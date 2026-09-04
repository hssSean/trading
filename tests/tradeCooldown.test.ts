import { describe, it, expect } from 'vitest';
import {
  activeCooldowns, cooldownKey, LOSS_COOLDOWN_MS, TIME_STOP_COOLDOWN_MS,
  symbolsOnSignalCooldown, symbolsInSameCandle, SIGNAL_COOLDOWN_MS,
  type ClosedTradeForCooldown, type RecentSignalRow,
} from '../src/lib/tradeCooldown';

// 這支守的是「剛被證偽的 setup 不要立刻重進」。8/23 Upstash 額度用盡後冷卻
// 完全失效（原本只存 Redis），是 Redis 死掉時唯一還會讓人真的虧錢的缺口。
//
// 兩個方向的錯都是靜默的：漏擋 = 連續虧損的同一個標的同方向立刻再發一次，
// 正是這個機制要防的事；誤擋 = 少一個候選。所以偏保守。

const T = 1_800_000_000_000;
const row = (o: Partial<ClosedTradeForCooldown>): ClosedTradeForCooldown => ({
  symbol: 'BTCUSDT', direction: 'LONG', result: null, close_reason: null, closed_at: T, ...o,
});

describe('activeCooldowns — 止損（同向 24h）', () => {
  it('冷卻期內鎖同方向', () => {
    const s = activeCooldowns([row({ result: 'LOSS', closed_at: T - 3600_000 })], T);
    expect(s.has(cooldownKey('BTCUSDT', 'LONG'))).toBe(true);
  });

  // 止損是對「這個方向錯了」的診斷，反向反而可能是對的——不能一起鎖。
  it('不鎖反方向', () => {
    const s = activeCooldowns([row({ result: 'LOSS', closed_at: T - 3600_000 })], T);
    expect(s.has(cooldownKey('BTCUSDT', 'SHORT'))).toBe(false);
  });

  it('超過 24h 就解除', () => {
    const s = activeCooldowns([row({ result: 'LOSS', closed_at: T - LOSS_COOLDOWN_MS })], T);
    expect(s.size).toBe(0);
  });

  it('剛好在 24h 邊界上算過期', () => {
    const edge = T - LOSS_COOLDOWN_MS;
    expect(activeCooldowns([row({ result: 'LOSS', closed_at: edge })], T).size).toBe(0);
    expect(activeCooldowns([row({ result: 'LOSS', closed_at: edge + 1 })], T).size).toBe(1);
  });
});

describe('activeCooldowns — 時間止損（雙向 4h）', () => {
  // 時間止損的判定是「8 根 K 線卡在 ±0.3R」＝對「這個標的在盤整」的診斷，
  // 不是對方向的診斷。只鎖同向的話，剛砍掉停滯多單、下一輪反向空單暢通，
  // 等於在同一個盤整區來回付手續費（2026-08-05 使用者實際踩到）。
  it('三種 time_stop 原因都鎖雙向', () => {
    for (const reason of ['time_stop_stall', 'time_stop_expiry', 'time_stop_expiry_post_tp1']) {
      const s = activeCooldowns([row({ close_reason: reason, closed_at: T - 60_000 })], T);
      expect(s.has(cooldownKey('BTCUSDT', 'LONG'))).toBe(true);
      expect(s.has(cooldownKey('BTCUSDT', 'SHORT'))).toBe(true);
    }
  });

  it('超過 4h 就解除', () => {
    const s = activeCooldowns([row({ close_reason: 'time_stop_stall', closed_at: T - TIME_STOP_COOLDOWN_MS })], T);
    expect(s.size).toBe(0);
  });

  // 時間止損的窗口比止損短很多，兩者不能共用同一個判定。
  it('時間止損用 4h 而不是 24h', () => {
    const at = T - 5 * 3600_000; // 5 小時前：超過 4h、還沒到 24h
    expect(activeCooldowns([row({ close_reason: 'time_stop_stall', closed_at: at })], T).size).toBe(0);
    expect(activeCooldowns([row({ result: 'LOSS', closed_at: at })], T).size).toBe(1);
  });
});

describe('activeCooldowns — 不該觸發的情況', () => {
  it('獲利出場不冷卻', () => {
    const rows = [
      row({ result: 'WIN_TP1', closed_at: T - 1000 }),
      row({ result: 'WIN_TP2', closed_at: T - 1000 }),
    ];
    expect(activeCooldowns(rows, T).size).toBe(0);
  });

  // CANCELLED 從沒開過倉，沒有任何東西被證偽。
  it('CANCELLED 不冷卻', () => {
    expect(activeCooldowns([row({ result: 'CANCELLED', closed_at: T - 1000 })], T).size).toBe(0);
  });

  it('缺 symbol 或 direction 直接跳過，不爆', () => {
    const rows = [
      { symbol: '', direction: 'LONG', result: 'LOSS', closed_at: T },
      { symbol: 'BTCUSDT', direction: '', result: 'LOSS', closed_at: T },
    ];
    expect(activeCooldowns(rows, T).size).toBe(0);
  });

  it('空輸入回空集合', () => {
    expect(activeCooldowns([], T).size).toBe(0);
  });
});

// 2026-09-04：這兩組補的是 route.ts 那兩道**只掛在 Redis 上**的關卡（6h 訊號
// 冷卻、同 4h 蠟燭）。Redis 空窗期它們一起 fail-open，實測造成同一支幣 0–1 分鐘
// 內反覆進出、全部同方向——純成本流失。
describe('symbolsOnSignalCooldown — 6h 訊號冷卻（不分方向）', () => {
  const sig = (o: Partial<RecentSignalRow>): RecentSignalRow =>
    ({ symbol: 'BTCUSDT', direction: 'LONG', opened_at: T, ...o });

  it('窗口內的 symbol 被鎖', () => {
    expect(symbolsOnSignalCooldown([sig({ opened_at: T - 3600_000 })], T).has('BTCUSDT')).toBe(true);
  });

  // 不分方向是刻意的：這道防的是「同一支幣被反覆推薦」，不是對方向的判斷。
  it('反方向也算同一個 symbol', () => {
    expect(symbolsOnSignalCooldown([sig({ direction: 'SHORT', opened_at: T - 60_000 })], T)
      .has('BTCUSDT')).toBe(true);
  });

  it('超過 6h 解除', () => {
    expect(symbolsOnSignalCooldown([sig({ opened_at: T - SIGNAL_COOLDOWN_MS })], T).size).toBe(0);
    expect(symbolsOnSignalCooldown([sig({ opened_at: T - SIGNAL_COOLDOWN_MS + 1 })], T).size).toBe(1);
  });

  // 跟 activeCooldowns 的「缺時間戳保守擋下」相反。opened_at 是必有欄位，
  // 缺了是資料異常——把異常變成無限期封鎖某個 symbol 是更糟的失效模式。
  it('缺 opened_at 跳過，不無限期封鎖', () => {
    expect(symbolsOnSignalCooldown([sig({ opened_at: null })], T).size).toBe(0);
  });

  it('空輸入回空集合', () => {
    expect(symbolsOnSignalCooldown([], T).size).toBe(0);
  });
});

describe('symbolsInSameCandle — 同 4h 蠟燭（分方向）', () => {
  const CANDLE = 4 * 3600_000;
  const bucketStart = Math.floor(T / CANDLE) * CANDLE;
  const sig = (o: Partial<RecentSignalRow>): RecentSignalRow =>
    ({ symbol: 'BTCUSDT', direction: 'LONG', opened_at: bucketStart + 60_000, ...o });

  it('同一根蠟燭內同方向被鎖', () => {
    expect(symbolsInSameCandle([sig({})], T).has(cooldownKey('BTCUSDT', 'LONG'))).toBe(true);
  });

  it('反方向不鎖', () => {
    expect(symbolsInSameCandle([sig({})], T).has(cooldownKey('BTCUSDT', 'SHORT'))).toBe(false);
  });

  // 用固定 4h 網格而不是「距今 4 小時內」。用錯會讓剛跨過整點的訊號被誤擋。
  it('上一根蠟燭不算，即使時間差不到 4 小時', () => {
    expect(symbolsInSameCandle([sig({ opened_at: bucketStart - 1 })], bucketStart + 1000).size).toBe(0);
  });

  it('缺 direction 跳過', () => {
    expect(symbolsInSameCandle([sig({ direction: '' })], T).size).toBe(0);
  });
});

describe('activeCooldowns — 邊界與組合', () => {
  // 漏擋比誤擋嚴重，所以缺時間戳時保守視為仍在冷卻。
  it('缺 closed_at 視為仍在冷卻', () => {
    const s = activeCooldowns([row({ result: 'LOSS', closed_at: null })], T);
    expect(s.has(cooldownKey('BTCUSDT', 'LONG'))).toBe(true);
  });

  it('同時是 LOSS 又是時間止損原因時，雙向都鎖', () => {
    const s = activeCooldowns(
      [row({ result: 'LOSS', close_reason: 'time_stop_stall', closed_at: T - 60_000 })], T);
    expect(s.has(cooldownKey('BTCUSDT', 'LONG'))).toBe(true);
    expect(s.has(cooldownKey('BTCUSDT', 'SHORT'))).toBe(true);
  });

  it('不同 symbol 互不影響', () => {
    const rows = [
      row({ symbol: 'BTCUSDT', result: 'LOSS', closed_at: T - 1000 }),
      row({ symbol: 'ETHUSDT', direction: 'SHORT', result: 'LOSS', closed_at: T - 1000 }),
    ];
    const s = activeCooldowns(rows, T);
    expect(s.has(cooldownKey('BTCUSDT', 'LONG'))).toBe(true);
    expect(s.has(cooldownKey('ETHUSDT', 'SHORT'))).toBe(true);
    expect(s.has(cooldownKey('ETHUSDT', 'LONG'))).toBe(false);
  });
});

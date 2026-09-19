import { describe, it, expect } from 'vitest';
import { simulateShadow, type ShadowTrade, type ShadowCandle } from '../src/lib/shadowSim';

// 影子模擬的悲觀軌跡是整個「調參紀律」的地基：funnel-verdict 用
// 「樂觀與悲觀兩端同號才算數」來決定一道濾網能不能動。2026-09-20 的體檢
// 發現這個地基在漏——`SHADOW_PESSIMISTIC` 2026-08-26 預設關閉之後，
// 系統仍然會**寫出 pessResult**，但那不是模擬出來的：
//
//   - 樂觀軌跡結案時直接把結果複製給悲觀 → netRPess 恆等於 netR，
//     「兩端同號」永遠成立，那道把關等於不存在。
//   - TIMEOUT 分支讀 `st.pessTp1Hit`，而關閉時它從來沒被更新過 → 一律
//     當成「沒到過 TP1」，那是憑空的悲觀不是模擬的悲觀。
//   - waiting 逾期（EXPIRED）直接 return，**從來不寫 pess 欄位** →
//     pessCovered 少算，覆蓋率看起來很差（score_gate 只有 49%），
//     但那些單兩種軌跡的 R 都是 0，本來就該算進覆蓋率。
//
// 三者都讓「這道關卡擋得對不對」的判讀失真，方向還不一致。

const h = 3600_000;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

/** 第 i 根 1h K 線。openTime = T0 + i*h。 */
const candle = (i: number, high: number, low: number, close: number): ShadowCandle => ({
  openTime: T0 + i * h, closeTime: T0 + (i + 1) * h, high, low, close,
});

const base = (over: Partial<ShadowTrade> = {}): ShadowTrade => ({
  id: 's1', at: T0, symbol: 'BTCUSDT', direction: 'LONG', timeframe: '1h',
  entry: 100, stopLoss: 98, tp1: 104, tp2: 108,
  score: 60, tier: null, strategy: 'A', rejectedAt: 'score_gate',
  signalPrice: 101, status: 'waiting', lastCheckedAt: T0, ...over,
});

const CFG = { waitingExpiryHours: 8, intradayCloseHours: 24, pessimistic: true };

describe('simulateShadow — EXPIRED 也要有悲觀資料', () => {
  it('掛單逾期未成交 → pessDone 要設起來（兩種軌跡的 R 都是 0）', () => {
    const st = base();
    // 價格從來沒碰到 entry=100，且已經過了 8 小時的等待上限。
    const candles = [candle(0, 103, 101, 102)];
    simulateShadow(st, candles, T0 + 9 * h, CFG);

    expect(st.status).toBe('done');
    expect(st.result).toBe('EXPIRED');
    expect(st.pessDone).toBe(true);
    expect(st.pessResult).toBe('EXPIRED');
  });

  it('還在等待期內就不結案，也不亂寫 pess 欄位', () => {
    const st = base();
    simulateShadow(st, [candle(0, 103, 101, 102)], T0 + 2 * h, CFG);
    expect(st.status).toBe('waiting');
    expect(st.pessDone).toBeUndefined();
  });
});

describe('simulateShadow — 悲觀軌跡要真的跟樂觀不一樣', () => {
  it('同一根 K 線同時觸及 TP1 與 SL：樂觀走 TP、悲觀認賠', () => {
    const st = base({ status: 'active', filledAt: T0 });
    // 一根同時碰到 tp2=108 與 stopLoss=98 的大棒。
    const candles = [candle(1, 109, 97, 100)];
    simulateShadow(st, candles, T0 + 3 * h, CFG);

    expect(st.result).toBe('WIN_TP2');
    expect(st.pessResult).toBe('LOSS');
  });
});

describe('simulateShadow — TIMEOUT 用的是真的悲觀狀態', () => {
  it('樂觀到過 TP1、悲觀先被掃出場 → 兩邊的 TIMEOUT 結果不同', () => {
    const st = base({ status: 'active', filledAt: T0 });
    // 第 1 根同時碰 tp1=104 與 sl=98：樂觀記 tp1Hit，悲觀直接 LOSS。
    // 之後一路盤整，樂觀走到 24h 上限才 TIMEOUT。
    const candles = [candle(1, 105, 97, 101), candle(2, 102, 100, 101)];
    simulateShadow(st, candles, T0 + 30 * h, CFG);

    expect(st.status).toBe('done');
    expect(st.tp1Hit).toBe(true);
    expect(st.result).toBe('WIN_TP1');
    expect(st.pessResult).toBe('LOSS');   // 不是憑空的 TIMEOUT
  });
});

describe('simulateShadow — 關閉悲觀軌跡時不准捏造', () => {
  const OFF = { ...CFG, pessimistic: false };

  it('樂觀結案時不再把結果複製給悲觀 —— 否則 netRPess 恆等於 netR', () => {
    const st = base({ status: 'active', filledAt: T0 });
    simulateShadow(st, [candle(1, 109, 99, 108)], T0 + 3 * h, OFF);

    expect(st.result).toBe('WIN_TP2');
    expect(st.pessDone).toBeUndefined();
    expect(st.pessResult).toBeUndefined();
  });

  it('EXPIRED 在關閉時也不寫 pess —— 覆蓋率要誠實反映「沒有資料」', () => {
    const st = base();
    simulateShadow(st, [candle(0, 103, 101, 102)], T0 + 9 * h, OFF);
    expect(st.result).toBe('EXPIRED');
    expect(st.pessDone).toBeUndefined();
  });
});

describe('simulateShadow — 既有行為不能被改壞', () => {
  it('價格碰到掛單價就轉 active，並記下 filledAt', () => {
    const st = base();
    simulateShadow(st, [candle(0, 102, 99, 101)], T0 + 1 * h, CFG);
    expect(st.status).toBe('active');
    expect(st.filledAt).toBe(T0);
  });

  it('成交後走到 TP2 → WIN_TP2', () => {
    const st = base({ status: 'active', filledAt: T0 });
    simulateShadow(st, [candle(1, 109, 99, 108)], T0 + 3 * h, CFG);
    expect(st.result).toBe('WIN_TP2');
    expect(st.status).toBe('done');
  });

  it('成交後先碰止損 → LOSS', () => {
    const st = base({ status: 'active', filledAt: T0 });
    simulateShadow(st, [candle(1, 101, 97, 98)], T0 + 3 * h, CFG);
    expect(st.result).toBe('LOSS');
    expect(st.pessResult).toBe('LOSS');
  });
});

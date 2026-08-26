import { describe, it, expect } from 'vitest';
import {
  unavailableSymbols, SYMBOL_UNAVAILABLE_COOLDOWN_MS, SYMBOL_UNAVAILABLE_REASON,
} from '../src/lib/symbolAvailability';

// 這支守的是「不要對下不了單的幣重複發訊號」。2026-08-26 實測：使用者一直
// 收到同一個幣的推薦單，下單被幣安 -4141 取消，下一輪再發，每 5 分鐘燒一次
// 完整指標計算 + 一則推播——Vercel 的 CPU 額度就是這樣爆的。
//
// 兩個方向的錯都是靜默的：判太鬆＝迴圈繼續燒額度；判太嚴（永不過期）＝
// 這個幣再也不會出現在推薦裡，而且沒有人會發現。

const T = 1_800_000_000_000;
const row = (symbol: string, close_reason: string | null, closed_at: number | null) =>
  ({ symbol, close_reason, closed_at });

describe('unavailableSymbols', () => {
  it('冷卻期內的 symbol_unavailable 會被擋', () => {
    const s = unavailableSymbols([row('MMTUSDT', SYMBOL_UNAVAILABLE_REASON, T - 3600_000)], T);
    expect(s.has('MMTUSDT')).toBe(true);
  });

  it('超過冷卻期就放行（symbol 可能重新開放）', () => {
    const old = T - SYMBOL_UNAVAILABLE_COOLDOWN_MS - 1;
    const s = unavailableSymbols([row('MMTUSDT', SYMBOL_UNAVAILABLE_REASON, old)], T);
    expect(s.has('MMTUSDT')).toBe(false);
  });

  it('剛好在冷卻邊界上算過期', () => {
    const edge = T - SYMBOL_UNAVAILABLE_COOLDOWN_MS;
    expect(unavailableSymbols([row('X', SYMBOL_UNAVAILABLE_REASON, edge)], T).has('X')).toBe(false);
    expect(unavailableSymbols([row('X', SYMBOL_UNAVAILABLE_REASON, edge + 1)], T).has('X')).toBe(true);
  });

  // 其他關單原因不該讓一個正常的幣被封鎖——止損出場是策略正常運作，
  // 誤擋的話會讓整個幣種悄悄從推薦池消失。
  it('其他 close_reason 一律不擋', () => {
    const rows = [
      row('AAAUSDT', 'stop_loss', T - 1000),
      row('BBBUSDT', 'tp2', T - 1000),
      row('CCCUSDT', 'time_stop_stall', T - 1000),
      row('DDDUSDT', null, T - 1000),
    ];
    expect(unavailableSymbols(rows, T).size).toBe(0);
  });

  // 沒有 closed_at 時無從判斷是否過期。誤擋只是少一個候選，誤放行是繼續
  // 無限迴圈燒額度——選安全的那邊。
  it('缺少 closed_at 時視為仍在冷卻', () => {
    const s = unavailableSymbols([row('MMTUSDT', SYMBOL_UNAVAILABLE_REASON, null)], T);
    expect(s.has('MMTUSDT')).toBe(true);
  });

  it('同一個 symbol 多筆記錄，只要有一筆還在冷卻就擋', () => {
    const rows = [
      row('MMTUSDT', SYMBOL_UNAVAILABLE_REASON, T - SYMBOL_UNAVAILABLE_COOLDOWN_MS - 5000),
      row('MMTUSDT', SYMBOL_UNAVAILABLE_REASON, T - 60_000),
    ];
    expect(unavailableSymbols(rows, T).has('MMTUSDT')).toBe(true);
  });

  it('空輸入回空集合，不爆', () => {
    expect(unavailableSymbols([], T).size).toBe(0);
  });

  it('可以覆寫冷卻長度', () => {
    const r = [row('X', SYMBOL_UNAVAILABLE_REASON, T - 5000)];
    expect(unavailableSymbols(r, T, 1000).has('X')).toBe(false);
    expect(unavailableSymbols(r, T, 10_000).has('X')).toBe(true);
  });
});

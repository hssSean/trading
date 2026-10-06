import { describe, it, expect } from 'vitest';
import { trailedStop, sizePosition, leverageFor, checkPosition, floorTo, type LivePos } from '../src/engine/s3aLive';

const pos = (over: Partial<LivePos> = {}): LivePos => ({
  symbol: 'AUSDT', signalDay: 0, entryDay: 100, entryAt: 0, entry: 10, stop0: 9, stop: 9, qty0: 30, tpQty: 10,
  partial: false, stopAlgoId: 1, tpAlgoId: 2, trailDay: 0, stopFailures: 0,
  score: 2, dist: 0.1, btcExt: 3, ret7: 0, breadth: 0.5, funding: 0, ...over,
});

describe('trailedStop', () => {
  it('只上移；進場那根日線之前的 LL10 不用', () => {
    expect(trailedStop(pos(), 9.5, 100)).toBe(9.5);
    expect(trailedStop(pos(), 8.5, 100)).toBe(9);
    expect(trailedStop(pos(), 9.5, 99)).toBe(9);
    expect(trailedStop(pos(), null, 100)).toBe(9);
  });
  it('已平 1/3 後不低於進場價', () => {
    expect(trailedStop(pos({ partial: true }), 9.5, 100)).toBe(10);
    expect(trailedStop(pos({ partial: true }), 10.5, 100)).toBe(10.5);
  });
});

describe('sizePosition', () => {
  const flt = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  it('權益 × f ÷ 止損距離，捨去到步長且不留浮點灰塵', () => {
    expect(sizePosition(4826.17, 0.04, 0.2721, 0.23776, { stepSize: 1, minQty: 1, minNotional: 5 })).toEqual({ qty: 5621, minQtyUsed: false });
    expect(floorTo(16.24, 0.01)).toBe(16.24);
  });
  it('不足最小量：最小量風險 ≤ 1.5f 用最小量，否則跳過', () => {
    expect(sizePosition(100, 0.04, 100, 99, { ...flt, minNotional: 500 })).toEqual({ qty: 5, minQtyUsed: true });
    expect(sizePosition(100, 0.04, 100, 98, { ...flt, minNotional: 500 })).toMatchObject({ skip: expect.stringMatching(/最小下單量/) });
  });
  it('止損在進場價之上直接跳過', () => {
    expect(sizePosition(100, 0.04, 10, 11, flt)).toMatchObject({ skip: '止損在進場價之上' });
  });
});

describe('leverageFor', () => {
  it('強平距離要大於止損距離的 1.1 倍左右；上限 10 倍', () => {
    expect(leverageFor(100, 99)).toBe(8);     // 強平要低於 89.1：1/8 − 1% = 11.5% ≥ 10.9%
    expect(leverageFor(100, 99.99, 0)).toBeLessThanOrEqual(10);
    const lev = leverageFor(0.2721, 0.23776);
    expect(lev).toBe(4);
    const liq = 0.2721 * (1 - (1 / lev - 0.01));
    expect(liq).toBeLessThan(0.23776 * 0.9);
    expect(leverageFor(100, 40)).toBe(1);
  });
});

describe('checkPosition', () => {
  const algos = new Set([1, 2]);
  it('部位歸零 → closed', () => {
    expect(checkPosition(pos(), 0, algos, 10)).toEqual({ kind: 'closed' });
  });
  it('止盈單不見且部位少了 1/3 → partial_filled，止損拉到進場價', () => {
    expect(checkPosition(pos(), 20, new Set([1]), 11)).toEqual({ kind: 'partial_filled', remaining: 20, newStop: 10 });
  });
  it('部位變小但止盈單還掛著（手動平倉）→ 不當成止盈', () => {
    expect(checkPosition(pos(), 20, algos, 10).kind).toBe('ok');
  });
  it('止損單不見 → stop_missing，標出價格是否已穿過', () => {
    expect(checkPosition(pos(), 30, new Set([2]), 9.5)).toEqual({ kind: 'stop_missing', priceThrough: false });
    expect(checkPosition(pos(), 30, new Set([2]), 8.9)).toEqual({ kind: 'stop_missing', priceThrough: true });
  });
  it('止盈單不見但部位沒變 → tp_missing（被拒絕）', () => {
    expect(checkPosition(pos(), 30, new Set([1]), 10.5)).toEqual({ kind: 'tp_missing', priceThrough: false });
    expect(checkPosition(pos(), 30, new Set([1]), 11.2)).toEqual({ kind: 'tp_missing', priceThrough: true });
  });
  it('已平 1/3 後止盈單本來就不在，不算 tp_missing', () => {
    expect(checkPosition(pos({ partial: true, tpAlgoId: null }), 20, new Set([1]), 10).kind).toBe('ok');
  });
});

import { describe, it, expect } from 'vitest';
import { calcSimpleAtr } from '../src/lib/monitorMath';

const bar = (high: number, low: number, close: number) => ({ high, low, close, closeTime: 0 });

describe('calcSimpleAtr', () => {
  it('returns 0 when fewer than period+1 candles are given (the exact bug this fixes: an incrementally-fetched tail of 1-2 bars must never silently produce a fake ATR)', () => {
    const candles = [bar(105, 95, 100), bar(106, 96, 101)];
    expect(calcSimpleAtr(candles, 14)).toBe(0);
  });

  it('returns 0 for an empty array', () => {
    expect(calcSimpleAtr([], 14)).toBe(0);
  });

  it('computes the simple mean of true ranges over the last `period` bars once enough candles exist', () => {
    // 16 flat bars with TR=10 each (high-low=10, no gap vs prior close) → ATR should be 10.
    const candles = Array.from({ length: 16 }, (_, i) => bar(105 + i, 95 + i, 100 + i));
    expect(calcSimpleAtr(candles, 14)).toBeCloseTo(10, 5);
  });

  it('uses fewer than `period` true ranges when only just-enough candles exist (period+1)', () => {
    // period+1 = 15 candles → 14 true ranges, n = min(14, 14) = 14
    const candles = Array.from({ length: 15 }, (_, i) => bar(100 + i * 2, 100 + i * 2 - 5, 100 + i * 2 - 2));
    const atr = calcSimpleAtr(candles, 14);
    expect(atr).toBeGreaterThan(0);
  });

  it('picks up gap-driven true range (high-prevClose or prevClose-low), not just high-low', () => {
    // Bar 2 gaps up hard: prevClose=100, low=98 → |low-prevClose| isn't the max;
    // high=130, prevClose=100 → |high-prevClose|=30 dwarfs high-low=(130-98)=32... use a clean gap case instead.
    const candles = [
      bar(102, 98, 100),   // prevClose = 100
      bar(140, 135, 138),  // high-low=5, but high-prevClose=40 → TR should be 40
    ];
    // period+1 must be satisfied; use period=1 so n=min(1, candles.length-1)=1
    const atr = calcSimpleAtr(candles, 1);
    expect(atr).toBeCloseTo(40, 5);
  });

  it('extra history beyond what the period needs does not change the result (only the tail matters)', () => {
    const tail = Array.from({ length: 15 }, (_, i) => bar(105 + i, 95 + i, 100 + i));
    const withExtraHistory = [bar(50, 40, 45), bar(60, 50, 55), ...tail];
    expect(calcSimpleAtr(withExtraHistory, 14)).toBeCloseTo(calcSimpleAtr(tail, 14), 5);
  });
});

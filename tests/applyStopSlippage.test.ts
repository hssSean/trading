import { describe, it, expect } from 'vitest';
import { applyStopSlippage, STOP_EXIT_SLIPPAGE_PCT } from '../src/lib/monitorMath';

describe('applyStopSlippage', () => {
  it('LONG: pushes the exit price DOWN (worse for a long stop-out)', () => {
    const r = applyStopSlippage(100, true);
    expect(r).toBeLessThan(100);
    expect(r).toBeCloseTo(100 * (1 - STOP_EXIT_SLIPPAGE_PCT), 10);
  });

  it('SHORT: pushes the exit price UP (worse for a short stop-out)', () => {
    const r = applyStopSlippage(100, false);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeCloseTo(100 * (1 + STOP_EXIT_SLIPPAGE_PCT), 10);
  });

  it('constant is 0.05% — same order of magnitude as backtest.ts entry slippage (0.03%)', () => {
    expect(STOP_EXIT_SLIPPAGE_PCT).toBe(0.0005);
  });

  it('scales with price (percentage-based, not a fixed price offset)', () => {
    const low  = applyStopSlippage(10, true);
    const high = applyStopSlippage(10000, true);
    expect(10 - low).toBeCloseTo(10 * STOP_EXIT_SLIPPAGE_PCT, 10);
    expect(10000 - high).toBeCloseTo(10000 * STOP_EXIT_SLIPPAGE_PCT, 6);
  });
});

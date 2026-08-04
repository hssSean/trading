import { describe, it, expect } from 'vitest';
import { calcDrawdown, type EquityPoint } from '../src/lib/monitorMath';

const p = (closedAt: number, accountR: number): EquityPoint => ({ closedAt, accountR });

describe('calcDrawdown', () => {
  it('no trades → everything zero (must not report a phantom drawdown that halts a fresh account)', () => {
    expect(calcDrawdown([])).toEqual({ peak: 0, current: 0, drawdown: 0 });
  });

  it('monotonically winning account has zero drawdown', () => {
    const r = calcDrawdown([p(1, 1), p(2, 2), p(3, 0.5)]);
    expect(r.peak).toBe(3.5);
    expect(r.current).toBe(3.5);
    expect(r.drawdown).toBe(0);
  });

  it('measures drawdown from the running peak, not from zero', () => {
    // +5 (peak 5) then -2 → equity 3, drawdown 2
    const r = calcDrawdown([p(1, 5), p(2, -2)]);
    expect(r.peak).toBe(5);
    expect(r.current).toBe(3);
    expect(r.drawdown).toBe(2);
  });

  it('an account underwater from the very first trade reports drawdown vs 0 peak', () => {
    // peak never exceeds 0 → drawdown is the full loss
    const r = calcDrawdown([p(1, -1), p(2, -1.5)]);
    expect(r.peak).toBe(0);
    expect(r.current).toBe(-2.5);
    expect(r.drawdown).toBe(2.5);
  });

  it('drawdown shrinks as equity recovers — this is what lets the halt self-clear', () => {
    const deep = calcDrawdown([p(1, 10), p(2, -8)]);
    expect(deep.drawdown).toBe(8);
    const recovered = calcDrawdown([p(1, 10), p(2, -8), p(3, 6)]);
    expect(recovered.drawdown).toBe(2);
  });

  it('the slow-bleed case the daily circuit breaker misses: five modest down days compound', () => {
    // each day alone is well inside the -3R daily breaker, cumulative is not
    const pts = [p(1, 6), p(2, -2.5), p(3, -2.5), p(4, -2.5), p(5, -2.5), p(6, -2.5)];
    const r = calcDrawdown(pts);
    expect(r.peak).toBe(6);
    expect(r.current).toBe(-6.5);
    expect(r.drawdown).toBe(12.5);
  });

  it('sorts by closedAt — out-of-order input must not fabricate a different peak', () => {
    const inOrder  = calcDrawdown([p(1, 5), p(2, -2), p(3, 1)]);
    const shuffled = calcDrawdown([p(3, 1), p(1, 5), p(2, -2)]);
    expect(shuffled).toEqual(inOrder);
  });

  it('does not mutate the caller array while sorting', () => {
    const pts = [p(3, 1), p(1, 5), p(2, -2)];
    const snapshot = JSON.stringify(pts);
    calcDrawdown(pts);
    expect(JSON.stringify(pts)).toBe(snapshot);
  });
});

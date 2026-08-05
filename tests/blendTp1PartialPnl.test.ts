import { describe, it, expect } from 'vitest';
import { blendTp1PartialPnl, TP1_PARTIAL_FRACTION } from '../src/lib/monitorMath';

describe('blendTp1PartialPnl', () => {
  it('LONG: 50/50 blend of pnl-at-tp1 and pnl-at-final', () => {
    // entry=100, tp1=110 (+10%), final=105 (+5%) → 0.5*10 + 0.5*5 = 7.5
    const r = blendTp1PartialPnl(100, 110, 105, true);
    expect(r).toBeCloseTo(7.5, 6);
  });

  it('SHORT: mirrors sign correctly', () => {
    // entry=100, tp1=90 (+10%), final=95 (+5%) → 0.5*10 + 0.5*5 = 7.5
    const r = blendTp1PartialPnl(100, 90, 95, false);
    expect(r).toBeCloseTo(7.5, 6);
  });

  it('final exit below entry (gave almost everything back) still blends — half stays locked at tp1', () => {
    // BANKUSDT-shaped case: entry=100, tp1=200 (100%), final exit trailing stop at 108 (+8%)
    // → 0.5*100 + 0.5*8 = 54, vs the old 100%-at-final model which would have said 8.
    const r = blendTp1PartialPnl(100, 200, 108, true);
    expect(r).toBeCloseTo(54, 6);
  });

  it('finalExitPrice === tp1 degenerates to a single clean value (both halves agree)', () => {
    const r = blendTp1PartialPnl(100, 110, 110, true);
    expect(r).toBeCloseTo(10, 6);
  });

  it('fraction=1 ignores the final price entirely — full position "locked" at tp1', () => {
    const r = blendTp1PartialPnl(100, 110, 50, true, 1);
    expect(r).toBeCloseTo(10, 6);
  });

  it('fraction=0 reproduces the pre-2026-08-05 behaviour exactly (100% at final price)', () => {
    const r = blendTp1PartialPnl(100, 110, 95, true, 0);
    expect(r).toBeCloseTo(-5, 6);
  });

  it('default export constant is 0.5 (matches the documented "middle-of-the-road" choice)', () => {
    expect(TP1_PARTIAL_FRACTION).toBe(0.5);
  });

  it('a full loss on the remaining half after tp1 still keeps the locked half positive (net can stay positive)', () => {
    // entry=100, tp1=110 (+10%), remaining half stopped out at breakeven floor 100 (0%)
    const r = blendTp1PartialPnl(100, 110, 100, true);
    expect(r).toBeCloseTo(5, 6);
  });
});

import { describe, it, expect } from 'vitest';
import { applyFundingRateCrowdingPenalty } from '../src/lib/monitorMath';

describe('applyFundingRateCrowdingPenalty', () => {
  it('LONG: deducts 5 when funding rate exceeds the crowding threshold (>0.1%)', () => {
    expect(applyFundingRateCrowdingPenalty(70, 'LONG', 0.0015)).toBe(65);
  });

  it('LONG: leaves score untouched at/below the threshold', () => {
    expect(applyFundingRateCrowdingPenalty(70, 'LONG', 0.001)).toBe(70);
    expect(applyFundingRateCrowdingPenalty(70, 'LONG', 0.0005)).toBe(70);
    expect(applyFundingRateCrowdingPenalty(70, 'LONG', -0.002)).toBe(70); // negative funding favors longs
  });

  it('SHORT: deducts 5 when funding rate is below the crowding threshold (<-0.05%)', () => {
    expect(applyFundingRateCrowdingPenalty(70, 'SHORT', -0.001)).toBe(65);
  });

  it('SHORT: leaves score untouched at/above the threshold', () => {
    expect(applyFundingRateCrowdingPenalty(70, 'SHORT', -0.0005)).toBe(70);
    expect(applyFundingRateCrowdingPenalty(70, 'SHORT', 0.002)).toBe(70); // positive funding favors shorts
  });

  it('never drops the score below 0', () => {
    expect(applyFundingRateCrowdingPenalty(3, 'LONG', 0.002)).toBe(0);
  });

  it('mirrors thresholds match the existing computeConfidence gate in route.ts (not reinvented)', () => {
    // LONG crowds at >0.001 (0.1%), SHORT crowds at <-0.0005 (0.05%) — asymmetric
    // on purpose (route.ts's original design), not a typo.
    expect(applyFundingRateCrowdingPenalty(70, 'LONG', 0.0011)).toBeLessThan(70);
    expect(applyFundingRateCrowdingPenalty(70, 'SHORT', -0.0006)).toBeLessThan(70);
  });
});

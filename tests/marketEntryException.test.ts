import { describe, it, expect } from 'vitest';
import { shouldEnterAtMarket, shiftSignalToMarketEntry, MarketEntryCandidate } from '../src/lib/marketEntryException';

function candidate(overrides: Partial<MarketEntryCandidate> = {}): MarketEntryCandidate {
  return {
    strategy: 'A',
    score: 80,
    entry: 100,
    stopLoss: 98,
    takeProfits: [104, 108],
    signalPrice: 105,
    scoreBreakdown: { entryDistAtr: 0.8 },
    ...overrides,
  };
}

describe('shouldEnterAtMarket', () => {
  it('is true when score meets threshold, bias confirmed, and entryDistAtr > 0', () => {
    expect(shouldEnterAtMarket(candidate(), 75, true)).toBe(true);
  });

  it('is false when score is below the threshold', () => {
    expect(shouldEnterAtMarket(candidate({ score: 70 }), 75, true)).toBe(false);
  });

  it('is false when bias is not confirmed', () => {
    expect(shouldEnterAtMarket(candidate(), 75, false)).toBe(false);
  });

  it('is false for strategy B (mean reversion has its own single-target design)', () => {
    expect(shouldEnterAtMarket(candidate({ strategy: 'B' }), 75, true)).toBe(false);
  });

  it('is false when signalPrice is missing', () => {
    expect(shouldEnterAtMarket(candidate({ signalPrice: undefined }), 75, true)).toBe(false);
  });

  it('is false when entryDistAtr is 0 or missing — no pullback distance to skip', () => {
    expect(shouldEnterAtMarket(candidate({ scoreBreakdown: { entryDistAtr: 0 } }), 75, true)).toBe(false);
    expect(shouldEnterAtMarket(candidate({ scoreBreakdown: {} }), 75, true)).toBe(false);
    expect(shouldEnterAtMarket(candidate({ scoreBreakdown: undefined }), 75, true)).toBe(false);
  });
});

describe('shiftSignalToMarketEntry', () => {
  it('moves entry to signalPrice and shifts stopLoss/takeProfits by the same delta (LONG, price rose)', () => {
    // entry=100, signalPrice=105 → shift = +5
    const r = shiftSignalToMarketEntry(candidate());
    expect(r.entry).toBe(105);
    expect(r.stopLoss).toBe(103);       // 98 + 5
    expect(r.takeProfits).toEqual([109, 113]); // [104,108] + 5
    expect(r.originalEntry).toBe(100);
  });

  it('mirrors for SHORT-style setups where signalPrice is below the original entry', () => {
    // entry=100, signalPrice=95 → shift = -5
    const r = shiftSignalToMarketEntry(candidate({ entry: 100, signalPrice: 95, stopLoss: 102, takeProfits: [96, 92] }));
    expect(r.entry).toBe(95);
    expect(r.stopLoss).toBe(97);        // 102 - 5
    expect(r.takeProfits).toEqual([91, 87]); // [96,92] - 5
  });

  it('preserves the risk distance exactly (risk-reward ratio unchanged)', () => {
    const original = candidate({ entry: 100, stopLoss: 98, takeProfits: [104, 108] });
    const originalRisk = Math.abs(original.entry - original.stopLoss);
    const originalReward1 = Math.abs(original.takeProfits[0] - original.entry);

    const r = shiftSignalToMarketEntry(original);
    const newRisk = Math.abs(r.entry - r.stopLoss);
    const newReward1 = Math.abs(r.takeProfits[0] - r.entry);

    expect(newRisk).toBeCloseTo(originalRisk, 8);
    expect(newReward1).toBeCloseTo(originalReward1, 8);
  });

  it('falls back to originalEntry when signalPrice is somehow missing (no-op shift)', () => {
    const r = shiftSignalToMarketEntry(candidate({ signalPrice: undefined }));
    expect(r.entry).toBe(100);
    expect(r.stopLoss).toBe(98);
    expect(r.takeProfits).toEqual([104, 108]);
  });
});

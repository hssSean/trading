import { describe, it, expect } from 'vitest';
import { analyzeScoreAttribution, calcRMultiple, AttributionTrade } from '../src/lib/scoreAttribution';

function trade(overrides: Partial<AttributionTrade> = {}): AttributionTrade {
  return {
    direction: 'LONG',
    result: 'WIN_TP1',
    pnlPercent: 2,
    entry: 100,
    stopLoss: 98, // riskPct = 2%
    scoreBreakdown: {
      trend: 10, momentum: 5, structure: 5, volume: 3, priceAction: 2, penalties: 0,
    },
    ...overrides,
  };
}

describe('calcRMultiple', () => {
  it('computes pnl% / risk% (2% pnl / 2% risk = 1R)', () => {
    expect(calcRMultiple({ entry: 100, stopLoss: 98, pnlPercent: 2 })).toBeCloseTo(1, 8);
  });

  it('mirrors for SHORT (risk% still from |entry-stopLoss|/entry)', () => {
    expect(calcRMultiple({ entry: 100, stopLoss: 102, pnlPercent: -1 })).toBeCloseTo(-0.5, 8);
  });

  it('returns null when pnlPercent is null (still open / cancelled)', () => {
    expect(calcRMultiple({ entry: 100, stopLoss: 98, pnlPercent: null })).toBeNull();
  });

  it('returns null when riskPct is zero (entry === stopLoss, degenerate)', () => {
    expect(calcRMultiple({ entry: 100, stopLoss: 100, pnlPercent: 2 })).toBeNull();
  });
});

describe('analyzeScoreAttribution — sample size', () => {
  it('counts total trades and how many carry a score breakdown', () => {
    const trades = [trade(), trade({ scoreBreakdown: null }), trade()];
    const r = analyzeScoreAttribution(trades);
    expect(r.sampleSize.total).toBe(3);
    expect(r.sampleSize.withBreakdown).toBe(2);
  });
});

describe('analyzeScoreAttribution — byFactorBucket', () => {
  it('returns empty buckets when fewer than 3 trades have a breakdown (too small to split into thirds)', () => {
    const trades = [trade(), trade()];
    const r = analyzeScoreAttribution(trades);
    expect(r.byFactorBucket.trend).toEqual([]);
  });

  it('splits into low/mid/high by the factor value and computes win rate + avg R per bucket', () => {
    // 6 trades, trend scores 1..6 (evenly spread) — low=[1,2], mid=[3,4], high=[5,6]
    const trades = [1, 2, 3, 4, 5, 6].map(trend =>
      trade({
        scoreBreakdown: { trend, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 },
        // Make the higher-trend trades losers, lower-trend trades winners —
        // an intentionally inverted relationship to test the bucket split itself,
        // not to assert any real-world pattern.
        result: trend <= 3 ? 'WIN_TP1' : 'LOSS',
        pnlPercent: trend <= 3 ? 2 : -2,
      }));
    const r = analyzeScoreAttribution(trades);
    const buckets = r.byFactorBucket.trend;
    expect(buckets).toHaveLength(3);
    expect(buckets[0].bucket).toBe('低');
    expect(buckets[0].count).toBe(2);
    expect(buckets[0].winRate).toBe(100); // trend 1,2 → both WIN
    expect(buckets[2].bucket).toBe('高');
    expect(buckets[2].winRate).toBe(0);   // trend 5,6 → both LOSS
  });

  it('excludes CANCELLED trades from win rate / R (never actually filled)', () => {
    const trades = [
      trade({ result: 'CANCELLED', pnlPercent: null, scoreBreakdown: { trend: 1, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }),
      trade({ result: 'WIN_TP1', pnlPercent: 2, scoreBreakdown: { trend: 2, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }),
      trade({ result: 'LOSS', pnlPercent: -2, scoreBreakdown: { trend: 3, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }),
    ];
    const r = analyzeScoreAttribution(trades);
    const totalCount = r.byFactorBucket.trend.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(2); // CANCELLED dropped
  });
});

describe('analyzeScoreAttribution — factorGroupByDirection', () => {
  it('computes separate averages for LONG and SHORT per factor group', () => {
    const trades = [
      trade({ direction: 'LONG', scoreBreakdown: { trend: 10, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }),
      trade({ direction: 'LONG', scoreBreakdown: { trend: 20, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }),
      trade({ direction: 'SHORT', scoreBreakdown: { trend: 5, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }),
    ];
    const r = analyzeScoreAttribution(trades);
    const trendRow = r.factorGroupByDirection.find(g => g.group === 'trend')!;
    expect(trendRow.longAvg).toBe(15); // (10+20)/2
    expect(trendRow.shortAvg).toBe(5);
    expect(trendRow.overallAvg).toBe(parseFloat(((10 + 20 + 5) / 3).toFixed(2)));
  });
});

describe('analyzeScoreAttribution — extensionAtrBuckets', () => {
  it('only includes trades where extensionAtr is defined', () => {
    const trades = [
      trade({ scoreBreakdown: { trend: 1, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } }), // no extensionAtr
      trade({ scoreBreakdown: { trend: 1, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0, extensionAtr: 0.5 } }),
      trade({ scoreBreakdown: { trend: 1, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0, extensionAtr: 1.5 } }),
      trade({ scoreBreakdown: { trend: 1, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0, extensionAtr: 2.5 } }),
    ];
    const r = analyzeScoreAttribution(trades);
    const totalCount = r.extensionAtrBuckets.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(3); // the one without extensionAtr is excluded
  });
});

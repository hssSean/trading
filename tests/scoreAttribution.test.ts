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

describe('analyzeScoreAttribution — byRegime', () => {
  it('aggregates win rate / avg R per regime (trending/ranging/transitional)', () => {
    const trades = [
      trade({ regime: 'trending', result: 'WIN_TP1', pnlPercent: 4 }),
      trade({ regime: 'trending', result: 'LOSS', pnlPercent: -2 }),
      trade({ regime: 'ranging', result: 'WIN_TP1', pnlPercent: 2 }),
    ];
    const r = analyzeScoreAttribution(trades);
    expect(r.byRegime.trending.count).toBe(2);
    expect(r.byRegime.trending.winRate).toBe(50);
    expect(r.byRegime.ranging.count).toBe(1);
    expect(r.byRegime.ranging.winRate).toBe(100);
  });

  it('omits regimes with no data rather than a zeroed-out entry', () => {
    const trades = [trade({ regime: null })];
    const r = analyzeScoreAttribution(trades);
    expect(Object.keys(r.byRegime)).toHaveLength(0);
  });

  it('does not require scoreBreakdown to be present — regime is a top-level field', () => {
    const trades = [trade({ regime: 'trending', scoreBreakdown: null })];
    const r = analyzeScoreAttribution(trades);
    expect(r.byRegime.trending.count).toBe(1);
  });
});

describe('analyzeScoreAttribution — tagStats', () => {
  it('aggregates win rate / avg R per momentum/priceAction sub-condition tag', () => {
    const trades = [
      trade({
        result: 'WIN_TP1', pnlPercent: 4,
        scoreBreakdown: { trend: 0, momentum: 5, structure: 0, volume: 0, priceAction: 0, penalties: 0, momentumTags: ['rsi_extreme'] },
      }),
      trade({
        result: 'LOSS', pnlPercent: -2,
        scoreBreakdown: { trend: 0, momentum: 5, structure: 0, volume: 0, priceAction: 0, penalties: 0, momentumTags: ['rsi_extreme'] },
      }),
      trade({
        result: 'WIN_TP1', pnlPercent: 2,
        scoreBreakdown: { trend: 0, momentum: 3, structure: 0, volume: 0, priceAction: 0, penalties: 0, momentumTags: ['rsi_healthy_pullback'] },
      }),
    ];
    const r = analyzeScoreAttribution(trades);
    expect(r.tagStats.rsi_extreme.count).toBe(2);
    expect(r.tagStats.rsi_extreme.winRate).toBe(50);
    expect(r.tagStats.rsi_healthy_pullback.count).toBe(1);
    expect(r.tagStats.rsi_healthy_pullback.winRate).toBe(100);
  });

  it('counts a trade under both its momentum and priceAction tags when it hits both', () => {
    const trades = [
      trade({
        result: 'WIN_TP1', pnlPercent: 2,
        scoreBreakdown: {
          trend: 0, momentum: 3, structure: 0, volume: 0, priceAction: 7, penalties: 0,
          momentumTags: ['macd_cross'], priceActionTags: ['engulfing'],
        },
      }),
    ];
    const r = analyzeScoreAttribution(trades);
    expect(r.tagStats.macd_cross.count).toBe(1);
    expect(r.tagStats.engulfing.count).toBe(1);
  });

  it('omits tags with zero hits rather than returning a zeroed-out entry', () => {
    const trades = [trade({ scoreBreakdown: { trend: 0, momentum: 0, structure: 0, volume: 0, priceAction: 0, penalties: 0 } })];
    const r = analyzeScoreAttribution(trades);
    expect(r.tagStats.rsi_extreme).toBeUndefined();
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

describe('analyzeScoreAttribution — confidenceBuckets', () => {
  it('only includes trades where confidence is defined — confidence is a top-level field, not inside scoreBreakdown', () => {
    const trades = [
      trade({ confidence: null }),
      trade({ confidence: 50 }),
      trade({ confidence: 65 }),
      trade({ confidence: 80 }),
    ];
    const r = analyzeScoreAttribution(trades);
    const totalCount = r.confidenceBuckets.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(3); // the null one is excluded
  });

  it('does not require scoreBreakdown to be present', () => {
    const trades = [
      trade({ confidence: 50, scoreBreakdown: null }),
      trade({ confidence: 60, scoreBreakdown: null }),
      trade({ confidence: 70, scoreBreakdown: null }),
    ];
    const r = analyzeScoreAttribution(trades);
    const totalCount = r.confidenceBuckets.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(3);
  });
});

describe('analyzeScoreAttribution — scoreBucketsByStrategy', () => {
  // 2026-08-12：這是 8/12 CSV 體檢查出的量測污染——策略A/B 的 score 是
  // 兩套不相容尺度（A: 60-77, B: 10-19），混在一起分桶會把 B 的極端值
  // 錯誤地丟進 A 的「低分桶」。這裡驗證修法：一律先依 strategy 分組。
  it('buckets score separately per strategy — never mixes scales from different strategies', () => {
    const trades = [
      // Strategy A: 3 trades, score 60-77 scale
      trade({ strategy: 'A', score: 60, pnlPercent: -2, result: 'LOSS' }),
      trade({ strategy: 'A', score: 68, pnlPercent: 2, result: 'WIN_TP1' }),
      trade({ strategy: 'A', score: 77, pnlPercent: 2, result: 'WIN_TP1' }),
      // Strategy B: 3 trades, score 10-19 scale (would land in "低" bucket
      // of a naive combined sort even though they outperform every A-tier trade)
      trade({ strategy: 'B', score: 14, pnlPercent: 7, result: 'WIN_TP2' }),
      trade({ strategy: 'B', score: 17, pnlPercent: 4, result: 'WIN_TP2' }),
      trade({ strategy: 'B', score: 10, pnlPercent: -2, result: 'LOSS' }),
    ];
    const r = analyzeScoreAttribution(trades);
    expect(r.scoreBucketsByStrategy.A.reduce((s, b) => s + b.count, 0)).toBe(3);
    expect(r.scoreBucketsByStrategy.B.reduce((s, b) => s + b.count, 0)).toBe(3);
    // B's high-scoring bucket (17) should reflect its own strong result (+2R),
    // not get diluted by being compared against A's much larger score range.
    const bHigh = r.scoreBucketsByStrategy.B.find(b => b.bucket === '高')!;
    expect(bHigh.avgR).toBeGreaterThan(0);
  });

  it('groups trades with no strategy field under "unknown" rather than guessing', () => {
    const trades = [
      trade({ strategy: undefined, score: 65 }),
      trade({ strategy: undefined, score: 70 }),
      trade({ strategy: undefined, score: 55 }),
    ];
    const r = analyzeScoreAttribution(trades);
    expect(r.scoreBucketsByStrategy.unknown).toBeDefined();
    expect(r.scoreBucketsByStrategy.A).toBeUndefined();
    expect(r.scoreBucketsByStrategy.unknown.reduce((s, b) => s + b.count, 0)).toBe(3);
  });

  it('excludes trades with no score value', () => {
    const trades = [
      trade({ strategy: 'A', score: null }),
      trade({ strategy: 'A', score: 65 }),
      trade({ strategy: 'A', score: 70 }),
      trade({ strategy: 'A', score: 75 }),
    ];
    const r = analyzeScoreAttribution(trades);
    expect(r.scoreBucketsByStrategy.A.reduce((s, b) => s + b.count, 0)).toBe(3);
  });
});

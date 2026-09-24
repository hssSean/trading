import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSignalCacheHit,
  getSignalCache,
  setSignalCache,
  cloneSignals,
  freshenCachedSignals,
  closedCandlesOnly,
  _resetSignalCache,
  type SignalCacheEntry,
} from '../src/lib/signalCache';
import type { Candle, TradingSignal } from '../src/types';

function candle(openTime: number): Candle {
  return { openTime, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: openTime + 1 };
}

function makeSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: 'orig-id',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    strength: 'STRONG',
    score: 70,
    entry: 100,
    takeProfits: [105, 110],
    stopLoss: 95,
    riskReward: 2,
    timeframe: '1h',
    timestamp: 1000,
    reasons: ['reason A'],
    indicators: {} as TradingSignal['indicators'],
    isRead: false,
    ...overrides,
  };
}

beforeEach(() => {
  _resetSignalCache();
});

describe('isSignalCacheHit', () => {
  const candles = [candle(1000), candle(2000)];

  it('false when nothing cached', () => {
    expect(isSignalCacheHit(undefined, candles, null, 'trending')).toBe(false);
  });

  it('false when candles are empty', () => {
    const cached: SignalCacheEntry = { lastBarOpenTime: 2000, htfBias: null, regime: 'trending', signals: [], dbgLong: 0, dbgShort: 0 };
    expect(isSignalCacheHit(cached, [], null, 'trending')).toBe(false);
  });

  it('true when last bar, htfBias, and regime all match', () => {
    const cached: SignalCacheEntry = { lastBarOpenTime: 2000, htfBias: 'LONG', regime: 'trending', signals: [], dbgLong: 0, dbgShort: 0 };
    expect(isSignalCacheHit(cached, candles, 'LONG', 'trending')).toBe(true);
  });

  it('false when the newest bar changed (real new candle closed)', () => {
    const cached: SignalCacheEntry = { lastBarOpenTime: 1000, htfBias: null, regime: 'trending', signals: [], dbgLong: 0, dbgShort: 0 };
    expect(isSignalCacheHit(cached, candles, null, 'trending')).toBe(false);
  });

  it('false when htfBias differs even though the bar is unchanged', () => {
    const cached: SignalCacheEntry = { lastBarOpenTime: 2000, htfBias: 'LONG', regime: 'trending', signals: [], dbgLong: 0, dbgShort: 0 };
    expect(isSignalCacheHit(cached, candles, 'SHORT', 'trending')).toBe(false);
  });

  it('false when regime differs even though the bar is unchanged (e.g. a regime-fetch failure defaulted it)', () => {
    const cached: SignalCacheEntry = { lastBarOpenTime: 2000, htfBias: null, regime: 'trending', signals: [], dbgLong: 0, dbgShort: 0 };
    expect(isSignalCacheHit(cached, candles, null, 'ranging')).toBe(false);
  });
});

describe('get/set roundtrip', () => {
  it('stores and retrieves per (symbol, timeframe) key', () => {
    const entry: SignalCacheEntry = { lastBarOpenTime: 1000, htfBias: null, regime: 'trending', signals: [makeSignal()], dbgLong: 42, dbgShort: 0 };
    setSignalCache('BTCUSDT', '1h', entry);
    expect(getSignalCache('BTCUSDT', '1h')).toEqual(entry);
    expect(getSignalCache('BTCUSDT', '15m')).toBeUndefined();
    expect(getSignalCache('ETHUSDT', '1h')).toBeUndefined();
  });
});

describe('cloneSignals', () => {
  it('produces a signal whose reasons array is independent of the original', () => {
    const original = makeSignal({ reasons: ['a'] });
    const [clone] = cloneSignals([original]);
    clone.reasons.push('mutated after clone');
    expect(original.reasons).toEqual(['a']);
  });

  it('preserves id and timestamp (unlike freshenCachedSignals)', () => {
    const original = makeSignal({ id: 'keep-me', timestamp: 12345 });
    const [clone] = cloneSignals([original]);
    expect(clone.id).toBe('keep-me');
    expect(clone.timestamp).toBe(12345);
  });
});

describe('freshenCachedSignals', () => {
  it('assigns a new id and timestamp distinct from the cached original', () => {
    const original = makeSignal({ id: 'stale-id', timestamp: 1 });
    const [fresh] = freshenCachedSignals([original]);
    expect(fresh.id).not.toBe('stale-id');
    expect(fresh.timestamp).toBeGreaterThan(1);
  });

  it('reasons array is independent of the cached original — this scan cannot corrupt future hits', () => {
    const original = makeSignal({ reasons: ['a'] });
    const [fresh] = freshenCachedSignals([original]);
    fresh.reasons.push('added downstream this scan (e.g. BTC-chaos downgrade note)');
    expect(original.reasons).toEqual(['a']);
  });

  it('a cache entry survives being handed out and mutated downstream, then read again later', () => {
    setSignalCache('BTCUSDT', '1h', {
      lastBarOpenTime: 1000, htfBias: null, regime: 'trending',
      signals: [makeSignal({ reasons: ['original reason'] })], dbgLong: 0, dbgShort: 0,
    });

    // Scan N: cache hit, hand out a freshened copy, downstream mutates it.
    const first = freshenCachedSignals(getSignalCache('BTCUSDT', '1h')!.signals);
    first[0].reasons.push('scan N added this');
    first[0].tier = 'B';

    // Scan N+1: cache hit again — must not see scan N's mutations.
    const second = freshenCachedSignals(getSignalCache('BTCUSDT', '1h')!.signals);
    expect(second[0].reasons).toEqual(['original reason']);
    expect(second[0].tier).toBeUndefined();
  });
});

// 2026-09-24（scripts/verify-strategy.ts 檢查 L1）：快取以最後一根 openTime 為 key，
// 所以餵給 generateSignals 的必須是已收盤 K 棒——否則同一根 K 棒的不同時刻會算出
// 不同訊號，而快取只留下「開盤幾分鐘」那一刻的答案。
describe('closedCandlesOnly', () => {
  const H = 3_600_000;
  const bar = (openTime: number): Candle =>
    ({ openTime, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: openTime + H - 1 });

  it('drops the still-forming last candle', () => {
    const now = 10 * H + 5 * 60_000; // 第 10 根開盤 5 分鐘
    const cs = [bar(8 * H), bar(9 * H), bar(10 * H)];
    expect(closedCandlesOnly(cs, now).map(c => c.openTime)).toEqual([8 * H, 9 * H]);
  });

  it('keeps everything when the last candle has already closed', () => {
    const now = 11 * H; // 第 10 根剛收盤、新的還沒抓回來
    const cs = [bar(8 * H), bar(9 * H), bar(10 * H)];
    expect(closedCandlesOnly(cs, now)).toHaveLength(3);
  });

  it('treats closeTime === now as still forming (closeTime is the last ms of the bar)', () => {
    const cs = [bar(9 * H), bar(10 * H)];
    expect(closedCandlesOnly(cs, 11 * H - 1)).toHaveLength(1);
  });

  it('makes the cache key stable across a bar: same input all hour → same output', () => {
    const early = [bar(8 * H), bar(9 * H), { ...bar(10 * H), close: 1.0 }];
    const late = [bar(8 * H), bar(9 * H), { ...bar(10 * H), close: 1.5 }];
    const now = 10 * H + 30 * 60_000;
    expect(closedCandlesOnly(early, now)).toEqual(closedCandlesOnly(late, now));
  });

  it('handles an empty array', () => {
    expect(closedCandlesOnly([], Date.now())).toEqual([]);
  });
});

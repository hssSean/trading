import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSignalCacheHit,
  getSignalCache,
  setSignalCache,
  cloneSignals,
  freshenCachedSignals,
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

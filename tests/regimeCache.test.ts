import { describe, it, expect, beforeEach } from 'vitest';
import {
  is4hBarUnchanged, getRegimeCache, setRegimeCache, _resetRegimeCache,
  type RegimeCacheEntry,
} from '../src/lib/regimeCache';
import type { Candle } from '../src/types';

function bar(openTime: number): Candle {
  return { openTime, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: openTime + 1 };
}

describe('is4hBarUnchanged', () => {
  it('false when there is no cached entry', () => {
    expect(is4hBarUnchanged(undefined, [bar(100)])).toBe(false);
  });

  it('false when the candle array is empty', () => {
    const cached: RegimeCacheEntry = { lastBarOpenTime: 100, adx: 25, atrPct: 60 };
    expect(is4hBarUnchanged(cached, [])).toBe(false);
  });

  it('false when the newest bar is different from what was cached (a new 4H bar closed)', () => {
    const cached: RegimeCacheEntry = { lastBarOpenTime: 100, adx: 25, atrPct: 60 };
    expect(is4hBarUnchanged(cached, [bar(0), bar(100), bar(200)])).toBe(false);
  });

  it('true when the newest bar matches the cached bar (nothing changed since last scan)', () => {
    const cached: RegimeCacheEntry = { lastBarOpenTime: 200, adx: 25, atrPct: 60 };
    expect(is4hBarUnchanged(cached, [bar(0), bar(100), bar(200)])).toBe(true);
  });

  it('only looks at the newest bar, not the whole array shape', () => {
    // Same latest bar even though the array grew from the front (older history
    // rolled in) — still a cache hit, since only the tail can move ADX/ATR.
    const cached: RegimeCacheEntry = { lastBarOpenTime: 200, adx: 25, atrPct: 60 };
    expect(is4hBarUnchanged(cached, [bar(-100), bar(0), bar(100), bar(200)])).toBe(true);
  });
});

describe('getRegimeCache / setRegimeCache', () => {
  beforeEach(() => _resetRegimeCache());

  it('returns undefined for a symbol never set', () => {
    expect(getRegimeCache('BTCUSDT')).toBeUndefined();
  });

  it('round-trips a stored entry', () => {
    setRegimeCache('BTCUSDT', { lastBarOpenTime: 100, adx: 30, atrPct: 70 });
    expect(getRegimeCache('BTCUSDT')).toEqual({ lastBarOpenTime: 100, adx: 30, atrPct: 70 });
  });

  it('overwrites a previous entry for the same symbol', () => {
    setRegimeCache('BTCUSDT', { lastBarOpenTime: 100, adx: 30, atrPct: 70 });
    setRegimeCache('BTCUSDT', { lastBarOpenTime: 200, adx: 15, atrPct: 40 });
    expect(getRegimeCache('BTCUSDT')).toEqual({ lastBarOpenTime: 200, adx: 15, atrPct: 40 });
  });

  it('keeps entries for different symbols independent', () => {
    setRegimeCache('BTCUSDT', { lastBarOpenTime: 100, adx: 30, atrPct: 70 });
    setRegimeCache('ETHUSDT', { lastBarOpenTime: 100, adx: 10, atrPct: 20 });
    expect(getRegimeCache('BTCUSDT')?.adx).toBe(30);
    expect(getRegimeCache('ETHUSDT')?.adx).toBe(10);
  });
});

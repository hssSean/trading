// Memoizes the 4H regime indicators (ADX, ATR percentile) per symbol.
//
// Why memoization instead of a truly incremental Wilder recursion: both
// achieve the same CPU win here (calcAdx/calcAtrHistory stop running every
// minute for a 4H bar that only changes every 4 hours), but a real incremental
// recursion means carrying smoothTR/smoothPlus/smoothMinus/adxVal state across
// scans forever — any dropped tick or off-by-one silently drifts the ADX away
// from what a fresh computation would give, with no way to detect the drift
// short of comparing against a full recompute. That's not a trade worth making
// for a regime classifier that gates which strategy runs.
//
// Memoization has none of that risk: the cached value is defined as "whatever
// calcAdx/calcAtrHistory would return for this exact 540-bar window," recomputed
// in full the moment the window's newest bar actually changes. Same ~239-in-240
// skip rate (a 4H bar closing while the scan runs every minute), zero chance of
// the cached number ever diverging from a fresh calculation.
import type { Candle } from '../types';

export interface RegimeCacheEntry {
  lastBarOpenTime: number;
  adx: number;
  atrPct: number;
}

// True only when the newest bar is literally the same bar the cached values
// were computed from. A 4H bar closing is the only event that can change
// ADX/ATR, so this is false roughly once every 4 hours per symbol and true
// on every other scan.
export function is4hBarUnchanged(
  cached: RegimeCacheEntry | undefined,
  candles: Candle[],
): boolean {
  if (!cached || candles.length === 0) return false;
  return candles[candles.length - 1].openTime === cached.lastBarOpenTime;
}

const cache = new Map<string, RegimeCacheEntry>();
// Generous relative to the ~15-20 actively scanned symbols; guards only
// against unbounded growth if the watch list churns over a long uptime.
const MAX_SYMBOLS = 100;

export function getRegimeCache(symbol: string): RegimeCacheEntry | undefined {
  return cache.get(symbol);
}

export function setRegimeCache(symbol: string, entry: RegimeCacheEntry): void {
  if (!cache.has(symbol) && cache.size >= MAX_SYMBOLS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(symbol); // re-insert so eviction order tracks recency
  cache.set(symbol, entry);
}

/** Test seam — module state needs a way to reset between tests. */
export function _resetRegimeCache(): void {
  cache.clear();
}

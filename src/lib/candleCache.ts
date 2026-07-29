// Relative imports on purpose: there's no vitest alias config, so a `@/` value
// import here would make this module untestable (the pure merge logic below is
// exactly the part that needs tests).
import type { Candle, Timeframe } from '../types';
import { fetchCandles } from '../api/binance';

// Incremental candle caching for the scan loop.
//
// The problem it solves: /api/analyze runs every minute and re-fetched 540 4H
// bars per symbol every single time. A 4H bar only changes every 4 hours, so
// 539 of those 540 bars were byte-identical to the previous run — but each run
// still paid to HTTP-transfer them, JSON.parse them, and rebuild 540 objects
// (6 parseFloat each). Across 15 symbols that's ~8,100 candle objects per scan
// of pure repeat work, and it was the dominant Vercel Fluid **Active CPU** cost.
//
// Why cache the parsed candle array rather than the computed indicator values:
// `adx` and `calcAtrHistory` are Wilder-smoothed recursive series — every value
// depends on the whole preceding series, so you cannot recompute them from just
// a short tail and get the same number. Caching the *input* array and splicing
// the tail keeps the input byte-identical to what the uncached path would have
// built, so the indicator outputs are identical too. This is an optimisation,
// not a behaviour change — that distinction is the whole point here (a previous
// attempt at this quota problem cut network calls, which Active CPU doesn't
// even bill for, and moved the number by zero).

export const TF_INTERVAL_MS: Record<string, number> = {
  '5m':  5 * 60_000,
  '15m': 15 * 60_000,
  '1h':  60 * 60_000,
  '4h':  4 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
};

/**
 * Splice a freshly-fetched tail onto a cached series.
 *
 * Returns null when the two don't join up — the caller must then refetch the
 * full window. That happens whenever the instance sat idle longer than the tail
 * covers (cold-ish start, low traffic), and serving a series with a hole in it
 * would silently corrupt every downstream indicator, so "refetch" is the only
 * safe answer.
 *
 * `fresh` overlapping the cached tail is the normal case (the live bar is
 * refetched every time); overlapping bars are replaced, not duplicated.
 */
export function mergeCandles(
  cached: Candle[],
  fresh: Candle[],
  limit: number,
  intervalMs: number,
): Candle[] | null {
  if (cached.length === 0 || fresh.length === 0) return null;

  const lastCachedOpen = cached[cached.length - 1].openTime;
  const firstFreshOpen = fresh[0].openTime;

  // Gap: the fresh tail starts more than one interval past where the cache
  // ends, so at least one bar in between was never fetched.
  if (firstFreshOpen > lastCachedOpen + intervalMs) return null;

  // Drop the cached bars the fresh tail supersedes, then append. Both inputs are
  // already chronological, so this stays sorted without a re-sort.
  let keepUntil = cached.length;
  while (keepUntil > 0 && cached[keepUntil - 1].openTime >= firstFreshOpen) keepUntil--;

  const merged = cached.slice(0, keepUntil).concat(fresh);
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

// Module scope: on Vercel Fluid a warm instance is reused across invocations, so
// this survives between cron runs. A cold start just refetches — slower once,
// never wrong.
const store = new Map<string, Candle[]>();

// Guards against unbounded growth if the watched-coin list churns. 15 coins ×
// a handful of timeframes fits comfortably; the oldest entry is evicted first
// (Map preserves insertion order).
const MAX_SERIES = 120;

// How many bars to pull on the incremental path. Only ever needs to cover the
// live bar plus anything closed since the last run; 5 leaves slack for a few
// missed cron ticks before the gap check forces a full refetch.
const TAIL_BARS = 5;

/** Test seam — the cache is module state, so tests need a way to reset it. */
export function _resetCandleCache(): void {
  store.clear();
}

/**
 * Same contract as fetchCandles(symbol, timeframe, limit), but only transfers
 * and parses the bars that actually changed since the last call.
 */
export async function fetchCandlesCached(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Candle[]> {
  const key = `${symbol}:${timeframe}:${limit}`;
  const intervalMs = TF_INTERVAL_MS[timeframe];
  const cached = store.get(key);

  if (cached && cached.length > 0 && intervalMs) {
    try {
      const fresh  = await fetchCandles(symbol, timeframe, TAIL_BARS);
      const merged = mergeCandles(cached, fresh, limit, intervalMs);
      if (merged) {
        store.delete(key);        // re-insert so eviction order tracks recency
        store.set(key, merged);
        return merged;
      }
      // Gap — fall through to the full refetch below.
    } catch {
      // Tail fetch failed. Returning the stale cache would hand the scan a
      // series missing the live bar; let the full refetch below try instead,
      // and if that throws too the caller's existing catch handles it.
    }
  }

  const full = await fetchCandles(symbol, timeframe, limit);
  if (store.size >= MAX_SERIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.delete(key);
  store.set(key, full);
  return full;
}

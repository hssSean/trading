import { describe, it, expect } from 'vitest';
import { mergeCandles, TF_INTERVAL_MS } from '../src/lib/candleCache';
import type { Candle } from '../src/types';

const H4 = TF_INTERVAL_MS['4h'];

// Bar N starts at N * interval. close encodes the bar so replacements are visible.
function bar(n: number, close = n, intervalMs = H4): Candle {
  const openTime = n * intervalMs;
  return {
    openTime,
    open: close, high: close + 1, low: close - 1, close,
    volume: 100,
    closeTime: openTime + intervalMs - 1,
  };
}

const series = (from: number, to: number, intervalMs = H4) => {
  const out: Candle[] = [];
  for (let n = from; n <= to; n++) out.push(bar(n, n, intervalMs));
  return out;
};

describe('mergeCandles', () => {
  it('replaces the overlapping live bar instead of duplicating it', () => {
    const cached = series(0, 9);          // bars 0..9
    const fresh  = [bar(9, 999), bar(10)]; // bar 9 re-fetched with a new close, bar 10 is new
    const merged = mergeCandles(cached, fresh, 100, H4)!;

    expect(merged.map(c => c.openTime)).toEqual(series(0, 10).map(c => c.openTime));
    // bar 9 must carry the FRESH close, not the stale cached one
    expect(merged.find(c => c.openTime === 9 * H4)!.close).toBe(999);
    expect(merged[merged.length - 1].close).toBe(10);
  });

  it('appends when the tail is exactly contiguous (no overlap)', () => {
    const cached = series(0, 9);
    const fresh  = series(10, 12);
    const merged = mergeCandles(cached, fresh, 100, H4)!;
    expect(merged).toHaveLength(13);
    expect(merged.map(c => c.close)).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it('returns the same content when the tail is entirely already-cached', () => {
    const cached = series(0, 9);
    const fresh  = [bar(8), bar(9)];
    const merged = mergeCandles(cached, fresh, 100, H4)!;
    expect(merged).toHaveLength(10);
    expect(merged.map(c => c.openTime)).toEqual(cached.map(c => c.openTime));
  });

  // The safety property: a series with a hole silently corrupts every Wilder-
  // smoothed indicator downstream, so a gap must force a full refetch, never a
  // best-effort splice.
  it('returns null when a bar is missing between cache and tail', () => {
    const cached = series(0, 9);       // ends at bar 9
    const fresh  = series(11, 13);     // bar 10 never fetched
    expect(mergeCandles(cached, fresh, 100, H4)).toBeNull();
  });

  it('accepts a tail starting exactly one interval past the cache (no hole)', () => {
    const cached = series(0, 9);
    const fresh  = series(10, 10);
    expect(mergeCandles(cached, fresh, 100, H4)).not.toBeNull();
  });

  it('returns null on empty cache or empty tail', () => {
    expect(mergeCandles([], series(0, 3), 100, H4)).toBeNull();
    expect(mergeCandles(series(0, 3), [], 100, H4)).toBeNull();
  });

  it('trims to the limit, keeping the most recent bars', () => {
    const cached = series(0, 99);
    const fresh  = [bar(99, 999), bar(100)];
    const merged = mergeCandles(cached, fresh, 50, H4)!;
    expect(merged).toHaveLength(50);
    expect(merged[merged.length - 1].openTime).toBe(100 * H4);
    expect(merged[0].openTime).toBe(51 * H4);
  });

  it('does not trim when the merged series is still under the limit', () => {
    const merged = mergeCandles(series(0, 9), [bar(10)], 540, H4)!;
    expect(merged).toHaveLength(11);
  });

  // The whole point of the cache: the spliced array must equal what a full
  // fetch would have produced, or the indicators silently diverge.
  it('produces exactly the array a full refetch would have', () => {
    const full     = series(0, 20);
    const cached   = series(0, 17);
    const tail     = series(18, 20);
    const merged   = mergeCandles(cached, tail, 540, H4)!;
    expect(merged).toEqual(full);
  });

  it('works for a non-4h interval too', () => {
    const m5 = TF_INTERVAL_MS['5m'];
    const merged = mergeCandles(series(0, 5, m5), [bar(5, 555, m5), bar(6, 6, m5)], 100, m5)!;
    expect(merged).toHaveLength(7);
    expect(merged.find(c => c.openTime === 5 * m5)!.close).toBe(555);
  });
});

// Memoizes per-(symbol, timeframe) generateSignals() output.
//
// Why this is the single biggest remaining CPU lever (docs/ANALYSIS-2026-08-04B-
// CPU曲線與容量瓶頸.md §3.1): /api/analyze scans every 5 minutes, but a
// timeframe's underlying candles only close on their own schedule — 15m every
// 15 min, 1h every 60 min. Recomputing the full signal pipeline
// (computeIndicators: EMA/RSI/MACD/BB/Donchian/ATR, structure analysis,
// OB/FVG scanning...) on a scan where the bar hasn't actually changed
// reproduces byte-identical output at 3× cost for 15m and 12× for 1h.
//
// Same memoization philosophy as regimeCache.ts: cache the FULL computed
// result, invalidate the instant any input changes, never carry state forward
// incrementally — that's what makes this safe to bolt onto a pipeline that
// gates real money decisions.
//
// htfBias and regime are included in the cache-hit check even though standard
// exchange candle boundaries nest (a 4h bar close is always also a 1h/15m/5m
// bar close, by construction — Binance klines are UTC-midnight-anchored — so
// if tf's own last bar is unchanged, neither htfBias's source timeframe nor
// the 4h regime could have changed either). The one case that breaks that
// invariant: a regime-fetch failure defaults symbolRegime to 'ranging'
// independent of any candle boundary (route.ts's "regime-fetch-failed → safe
// fallback" path) — so the explicit comparison is required for correctness,
// not just defense-in-depth.
import type { Candle, Regime, TradingSignal } from '../types';
import type { RejectedCandidate } from '../analysis/signals';

export interface SignalCacheEntry {
  lastBarOpenTime: number;
  htfBias: 'LONG' | 'SHORT' | null;
  regime: Regime | undefined;
  signals: TradingSignal[];
  dbgLong: number;
  dbgShort: number;
  // 2026-08-18（docs/TODO.md P2 #7）：被分數門檻擋掉的候選＋它的價位，給
  // score_gate 影子模擬用。跟 dbgLong/dbgShort 一起快取的理由相同——1h 訊號
  // 12 次掃描有 11 次是快取命中，不一起存的話影子候選只會在換 K 棒那一輪
  // 出現，命中/未命中行為不一致。沒有被分數擋（或根本沒候選）時是 undefined。
  rejected?: RejectedCandidate;
}

export function isSignalCacheHit(
  cached: SignalCacheEntry | undefined,
  candles: Candle[],
  htfBias: 'LONG' | 'SHORT' | null,
  regime: Regime | undefined,
): boolean {
  if (!cached || candles.length === 0) return false;
  return cached.lastBarOpenTime === candles[candles.length - 1].openTime
    && cached.htfBias === htfBias
    && cached.regime === regime;
}

// Signals get mutated in place downstream (route.ts annotates fundingRate/
// confidence/tier/suggestedRiskPct onto the top-level object, and pushes onto
// `reasons` for the BTC-chaos downgrade / scalp-tag notes — grep-confirmed the
// only nested-array mutation is `reasons`). A cache entry that shares object
// identity with what a scan hands to its caller would let this scan's
// mutations leak into a future scan's "cache hit" result. Clone deep enough
// to break that: top-level shallow copy plus a fresh `reasons` array copy.
function cloneSignal(s: TradingSignal): TradingSignal {
  return { ...s, reasons: [...s.reasons] };
}

export function cloneSignals(signals: TradingSignal[]): TradingSignal[] {
  return signals.map(cloneSignal);
}

// Returns fresh copies with regenerated id/timestamp so a cache hit is
// indistinguishable from a fresh computation to every downstream consumer
// (signal_id dedup, notification freshness, DB insert) — only the expensive
// computation is skipped, not the object-identity contract callers rely on.
export function freshenCachedSignals(signals: TradingSignal[]): TradingSignal[] {
  return signals.map(s => ({
    ...cloneSignal(s),
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
  }));
}

const cache = new Map<string, SignalCacheEntry>();
// Generous relative to ~15-20 actively scanned symbols × up to 3 timeframes.
const MAX_ENTRIES = 200;

export function getSignalCache(symbol: string, timeframe: string): SignalCacheEntry | undefined {
  return cache.get(`${symbol}:${timeframe}`);
}

export function setSignalCache(symbol: string, timeframe: string, entry: SignalCacheEntry): void {
  const key = `${symbol}:${timeframe}`;
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key); // re-insert so eviction order tracks recency
  cache.set(key, entry);
}

/** Test seam — module state needs a way to reset between tests. */
export function _resetSignalCache(): void {
  cache.clear();
}

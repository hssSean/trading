'use client';
import { useEffect, useRef } from 'react';
import { useStore } from '@/store/useStore';
import { usePriceStore } from '@/store/usePriceStore';
import { fetchPricesFor, fetchTickers24hFor, RateLimitedError } from '@/api/binance';
import { pickTp1Hits } from '@/lib/tp1Watch';

// Global live-price feed. Mounted once in the root layout so it survives route
// changes — the previous per-page pollers died on navigation, which is why the
// 記錄 page showed a price frozen at whatever the 首頁 last fetched.
//
// Two loops:
//   fast (3s)  — last price only. Drives 現價, 距進場, 浮動損益, local TP1 marking.
//   slow (60s) — 24h change, which only needs to be roughly right.
//
// Both are self-scheduling rather than setInterval: a slow round can never
// stack a second request on top of an in-flight one.
const FAST_MS = 3_000;
const SLOW_MS = 60_000;
// A Binance 429 escalates to an IP ban (418) if you keep pushing, and a ban
// takes minutes to clear — it would kill the analysis requests too, not just
// prices. So back off hard rather than retrying on the next tick.
const BACKOFF_MS = 60_000;

/** Symbols worth a price for: everything watched, plus any open trade's symbol
 *  (a coin can be removed from the watchlist while its position is still open). */
function trackedSymbols(): string[] {
  const s = useStore.getState();
  const out = new Set<string>();
  for (const c of s.coins) out.add(c.symbol);
  for (const t of s.trades) if (!t.result) out.add(t.symbol);
  return Array.from(out);
}

export function PriceFeed() {
  // Backoff is deliberately a ref: it must survive a remount, otherwise React
  // StrictMode's dev double-mount would wipe an active rate-limit backoff.
  const backoffUntilRef = useRef(0);

  useEffect(() => {
    // Local to this effect run, NOT a ref. With a shared ref, StrictMode's
    // mount→cleanup→mount would have the second mount reset the flag while the
    // first loop was still awaiting its fetch, so the old loop resurrected
    // itself and we polled at double rate forever.
    let stopped = false;

    const runFast = async () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() < backoffUntilRef.current) return;

      const symbols = trackedSymbols();
      if (symbols.length === 0) return;

      try {
        const prices = await fetchPricesFor(symbols);
        if (stopped) return;
        usePriceStore.getState().setPrices(prices);
        if (usePriceStore.getState().rateLimited) usePriceStore.getState().setRateLimited(false);

        // Flip cards to "✅ TP1·等TP2" immediately. Cosmetic only — the real
        // close is the server's call (monitorActiveTrades).
        const hits = pickTp1Hits(useStore.getState().trades, sym => prices.get(sym) ?? 0);
        if (hits.length > 0) {
          const hitSet = new Set(hits);
          useStore.setState(s => ({
            trades: s.trades.map(t => (hitSet.has(t.id) ? { ...t, status: 'tp1_hit' as const } : t)),
          }));
        }
      } catch (err) {
        if (err instanceof RateLimitedError) {
          backoffUntilRef.current = Date.now() + BACKOFF_MS;
          usePriceStore.getState().setRateLimited(true);
        }
        // Anything else (offline, DNS, timeout): stay quiet, next tick retries.
      }
    };

    const runSlow = async () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() < backoffUntilRef.current) return;

      const symbols = trackedSymbols();
      if (symbols.length === 0) return;

      try {
        const tickers = await fetchTickers24hFor(symbols);
        if (stopped) return;
        usePriceStore.getState().setTickers24h(tickers);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          backoffUntilRef.current = Date.now() + BACKOFF_MS;
          usePriceStore.getState().setRateLimited(true);
        }
      }
    };

    // Self-scheduling loop: the next tick is queued only after this one settles.
    let fastTimer: ReturnType<typeof setTimeout>;
    let slowTimer: ReturnType<typeof setTimeout>;
    const loopFast = async () => {
      await runFast();
      if (stopped) return;
      fastTimer = setTimeout(loopFast, FAST_MS);
    };
    const loopSlow = async () => {
      await runSlow();
      if (stopped) return;
      slowTimer = setTimeout(loopSlow, SLOW_MS);
    };

    // Coming back to the tab must not wait out a full interval — that's the
    // exact moment the user is looking at a stale number.
    const onVisible = () => { if (document.visibilityState === 'visible') { runFast(); runSlow(); } };
    document.addEventListener('visibilitychange', onVisible);

    loopFast();
    loopSlow();

    return () => {
      stopped = true;
      clearTimeout(fastTimer);
      clearTimeout(slowTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}

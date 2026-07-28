'use client';
import { create } from 'zustand';

// Live prices live in their own ephemeral store, deliberately NOT in useStore.
//
// Two reasons, both of which bit us when prices were a field on WatchedCoin:
//   1. useStore is persisted (zustand/persist). Every price write re-serialized
//      the whole blob — coins + 100 signals + all trades — to localStorage.
//      At a 3s refresh that's a synchronous main-thread write every 3s.
//   2. StoreHydration subscribes to useStore and debounces a Supabase save 4s
//      after any change. A 3s price tick would reset that timer forever, so the
//      debounced save would never fire at all.
//
// Keeping prices out of useStore makes both problems structurally impossible
// rather than something to remember to guard against.
export interface PriceTick {
  price: number;
  /** 24h absolute change. Refreshed on the slow loop, so may lag `price`. */
  change24h: number;
  /** 24h percent change. Refreshed on the slow loop, so may lag `price`. */
  changePct24h: number;
  /** When `price` last *changed* (ms epoch). 0 = never fetched. For "last
   *  fetched", read `lastTickAt` — a flat market leaves `at` behind on purpose. */
  at: number;
}

interface PriceState {
  prices: Record<string, PriceTick>;
  /** Last successful fast-loop tick (ms epoch). 0 = no price data yet. */
  lastTickAt: number;
  /** Set while backing off from a Binance 429/418. Surfaced as a UI hint. */
  rateLimited: boolean;

  setPrices: (next: Map<string, number>) => void;
  setTickers24h: (next: Map<string, { price: number; priceChange: number; priceChangePercent: number }>) => void;
  setRateLimited: (v: boolean) => void;
}

const EMPTY: PriceTick = { price: 0, change24h: 0, changePct24h: 0, at: 0 };

export const usePriceStore = create<PriceState>()((set) => ({
  prices: {},
  lastTickAt: 0,
  rateLimited: false,

  setPrices: (next) =>
    set((s) => {
      if (next.size === 0) return s;
      const at = Date.now();
      let changed = false;
      const prices = { ...s.prices };
      next.forEach((price, symbol) => {
        const prev = prices[symbol];
        // Skip unchanged prices so the tick object keeps its identity — that's
        // what stops every subscriber re-rendering on every 3s poll.
        if (prev && prev.price === price) return;
        prices[symbol] = { ...(prev ?? EMPTY), price, at };
        changed = true;
      });
      if (!changed) return { lastTickAt: at };
      return { prices, lastTickAt: at };
    }),

  setTickers24h: (next) =>
    set((s) => {
      if (next.size === 0) return s;
      const at = Date.now();
      const prices = { ...s.prices };
      next.forEach((t, symbol) => {
        prices[symbol] = {
          price: t.price,
          change24h: t.priceChange,
          changePct24h: t.priceChangePercent,
          at,
        };
      });
      return { prices, lastTickAt: at };
    }),

  setRateLimited: (v) => set({ rateLimited: v }),
}));

// ── Read helpers ──────────────────────────────────────────────
// 0 means "no price yet" everywhere in the UI (see fmtPrice's `if (!p) return '—'`),
// so callers can keep using the existing `px > 0` guards unchanged.

/** Subscribe to one symbol's price. Re-renders only when that symbol moves. */
export const usePrice = (symbol: string): number =>
  usePriceStore((s) => s.prices[symbol]?.price ?? 0);

/** Subscribe to one symbol's full tick (price + 24h change). */
export const useTick = (symbol: string): PriceTick =>
  usePriceStore((s) => s.prices[symbol] ?? EMPTY);

/** Non-reactive read, for use inside intervals/callbacks. */
export const getPrice = (symbol: string): number =>
  usePriceStore.getState().prices[symbol]?.price ?? 0;

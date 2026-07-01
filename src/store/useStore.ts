'use client';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { WatchedCoin, TradingSignal, AppSettings, Timeframe, TradeRecord, TradeResult } from '@/types';

const DEFAULT_SETTINGS: AppSettings = {
  analysisIntervalMinutes: 15,
  notificationsEnabled: true,
  minSignalStrength: 'MODERATE',
  defaultTimeframes: ['4h', '1h'],
  vibrationEnabled: true,
  soundEnabled: false,
};

export function makeCoin(symbol: string, timeframes: Timeframe[]): WatchedCoin {
  const base = symbol.replace('USDT', '');
  return {
    symbol,
    displayName: `${base}/USDT`,
    baseAsset: base,
    quoteAsset: 'USDT',
    timeframes,
    currentPrice: 0,
    priceChange24h: 0,
    priceChangePercent24h: 0,
    lastAnalyzed: 0,
    signals: [],
    isLoading: false,
  };
}

const DEFAULT_COINS: WatchedCoin[] = [
  makeCoin('BTCUSDT', ['4h', '1h']),
  makeCoin('ETHUSDT', ['4h', '1h']),
];

interface StoreState {
  coins: WatchedCoin[];
  settings: AppSettings;
  allSignals: TradingSignal[];
  trades: TradeRecord[];
  lineToken: string;
  lineUserId: string;
  webhookSecret: string;
  _hasHydrated: boolean;

  setHasHydrated: (v: boolean) => void;
  addCoin: (symbol: string) => void;
  removeCoin: (symbol: string) => void;
  updateCoin: (symbol: string, patch: Partial<WatchedCoin>) => void;
  addSignals: (symbol: string, signals: TradingSignal[]) => void;
  markSignalRead: (signalId: string) => void;
  clearSignals: (symbol?: string) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  setLine: (token: string, userId: string) => void;
  setWebhookSecret: (secret: string) => void;
  // Trade journal
  addTrade: (signal: TradingSignal) => void;
  closeTrade: (id: string, result: TradeResult, exitPrice: number) => void;
  deleteTrade: (id: string) => void;
  hasActiveTrade: (symbol: string) => boolean;
}

const safeStorage = typeof window !== 'undefined' ? localStorage : {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      coins: DEFAULT_COINS,
      settings: DEFAULT_SETTINGS,
      allSignals: [],
      trades: [],
      lineToken: '',
      lineUserId: '',
      webhookSecret: 'abc123',
      _hasHydrated: false,

      setHasHydrated: (v) => set({ _hasHydrated: v }),

      addCoin: (symbol) => {
        if (get().coins.some((c) => c.symbol === symbol)) return;
        set((s) => ({
          coins: [...s.coins, makeCoin(symbol, s.settings.defaultTimeframes)],
        }));
      },

      removeCoin: (symbol) =>
        set((s) => ({
          coins: s.coins.filter((c) => c.symbol !== symbol),
          allSignals: s.allSignals.filter((sg) => sg.symbol !== symbol),
        })),

      updateCoin: (symbol, patch) =>
        set((s) => ({
          coins: s.coins.map((c) => (c.symbol === symbol ? { ...c, ...patch } : c)),
        })),

      addSignals: (symbol, newSignals) => {
        if (!newSignals.length) return;
        set((s) => ({
          coins: s.coins.map((c) =>
            c.symbol === symbol
              ? { ...c, signals: newSignals.slice(0, 10), lastAnalyzed: Date.now() }
              : c,
          ),
          allSignals: [
            ...newSignals,
            ...s.allSignals.filter((sg) => sg.symbol !== symbol),
          ].slice(0, 200),
        }));
      },

      markSignalRead: (signalId) =>
        set((s) => ({
          allSignals: s.allSignals.map((sg) =>
            sg.id === signalId ? { ...sg, isRead: true } : sg,
          ),
          coins: s.coins.map((c) => ({
            ...c,
            signals: c.signals.map((sg) =>
              sg.id === signalId ? { ...sg, isRead: true } : sg,
            ),
          })),
        })),

      clearSignals: (symbol) => {
        if (symbol) {
          set((s) => ({
            allSignals: s.allSignals.filter((sg) => sg.symbol !== symbol),
            coins: s.coins.map((c) => (c.symbol === symbol ? { ...c, signals: [] } : c)),
          }));
        } else {
          set((s) => ({
            allSignals: [],
            coins: s.coins.map((c) => ({ ...c, signals: [] })),
          }));
        }
      },

      updateSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),

      setLine: (token, userId) =>
        set({ lineToken: token, lineUserId: userId }),

      setWebhookSecret: (secret) => set({ webhookSecret: secret }),

      // ── Trade journal ──────────────────────────────────────
      addTrade: (signal) => {
        const existing = get().trades;
        // Skip if same coin already has a pending trade
        if (existing.some((t) => t.symbol === signal.symbol && !t.result)) return;
        const trade: TradeRecord = {
          id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          signalId: signal.id,
          symbol: signal.symbol,
          direction: signal.direction,
          timeframe: signal.timeframe,
          strength: signal.strength,
          score: signal.score,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          tp1: signal.takeProfits[0],
          tp2: signal.takeProfits[1] ?? signal.takeProfits[0],
          reasons: signal.reasons,
          openedAt: Date.now(),
        };
        set((s) => ({ trades: [trade, ...s.trades].slice(0, 500) }));
      },

      closeTrade: (id, result, exitPrice) => {
        set((s) => ({
          trades: s.trades.map((t) => {
            if (t.id !== id) return t;
            const pnl = t.direction === 'LONG'
              ? ((exitPrice - t.entry) / t.entry) * 100
              : ((t.entry - exitPrice) / t.entry) * 100;
            return { ...t, result, exitPrice, closedAt: Date.now(), pnlPercent: parseFloat(pnl.toFixed(2)) };
          }),
        }));
      },

      deleteTrade: (id) =>
        set((s) => ({ trades: s.trades.filter((t) => t.id !== id) })),

      hasActiveTrade: (symbol) =>
        get().trades.some((t) => t.symbol === symbol && !t.result),
    }),
    {
      name: 'crypto-trader-v2',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({
        coins: s.coins.map((c) => ({ ...c, isLoading: false })),
        settings: s.settings,
        allSignals: s.allSignals.slice(0, 100),
        trades: s.trades.slice(0, 500),
        lineToken: s.lineToken,
        lineUserId: s.lineUserId,
        webhookSecret: s.webhookSecret,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { TradeRecord } from '@/types';

interface CloudData {
  watchlist:   { symbol: string; timeframes: string[] }[];
  trades:      TradeRecord[];
  lineToken?:  string;
  lineUserId?: string;
  savedAt:     number;
}

async function saveToCloud(secret: string) {
  if (!secret) return;
  const store = useStore.getState();
  try {
    await fetch(`/api/sync?secret=${encodeURIComponent(secret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        watchlist:  store.coins.map(c => ({ symbol: c.symbol, timeframes: c.timeframes })),
        trades:     store.trades,
        lineToken:  store.lineToken,
        lineUserId: store.lineUserId,
      } satisfies Omit<CloudData, 'savedAt'>),
    });
  } catch { /* ignore */ }
}

export function StoreHydration({ children }: { children: React.ReactNode }) {
  const hasHydrated = useStore(s => s._hasHydrated);
  const [mounted, setMounted]           = useState(false);
  const [cloudReady, setCloudReady]     = useState(false);
  const saveTimerRef                    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cloudLoadedRef                  = useRef(false);

  useEffect(() => { setMounted(true); }, []);

  // ── Cloud sync: load on startup, auto-save on key state changes ──
  useEffect(() => {
    if (!hasHydrated || cloudLoadedRef.current) return;
    cloudLoadedRef.current = true;

    const secret = useStore.getState().webhookSecret;

    const loadFromCloud = async () => {
      if (!secret) { setCloudReady(true); return; }
      try {
        const res = await fetch(`/api/sync?secret=${encodeURIComponent(secret)}`);
        if (!res.ok) { setCloudReady(true); return; }
        const { data }: { data: CloudData | null } = await res.json();
        if (data) {
          const store = useStore.getState();
          // Merge watchlist — add any coins from cloud not in local
          const existing = new Set(store.coins.map(c => c.symbol));
          (data.watchlist ?? []).forEach(w => { if (!existing.has(w.symbol)) store.addCoin(w.symbol); });
          // Merge trades — add any trades from cloud not in local (dedup by id)
          const existingIds = new Set(store.trades.map(t => t.id));
          const newTrades = (data.trades ?? []).filter(t => !existingIds.has(t.id));
          if (newTrades.length > 0 || (data.lineToken && !store.lineToken) || (data.lineUserId && !store.lineUserId)) {
            useStore.setState(s => ({
              trades:    [...newTrades, ...s.trades].slice(0, 500),
              lineToken:  data.lineToken  || s.lineToken,
              lineUserId: data.lineUserId || s.lineUserId,
            }));
          }
        }
      } catch { /* ignore network errors */ }
      setCloudReady(true);
    };

    loadFromCloud();

    // Auto-save when coins/trades/LINE config change (debounced 4s)
    const unsub = useStore.subscribe(() => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const s = useStore.getState();
      saveTimerRef.current = setTimeout(() => saveToCloud(s.webhookSecret), 4000);
    });

    // Periodic save every 10 minutes as a safeguard
    const periodicId = setInterval(() => saveToCloud(useStore.getState().webhookSecret), 10 * 60 * 1000);

    return () => {
      unsub();
      clearInterval(periodicId);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [hasHydrated]);

  if (!mounted || !hasHydrated) {
    return (
      <div className="min-h-dvh bg-[#0A0A0F] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Cloud ready state is available but we don't block rendering on it
  void cloudReady;

  return <>{children}</>;
}

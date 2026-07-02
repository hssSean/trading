'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useStore } from '@/store/useStore';
import { supabase } from '@/lib/supabase';
import { TradeRecord } from '@/types';

// ── Supabase sync helpers ──────────────────────────────────────────

async function loadFromSupabase(userId: string) {
  const store = useStore.getState();

  // Load watchlist
  const { data: wl } = await supabase.from('watchlist').select('symbol,timeframes').eq('user_id', userId);
  if (wl) {
    const existing = new Set(store.coins.map(c => c.symbol));
    wl.forEach(r => { if (!existing.has(r.symbol)) store.addCoin(r.symbol); });
  }

  // Load trades
  const { data: tr } = await supabase.from('trades').select('*').eq('user_id', userId).order('opened_at', { ascending: false });
  if (tr && tr.length > 0) {
    const existingIds = new Set(store.trades.map(t => t.id));
    const incoming: TradeRecord[] = tr
      .filter(r => !existingIds.has(r.id))
      .map(r => ({
        id:            r.id,
        signalId:      r.signal_id ?? '',
        symbol:        r.symbol,
        direction:     r.direction,
        timeframe:     r.timeframe,
        strength:      r.strength ?? 'STRONG',
        score:         r.score ?? 0,
        entry:         r.entry,
        stopLoss:      r.stop_loss,
        tp1:           r.tp1,
        tp2:           r.tp2,
        reasons:       r.reasons ?? [],
        entryNotes:    r.entry_notes ?? '',
        entryChartUrl: r.entry_chart_url ?? '',
        exitChartUrl:  r.exit_chart_url ?? '',
        openedAt:      r.opened_at,
        closedAt:      r.closed_at ?? undefined,
        result:        r.result ?? undefined,
        exitPrice:     r.exit_price ?? undefined,
        pnlPercent:    r.pnl_percent ?? undefined,
      }));
    if (incoming.length > 0) {
      useStore.setState(s => ({ trades: [...incoming, ...s.trades].slice(0, 500) }));
    }
  }

  // Load profile
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (prof) {
    useStore.setState(s => ({
      lineToken:     prof.line_token  || s.lineToken,
      lineUserId:    prof.line_user_id || s.lineUserId,
      webhookSecret: prof.webhook_secret || s.webhookSecret,
      settings:      prof.settings ? { ...s.settings, ...(prof.settings as object) } : s.settings,
    }));
  }
}

async function saveToSupabase(userId: string) {
  const s = useStore.getState();

  // Upsert profile
  await supabase.from('profiles').upsert({
    id:             userId,
    line_token:     s.lineToken,
    line_user_id:   s.lineUserId,
    webhook_secret: s.webhookSecret,
    settings:       s.settings,
  });

  // Upsert watchlist
  const watchRows = s.coins.map(c => ({ user_id: userId, symbol: c.symbol, timeframes: c.timeframes }));
  if (watchRows.length > 0) await supabase.from('watchlist').upsert(watchRows, { onConflict: 'user_id,symbol' });

  // Upsert trades
  const tradeRows = s.trades.map(t => ({
    id:             t.id,
    user_id:        userId,
    signal_id:      t.signalId,
    symbol:         t.symbol,
    direction:      t.direction,
    timeframe:      t.timeframe,
    strength:       t.strength,
    score:          t.score,
    entry:          t.entry,
    stop_loss:      t.stopLoss,
    tp1:            t.tp1,
    tp2:            t.tp2,
    reasons:        t.reasons,
    entry_notes:    t.entryNotes ?? '',
    entry_chart_url: t.entryChartUrl ?? '',
    exit_chart_url:  t.exitChartUrl  ?? '',
    opened_at:      t.openedAt,
    closed_at:      t.closedAt ?? null,
    result:         t.result ?? null,
    exit_price:     t.exitPrice ?? null,
    pnl_percent:    t.pnlPercent ?? null,
  }));
  if (tradeRows.length > 0) await supabase.from('trades').upsert(tradeRows, { onConflict: 'id' });
}

// ── Component ──────────────────────────────────────────────────────

export function StoreHydration({ children }: { children: React.ReactNode }) {
  const hasHydrated = useStore(s => s._hasHydrated);
  const [mounted, setMounted]     = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [userId, setLocalUserId]  = useState<string | null>(null);
  const saveTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncDoneRef               = useRef(false);
  const router   = useRouter();
  const pathname = usePathname();

  useEffect(() => { setMounted(true); }, []);

  // ── Auth check on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;

    supabase.auth.getSession().then(({ data: { session } }) => {
      const uid = session?.user?.id ?? null;
      setLocalUserId(uid);
      if (uid) useStore.getState().setUserId(uid);
      setAuthReady(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      const uid = session?.user?.id ?? null;
      setLocalUserId(uid);
      if (uid) useStore.getState().setUserId(uid);
      else      useStore.getState().setUserId('');
    });

    return () => subscription.unsubscribe();
  }, [mounted]);

  // ── Redirect to /login if not authenticated ──────────────────────
  useEffect(() => {
    if (!authReady) return;
    if (!userId && pathname !== '/login') router.replace('/login');
  }, [authReady, userId, pathname, router]);

  // ── Load from Supabase after auth ────────────────────────────────
  useEffect(() => {
    if (!userId || !hasHydrated || syncDoneRef.current) return;
    syncDoneRef.current = true;
    loadFromSupabase(userId).catch(() => {});

    // Auto-save on state changes (debounced 4s)
    const unsub = useStore.subscribe(() => {
      if (!useStore.getState().userId) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const uid = useStore.getState().userId;
        if (uid) saveToSupabase(uid).catch(() => {});
      }, 4000);
    });

    // Periodic save every 10 min
    const periodic = setInterval(() => {
      const uid = useStore.getState().userId;
      if (uid) saveToSupabase(uid).catch(() => {});
    }, 10 * 60 * 1000);

    return () => {
      unsub();
      clearInterval(periodic);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [userId, hasHydrated]);

  // Show spinner during init
  if (!mounted || !hasHydrated) {
    return (
      <div className="min-h-dvh bg-[#0A0A0F] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // While checking auth, show blank (avoid flash)
  if (!authReady) {
    return (
      <div className="min-h-dvh bg-[#0A0A0F] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}

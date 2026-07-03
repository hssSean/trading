'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useStore } from '@/store/useStore';
import { supabase } from '@/lib/supabase';
import { TradeRecord } from '@/types';

// Tracks IDs deleted in this session so loadFromSupabase won't re-add them.
// Module-level so it persists across re-renders and periodic syncs.
const sessionDeletedIds = new Set<string>();

export async function deleteTradePermanently(tradeId: string): Promise<void> {
  sessionDeletedIds.add(tradeId);
  useStore.getState().deleteTrade(tradeId);
  const userId = useStore.getState().userId;
  if (userId) {
    try {
      await supabase.from('trades').delete().eq('id', tradeId).eq('user_id', userId);
    } catch { /* best effort — sessionDeletedIds prevents re-add even if this fails */ }
  }
}

// ── Supabase sync helpers ──────────────────────────────────────────

export async function loadFromSupabase(userId: string) {
  const store = useStore.getState();

  // Load watchlist
  const { data: wl } = await supabase.from('watchlist').select('symbol,timeframes').eq('user_id', userId);
  if (wl) {
    const existing = new Set(store.coins.map(c => c.symbol));
    wl.forEach(r => { if (!existing.has(r.symbol)) store.addCoin(r.symbol); });
  }

  // Load trades — only 'active' or closed trades (not 'waiting' limit orders pending fill)
  const { data: tr } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .or('status.eq.active,status.is.null,result.not.is.null')
    .order('opened_at', { ascending: false });
  if (tr && tr.length > 0) {
    const existingMap       = new Map(store.trades.map(t => [t.id, t]));
    const existingSignalIds = new Set(store.trades.map(t => t.signalId).filter(Boolean));
    const activeSymbols     = new Set(store.trades.filter(t => !t.result && t.status !== 'waiting').map(t => t.symbol));
    const incoming: TradeRecord[] = [];

    for (const r of tr) {
      // Skip waiting limit orders — server will upgrade to 'active' on fill
      if (r.status === 'waiting') continue;
      // Skip trades deleted in this session — don't let the sync resurrect them
      if (sessionDeletedIds.has(r.id)) continue;

      if (existingMap.has(r.id)) {
        // Trade already in local store — check if server closed it while app was open
        const local = existingMap.get(r.id)!;
        if (r.result && !local.result) {
          useStore.getState().closeTrade(r.id, r.result, r.exit_price ?? 0);
        }
        // If server upgraded status from waiting → active (fill confirmed)
        if (r.status === 'active' && local.status === 'waiting') {
          useStore.setState(s => ({
            trades: s.trades.map(t => t.id === r.id ? { ...t, status: 'active' as const } : t),
          }));
        }
      } else if (
        !existingSignalIds.has(r.signal_id ?? '') &&
        (r.result != null || !activeSymbols.has(r.symbol))
      ) {
        const record: TradeRecord = {
          id:          r.id,
          signalId:    r.signal_id ?? '',
          symbol:      r.symbol,
          direction:   r.direction,
          timeframe:   r.timeframe,
          strength:    r.strength ?? 'STRONG',
          score:       r.score ?? 0,
          entry:       r.entry,
          stopLoss:    r.stop_loss,
          tp1:         r.tp1,
          tp2:         r.tp2,
          reasons:     r.reasons ?? [],
          entryNotes:  r.entry_notes ?? '',
          openedAt:    r.opened_at,
          closedAt:    r.closed_at ?? undefined,
          result:      r.result ?? undefined,
          exitPrice:   r.exit_price ?? undefined,
          pnlPercent:  r.pnl_percent ?? undefined,
          status:      (r.status as 'waiting' | 'active' | undefined) ?? 'active',
          signalPrice: r.signal_price ?? undefined,
        };
        incoming.push(record);
        existingSignalIds.add(r.signal_id ?? '');
        if (!r.result) activeSymbols.add(r.symbol);
      }
    }

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

  // Upsert trades (skip waiting — server manages those directly)
  const tradeRows = s.trades
    .filter(t => t.status !== 'waiting')
    .map(t => ({
      id:           t.id,
      user_id:      userId,
      signal_id:    t.signalId,
      symbol:       t.symbol,
      direction:    t.direction,
      timeframe:    t.timeframe,
      strength:     t.strength,
      score:        t.score,
      entry:        t.entry,
      stop_loss:    t.stopLoss,
      tp1:          t.tp1,
      tp2:          t.tp2,
      reasons:      t.reasons,
      entry_notes:  t.entryNotes ?? '',
      opened_at:    t.openedAt,
      closed_at:    t.closedAt ?? null,
      result:       t.result ?? null,
      exit_price:   t.exitPrice ?? null,
      pnl_percent:  t.pnlPercent ?? null,
      status:       t.status ?? 'active',
      signal_price: t.signalPrice ?? null,
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

    // Server writes trades directly to Supabase with status='waiting'|'active',
    // so we only need to load from Supabase — no manual pickup needed.
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
    const periodicSave = setInterval(() => {
      const uid = useStore.getState().userId;
      if (uid) saveToSupabase(uid).catch(() => {});
    }, 10 * 60 * 1000);

    // Periodic re-sync from Supabase every 2 min:
    // - picks up trades inserted by server (LINE signal auto-write)
    // - reflects server-side TP/SL auto-close results
    const periodicSync = setInterval(async () => {
      const uid = useStore.getState().userId;
      if (uid) await loadFromSupabase(uid).catch(() => {});
    }, 2 * 60 * 1000);

    return () => {
      unsub();
      clearInterval(periodicSave);
      clearInterval(periodicSync);
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

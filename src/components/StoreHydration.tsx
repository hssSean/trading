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

function rowToRecord(r: Record<string, unknown>): TradeRecord {
  return {
    id:          r.id as string,
    signalId:    (r.signal_id as string | null) ?? '',
    symbol:      r.symbol as string,
    direction:   r.direction as 'LONG' | 'SHORT',
    timeframe:   r.timeframe as TradeRecord['timeframe'],
    strength:    (r.strength as TradeRecord['strength']) ?? 'STRONG',
    score:       (r.score as number) ?? 0,
    entry:       r.entry as number,
    stopLoss:    r.stop_loss as number,
    tp1:         r.tp1 as number,
    tp2:         r.tp2 as number,
    reasons:     (r.reasons as string[]) ?? [],
    entryNotes:  (r.entry_notes as string) ?? '',
    openedAt:    r.opened_at as number,
    closedAt:    (r.closed_at as number | null) ?? undefined,
    result:      (r.result as TradeRecord['result']) ?? undefined,
    exitPrice:   (r.exit_price as number | null) ?? undefined,
    pnlPercent:  (r.pnl_percent as number | null) ?? undefined,
    status:      ((r.status as string | null) as 'waiting' | 'active' | undefined) ?? 'active',
    signalPrice: (r.signal_price as number | null) ?? undefined,
  };
}

// ── Additive sync (used by periodic background sync) ──────────────
// Only adds trades that are new or have been updated on the server.
// Does NOT remove local trades — safe for background use.
export async function loadFromSupabase(userId: string) {
  const store = useStore.getState();

  // Load watchlist
  const { data: wl } = await supabase.from('watchlist').select('symbol,timeframes').eq('user_id', userId);
  if (wl) {
    const existing = new Set(store.coins.map(c => c.symbol));
    wl.forEach(r => { if (!existing.has(r.symbol)) store.addCoin(r.symbol); });
  }

  // Load all trades including 'waiting' limit orders
  const { data: tr } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('opened_at', { ascending: false });
  if (tr && tr.length > 0) {
    const existingMap       = new Map(store.trades.map(t => [t.id, t]));
    const existingSignalIds = new Set(store.trades.map(t => t.signalId).filter(Boolean));
    const activeSymbols     = new Set(store.trades.filter(t => !t.result && t.status !== 'waiting').map(t => t.symbol));
    const incoming: TradeRecord[] = [];

    for (const r of tr as Record<string, unknown>[]) {
      if (sessionDeletedIds.has(r.id as string)) continue;

      if (existingMap.has(r.id as string)) {
        const local = existingMap.get(r.id as string)!;
        if (r.result && !local.result) {
          useStore.getState().closeTrade(r.id as string, r.result as TradeRecord['result'] & string, (r.exit_price as number) ?? 0);
        }
        if (r.status === 'active' && local.status === 'waiting') {
          useStore.setState(s => ({
            trades: s.trades.map(t => t.id === r.id ? { ...t, status: 'active' as const } : t),
          }));
        }
      } else if (
        !existingSignalIds.has((r.signal_id as string) ?? '') &&
        (r.result != null || r.status === 'waiting' || !activeSymbols.has(r.symbol as string))
      ) {
        const record = rowToRecord(r);
        incoming.push(record);
        existingSignalIds.add((r.signal_id as string) ?? '');
        if (!r.result) activeSymbols.add(r.symbol as string);
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

// ── Full replace sync (used by manual "同步紀錄" button) ──────────
// Correct order: download FIRST (so we never overwrite a closed trade with an
// open local copy), then upload only what Supabase is missing or behind on,
// then set local state to the authoritative server result.
export async function fullSyncFromSupabase(userId: string): Promise<number> {
  // Step 1: Download authoritative server state FIRST
  const { data: tr } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('opened_at', { ascending: false });

  const serverMap = new Map<string, TradeRecord>();
  if (tr) {
    for (const r of tr as Record<string, unknown>[]) {
      if (!sessionDeletedIds.has(r.id as string)) {
        serverMap.set(r.id as string, rowToRecord(r));
      }
    }
  }

  const localStore = useStore.getState().trades;

  // Step 2: Upload only what Supabase is missing or behind on:
  //   - New local trades not yet in Supabase
  //   - Local trades we closed but Supabase still has as open
  // Never overwrite a Supabase result with a local open state.
  const toUpload = localStore
    .filter(t => t.status !== 'waiting' && !sessionDeletedIds.has(t.id))
    .filter(t => {
      const sv = serverMap.get(t.id);
      if (!sv) return true;                    // new local trade
      if (t.result && !sv.result) return true; // local has close result, server doesn't
      return false;                            // server state is same or newer — don't overwrite
    });

  if (toUpload.length > 0) {
    const rows = toUpload.map(t => ({
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
    await supabase.from('trades').upsert(rows, { onConflict: 'id' });
    toUpload.forEach(t => serverMap.set(t.id, t));
  }

  // Step 3: Deduplicate by signalId — two devices may have independently created
  // separate trade records for the same signal. Keep the most final state
  // (closed wins; ties broken by newest openedAt) and delete the duplicates.
  const signalBuckets: Record<string, TradeRecord[]> = {};
  Array.from(serverMap.values()).forEach(t => {
    if (!t.signalId) return;
    signalBuckets[t.signalId] = signalBuckets[t.signalId] ?? [];
    signalBuckets[t.signalId].push(t);
  });
  const dupesToDelete: string[] = [];
  Object.values(signalBuckets).forEach((records: TradeRecord[]) => {
    if (records.length < 2) return;
    records.sort((a: TradeRecord, b: TradeRecord) =>
      (b.result ? 1 : 0) - (a.result ? 1 : 0) || b.openedAt - a.openedAt
    );
    records.slice(1).forEach((t: TradeRecord) => {
      dupesToDelete.push(t.id);
      serverMap.delete(t.id);
      sessionDeletedIds.add(t.id);
    });
  });
  if (dupesToDelete.length > 0) {
    await supabase.from('trades').delete().in('id', dupesToDelete).eq('user_id', userId);
  }

  // Step 4: Final state = authoritative server set
  // Preserve any local-only trades not yet reflected in Supabase
  const localOnly = localStore.filter(
    t => !serverMap.has(t.id) && !sessionDeletedIds.has(t.id)
  );
  const merged = [...Array.from(serverMap.values()), ...localOnly]
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 500);

  const before = localStore.length;
  useStore.setState({ trades: merged });

  // Also sync watchlist + profile
  const { data: wl } = await supabase.from('watchlist').select('symbol,timeframes').eq('user_id', userId);
  if (wl) {
    const existing = new Set(useStore.getState().coins.map(c => c.symbol));
    wl.forEach(r => { if (!existing.has(r.symbol)) useStore.getState().addCoin(r.symbol); });
  }
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (prof) {
    useStore.setState(s => ({
      lineToken:     prof.line_token  || s.lineToken,
      lineUserId:    prof.line_user_id || s.lineUserId,
      webhookSecret: prof.webhook_secret || s.webhookSecret,
      settings:      prof.settings ? { ...s.settings, ...(prof.settings as object) } : s.settings,
    }));
  }

  return Math.abs(merged.length - before);
}

export async function saveToSupabase(userId: string) {
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

    // Sync immediately when user returns to the tab (e.g. after LINE notification)
    // First save local → server (upload any changes made while offline or on another device),
    // then load server → local (pick up changes from other devices).
    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible') return;
      const uid = useStore.getState().userId;
      if (!uid) return;
      // Load first so we pick up closes from other devices before uploading our state.
      await loadFromSupabase(uid).catch(() => {});
      await saveToSupabase(uid).catch(() => {});
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unsub();
      clearInterval(periodicSave);
      clearInterval(periodicSync);
      document.removeEventListener('visibilitychange', handleVisibility);
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

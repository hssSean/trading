'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useStore } from '@/store/useStore';
import { supabase } from '@/lib/supabase';
import { fetchCandles } from '@/api/binance';
import { TradeRecord, TradeResult, TradingSignal } from '@/types';
import { resolveServerOutcome, deriveTp1Status, resolveStatus } from '@/lib/tradeSync';

// Tracks IDs deleted in this session so loadFromSupabase won't re-add them.
// Module-level so it persists across re-renders and periodic syncs.
const sessionDeletedIds = new Set<string>();

// Same guard as sessionDeletedIds above, but for watchlist symbols — removeCoin only
// ever touched local state (待修改事項.md watchlist bug: same resurrection pattern as
// the trades one above, just for coins instead of trades).
const sessionDeletedCoinSymbols = new Set<string>();

// Set to true during a full reset to block all sync from running concurrently.
let isResetting = false;
export function setIsResetting(v: boolean) { isResetting = v; }
export function clearSessionDeletedIds() { sessionDeletedIds.clear(); }

// IDs/symbols whose server-side delete has not yet been confirmed to succeed — persisted
// so a closed tab/app doesn't lose track of them. sessionDeletedIds/sessionDeletedCoinSymbols
// already hide them from the UI immediately; this queue is purely about eventually reaching
// the DB (待修改事項.md P2-2).
const PENDING_DELETE_KEY = 'pendingTradeDeletes';
const PENDING_COIN_DELETE_KEY = 'pendingWatchlistDeletes';

function loadPendingIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}
function savePendingIds(key: string, ids: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* storage unavailable — best effort */ }
}

// Supabase's `.delete()` returns { error } on a DB-level failure rather than throwing —
// only a network exception hits the catch block. The original code checked neither,
// so a rejected delete (RLS, transient DB error) silently no-opped with the row still
// live server-side. Both paths are now treated as failure.
async function tryDeleteFromServer(tradeId: string, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('trades').delete().eq('id', tradeId).eq('user_id', userId);
    return !error;
  } catch {
    return false;
  }
}

export async function deleteTradePermanently(tradeId: string): Promise<void> {
  sessionDeletedIds.add(tradeId);
  useStore.getState().deleteTrade(tradeId);
  const userId = useStore.getState().userId;
  if (!userId) return;

  const ok = await tryDeleteFromServer(tradeId, userId);
  if (!ok) {
    const pending = new Set(loadPendingIds(PENDING_DELETE_KEY));
    pending.add(tradeId);
    savePendingIds(PENDING_DELETE_KEY, Array.from(pending));
    useStore.getState().setSyncWarning('刪除未能同步到伺服器，將自動重試（本機顯示不受影響）');
  }
}

// Retries deletes that failed to reach the server in a previous attempt (including ones
// queued in an earlier session). Called alongside loadFromSupabase so it rides the same
// cadence (page load, periodic sync, visibility change) without a dedicated timer.
export async function retryPendingDeletes(userId: string): Promise<void> {
  const pending = loadPendingIds(PENDING_DELETE_KEY);
  if (pending.length === 0) return;
  const stillPending: string[] = [];
  for (const id of pending) {
    sessionDeletedIds.add(id); // guard against a concurrent loadFromSupabase re-adding it
    const ok = await tryDeleteFromServer(id, userId);
    if (!ok) stillPending.push(id);
  }
  savePendingIds(PENDING_DELETE_KEY, stillPending);
}

async function tryDeleteWatchlistFromServer(symbol: string, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('watchlist').delete().eq('user_id', userId).eq('symbol', symbol);
    return !error;
  } catch {
    return false;
  }
}

// Mirrors deleteTradePermanently above: removeCoin only ever removed local state, so the
// watchlist row survived server-side and the next loadFromSupabase (periodic sync, tab
// visibility change, next login) added it right back.
export async function removeCoinPermanently(symbol: string): Promise<void> {
  sessionDeletedCoinSymbols.add(symbol);
  useStore.getState().removeCoin(symbol);
  const userId = useStore.getState().userId;
  if (!userId) return;

  const ok = await tryDeleteWatchlistFromServer(symbol, userId);
  if (!ok) {
    const pending = new Set(loadPendingIds(PENDING_COIN_DELETE_KEY));
    pending.add(symbol);
    savePendingIds(PENDING_COIN_DELETE_KEY, Array.from(pending));
    useStore.getState().setSyncWarning('移除幣種未能同步到伺服器，將自動重試（本機顯示不受影響）');
  }
}

export async function retryPendingCoinDeletes(userId: string): Promise<void> {
  const pending = loadPendingIds(PENDING_COIN_DELETE_KEY);
  if (pending.length === 0) return;
  const stillPending: string[] = [];
  for (const symbol of pending) {
    sessionDeletedCoinSymbols.add(symbol); // guard against a concurrent loadFromSupabase re-adding it
    const ok = await tryDeleteWatchlistFromServer(symbol, userId);
    if (!ok) stillPending.push(symbol);
  }
  savePendingIds(PENDING_COIN_DELETE_KEY, stillPending);
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
    // status 欄位對 authenticated role 不可讀，永遠是 undefined —— 這裡絕不能塞 'active'
    // 頂替（曾經這樣做，被單向閂鎖誤認成「已確認成交」，伺服器後來查到的真值 'waiting'
    // 永遠打不贏，推薦單一出現就顯示持倉中）。唯一例外：result=WIN_TP1 且無 closed_at
    // 可從「可讀欄位」單獨推出 tp1_hit，這才算真正確認，其餘一律留 undefined 交給
    // reconcileFromServer 用 service role 補上權威值。
    status:      deriveTp1Status(
                   (r.result as TradeRecord['result']) ?? undefined,
                   (r.closed_at as number | null) ?? undefined,
                   undefined,
                 ),
    statusConfirmed: (r.result as TradeRecord['result']) === 'WIN_TP1' && (r.closed_at as number | null) == null,
    signalPrice: (r.signal_price as number | null) ?? undefined,
    filledAt:    (r.filled_at as number | null) ?? undefined,
    // 伺服器寫的關單原因（time_stop_stall / tp2 / trailing_stop / ...）。
    // 紀錄頁靠這個分辨「系統關的」與「使用者自己按平倉的」——沒有它，
    // 伺服器的時間止損（result='MANUAL_CLOSE'）會被一律標成「手動平倉」。
    closeReason: (r.close_reason as string | null) ?? undefined,
    tier:        ((r.tier as string | null) as 'A' | 'B' | undefined) ?? undefined,
    scoreBreakdown: (r.score_breakdown as TradeRecord['scoreBreakdown'] | null) ?? undefined,
  };
}

// Apply the server row's authoritative terminal state to a locally-known trade.
// The server owns closing (monitor writes closed_at); the client only reads
// result / closed_at / exit_price / pnl_percent (status is unreadable here).
// Returns true if it recorded a TP1-watching mark or a finalize, so callers can
// skip the open-trade ID-adoption branch.
function applyServerOutcome(targetId: string, local: TradeRecord, r: Record<string, unknown>): boolean {
  const action = resolveServerOutcome(local, {
    result:     (r.result as TradeResult | null) ?? null,
    closedAt:   (r.closed_at as number | null) ?? null,
    exitPrice:  (r.exit_price as number | null) ?? null,
    pnlPercent: (r.pnl_percent as number | null) ?? null,
    closeReason: (r.close_reason as string | null) ?? null,
  });
  if (action.kind === 'finalize') {
    useStore.getState().finalizeFromServer(
      targetId, action.result, action.exitPrice, action.pnlPercent, action.closedAt, action.closeReason,
    );
    return true;
  }
  if (action.kind === 'markTp1') {
    useStore.getState().markTp1Watching(targetId, action.exitPrice, action.pnlPercent);
    return true;
  }
  return false;
}

// ── Additive sync (used by periodic background sync) ──────────────
// Only adds trades that are new or have been updated on the server.
// Does NOT remove local trades — safe for background use.
export async function loadFromSupabase(userId: string) {
  if (isResetting) return;
  const store = useStore.getState();

  // Load watchlist
  const { data: wl } = await supabase.from('watchlist').select('symbol,timeframes').eq('user_id', userId);
  if (wl) {
    const existing = new Set(store.coins.map(c => c.symbol));
    wl.forEach(r => { if (!existing.has(r.symbol) && !sessionDeletedCoinSymbols.has(r.symbol)) store.addCoin(r.symbol); });
  }

  // Load all trades including 'waiting' limit orders.
  // tr === null  → network/DB error — skip ALL trade processing (never purge on failure).
  // tr.length === 0 → success, no DB trades → orphan purge removes all local open trades.
  const { data: tr } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('opened_at', { ascending: false });

  if (tr !== null) {
    const dbRows = tr as Record<string, unknown>[];
    // dbIds is the authoritative set of trade IDs that exist in DB right now.
    // Built even when dbRows is empty so the orphan purge works correctly.
    const dbIds  = new Set(dbRows.map(r => r.id as string));

    if (dbRows.length > 0) {
      const existingMap       = new Map(store.trades.map(t => [t.id, t]));
      const existingSignalIds = new Set(store.trades.map(t => t.signalId).filter(Boolean));
      // reverse lookup: signalId → local trade (for reconciling server trades with different IDs)
      const existingBySignal  = new Map(store.trades.filter(t => !!t.signalId).map(t => [t.signalId!, t]));
      const activeSymbols     = new Set(store.trades.filter(t => !t.result).map(t => t.symbol));
      const incoming: TradeRecord[] = [];

      for (const r of dbRows) {
        if (sessionDeletedIds.has(r.id as string)) continue;

        if (existingMap.has(r.id as string)) {
          // Same ID — adopt the server's authoritative terminal state. TP1-watching
          // (result=WIN_TP1, no closed_at) marks WITHOUT closing; a server closed_at
          // (trailing stop / TP2 / SL) finalizes even when the local copy already had
          // result=WIN_TP1 — the old `!local.result` guard left those stuck in 持倉中.
          // status transitions still come from reconcileFromServer() (status unreadable here).
          applyServerOutcome(r.id as string, existingMap.get(r.id as string)!, r);
        } else {
          const srvSignalId = (r.signal_id as string) ?? '';
          const localBySig  = srvSignalId ? existingBySignal.get(srvSignalId) : undefined;
          if (localBySig) {
            const handled = applyServerOutcome(localBySig.id, localBySig, r);
            if (!handled && !r.result && !existingMap.has(r.id as string)) {
              // Open trade: signalId matches a local trade but IDs differ (client-ID vs server-ID
              // mismatch from the pre-fix era). Add the server-ID row to incoming so local state
              // adopts the correct DB-backed ID in this same load cycle. The orphan purge below
              // will then remove the stale client-ID copy.
              incoming.push(rowToRecord(r));
              if (srvSignalId) existingSignalIds.add(srvSignalId);
              activeSymbols.add(r.symbol as string);
            }
          } else if (r.result != null || !activeSymbols.has(r.symbol as string)) {
            const record = rowToRecord(r);
            incoming.push(record);
            if (srvSignalId) existingSignalIds.add(srvSignalId);
            if (!r.result) activeSymbols.add(r.symbol as string);
          }
        }
      }

      if (incoming.length > 0) {
        useStore.setState(s => ({ trades: [...incoming, ...s.trades].slice(0, 500) }));
      }
    }

    // ── Orphan purge: remove open local trades not backed by any DB row ────────
    // Runs whenever the DB query succeeded (tr !== null), even on empty response.
    // Closed trades (t.result !== undefined) are always preserved — they are
    // historical records and must never be dropped just because a query didn't
    // return them (DB may have pruned old data, or the trade was closed offline).
    // Only open trades (result IS NULL) are held to the DB-authoritative standard.
    // GRACE PERIOD: a just-created local trade (addTrade writes locally, then a
    // debounced 4s save uploads it) isn't in DB yet — purging it on a sync that
    // races the save would delete it. Keep open trades younger than 2 min so the
    // upload has time to land.
    const SYNC_GRACE_MS = 120_000;
    const nowTs = Date.now();
    useStore.setState(s => ({
      trades: s.trades.filter(t =>
        t.result !== undefined ||             // keep: closed trade (historical — never purge)
        dbIds.has(t.id) ||                     // keep: open trade with a DB-confirmed ID
        (nowTs - t.openedAt < SYNC_GRACE_MS)   // keep: just-created, upload may be in flight
      ),
    }));

    // Collapse duplicate OPEN trades per symbol (a symbol can have at most one
    // open trade). A stale 'waiting' alongside a filled 'active' shows the same
    // signal twice — keep the most advanced (tp1_hit > active > waiting), newest
    // as tie-breaker. Closed trades are never collapsed (history).
    const STATUS_RANK: Record<string, number> = { tp1_hit: 3, active: 2, waiting: 1 };
    useStore.setState(s => {
      const bestOpenBySymbol = new Map<string, TradeRecord>();
      for (const t of s.trades) {
        if (t.result) continue;
        const cur = bestOpenBySymbol.get(t.symbol);
        if (!cur) { bestOpenBySymbol.set(t.symbol, t); continue; }
        const better =
          (STATUS_RANK[t.status ?? 'active'] ?? 2) - (STATUS_RANK[cur.status ?? 'active'] ?? 2)
          || t.openedAt - cur.openedAt;
        if (better > 0) bestOpenBySymbol.set(t.symbol, t);
      }
      return {
        trades: s.trades.filter(t => t.result || bestOpenBySymbol.get(t.symbol) === t),
      };
    });
  }

  // Load profile
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (prof) {
    // Cross-device reset guard: if another device triggered a full reset after our last
    // load, wipe local data and adopt the server's (empty) state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverResetAt = (prof as any).reset_at as number | null | undefined;
    const localResetAt  = useStore.getState().lastResetAt;
    if (serverResetAt && serverResetAt > localResetAt) {
      useStore.setState({ trades: [], lastResetAt: serverResetAt });
      useStore.getState().clearSignals();
      // Sync profile settings then return — no trades to reconcile
      useStore.setState(s => ({
        webhookSecret: prof.webhook_secret || s.webhookSecret,
        settings:      prof.settings ? { ...s.settings, ...(prof.settings as object) } : s.settings,
      }));
      return;
    }

    useStore.setState(s => ({
      webhookSecret: prof.webhook_secret || s.webhookSecret,
      settings:      prof.settings ? { ...s.settings, ...(prof.settings as object) } : s.settings,
    }));
  }

  // Step 1: Ask server for actual status (service role bypasses column-grant restrictions).
  // This fixes the root cause: 'status' and 'signal_price' columns return 42703 for the
  // authenticated role, so we can't trust what loadFromSupabase reads from Supabase directly.
  const webhookSecret = useStore.getState().webhookSecret;
  const confirmedActive = await reconcileFromServer(webhookSecret);

  // Step 2: Fallback price-based reconcile for trades the server returned null status for.
  await reconcileIncorrectlyActiveTrades(confirmedActive);
}

// Calls /api/trade-status (server uses service role key to read the status column that
// the authenticated role cannot access). Returns a Set of IDs the server confirmed as
// legitimately 'active' (filled), so the price-based fallback doesn't false-positive them.
async function reconcileFromServer(webhookSecret: string): Promise<Set<string>> {
  const confirmedActive = new Set<string>();
  const store = useStore.getState();
  // Include TP1-watching trades (result=WIN_TP1, still open) so the server can return
  // their live current_stop for the position card and confirm status='tp1_hit'.
  const openTrades = store.trades.filter(t => !t.result || (t.status === 'tp1_hit' && !t.closedAt));
  if (openTrades.length === 0) return confirmedActive;

  try {
    const res = await fetch('/api/trade-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': webhookSecret },
      body: JSON.stringify({ ids: openTrades.map(t => t.id) }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        useStore.getState().setSyncWarning('Webhook Secret 不符，狀態同步失敗，請至設定頁確認密鑰');
      }
      return confirmedActive;
    }

    // Clear any previous auth warning on success
    useStore.getState().setSyncWarning(null);

    const { statuses } = await res.json() as {
      statuses: Record<string, { status: string | null; signalPrice: number | null; currentStop?: number | null }>
    };

    useStore.setState(s => ({
      trades: s.trades.map(t => {
        // Adopt current_stop even for closed-result trades that are still tp1-watching
        // (result=WIN_TP1, no closedAt) so the position card can show the live stop.
        if (t.result && !(t.status === 'tp1_hit' && !t.closedAt)) return t;
        const srv = statuses[t.id];
        // srv missing entirely (id not in response) vs srv.status===null (row found,
        // column NULL/unmigrated) are different cases — resolveStatus needs both kept
        // distinct so a NULL read doesn't get treated as "no info, keep local as-is"
        // in a way that also silently re-confirms a stale local guess.
        const resolved = resolveStatus({
          localStatus:    t.status,
          localConfirmed: t.statusConfirmed ?? false,
          serverStatus:   srv ? (srv.status as 'waiting' | 'active' | 'tp1_hit' | null) : undefined,
        });
        if (resolved.status === 'active' && resolved.confirmed) confirmedActive.add(t.id);
        return {
          ...t,
          status: resolved.status,
          statusConfirmed: resolved.confirmed,
          ...(srv?.signalPrice != null ? { signalPrice: srv.signalPrice } : {}),
          ...(srv?.currentStop != null ? { currentStop: srv.currentStop } : {}),
        };
      }),
    }));
  } catch { /* network error — fall through to price-based reconcile */ }

  return confirmedActive;
}

// Fallback for trades where the server returned null status (legacy records) or the
// server endpoint was unreachable. Uses signalPrice to identify unfilled limit orders,
// then confirms via Binance live price. Skips trades the server confirmed as 'active'.
//
// 2026-07-26: this used to also write status='active' back to Supabase ("fix DB lag").
// That gave the client fill-detection authority it must not have — the server is the
// only side with an atomic .eq('status','waiting') write guarding against concurrent
// crons, and its own Phase 1 candle scan is correctly time-anchored (openTime >= opened_at,
// see route.ts). This fallback previously omitted that anchor, so pre-order candles could
// satisfy entryTouched and the client would write a phantom fill straight into the DB —
// confirmed live on ZEC/HYPE limit shorts that were never actually filled. Fix: added the
// same anchor, AND removed the DB write. Local-only promotion is now purely cosmetic
// (self-corrects next reconcileFromServer poll or the next server cron, ≤5min); a legacy
// row truly stuck in 'waiting' forever (fill candle rolled off the lookback window) needs
// a manual DB fix instead of a silent client write.
async function reconcileIncorrectlyActiveTrades(confirmedActive: Set<string> = new Set()): Promise<void> {
  const store = useStore.getState();
  // Suspects: open trades that look like limit orders but whose fill status is uncertain.
  // Status may be null-defaulted to 'active' because the DB status column didn't exist.
  // Confirmed-active trades (server verified) are excluded — no need to re-check.
  const suspects = store.trades.filter(t => {
    // Include 'waiting' too: a limit order whose entry the price already touched should
    // latch back to 'active' here (heals trades a prior bug or server lag left as waiting).
    if (t.result) return false;
    if (confirmedActive.has(t.id)) return false;
    const sp = t.signalPrice ?? 0;
    const hasLimitReason = (t.reasons ?? []).some(
      r => r.includes('掛限價單') || r.includes('待回測') || r.includes('待反彈')
    );
    if (sp === 0 && !hasLimitReason) return false;
    const isLongLimit  = t.direction === 'LONG'  && (sp > 0 ? sp > t.entry * 1.003 : hasLimitReason);
    const isShortLimit = t.direction === 'SHORT' && (sp > 0 ? sp < t.entry * 0.997 : hasLimitReason);
    return isLongLimit || isShortLimit;
  });
  if (suspects.length === 0) return;

  // For each suspect: fetch 1h K-lines and check whether price touched the entry AFTER
  // the order was placed. startTime retreats ONE 1h bar before opened_at (the candle
  // containing the fill often opens before opened_at), but evalCandles then filters back
  // to openTime >= openedAt — same two-step anchor as route.ts's Phase 1 fill scan — so
  // pre-order price action can never be misread as a fill.
  // This fallback only PROMOTES (latches active locally); it never demotes to waiting —
  // fills are a one-way latch (server cancels unfilled limits via `result`, not by
  // reverting to waiting) — and never writes to the DB (see function comment above).
  //
  // 2026-08-04（docs/ANALYSIS-2026-08-04-移動止損失效與策略數據檢討.md 修正D）：
  // was 4h/500 — with the same start-of-bar anchor, a limit order placed at 04:36
  // has its 04:00 4h bar excluded, so the next usable bar doesn't land until 08:00:
  // up to a ~4h blind spot before this fallback could ever notice a fill. The
  // server's own Phase 1 fill scan (route.ts) uses 1h for the same reason this
  // fallback exists — align the two so the client-side backstop is never blunter
  // than the path it's backing up. 168 bars = 7 days, matching the server's lookback.
  const toActivate: string[] = [];

  for (const t of suspects) {
    try {
      const candles = await fetchCandles(t.symbol, '1h', 168, 2, t.openedAt - 3_600_000);
      const evalCandles = candles.filter(c => c.openTime >= t.openedAt);
      const entryTouched = evalCandles.some(c =>
        t.direction === 'LONG'  ? c.low  <= t.entry :
        t.direction === 'SHORT' ? c.high >= t.entry :
        false
      );
      if (entryTouched) toActivate.push(t.id);
    } catch {
      // API failure — leave this trade's status unchanged; retry on next load
    }
    await new Promise(r => setTimeout(r, 250)); // stagger to avoid 429
  }

  if (toActivate.length === 0) return;

  const activateSet = new Set(toActivate);
  useStore.setState(s => ({
    trades: s.trades.map(t => (activateSet.has(t.id) ? { ...t, status: 'active' as const, statusConfirmed: true } : t)),
  }));
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

  // Step 2: Update only what Supabase is behind on — a local trade we closed but
  // Supabase still has as open. UPDATE-ONLY, never insert/upsert: every trade row is
  // authored by the server (auto-insert on signal detection — route.ts Step 1), so a
  // missing server row (`!sv`) means it was legitimately cancelled/deleted, not "new
  // and needs creating". Upserting here would resurrect a dead limit order with none
  // of the server-owned columns (status/signal_price null) — the ghost-order bug this
  // replaces (待修改事項.md P0-1).
  const toUpdate = localStore
    .filter(t => t.status !== 'waiting' && !sessionDeletedIds.has(t.id))
    .filter(t => {
      const sv = serverMap.get(t.id);
      if (!sv) return false;                   // no server row — nothing to update, never create one
      return !!t.result && !sv.result;         // local has close result, server doesn't
    });

  if (toUpdate.length > 0) {
    const rows = toUpdate.map(t => ({
      id:           t.id,
      closed_at:    t.closedAt ?? null,
      result:       t.result ?? null,
      exit_price:   t.exitPrice ?? null,
      pnl_percent:  t.pnlPercent ?? null,
      entry_notes:  t.entryNotes ?? '',
      // Same rule as saveToSupabase's finalizedRows: omitted (not nulled) when absent.
      // 2026-08-05：closeReason 現在也會從伺服器同步回本地，所以這裡推回去的
      // 可能是伺服器自己寫的值——寫回同一個值是冪等的，不會蓋錯；重點仍是
      // 「沒有值時要省略而不是寫 null」，否則會清掉 route.ts 寫的關單原因。
      ...(t.closeReason ? { close_reason: t.closeReason } : {}),
    }));
    await Promise.all(rows.map(({ id, ...patch }) =>
      supabase.from('trades').update(patch).eq('id', id).eq('user_id', userId)
    ));
    toUpdate.forEach(t => serverMap.set(t.id, t));
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
    wl.forEach(r => { if (!existing.has(r.symbol) && !sessionDeletedCoinSymbols.has(r.symbol)) useStore.getState().addCoin(r.symbol); });
  }
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (prof) {
    useStore.setState(s => ({
      webhookSecret: prof.webhook_secret || s.webhookSecret,
      settings:      prof.settings ? { ...s.settings, ...(prof.settings as object) } : s.settings,
    }));
  }

  // Fix status for all open trades (rowToRecord defaults to 'active' since status column
  // is not readable by client; reconcileFromServer uses service role to get actual status).
  const webhookSecret = useStore.getState().webhookSecret;
  const confirmedActive = await reconcileFromServer(webhookSecret);
  await reconcileIncorrectlyActiveTrades(confirmedActive);

  return Math.abs(merged.length - before);
}

export async function saveToSupabase(userId: string) {
  if (isResetting) return;

  // Cross-device reset guard: check server reset_at BEFORE pushing any trades.
  // If another device triggered a full reset since our last sync, we must wipe local
  // state rather than push stale trades back. This runs on every save (every ≤4s),
  // so any open client self-clears within one debounce cycle after a reset.
  try {
    const { data: profCheck } = await supabase
      .from('profiles')
      .select('reset_at')
      .eq('id', userId)
      .single();
    const serverResetAt = (profCheck as { reset_at?: number | null } | null)?.reset_at ?? 0;
    const localResetAt  = useStore.getState().lastResetAt;
    if (serverResetAt > localResetAt) {
      useStore.setState({ trades: [], lastResetAt: serverResetAt });
      useStore.getState().clearSignals();
      return; // don't push stale data — next save will upload the (empty) clean state
    }
  } catch { /* network error — proceed optimistically; loadFromSupabase will catch it */ }

  const s = useStore.getState();

  // Upsert profile
  await supabase.from('profiles').upsert({
    id:             userId,
    webhook_secret: s.webhookSecret,
    settings:       s.settings,
  });

  // Upsert watchlist
  const watchRows = s.coins.map(c => ({ user_id: userId, symbol: c.symbol, timeframes: c.timeframes }));
  if (watchRows.length > 0) await supabase.from('watchlist').upsert(watchRows, { onConflict: 'user_id,symbol' });

  // Update trades (skip waiting — server manages those directly). UPDATE-ONLY, never
  // insert/upsert: every row is authored by the server (auto-insert on signal detection
  // — route.ts Step 1). The client only ever owns two kinds of edits — entry_notes/entry
  // (updateTrade) and a manual close's closed_at/result/exit/pnl — never row creation.
  // Upserting here would resurrect a row the server legitimately deleted (cancelled limit
  // order) with none of the server-owned columns (status/signal_price null) — the
  // ghost-order bug this replaces (待修改事項.md P0-1).
  //
  // openRows additionally require statusConfirmed: an unconfirmed row is one the server
  // JUST created; it already has everything server-authored, so there's nothing client-
  // side worth pushing until the next reconcile confirms it (skips a pointless request
  // for every still-unconfirmed trade on every 4s debounce tick).
  const nonWaiting = s.trades.filter(t => t.status !== 'waiting');
  const openRows = nonWaiting
    .filter(t => !t.closedAt && t.statusConfirmed)
    .map(t => ({ id: t.id, entry_notes: t.entryNotes ?? '', entry: t.entry }));
  const finalizedRows = nonWaiting.filter(t => !!t.closedAt).map(t => ({
    id:          t.id,
    entry_notes: t.entryNotes ?? '',
    entry:       t.entry,
    closed_at:   t.closedAt ?? null,
    result:      t.result ?? null,
    exit_price:  t.exitPrice ?? null,
    pnl_percent: t.pnlPercent ?? null,
    // Set by the client's own manual close (useStore.closeTrade), and — since
    // 2026-08-05 — also mirrored back from the server so the journal can tell a
    // system time-stop apart from a user close. Either way it's omitted, NOT
    // written as null, when absent: a null here would wipe the close_reason
    // route.ts wrote (tp2/trailing_stop/stop_loss/time_stop_stall/...). Pushing
    // back a value that originally came from the server is idempotent.
    ...(t.closeReason ? { close_reason: t.closeReason } : {}),
  }));

  const updateTrades = async (rows: { id: string; [k: string]: unknown }[]) => {
    await Promise.all(rows.map(async ({ id, ...patch }) => {
      const { error } = await supabase.from('trades').update(patch).eq('id', id).eq('user_id', userId);
      if (error) console.error('[saveToSupabase] update error:', error.code, error.message);
    }));
  };
  await updateTrades(openRows);
  await updateTrades(finalizedRows);
}

// ── Pending signal pickup (runs on any page, not just home) ───────
// When the server inserts a trade it also queues the signal in Redis.
// We detect those signals here and reload from DB — using the server's
// own trade ID — instead of creating a parallel client-side trade that
// saveToSupabase would upsert as a duplicate row with a different ID.
const seenSignalIds = new Set<string>();

async function pickupServerSignals(): Promise<void> {
  const secret = useStore.getState().webhookSecret;
  const userId = useStore.getState().userId;
  if (!secret || !userId) return;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'x-webhook-secret': secret },
    });
    if (!res.ok) return;
    const data = await res.json() as { signals?: TradingSignal[] };
    const freshSigs = (data.signals ?? []).filter(sig => !seenSignalIds.has(sig.id));
    if (freshSigs.length === 0) return;

    // Add any new symbols to watchlist so they appear in the signal tab
    freshSigs.forEach(sig => {
      seenSignalIds.add(sig.id);
      const s = useStore.getState();
      if (!s.coins.find(c => c.symbol === sig.symbol)) s.addCoin(sig.symbol);
    });

    // Reload from DB — the server already inserted the trade with a stable ID.
    // This avoids creating a second local trade (new client ID) that
    // saveToSupabase would persist as a duplicate row.
    await loadFromSupabase(userId);
  } catch { /* ignore network errors */ }
}

// ── Component ──────────────────────────────────────────────────────

export function StoreHydration({ children }: { children: React.ReactNode }) {
  const hasHydrated   = useStore(s => s._hasHydrated);
  const syncWarning   = useStore(s => s.syncWarning);
  const setSyncWarning = useStore(s => s.setSyncWarning);
  const [mounted, setMounted]     = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [userId, setLocalUserId]  = useState<string | null>(null);
  const saveTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef            = useRef(false);
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

  // ── Initial load from Supabase after auth ─────────────────────────
  // Ref-guarded on purpose: this is a one-shot "pull the world" on first login,
  // not something that should re-fire on every session hiccup.
  useEffect(() => {
    if (!userId || !hasHydrated || initialLoadRef.current) return;
    initialLoadRef.current = true;

    loadFromSupabase(userId)
      .then(() => pickupServerSignals())  // pick up any Redis-queued signals missed on other pages
      .then(() => retryPendingDeletes(userId))
      .then(() => retryPendingCoinDeletes(userId))
      .catch(() => {});
  }, [userId, hasHydrated]);

  // ── Background sync listeners (save/periodic-sync/visibility) ────
  // 2026-08-03：故意「不」依賴 userId（跟上面那個 effect 不同）——這裡曾經
  // 跟初始載入共用同一個 effect，deps 是 [userId, hasHydrated] 且用 syncDoneRef
  // 閂鎖只讓它們註冊一次。iOS standalone PWA 從背景恢復時，supabase-js 的
  // token 自動刷新偶爾會有一瞬間 session 空窗（onAuthStateChange 先收到
  // null，稍後才收到恢復的 uid），userId 因此短暫變 null 又變回來：
  //   1. userId → null：這裡的 cleanup 被觸發，四個監聽器全部解除
  //   2. userId 恢復：effect body 重跑，但閂鎖已經是 true，直接 return
  //      —— 監聽器永遠沒有重新註冊
  // 結果是定期同步、回前景同步、自動存檔永久死亡，只剩手動「同步紀錄」
  // 按鈕還能觸發 fullSyncFromSupabase（待修改事項.md 2026-08-03 實錘：
  // 分類按鈕要重整才有反應、掛單卡在「已達進場 等待確認」都是這裡）。
  // 修法：這個 effect 只依賴 hasHydrated（只會 false→true 一次，見
  // useStore.ts 的 onRehydrateStorage，永不重置）——session 空窗不再讓監聽器
  // 被拆掉。每個回呼內部本來就即時讀 useStore.getState().userId 決定要不要
  // 動作，不靠 closure 捕捉的值，所以拿掉 userId 依賴不影響行為。
  useEffect(() => {
    if (!hasHydrated) return;

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
      if (uid) {
        await loadFromSupabase(uid).catch(() => {});
        await retryPendingDeletes(uid).catch(() => {});
        await retryPendingCoinDeletes(uid).catch(() => {});
      }
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
      await pickupServerSignals(); // catch any signals queued since last visit
      await retryPendingDeletes(uid).catch(() => {});
      await retryPendingCoinDeletes(uid).catch(() => {});
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
  }, [hasHydrated]);

  // Show spinner during init
  if (!mounted || !hasHydrated) {
    return (
      <div className="min-h-dvh bg-[#0A0D11] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#2DD4BF] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // While checking auth, show blank (avoid flash)
  if (!authReady) {
    return (
      <div className="min-h-dvh bg-[#0A0D11] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#2DD4BF] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      {syncWarning && (
        <div className="fixed top-16 left-0 right-0 z-50 px-4 py-2 bg-orange-500/10 border-b border-orange-500/30 text-orange-400 text-xs text-center font-semibold flex items-center justify-center gap-2">
          <span>⚠ {syncWarning}</span>
          <button onClick={() => setSyncWarning(null)} className="opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
      {children}
    </>
  );
}

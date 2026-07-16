'use client';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { deleteTradePermanently, loadFromSupabase, saveToSupabase, fullSyncFromSupabase } from '@/components/StoreHydration';
import { fetchCurrentPrice } from '@/api/binance';
import { TradeResult } from '@/types';

const RESULT_LABEL: Record<string, string> = {
  WIN_TP1:      'TP1 達標',
  WIN_TP2:      'TP2 達標',
  LOSS:         '止損出場',
  MANUAL_CLOSE: '手動平倉',
};

const RESULT_COLOR: Record<string, string> = {
  WIN_TP1:      '#00C851',
  WIN_TP2:      '#00A040',
  LOSS:         '#FF4444',
  MANUAL_CLOSE: '#F0B90B',
};

function fmtPrice(p: number) {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}分鐘`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小時${m % 60 ? ` ${m % 60}分` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}天${h % 24}時`;
}

function unlockCoin(symbol: string) {
  const secret = useStore.getState().webhookSecret;
  fetch(`/api/analyze?symbol=${symbol}`, { method: 'DELETE', headers: { 'x-webhook-secret': secret } }).catch(() => {});
}

function calcPositionSize(entry: number, sl: number, accountSize: number) {
  const stopPct = Math.abs(entry - sl) / entry;
  if (stopPct <= 0) return null;
  const riskUSDT    = accountSize * 0.01;
  const positionUSDT = riskUSDT / stopPct;
  const coins        = positionUSDT / entry;
  return { riskUSDT, positionUSDT, coins };
}

export default function TradesPage() {
  const trades          = useStore(s => s.trades);
  const coins           = useStore(s => s.coins);
  const accountSize     = useStore(s => s.settings.accountSize);
  const closeTrade      = useStore(s => s.closeTrade);
  const addManualTrade  = useStore(s => s.addManualTrade);
  const updateTrade     = useStore(s => s.updateTrade);

  // Poll prices for active (持倉中) trades so livePnl stays fresh.
  // Reads directly from store inside the interval to avoid recreating it when trades change.
  useEffect(() => {
    const pollPrices = async () => {
      const seen = new Set<string>();
      const activeSymbols = useStore.getState().trades
        .filter(t => (!t.result && t.status !== 'waiting') || (t.status === 'tp1_hit' && !t.closedAt))
        .map(t => t.symbol)
        .filter(s => { if (seen.has(s)) return false; seen.add(s); return true; });
      if (activeSymbols.length === 0) return;
      for (const sym of activeSymbols) {
        try {
          const price = await fetchCurrentPrice(sym);
          useStore.getState().updateCoin(sym, { currentPrice: price });
        } catch { /* ignore per-symbol errors — next tick will retry */ }
        await new Promise(r => setTimeout(r, 120)); // stagger to avoid 429
      }
    };

    pollPrices(); // immediate on mount
    const id = setInterval(pollPrices, 30_000);
    return () => clearInterval(id);
  }, []); // empty deps: interval reads store directly, no closure staleness

  const [closeModal, setCloseModal] = useState<{
    id: string; symbol: string; direction: 'LONG' | 'SHORT';
    entry: number; tp1: number; tp2: number; sl: number;
  } | null>(null);
  const [exitPrice,  setExitPrice]  = useState('');
  const [exitResult, setExitResult] = useState<TradeResult>('WIN_TP1');
  const [filter,     setFilter]     = useState<'ALL' | 'PENDING' | 'WAITING' | 'CLOSED' | 'PROFIT' | 'LOSS_LIVE'>('ALL');
  const [resultFilter, setResultFilter] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL');
  const [dirFilter,  setDirFilter]  = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [dateFilter, setDateFilter] = useState<'all' | 'week' | 'month'>('all');
  const [sortBy,     setSortBy]     = useState<'time' | 'pnl' | 'score'>('time');
  const [sortDir,    setSortDir]    = useState<'desc' | 'asc'>('desc');
  const [unlockMsg,  setUnlockMsg]  = useState<Record<string, boolean>>({});
  const [syncing,    setSyncing]    = useState(false);
  const [syncMsg,    setSyncMsg]    = useState('');
  const [showManual,      setShowManual]      = useState(false);
  const [showDetailStats, setShowDetailStats] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteText,    setNoteText]    = useState('');
  const [actualEntry, setActualEntry] = useState('');
  const [mSymbol,    setMSymbol]    = useState('');
  const [mDir,       setMDir]       = useState<'LONG' | 'SHORT'>('LONG');
  const [mEntry,     setMEntry]     = useState('');
  const [mTP1,       setMTP1]       = useState('');
  const [mTP2,       setMTP2]       = useState('');
  const [mSL,        setMSL]        = useState('');
  const [mError,     setMError]     = useState('');
  const now = useMemo(() => Date.now(), [dateFilter]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Memoize derived arrays: prevents filtered from recomputing on every store update (coins poll).
  const waiting       = useMemo(() => trades.filter(t => t.status === 'waiting'), [trades]);
  const closed        = useMemo(() => trades.filter(t => !!t.result), [trades]);
  // 持倉中 = active & not closed (exclude waiting)
  const pending       = useMemo(() => trades.filter(t => !t.result && t.status !== 'waiting'), [trades]);
  // 追蹤TP2 = TP1 hit, result locked as WIN_TP1, not yet finally closed
  const watchingTp2   = useMemo(() => trades.filter(t => t.status === 'tp1_hit' && t.result === 'WIN_TP1' && !t.closedAt), [trades]);
  const wins    = closed.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
  const losses  = closed.filter(t => t.result === 'LOSS');
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : null;
  const avgPnl  = closed.length > 0
    ? (closed.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / closed.length).toFixed(2)
    : null;
  const totalWin  = wins.reduce((a, t) => a + Math.max(t.pnlPercent ?? 0, 0), 0);
  const totalLoss = Math.abs(losses.reduce((a, t) => a + Math.min(t.pnlPercent ?? 0, 0), 0));
  const profitFactor = totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : null;
  const totalReturn  = closed.length > 0
    ? closed.reduce((a, t) => a + (t.pnlPercent ?? 0), 0)
    : null;

  // ── Extended stats ───────────────────────────────────────────
  const avgWin  = wins.length   > 0 ? (wins.reduce((a, t)   => a + (t.pnlPercent ?? 0), 0) / wins.length).toFixed(2)   : null;
  const avgLoss = losses.length > 0 ? (losses.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / losses.length).toFixed(2) : null;

  // RR analysis
  const calcRR = (t: (typeof trades)[0]) => {
    const risk = Math.abs(t.entry - t.stopLoss);
    return risk > 0 ? Math.abs(t.tp2 - t.entry) / risk : 0;
  };
  const avgPlannedRR = useMemo(() => {
    const all = [...pending, ...closed].filter(t => t.status !== 'waiting');
    if (!all.length) return null;
    return (all.reduce((a, t) => a + calcRR(t), 0) / all.length).toFixed(2);
  }, [pending, closed]);
  const avgActualRR = useMemo(() => {
    if (!wins.length) return null;
    return (wins.reduce((a, t) => {
      const risk = Math.abs(t.entry - t.stopLoss);
      return a + (risk > 0 ? Math.abs((t.exitPrice ?? t.tp1) - t.entry) / risk : 0);
    }, 0) / wins.length).toFixed(2);
  }, [wins]);
  // Expected value per trade = winRate * avgWin + lossRate * avgLoss − trading cost (0.15% round-trip)
  const expectedValue = useMemo(() => {
    if (!closed.length || avgWin === null || avgLoss === null) return null;
    const wr = wins.length / closed.length;
    const COST_PCT = 0.15; // 0.15% round-trip (entry + exit taker fee)
    const ev = wr * parseFloat(avgWin) + (1 - wr) * parseFloat(avgLoss) - COST_PCT;
    return ev.toFixed(2);
  }, [closed.length, wins.length, avgWin, avgLoss]);

  const longClosed  = closed.filter(t => t.direction === 'LONG');
  const shortClosed = closed.filter(t => t.direction === 'SHORT');
  const longWins    = longClosed.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
  const shortWins   = shortClosed.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
  const longWinRate  = longClosed.length  > 0 ? Math.round(longWins.length  / longClosed.length  * 100) : null;
  const shortWinRate = shortClosed.length > 0 ? Math.round(shortWins.length / shortClosed.length * 100) : null;

  const maxConsecLoss = useMemo(() => {
    let best = 0; let cur = 0;
    [...trades]
      .filter(t => t.result)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .forEach(t => {
        if (t.result === 'LOSS') { cur++; best = Math.max(best, cur); } else cur = 0;
      });
    return best;
  }, [trades]);

  const { bestCoin, worstCoin } = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    closed.forEach(t => {
      const c = map.get(t.symbol) ?? { total: 0, count: 0 };
      map.set(t.symbol, { total: c.total + (t.pnlPercent ?? 0), count: c.count + 1 });
    });
    const arr = Array.from(map.entries()).map(([s, v]) => ({ symbol: s, avg: +(v.total / v.count).toFixed(2) }));
    if (arr.length === 0) return { bestCoin: null, worstCoin: null };
    const sorted = [...arr].sort((a, b) => b.avg - a.avg);
    return { bestCoin: sorted[0], worstCoin: sorted[sorted.length - 1] };
  }, [closed]);

  // ── 策略分析模組 ─────────────────────────────────────────────

  // 累積資產曲線（按平倉時間排序）
  const equityCurve = useMemo(() => {
    let cum = 0;
    return [...closed]
      .filter(t => t.closedAt)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .map(t => { cum += t.pnlPercent ?? 0; return parseFloat(cum.toFixed(2)); });
  }, [closed]);

  // 最大回撤（從高峰到谷底的最大下跌）
  const maxDrawdown = useMemo(() => {
    if (equityCurve.length < 2) return null;
    let peak = 0, maxDD = 0;
    equityCurve.forEach(v => {
      if (v > peak) peak = v;
      const dd = peak - v;
      if (dd > maxDD) maxDD = dd;
    });
    return maxDD.toFixed(2);
  }, [equityCurve]);

  // 月度損益（最近 6 個月）
  const monthlyPnl = useMemo(() => {
    const map = new Map<string, { pnl: number; wins: number; total: number }>();
    closed.filter(t => t.closedAt).forEach(t => {
      const d = new Date(t.closedAt!);
      const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const e = map.get(key) ?? { pnl: 0, wins: 0, total: 0 };
      map.set(key, {
        pnl:   e.pnl + (t.pnlPercent ?? 0),
        wins:  e.wins + (t.result === 'WIN_TP1' || t.result === 'WIN_TP2' ? 1 : 0),
        total: e.total + 1,
      });
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([key, v]) => ({ key, pnl: parseFloat(v.pnl.toFixed(2)), wins: v.wins, total: v.total }));
  }, [closed]);

  // 評分區間效益（哪個分數段勝率最高）
  const scoreRanges = useMemo(() => [
    { label: '12–14', min: 12, max: 14 },
    { label: '15–17', min: 15, max: 17 },
    { label: '18+',   min: 18, max: 999 },
  ].map(r => {
    const inRange = closed.filter(t => (t.score ?? 0) >= r.min && (t.score ?? 0) <= r.max);
    const ws = inRange.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
    return {
      label: r.label,
      total: inRange.length,
      wr: inRange.length ? Math.round(ws.length / inRange.length * 100) : null,
      avgPnl: inRange.length ? parseFloat((inRange.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / inRange.length).toFixed(2)) : null,
    };
  }).filter(r => r.total > 0), [closed]);

  // 信號因子效益（哪些技術條件勝率最高）
  const reasonStats = useMemo(() => {
    const KW = ['看漲 OB', '看跌 OB', 'FVG', 'ChoCH', 'BOS', 'RSI 超賣', 'RSI 超買', 'RSI 看漲背離', 'RSI 看跌背離', 'MACD 黃金交叉', 'MACD 死亡交叉', 'Fib 黃金口袋', 'EQL', 'EQH', '破壞塊'];
    return KW.map(kw => {
      const m = closed.filter(t => t.reasons?.some(r => r.includes(kw)));
      if (m.length < 2) return null;
      const ws = m.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
      return { label: kw, total: m.length, wr: Math.round(ws.length / m.length * 100) };
    }).filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.wr - a.wr).slice(0, 8);
  }, [closed]);

  // 時框效益（哪個時間週期勝率最高）
  const tfStats = useMemo(() => {
    const map = new Map<string, { wins: number; total: number; pnl: number }>();
    closed.forEach(t => {
      const tf = t.timeframe ?? '?';
      const e = map.get(tf) ?? { wins: 0, total: 0, pnl: 0 };
      map.set(tf, {
        wins:  e.wins + (t.result === 'WIN_TP1' || t.result === 'WIN_TP2' ? 1 : 0),
        total: e.total + 1,
        pnl:   e.pnl + (t.pnlPercent ?? 0),
      });
    });
    return Array.from(map.entries())
      .map(([tf, v]) => ({ tf, wr: Math.round(v.wins / v.total * 100), total: v.total, avgPnl: parseFloat((v.pnl / v.total).toFixed(2)) }))
      .sort((a, b) => b.wr - a.wr);
  }, [closed]);

  // 平均持倉時間
  const avgHoldTime = useMemo(() => {
    const with2 = closed.filter(t => t.openedAt && t.closedAt);
    if (!with2.length) return null;
    const avgMs = with2.reduce((a, t) => a + ((t.closedAt ?? 0) - t.openedAt), 0) / with2.length;
    const h = Math.floor(avgMs / 3600000);
    return h < 24 ? `${h}小時` : `${Math.floor(h / 24)}天${h % 24}時`;
  }, [closed]);

  const filtered = useMemo(() => {
    // Base set
    const calcLivePnl = (t: (typeof trades)[0]) => {
      const livePx = coins.find(c => c.symbol === t.symbol)?.currentPrice ?? 0;
      if (!livePx) return null;
      return t.direction === 'LONG'
        ? (livePx - t.entry) / t.entry * 100
        : (t.entry - livePx) / t.entry * 100;
    };
    let base = filter === 'PENDING'   ? pending
             : filter === 'WAITING'   ? waiting
             : filter === 'CLOSED'    ? closed
             : filter === 'PROFIT'    ? pending.filter(t => (calcLivePnl(t) ?? -1) > 0)
             : filter === 'LOSS_LIVE' ? pending.filter(t => (calcLivePnl(t) ?? 1) < 0)
             : [...waiting, ...pending, ...closed];
    // Closed result sub-filter
    if (filter === 'CLOSED' && resultFilter !== 'ALL') {
      if (resultFilter === 'WIN')  base = base.filter(t => t.result === 'WIN_TP1' || t.result === 'WIN_TP2');
      if (resultFilter === 'LOSS') base = base.filter(t => t.result === 'LOSS');
    }
    // Direction filter
    if (dirFilter !== 'ALL') base = base.filter(t => t.direction === dirFilter);
    // Date filter
    if (dateFilter !== 'all') {
      const cutoff = dateFilter === 'week'
        ? now - 7  * 24 * 3600 * 1000
        : now - 30 * 24 * 3600 * 1000;
      base = base.filter(t => t.openedAt >= cutoff);
    }
    // Sort (waiting always on top, then by sort key)
    base.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1;
      if (b.status === 'waiting' && a.status !== 'waiting') return  1;
      let diff = 0;
      if (sortBy === 'pnl')   diff = (a.pnlPercent ?? 0) - (b.pnlPercent ?? 0);
      if (sortBy === 'score') diff = (a.score ?? 0) - (b.score ?? 0);
      if (sortBy === 'time')  diff = a.openedAt - b.openedAt;
      return sortDir === 'desc' ? -diff : diff;
    });
    return base;
  }, [filter, resultFilter, dirFilter, dateFilter, sortBy, sortDir, pending, closed, waiting, now, coins]);

  const exportCsv = () => {
    const header = 'ID,幣種,方向,週期,強度,得分,進場價,止損,TP1,TP2,開倉時間,平倉時間,結果,出場價,損益%,分析依據,個人備註';
    const rows = closed.map(t =>
      [
        t.id, t.symbol, t.direction, t.timeframe, t.strength, t.score,
        t.entry, t.stopLoss, t.tp1, t.tp2,
        fmtDate(t.openedAt),
        fmtDate(t.closedAt ?? t.openedAt),
        RESULT_LABEL[t.result ?? 'MANUAL_CLOSE'],
        t.exitPrice ?? '',
        t.pnlPercent ?? '',
        `"${(t.reasons ?? []).join(' | ').replace(/"/g, '""')}"`,
        `"${(t.entryNotes ?? '').replace(/"/g, '""')}"`,
      ].join(',')
    );
    const csv  = [header, ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearClosed = useCallback(async () => {
    if (!window.confirm(`確定清除所有 ${closed.length} 筆已結束紀錄？\n此操作無法復原，雲端紀錄也會一併刪除。`)) return;
    const ids = closed.map(t => t.id);
    await Promise.all(ids.map(id => deleteTradePermanently(id)));
  }, [closed]);

  const handleClose = () => {
    if (!closeModal) return;
    const price = parseFloat(exitPrice);
    if (isNaN(price) || price <= 0) return;
    // Warn if exit price deviates >50% from entry (likely typo)
    const dev = Math.abs(price - closeModal.entry) / closeModal.entry;
    if (dev > 0.5 && !window.confirm(`出場價 $${price} 距進場 $${fmtPrice(closeModal.entry)} 偏離 ${(dev * 100).toFixed(1)}%，確定嗎？`)) return;
    // Apply corrected actual entry price BEFORE closing so PnL is accurate
    const parsedActualEntry = parseFloat(actualEntry);
    if (!isNaN(parsedActualEntry) && parsedActualEntry > 0 && parsedActualEntry !== closeModal.entry) {
      updateTrade(closeModal.id, { entry: parsedActualEntry });
    }
    closeTrade(closeModal.id, exitResult, price);
    unlockCoin(closeModal.symbol);
    setCloseModal(null);
    setExitPrice('');
    setActualEntry('');
  };

  const handleManualUnlock = useCallback((symbol: string) => {
    unlockCoin(symbol);
    setUnlockMsg(prev => ({ ...prev, [symbol]: true }));
    setTimeout(() => setUnlockMsg(prev => ({ ...prev, [symbol]: false })), 2500);
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const uid = useStore.getState().userId;
      if (!uid) { setSyncMsg('請先登入'); return; }
      // 完整雙向同步：先上傳本機 → 再以 Supabase 為主取代本機
      // 解決「手機電腦紀錄不一致」問題
      const changes = await fullSyncFromSupabase(uid);
      setSyncMsg(changes > 0 ? `完整同步完成，${changes > 0 ? `差異 ${changes} 筆` : ''}資料已一致` : '完整同步完成，資料已一致');
    } catch {
      setSyncMsg('同步失敗，請重試');
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 4000);
    }
  }, []);

  const handleManualCreate = () => {
    setMError('');
    const sym = mSymbol.trim().toUpperCase().replace('/', '');
    const symbol = sym.endsWith('USDT') ? sym : sym + 'USDT';
    const entry = parseFloat(mEntry), tp1 = parseFloat(mTP1), tp2 = parseFloat(mTP2), sl = parseFloat(mSL);
    if (!symbol) { setMError('請輸入幣種代號'); return; }
    if (isNaN(entry) || entry <= 0) { setMError('請輸入有效的進場價格'); return; }
    if (isNaN(tp1) || tp1 <= 0) { setMError('請輸入有效的 TP1'); return; }
    if (isNaN(sl)  || sl  <= 0) { setMError('請輸入有效的止損價格'); return; }
    if (mDir === 'LONG'  && sl >= entry) { setMError('做多止損必須低於進場價'); return; }
    if (mDir === 'SHORT' && sl <= entry) { setMError('做空止損必須高於進場價'); return; }
    if (trades.some(t => t.symbol === symbol && !t.result)) { setMError('此幣種已有進行中的交易'); return; }
    addManualTrade({ symbol, direction: mDir, entry, stopLoss: sl, tp1, tp2: isNaN(tp2) || tp2 <= 0 ? tp1 : tp2 });
    setShowManual(false);
    setMSymbol(''); setMDir('LONG'); setMEntry(''); setMTP1(''); setMTP2(''); setMSL(''); setMError('');
  };

  const autoFill = (result: TradeResult) => {
    setExitResult(result);
    if (!closeModal) return;
    if (result === 'WIN_TP1')      setExitPrice(String(closeModal.tp1));
    else if (result === 'WIN_TP2') setExitPrice(String(closeModal.tp2));
    else if (result === 'LOSS')    setExitPrice(String(closeModal.sl));
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (!selectedIds.size) return;
    const count = selectedIds.size;
    if (!window.confirm(`確定永久刪除選取的 ${count} 筆紀錄？\n此操作無法復原，雲端同步後也會移除。`)) return;
    await Promise.all(Array.from(selectedIds).map(id => deleteTradePermanently(id)));
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [selectedIds]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E] shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-[#EAEAF4] text-xl font-extrabold tracking-tight">交易紀錄</h1>
            <p className="text-[#606080] text-xs mt-0.5">
              {closed.length} 已結束 · {pending.length} 持倉
              {watchingTp2.length > 0 && <span className="text-green-400"> · {watchingTp2.length} 追蹤TP2</span>}
              {waiting.length > 0 && <span className="text-yellow-400"> · {waiting.length} 掛單中</span>}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="text-blue-400 text-xs font-semibold px-3 py-1.5 border border-blue-400/40 rounded-full disabled:opacity-40 active:opacity-70"
            >
              {syncing ? (
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin inline-block" />
                  同步中
                </span>
              ) : '同步紀錄'}
            </button>
            <button onClick={() => setShowManual(true)} className="btn-primary text-xs px-3 py-1.5">
              + 新增
            </button>
            <button onClick={exportCsv} className="text-[#F0B90B] text-xs font-semibold px-3 py-1.5 border border-[#F0B90B]/40 rounded-full active:opacity-70">
              匯出
            </button>
            <button
              onClick={() => { setSelectMode(v => !v); setSelectedIds(new Set()); setEditingNote(null); }}
              className={`text-xs font-semibold px-3 py-1.5 border rounded-full active:opacity-70 ${
                selectMode ? 'text-red-400 border-red-400/40' : 'text-[#606080] border-[#1E1E2E]'
              }`}
            >
              {selectMode ? '取消' : '選取'}
            </button>
          </div>
        </div>
        {syncMsg && (
          <div className={`mb-2 px-3 py-2 rounded-xl text-xs font-semibold ${
            syncMsg.includes('失敗') ? 'bg-red-500/10 text-red-400' : 'bg-blue-500/10 text-blue-400'
          }`}>
            {syncMsg}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-4 gap-1.5 mb-2">
          <StatCard label="總交易" value={String(closed.length)} sub={`${pending.length} 持倉`} />
          <StatCard
            label="勝率"
            value={winRate !== null ? `${winRate}%` : '—'}
            sub={`${wins.length}W ${closed.length - wins.length}L`}
            color={winRate !== null ? (winRate >= 50 ? '#00C851' : '#FF4444') : undefined}
          />
          <StatCard
            label="累積報酬"
            value={totalReturn !== null ? `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%` : '—'}
            sub="全部加起來"
            color={totalReturn !== null ? (totalReturn >= 0 ? '#00C851' : '#FF4444') : undefined}
          />
          <StatCard
            label="賺賠比"
            value={avgWin !== null ? `+${parseFloat(avgWin).toFixed(1)}%` : '—'}
            color={avgWin !== null ? '#00C851' : undefined}
            value2={avgLoss !== null ? `${parseFloat(avgLoss).toFixed(1)}%` : undefined}
            color2={avgLoss !== null ? '#FF4444' : undefined}
            sub={avgWin !== null || avgLoss !== null ? '平均賺 vs 平均賠' : '尚無結束交易'}
          />
        </div>

        {/* Expandable detail stats */}
        {closed.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setShowDetailStats(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 bg-[#0D0D16] rounded-xl border border-[#1E1E2E] text-xs text-[#606080] active:opacity-70"
            >
              <span className="font-semibold">詳細績效分析</span>
              <span>{showDetailStats ? '▲ 收起' : '▼ 展開'}</span>
            </button>
            {showDetailStats && (
              <div className="mt-1.5 bg-[#0D0D16] border border-[#1E1E2E] rounded-xl p-3 space-y-3">
                {/* Direction breakdown */}
                <div>
                  <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">多/空勝率</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-[#0A1A10] rounded-lg px-3 py-2">
                      <p className="text-[#00C851] text-[9px] font-bold mb-0.5">▲ 做多 ({longClosed.length}筆)</p>
                      <p className={`text-base font-extrabold ${longWinRate !== null && longWinRate >= 50 ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
                        {longWinRate !== null ? `${longWinRate}%` : '—'}
                      </p>
                      <p className="text-[#404060] text-[9px]">{longWins.length}W {longClosed.length - longWins.length}L</p>
                    </div>
                    <div className="bg-[#1A0A0A] rounded-lg px-3 py-2">
                      <p className="text-[#FF4444] text-[9px] font-bold mb-0.5">▼ 做空 ({shortClosed.length}筆)</p>
                      <p className={`text-base font-extrabold ${shortWinRate !== null && shortWinRate >= 50 ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
                        {shortWinRate !== null ? `${shortWinRate}%` : '—'}
                      </p>
                      <p className="text-[#404060] text-[9px]">{shortWins.length}W {shortClosed.length - shortWins.length}L</p>
                    </div>
                  </div>
                </div>

                {/* Avg win / loss + consecutive + hold time */}
                <div>
                  <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">損益分析</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">平均獲利</p>
                      <p className="text-[#00C851] text-xs font-bold">{avgWin ? `+${avgWin}%` : '—'}</p>
                    </div>
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">平均虧損</p>
                      <p className="text-[#FF4444] text-xs font-bold">{avgLoss ? `${avgLoss}%` : '—'}</p>
                    </div>
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">最大連虧</p>
                      <p className={`text-xs font-bold ${maxConsecLoss >= 3 ? 'text-red-400' : 'text-[#A0A0C0]'}`}>{maxConsecLoss}筆</p>
                    </div>
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">平均持倉</p>
                      <p className="text-[#A0A0C0] text-xs font-bold">{avgHoldTime ?? '—'}</p>
                    </div>
                  </div>
                </div>

                {/* RR analysis */}
                <div>
                  <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">風報比分析</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">計畫平均 RR</p>
                      <p className="text-[#A0A0C0] text-xs font-bold">{avgPlannedRR ? `1:${avgPlannedRR}` : '—'}</p>
                    </div>
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">實際達成 RR</p>
                      <p className={`text-xs font-bold ${avgActualRR ? 'text-[#00C851]' : 'text-[#404060]'}`}>{avgActualRR ? `1:${avgActualRR}` : '—'}</p>
                    </div>
                    <div className="bg-[#12121A] rounded-lg px-2 py-1.5 text-center">
                      <p className="text-[#404060] text-[8px]">每筆期望值</p>
                      <p className={`text-xs font-bold ${expectedValue ? (parseFloat(expectedValue) >= 0 ? 'text-[#00C851]' : 'text-red-400') : 'text-[#404060]'}`}>
                        {expectedValue ? `${parseFloat(expectedValue) >= 0 ? '+' : ''}${expectedValue}%` : '—'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Equity curve + max drawdown */}
                {equityCurve.length >= 2 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest">資產曲線</p>
                      <div className="flex gap-3 text-[9px]">
                        <span className="text-[#606080]">
                          累積 <span className={parseFloat((equityCurve[equityCurve.length - 1] ?? 0).toString()) >= 0 ? 'text-[#00C851] font-bold' : 'text-red-400 font-bold'}>
                            {(equityCurve[equityCurve.length - 1] ?? 0) >= 0 ? '+' : ''}{equityCurve[equityCurve.length - 1]}%
                          </span>
                        </span>
                        {maxDrawdown && parseFloat(maxDrawdown) > 0 && (
                          <span className="text-[#606080]">最大回撤 <span className="text-red-400 font-bold">-{maxDrawdown}%</span></span>
                        )}
                      </div>
                    </div>
                    <div className="bg-[#0A0A0F] rounded-xl p-2">
                      <EquityCurve data={equityCurve} />
                    </div>
                  </div>
                )}

                {/* Monthly P&L */}
                {monthlyPnl.length > 0 && (
                  <div>
                    <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">月度損益</p>
                    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${monthlyPnl.length}, 1fr)` }}>
                      {monthlyPnl.map(m => (
                        <div key={m.key} className={`rounded-lg px-1.5 py-2 text-center border ${m.pnl >= 0 ? 'bg-green-400/5 border-green-400/20' : 'bg-red-400/5 border-red-400/20'}`}>
                          <p className="text-[#404060] text-[8px] mb-0.5">{m.key.slice(5)}</p>
                          <p className={`text-xs font-bold ${m.pnl >= 0 ? 'text-[#00C851]' : 'text-red-400'}`}>{m.pnl >= 0 ? '+' : ''}{m.pnl}%</p>
                          <p className="text-[#404060] text-[7px] mt-0.5">{m.wins}W/{m.total - m.wins}L</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* TF win rate */}
                {tfStats.length > 0 && (
                  <div>
                    <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">時框效益</p>
                    <div className="space-y-1">
                      {tfStats.map(r => (
                        <div key={r.tf} className="flex items-center gap-2">
                          <span className="text-[#EAEAF4] text-[10px] font-mono w-8 shrink-0">{r.tf}</span>
                          <div className="flex-1 h-3 bg-[#1A1A26] rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${r.wr}%`, background: r.wr >= 60 ? '#00C851' : r.wr >= 45 ? '#F0B90B' : '#FF4444' }} />
                          </div>
                          <span className="text-[10px] font-bold w-8 text-right shrink-0" style={{ color: r.wr >= 60 ? '#00C851' : r.wr >= 45 ? '#F0B90B' : '#FF4444' }}>{r.wr}%</span>
                          <span className="text-[#404060] text-[9px] w-8 text-right shrink-0">{r.total}筆</span>
                          <span className={`text-[9px] w-10 text-right shrink-0 ${r.avgPnl >= 0 ? 'text-[#00C851]' : 'text-red-400'}`}>{r.avgPnl >= 0 ? '+' : ''}{r.avgPnl}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Score range analysis */}
                {scoreRanges.length > 0 && (
                  <div>
                    <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">評分效益（高分 = 高勝率？）</p>
                    <div className="space-y-1">
                      {scoreRanges.map(r => (
                        <div key={r.label} className="flex items-center gap-2">
                          <span className="text-[#F0B90B] text-[10px] font-mono w-12 shrink-0">{r.label}分</span>
                          <div className="flex-1 h-3 bg-[#1A1A26] rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${r.wr ?? 0}%`, background: (r.wr ?? 0) >= 60 ? '#00C851' : (r.wr ?? 0) >= 45 ? '#F0B90B' : '#FF4444' }} />
                          </div>
                          <span className="text-[10px] font-bold w-8 text-right shrink-0" style={{ color: (r.wr ?? 0) >= 60 ? '#00C851' : (r.wr ?? 0) >= 45 ? '#F0B90B' : '#FF4444' }}>{r.wr ?? '—'}%</span>
                          <span className="text-[#404060] text-[9px] w-8 text-right shrink-0">{r.total}筆</span>
                          {r.avgPnl !== null && (
                            <span className={`text-[9px] w-10 text-right shrink-0 ${r.avgPnl >= 0 ? 'text-[#00C851]' : 'text-red-400'}`}>{r.avgPnl >= 0 ? '+' : ''}{r.avgPnl}%</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Signal reason win rate */}
                {reasonStats.length > 0 && (
                  <div>
                    <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">信號因子效益（哪個條件最準）</p>
                    <div className="space-y-1">
                      {reasonStats.map(r => (
                        <div key={r.label} className="flex items-center gap-2">
                          <span className="text-[#A0A0C0] text-[9px] flex-1 truncate">{r.label}</span>
                          <div className="w-20 h-2.5 bg-[#1A1A26] rounded-full overflow-hidden shrink-0">
                            <div className="h-full rounded-full" style={{ width: `${r.wr}%`, background: r.wr >= 65 ? '#00C851' : r.wr >= 50 ? '#F0B90B' : '#FF4444' }} />
                          </div>
                          <span className="text-[10px] font-bold w-7 text-right shrink-0" style={{ color: r.wr >= 65 ? '#00C851' : r.wr >= 50 ? '#F0B90B' : '#FF4444' }}>{r.wr}%</span>
                          <span className="text-[#404060] text-[9px] w-6 text-right shrink-0">{r.total}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Best / worst coin */}
                {(bestCoin || worstCoin) && (
                  <div>
                    <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1.5">幣種表現</p>
                    <div className="grid grid-cols-2 gap-2">
                      {bestCoin && (
                        <div className="bg-[#0A1A10] rounded-lg px-3 py-2">
                          <p className="text-[#404060] text-[8px] mb-0.5">最佳幣種</p>
                          <p className="text-[#EAEAF4] text-xs font-bold">{bestCoin.symbol.replace('USDT', '')}</p>
                          <p className="text-[#00C851] text-xs">{bestCoin.avg >= 0 ? '+' : ''}{bestCoin.avg}%</p>
                        </div>
                      )}
                      {worstCoin && worstCoin.symbol !== bestCoin?.symbol && (
                        <div className="bg-[#1A0A0A] rounded-lg px-3 py-2">
                          <p className="text-[#404060] text-[8px] mb-0.5">最差幣種</p>
                          <p className="text-[#EAEAF4] text-xs font-bold">{worstCoin.symbol.replace('USDT', '')}</p>
                          <p className="text-[#FF4444] text-xs">{worstCoin.avg >= 0 ? '+' : ''}{worstCoin.avg}%</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Portfolio Heat */}
        {pending.length > 0 && (
          <div className={`rounded-2xl px-4 py-2.5 mb-3 border flex items-center justify-between ${
            pending.length >= 5 ? 'border-red-500/40 bg-red-500/5'
            : pending.length >= 3 ? 'border-yellow-500/40 bg-yellow-500/5'
            : 'border-[#1E1E2E] bg-[#12121A]'
          }`}>
            <div>
              <p className="text-[#606080] text-[9px]">帳戶總曝險</p>
              <p className={`font-extrabold text-base ${
                pending.length >= 5 ? 'text-red-400'
                : pending.length >= 3 ? 'text-yellow-400' : 'text-[#EAEAF4]'
              }`}>{pending.length}%</p>
            </div>
            <div className="text-right">
              <p className="text-[#606080] text-[9px]">{pending.length} 筆持倉 × 1% 風險</p>
              {pending.length >= 5
                ? <p className="text-red-400 text-[9px]">⚠ 高風險，建議暫停開新倉</p>
                : pending.length >= 3
                ? <p className="text-yellow-400 text-[9px]">注意：總曝險偏高</p>
                : <p className="text-[#404060] text-[9px]">風險在控制範圍內</p>
              }
            </div>
          </div>
        )}

        {/* Row 1: 狀態 filter */}
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {([
            ['ALL',       '全部'],
            ['PENDING',   `持倉 (${pending.length})`],
            ['WAITING',   waiting.length > 0 ? `等待進場 (${waiting.length})` : '等待進場'],
            ['CLOSED',    `結束 (${closed.length})`],
            ['PROFIT',    '浮盈'],
            ['LOSS_LIVE', '浮虧'],
          ] as const).map(([f, label]) => (
            <button key={f} onClick={() => { setFilter(f); if (f !== 'CLOSED') setResultFilter('ALL'); }}
              className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${
                filter === f
                  ? f === 'PROFIT'    ? 'bg-green-500 border-green-500 text-white'
                  : f === 'LOSS_LIVE' ? 'bg-red-500 border-red-500 text-white'
                  : f === 'WAITING'   ? 'bg-yellow-500 border-yellow-500 text-black'
                  : 'bg-[#F0B90B] border-[#F0B90B] text-[#0A0A0F]'
                  : f === 'PROFIT'    ? 'border-green-500/30 text-green-500/70'
                  : f === 'LOSS_LIVE' ? 'border-red-500/30 text-red-400/70'
                  : f === 'WAITING'   ? 'border-yellow-500/30 text-yellow-400/70'
                  : 'border-[#1E1E2E] text-[#606080]'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Row 1b: 已結束 result sub-filter */}
        {filter === 'CLOSED' && (
          <div className="flex gap-1.5 mb-2">
            {([
              ['ALL',  '全部'],
              ['WIN',  `獲利 (${wins.length})`],
              ['LOSS', `止損 (${losses.length})`],
            ] as const).map(([f, label]) => (
              <button key={f} onClick={() => setResultFilter(f)}
                className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${
                  resultFilter === f
                    ? f === 'WIN'  ? 'bg-green-500 border-green-500 text-white'
                    : f === 'LOSS' ? 'bg-red-500 border-red-500 text-white'
                    : 'bg-[#F0B90B] border-[#F0B90B] text-[#0A0A0F]'
                    : f === 'WIN'  ? 'border-green-500/30 text-green-500/70'
                    : f === 'LOSS' ? 'border-red-500/30 text-red-400/70'
                    : 'border-[#1E1E2E] text-[#606080]'
                }`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Row 2: 方向 + 時間 + 排序 */}
        <div className="flex gap-1.5 flex-wrap items-center">
          {/* Direction */}
          {(['ALL', 'LONG', 'SHORT'] as const).map(d => (
            <button key={d} onClick={() => setDirFilter(d)}
              className={`text-xs px-2.5 py-1 rounded-full font-semibold border transition-colors ${dirFilter === d
                ? d === 'LONG'  ? 'bg-green-500/20 border-green-500/50 text-green-400'
                : d === 'SHORT' ? 'bg-red-500/20 border-red-500/50 text-red-400'
                :                 'bg-[#F0B90B]/20 border-[#F0B90B]/50 text-[#F0B90B]'
                : 'border-[#1E1E2E] text-[#404060]'}`}>
              {d === 'ALL' ? '多/空' : d === 'LONG' ? '▲ 多' : '▼ 空'}
            </button>
          ))}
          <div className="w-px h-4 bg-[#1E1E2E]" />
          {/* Date range */}
          {([['all', '全部'], ['week', '本週'], ['month', '本月']] as const).map(([d, label]) => (
            <button key={d} onClick={() => setDateFilter(d)}
              className={`text-xs px-2.5 py-1 rounded-full font-semibold border transition-colors ${dateFilter === d ? 'bg-blue-500/20 border-blue-500/40 text-blue-400' : 'border-[#1E1E2E] text-[#404060]'}`}>
              {label}
            </button>
          ))}
          <div className="w-px h-4 bg-[#1E1E2E]" />
          {/* Sort */}
          <button
            onClick={() => {
              if (sortBy === 'time')  { setSortBy('pnl');  setSortDir('desc'); }
              else if (sortBy === 'pnl')   { setSortBy('score'); setSortDir('desc'); }
              else { setSortBy('time'); setSortDir('desc'); }
            }}
            className="text-xs px-2.5 py-1 rounded-full border border-[#1E1E2E] text-[#404060] font-semibold"
          >
            {sortBy === 'time' ? '⏱ 時間' : sortBy === 'pnl' ? '📊 損益' : '⭐ 得分'}
            {sortDir === 'desc' ? '↓' : '↑'}
          </button>
          {closed.length > 0 && (
            <button
              onClick={handleClearClosed}
              className="ml-auto text-xs px-2.5 py-1 rounded-full border border-red-500/30 text-red-400/70 font-semibold active:opacity-70"
            >
              清除已結束
            </button>
          )}
        </div>
      </div>

      {/* Trade list */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 scroll-container">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-2 text-center">
            <p className="text-5xl">📋</p>
            <p className="text-[#A0A0C0] font-semibold">還沒有交易紀錄</p>
            <p className="text-[#606080] text-sm">伺服器每 5 分鐘自動分析，達到強訊號時自動建立並即時推播</p>
          </div>
        ) : (
          filtered.map(trade => {
            const isWaiting     = trade.status === 'waiting';
            const isTp1Hit      = trade.status === 'tp1_hit';
            const isWatchingTp2 = isTp1Hit && trade.result === 'WIN_TP1' && !trade.closedAt;
            const isPending     = !trade.result && !isWaiting;
            const isWin     = trade.result === 'WIN_TP1' || trade.result === 'WIN_TP2';
            const coinData  = coins.find(c => c.symbol === trade.symbol);
            const livePx    = coinData?.currentPrice ?? 0;

            // 等待進場中的掛單：顯示距進場位的差距
            let distToEntry = 0;
            if (isWaiting && livePx > 0) {
              distToEntry = trade.direction === 'LONG'
                ? (livePx - trade.entry) / trade.entry * 100  // 正值 = 還差多少才到進場
                : (trade.entry - livePx) / trade.entry * 100;
            }

            // Live PnL and distances (only for active pending trades)
            let livePnl = 0, distTP1 = 0, distSL = 0, nearSL = false;
            if (isPending && livePx > 0) {
              livePnl = trade.direction === 'LONG'
                ? (livePx - trade.entry) / trade.entry * 100
                : (trade.entry - livePx) / trade.entry * 100;
              distTP1 = trade.direction === 'LONG'
                ? (trade.tp1 - livePx) / livePx * 100
                : (livePx - trade.tp1) / livePx * 100;
              distSL = trade.direction === 'LONG'
                ? (livePx - trade.stopLoss) / livePx * 100
                : (trade.stopLoss - livePx) / livePx * 100;
              nearSL = distSL < 1.5;
            }
            // Distance to TP2 for trades watching for TP2 upgrade
            let distTP2 = 0;
            if (isWatchingTp2 && livePx > 0) {
              distTP2 = trade.direction === 'LONG'
                ? (trade.tp2 - livePx) / livePx * 100
                : (livePx - trade.tp2) / livePx * 100;
            }

            return (
              <div
                key={trade.id}
                onClick={selectMode ? () => toggleSelect(trade.id) : undefined}
                className={`relative rounded-2xl p-4 mb-3 border${selectMode ? ' cursor-pointer select-none' : ''} ${
                  selectMode && selectedIds.has(trade.id)
                    ? 'border-[#F0B90B]/50 bg-[#F0B90B]/5'
                    : isWaiting      ? 'bg-[#0D0D16] border-yellow-500/30 border-dashed'
                    : isPending && nearSL ? 'bg-[#12121A] border-red-500/50'
                    : 'bg-[#12121A] border-[#1E1E2E]'
                }`}
              >
                {selectMode && (
                  <div
                    className="absolute top-4 right-4 w-5 h-5 rounded-full border-2 flex items-center justify-center"
                    style={{ borderColor: selectedIds.has(trade.id) ? '#F0B90B' : '#3A3A50', background: selectedIds.has(trade.id) ? '#F0B90B' : 'transparent' }}
                  >
                    {selectedIds.has(trade.id) && <span className="text-[#0A0A0F] text-[9px] font-extrabold leading-none">✓</span>}
                  </div>
                )}
                {/* Top row */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-extrabold ${trade.direction === 'LONG' ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
                      {trade.direction === 'LONG' ? '▲ 做多' : '▼ 做空'}
                    </span>
                    <span className={`font-bold ${isWaiting ? 'text-[#A0A0C0]' : 'text-[#EAEAF4]'}`}>
                      {trade.symbol.replace('USDT', '/USDT')}
                    </span>
                    <span className="text-[#606080] text-xs">{trade.timeframe}</span>
                    {trade.tier === 'B' && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">🅱 輕倉 0.5%</span>
                    )}
                    {(isPending || isWaiting) && (
                      <span className="text-xs text-[#404060]">{fmtDuration(now - trade.openedAt)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isWaiting ? (
                      <span className="text-xs bg-yellow-500/15 text-yellow-400 px-2 py-0.5 rounded-full font-semibold border border-yellow-500/30">
                        ⏳ 等待進場
                      </span>
                    ) : isPending ? (
                      <>
                        {livePx > 0 && (
                          <span className={`text-xs font-bold ${livePnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                          </span>
                        )}
                        {isTp1Hit ? (
                          <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-semibold border border-green-500/40">✅ TP1·等TP2</span>
                        ) : (
                          <span className="text-xs bg-[#F0B90B]/20 text-[#F0B90B] px-2 py-0.5 rounded-full font-semibold">持倉中</span>
                        )}
                      </>
                    ) : isWatchingTp2 ? (
                      <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-semibold border border-green-500/40">✅ TP1·等TP2</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ background: `${RESULT_COLOR[trade.result!]}20`, color: RESULT_COLOR[trade.result!] }}>
                        {RESULT_LABEL[trade.result!]}
                      </span>
                    )}
                    <span className="text-[#F0B90B] text-xs font-bold">{trade.score}分</span>
                  </div>
                </div>

                {/* Price grid */}
                <div className="grid grid-cols-4 gap-1 mb-2">
                  <PriceCell label="進場" value={`$${fmtPrice(trade.entry)}`} />
                  <PriceCell label="TP1"  value={`$${fmtPrice(trade.tp1)}`}      color="#00C851" />
                  <PriceCell label="TP2"  value={`$${fmtPrice(trade.tp2)}`}      color="#00A040" />
                  <PriceCell label="止損" value={`$${fmtPrice(trade.stopLoss)}`} color="#FF4444" />
                </div>

                {/* Waiting: distance to entry */}
                {isWaiting && livePx > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 mb-2">
                    <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-2 text-center">
                      <p className="text-[#606080] text-[9px]">距進場位</p>
                      <p className={`text-xs font-bold ${distToEntry > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                        {distToEntry > 0
                          ? `還差 ${distToEntry.toFixed(2)}%`
                          : `已達進場 等待確認`}
                      </p>
                    </div>
                    <div className="bg-[#0A0A0F] rounded-xl p-2 text-center">
                      <p className="text-[#606080] text-[9px]">現價</p>
                      <p className="text-[#A0A0C0] text-xs font-bold">${fmtPrice(livePx)}</p>
                    </div>
                  </div>
                )}

                {/* Distance bars for active pending trades */}
                {isPending && livePx > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 mb-2">
                    {isTp1Hit ? (
                      <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-2 text-center">
                        <p className="text-green-400 text-[9px] font-semibold">✅ TP1 已達標</p>
                        <p className="text-green-400 text-xs font-bold">
                          {distTP1 > 0 ? `距TP2 還差 ${distTP1.toFixed(2)}%` : `已超過 TP2 ${Math.abs(distTP1).toFixed(2)}%`}
                        </p>
                      </div>
                    ) : (
                      <div className={`rounded-xl p-2 text-center ${distTP1 > 0 ? 'bg-green-400/5' : 'bg-green-400/15'}`}>
                        <p className="text-[#606080] text-[9px]">距 TP1</p>
                        <p className={`text-xs font-bold ${distTP1 > 0 ? 'text-green-400' : 'text-[#00C851]'}`}>
                          {distTP1 > 0 ? `還差 ${distTP1.toFixed(2)}%` : `超過 ${Math.abs(distTP1).toFixed(2)}%`}
                        </p>
                      </div>
                    )}
                    <div className={`rounded-xl p-2 text-center ${nearSL ? 'bg-red-500/15' : 'bg-red-400/5'}`}>
                      <p className="text-[#606080] text-[9px]">{nearSL ? '⚠ 接近止損' : '距 SL'}</p>
                      <p className={`text-xs font-bold ${nearSL ? 'text-red-400' : 'text-[#A0A0C0]'}`}>
                        {distSL >= 0 ? `緩衝 ${distSL.toFixed(2)}%` : `穿越 ${Math.abs(distSL).toFixed(2)}%`}
                      </p>
                    </div>
                  </div>
                )}

                {/* TP2 distance bar for trades that hit TP1 and are watching for TP2 */}
                {isWatchingTp2 && livePx > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 mb-2">
                    <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-2 text-center">
                      <p className="text-green-400 text-[9px] font-semibold">✅ TP1 已鎖定 · 追蹤TP2</p>
                      <p className="text-green-400 text-xs font-bold">
                        {distTP2 > 0 ? `距TP2 還差 ${distTP2.toFixed(2)}%` : `已超過TP2 ${Math.abs(distTP2).toFixed(2)}%`}
                      </p>
                    </div>
                    <div className="bg-[#0A0A0F] rounded-xl p-2 text-center">
                      <p className="text-[#606080] text-[9px]">現價</p>
                      <p className="text-[#A0A0C0] text-xs font-bold">${fmtPrice(livePx)}</p>
                    </div>
                  </div>
                )}

                {/* Position sizing (1% risk rule) for pending trades */}
                {isPending && (() => {
                  const pos = calcPositionSize(trade.entry, trade.stopLoss, accountSize);
                  if (!pos) return null;
                  const slPct = Math.abs(trade.entry - trade.stopLoss) / trade.entry * 100;
                  return (
                    <div className="mb-2 bg-[#0D1020] border border-[#F0B90B]/15 rounded-xl px-3 py-2">
                      <p className="text-[#6B5A20] text-[9px] font-bold uppercase tracking-widest mb-1.5">倉位計算（1% 風險）</p>
                      <div className="grid grid-cols-3 gap-1">
                        <div className="text-center">
                          <p className="text-[#404060] text-[8px]">風險金額</p>
                          <p className="text-[#F0B90B] text-xs font-bold">${pos.riskUSDT.toFixed(0)}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-[#404060] text-[8px]">建議倉位</p>
                          <p className="text-[#EAEAF4] text-xs font-bold">${pos.positionUSDT.toFixed(0)}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-[#404060] text-[8px]">止損幅度</p>
                          <p className={`text-xs font-bold ${slPct > 5 ? 'text-red-400' : 'text-[#A0A0C0]'}`}>{slPct.toFixed(2)}%</p>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* TP1 hit: breakeven reminder */}
                {isTp1Hit && (
                  <div className="mb-2 bg-green-500/5 border border-green-500/20 rounded-xl px-3 py-2 flex items-center gap-2">
                    <span className="text-green-400 text-xs">💡</span>
                    <p className="text-green-400/80 text-xs">TP1 已達標，建議將止損移至成本 <span className="font-bold text-green-400">${fmtPrice(trade.entry)}</span>，繼續持有等待 TP2</p>
                  </div>
                )}

                {/* Auto-generated entry reasons from signal analysis */}
                {trade.reasons && trade.reasons.length > 0 && (
                  <div className="mt-2 bg-[#0D1820] border border-blue-400/10 rounded-xl px-3 py-2">
                    <p className="text-[#405060] text-[9px] mb-1 font-semibold uppercase tracking-wide">分析依據</p>
                    {trade.reasons.map((r, i) => (
                      <p key={i} className="text-[#5A8090] text-[10px] leading-[1.5]">• {r}</p>
                    ))}
                  </div>
                )}

                {/* Personal notes (editable) */}
                {editingNote === trade.id ? (
                  <div className="mt-2">
                    <textarea
                      value={noteText}
                      onChange={e => setNoteText(e.target.value)}
                      placeholder="個人備註、市場觀察…"
                      rows={2}
                      className="w-full bg-[#1A1A26] border border-[#1E1E2E] rounded-xl px-3 py-2 text-xs text-[#EAEAF4] resize-none outline-none mb-2"
                    />
                    <div className="flex gap-2">
                      <button onClick={() => { updateTrade(trade.id, { entryNotes: noteText }); setEditingNote(null); }}
                        className="flex-1 py-1.5 rounded-lg bg-[#F0B90B] text-[#0A0A0F] text-xs font-bold">儲存</button>
                      <button onClick={() => setEditingNote(null)}
                        className="px-3 py-1.5 rounded-lg bg-[#1A1A26] text-[#606080] text-xs">取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      {trade.entryNotes
                        ? <p className="text-[#A0A0C0] text-xs leading-5 bg-[#1A1A26] rounded-xl px-3 py-2">{trade.entryNotes}</p>
                        : !selectMode && <button onClick={() => { setEditingNote(trade.id); setNoteText(''); }}
                            className="text-[#404060] text-xs">＋ 個人備註</button>
                      }
                    </div>
                    {trade.entryNotes && !selectMode && (
                      <button onClick={() => { setEditingNote(trade.id); setNoteText(trade.entryNotes ?? ''); }}
                        className="text-[#404060] text-xs shrink-0">✏️</button>
                    )}
                  </div>
                )}

                {/* Result row for closed trades */}
                {!isPending && !isWaiting && trade.exitPrice !== undefined && (
                  <div className="flex items-center justify-between mt-1 pt-2 border-t border-[#1E1E2E]">
                    <span className="text-[#606080] text-xs">出場 ${fmtPrice(trade.exitPrice)}</span>
                    <span className={`text-sm font-extrabold ${isWin ? 'text-[#00C851]' : 'text-[#FF4444]'}`}>
                      {trade.pnlPercent !== undefined ? `${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent}%` : '—'}
                    </span>
                  </div>
                )}

                {/* Timestamp + actions */}
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#1E1E2E]">
                  <span className="text-[#404060] text-xs">{fmtDate(trade.openedAt)}</span>
                  {!selectMode && <div className="flex gap-2 flex-wrap justify-end">
                    <a
                      href={`https://www.tradingview.com/chart/?symbol=BINANCE:${trade.symbol}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-2 py-1 rounded-xl text-blue-400 border border-blue-400/20 active:opacity-70"
                    >
                      圖表
                    </a>
                    {isWaiting && (
                      <button
                        onClick={() => handleManualUnlock(trade.symbol)}
                        title="手動取消掛單並解鎖推播"
                        className={`text-xs px-2 py-1 rounded-xl border transition-colors ${
                          unlockMsg[trade.symbol]
                            ? 'bg-green-400/10 text-green-400 border-green-400/30'
                            : 'text-yellow-400/70 border-yellow-500/30 active:opacity-70'
                        }`}
                      >
                        {unlockMsg[trade.symbol] ? '✓ 已取消' : '取消掛單'}
                      </button>
                    )}
                    {(isPending || isWatchingTp2) && (
                      <>
                        <button
                          onClick={() => handleManualUnlock(trade.symbol)}
                          title="解除 LINE 推播鎖定"
                          className={`text-xs px-2 py-1 rounded-xl border transition-colors ${
                            unlockMsg[trade.symbol]
                              ? 'bg-green-400/10 text-green-400 border-green-400/30'
                              : 'text-[#404060] border-[#1E1E2E] active:opacity-70'
                          }`}
                        >
                          {unlockMsg[trade.symbol] ? '✓ 已解鎖' : '解鎖推播'}
                        </button>
                        <button
                          onClick={() => setCloseModal({
                            id: trade.id, symbol: trade.symbol, direction: trade.direction,
                            entry: trade.entry, tp1: trade.tp1, tp2: trade.tp2, sl: trade.stopLoss,
                          })}
                          className="text-xs px-3 py-1 rounded-xl bg-[#1A1A26] border border-[#1E1E2E] text-[#A0A0C0] font-semibold active:opacity-70"
                        >
                          手動記錄
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => {
                        const label = trade.result ? `已結束的 ${trade.symbol.replace('USDT', '')} 紀錄` : `${trade.symbol.replace('USDT', '')} 持倉紀錄`;
                        if (window.confirm(`確定永久刪除${label}？\n此操作無法復原，雲端同步後也會移除。`)) {
                          deleteTradePermanently(trade.id);
                        }
                      }}
                      className="text-xs px-2 py-1 rounded-xl text-[#404060] active:opacity-70"
                    >
                      刪除
                    </button>
                  </div>}
                </div>
              </div>
            );
          })
        )}
        <div className="h-4" />
      </div>

      {/* Multi-select delete bar */}
      {selectMode && (
        <div className="bg-[#0D0D16] border-t border-[#1E1E2E] px-4 py-3 flex items-center gap-3 shrink-0">
          <span className="text-[#606080] text-sm">
            已選 <span className="text-[#EAEAF4] font-bold">{selectedIds.size}</span> 筆
          </span>
          <div className="flex-1" />
          <button
            onClick={() => {
              const allIds = new Set(filtered.map(t => t.id));
              setSelectedIds(prev => prev.size === filtered.length ? new Set() : allIds);
            }}
            className="text-xs px-3 py-1.5 rounded-full border border-[#1E1E2E] text-[#A0A0C0] font-semibold active:opacity-70"
          >
            {selectedIds.size === filtered.length ? '取消全選' : '全選'}
          </button>
          <button
            onClick={handleBulkDelete}
            disabled={selectedIds.size === 0}
            className="text-xs px-4 py-1.5 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 font-semibold disabled:opacity-40 active:opacity-70"
          >
            刪除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </button>
        </div>
      )}

      {/* Manual create trade modal */}
      {showManual && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end" onClick={e => e.target === e.currentTarget && setShowManual(false)}>
          <div className="w-full max-w-xl mx-auto bg-[#12121A] rounded-t-3xl p-6 pb-10 border-t border-[#1E1E2E]">
            <div className="w-12 h-1 bg-[#1E1E2E] rounded-full mx-auto mb-5" />
            <h2 className="text-[#EAEAF4] text-lg font-extrabold mb-1">手動新增交易</h2>
            <p className="text-[#606080] text-xs mb-4">依照 LINE 推播內容輸入，用於補錄遺漏的紀錄</p>

            <p className="text-[#606080] text-xs mb-1">幣種代號</p>
            <input
              value={mSymbol}
              onChange={e => { setMSymbol(e.target.value.toUpperCase()); setMError(''); }}
              placeholder="例如：SYN 或 SYNUSDT"
              className="input-field mb-3"
            />

            <p className="text-[#606080] text-xs mb-1">方向</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {(['LONG', 'SHORT'] as const).map(d => (
                <button key={d} onClick={() => setMDir(d)}
                  className={`py-2.5 rounded-xl text-sm font-bold border transition-colors ${mDir === d
                    ? d === 'LONG' ? 'bg-green-400/20 text-green-400 border-green-400' : 'bg-red-400/20 text-red-400 border-red-400'
                    : 'border-[#1E1E2E] text-[#606080]'}`}>
                  {d === 'LONG' ? '▲ 做多' : '▼ 做空'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <p className="text-[#606080] text-xs mb-1">進場價</p>
                <input value={mEntry} onChange={e => setMEntry(e.target.value)} placeholder="Entry" type="number" className="input-field" />
              </div>
              <div>
                <p className="text-[#606080] text-xs mb-1">止損 SL</p>
                <input value={mSL} onChange={e => setMSL(e.target.value)} placeholder="Stop Loss" type="number" className="input-field" />
              </div>
              <div>
                <p className="text-[#606080] text-xs mb-1">TP1</p>
                <input value={mTP1} onChange={e => setMTP1(e.target.value)} placeholder="Take Profit 1" type="number" className="input-field" />
              </div>
              <div>
                <p className="text-[#606080] text-xs mb-1">TP2（選填）</p>
                <input value={mTP2} onChange={e => setMTP2(e.target.value)} placeholder="Take Profit 2" type="number" className="input-field" />
              </div>
            </div>

            {mError && <p className="text-red-400 text-xs mb-3">{mError}</p>}

            <div className="flex gap-3">
              <button onClick={() => setShowManual(false)} className="flex-1 py-3 rounded-xl bg-[#1A1A26] text-[#A0A0C0] font-semibold border border-[#1E1E2E]">
                取消
              </button>
              <button onClick={handleManualCreate} className="flex-1 py-3 rounded-xl btn-primary font-semibold">
                新增紀錄
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual close modal */}
      {closeModal && (() => {
        const livePxClose = coins.find(c => c.symbol === closeModal.symbol)?.currentPrice ?? 0;
        return (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-end" onClick={e => { if (e.target === e.currentTarget) { setCloseModal(null); setActualEntry(''); } }}>
          <div className="w-full max-w-xl mx-auto bg-[#12121A] rounded-t-3xl p-6 pb-10 border-t border-[#1E1E2E]">
            <div className="w-12 h-1 bg-[#1E1E2E] rounded-full mx-auto mb-5" />
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[#EAEAF4] text-lg font-extrabold">手動記錄結果</h2>
              {livePxClose > 0 && (
                <div className="text-right">
                  <p className="text-[#606080] text-[10px]">即時價格</p>
                  <p className="text-[#EAEAF4] font-bold text-sm font-mono">${fmtPrice(livePxClose)}</p>
                </div>
              )}
            </div>
            <p className="text-[#606080] text-xs mb-4">記錄後自動解除 LINE 推播鎖定</p>

            <p className="text-[#606080] text-xs mb-2">選擇結果（自動填入出場價）</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(['WIN_TP1', 'WIN_TP2', 'LOSS', 'MANUAL_CLOSE'] as TradeResult[]).map(r => (
                <button key={r} onClick={() => autoFill(r)}
                  className={`py-2.5 rounded-xl text-sm font-semibold border transition-colors ${exitResult === r ? 'border-transparent' : 'border-[#1E1E2E] text-[#606080]'}`}
                  style={exitResult === r ? { background: `${RESULT_COLOR[r]}20`, color: RESULT_COLOR[r], borderColor: RESULT_COLOR[r] } : {}}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
            </div>

            {/* Actual entry correction — for limit orders that filled at a different price */}
            <div className="bg-[#0D1020] border border-[#F0B90B]/15 rounded-xl px-3 py-2.5 mb-3">
              <p className="text-[#6B5A20] text-[9px] font-bold uppercase tracking-widest mb-1">實際成交進場價（限價單修正）</p>
              <p className="text-[#404060] text-[10px] mb-2">
                掛單設定價：<span className="text-[#EAEAF4] font-semibold">${closeModal ? fmtPrice(closeModal.entry) : ''}</span>
                {' '}— 若實際成交價不同，請填入以下欄位
              </p>
              <input
                value={actualEntry}
                onChange={e => setActualEntry(e.target.value)}
                placeholder={`留空 = 沿用掛單價 $${closeModal ? fmtPrice(closeModal.entry) : ''}`}
                type="number"
                className="input-field text-sm"
              />
            </div>

            <p className="text-[#606080] text-xs mb-1">出場價格</p>
            <input value={exitPrice} onChange={e => setExitPrice(e.target.value)}
              placeholder="輸入出場價" type="number" className="input-field mb-4" />

            <div className="flex gap-3">
              <button onClick={() => setCloseModal(null)} className="flex-1 py-3 rounded-xl bg-[#1A1A26] text-[#A0A0C0] font-semibold border border-[#1E1E2E]">
                取消
              </button>
              <button onClick={handleClose} className="flex-1 py-3 rounded-xl btn-primary font-semibold">
                確認記錄
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

function EquityCurve({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const W = 300, H = 72, P = 8;
  const minV = Math.min(0, ...data);
  const maxV = Math.max(0, ...data);
  const range = maxV - minV || 1;
  const sy = (v: number) => H - P - ((v - minV) / range) * (H - P * 2);
  const sx = (i: number) => P + (i / (data.length - 1)) * (W - P * 2);
  const zero = sy(0);
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const area = `${path} L${sx(data.length - 1).toFixed(1)},${zero} L${P},${zero}Z`;
  const last = data[data.length - 1];
  const col  = last >= 0 ? '#00C851' : '#FF4444';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 72 }}>
      <line x1={P} y1={zero} x2={W - P} y2={zero} stroke="#252535" strokeWidth="1" strokeDasharray="4,3" />
      <path d={area} fill={`${col}18`} />
      <path d={path} stroke={col} strokeWidth="2" fill="none" strokeLinejoin="round" />
      <circle cx={sx(data.length - 1)} cy={sy(last)} r="3.5" fill={col} />
    </svg>
  );
}

function StatCard({ label, value, sub, color, value2, color2 }: {
  label: string; value: string; sub: string; color?: string;
  value2?: string; color2?: string;
}) {
  return (
    <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-2.5 text-center">
      <p className="text-[#606080] text-[9px] mb-0.5">{label}</p>
      <p className={`font-extrabold ${value2 !== undefined ? 'text-sm leading-tight' : 'text-base'}`} style={{ color: color ?? '#EAEAF4' }}>{value}</p>
      {value2 !== undefined && (
        <p className="font-extrabold text-sm leading-tight" style={{ color: color2 ?? '#EAEAF4' }}>{value2}</p>
      )}
      <p className="text-[#404060] text-[9px]">{sub}</p>
    </div>
  );
}

function PriceCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#0A0A0F] rounded-xl p-2 text-center">
      <p className="text-[#606080] text-xs">{label}</p>
      <p className="font-bold text-xs mt-0.5" style={{ color: color ?? '#EAEAF4' }}>{value}</p>
    </div>
  );
}

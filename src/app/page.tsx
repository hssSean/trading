'use client';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { CoinCard } from '@/components/CoinCard';
import { BtcStatusBar } from '@/components/BtcStatusBar';
import { ScanStatusPanel } from '@/components/ScanStatusPanel';
import { fetchCandles, fetchTicker24h, validateSymbol, fetchTopCoinsByVolume, searchSymbols } from '@/api/binance';
import { generateSignals, unifySignalDirection } from '@/analysis/signals';
import { computeIndicators } from '@/analysis/indicators';
import { Candle, Timeframe, TradingSignal } from '@/types';
import { loadFromSupabase } from '@/components/StoreHydration';
import { isUnconfirmedSync } from '@/lib/tradeSync';

const HTF_MAP: Partial<Record<Timeframe, Timeframe>> = {
  '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d',
};

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

// ── Fast: price update + TP1 detection (no candle fetch) ─────────
// All actual trade closes (TP2, SL, TP1 final) are handled by server cron
// (monitorActiveTrades). Client only marks TP1 locally so the trade card
// immediately shows "✅ TP1·等TP2" without waiting for the next 2-min sync.
// Returns false when Binance rate-limits us (caller should stop the loop).
async function checkCoinPrice(symbol: string): Promise<boolean> {
  const store = useStore.getState();
  if (!store.coins.find((c) => c.symbol === symbol)) return true;
  try {
    const ticker = await fetchTicker24h(symbol);
    const currentPrice = ticker.price;
    store.updateCoin(symbol, {
      currentPrice,
      priceChange24h: ticker.priceChange,
      priceChangePercent24h: ticker.priceChangePercent,
    });

    // Mark TP1 locally for active (non-waiting, non-tp1_hit) trades. Excludes
    // isUnconfirmedSync: an unconfirmed trade's real DB status may still be
    // 'waiting' (limit order not yet filled) — status===undefined here is NOT
    // proof of an active position, just an unresolved sync gap (see tradeSync.ts).
    const fresh = useStore.getState();
    const active = fresh.trades.filter(
      t => t.symbol === symbol && !t.result && t.status !== 'waiting' && t.status !== 'tp1_hit' && !isUnconfirmedSync(t)
    );
    for (const trade of active) {
      const tp1Reached = trade.direction === 'LONG'
        ? currentPrice >= trade.tp1
        : currentPrice <= trade.tp1;
      if (tp1Reached) {
        useStore.setState(s => ({
          trades: s.trades.map(t =>
            t.id === trade.id ? { ...t, status: 'tp1_hit' as const } : t
          ),
        }));
      }
    }
    return true;
  } catch (err) {
    // Detect Binance rate limit (429/418) and signal caller to back off
    const msg = String(err).toLowerCase();
    if (msg.includes('429') || msg.includes('418') || msg.includes('too many')) return false;
    return true;
  }
}

// ── Full: candle analysis + signal generation ────────────────────
async function runCoinAnalysis(symbol: string) {
  const store = useStore.getState();
  const coin = store.coins.find((c) => c.symbol === symbol);
  if (!coin) return;
  store.updateCoin(symbol, { isLoading: true });
  try {
    // Price update + TP/SL detection
    await checkCoinPrice(symbol);

    const allSignals: TradingSignal[] = [];
    const candleCache = new Map<string, Candle[]>();

    for (const tf of coin.timeframes) {
      try {
        if (!candleCache.has(tf)) {
          candleCache.set(tf, await fetchCandles(symbol, tf as Timeframe, 200));
        }
      } catch { continue; }
      const candles = candleCache.get(tf)!;

      let bias: 'LONG' | 'SHORT' | null = null;
      const htfTf = HTF_MAP[tf as Timeframe];
      if (htfTf) {
        try {
          if (!candleCache.has(htfTf)) {
            candleCache.set(htfTf, await fetchCandles(symbol, htfTf, 250));
          }
          const htfC   = candleCache.get(htfTf)!;
          const htfInd = computeIndicators(htfC);
          const htfPx  = htfC[htfC.length - 1].close;
          const e200   = htfInd.ema200;
          if (!isNaN(e200) && e200 > 0) {
            const near = Math.abs(htfPx - e200) / e200 < 0.015;
            if (!near) bias = htfPx > e200 ? 'LONG' : 'SHORT';
          }
        } catch { /* skip */ }
      }
      allSignals.push(...generateSignals(symbol, tf as Timeframe, candles, bias));
    }
    store.addSignals(symbol, unifySignalDirection(allSignals));
  } catch (err) {
    console.error('[analyze]', symbol, err);
  } finally {
    store.updateCoin(symbol, { isLoading: false, lastAnalyzed: Date.now() });
  }
}

export default function HomePage() {
  const coins                = useStore((s) => s.coins);
  const addCoin              = useStore((s) => s.addCoin);
  const hasHydrated          = useStore((s) => s._hasHydrated);
  const analysisIntervalMins = useStore((s) => s.settings.analysisIntervalMinutes);

  const [refreshing, setRefreshing]       = useState(false);
  const [showAdd, setShowAdd]             = useState(false);
  const [input, setInput]                 = useState('');
  const [adding, setAdding]               = useState(false);
  const [addError, setAddError]           = useState('');
  const [autoLoading, setAutoLoading]     = useState(false);
  const [autoMsg, setAutoMsg]             = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const autoLoaded      = useRef(false);
  const seenPendingIds  = useRef<Set<string>>(new Set());

  const analyzeAll = useCallback(async () => {
    setRefreshing(true);
    const symbols = useStore.getState().coins.map((c) => c.symbol);
    // Parallel with concurrency=3 — faster than serial, avoids Binance rate limit
    const CONC = 3;
    for (let i = 0; i < symbols.length; i += CONC) {
      await Promise.all(symbols.slice(i, i + CONC).map(s => runCoinAnalysis(s)));
    }
    setRefreshing(false);
  }, []);

  const loadTopCoins = useCallback(async (silent = false) => {
    if (!silent) setAutoLoading(true);
    setAutoMsg('');
    try {
      const top = await fetchTopCoinsByVolume(20); // match server's 20-coin scan (spec §2.1)
      const store = useStore.getState();
      const existing = new Set(store.coins.map((c) => c.symbol));
      const toAdd = top.filter((s) => !existing.has(s));
      toAdd.forEach((s) => store.addCoin(s));
      if (!silent) {
        setAutoMsg('已載入成交量前 20 名，新增 ' + toAdd.length + ' 個幣種');
        setTimeout(() => setAutoMsg(''), 4000);
      }
      const CONC = 3;
      for (let i = 0; i < toAdd.length; i += CONC) {
        await Promise.all(toAdd.slice(i, i + CONC).map(s => runCoinAnalysis(s)));
      }
    } catch {
      if (!silent) {
        setAutoMsg('載入失敗，請確認網路連線');
        setTimeout(() => setAutoMsg(''), 3000);
      }
    } finally {
      setAutoLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasHydrated || autoLoaded.current) return;
    autoLoaded.current = true;
    // Always sync with server's top-15 (adds new coins, never removes existing ones)
    loadTopCoins(true);
    // Analyze pre-existing coins that haven't run yet
    // (newly added coins are analyzed inside loadTopCoins)
    useStore.getState().coins
      .filter((c) => c.lastAnalyzed === 0)
      .forEach((c, i) => setTimeout(() => runCoinAnalysis(c.symbol), i * 400 + 300));
  }, [hasHydrated, loadTopCoins]);

  // ── Fast: price update + TP1 detection every 30s ─────────────
  useEffect(() => {
    const checkAll = async () => {
      const syms = useStore.getState().coins.map((c) => c.symbol);
      for (const s of syms) {
        const ok = await checkCoinPrice(s);
        if (!ok) break; // Binance rate-limited — stop this round, next interval will retry
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const id = setInterval(checkAll, 30 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── Full signal analysis (controlled by settings interval) ────
  useEffect(() => {
    const ms = Math.max(analysisIntervalMins * 60 * 1000, 60 * 1000); // min 1 minute
    const id = setInterval(() => { analyzeAll(); }, ms);
    return () => clearInterval(id);
  }, [analyzeAll, analysisIntervalMins]);

  // ── Coin list refresh every 6 hours — quietly adds new top coins
  useEffect(() => {
    const id = setInterval(() => { loadTopCoins(true); }, 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadTopCoins]);

  // ── Pick up pending signals that server queued in Redis ──────────
  // When the server inserts a trade it also queues the signal in Redis.
  // We detect new signals here then reload from DB (using loadFromSupabase)
  // so the local state uses the server's trade ID — avoiding the duplicate
  // that used to occur when addTrade created a client-side ID that
  // saveToSupabase would then upsert as a separate DB row.
  useEffect(() => {
    const pickupPending = async () => {
      if (document.visibilityState !== 'visible') return;
      const secret = useStore.getState().webhookSecret;
      const userId = useStore.getState().userId;
      try {
        const res = await fetch('/api/analyze', { method: 'POST', headers: { 'x-webhook-secret': secret } });
        const data: { signals?: TradingSignal[] } = await res.json();
        const freshSigs = (data.signals ?? []).filter(sig => !seenPendingIds.current.has(sig.id));
        if (freshSigs.length === 0) return;

        for (const sig of freshSigs) {
          seenPendingIds.current.add(sig.id);
          const s = useStore.getState();
          if (!s.coins.find(c => c.symbol === sig.symbol)) {
            s.addCoin(sig.symbol);
            setTimeout(() => runCoinAnalysis(sig.symbol), 500);
          }
        }
        // Reload from DB — server already inserted the trade with a stable ID.
        if (userId) await loadFromSupabase(userId);
      } catch { /* ignore network errors */ }
    };
    pickupPending();
    document.addEventListener('visibilitychange', pickupPending);
    const pollId = setInterval(pickupPending, 15 * 1000);
    return () => {
      document.removeEventListener('visibilitychange', pickupPending);
      clearInterval(pollId);
    };
  }, []);

  useEffect(() => {
    if (!input.trim() || input.length < 2) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const results = await searchSymbols(input.trim());
        setSearchResults(results.slice(0, 5));
      } catch { setSearchResults([]); }
    }, 400);
    return () => clearTimeout(t);
  }, [input]);

  const handleAdd = async (rawSymbol?: string) => {
    setAddError('');
    const raw    = (rawSymbol ?? input).trim().toUpperCase().replace('/', '');
    const symbol = raw.endsWith('USDT') ? raw : raw + 'USDT';
    if (coins.some((c) => c.symbol === symbol)) {
      setAddError('此幣種已在監控列表中');
      return;
    }
    setAdding(true);
    const valid = await validateSymbol(symbol);
    setAdding(false);
    if (!valid) { setAddError('找不到 ' + symbol + '，請確認代號'); return; }
    addCoin(symbol);
    closeAdd();
    setTimeout(() => runCoinAnalysis(symbol), 300);
  };

  const closeAdd = () => {
    setShowAdd(false);
    setInput('');
    setAddError('');
    setSearchResults([]);
  };

  const unread           = coins.reduce((n, c) => n + c.signals.filter((s) => !s.isRead).length, 0);
  const autoCloseAlerts  = useStore((s) => s.autoCloseAlerts);
  const dismissAutoClose = useStore((s) => s.dismissAutoCloseAlert);
  const minStrength      = useStore((s) => s.settings.minSignalStrength);

  // Sort coins: highest-score signal first, then by name
  const STRENGTH_RANK: Record<string, number> = { WEAK: 0, MODERATE: 1, STRONG: 2 };
  const sortedCoins = useMemo(() =>
    [...coins].sort((a, b) => (b.signals[0]?.score ?? 0) - (a.signals[0]?.score ?? 0)),
  [coins]);

  // Market sentiment: count coins with LONG vs SHORT signals (above minStrength)
  const sentiment = useMemo(() => {
    let longs = 0, shorts = 0;
    coins.forEach(c => {
      const top = c.signals.find(s => STRENGTH_RANK[s.strength] >= STRENGTH_RANK[minStrength]);
      if (top?.direction === 'LONG') longs++;
      else if (top?.direction === 'SHORT') shorts++;
    });
    return { longs, shorts };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coins, minStrength]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div>
          <h1 className="text-[#E8ECF1] text-[15px] font-medium tracking-[0.05em]">幣種監控</h1>
          <p className="text-[#565E6B] text-[10px] mt-0.5 num">
            {coins.length} 監控 · {coins.filter((c) => c.signals.length > 0).length} 訊號
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex gap-1.5">
          <button
            onClick={() => loadTopCoins(false)}
            disabled={autoLoading || refreshing}
            className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded disabled:opacity-40 active:bg-[#141A21]"
          >
            {autoLoading ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-[#8A94A2] border-t-transparent rounded-full animate-spin inline-block" />
                載入
              </span>
            ) : '熱門'}
          </button>
          <button
            onClick={analyzeAll}
            disabled={refreshing || autoLoading}
            className="text-[#2DD4BF] text-[11px] px-2.5 py-1 border border-[#2DD4BF]/40 rounded disabled:opacity-40 active:bg-[#141A21]"
          >
            {refreshing ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-[#2DD4BF] border-t-transparent rounded-full animate-spin inline-block" />
                掃描中
              </span>
            ) : '掃描'}
          </button>
          <button onClick={() => setShowAdd(true)} className="bg-[#2DD4BF] text-[#0A0D11] text-[11px] font-medium px-2.5 py-1 rounded active:opacity-80">
            +
          </button>
        </div>
      </div>

      {/* Edge-to-edge market status strip */}
      <BtcStatusBar />

      <div className="px-3 pt-2 space-y-2">
        {autoLoading && (
          <div className="mt-2 px-3 py-2 bg-[#0F141A] border border-[#1B222B] rounded-md flex items-center gap-2">
            <span className="w-3 h-3 border-[1.5px] border-[#2DD4BF] border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-[#8A94A2] text-xs">正在從 Binance 抓取熱門幣種…</p>
          </div>
        )}
        {autoMsg && !autoLoading && (
          <div className="mt-2 px-3 py-2 bg-[#0F141A] border border-[#1B222B] rounded-md text-[#8A94A2] text-xs">
            {autoMsg}
          </div>
        )}
        {/* Auto-close alerts */}
        {autoCloseAlerts.map(alert => (
          <div key={alert.id}
            className={`mt-2 px-3 py-2 rounded-md flex items-center justify-between border bg-[#0F141A] ${
              alert.result === 'LOSS' ? 'border-[#F6465D]/30' : 'border-[#0ECB81]/30'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-[10px] shrink-0 ${alert.result === 'LOSS' ? 'text-[#F6465D]' : 'text-[#0ECB81]'}`}>●</span>
              <p className={`text-xs truncate ${alert.result === 'LOSS' ? 'text-[#F6465D]' : 'text-[#0ECB81]'}`}>
                {alert.symbol.replace('USDT', '/USDT')} 自動平倉 ·{' '}
                {alert.result === 'WIN_TP2' ? 'TP2 達標' : alert.result === 'WIN_TP1' ? 'TP1 達標' : '止損出場'}{' '}
                <span className="num">{alert.pnlPercent >= 0 ? '+' : ''}{alert.pnlPercent}%</span>
              </p>
            </div>
            <button onClick={() => dismissAutoClose(alert.id)} className="text-[#565E6B] text-sm ml-2 shrink-0">✕</button>
          </div>
        ))}

        {/* Server scan status — why each coin was / wasn't signalled */}
        <ScanStatusPanel />

        {/* Market sentiment bar */}
        {(sentiment.longs + sentiment.shorts) > 0 && (
          <div className="mt-2 px-3 py-2 bg-[#0F141A] border border-[#1B222B] rounded-md flex items-center gap-3">
            <span className="text-[#0ECB81] text-xs num shrink-0">▲ {sentiment.longs}</span>
            <div className="flex-1 h-1 bg-[#141A21] overflow-hidden">
              <div className="h-full bg-[#0ECB81]" style={{ width: `${Math.round(sentiment.longs / (sentiment.longs + sentiment.shorts) * 100)}%` }} />
            </div>
            <div className="flex-1 h-1 bg-[#141A21] overflow-hidden flex justify-end">
              <div className="h-full bg-[#F6465D]" style={{ width: `${Math.round(sentiment.shorts / (sentiment.longs + sentiment.shorts) * 100)}%` }} />
            </div>
            <span className="text-[#F6465D] text-xs num shrink-0">{sentiment.shorts} ▼</span>
          </div>
        )}

        {unread > 0 && (
          <div className="mt-2 px-3 py-2 bg-[#0F141A] border border-[#2DD4BF]/30 rounded-md flex items-center gap-2">
            <span className="text-[#2DD4BF] text-[10px]">●</span>
            <p className="text-[#2DD4BF] text-xs"><span className="num">{unread}</span> 個未讀交易信號</p>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pt-2 scroll-container">
        {sortedCoins.length === 0 && !autoLoading ? (
          <div className="px-4"><EmptyState onAuto={() => loadTopCoins(false)} onManual={() => setShowAdd(true)} autoLoading={autoLoading} /></div>
        ) : (
          <>
            {/* Column header — terminal table */}
            <div className="flex items-center px-3 py-1.5 border-y border-[#1B222B] bg-[#0C1116]">
              <span className="w-[96px] tlabel">幣種</span>
              <span className="flex-1 text-right tlabel">最新價 / 24H</span>
              <span className="w-[76px] text-right tlabel">訊號</span>
            </div>
            {sortedCoins.map((coin) => <CoinCard key={coin.symbol} coin={coin} />)}
          </>
        )}
        <div className="h-4" />
      </div>

      {showAdd && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-end"
          onClick={(e) => e.target === e.currentTarget && closeAdd()}
        >
          <div className="w-full max-w-xl mx-auto bg-[#0F141A] rounded-t-3xl p-6 pb-10 border-t border-[#1B222B]">
            <div className="w-12 h-1 bg-[#1B222B] rounded-full mx-auto mb-5" />
            <h2 className="text-[#E8ECF1] text-lg font-extrabold mb-1">新增監控幣種</h2>
            <p className="text-[#565E6B] text-sm mb-4">輸入代號，輸入時自動搜尋</p>
            <div className="flex gap-2 mb-4 flex-wrap">
              {['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','MATIC'].map((c) => (
                <button key={c} onClick={() => setInput(c)} className="chip text-xs py-1">{c}</button>
              ))}
            </div>
            <input
              autoFocus
              value={input}
              onChange={(e) => { setInput(e.target.value.toUpperCase()); setAddError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="輸入代號，例如：BTC、SOL"
              className="input-field mb-2"
            />
            {searchResults.length > 0 && (
              <div className="bg-[#141A21] rounded-xl border border-[#1B222B] mb-2 overflow-hidden">
                {searchResults.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleAdd(s)}
                    className="w-full text-left px-4 py-2.5 text-sm text-[#E8ECF1] border-b border-[#1B222B] last:border-0 font-mono active:bg-[#252535]"
                  >
                    {s.replace('USDT', '/USDT')}
                  </button>
                ))}
              </div>
            )}
            {addError && <p className="text-red-400 text-xs mb-2">{addError}</p>}
            <div className="flex gap-3 mt-2">
              <button onClick={closeAdd} className="flex-1 py-3 rounded-xl bg-[#141A21] text-[#8A94A2] font-semibold border border-[#1B222B]">
                取消
              </button>
              <button onClick={() => handleAdd()} disabled={!input.trim() || adding} className="flex-1 py-3 rounded-xl btn-primary disabled:opacity-50">
                {adding ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-[#0A0D11] border-t-transparent rounded-full animate-spin" />
                    驗證中
                  </span>
                ) : '新增'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onAuto, onManual, autoLoading }: { onAuto: () => void; onManual: () => void; autoLoading: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-8">
      <div className="text-[#2A323D] text-3xl num">[ ]</div>
      <div>
        <p className="text-[#8A94A2] font-medium text-base">還沒有監控幣種</p>
        <p className="text-[#565E6B] text-sm mt-1">自動載入 Binance 熱門幣種，或手動新增</p>
      </div>
      <div className="flex gap-3">
        <button onClick={onAuto} disabled={autoLoading} className="px-5 py-2 rounded border border-[#232B35] text-[#8A94A2] text-sm disabled:opacity-40 active:bg-[#141A21]">
          {autoLoading ? '載入中…' : '自動載入熱門'}
        </button>
        <button onClick={onManual} className="btn-primary px-5 py-2 text-sm">
          + 手動新增
        </button>
      </div>
    </div>
  );
}

'use client';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { usePriceStore } from '@/store/usePriceStore';
import { pickTp1Hits } from '@/lib/tp1Watch';
import { CoinCard } from '@/components/CoinCard';
import { BtcStatusBar } from '@/components/BtcStatusBar';
import { ScanStatusPanel } from '@/components/ScanStatusPanel';
import { FormField } from '@/components/ui/FormField';
import { fetchCandles, fetchTicker24h, validateSymbol, fetchTopCoinsByVolume, searchSymbols } from '@/api/binance';
import { generateSignals, unifySignalDirection } from '@/analysis/signals';
import { computeIndicators } from '@/analysis/indicators';
import { Candle, Timeframe, TradingSignal } from '@/types';
import { loadFromSupabase } from '@/components/StoreHydration';

const HTF_MAP: Partial<Record<Timeframe, Timeframe>> = {
  '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d',
};

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

// ── One-shot price refresh for a single coin (no candle fetch) ───
// The continuous 3s price loop lives in <PriceFeed> (mounted in the root
// layout). This is only the "refresh right now" path used at the start of a
// full analysis, so the indicators are compared against a fresh price rather
// than one up to 3s old.
//
// All actual trade closes (TP2, SL, TP1 final) are handled by server cron
// (monitorActiveTrades). The client only marks TP1 locally so the trade card
// immediately shows "✅ TP1·等TP2" without waiting for the next 2-min sync.
async function checkCoinPrice(symbol: string): Promise<void> {
  const store = useStore.getState();
  if (!store.coins.find((c) => c.symbol === symbol)) return;
  try {
    const ticker = await fetchTicker24h(symbol);
    usePriceStore.getState().setTickers24h(new Map([[symbol, ticker]]));

    const hits = pickTp1Hits(
      useStore.getState().trades.filter(t => t.symbol === symbol),
      () => ticker.price,
    );
    if (hits.length > 0) {
      const hitSet = new Set(hits);
      useStore.setState(s => ({
        trades: s.trades.map(t => (hitSet.has(t.id) ? { ...t, status: 'tp1_hit' as const } : t)),
      }));
    }
  } catch {
    // Ignore: PriceFeed's 3s loop is the real price source and handles backoff.
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

  // Price polling + TP1 detection used to live here as a 30s loop that walked
  // the coins one at a time (~4-5s per round, and it died whenever the user
  // navigated away). Both now belong to <PriceFeed> in the root layout.

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
      <div className="flex items-center px-3 pt-14 pb-2.5 safe-top border-b border-white/[0.06]">
        <div>
          <h1 className="text-text-p text-[15px] font-medium tracking-[0.05em]">幣種監控</h1>
          <p className="text-text-m text-[10px] mt-0.5 num">
            {coins.length} 監控 · {coins.filter((c) => c.signals.length > 0).length} 訊號
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex gap-1.5">
          <button
            onClick={() => loadTopCoins(false)}
            disabled={autoLoading || refreshing}
            className="text-text-s text-[11px] px-2.5 py-1 rounded-full border border-white/[0.08] disabled:opacity-40 active:bg-white/[0.04]"
          >
            {autoLoading ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-text-s border-t-transparent rounded-full animate-spin inline-block" />
                載入
              </span>
            ) : '熱門'}
          </button>
          <button
            onClick={analyzeAll}
            disabled={refreshing || autoLoading}
            className="text-accent text-[11px] px-2.5 py-1 rounded-full border border-accent/40 disabled:opacity-40 active:bg-white/[0.04]"
          >
            {refreshing ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin inline-block" />
                掃描中
              </span>
            ) : '掃描'}
          </button>
          <button onClick={() => setShowAdd(true)} className="bg-accent text-[#0A0D11] text-[11px] font-medium px-2.5 py-1 rounded-full active:opacity-80">
            +
          </button>
        </div>
      </div>

      {/* Edge-to-edge market status strip */}
      <BtcStatusBar />

      <div className="px-3 pt-2 space-y-2">
        {autoLoading && (
          <div className="mt-2 px-3 py-2 bg-card-2 border border-white/[0.06] rounded-md flex items-center gap-2">
            <span className="w-3 h-3 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-text-s text-xs">正在從 Binance 抓取熱門幣種…</p>
          </div>
        )}
        {autoMsg && !autoLoading && (
          <div className="mt-2 px-3 py-2 bg-card-2 border border-white/[0.06] rounded-md text-text-s text-xs">
            {autoMsg}
          </div>
        )}
        {/* Auto-close alerts */}
        {autoCloseAlerts.map(alert => (
          <div key={alert.id}
            className={`mt-2 px-3 py-2 rounded-md flex items-center justify-between border bg-card-2 ${
              alert.result === 'LOSS' ? 'border-down/30' : 'border-up/30'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-[10px] shrink-0 ${alert.result === 'LOSS' ? 'text-down' : 'text-up'}`}>●</span>
              <p className={`text-xs truncate ${alert.result === 'LOSS' ? 'text-down' : 'text-up'}`}>
                {alert.symbol.replace('USDT', '/USDT')} 自動平倉 ·{' '}
                {alert.result === 'WIN_TP2' ? 'TP2 達標' : alert.result === 'WIN_TP1' ? 'TP1 達標' : '止損出場'}{' '}
                <span className="num">{alert.pnlPercent >= 0 ? '+' : ''}{alert.pnlPercent}%</span>
              </p>
            </div>
            <button onClick={() => dismissAutoClose(alert.id)} className="text-text-m text-sm ml-2 shrink-0">✕</button>
          </div>
        ))}

        {/* Server scan status — why each coin was / wasn't signalled */}
        <ScanStatusPanel />

        {/* Market sentiment bar */}
        {(sentiment.longs + sentiment.shorts) > 0 && (
          <div className="mt-2 px-3 py-2 bg-card-2 border border-white/[0.06] rounded-md flex items-center gap-3">
            <span className="text-up text-xs num shrink-0">▲ {sentiment.longs}</span>
            <div className="flex-1 h-1 bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-up" style={{ width: `${Math.round(sentiment.longs / (sentiment.longs + sentiment.shorts) * 100)}%` }} />
            </div>
            <div className="flex-1 h-1 bg-white/[0.06] overflow-hidden flex justify-end">
              <div className="h-full bg-down" style={{ width: `${Math.round(sentiment.shorts / (sentiment.longs + sentiment.shorts) * 100)}%` }} />
            </div>
            <span className="text-down text-xs num shrink-0">{sentiment.shorts} ▼</span>
          </div>
        )}

        {unread > 0 && (
          <div className="mt-2 px-3 py-2 bg-card-2 border border-accent/30 rounded-md flex items-center gap-2">
            <span className="text-accent text-[10px]">●</span>
            <p className="text-accent text-xs"><span className="num">{unread}</span> 個未讀交易信號</p>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pt-2 scroll-container">
        {sortedCoins.length === 0 && !autoLoading ? (
          <div className="px-4"><EmptyState onAuto={() => loadTopCoins(false)} onManual={() => setShowAdd(true)} autoLoading={autoLoading} /></div>
        ) : (
          <>
            {/* Column header — terminal table */}
            <div className="flex items-center px-3 py-1.5 border-y border-white/[0.06] bg-white/[0.02]">
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
          <div className="w-full max-w-xl mx-auto bg-card-2 rounded-t-3xl p-6 pb-10 border-t border-white/[0.06]">
            <div className="w-12 h-1 bg-white/[0.06] rounded-full mx-auto mb-5" />
            <h2 className="text-text-p text-lg font-extrabold mb-1">新增監控幣種</h2>
            <p className="text-text-m text-sm mb-4">輸入代號，輸入時自動搜尋</p>
            <div className="flex gap-2 mb-4 flex-wrap">
              {['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','MATIC'].map((c) => (
                <button key={c} onClick={() => setInput(c)} className="chip text-xs py-1">{c}</button>
              ))}
            </div>
            <div className="mb-2" onKeyDown={(e) => e.key === 'Enter' && handleAdd()}>
              <FormField
                label="幣種代號"
                value={input}
                onChange={(v) => { setInput(v.toUpperCase()); setAddError(''); }}
                placeholder="輸入代號，例如：BTC、SOL"
              />
            </div>
            {searchResults.length > 0 && (
              <div className="bg-white/[0.04] rounded-xl border border-white/[0.06] mb-2 overflow-hidden">
                {searchResults.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleAdd(s)}
                    className="w-full text-left px-4 py-2.5 text-sm text-text-p border-b border-white/[0.06] last:border-0 font-mono active:bg-white/[0.08]"
                  >
                    {s.replace('USDT', '/USDT')}
                  </button>
                ))}
              </div>
            )}
            {addError && <p className="text-down text-xs mb-2">{addError}</p>}
            <div className="flex gap-3 mt-2">
              <button onClick={closeAdd} className="flex-1 py-3 rounded-xl bg-white/[0.04] text-text-s font-semibold border border-white/[0.06]">
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
      <div className="text-text-m text-3xl num">[ ]</div>
      <div>
        <p className="text-text-s font-medium text-base">還沒有監控幣種</p>
        <p className="text-text-m text-sm mt-1">自動載入 Binance 熱門幣種，或手動新增</p>
      </div>
      <div className="flex gap-3">
        <button onClick={onAuto} disabled={autoLoading} className="px-5 py-2 rounded border border-white/[0.08] text-text-s text-sm disabled:opacity-40 active:bg-white/[0.04]">
          {autoLoading ? '載入中…' : '自動載入熱門'}
        </button>
        <button onClick={onManual} className="btn-primary px-5 py-2 text-sm">
          + 手動新增
        </button>
      </div>
    </div>
  );
}

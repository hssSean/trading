'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useStore } from '@/store/useStore';
import { CoinCard } from '@/components/CoinCard';
import { fetchCandles, fetchTicker24h, validateSymbol, fetchTopCoinsByVolume, searchSymbols } from '@/api/binance';
import { generateSignals } from '@/analysis/signals';
import { Timeframe } from '@/types';

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

async function runCoinAnalysis(symbol: string) {
  const store = useStore.getState();
  const coin = store.coins.find((c) => c.symbol === symbol);
  if (!coin) return;
  store.updateCoin(symbol, { isLoading: true });
  try {
    const ticker = await fetchTicker24h(symbol);
    store.updateCoin(symbol, {
      currentPrice: ticker.price,
      priceChange24h: ticker.priceChange,
      priceChangePercent24h: ticker.priceChangePercent,
    });
    const allSignals = [];
    for (const tf of coin.timeframes) {
      const candles = await fetchCandles(symbol, tf as Timeframe, 200);
      allSignals.push(...generateSignals(symbol, tf as Timeframe, candles));
    }
    store.addSignals(symbol, allSignals);
    // Auto-add STRONG signals (score >= 16) to trade journal if no active trade
    const best = allSignals.filter((s) => s.strength === 'STRONG').sort((a, b) => b.score - a.score)[0];
    if (best && !store.hasActiveTrade(symbol)) {
      store.addTrade(best);
    }
  } catch (err) {
    console.error('[analyze]', symbol, err);
  } finally {
    store.updateCoin(symbol, { isLoading: false, lastAnalyzed: Date.now() });
  }
}

export default function HomePage() {
  const coins       = useStore((s) => s.coins);
  const addCoin     = useStore((s) => s.addCoin);
  const hasHydrated = useStore((s) => s._hasHydrated);

  const [refreshing, setRefreshing]       = useState(false);
  const [showAdd, setShowAdd]             = useState(false);
  const [input, setInput]                 = useState('');
  const [adding, setAdding]               = useState(false);
  const [addError, setAddError]           = useState('');
  const [autoLoading, setAutoLoading]     = useState(false);
  const [autoMsg, setAutoMsg]             = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  const autoLoaded = useRef(false);

  const analyzeAll = useCallback(async () => {
    setRefreshing(true);
    const symbols = useStore.getState().coins.map((c) => c.symbol);
    for (const s of symbols) {
      await runCoinAnalysis(s);
      await new Promise((r) => setTimeout(r, 300));
    }
    setRefreshing(false);
  }, []);

  const loadTopCoins = useCallback(async (silent = false) => {
    if (!silent) setAutoLoading(true);
    setAutoMsg('');
    try {
      const top = await fetchTopCoinsByVolume(10);
      const store = useStore.getState();
      const existing = new Set(store.coins.map((c) => c.symbol));
      const toAdd = top.filter((s) => !existing.has(s));
      toAdd.forEach((s) => store.addCoin(s));
      if (!silent) {
        setAutoMsg('已載入成交量前 10 名，新增 ' + toAdd.length + ' 個幣種');
        setTimeout(() => setAutoMsg(''), 4000);
      }
      for (const s of toAdd) {
        await runCoinAnalysis(s);
        await new Promise((r) => setTimeout(r, 300));
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
    const syms = useStore.getState().coins.map((c) => c.symbol);
    const isDefault =
      syms.length === DEFAULT_SYMBOLS.length &&
      DEFAULT_SYMBOLS.every((s) => syms.includes(s));
    if (isDefault) {
      loadTopCoins(true);
    } else {
      const needsAnalysis = useStore.getState().coins.some((c) => c.lastAnalyzed === 0);
      if (needsAnalysis) analyzeAll();
    }
  }, [hasHydrated, loadTopCoins, analyzeAll]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const id = setInterval(() => { analyzeAll(); }, 30 * 1000);
    return () => clearInterval(id);
  }, [analyzeAll]);

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

  const unread = coins.reduce((n, c) => n + c.signals.filter((s) => !s.isRead).length, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E]">
        <div>
          <h1 className="text-[#EAEAF4] text-xl font-extrabold tracking-tight">Crypto Trader</h1>
          <p className="text-[#606080] text-xs mt-0.5">
            {coins.length} 個幣種 · {coins.filter((c) => c.signals.length > 0).length} 個有信號
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => loadTopCoins(false)}
            disabled={autoLoading || refreshing}
            className="text-blue-400 text-xs font-semibold px-3 py-1.5 border border-blue-400/30 rounded-full disabled:opacity-40 active:opacity-70"
          >
            {autoLoading ? (
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin inline-block" />
                載入
              </span>
            ) : '熱門'}
          </button>
          <button
            onClick={analyzeAll}
            disabled={refreshing || autoLoading}
            className="text-[#F0B90B] text-xs font-semibold px-3 py-1.5 border border-[#F0B90B]/40 rounded-full disabled:opacity-40 active:opacity-70"
          >
            {refreshing ? (
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin inline-block" />
                分析中
              </span>
            ) : '重新分析'}
          </button>
          <button onClick={() => setShowAdd(true)} className="btn-primary text-xs">
            + 新增
          </button>
        </div>
      </div>

      <div className="px-4 space-y-2">
        {autoLoading && (
          <div className="mt-3 px-4 py-2.5 bg-blue-500/10 border border-blue-500/30 rounded-2xl flex items-center gap-2">
            <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-blue-400 text-xs font-semibold">正在從 Binance 抓取熱門幣種…</p>
          </div>
        )}
        {autoMsg && !autoLoading && (
          <div className="mt-3 px-4 py-2.5 bg-blue-500/10 border border-blue-500/30 rounded-2xl text-blue-400 text-xs font-semibold">
            已完成：{autoMsg}
          </div>
        )}
        {unread > 0 && (
          <div className="mt-3 px-4 py-2.5 bg-yellow-400/10 border border-[#F0B90B]/30 rounded-2xl flex items-center gap-2">
            <span className="text-[#F0B90B]">🔔</span>
            <p className="text-[#F0B90B] text-xs font-semibold">{unread} 個未讀交易信號</p>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-3 scroll-container">
        {coins.length === 0 && !autoLoading ? (
          <EmptyState onAuto={() => loadTopCoins(false)} onManual={() => setShowAdd(true)} autoLoading={autoLoading} />
        ) : (
          coins.map((coin) => <CoinCard key={coin.symbol} coin={coin} />)
        )}
        <div className="h-4" />
      </div>

      {showAdd && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-end"
          onClick={(e) => e.target === e.currentTarget && closeAdd()}
        >
          <div className="w-full max-w-xl mx-auto bg-[#12121A] rounded-t-3xl p-6 pb-10 border-t border-[#1E1E2E]">
            <div className="w-12 h-1 bg-[#1E1E2E] rounded-full mx-auto mb-5" />
            <h2 className="text-[#EAEAF4] text-lg font-extrabold mb-1">新增監控幣種</h2>
            <p className="text-[#606080] text-sm mb-4">輸入代號，輸入時自動搜尋</p>
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
              <div className="bg-[#1A1A26] rounded-xl border border-[#1E1E2E] mb-2 overflow-hidden">
                {searchResults.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleAdd(s)}
                    className="w-full text-left px-4 py-2.5 text-sm text-[#EAEAF4] border-b border-[#1E1E2E] last:border-0 font-mono active:bg-[#252535]"
                  >
                    {s.replace('USDT', '/USDT')}
                  </button>
                ))}
              </div>
            )}
            {addError && <p className="text-red-400 text-xs mb-2">{addError}</p>}
            <div className="flex gap-3 mt-2">
              <button onClick={closeAdd} className="flex-1 py-3 rounded-xl bg-[#1A1A26] text-[#A0A0C0] font-semibold border border-[#1E1E2E]">
                取消
              </button>
              <button onClick={() => handleAdd()} disabled={!input.trim() || adding} className="flex-1 py-3 rounded-xl btn-primary disabled:opacity-50">
                {adding ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-[#0A0A0F] border-t-transparent rounded-full animate-spin" />
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
      <div className="text-5xl">📈</div>
      <div>
        <p className="text-[#A0A0C0] font-semibold text-base">還沒有監控幣種</p>
        <p className="text-[#606080] text-sm mt-1">自動載入 Binance 熱門幣種，或手動新增</p>
      </div>
      <div className="flex gap-3">
        <button onClick={onAuto} disabled={autoLoading} className="px-5 py-2.5 rounded-2xl bg-blue-500/10 border border-blue-500/30 text-blue-400 font-semibold text-sm disabled:opacity-40">
          {autoLoading ? '載入中…' : '自動載入熱門'}
        </button>
        <button onClick={onManual} className="btn-primary px-5 py-2.5 rounded-2xl text-sm">
          + 手動新增
        </button>
      </div>
    </div>
  );
}

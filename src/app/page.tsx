'use client';
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '@/store/useStore';
import { CoinCard } from '@/components/CoinCard';
import { fetchCandles, fetchTicker24h, validateSymbol } from '@/api/binance';
import { generateSignals } from '@/analysis/signals';
import { Timeframe } from '@/types';

// Runs full analysis for one coin and updates the store
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
  } catch (err) {
    console.error('[analyze]', symbol, err);
  } finally {
    store.updateCoin(symbol, { isLoading: false, lastAnalyzed: Date.now() });
  }
}

export default function HomePage() {
  const coins = useStore((s) => s.coins);
  const addCoin = useStore((s) => s.addCoin);
  const hasHydrated = useStore((s) => s._hasHydrated);

  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  const analyzeAll = useCallback(async () => {
    setRefreshing(true);
    const symbols = useStore.getState().coins.map((c) => c.symbol);
    for (const s of symbols) {
      await runCoinAnalysis(s);
      await new Promise((r) => setTimeout(r, 400));
    }
    setRefreshing(false);
  }, []);

  // Auto-analyze after hydration if coins haven't been analyzed yet
  useEffect(() => {
    if (!hasHydrated) return;
    const needsAnalysis = useStore.getState().coins.some((c) => c.lastAnalyzed === 0);
    if (needsAnalysis) analyzeAll();
  }, [hasHydrated, analyzeAll]);

  const handleAdd = async () => {
    setAddError('');
    const raw = input.trim().toUpperCase().replace('/', '');
    const symbol = raw.endsWith('USDT') ? raw : raw + 'USDT';

    if (coins.some((c) => c.symbol === symbol)) {
      setAddError('此幣種已在監控列表中');
      return;
    }
    setAdding(true);
    const valid = await validateSymbol(symbol);
    setAdding(false);

    if (!valid) {
      setAddError(`找不到 ${symbol}，請確認代號（例如 BTC、ETH、SOL）`);
      return;
    }

    addCoin(symbol);
    closeAdd();
    setTimeout(() => runCoinAnalysis(symbol), 300);
  };

  const closeAdd = () => {
    setShowAdd(false);
    setInput('');
    setAddError('');
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 pt-14 pb-4 safe-top">
        <div>
          <h1 className="text-[#EAEAF4] text-xl font-extrabold tracking-tight">Crypto Trader</h1>
          <p className="text-[#606080] text-xs mt-0.5">
            {coins.length} 個幣種 · {coins.filter((c) => c.signals.length > 0).length} 個有信號
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={analyzeAll}
            disabled={refreshing}
            className="text-[#F0B90B] text-sm font-semibold px-3 py-1.5 border border-[#F0B90B]/40 rounded-full disabled:opacity-40 active:opacity-70"
          >
            {refreshing ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin inline-block" />
                分析中
              </span>
            ) : '重新分析'}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="btn-primary text-sm"
          >
            + 新增
          </button>
        </div>
      </div>

      {/* ── Coin list ── */}
      <div className="flex-1 overflow-y-auto px-4 scroll-container">
        {coins.length === 0 ? (
          <EmptyState onAdd={() => setShowAdd(true)} />
        ) : (
          <>
            {/* Unread signals summary banner */}
            {(() => {
              const unread = coins.reduce((n, c) => n + c.signals.filter((s) => !s.isRead).length, 0);
              return unread > 0 ? (
                <div className="mb-3 px-4 py-3 bg-yellow-400/10 border border-[#F0B90B]/30 rounded-2xl flex items-center gap-3">
                  <span className="text-[#F0B90B] text-lg">🔔</span>
                  <p className="text-[#F0B90B] text-sm font-semibold">
                    {unread} 個未讀交易信號
                  </p>
                </div>
              ) : null;
            })()}
            {coins.map((coin) => (
              <CoinCard key={coin.symbol} coin={coin} />
            ))}
          </>
        )}
        <div className="h-4" />
      </div>

      {/* ── Add coin modal ── */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-end"
          onClick={(e) => e.target === e.currentTarget && closeAdd()}
        >
          <div className="w-full max-w-xl mx-auto bg-[#12121A] rounded-t-3xl p-6 pb-10 border-t border-[#1E1E2E]">
            <div className="w-12 h-1 bg-[#1E1E2E] rounded-full mx-auto mb-5" />
            <h2 className="text-[#EAEAF4] text-lg font-extrabold mb-1">新增監控幣種</h2>
            <p className="text-[#606080] text-sm mb-4">輸入幣種代號，支援 Binance USDT 交易對</p>

            {/* Quick add popular coins */}
            <div className="flex gap-2 mb-4 flex-wrap">
              {['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'].map((c) => (
                <button
                  key={c}
                  onClick={() => setInput(c)}
                  className="chip text-xs py-1"
                >
                  {c}
                </button>
              ))}
            </div>

            <input
              autoFocus
              value={input}
              onChange={(e) => { setInput(e.target.value.toUpperCase()); setAddError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="輸入代號，例如：BTC"
              className="w-full bg-[#1A1A26] text-[#EAEAF4] rounded-xl px-4 py-3 text-lg border border-[#1E1E2E] focus:border-[#F0B90B] outline-none mb-2 font-mono tracking-wider"
            />
            {addError && <p className="text-red-400 text-xs mb-3">{addError}</p>}

            <div className="flex gap-3 mt-2">
              <button
                onClick={closeAdd}
                className="flex-1 py-3 rounded-xl bg-[#1A1A26] text-[#A0A0C0] font-semibold border border-[#1E1E2E]"
              >
                取消
              </button>
              <button
                onClick={handleAdd}
                disabled={!input.trim() || adding}
                className="flex-1 py-3 rounded-xl btn-primary disabled:opacity-50"
              >
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

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-8">
      <div className="text-5xl">📈</div>
      <div>
        <p className="text-[#A0A0C0] font-semibold text-base">還沒有監控幣種</p>
        <p className="text-[#606080] text-sm mt-1">加入幣種，讓 AI 幫你分析最佳進場位置</p>
      </div>
      <button onClick={onAdd} className="btn-primary px-8 py-3 rounded-2xl">
        + 新增幣種
      </button>
    </div>
  );
}

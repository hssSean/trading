'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store/useStore';
import { SignalCard } from '@/components/SignalCard';
import { CandlestickChart } from '@/components/CandlestickChart';
import { fetchCandles, fetchTicker24h } from '@/api/binance';
import { computeIndicators } from '@/analysis/indicators';
import { generateSignals } from '@/analysis/signals';
import { findOrderBlocks, findFairValueGaps } from '@/analysis/smc';
import { findSRLevels } from '@/analysis/snr';
import { Candle, TechnicalIndicators, Timeframe, OrderBlock, FairValueGap, SRLevel } from '@/types';

const TFS: Timeframe[] = ['15m', '1h', '4h', '1d'];

// ── Next.js 14: params is a plain object, NOT a Promise ──
export default function AnalysisPage({ params }: { params: { symbol: string } }) {
  const { symbol } = params;
  const router = useRouter();
  const { coins, updateCoin, addSignals } = useStore();
  const coin = coins.find((c) => c.symbol === symbol);

  const [tf, setTf] = useState<Timeframe>('4h');
  const [indicators, setIndicators] = useState<TechnicalIndicators | null>(null);
  const [orderBlocks, setOrderBlocks] = useState<OrderBlock[]>([]);
  const [fvgs, setFvgs] = useState<FairValueGap[]>([]);
  const [srLevels, setSrLevels] = useState<SRLevel[]>([]);
  const [chartCandles, setChartCandles] = useState<Candle[]>([]);
  const [htfBias, setHtfBias] = useState<'LONG' | 'SHORT' | null>(null);
  const [htfLabel, setHtfLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unlockFlash, setUnlockFlash] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleUnlock = () => {
    const store  = useStore.getState();
    fetch(`/api/analyze?secret=${encodeURIComponent(store.webhookSecret)}&symbol=${symbol}`, { method: 'DELETE' }).catch(() => {});
    setUnlockFlash(true);
    setTimeout(() => setUnlockFlash(false), 2500);
  };

  const analyze = useCallback(
    async (timeframe: Timeframe) => {
      // Cancel any in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setError('');
      try {
        const [candles, ticker] = await Promise.all([
          fetchCandles(symbol, timeframe, 200),
          fetchTicker24h(symbol),
        ]);

        setChartCandles(candles);

        // Indicators
        setIndicators(computeIndicators(candles));

        // SMC levels
        setOrderBlocks(findOrderBlocks(candles).filter((ob) => !ob.mitigated).slice(0, 5));
        setFvgs(findFairValueGaps(candles).filter((f) => !f.filled).slice(0, 5));
        setSrLevels(findSRLevels(candles).slice(0, 6));

        // ── HTF bias: higher timeframe determines trend direction ──
        const htfMap: Partial<Record<Timeframe, Timeframe>> = {
          '15m': '1h', '1h': '4h', '4h': '1d',
        };
        const htfTf = htfMap[timeframe] ?? null;
        let bias: 'LONG' | 'SHORT' | null = null;
        let biasLabel = '';
        if (htfTf) {
          try {
            const htfCandles = await fetchCandles(symbol, htfTf, 100);
            const htfInd     = computeIndicators(htfCandles);
            const htfPrice   = htfCandles[htfCandles.length - 1].close;
            const aboveHtfEma200 = htfPrice > htfInd.ema200;
            const nearHtfEma200  = Math.abs(htfPrice - htfInd.ema200) / htfInd.ema200 < 0.015;
            if (!nearHtfEma200) {
              bias      = aboveHtfEma200 ? 'LONG' : 'SHORT';
              biasLabel = aboveHtfEma200 ? `${htfTf.toUpperCase()} 大框偏多 ▲` : `${htfTf.toUpperCase()} 大框偏空 ▼`;
            } else {
              biasLabel = `${htfTf.toUpperCase()} 大框盤整`;
            }
          } catch { /* htf fetch failed, no bias */ }
        }
        setHtfBias(bias);
        setHtfLabel(biasLabel);

        // Update price
        updateCoin(symbol, {
          currentPrice: ticker.price,
          priceChange24h: ticker.priceChange,
          priceChangePercent24h: ticker.priceChangePercent,
        });

        // Generate signals for all coin timeframes (pass htfBias for current tf)
        const currentCoins = useStore.getState().coins;
        const thisCoin = currentCoins.find((c) => c.symbol === symbol);
        const coinTfs = thisCoin?.timeframes ?? [timeframe];
        const allSig = [];
        for (const t of coinTfs) {
          const c = t === timeframe ? candles : await fetchCandles(symbol, t, 200);
          allSig.push(...generateSignals(symbol, t, c, t === timeframe ? bias : undefined));
        }
        addSignals(symbol, allSig);
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'CanceledError') return;
        setError('無法取得資料，請確認網路連線後重試');
      } finally {
        setLoading(false);
      }
    },
    [symbol, updateCoin, addSignals],
  );

  useEffect(() => {
    analyze(tf);
    return () => abortRef.current?.abort();
  }, [tf, analyze]);

  const currentPrice = coin?.currentPrice ?? 0;
  const isUp = (coin?.priceChangePercent24h ?? 0) >= 0;
  const nearbyOBs = orderBlocks.filter(
    (ob) => Math.abs(currentPrice - (ob.type === 'bullish' ? ob.high : ob.low)) / currentPrice < 0.05,
  );
  const nearbyFVGs = fvgs.filter(
    (f) => currentPrice >= f.bottom * 0.97 && currentPrice <= f.top * 1.03,
  );
  const nearSR = srLevels.filter(
    (l) => Math.abs(currentPrice - l.price) / currentPrice < 0.03,
  );

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="px-4 pt-14 pb-2 safe-top flex items-center gap-3 border-b border-[#1E1E2E]">
        <button
          onClick={() => router.back()}
          className="w-9 h-9 rounded-full bg-[#1A1A26] flex items-center justify-center text-[#F0B90B] text-xl font-bold shrink-0"
        >
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-[#606080] text-xs">{symbol}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-[#EAEAF4] text-2xl font-extrabold">
              ${fmtPrice(coin?.currentPrice ?? 0)}
            </span>
            {coin && (
              <span className={`text-sm font-medium ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                {isUp ? '+' : ''}{coin.priceChangePercent24h.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleUnlock}
            className={`text-xs font-semibold border rounded-full px-3 py-1.5 transition-colors active:opacity-70 ${
              unlockFlash
                ? 'text-green-400 border-green-400/50 bg-green-400/10'
                : 'text-[#606080] border-[#1E1E2E]'
            }`}
            title="解除 LINE 推播鎖定，允許此幣種再次推薦新信號"
          >
            {unlockFlash ? '✓ 已解鎖' : '解鎖推播'}
          </button>
          <button
            onClick={() => analyze(tf)}
            disabled={loading}
            className="text-[#F0B90B] text-xs font-semibold border border-[#F0B90B]/40 rounded-full px-3 py-1.5 disabled:opacity-40 active:opacity-70"
          >
            {loading ? '分析中…' : '重新整理'}
          </button>
        </div>
      </div>

      {/* ── Timeframe tabs ── */}
      <div className="flex gap-2 px-4 py-3">
        {TFS.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${
              tf === t
                ? 'bg-yellow-400/10 text-[#F0B90B] border border-[#F0B90B]/50'
                : 'bg-[#1A1A26] text-[#606080] border border-transparent'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── K線圖 ── */}
      <div className="border-b border-[#1E1E2E]">
        {/* HTF bias badge */}
        {htfLabel && (
          <div className="px-4 pt-2 pb-0">
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
              htfBias === 'LONG'  ? 'text-green-400 bg-green-400/10 border-green-400/30' :
              htfBias === 'SHORT' ? 'text-red-400   bg-red-400/10   border-red-400/30'   :
              'text-[#606080] bg-[#1A1A26] border-[#1E1E2E]'
            }`}>
              {htfLabel}
            </span>
          </div>
        )}
        <CandlestickChart
          candles={chartCandles}
          signals={coin?.signals ?? []}
          srLevels={srLevels}
          orderBlocks={orderBlocks}
          height={280}
        />
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 overflow-y-auto px-4 scroll-container">

        {/* Error state */}
        {error && (
          <div className="card mb-4 border-red-500/30 bg-red-500/5">
            <p className="text-red-400 text-sm text-center">{error}</p>
            <button
              onClick={() => analyze(tf)}
              className="mt-3 w-full py-2 rounded-xl bg-red-500/10 text-red-400 text-sm font-semibold"
            >
              重試
            </button>
          </div>
        )}

        {/* ── Technical Indicators ── */}
        <Section title={`技術指標 (${tf})`} loading={loading && !indicators}>
          {indicators && (
            <div className="grid grid-cols-3 gap-2">
              <IndBox
                label="RSI (14)"
                value={indicators.rsi.toFixed(1)}
                color={indicators.rsi > 70 ? 'red' : indicators.rsi < 30 ? 'green' : 'neutral'}
                tag={indicators.rsi > 70 ? '超買' : indicators.rsi < 30 ? '超賣' : '中性'}
              />
              <IndBox
                label="MACD"
                value={indicators.macd > 0 ? `+${indicators.macd.toFixed(4)}` : indicators.macd.toFixed(4)}
                color={indicators.macd > 0 ? 'green' : 'red'}
                tag={indicators.macdHistogram > 0 ? '黃金交叉' : '死亡交叉'}
              />
              <IndBox
                label="趨勢"
                value={indicators.trend === 'bullish' ? '看漲 ▲' : indicators.trend === 'bearish' ? '看跌 ▼' : '盤整'}
                color={indicators.trend === 'bullish' ? 'green' : indicators.trend === 'bearish' ? 'red' : 'neutral'}
              />
              <IndBox label="EMA 20" value={`$${fmtPrice(indicators.ema20)}`}
                color={currentPrice > indicators.ema20 ? 'green' : 'red'}
                tag={currentPrice > indicators.ema20 ? '上方' : '下方'} />
              <IndBox label="EMA 50" value={`$${fmtPrice(indicators.ema50)}`}
                color={currentPrice > indicators.ema50 ? 'green' : 'red'}
                tag={currentPrice > indicators.ema50 ? '上方' : '下方'} />
              <IndBox label="EMA 200" value={`$${fmtPrice(indicators.ema200)}`}
                color={currentPrice > indicators.ema200 ? 'green' : 'red'}
                tag={currentPrice > indicators.ema200 ? '上方' : '下方'} />
            </div>
          )}
        </Section>

        {/* ── SMC Key Levels ── */}
        {(nearbyOBs.length > 0 || nearbyFVGs.length > 0 || nearSR.length > 0) && (
          <Section title="⚡ 當前附近關鍵位置">
            {nearbyOBs.map((ob, i) => (
              <LevelRow
                key={`ob-${i}`}
                label={ob.type === 'bullish' ? '看漲 OB 訂單塊' : '看跌 OB 訂單塊'}
                range={`$${fmtPrice(ob.low)} — $${fmtPrice(ob.high)}`}
                color={ob.type === 'bullish' ? 'green' : 'red'}
                badge={`強度 ${ob.strength}`}
              />
            ))}
            {nearbyFVGs.map((f, i) => (
              <LevelRow
                key={`fvg-${i}`}
                label={f.type === 'bullish' ? '看漲 FVG 缺口' : '看跌 FVG 缺口'}
                range={`$${fmtPrice(f.bottom)} — $${fmtPrice(f.top)}`}
                color={f.type === 'bullish' ? 'green' : 'red'}
                badge="未填補"
              />
            ))}
            {nearSR.map((l, i) => (
              <LevelRow
                key={`sr-${i}`}
                label={l.type === 'support' ? '支撐位' : '阻力位'}
                range={`$${fmtPrice(l.price)}`}
                color={l.type === 'support' ? 'green' : 'red'}
                badge={`觸碰 ${l.touchCount} 次`}
              />
            ))}
          </Section>
        )}

        {/* ── All SR Levels ── */}
        {srLevels.length > 0 && (
          <Section title="支撐 / 阻力位">
            <div className="space-y-1.5">
              {srLevels.slice(0, 6).map((l, i) => {
                const dist = currentPrice
                  ? ((l.price - currentPrice) / currentPrice) * 100
                  : 0;
                return (
                  <div key={i} className="flex items-center justify-between bg-[#1A1A26] rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${l.type === 'support' ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="text-[#EAEAF4] text-xs font-mono font-semibold">
                        ${fmtPrice(l.price)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[#606080] text-[10px]">觸碰 {l.touchCount}×</span>
                      <span className={`text-[10px] font-semibold ${dist > 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {dist > 0 ? '+' : ''}{dist.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── Order Blocks ── */}
        {orderBlocks.length > 0 && (
          <Section title="訂單塊 (Order Blocks)">
            <div className="space-y-1.5">
              {orderBlocks.map((ob, i) => (
                <div key={i} className={`flex items-center justify-between rounded-xl px-3 py-2 ${ob.type === 'bullish' ? 'bg-green-400/5 border border-green-400/20' : 'bg-red-400/5 border border-red-400/20'}`}>
                  <div>
                    <p className={`text-xs font-semibold ${ob.type === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>
                      {ob.type === 'bullish' ? '看漲 OB' : '看跌 OB'} · 強度 {ob.strength}/5
                    </p>
                    <p className="text-[#606080] text-[10px] font-mono mt-0.5">
                      ${fmtPrice(ob.low)} — ${fmtPrice(ob.high)}
                    </p>
                  </div>
                  <span className="text-[#606080] text-[10px]">
                    {new Date(ob.time).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Trading Signals ── */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[#EAEAF4] font-bold text-sm">
            交易信號 {coin?.signals.length ? `(${coin.signals.length})` : ''}
          </h3>
          {coin?.signals.length ? (
            <span className="text-[#606080] text-xs">{tf} 週期</span>
          ) : null}
        </div>

        {loading && !coin?.signals.length ? (
          <div className="space-y-3">
            {[1, 2].map((k) => (
              <div key={k} className="card h-32 animate-pulse bg-[#12121A]" />
            ))}
          </div>
        ) : coin?.signals.length ? (
          coin.signals.map((s) => <SignalCard key={s.id} signal={s} />)
        ) : (
          !loading && (
            <div className="card text-center py-8">
              <p className="text-2xl mb-2">🔍</p>
              <p className="text-[#A0A0C0] font-semibold text-sm">此時間週期暫無符合條件的信號</p>
              <p className="text-[#606080] text-xs mt-1">需要：得分 ≥7 且風險回報比 ≥1.5:1</p>
            </div>
          )
        )}

        <div className="h-6" />
      </div>
    </div>
  );
}

// ── Sub-components ──

function Section({
  title,
  loading,
  children,
}: {
  title: string;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="card mb-4">
      <h3 className="text-[#EAEAF4] font-bold text-sm mb-3">{title}</h3>
      {loading ? (
        <div className="h-20 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

type ColorType = 'green' | 'red' | 'neutral';
const colorMap: Record<ColorType, string> = {
  green: 'text-green-400',
  red: 'text-red-400',
  neutral: 'text-[#EAEAF4]',
};

function IndBox({
  label,
  value,
  color,
  tag,
}: {
  label: string;
  value: string;
  color: ColorType;
  tag?: string;
}) {
  return (
    <div className="bg-[#1A1A26] rounded-xl p-2.5">
      <p className="text-[#606080] text-[9px] mb-1 truncate">{label}</p>
      <p className={`${colorMap[color]} font-bold text-xs truncate`}>{value}</p>
      {tag && <p className={`${colorMap[color]} text-[9px] mt-0.5 opacity-75`}>{tag}</p>}
    </div>
  );
}

function LevelRow({
  label,
  range,
  color,
  badge,
}: {
  label: string;
  range: string;
  color: 'green' | 'red';
  badge: string;
}) {
  const c = color === 'green' ? 'text-green-400' : 'text-red-400';
  const bg = color === 'green' ? 'bg-green-400/10' : 'bg-red-400/10';
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1E1E2E] last:border-0">
      <div>
        <p className={`${c} text-xs font-semibold`}>{label}</p>
        <p className="text-[#EAEAF4] text-xs font-mono mt-0.5">{range}</p>
      </div>
      <span className={`${bg} ${c} text-[10px] font-semibold px-2 py-0.5 rounded-full`}>
        {badge}
      </span>
    </div>
  );
}

function fmtPrice(p: number): string {
  if (!p) return '---';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

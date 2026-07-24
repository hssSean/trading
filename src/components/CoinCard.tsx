'use client';
import Link from 'next/link';
import { useStore } from '@/store/useStore';
import { WatchedCoin } from '@/types';

const STRENGTH_RANK: Record<string, number> = { WEAK: 0, MODERATE: 1, STRONG: 2 };

export function CoinCard({ coin }: { coin: WatchedCoin }) {
  const isUp        = (coin.priceChangePercent24h ?? 0) >= 0;
  const minStrength = useStore((s) => s.settings.minSignalStrength);
  const filtered    = coin.signals.filter((s) => STRENGTH_RANK[s.strength] >= STRENGTH_RANK[minStrength]);
  const latest      = filtered[0];
  const unread      = filtered.filter((s) => !s.isRead).length;
  const openTrade   = useStore((s) => s.trades.find((t) => t.symbol === coin.symbol && !t.result));
  const activeTrade = !!openTrade;

  // Live PnL for open trade
  const livePnl = openTrade && coin.currentPrice > 0
    ? openTrade.direction === 'LONG'
      ? (coin.currentPrice - openTrade.entry) / openTrade.entry * 100
      : (openTrade.entry - coin.currentPrice) / openTrade.entry * 100
    : null;

  return (
    <Link href={`/analysis/${coin.symbol}`} className="block card-hover mb-2.5">
      {/* Top row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-[#1A2029] border border-[#222A35] flex items-center justify-center shrink-0">
            <span className="text-[#97A2B0] text-[11px] font-medium num">{coin.baseAsset.slice(0, 3)}</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-[#EAEDF2] font-medium text-[15px]">{coin.displayName}</p>
              {activeTrade && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md border border-[#2DD4BF]/40 text-[#2DD4BF]">持倉中</span>
              )}
              {livePnl !== null && (
                <span className={`text-[10px] font-medium num ${livePnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                  {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                </span>
              )}
            </div>
            <p className="text-[#59616E] text-xs mt-0.5">{coin.timeframes.join(' · ')}</p>
          </div>
        </div>

        <div className="text-right shrink-0">
          {coin.isLoading ? (
            <div className="w-16 h-4 bg-[#1A2029] rounded animate-pulse ml-auto" />
          ) : (
            <>
              <p className="text-[#EAEDF2] text-[15px] num">{fmtPrice(coin.currentPrice)}</p>
              <p className={`text-sm mt-0.5 num ${isUp ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                {isUp ? '+' : ''}{(coin.priceChangePercent24h ?? 0).toFixed(2)}%
              </p>
            </>
          )}
        </div>
      </div>

      {/* Signal row */}
      {latest ? (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#1B2129]">
          <span className={latest.direction === 'LONG' ? 'badge-long' : 'badge-short'}>
            {latest.direction === 'LONG' ? '做多' : '做空'}
          </span>
          <span className="text-[#59616E] text-xs flex-1 truncate num">
            入場 {fmtPrice(latest.entry)} · {latest.timeframe} · RR {latest.riskReward}
          </span>
          {unread > 0 && (
            <span className="bg-[#2DD4BF] text-[#08110F] text-[10px] font-medium rounded-full px-1.5 py-0.5 num">
              {unread}
            </span>
          )}
        </div>
      ) : (
        !coin.isLoading && (
          <p className="text-[#59616E] text-xs mt-3 pt-3 border-t border-[#1B2129] text-center">暫無信號 · 點擊分析</p>
        )
      )}
    </Link>
  );
}

function fmtPrice(p: number) {
  if (!p) return '—';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

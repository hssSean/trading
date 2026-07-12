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
    <Link href={`/analysis/${coin.symbol}`} className="block card-hover mb-3">
      {/* Top row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-yellow-400/10 flex items-center justify-center">
            <span className="text-[#F0B90B] text-xs font-bold">{coin.baseAsset.slice(0, 3)}</span>
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[#EAEAF4] font-bold text-base">{coin.displayName}</p>
              {activeTrade && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#F0B90B]/20 text-[#F0B90B]">持倉中</span>
              )}
              {livePnl !== null && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                  livePnl >= 0 ? 'bg-green-400/15 text-green-400' : 'bg-red-400/15 text-red-400'
                }`}>
                  {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
                </span>
              )}
            </div>
            <p className="text-[#606080] text-xs mt-0.5">{coin.timeframes.join(' · ')}</p>
          </div>
        </div>

        <div className="text-right">
          {coin.isLoading ? (
            <div className="w-16 h-4 bg-[#1A1A26] rounded animate-pulse" />
          ) : (
            <>
              <p className="text-[#EAEAF4] font-semibold text-base">${fmtPrice(coin.currentPrice)}</p>
              <p className={`text-sm font-medium mt-0.5 ${isUp ? 'text-green-400' : 'text-red-400'}`}>
                {isUp ? '+' : ''}{(coin.priceChangePercent24h ?? 0).toFixed(2)}%
              </p>
            </>
          )}
        </div>
      </div>

      {/* Signal row */}
      {latest ? (
        <div className="flex items-center gap-2 mt-3">
          <span className={latest.direction === 'LONG' ? 'badge-long' : 'badge-short'}>
            {latest.direction === 'LONG' ? '做多 ▲' : '做空 ▼'}
          </span>
          <span className="text-[#606080] text-xs flex-1 truncate">
            入場 ${fmtPrice(latest.entry)} · {latest.timeframe} · RR {latest.riskReward}:1
          </span>
          {unread > 0 && (
            <span className="bg-[#F0B90B] text-[#0A0A0F] text-[10px] font-bold rounded-full px-1.5 py-0.5">
              {unread}
            </span>
          )}
        </div>
      ) : (
        !coin.isLoading && (
          <p className="text-[#606080] text-xs mt-3 text-center">暫無信號 — 點擊立即分析</p>
        )
      )}
    </Link>
  );
}

function fmtPrice(p: number) {
  if (!p) return '---';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

'use client';
import Link from 'next/link';
import { useStore } from '@/store/useStore';
import { WatchedCoin } from '@/types';

export function CoinCard({ coin }: { coin: WatchedCoin }) {
  const isUp        = coin.priceChangePercent24h >= 0;
  const latest      = coin.signals[0];
  const unread      = coin.signals.filter((s) => !s.isRead).length;
  const activeTrade = useStore((s) => s.trades.some((t) => t.symbol === coin.symbol && !t.result));

  return (
    <Link href={`/analysis/${coin.symbol}`} className="block card-hover mb-3">
      {/* Top row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-yellow-400/10 flex items-center justify-center">
            <span className="text-[#F0B90B] text-xs font-bold">{coin.baseAsset.slice(0, 3)}</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[#EAEAF4] font-bold text-base">{coin.displayName}</p>
              {activeTrade && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#F0B90B]/20 text-[#F0B90B]">持倉中</span>
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
                {isUp ? '+' : ''}{coin.priceChangePercent24h.toFixed(2)}%
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

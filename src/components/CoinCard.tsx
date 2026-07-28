'use client';
import Link from 'next/link';
import { useStore } from '@/store/useStore';
import { useTick } from '@/store/usePriceStore';
import { WatchedCoin } from '@/types';

const STRENGTH_RANK: Record<string, number> = { WEAK: 0, MODERATE: 1, STRONG: 2 };

// Dense terminal data row (replaces the old rounded card). One coin per line,
// hairline-divided; numbers right-aligned and monospace.
export function CoinCard({ coin }: { coin: WatchedCoin }) {
  // Subscribes to this symbol only, so a price move on another coin doesn't
  // re-render this row.
  const tick        = useTick(coin.symbol);
  const isUp        = tick.changePct24h >= 0;
  const minStrength = useStore((s) => s.settings.minSignalStrength);
  const filtered    = coin.signals.filter((s) => STRENGTH_RANK[s.strength] >= STRENGTH_RANK[minStrength]);
  const latest      = filtered[0];
  const unread      = filtered.filter((s) => !s.isRead).length;
  const openTrade   = useStore((s) => s.trades.find((t) => t.symbol === coin.symbol && !t.result));
  const activeTrade = !!openTrade;

  const livePnl = openTrade && tick.price > 0
    ? openTrade.direction === 'LONG'
      ? (tick.price - openTrade.entry) / openTrade.entry * 100
      : (openTrade.entry - tick.price) / openTrade.entry * 100
    : null;

  return (
    <Link
      href={`/analysis/${coin.symbol}`}
      className="flex items-center px-3 py-2.5 border-b border-[#141A21] active:bg-[#12181F]"
    >
      {/* Symbol + timeframe */}
      <div className="w-[96px] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[#E8ECF1] text-[13px] num">{coin.baseAsset}</span>
          {activeTrade && <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] shrink-0" />}
        </div>
        <div className="text-[#565E6B] text-[10px] mt-0.5 truncate">{coin.timeframes.join(' · ')}</div>
      </div>

      {/* Price + 24h change */}
      <div className="flex-1 text-right">
        {coin.isLoading ? (
          <div className="w-16 h-3.5 bg-[#141A21] rounded animate-pulse ml-auto" />
        ) : (
          <>
            <div className="text-[#E8ECF1] text-[13px] num">{fmtPrice(tick.price)}</div>
            <div className={`text-[11px] num ${isUp ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
              {isUp ? '+' : ''}{tick.changePct24h.toFixed(2)}%
            </div>
          </>
        )}
      </div>

      {/* Signal / live position */}
      <div className="w-[76px] text-right shrink-0">
        {activeTrade && livePnl !== null ? (
          <>
            <div className={`text-[12px] num ${livePnl >= 0 ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
              {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
            </div>
            <div className="text-[#565E6B] text-[10px]">持倉</div>
          </>
        ) : latest ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className={latest.direction === 'LONG' ? 'text-[#0ECB81] text-[11px]' : 'text-[#F6465D] text-[11px]'}>
              {latest.direction === 'LONG' ? '做多' : '做空'}
            </span>
            <span className="text-[#2DD4BF] text-[12px] num">{latest.score}</span>
            {unread > 0 && <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF]" />}
          </div>
        ) : (
          <span className="text-[#565E6B] text-[12px]">—</span>
        )}
      </div>
    </Link>
  );
}

function fmtPrice(p: number) {
  if (!p) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

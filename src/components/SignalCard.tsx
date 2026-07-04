'use client';
import { useState } from 'react';
import { TradingSignal } from '@/types';
import { useStore } from '@/store/useStore';
import { formatDistanceToNow } from 'date-fns';
import { zhTW } from 'date-fns/locale';

interface Props {
  signal: TradingSignal;
  onClick?: () => void;
  compact?: boolean;
}

export function SignalCard({ signal, onClick, compact }: Props) {
  const isLong    = signal.direction === 'LONG';
  const tp1       = signal.takeProfits?.[0];
  const tp2       = signal.takeProfits?.[1];
  const addTrade   = useStore((s) => s.addTrade);
  const hasTrade   = useStore((s) => s.trades.some((t) => t.symbol === signal.symbol && !t.result));
  const justAdded  = useStore((s) => s.trades.some((t) => t.signalId === signal.id));
  const accountSize = useStore((s) => s.settings.accountSize);
  const [flash, setFlash] = useState(false);

  // Position sizing: 1% risk rule
  const stopDistPct   = Math.abs(signal.entry - signal.stopLoss) / signal.entry;
  const riskUSDT      = accountSize * 0.01;
  const positionUSDT  = stopDistPct > 0 ? Math.round(riskUSDT / stopDistPct) : 0;
  const isHighVol     = signal.reasons.some((r) => r.startsWith('⚠ 高波動'));
  const sp            = signal.signalPrice ?? 0;
  const isLimit       = sp > 0 && Math.abs(signal.entry - sp) / sp > 0.003;
  const isIntraday    = signal.timeframe === '5m' || signal.timeframe === '15m';

  const handleAddTrade = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasTrade || justAdded) return;
    addTrade(signal);
    setFlash(true);
    setTimeout(() => setFlash(false), 2000);
  };

  const strengthColor =
    signal.strength === 'STRONG'
      ? 'text-green-400'
      : signal.strength === 'MODERATE'
      ? 'text-yellow-400'
      : 'text-[#606080]';

  const strengthLabel =
    signal.strength === 'STRONG' ? '強 ★★★' : signal.strength === 'MODERATE' ? '中 ★★' : '弱 ★';

  let timeAgo = '';
  try {
    timeAgo = formatDistanceToNow(signal.timestamp, { locale: zhTW, addSuffix: true });
  } catch {
    timeAgo = new Date(signal.timestamp).toLocaleString('zh-TW');
  }

  return (
    <div
      onClick={onClick}
      className={`card mb-3 ${onClick ? 'cursor-pointer active:scale-[0.98] transition-transform' : ''} ${!signal.isRead ? 'border-[#F0B90B]' : ''}`}
    >
      {/* ── Header row ── */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={isLong ? 'badge-long' : 'badge-short'}>
            {isLong ? '做多 ▲' : '做空 ▼'}
          </span>
          <span className="text-[#EAEAF4] font-bold text-sm">
            {signal.symbol.replace('USDT', '/USDT')}
          </span>
          <span className="badge-tf">{signal.timeframe}</span>
          {isIntraday && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/30 font-semibold">日內</span>}
          {isLimit    && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 font-semibold">限價</span>}
          {!signal.isRead && (
            <span className="w-2 h-2 rounded-full bg-[#F0B90B] animate-pulse" />
          )}
        </div>
        <div className="text-right shrink-0 ml-2">
          <p className={`text-xs font-semibold ${strengthColor}`}>{strengthLabel}</p>
          <p className="text-[#606080] text-[10px] mt-0.5">{timeAgo}</p>
        </div>
      </div>

      {/* ── Price grid ── */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <PriceBox label="📌 入場價" value={tp1 ? signal.entry : null} highlight={signal.entry} color="blue" />
        <PriceBox label="🛑 止損 SL" value={signal.stopLoss} color="red" />
        {tp1 && <PriceBox label="🎯 止盈 TP1" value={tp1} color="green" />}
        {tp2 && <PriceBox label="🎯 止盈 TP2" value={tp2} color="green" dim />}
      </div>

      {/* ── Stats row ── */}
      <div className="flex gap-2 mb-3">
        <StatChip label="風報比" value={`${signal.riskReward}:1`} />
        <StatChip label="得分" value={`${signal.score}pt`} />
        {tp1 && (
          <StatChip
            label="TP1 幅度"
            value={`+${(Math.abs(tp1 - signal.entry) / signal.entry * 100).toFixed(1)}%`}
            color="#00C851"
          />
        )}
        <StatChip
          label="SL 距離"
          value={`-${(Math.abs(signal.stopLoss - signal.entry) / signal.entry * 100).toFixed(1)}%`}
          color="#FF4444"
        />
      </div>

      {/* ── Position size + volatility ── */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 bg-[#1A1A26] rounded-xl px-3 py-2">
          <p className="text-[#606080] text-[9px]">建議倉位（1% 風險）</p>
          <p className="text-[#EAEAF4] font-bold text-xs mt-0.5">
            {positionUSDT > 0 ? `$${positionUSDT.toLocaleString()} USDT` : '—'}
            <span className="text-[#404060] font-normal ml-1">（虧損上限 ${riskUSDT.toFixed(0)}）</span>
          </p>
        </div>
        {isHighVol && (
          <span className="text-xs font-semibold px-2 py-1 rounded-xl bg-orange-500/20 text-orange-400 border border-orange-500/30 shrink-0">
            高波動
          </span>
        )}
      </div>

      {/* ── Reasons ── */}
      {!compact && signal.reasons.length > 0 && (
        <div className="pt-2 border-t border-[#1E1E2E]">
          <p className="text-[#606080] text-[10px] mb-1.5 font-semibold uppercase tracking-wide">分析依據</p>
          <div className="space-y-1">
            {signal.reasons.slice(0, 5).map((r, i) => (
              <p key={i} className="text-[#A0A0C0] text-xs">• {r}</p>
            ))}
          </div>
        </div>
      )}

      {/* ── Add to Journal button ── */}
      {!compact && (
        <div className="pt-2 mt-2 border-t border-[#1E1E2E]">
          <button
            onClick={handleAddTrade}
            disabled={hasTrade || justAdded}
            className={`w-full py-2 rounded-xl text-xs font-semibold transition-colors ${
              flash
                ? 'bg-green-400/20 text-green-400 border border-green-400/40'
                : justAdded || hasTrade
                ? 'bg-[#1A1A26] text-[#404060] border border-[#1E1E2E] cursor-not-allowed'
                : 'bg-[#F0B90B]/10 text-[#F0B90B] border border-[#F0B90B]/30 active:opacity-70'
            }`}
          >
            {flash ? '✓ 已加入交易紀錄' : justAdded ? '已在紀錄中' : hasTrade ? `${signal.symbol.replace('USDT', '')} 已有持倉中` : '+ 加入交易紀錄'}
          </button>
        </div>
      )}
    </div>
  );
}

function PriceBox({
  label,
  value,
  highlight,
  color,
  dim,
}: {
  label: string;
  value: number | null | undefined;
  highlight?: number;
  color: 'blue' | 'green' | 'red';
  dim?: boolean;
}) {
  const colorClass = {
    blue: 'text-blue-400',
    green: dim ? 'text-green-400/60' : 'text-green-400',
    red: 'text-red-400',
  }[color];

  const displayValue = value ?? highlight;
  return (
    <div className="bg-[#1A1A26] rounded-xl p-3">
      <p className="text-[#606080] text-[10px] mb-1">{label}</p>
      <p className={`${colorClass} font-bold text-sm font-mono`}>
        {displayValue != null ? `$${fmtPrice(displayValue)}` : '---'}
      </p>
    </div>
  );
}

function StatChip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex-1 bg-[#1A1A26] rounded-xl px-2 py-2 text-center min-w-0">
      <p className="text-[#606080] text-[9px] truncate">{label}</p>
      <p className="font-bold text-xs mt-0.5" style={{ color: color ?? '#F0B90B' }}>{value}</p>
    </div>
  );
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

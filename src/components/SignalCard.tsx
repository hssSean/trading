'use client';
import { useState } from 'react';
import { TradingSignal } from '@/types';
import { useStore } from '@/store/useStore';
import { calcPositionPlan, tierRiskMultiplier } from '@/lib/position';
import { loadFromSupabase } from '@/components/StoreHydration';
import { formatDistanceToNow } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { TradeCard } from '@/components/ui/TradeCard';
import { PillBadge } from '@/components/ui/PillBadge';
import { StatChip } from '@/components/ui/StatChip';
import { Wallet, Layers, ShieldAlert } from 'lucide-react';

interface Props {
  signal: TradingSignal;
  onClick?: () => void;
  compact?: boolean;
}

export function SignalCard({ signal, onClick, compact }: Props) {
  const isLong    = signal.direction === 'LONG';
  const tp1       = signal.takeProfits?.[0];
  const tp2       = signal.takeProfits?.[1];
  const userId      = useStore((s) => s.userId);
  const hasTrade    = useStore((s) => s.trades.some((t) => t.symbol === signal.symbol && !t.result));
  const justAdded   = useStore((s) => s.trades.some((t) => t.signalId === signal.id));
  const accountSize = useStore((s) => s.settings.accountSize);
  const riskPct     = useStore((s) => s.settings.riskPctPerTrade ?? 1);
  const [flash, setFlash]     = useState(false);
  const [syncing, setSyncing] = useState(false);

  const effRisk = riskPct * tierRiskMultiplier(signal.symbol, signal.tier);
  const plan    = calcPositionPlan(accountSize, effRisk, signal.entry, signal.stopLoss, signal.tier === 'B' ? 5 : 10);
  const isHighVol  = signal.reasons.some((r) => r.startsWith('⚠ 高波動'));
  const sp         = signal.signalPrice ?? 0;
  const isLimit    = sp > 0 && Math.abs(signal.entry - sp) / sp > 0.003;
  const isIntraday = signal.timeframe === '5m' || signal.timeframe === '15m';

  // 伺服器在訊號產生的同一個請求裡就已經自動入帳（見 route.ts Step 1），所以這裡從來
  // 不需要、也不該在本地捏造一張新的交易列——那只會製造一張沒有 status/signal_price
  // 的殭屍單（見 待修改事項.md P1-3）。按鈕只負責「現在就去把伺服器那張正牌的單拉下來」，
  // 補上本地尚未同步到的空窗（通常 2 分鐘內的定期同步就會自動補上）。
  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasTrade || justAdded || syncing || !userId) return;
    setSyncing(true);
    try {
      await loadFromSupabase(userId);
      setFlash(true);
      setTimeout(() => setFlash(false), 2000);
    } finally {
      setSyncing(false);
    }
  };

  let timeAgo = '';
  try {
    timeAgo = formatDistanceToNow(signal.timestamp, { locale: zhTW, addSuffix: true });
  } catch {
    timeAgo = new Date(signal.timestamp).toLocaleString('zh-TW');
  }

  const tp1Pct = tp1 != null ? (Math.abs(tp1 - signal.entry) / signal.entry * 100) : null;
  const slPct  = Math.abs(signal.stopLoss - signal.entry) / signal.entry * 100;

  return (
    <TradeCard
      variant="active"
      onClick={onClick}
      className={`${onClick ? 'cursor-pointer' : ''} ${!signal.isRead ? '!border-accent/45' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-3">
        <div
          className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[12px] font-medium"
          style={{
            background: `${isLong ? '#1D9E75' : '#E24B4A'}24`,
            color: isLong ? '#5DCAA5' : '#F09595',
          }}
        >
          {signal.symbol.replace('USDT', '').slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[14px] font-medium text-text-p">
              {signal.symbol.replace('USDT', '')}/USDT
            </span>
            {!signal.isRead && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
          </div>
          <div className="text-[11px] text-text-s flex items-center gap-1.5 flex-wrap mt-0.5">
            <span>{signal.timeframe} · {isLong ? '做多' : '做空'}</span>
            {isIntraday && <PillBadge label="日內" color="#2DD4BF" />}
            {isLimit    && <PillBadge label="限價" color="#8A94A2" />}
            {isHighVol  && <PillBadge label="高波動" color="#E6AF5A" />}
          </div>
        </div>
        <span className="text-accent text-[14px] num shrink-0">{signal.score}</span>
      </div>

      {/* Price grid 2x2 */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mb-3">
        <Row label="ENTRY" value={signal.entry}    colorClass="text-text-p" />
        <Row label="STOP"  value={signal.stopLoss} colorClass="text-down" />
        {tp1 != null && <Row label="TP1" value={tp1} colorClass="text-up" />}
        {tp2 != null && <Row label="TP2" value={tp2} colorClass="text-up" />}
      </div>

      {/* RR / TP1% / SL% */}
      <div className="text-[11px] text-text-s num mb-3">
        <span>RR 1:{signal.riskReward}</span>
        {tp1Pct != null && <span className="text-up"> · TP1 +{tp1Pct.toFixed(1)}%</span>}
        <span className="text-down"> · SL −{slPct.toFixed(1)}%</span>
      </div>

      {/* Position sizing */}
      {plan && (
        <div className="mb-3">
          <p className="tlabel mb-1.5">倉位計算（{effRisk}% 風險）</p>
          <div className="grid grid-cols-3 gap-2">
            <StatChip icon={<Wallet className="w-4 h-4" />} label="建議倉位" value={`${plan.positionUSDT}U`} />
            <StatChip icon={<Layers className="w-4 h-4" />} label="本金×槓桿" value={`${plan.marginUSDT}U×${plan.leverage}`} />
            <StatChip icon={<ShieldAlert className="w-4 h-4" />} label="止損虧損" value={`${plan.riskUSDT}U`} />
          </div>
          {plan.belowMinNotional && (
            <p className="text-[#E6AF5A] text-[10px] mt-1.5">低於交易所最低下單額 5U</p>
          )}
        </div>
      )}

      {/* Reasons */}
      {!compact && signal.reasons.length > 0 && (
        <div className="mb-3 border-t border-white/[0.06] pt-2.5 space-y-0.5">
          {signal.reasons.slice(0, 5).map((r, i) => (
            <p key={i} className="text-text-s text-[11px] leading-relaxed">› {r}</p>
          ))}
        </div>
      )}

      {/* Time + sync */}
      {!compact && (
        <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <span className="text-text-m text-[10px]">{timeAgo}</span>
          <button
            onClick={handleSync}
            disabled={hasTrade || justAdded || syncing}
            className={`text-[11px] font-medium px-3.5 py-1.5 rounded-full transition-colors ${
              flash
                ? 'border border-up/45 text-up'
                : justAdded || hasTrade
                ? 'border border-white/[0.08] text-text-m cursor-not-allowed'
                : 'bg-accent text-[#0A0D11] active:opacity-80'
            }`}
          >
            {flash ? '✓ 已同步' : justAdded ? '已在紀錄' : hasTrade ? '已持倉' : syncing ? '同步中…' : '同步 ▸'}
          </button>
        </div>
      )}
    </TradeCard>
  );
}

function Row({ label, value, colorClass }: { label: string; value: number; colorClass: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-dotted border-white/[0.08] pb-1">
      <span className="tlabel">{label}</span>
      <span className={`text-[13px] num ${colorClass}`}>{fmtPrice(value)}</span>
    </div>
  );
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

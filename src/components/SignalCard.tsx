'use client';
import { useState } from 'react';
import { TrendingUp, TrendingDown, Check, Plus } from 'lucide-react';
import { TradingSignal } from '@/types';
import { useStore } from '@/store/useStore';
import { calcPositionPlan } from '@/lib/position';
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
  const addTrade    = useStore((s) => s.addTrade);
  const hasTrade    = useStore((s) => s.trades.some((t) => t.symbol === signal.symbol && !t.result));
  const justAdded   = useStore((s) => s.trades.some((t) => t.signalId === signal.id));
  const accountSize = useStore((s) => s.settings.accountSize);
  const riskPct     = useStore((s) => s.settings.riskPctPerTrade ?? 1);
  const [flash, setFlash] = useState(false);

  // Position sizing: user risk% (tier B halved, leverage ≤5x)
  const effRisk = riskPct * (signal.tier === 'B' ? 0.5 : 1);
  const plan    = calcPositionPlan(accountSize, effRisk, signal.entry, signal.stopLoss, signal.tier === 'B' ? 5 : 10);
  const isHighVol  = signal.reasons.some((r) => r.startsWith('⚠ 高波動'));
  const sp         = signal.signalPrice ?? 0;
  const isLimit    = sp > 0 && Math.abs(signal.entry - sp) / sp > 0.003;
  const isIntraday = signal.timeframe === '5m' || signal.timeframe === '15m';

  const handleAddTrade = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasTrade || justAdded) return;
    addTrade(signal);
    setFlash(true);
    setTimeout(() => setFlash(false), 2000);
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
    <div
      onClick={onClick}
      className={`card mb-2.5 ${onClick ? 'cursor-pointer active:scale-[0.99] transition-transform' : ''} ${!signal.isRead ? 'border-[#2DD4BF]/50' : ''}`}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[#EAEDF2] font-medium text-[15px]">
          {signal.symbol.replace('USDT', '')}<span className="text-[#59616E]">/USDT</span>
        </span>
        <span className={`${isLong ? 'badge-long' : 'badge-short'} inline-flex items-center gap-1`}>
          {isLong ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{isLong ? '做多' : '做空'}
        </span>
        <span className="badge-tf num">{signal.timeframe}</span>
        {isIntraday && <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-[#2DD4BF]/30 text-[#2DD4BF]">日內</span>}
        {isLimit    && <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-[#222A35] text-[#97A2B0]">限價</span>}
        {isHighVol  && <span className="text-[10px] px-1.5 py-0.5 rounded-md border border-[#2A323D] text-[#97A2B0]">高波動</span>}
        <span className="flex-1" />
        <span className="text-[#59616E] text-[11px]">評分</span>
        <span className="text-[#2DD4BF] text-[15px] font-medium num">{signal.score}</span>
      </div>

      {/* ── Price grid 2×2 (hairline-divided, mono) ── */}
      <div className="grid grid-cols-2 gap-px mt-3 bg-[#1B2129] border border-[#1B2129] rounded-lg overflow-hidden">
        <PriceCell label="進場" value={signal.entry} color="#EAEDF2" />
        <PriceCell label="止損" value={signal.stopLoss} color="#F6465D" />
        {tp1 != null && <PriceCell label="TP1" value={tp1} color="#0ECB81" />}
        {tp2 != null && <PriceCell label="TP2" value={tp2} color="#0ECB81" />}
      </div>

      {/* ── Stats line ── */}
      <div className="flex items-center gap-2 mt-2.5 text-[12px] text-[#97A2B0]">
        <span className="num">RR 1:{signal.riskReward}</span>
        <span className="w-px h-3 bg-[#2A323D]" />
        {tp1Pct != null && <span className="text-[#0ECB81] num">TP1 +{tp1Pct.toFixed(1)}%</span>}
        <span className="text-[#F6465D] num">SL −{slPct.toFixed(1)}%</span>
        <span className="flex-1" />
        <span className="text-[#59616E] text-[11px]">{timeAgo}</span>
      </div>

      {/* ── Position size ── */}
      <div className="mt-2.5 bg-[#12161C] border border-[#222A35] rounded-lg px-3 py-2">
        <p className="text-[#59616E] text-[11px]">建議倉位 · {effRisk}% 風險</p>
        <p className="text-[#EAEDF2] text-[13px] mt-0.5 num">
          {plan ? (
            <>
              {plan.positionUSDT} USDT
              <span className="text-[#2DD4BF] ml-1.5">本金 {plan.marginUSDT}U ×{plan.leverage}</span>
              <span className="text-[#59616E] ml-1.5">上限虧 {plan.riskUSDT}U</span>
            </>
          ) : '—'}
        </p>
        {plan?.belowMinNotional && (
          <p className="text-[#F6465D] text-[11px] mt-1 opacity-80">低於交易所最低下單額 5U，可能無法開單</p>
        )}
      </div>

      {/* ── Reasons ── */}
      {!compact && signal.reasons.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[#1B2129]">
          <p className="text-[#59616E] text-[11px] mb-1.5">分析依據</p>
          <div className="space-y-1">
            {signal.reasons.slice(0, 5).map((r, i) => (
              <p key={i} className="text-[#97A2B0] text-xs leading-relaxed">{r}</p>
            ))}
          </div>
        </div>
      )}

      {/* ── Add to journal ── */}
      {!compact && (
        <button
          onClick={handleAddTrade}
          disabled={hasTrade || justAdded}
          className={`w-full mt-3 py-2 rounded-lg text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors ${
            flash
              ? 'bg-[#0ECB81]/15 text-[#0ECB81] border border-[#0ECB81]/40'
              : justAdded || hasTrade
              ? 'bg-[#12161C] text-[#59616E] border border-[#222A35] cursor-not-allowed'
              : 'bg-[#2DD4BF] text-[#08110F] active:opacity-80'
          }`}
        >
          {flash
            ? <><Check size={14} /> 已加入紀錄</>
            : justAdded ? '已在紀錄中'
            : hasTrade ? `${signal.symbol.replace('USDT', '')} 已持倉`
            : <><Plus size={14} /> 加入交易紀錄</>}
        </button>
      )}
    </div>
  );
}

function PriceCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-[#12161C] px-3 py-2">
      <div className="text-[#59616E] text-[11px]">{label}</div>
      <div className="text-[14px] mt-0.5 num" style={{ color }}>{fmtPrice(value)}</div>
    </div>
  );
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

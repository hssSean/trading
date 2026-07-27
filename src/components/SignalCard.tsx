'use client';
import { useState } from 'react';
import { TradingSignal } from '@/types';
import { useStore } from '@/store/useStore';
import { calcPositionPlan, tierRiskMultiplier } from '@/lib/position';
import { loadFromSupabase } from '@/components/StoreHydration';
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
    <div
      onClick={onClick}
      className={`mb-2.5 bg-[#0F141A] border rounded-md p-3 ${onClick ? 'cursor-pointer active:bg-[#12181F]' : ''} ${!signal.isRead ? 'border-[#2DD4BF]/45' : 'border-[#1B222B]'}`}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2 flex-wrap text-[13px]">
        <span className="text-[#E8ECF1] num">
          {signal.symbol.replace('USDT', '')}<span className="text-[#565E6B]">USDT</span>
        </span>
        <span className={isLong ? 'text-[#0ECB81] text-[12px]' : 'text-[#F6465D] text-[12px]'}>
          {isLong ? 'LONG' : 'SHORT'}
        </span>
        <span className="text-[#565E6B] text-[11px] num">{signal.timeframe}</span>
        {isIntraday && <Tag text="日內" accent />}
        {isLimit    && <Tag text="限價" />}
        {isHighVol  && <Tag text="高波動" />}
        {!signal.isRead && <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] animate-pulse" />}
        <span className="flex-1" />
        <span className="tlabel">評分</span>
        <span className="text-[#2DD4BF] text-[14px] num">{signal.score}</span>
      </div>

      {/* ── Price grid 2×2 (dotted rows, mono) ── */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mt-3">
        <Row label="ENTRY" value={signal.entry} color="#E8ECF1" />
        <Row label="STOP" value={signal.stopLoss} color="#F6465D" />
        {tp1 != null && <Row label="TP1" value={tp1} color="#0ECB81" />}
        {tp2 != null && <Row label="TP2" value={tp2} color="#0ECB81" />}
      </div>

      {/* ── Stats + position ── */}
      <div className="mt-3 text-[11px] text-[#565E6B] num leading-relaxed">
        <span>RR 1:{signal.riskReward}</span>
        {tp1Pct != null && <span className="text-[#0ECB81]"> · TP1 +{tp1Pct.toFixed(1)}%</span>}
        <span className="text-[#F6465D]"> · SL −{slPct.toFixed(1)}%</span>
        {plan && (
          <div className="text-[#8A94A2] mt-0.5">
            倉位 {plan.positionUSDT}U · 本金 {plan.marginUSDT}U ×{plan.leverage} · 上限虧 {plan.riskUSDT}U（{effRisk}%）
            {plan.belowMinNotional && <span className="text-[#F6465D]"> · 低於最低下單 5U</span>}
          </div>
        )}
      </div>

      {/* ── Reasons ── */}
      {!compact && signal.reasons.length > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-[#1B222B] space-y-0.5">
          {signal.reasons.slice(0, 5).map((r, i) => (
            <p key={i} className="text-[#8A94A2] text-[11px] leading-relaxed">› {r}</p>
          ))}
        </div>
      )}

      {/* ── Time + record ── */}
      {!compact && (
        <div className="flex items-center mt-3">
          <span className="text-[#565E6B] text-[10px]">{timeAgo}</span>
          <span className="flex-1" />
          <button
            onClick={handleSync}
            disabled={hasTrade || justAdded || syncing}
            className={`text-[11px] font-medium px-3.5 py-1.5 rounded transition-colors ${
              flash
                ? 'border border-[#0ECB81]/45 text-[#0ECB81]'
                : justAdded || hasTrade
                ? 'border border-[#232B35] text-[#565E6B] cursor-not-allowed'
                : 'bg-[#2DD4BF] text-[#0A0D11] active:opacity-80'
            }`}
          >
            {flash ? '✓ 已同步' : justAdded ? '已在紀錄' : hasTrade ? '已持倉' : syncing ? '同步中…' : '同步 ▸'}
          </button>
        </div>
      )}
    </div>
  );
}

function Tag({ text, accent }: { text: string; accent?: boolean }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${accent ? 'border-[#2DD4BF]/30 text-[#2DD4BF]' : 'border-[#232B35] text-[#8A94A2]'}`}>
      {text}
    </span>
  );
}

function Row({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-dotted border-[#232B35] pb-1">
      <span className="tlabel">{label}</span>
      <span className="text-[13px] num" style={{ color }}>{fmtPrice(value)}</span>
    </div>
  );
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

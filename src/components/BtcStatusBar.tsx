'use client';
import { useEffect, useState, useCallback } from 'react';
import { TrendingUp, TrendingDown, AlertTriangle, Flame } from 'lucide-react';
import { useStore } from '@/store/useStore';

interface Scan {
  btcRegime: string;
  circuitBreaker: string | boolean | null;
  eventFilter: string | boolean | null;
  totalOpenRisk: number;
  notified: string[];
}

const BTC: Record<string, { label: string; hint: string; color: string; Icon: typeof TrendingUp }> = {
  bullish: { label: 'BTC 偏多', hint: '順勢做多優先 · 山寨空暫停', color: '#0ECB81', Icon: TrendingUp },
  bearish: { label: 'BTC 偏空', hint: '順勢做空優先 · 山寨多暫停', color: '#F6465D', Icon: TrendingDown },
  chaotic: { label: 'BTC 混沌', hint: '降級 B 級輕倉（0.5%）',      color: '#2DD4BF', Icon: AlertTriangle },
};

// Glanceable market-state strip for the home top. Reuses /api/scan-status (same source
// as ScanStatusPanel) so it answers "why no signals" at a glance: BTC bias + blockers.
export function BtcStatusBar() {
  const [scan, setScan] = useState<Scan | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const secret = useStore.getState().webhookSecret;
      const res  = await fetch('/api/scan-status', { headers: secret ? { 'x-webhook-secret': secret } : {} });
      const data = await res.json();
      if (data.scan) setScan(data.scan);
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 90 * 1000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  if (!scan) return null;

  const info    = BTC[scan.btcRegime] ?? { label: `BTC ${scan.btcRegime}`, hint: '大盤中性', color: '#97A2B0', Icon: TrendingUp };
  const blocked = !!scan.circuitBreaker || !!scan.eventFilter;
  const Icon    = info.Icon;

  return (
    <div className="mt-2 bg-[#12161C] border border-[#222A35] rounded-xl px-3 py-2.5 flex items-center gap-2.5">
      <Icon size={17} color={info.color} strokeWidth={2} />
      <span className="text-[13px] font-medium" style={{ color: info.color }}>{info.label}</span>
      <span className="text-[#3A424E]">·</span>
      <span className="text-[#97A2B0] text-[12px] truncate">{info.hint}</span>
      <span className="flex-1" />
      {blocked ? (
        <span className="inline-flex items-center gap-1 text-[#F6465D] text-[11px] font-medium border border-[#F6465D]/30 rounded-md px-1.5 py-0.5 shrink-0">
          <Flame size={12} /> {scan.circuitBreaker ? '熔斷中' : '事件窗口'}
        </span>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[#97A2B0] text-[12px] num">{scan.notified.length} 訊號</span>
          <span className="w-px h-3 bg-[#2A323D]" />
          <span className="text-[#59616E] text-[12px] num">風險 {scan.totalOpenRisk}%</span>
        </div>
      )}
    </div>
  );
}

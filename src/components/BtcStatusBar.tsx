'use client';
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '@/store/useStore';

interface Scan {
  btcRegime: string;
  circuitBreaker: string | boolean | null;
  drawdownHalt?: string | boolean | null;
  eventFilter: string | boolean | null;
  totalOpenRisk: number;
  notified: string[];
}

const BTC: Record<string, { label: string; hint: string; color: string }> = {
  bullish: { label: 'BTC 偏多', hint: '順勢做多 · 山寨空暫停', color: '#0ECB81' },
  bearish: { label: 'BTC 偏空', hint: '順勢做空 · 山寨多暫停', color: '#F6465D' },
  chaotic: { label: 'BTC 混沌', hint: '降級 B 級輕倉 0.5%',    color: '#2DD4BF' },
};

// Thin edge-to-edge terminal status strip under the header. Reuses /api/scan-status
// (same source as ScanStatusPanel) — answers "why no signals" at a glance.
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

  const info    = BTC[scan.btcRegime] ?? { label: `BTC ${scan.btcRegime}`, hint: '大盤中性', color: '#8A94A2' };
  const blocked = !!scan.circuitBreaker || !!scan.drawdownHalt || !!scan.eventFilter;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0C1116] border-b border-white/[0.06] text-[11px]">
      <span style={{ color: info.color }}>●</span>
      <span className="font-medium" style={{ color: info.color }}>{info.label}</span>
      <span className="text-text-m">|</span>
      <span className="text-text-s truncate">{info.hint}</span>
      <span className="flex-1" />
      {blocked ? (
        <span className="text-down font-medium">
          {scan.circuitBreaker ? '熔斷中' : scan.drawdownHalt ? '回撤停機' : '事件窗口'}
        </span>
      ) : (
        <>
          <span className="text-text-s num">{scan.notified.length} 訊號</span>
          <span className="text-text-m">|</span>
          <span className="text-text-m num">持倉評分 {scan.totalOpenRisk}</span>
        </>
      )}
    </div>
  );
}

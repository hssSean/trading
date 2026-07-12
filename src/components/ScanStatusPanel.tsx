'use client';
import { useEffect, useState, useCallback } from 'react';
import { useStore } from '@/store/useStore';

interface ScanCoin {
  symbol: string;
  topScore: number;
  rawTopScore?: number;
  adx4h: number | null;
  regime: string | null;
  agreeTFs: number;
  note: string | null;
}

interface Scan {
  at: number;
  btcRegime: string;
  circuitBreaker: string | boolean | null;
  eventFilter: string | boolean | null;
  totalOpenRisk: number;
  notified: string[];
  coins: ScanCoin[];
}

const REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  trending:     { text: '趨勢', cls: 'text-green-400' },
  ranging:      { text: '震盪', cls: 'text-blue-400' },
  transitional: { text: '過渡', cls: 'text-[#606080]' },
};

const BTC_REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  bullish: { text: 'BTC 偏多', cls: 'text-green-400' },
  bearish: { text: 'BTC 偏空', cls: 'text-red-400' },
  chaotic: { text: 'BTC 混沌', cls: 'text-[#F0B90B]' },
};

function timeAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1)  return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function ScanStatusPanel() {
  const [scan, setScan]         = useState<Scan | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [errMsg, setErrMsg]     = useState('');

  const fetchStatus = useCallback(async () => {
    try {
      const secret = useStore.getState().webhookSecret;
      const res  = await fetch('/api/scan-status', { headers: secret ? { 'x-webhook-secret': secret } : {} });
      if (res.status === 401) { setErrMsg('請在設定頁填入 Webhook 密鑰'); return; }
      const data = await res.json();
      if (data.scan) { setScan(data.scan); setErrMsg(''); }
      else setErrMsg(data.reason === 'redis-not-configured' ? '' : '尚無掃描紀錄（等待下次伺服器分析）');
    } catch { /* network error — keep stale data */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 90 * 1000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  if (!scan) {
    return errMsg ? (
      <div className="mt-2 px-3 py-2 bg-[#12121A] border border-[#1E1E2E] rounded-2xl">
        <p className="text-[#606080] text-xs">📡 {errMsg}</p>
      </div>
    ) : null;
  }

  const btc = BTC_REGIME_LABEL[scan.btcRegime] ?? { text: scan.btcRegime, cls: 'text-[#606080]' };
  const blockers = [
    scan.circuitBreaker ? '⛔ 熔斷中' : null,
    scan.eventFilter ? '📅 事件窗口' : null,
  ].filter(Boolean);

  return (
    <div className="mt-2 bg-[#12121A] border border-[#1E1E2E] rounded-2xl overflow-hidden">
      {/* Summary row — always visible */}
      <button onClick={() => { setExpanded(e => !e); if (!expanded) fetchStatus(); }}
        className="w-full px-3 py-2 flex items-center gap-2 text-left">
        <span className="text-xs shrink-0">📡</span>
        <span className="text-[#A0A0C0] text-xs font-semibold shrink-0">伺服器掃描</span>
        <span className="text-[#404060] text-[10px] shrink-0">{timeAgo(scan.at)}</span>
        <span className={`text-[10px] font-bold shrink-0 ${btc.cls}`}>{btc.text}</span>
        {blockers.length > 0 && (
          <span className="text-red-400 text-[10px] font-bold shrink-0">{blockers.join(' ')}</span>
        )}
        <span className="flex-1" />
        {scan.notified.length > 0 && (
          <span className="text-green-400 text-[10px] font-bold shrink-0">✉ {scan.notified.length} 訊號</span>
        )}
        <span className="text-[#404060] text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded: per-coin table */}
      {expanded && (
        <div className="px-3 pb-2.5 border-t border-[#1E1E2E]">
          {(scan.circuitBreaker || scan.eventFilter) && (
            <p className="text-red-400/80 text-[10px] mt-2">
              {typeof scan.circuitBreaker === 'string' ? `⛔ ${scan.circuitBreaker}` : ''}
              {typeof scan.eventFilter === 'string' ? ` 📅 ${scan.eventFilter}` : ''}
            </p>
          )}
          <div className="mt-2 space-y-1">
            {scan.coins.map(c => {
              const reg = c.regime ? (REGIME_LABEL[c.regime] ?? { text: c.regime, cls: 'text-[#606080]' }) : null;
              const isNotified = scan.notified.includes(c.symbol);
              return (
                <div key={c.symbol} className="flex items-center gap-2 text-[10px] leading-4">
                  <span className="text-[#EAEAF4] font-bold w-16 shrink-0 truncate">{c.symbol.replace('USDT', '')}</span>
                  <span className={`w-10 shrink-0 font-bold ${c.topScore >= 65 ? 'text-[#F0B90B]' : 'text-[#404060]'}`}>
                    {c.topScore > 0 ? `${c.topScore}分`
                      : (c.rawTopScore ?? 0) > 0 ? `${c.rawTopScore}未達` : '—'}
                  </span>
                  {reg && <span className={`w-7 shrink-0 ${reg.cls}`}>{reg.text}</span>}
                  <span className="text-[#404060] w-14 shrink-0">ADX {c.adx4h ?? '?'}</span>
                  <span className="flex-1 text-[#606080] truncate">
                    {isNotified ? '✅ 已發訊號' : (c.note ?? '無合格訊號')}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-[#404060] text-[9px] mt-2">
            總持倉風險 {scan.totalOpenRisk}% · 每 5 分鐘自動掃描 · 點擊標題可收合
          </p>
        </div>
      )}
    </div>
  );
}

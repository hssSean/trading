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

// v2.1 §0: reject-funnel gate id → human label
const REJECT_LABEL: Record<string, string> = {
  event_filter:      '事件窗口',
  circuit_breaker:   '當日熔斷',
  total_risk_cap:    '總風險上限',
  locked:            '持倉鎖定',
  same_candle:       '同4H蠟燭',
  cooldown:          '冷卻中',
  confluence:        '多框架未確認',
  no_entry_tf:       '進場時區無訊號',
  btc_direction:     'BTC 逆向',
  btc_pause:         'BTC 急漲跌暫停',
  same_dir_cap:      '同向上限',
  loss_cooldown:     '止損後冷卻24h',
  bias_hold:         '反向bias保留',
  has_open_position: '已有持倉',
  dup_check_error:   '重複檢查失敗',
  score_gate:        '分數/組數未達',
  no_profile:        '帳號未解析',
  insert_failed:     'DB寫入失敗',
};

interface FunnelStats {
  total: number;
  sent: number;
  rejected: number;
  reasons: Array<{
    key: string;
    count: number;
    pctOfRejected: number;
    // Simulated outcome of what this gate rejected: netR < 0 = gate saved money
    shadow?: { win: number; loss: number; other: number; pending: number; netR: number };
  }>;
}

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
  const [funnel, setFunnel]     = useState<FunnelStats | null>(null);
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

  const fetchFunnel = useCallback(async () => {
    try {
      const secret = useStore.getState().webhookSecret;
      const res  = await fetch('/api/reject-funnel?days=3', { headers: secret ? { 'x-webhook-secret': secret } : {} });
      const data = await res.json();
      if (data.ok) setFunnel(data);
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 90 * 1000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Funnel stats are heavier — fetch only when the panel is expanded
  useEffect(() => {
    if (expanded) fetchFunnel();
  }, [expanded, fetchFunnel]);

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
          {/* v2.1 §0: reject funnel — which gate kills the most candidates */}
          {funnel && funnel.total > 0 && (
            <div className="mt-2.5 pt-2 border-t border-[#1E1E2E]">
              <p className="text-[#404060] text-[9px] uppercase font-bold tracking-widest mb-1">
                近3天訊號漏斗 — 候選 {funnel.total} · 出單 <span className="text-green-400">{funnel.sent}</span>
              </p>
              {funnel.reasons.slice(0, 5).map(r => {
                const sh = r.shadow;
                const decided = sh ? sh.win + sh.loss + sh.other : 0;
                return (
                  <div key={r.key} className="text-[10px] leading-4 mb-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[#606080] w-24 shrink-0 truncate">{REJECT_LABEL[r.key] ?? r.key}</span>
                      <div className="flex-1 h-1 bg-[#1A1A26] rounded-full overflow-hidden">
                        <div className="h-full bg-red-400/50 rounded-full" style={{ width: `${r.pctOfRejected}%` }} />
                      </div>
                      <span className="text-[#606080] w-14 shrink-0 text-right">{r.count} ({r.pctOfRejected}%)</span>
                    </div>
                    {sh && decided > 0 && (
                      <p className={`pl-2 ${sh.netR <= 0 ? 'text-green-400/70' : 'text-orange-400/90'}`}>
                        └ 模擬被擋訊號：✓賺{sh.win} ✗虧{sh.loss}{sh.other > 0 ? ` ⏱其他${sh.other}` : ''} · 淨 {sh.netR >= 0 ? '+' : ''}{sh.netR}R {sh.netR <= 0 ? '（這關擋得對）' : '（擋掉了賺錢單）'}
                      </p>
                    )}
                  </div>
                );
              })}
              {funnel.reasons.length === 0 && (
                <p className="text-[#404060] text-[10px]">尚無被拒紀錄</p>
              )}
            </div>
          )}
          <p className="text-[#404060] text-[9px] mt-2">
            總持倉風險 {scan.totalOpenRisk}% · 每 5 分鐘自動掃描 · 點擊標題可收合
          </p>
        </div>
      )}
    </div>
  );
}

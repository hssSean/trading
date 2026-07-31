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
  trending:     { text: '趨勢', cls: 'text-up' },
  ranging:      { text: '震盪', cls: 'text-accent' },
  transitional: { text: '過渡', cls: 'text-text-m' },
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

// Capacity gates block on portfolio-slot availability (correlated basket already
// full), not signal quality — their shadow netR reflects the same handful of BTC
// moves counted once per blocked symbol, not independent edge. The win/lose verdict
// below is misleading for these; show the raw numbers without the judgment.
const CAPACITY_GATES = new Set(['same_dir_cap', 'total_risk_cap', 'locked']);

interface TimeStopStat {
  win: number;
  loss: number;
  stillOpen: number;
  live: number;
  netR: number;      // 「如果不砍會怎樣」的模擬淨R
  realNetR: number;  // 真實時間止損出場的淨R
}

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
  // docs/TODO.md P1 #1：時間止損（8根K線停滯/24-168h到期）強制關單後，
  // 繼續模擬到真正 TP/SL 的淨R vs 真實出場淨R。
  timeStopStats?: Partial<Record<'stall' | 'expiry', TimeStopStat>>;
}

const TIME_STOP_LABEL: Record<string, string> = {
  stall:  '停滯止損（8根K線）',
  expiry: '到期平倉（24-168h）',
};

const BTC_REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  bullish: { text: 'BTC 偏多', cls: 'text-up' },
  bearish: { text: 'BTC 偏空', cls: 'text-down' },
  chaotic: { text: 'BTC 混沌', cls: 'text-accent' },
};

// Shared row for both the quality-gate and capacity-gate funnel groups
// (docs/TODO.md P1 #2) — same layout, only the caption differs by gate kind.
function FunnelReasonRow({ r }: { r: FunnelStats['reasons'][number] }) {
  const sh = r.shadow;
  const decided = sh ? sh.win + sh.loss + sh.other : 0;
  return (
    <div className="text-[10px] leading-4 mb-0.5">
      <div className="flex items-center gap-2">
        <span className="text-text-m w-24 shrink-0 truncate">{REJECT_LABEL[r.key] ?? r.key}</span>
        <div className="flex-1 h-1 bg-white/[0.06] overflow-hidden">
          <div className="h-full bg-down/50" style={{ width: `${r.pctOfRejected}%` }} />
        </div>
        <span className="text-text-m w-14 shrink-0 text-right num">{r.count} ({r.pctOfRejected}%)</span>
      </div>
      {sh && decided > 0 && (
        CAPACITY_GATES.has(r.key) ? (
          <p className="pl-2 num text-text-m">
            └ 模擬被擋訊號：賺{sh.win} 虧{sh.loss}{sh.other > 0 ? ` 其他${sh.other}` : ''} · 淨 {sh.netR >= 0 ? '+' : ''}{sh.netR}R（容量關卡，非品質判斷，數字僅供參考）
          </p>
        ) : (
          <p className={`pl-2 num ${sh.netR <= 0 ? 'text-up/70' : 'text-[#C99A2E]/90'}`}>
            └ 模擬被擋訊號：賺{sh.win} 虧{sh.loss}{sh.other > 0 ? ` 其他${sh.other}` : ''} · 淨 {sh.netR >= 0 ? '+' : ''}{sh.netR}R {sh.netR <= 0 ? '（這關擋得對）' : '（擋掉了賺錢單）'}
          </p>
        )
      )}
    </div>
  );
}

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
      <div className="mt-2 px-3 py-2 bg-card-2 border border-white/[0.06] rounded-xl">
        <p className="text-text-m text-xs">{errMsg}</p>
      </div>
    ) : null;
  }

  const btc = BTC_REGIME_LABEL[scan.btcRegime] ?? { text: scan.btcRegime, cls: 'text-text-m' };
  const blockers = [
    scan.circuitBreaker ? '熔斷中' : null,
    scan.eventFilter ? '事件窗口' : null,
  ].filter(Boolean);

  return (
    <div className="mt-2 bg-card-2 border border-white/[0.06] rounded-xl overflow-hidden">
      {/* Summary row — always visible */}
      <button onClick={() => { setExpanded(e => !e); if (!expanded) fetchStatus(); }}
        className="w-full px-3 py-2 flex items-center gap-2 text-left">
        <span className="text-text-s text-[11px] shrink-0">伺服器掃描</span>
        <span className="text-text-m text-[10px] shrink-0 num">{timeAgo(scan.at)}</span>
        <span className={`text-[10px] shrink-0 ${btc.cls}`}>{btc.text}</span>
        {blockers.length > 0 && (
          <span className="text-down text-[10px] shrink-0">{blockers.join(' ')}</span>
        )}
        <span className="flex-1" />
        {scan.notified.length > 0 && (
          <span className="text-up text-[10px] shrink-0 num">{scan.notified.length} 訊號</span>
        )}
        <span className="text-text-m text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded: per-coin table */}
      {expanded && (
        <div className="px-3 pb-2.5 border-t border-white/[0.06]">
          {(scan.circuitBreaker || scan.eventFilter) && (
            <p className="text-down/80 text-[10px] mt-2">
              {typeof scan.circuitBreaker === 'string' ? scan.circuitBreaker : ''}
              {typeof scan.eventFilter === 'string' ? ` ${scan.eventFilter}` : ''}
            </p>
          )}
          <div className="mt-2 space-y-1">
            {scan.coins.map(c => {
              const reg = c.regime ? (REGIME_LABEL[c.regime] ?? { text: c.regime, cls: 'text-text-m' }) : null;
              const isNotified = scan.notified.includes(c.symbol);
              return (
                <div key={c.symbol} className="flex items-center gap-2 text-[10px] leading-4">
                  <span className="text-text-p w-16 shrink-0 truncate num">{c.symbol.replace('USDT', '')}</span>
                  <span className={`w-10 shrink-0 num ${c.topScore >= 65 ? 'text-accent' : 'text-text-m'}`}>
                    {c.topScore > 0 ? `${c.topScore}分`
                      : (c.rawTopScore ?? 0) > 0 ? `${c.rawTopScore}未達` : '—'}
                  </span>
                  {reg && <span className={`w-7 shrink-0 ${reg.cls}`}>{reg.text}</span>}
                  <span className="text-text-m w-14 shrink-0 num">ADX {c.adx4h ?? '?'}</span>
                  <span className="flex-1 text-text-s truncate">
                    {isNotified ? '已發訊號' : (c.note ?? '無合格訊號')}
                  </span>
                </div>
              );
            })}
          </div>
          {/* v2.1 §0: reject funnel — which gate kills the most candidates.
              docs/TODO.md P1 #2: capacity gates (correlated-basket slot limits)
              and quality gates (signal didn't clear a bar) are split into two
              groups so a capacity gate's netR — which reflects the same handful
              of BTC moves counted once per blocked symbol, not independent
              signal edge — never sits in the same ranked list as quality gates
              and gets read as "this quality filter is wrong". */}
          {funnel && funnel.total > 0 && (() => {
            const qualityReasons  = funnel.reasons.filter(r => !CAPACITY_GATES.has(r.key)).slice(0, 5);
            const capacityReasons = funnel.reasons.filter(r =>  CAPACITY_GATES.has(r.key));
            return (
              <div className="mt-2.5 pt-2 border-t border-white/[0.06]">
                <p className="tlabel mb-1">
                  近3天訊號漏斗 — 候選 {funnel.total} · 出單 <span className="text-up num">{funnel.sent}</span>
                </p>
                {qualityReasons.length > 0 && (
                  <div className="mb-1.5">
                    <p className="text-text-m text-[9px] mb-0.5">品質關卡</p>
                    {qualityReasons.map(r => <FunnelReasonRow key={r.key} r={r} />)}
                  </div>
                )}
                {capacityReasons.length > 0 && (
                  <div>
                    <p className="text-text-m text-[9px] mb-0.5">容量關卡（曝險上限，非品質判斷）</p>
                    {capacityReasons.map(r => <FunnelReasonRow key={r.key} r={r} />)}
                  </div>
                )}
                {funnel.reasons.length === 0 && (
                  <p className="text-text-m text-[10px]">尚無被拒紀錄</p>
                )}
              </div>
            );
          })()}
          {/* docs/TODO.md P1 #1: 時間止損強制關單後，繼續模擬到真正 TP/SL 的
              淨R vs 真實出場淨R——正差值代表「讓它走完會更好」，負或接近0
              代表「砍得對」。樣本不足前只陳述數字，不下判詞。 */}
          {funnel?.timeStopStats && (Object.keys(funnel.timeStopStats).length > 0) && (
            <div className="mt-2.5 pt-2 border-t border-white/[0.06]">
              <p className="tlabel mb-1">時間止損影子模擬</p>
              {(['stall', 'expiry'] as const).map(trigger => {
                const s = funnel.timeStopStats?.[trigger];
                if (!s) return null;
                const decided = s.win + s.loss + s.stillOpen;
                return (
                  <p key={trigger} className="text-[10px] leading-4 mb-0.5 num text-text-m">
                    {TIME_STOP_LABEL[trigger]}：真實淨 {s.realNetR >= 0 ? '+' : ''}{s.realNetR}R
                    {decided > 0 && (
                      <> · 若不砍模擬淨 {s.netR >= 0 ? '+' : ''}{s.netR}R（賺{s.win} 虧{s.loss}{s.stillOpen > 0 ? ` 未平${s.stillOpen}` : ''}）</>
                    )}
                    {s.live > 0 && <span className="text-text-m"> · {s.live} 筆追蹤中</span>}
                  </p>
                );
              })}
            </div>
          )}
          <p className="text-text-m text-[9px] mt-2 num">
            持倉風險評分 {scan.totalOpenRisk}（非帳戶實際風險%）· 每 5 分鐘自動掃描 · 點擊標題可收合
          </p>
        </div>
      )}
    </div>
  );
}

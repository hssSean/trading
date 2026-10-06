'use client';
// 策略帳戶（2026-10-07 部署，docs/strategy-deploy-2026-10-06.md）：
//   - S3-A testnet 真倉（live-runner 下單，s3a-live:*）
//   - S3-A／S3-B／S1 三個模擬帳本（/api/analyze 每天記帳，s3s1:*；起始各 100 USDT）
// 資料由 /api/strategies 讀取，統計口徑與 scripts/s3s1-report.ts 共用 src/lib/s3s1/stats.ts。
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import type { Position, SignalLog } from '@/lib/s3s1/engine';
import type { AcctSummary, LiveSummary, LiveDone } from '@/lib/s3s1/stats';

interface Acct { summary: AcctSummary; open: Position[]; recent: Position[]; signals: SignalLog[]; blocked: Record<string, number> }
interface Resp {
  ok: boolean; reason?: string;
  trackStart: { s3: number | null; s1: number | null };
  lastRun: { s3: number | null; s1: number | null };
  accounts: Acct[];
  live: { summary: LiveSummary; lastDay: number | null; open: Record<string, number | string | boolean | null>[]; recent: LiveDone[] };
}

const EXIT: Record<string, string> = { stop: '止損', breakeven: '保本', trail: '移動止損', ema: '跌破 EMA20' };
const fmtR = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}R`);
const fmtPct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const fmtPx = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '—' : p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const fmtD = (t: number | null | undefined) => (t ? `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}` : '—');
const fmtT = (t: number | null | undefined) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const color = (x: number | null | undefined) => (x == null || !Number.isFinite(x) || x === 0 ? 'text-[#8A94A2]' : x > 0 ? 'text-up' : 'text-down');
const coin = (s: string) => s.replace(/USDT$/, '');

function Stats({ items }: { items: [string, string, number | null | undefined][] }) {
  return (
    <div className="grid grid-cols-4 gap-2 mt-2.5 num">
      {items.map(([k, v, c]) => (
        <div key={k}>
          <p className="text-[#565E6B] text-[10px]">{k}</p>
          <p className={`text-sm ${c === undefined ? 'text-[#E8ECF1]' : color(c)}`}>{v}</p>
        </div>
      ))}
    </div>
  );
}

function Row({ left, sub, right, rc }: { left: string; sub: string; right: string; rc?: number | null }) {
  return (
    <div className="flex items-center justify-between bg-[#0A0D11] rounded-lg px-2.5 py-2 num">
      <div className="min-w-0">
        <p className="text-[11px] text-[#E8ECF1]">{left}</p>
        <p className="text-[10px] text-[#565E6B] truncate">{sub}</p>
      </div>
      <p className={`text-[11px] whitespace-nowrap ${rc === undefined ? 'text-accent' : color(rc)}`}>{right}</p>
    </div>
  );
}

function LiveCard({ live }: { live: Resp['live'] }) {
  const [open, setOpen] = useState(true);
  const s = live.summary;
  return (
    <div className="bg-[#0D0D16] border border-accent/30 rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[#E8ECF1] text-xs leading-5">S3-A｜testnet 真倉</p>
        <p className="text-[#565E6B] text-[10px] num whitespace-nowrap">持倉 {live.open.length}・最近決策 {fmtD(live.lastDay)}</p>
      </div>
      {s.halted && <p className="text-down text-[11px] mt-1">⛔ 已停用：{s.halted}</p>}
      <Stats items={[
        ['已實現', `${s.realized >= 0 ? '+' : ''}${s.realized.toFixed(1)}U`, s.realized],
        ['報酬', fmtPct(s.retPct), s.retPct],
        ['已結束', `${s.trades}（勝 ${s.wins}）`, undefined],
        ['每筆淨', fmtR(s.avgR), s.avgR],
      ]} />
      <p className="text-[#3A424E] text-[9px] mt-1 num">起始 {s.baseEquity ? `${s.baseEquity.toFixed(0)} USDT` : '—'}・回撤 {s.ddPct == null ? '—' : `${s.ddPct.toFixed(1)}%`}・連虧 {s.lossStreak}</p>
      <button onClick={() => setOpen(v => !v)} className="w-full mt-2 text-[10px] text-[#8A94A2] py-1 border-t border-[#1B222B]">
        {open ? '收起' : `看持倉與紀錄（${live.open.length + live.recent.length}）`}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {live.open.length + live.recent.length === 0 && <p className="text-[#565E6B] text-[11px] text-center py-3">還沒有交易</p>}
          {live.open.map(p => (
            <Row key={String(p.symbol)} left={`${coin(String(p.symbol))}・持倉中${p.partial ? '（已平 1/3）' : ''}`}
              sub={`${fmtT(Number(p.entryAt))} 進 ${fmtPx(Number(p.entry))}・止損 ${fmtPx(Number(p.stop))}・數量 ${p.qty0}`} right="持倉" />
          ))}
          {live.recent.map(p => (
            <Row key={`${p.symbol}:${p.entryDay}`} left={`${coin(p.symbol)}・${fmtD(p.entryAt)}→${fmtD(p.exitAt)}`}
              sub={`進 ${fmtPx(p.entry)} 出 ${fmtPx(p.exitAvg)}・${p.netPnl >= 0 ? '+' : ''}${p.netPnl.toFixed(2)}U`} right={fmtR(p.R)} rc={p.R} />
          ))}
        </div>
      )}
    </div>
  );
}

function AcctCard({ a }: { a: Acct }) {
  const [tab, setTab] = useState<'none' | 'trades' | 'signals'>('none');
  const s = a.summary;
  const blocked = Object.entries(a.blocked).sort((x, y) => y[1] - x[1]);
  return (
    <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[#E8ECF1] text-xs leading-5">{s.name}</p>
        <p className="text-[#565E6B] text-[10px] num whitespace-nowrap">持倉 {s.open}・風險 {s.riskOpenPct.toFixed(0)}%</p>
      </div>
      {s.halted && <p className="text-down text-[11px] mt-1">⛔ 已停用：{s.halted}</p>}
      <Stats items={[
        ['權益', `${s.equity.toFixed(1)}U`, s.equity - s.initial],
        ['報酬', fmtPct(s.retPct), s.retPct],
        ['已結束', `${s.trades}（勝 ${s.wins}）`, undefined],
        ['每筆淨', fmtR(s.avgR), s.avgR],
      ]} />
      <p className="text-[#3A424E] text-[9px] mt-1 num">回撤 {s.ddPct.toFixed(1)}%（最大 {s.maxDdPct.toFixed(1)}%）・連虧 {s.lossStreak}・合計 {fmtR(s.sumR, 1)}</p>
      <div className="flex mt-2 border-t border-[#1B222B]">
        {([['trades', `持倉與紀錄（${a.open.length + a.recent.length}）`], ['signals', `訊號（${a.signals.length}）`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(t => (t === k ? 'none' : k))}
            className={`flex-1 text-[10px] py-1.5 ${tab === k ? 'text-accent' : 'text-[#8A94A2]'}`}>{label}</button>
        ))}
      </div>
      {tab === 'trades' && (
        <div className="mt-1 space-y-1">
          {a.open.length + a.recent.length === 0 && <p className="text-[#565E6B] text-[11px] text-center py-3">還沒有交易</p>}
          {a.open.map(p => (
            <Row key={p.id} left={`${coin(p.symbol)}・持倉中`} sub={`${fmtT(p.entryT)} 進 ${fmtPx(p.entry)}・止損 ${fmtPx(p.stop)}・風險 ${p.riskUsdt.toFixed(2)}U`} right="持倉" />
          ))}
          {a.recent.map(p => (
            <Row key={p.id} left={`${coin(p.symbol)}・${fmtD(p.entryT)}→${fmtD(p.exitT)}・${EXIT[p.exitReason ?? ''] ?? p.exitReason ?? ''}${p.partial ? '（已平 1/3）' : ''}`}
              sub={`進 ${fmtPx(p.entry)} 出 ${fmtPx(p.exitPx)}・${(p.pnlUsdt ?? 0) >= 0 ? '+' : ''}${(p.pnlUsdt ?? 0).toFixed(2)}U${p.addR != null ? `・加碼 ${fmtR(p.addR)}` : ''}`}
              right={fmtR(p.netR)} rc={p.netR} />
          ))}
        </div>
      )}
      {tab === 'signals' && (
        <div className="mt-1 space-y-1">
          {blocked.length > 0 && (
            <p className="text-[#565E6B] text-[10px] px-1 leading-4">擋掉：{blocked.map(([k, n]) => `${k}×${n}`).join('、')}</p>
          )}
          {a.signals.length === 0 && <p className="text-[#565E6B] text-[11px] text-center py-3">還沒有訊號</p>}
          {a.signals.map((g, i) => (
            <Row key={`${g.symbol}-${g.signalT}-${i}`} left={`${coin(g.symbol)}・${fmtT(g.signalT)}`}
              sub={g.decision === 'open' ? `收盤 ${fmtPx(g.close)}・止損 ${fmtPx(g.stop)}${g.score != null ? `・分數 ${g.score}` : ''}` : (g.reason ?? '')}
              right={g.decision === 'open' ? '開倉' : '擋掉'} rc={g.decision === 'open' ? 1 : null} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function StrategiesPage() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setError('尚未登入，無法查詢'); return; }
      const res = await fetch('/api/strategies', { headers: { Authorization: `Bearer ${jwt}` } });
      const json = await res.json() as Resp;
      if (!res.ok || !json.ok) { setError(json.reason ?? `查詢失敗（${res.status}）`); setData(null); }
      else setData(json);
    } catch (e) {
      setError(String(e).slice(0, 150));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <div className="px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-medium tracking-[0.05em]">策略帳戶</h1>
            <p className="text-[#565E6B] text-[10px] mt-0.5">S3 每天 09:05 後、S1 每 12 小時更新</p>
          </div>
          <button
            onClick={() => router.push('/settings')}
            className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded active:bg-[#141A21]"
          >
            返回設定
          </button>
        </div>
        {data && (
          <p className="text-[#3A424E] text-[10px] mt-2 num">
            起點 S3 {fmtT(data.trackStart.s3)}／S1 {fmtT(data.trackStart.s1)}・最近記帳 S3 {fmtD(data.lastRun.s3)}／S1 {fmtT(data.lastRun.s1)}
          </p>
        )}
      </div>

      <div className="px-3 py-3 space-y-2 pb-20">
        {loading && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && (
          <div className="bg-[#0D0D16] border border-[#F6465D]/30 rounded-xl p-3">
            <p className="text-[#F6465D] text-xs">{error}</p>
          </div>
        )}
        {!loading && !error && data && (
          <>
            <LiveCard live={data.live} />
            <p className="text-[#565E6B] text-[10px] px-1 pt-2">模擬帳本（不下單，起始各 100 USDT）</p>
            {data.accounts.map(a => <AcctCard key={a.summary.key} a={a} />)}
            <p className="text-[#3A424E] text-[10px] leading-4 px-1 pt-2">
              R ＝ 以止損距離為 1 單位的報酬，已扣手續費與資金費率。權益只算已平倉的單。
              達到停用條件（S3-A 回撤 &gt; 35% 或連虧 7 筆；S3-B 回撤 &gt; 40% 或連虧 15 筆；S1 回撤 &gt; 60% 或近 50 筆勝率 &lt; 45%）會自動停止開新倉，持倉照規則出場。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

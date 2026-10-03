'use client';
// 紙上策略的單一策略卡片（/paper 頁面用）。拆出來是為了能在單元測試裡直接渲染驗證。
import { useState } from 'react';
import { PAPER_SPEC, type PaperSummary, type PaperRecord } from '@/lib/paper/stats';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '等待成交', cls: 'text-[#8A94A2] border-[#232B35]' },
  open:    { label: '持倉中',   cls: 'text-accent border-accent/40' },
  done:    { label: '已結束',   cls: 'text-[#565E6B] border-[#1B222B]' },
  skip:    { label: '不交易',   cls: 'text-[#565E6B] border-[#1B222B]' },
};
const EXIT: Record<string, string> = {
  stop: '止損', breakeven: '保本出場', ema: '跌破 EMA20 出場', target: '止盈', time: '120 小時到期',
};

const fmtR = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}R`);
const fmtPct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
const fmtPx = (p: number) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const fmtT = (t: number | null | undefined) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const rColor = (x: number | null | undefined) => (x == null ? 'text-[#8A94A2]' : x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-[#8A94A2]');

export function PaperStratCard({ summary: s, recent, defaultOpen = false }: { summary: PaperSummary; recent: PaperRecord[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const spec = PAPER_SPEC[s.key];
  const done = s.counts.done;
  const progress = Math.min(1, done / spec.minN);
  const vColor = s.verdict === 'fail' ? 'text-down' : s.verdict === 'pass' ? 'text-up' : 'text-[#8A94A2]';
  return (
    <div className="bg-[#0D0D16] border border-[#1B222B] rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[#E8ECF1] text-xs leading-5">{spec.name}</p>
        <p className="text-[#565E6B] text-[10px] num whitespace-nowrap">持倉 {s.counts.open}・掛單 {s.counts.pending}</p>
      </div>

      <div className="grid grid-cols-4 gap-2 mt-2.5 num">
        {[
          ['已結束', String(done), `回測 ${spec.perWk}/週`],
          ['勝率', fmtPct(s.win), `回測 ${fmtPct(spec.win)}`],
          ['每筆淨', fmtR(s.avgR), `回測 ${fmtR(spec.avgR)}`],
          ['合計', fmtR(s.sumR, 1), `回撤 ${s.maxDdR.toFixed(1)}R`],
        ].map(([k, v, sub], i) => (
          <div key={k}>
            <p className="text-[#565E6B] text-[10px]">{k}</p>
            <p className={`text-sm ${i === 2 ? rColor(s.avgR) : i === 3 ? rColor(s.sumR) : 'text-[#E8ECF1]'}`}>{v}</p>
            <p className="text-[#3A424E] text-[9px]">{sub}</p>
          </div>
        ))}
      </div>

      <div className="mt-2.5">
        <div className="h-1 bg-[#1B222B] rounded-full overflow-hidden">
          <div className="h-full bg-accent/60" style={{ width: `${progress * 100}%` }} />
        </div>
        <p className={`text-[10px] mt-1 ${vColor}`}>{s.verdictText}</p>
        <p className="text-[#3A424E] text-[9px] mt-0.5">判準：{spec.rule}</p>
      </div>

      <button onClick={() => setOpen(v => !v)} className="w-full mt-2 text-[10px] text-[#8A94A2] py-1 border-t border-[#1B222B]">
        {open ? '收起紀錄' : `看最近紀錄（${recent.length}）`}
        {(s.counts.nofill + s.counts.busy) > 0 && <span className="text-[#3A424E]">　另有未成交／已有持倉略過 {s.counts.nofill + s.counts.busy} 筆未列出</span>}
      </button>

      {open && (
        <div className="mt-1 space-y-1">
          {recent.length === 0 && <p className="text-[#565E6B] text-[11px] text-center py-3">還沒有紀錄</p>}
          {recent.map(r => {
            const isA = s.key === 'strategyA';
            const st = STATUS[r.status] ?? { label: r.status, cls: 'text-[#565E6B] border-[#1B222B]' };
            const side = isA ? 1 : r.side;
            const entry = r.entry ?? r.price;
            const stop = isA ? r.stop : r.sl;
            const exit = isA ? r.exitReason : r.exitKind;
            return (
              <div key={r.id} className="flex items-center justify-between bg-[#0A0D11] rounded-lg px-2.5 py-2 num">
                <div className="min-w-0">
                  <p className="text-[11px] text-[#E8ECF1]">
                    {String(r.symbol).replace(/USDT$/, '')}
                    <span className={`ml-1.5 ${side === 1 ? 'text-up' : 'text-down'}`}>{side === 1 ? '多' : '空'}</span>
                    {!isA && <span className="ml-1.5 text-[#565E6B]">{r.kind === 1 ? '限價' : '市價'}</span>}
                    {isA && r.partial && <span className="ml-1.5 text-[#565E6B]">已平 1/3</span>}
                  </p>
                  <p className="text-[10px] text-[#565E6B]">
                    {fmtT(isA ? r.entryT : r.startT)}・進 {entry != null ? fmtPx(Number(entry)) : '—'}・損 {fmtPx(Number(stop))}
                    {!isA && <>・盈 {fmtPx(Number(r.tp))}</>}
                  </p>
                </div>
                <div className="text-right shrink-0 ml-2">
                  {r.status === 'done'
                    ? <p className={`text-[12px] ${rColor(r.netR)}`}>{fmtR(r.netR)}</p>
                    : <span className={`text-[10px] px-1.5 py-0.5 border rounded ${st.cls}`}>{st.label}</span>}
                  <p className="text-[9px] text-[#3A424E]">{r.status === 'done' ? (EXIT[exit] ?? exit ?? '') : r.status === 'skip' ? (r.note ?? '') : ''}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


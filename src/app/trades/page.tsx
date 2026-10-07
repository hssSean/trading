'use client';
// 紀錄：S3-A＋S3-B testnet 真倉的交易（同帳戶分帳；文件 §7.2、§7.3：成交價、滑價、止損移動、手續費、資金費、R）。
// 舊策略的交易紀錄搬到 /legacy/trades。
import { useState } from 'react';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { LiveClosed, TradesResp } from '@/lib/s3s1/apiTypes';
import { LEGS, LEG_KEYS, legsOf, type LivePos } from '@/engine/s3aLive';
import { legOf } from '@/lib/s3s1/stats';
import { EVENT_LABEL } from '@/components/s3/HomeCards';
import { Card, CardTitle, Empty, ErrorBox, PageHeader, Stats, coin, color, fmtD, fmtPct, fmtPx, fmtR, fmtT, fmtU } from '@/components/s3/ui';

const slipBp = (p: LivePos) => (p.refPx ? (p.entry / p.refPx - 1) * 1e4 : null);

function Events({ p }: { p: LivePos }) {
  if (!p.events?.length) return null;
  return (
    <div className="mt-1.5 space-y-0.5 text-[10px] num border-t border-[#1B222B] pt-1.5">
      {p.events.map((e, i) => (
        <p key={i} className="text-[#8A94A2]">{fmtT(e.t)}　{EVENT_LABEL[e.kind] ?? e.kind}{e.px != null ? ` ${fmtPx(e.px)}` : ''}{e.qty != null ? ` × ${e.qty}` : ''}{e.note ? `（${e.note}）` : ''}</p>
      ))}
    </div>
  );
}

function TradeItem({ p }: { p: LiveClosed | (LivePos & { exitAt?: undefined }) }) {
  const [open, setOpen] = useState(false);
  const done = 'R' in p && p.exitAt != null;
  const d = p as LiveClosed;
  const slip = slipBp(p);
  return (
    <div className="bg-[#0A0D11] rounded-lg px-2.5 py-2 num" onClick={() => setOpen(v => !v)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-[#E8ECF1]">
          {coin(p.symbol)}<span className="text-[#565E6B]">・{fmtD(p.entryAt)}{done ? `→${fmtD(d.exitAt)}` : '・持倉中'}{p.partial ? '・已平 1/3' : ''}</span>
        </p>
        <p className={`text-[11px] ${done ? color(d.R) : 'text-accent'}`}>{done ? fmtR(d.R) : '持倉'}</p>
      </div>
      <p className="text-[10px] text-[#565E6B] mt-0.5">
        進 {fmtPx(p.entry)}{done ? ` 出 ${fmtPx(d.exitAvg)}` : ''}・止損 {fmtPx(p.stop0)}・數量 {p.qty0}
        {slip != null ? `・滑價 ${slip >= 0 ? '+' : ''}${slip.toFixed(1)}bp` : ''}
      </p>
      {done && (
        <p className="text-[10px] text-[#565E6B]">
          淨損益 <span className={color(d.netPnl)}>{fmtU(d.netPnl)}</span>・手續費 {d.fee.toFixed(2)}U・資金費 {fmtU(d.fundingFee)}
        </p>
      )}
      <div className="text-[10px] mt-0.5 space-y-0.5">
        {LEG_KEYS.filter(k => legsOf(p)[k]).map(k => {
          const r = done ? legOf(d, k) : null;
          return (
            <p key={k} className="flex justify-between">
              <span className="text-[#8A94A2]">{LEGS[k].name} {legsOf(p)[k]!.qty0}{k === 'B' && (p.addQty ?? 0) > 0 ? `＋加碼 ${p.addQty}${p.addFilled ? '（已成交）' : done ? '（未觸發）' : '（待觸發）'}` : ''}</span>
              {r && <span className={color(r.net)}>{fmtU(r.net)}・{fmtR(r.R)}</span>}
            </p>
          );
        })}
      </div>
      {open && <Events p={p} />}
    </div>
  );
}

const csvCell = (v: unknown) => {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv(rows: (LivePos & Partial<LiveClosed>)[]) {
  const iso = (t?: number | null) => (t ? new Date(t).toISOString() : '');
  const data = rows.map(p => ({
    symbol: p.symbol, signalDay: iso(p.signalDay), entryAt: iso(p.entryAt), refPx: p.refPx, entry: p.entry, slippageBp: slipBp(p),
    qty0: p.qty0, stop0: p.stop0, stopNow: p.stop, partial: p.partial, score: p.score, dist: p.dist, btcExt: p.btcExt, ret7: p.ret7,
    breadth: p.breadth, fundingRate: p.funding, exitAt: iso(p.exitAt), exitAvg: p.exitAvg, R: p.R, netPnl: p.netPnl, fee: p.fee,
    fundingFee: p.fundingFee,
    qtyA: legsOf(p).A?.qty0, qtyB: legsOf(p).B?.qty0, addQty: p.addQty, addFilled: p.addFilled, addEntry: p.addEntry,
    netA: p.exitAt ? legOf(p as LiveClosed, 'A')?.net : null, R_A: p.exitAt ? legOf(p as LiveClosed, 'A')?.R : null,
    netB: p.exitAt ? legOf(p as LiveClosed, 'B')?.net : null, R_B: p.exitAt ? legOf(p as LiveClosed, 'B')?.R : null,
    events: p.events,
  }));
  const cols = Object.keys(data[0] ?? { symbol: '' });
  const body = [cols.join(','), ...data.map(r => cols.map(c => csvCell((r as Record<string, unknown>)[c])).join(','))].join('\n');
  const blob = new Blob(['﻿' + body + '\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `s3a-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function TradesPage() {
  const { data, error, loading } = useS3Api<TradesResp>('/api/s3/trades');

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <PageHeader title="交易紀錄" sub="S3-A＋S3-B testnet 真倉・點一筆看事件"
        right={data && data.open.length + data.done.length > 0 ? (
          <button onClick={() => exportCsv([...data.open, ...data.done])} className="text-accent text-[11px] px-2.5 py-1 border border-accent/30 rounded shrink-0">匯出 CSV</button>
        ) : undefined} />
      <div className="px-3 py-3 space-y-2 pb-20">
        {loading && !data && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && <ErrorBox text={error} />}
        {data?.summaries.map(s => (
          <Card key={s.leg} accent>
            <CardTitle title={`${s.name} 累計`} right={s.halted ? <span className="text-down">⛔ {s.halted}</span> : undefined} />
            <Stats items={[
              ['已實現', fmtU(s.realized, 1), s.realized],
              ['報酬', fmtPct(s.retPct, 2), s.retPct],
              ['已結束', `${s.trades}（勝 ${s.wins}）`],
              ['每筆淨', fmtR(s.avgR), s.avgR],
            ]} />
            <p className="text-[#3A424E] text-[9px] mt-1 num">
              回撤 {s.ddPct == null ? '—' : `${s.ddPct.toFixed(1)}%`}・連虧 {s.lossStreak}・回測基準 {s.leg === 'A' ? '每筆 +0.70R、勝率 60%' : '每筆 +2.31R、勝率 41%'}
            </p>
          </Card>
        ))}
        {data && data.open.length + data.done.length === 0 && <Card><Empty text="還沒有交易。第一筆會在出現符合條件的日線突破時，於台灣 08:00 後進場。" /></Card>}
        <div className="space-y-1">
          {data?.open.map(p => <TradeItem key={`o-${p.symbol}`} p={p} />)}
          {data?.done.map(p => <TradeItem key={`d-${p.symbol}-${p.entryDay}`} p={p} />)}
        </div>
      </div>
    </div>
  );
}

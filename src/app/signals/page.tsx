'use client';
// 訊號：S3-A 真倉（s3a-live:signals）與三個帳本（s3s1:signals）每一個通過訊號條件的 K 線，包含被擋掉的與理由
// （文件 §7.1：分數被擋掉的 S3 訊號一定要記錄——那是唯一能用新資料驗證分數有沒有用的方法）。
// 舊策略的信號頁搬到 /legacy/signals。
import { useMemo, useState } from 'react';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { SignalsResp } from '@/lib/s3s1/apiTypes';
import { reasonKey } from '@/lib/s3s1/stats';
import { Card, Empty, ErrorBox, PageHeader, Seg, coin, fmtPx, fmtT } from '@/components/s3/ui';

type Src = 'live' | 's3a' | 's3b' | 's1';
const SRC_LABEL: Record<Src, string> = { live: '真倉 S3-A＋B', s3a: '帳本 S3-A', s3b: '帳本 S3-B', s1: '帳本 S1' };

interface Item {
  src: Src; symbol: string; t: number; decision: 'open' | 'skip'; reason?: string;
  close: number; stop: number; score?: number; parts?: number[]; dist?: number;
  legs?: Partial<Record<'A' | 'B', string>>;
}

const PART_LABEL = ['止損距離', 'BTC 強度', '7 日漲幅'];

function SignalItem({ s }: { s: Item }) {
  const open = s.decision === 'open';
  return (
    <div className="bg-[#0A0D11] rounded-lg px-2.5 py-2 num">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-[#E8ECF1]">{coin(s.symbol)}<span className="text-[#565E6B]">・{SRC_LABEL[s.src]}・訊號 {fmtT(s.t)}</span></p>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${open ? 'text-up border-up/40' : 'text-[#8A94A2] border-[#232B35]'}`}>{open ? '開倉' : '擋掉'}</span>
      </div>
      <p className="text-[10px] text-[#565E6B] mt-0.5">
        收盤 {fmtPx(s.close)}・止損 {fmtPx(s.stop)}{s.dist != null ? `・距離 ${(s.dist * 100).toFixed(1)}%` : ''}
        {s.score != null && <>・分數 {s.score}{s.parts ? `（${s.parts.map((v, i) => `${PART_LABEL[i]} ${v > 0 ? '+' : ''}${v}`).join('、')}）` : ''}</>}
      </p>
      {!open && s.reason && <p className="text-[10px] text-[#8A94A2] mt-0.5">{s.reason}</p>}
      {s.legs && (
        <p className="text-[10px] mt-0.5">
          {(['A', 'B'] as const).filter(k => s.legs![k]).map(k => (
            <span key={k} className={`mr-3 ${s.legs![k] === 'open' ? 'text-up' : 'text-[#565E6B]'}`}>S3-{k}：{s.legs![k] === 'open' ? '開倉' : s.legs![k]}</span>
          ))}
        </p>
      )}
    </div>
  );
}

export default function SignalsPage() {
  const { data, error, loading } = useS3Api<SignalsResp>('/api/s3/signals');
  const [src, setSrc] = useState<'all' | Src>('all');
  const [dec, setDec] = useState<'all' | 'open' | 'skip'>('all');

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const live: Item[] = data.live.map(s => ({ src: 'live', symbol: s.symbol, t: s.signalDay, decision: s.decision, reason: s.reason,
      close: s.close, stop: s.stop, score: s.score, parts: s.scoreParts, dist: s.dist, legs: s.legs }));
    const ledger: Item[] = data.ledger.map(s => ({ src: s.acct, symbol: s.symbol, t: s.signalT, decision: s.decision, reason: s.reason,
      close: s.close, stop: s.stop, score: s.score, parts: s.scoreParts, dist: s.dist }));
    return [...live, ...ledger].sort((a, b) => b.t - a.t);
  }, [data]);

  const shown = items.filter(s => (src === 'all' || s.src === src) && (dec === 'all' || s.decision === dec));
  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shown) if (s.decision === 'skip') m.set(reasonKey(s.reason), (m.get(reasonKey(s.reason)) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [shown]);
  const opens = shown.filter(s => s.decision === 'open').length;

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <PageHeader title="訊號" sub={data ? `顯示 ${shown.length} 筆・開倉 ${opens}・擋掉 ${shown.length - opens}` : 'S3／S1 每一個突破訊號，含被擋掉的'} />
      <div className="px-3 py-3 space-y-2 pb-20">
        <Seg value={src} onChange={setSrc} options={[['all', '全部'], ['live', '真倉'], ['s3a', '帳本 S3-A'], ['s3b', '帳本 S3-B'], ['s1', '帳本 S1']]} />
        <Seg value={dec} onChange={setDec} options={[['all', '全部'], ['open', '開倉'], ['skip', '擋掉']]} />
        {loading && !data && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && <ErrorBox text={error} />}
        {reasons.length > 0 && (
          <Card>
            <p className="text-[#565E6B] text-[10px] mb-1">擋掉的原因</p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] num">
              {reasons.map(([k, n]) => <span key={k} className="text-[#8A94A2]">{k} <span className="text-[#E8ECF1]">{n}</span></span>)}
            </div>
          </Card>
        )}
        {data && shown.length === 0 && <Card><Empty text="還沒有訊號。S3 只在日線收盤（台灣 08:00）時產生，一個月約幾個。" /></Card>}
        <div className="space-y-1">
          {shown.map((s, i) => <SignalItem key={`${s.src}-${s.symbol}-${s.t}-${i}`} s={s} />)}
        </div>
      </div>
    </div>
  );
}

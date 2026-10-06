'use client';
// 帳本：S3-A／S3-B／S1 三個模擬帳本（不下單，起始各 100 USDT），對照文件 §9 回測基準。
// 資料由 /api/analyze 每天記帳（src/lib/s3s1/engine.ts），這頁透過 /api/s3/ledgers 讀取。
import { useState } from 'react';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { LedgerAcct, LedgersResp } from '@/lib/s3s1/apiTypes';
import { BENCHMARKS } from '@/lib/s3s1/benchmarks';
import { Card, CardTitle, Empty, ErrorBox, EXIT_LABEL, PageHeader, Row, Stats, coin, fmtD, fmtPct, fmtPx, fmtR, fmtT } from '@/components/s3/ui';

function LedgerCard({ a }: { a: LedgerAcct }) {
  const [tab, setTab] = useState<'none' | 'trades' | 'bench'>('none');
  const s = a.summary;
  const b = BENCHMARKS[s.key];
  const blocked = Object.entries(a.blocked).sort((x, y) => y[1] - x[1]);
  return (
    <Card>
      <CardTitle title={s.name} right={<>持倉 {s.open}・風險 {s.riskOpenPct.toFixed(0)}%</>} />
      {s.halted && <p className="text-down text-[11px] mt-1">⛔ 已停用：{s.halted}</p>}
      <Stats items={[
        ['權益', `${s.equity.toFixed(1)}U`, s.equity - s.initial],
        ['報酬', fmtPct(s.retPct), s.retPct],
        ['已結束', `${s.trades}（勝 ${s.wins}）`],
        ['每筆淨', fmtR(s.avgR), s.avgR],
      ]} />
      <p className="text-[#3A424E] text-[9px] mt-1 num">回撤 {s.ddPct.toFixed(1)}%（最大 {s.maxDdPct.toFixed(1)}%）・連虧 {s.lossStreak}・合計 {fmtR(s.sumR, 1)}</p>
      {blocked.length > 0 && (
        <p className="text-[#565E6B] text-[10px] mt-1 leading-4">擋掉：{blocked.map(([k, n]) => `${k}×${n}`).join('、')}</p>
      )}
      <div className="flex mt-2 border-t border-[#1B222B]">
        {([['trades', `持倉與紀錄（${a.open.length + a.recent.length}）`], ['bench', '回測基準']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(t => (t === k ? 'none' : k))}
            className={`flex-1 text-[10px] py-1.5 ${tab === k ? 'text-accent' : 'text-[#8A94A2]'}`}>{label}</button>
        ))}
      </div>
      {tab === 'trades' && (
        <div className="mt-1 space-y-1">
          {a.open.length + a.recent.length === 0 && <Empty text="還沒有交易" />}
          {a.open.map(p => (
            <Row key={p.id} left={`${coin(p.symbol)}・持倉中`} sub={`${fmtT(p.entryT)} 進 ${fmtPx(p.entry)}・止損 ${fmtPx(p.stop)}・風險 ${p.riskUsdt.toFixed(2)}U`} right="持倉" />
          ))}
          {a.recent.map(p => (
            <Row key={p.id} left={`${coin(p.symbol)}・${fmtD(p.entryT)}→${fmtD(p.exitT)}・${EXIT_LABEL[p.exitReason ?? ''] ?? p.exitReason ?? ''}${p.partial ? '（已平 1/3）' : ''}`}
              sub={`進 ${fmtPx(p.entry)} 出 ${fmtPx(p.exitPx)}・${(p.pnlUsdt ?? 0) >= 0 ? '+' : ''}${(p.pnlUsdt ?? 0).toFixed(2)}U${p.addR != null ? `・加碼 ${fmtR(p.addR)}` : ''}`}
              right={fmtR(p.netR)} rc={p.netR} />
          ))}
        </div>
      )}
      {tab === 'bench' && (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] num">
          {([['每月筆數', b.perMonth], ['整筆勝率', b.winRate], ['每筆', b.perTradeR], ['最大回撤', b.maxDd], ['最長連虧', b.maxLossStreak], ['100U 一年後', b.oneYear]] as const).map(([k, v]) => (
            <p key={k} className="flex justify-between"><span className="text-[#565E6B]">{k}</span><span className="text-[#8A94A2]">{v}</span></p>
          ))}
          <p className="col-span-2 text-[#3A424E] text-[9px] leading-4 mt-1">左邊 2020–22、右邊 2023 年後；一年後是中位數（最差 10%）。</p>
        </div>
      )}
    </Card>
  );
}

export default function LedgersPage() {
  const { data, error, loading } = useS3Api<LedgersResp>('/api/s3/ledgers');
  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]">
      <PageHeader title="模擬帳本" sub={data
        ? <>起點 S3 {fmtT(data.trackStart.s3)}／S1 {fmtT(data.trackStart.s1)}・最近記帳 S3 {fmtD(data.lastRun.s3)}／S1 {fmtT(data.lastRun.s1)}</>
        : '不下單・起始各 100 USDT・S3 每天 09:05、S1 每 12 小時記帳'} />
      <div className="px-3 py-3 space-y-2 pb-20">
        {loading && !data && <p className="text-[#565E6B] text-xs text-center py-8">載入中…</p>}
        {error && <ErrorBox text={error} />}
        {data?.accounts.map(a => <LedgerCard key={a.summary.key} a={a} />)}
        {data && (
          <p className="text-[#3A424E] text-[10px] leading-4 px-1 pt-2">
            R ＝ 以止損距離為 1 單位的報酬，已扣手續費與資金費率。權益只算已平倉的單。S3 每月約 2 筆，至少 6 個月才有比較意義；
            短期內主要是確認「做的跟回測一模一樣」。停用條件：S3-A 回撤 &gt; 35% 或連虧 7 筆；S3-B 回撤 &gt; 40% 或連虧 15 筆；
            S1 回撤 &gt; 60% 或近 50 筆勝率 &lt; 45%。
          </p>
        )}
      </div>
    </div>
  );
}

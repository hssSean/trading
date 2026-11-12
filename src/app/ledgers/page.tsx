'use client';
// 帳本：S3-A／S3-B／S1／BR 四個模擬帳本（不下單，起始各 100 USDT），對照回測基準。BR = 空頭反彈做空（2026-11-12 加）。
// 資料由 /api/analyze 每天記帳（src/lib/s3s1/engine.ts），這頁透過 /api/s3/ledgers 讀取。
// 最下方 CTREND 週帳本是 EC2 每週一寫的（research/ctrend/ctrend_forward.py，2026-11-13 加）。
import { useState } from 'react';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { LedgerAcct, LedgersResp } from '@/lib/s3s1/apiTypes';
import type { CtrendSummary } from '@/lib/ctrend/view';
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
            <Row key={p.id} left={`${coin(p.symbol)}${p.side === -1 ? '（空）' : ''}・持倉中`} sub={`${fmtT(p.entryT)} 進 ${fmtPx(p.entry)}・止損 ${fmtPx(p.stop)}・風險 ${p.riskUsdt.toFixed(2)}U`} right="持倉" />
          ))}
          {a.recent.map(p => (
            <Row key={p.id} left={`${coin(p.symbol)}${p.side === -1 ? '（空）' : ''}・${fmtD(p.entryT)}→${fmtD(p.exitT)}・${EXIT_LABEL[p.exitReason ?? ''] ?? p.exitReason ?? ''}${p.partial ? '（已平 1/3）' : ''}`}
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

function CtrendCard({ c }: { c: CtrendSummary | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardTitle title="CTREND 週帳本" right={c?.openWeek ? <>持倉週 {c.openWeek.slice(5)}</> : '前向驗證'} />
      {!c ? (
        <p className="text-[#565E6B] text-[11px] mt-2 leading-4">還沒跑過。EC2 安裝後每週一 09:30（台灣）記一筆：docs/EC2-ctrend.md</p>
      ) : (
        <>
          {c.stale && <p className="text-down text-[11px] mt-1">⚠ 超過 8 天沒更新（EC2 的 ctrend.timer 可能停了）</p>}
          <Stats items={[
            ['週數', `${c.weeks}`],
            ['累積', fmtPct(c.cumNet * 100), c.cumNet],
            ['平均／週', fmtPct(c.meanNet * 100, 2), c.meanNet],
            ['t', c.tNet == null ? '—' : c.tNet.toFixed(2)],
          ]} />
          <p className="text-[#3A424E] text-[9px] mt-1 num">最後更新 {fmtT(c.lastRun)}・多 {c.topLong.map(coin).join(' ') || '—'}・空 {c.topShort.map(coin).join(' ') || '—'}</p>
          <div className="flex mt-2 border-t border-[#1B222B]">
            <button onClick={() => setOpen(o => !o)} className={`flex-1 text-[10px] py-1.5 ${open ? 'text-accent' : 'text-[#8A94A2]'}`}>最近 {c.recent.length} 週</button>
          </div>
          {open && (
            <div className="mt-1 space-y-1">
              {c.recent.length === 0 && <Empty text="第一週還沒結算" />}
              {c.recent.map(w => (
                <Row key={w.wk} left={`${w.wk} 那週`} sub={`多 ${w.nLong}／空 ${w.nShort}（幣池 ${w.nUniverse}）・換手 ${w.turnover.toFixed(2)}・前 100 ${fmtPct(w.top100.net * 100, 2)}`}
                  right={fmtPct(w.net * 100, 2)} rc={w.net} />
              ))}
            </div>
          )}
        </>
      )}
      <p className="text-[#3A424E] text-[9px] mt-1.5 leading-4">
        論文 CTREND（28 個技術指標的橫截面趨勢分數）多最高 1/5、空最低 1/5，每週一換倉；扣手續費與資金費。只記帳不下單。
        前 26 週不看結果；滿 52 週平均 &gt; 0 且 t &gt; 1.5 才考慮下一步，≤ 0 結案。
      </p>
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
        {data && <CtrendCard c={data.ctrend ?? null} />}
        {data && (
          <p className="text-[#3A424E] text-[10px] leading-4 px-1 pt-2">
            R ＝ 以止損距離為 1 單位的報酬，已扣手續費與資金費率。權益只算已平倉的單。S3 每月約 2 筆，至少 6 個月才有比較意義；
            短期內主要是確認「做的跟回測一模一樣」。停用條件：S3-A 回撤 &gt; 35% 或連虧 7 筆；S3-B 回撤 &gt; 40% 或連虧 15 筆；
            S1 回撤 &gt; 60% 或近 50 筆勝率 &lt; 45%。BR（空頭反彈做空）是前向驗證用：回測每筆只有 +0.02～+0.06R，
            滑價稍大就歸零，所以只記帳、不下單，也不設停用條件；至少累積 100 筆再判斷。
          </p>
        )}
      </div>
    </div>
  );
}

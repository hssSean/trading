#!/usr/bin/env npx tsx
/**
 * 紙上策略報表（唯讀）：策略 A（日線 Keltner）與影片策略 A/B/C 分開統計。
 *
 *   ENV_FILE=env.txt npm run paper-report
 *
 * 讀 Redis paper:<strat>:open／done（由 /api/analyze 每天 UTC 00:20 後寫入，見 src/lib/paper/runner.ts）。
 * 每套都對照規格的回測數字與規格寫的停止／放行條件。
 */
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { mean, f, summarize, maxDrawdownR } from './lib/rstats';

const D = 86_400_000, WEEK = 7 * D;
type Rec = Record<string, any>;
const parse = (v: unknown): Rec => (typeof v === 'string' ? JSON.parse(v) : v) as Rec;

// 規格的回測對照（2023 年以後；策略 A 為「上限 10 筆」實際成交的數字）
const SPEC: Record<string, { perWk: number; win: number; avgR: number; rule: string }> = {
  strategyA: { perWk: 2.2, win: 0.51, avgR: 0.35, rule: '50 筆後勝率 < 45% 或每筆平均 < 0，或回撤 > 30% → 停止並人工檢查' },
  videoA: { perWk: 43.4, win: 0.28, avgR: -0.03, rule: '100 筆後每筆平均 > +0.15R 且勝率明顯優於回測才考慮小資金，否則停止' },
  videoB: { perWk: 26.7, win: 0.26, avgR: -0.08, rule: '同上' },
  videoC: { perWk: 96.9, win: 0.32, avgR: -0.01, rule: '同上' },
};
const NAME: Record<string, string> = { strategyA: '策略 A（日線 Keltner 突破，只做多）', videoA: '影片 A（BOS＋斐波那契＋FVG）', videoB: '影片 B（流動性掃描＋CHoCH＋訂單塊）', videoC: '影片 C（EMA50＋MACD＋樞軸點）' };

/** 策略 A 規格的持倉上限：同時最多 10 筆，同日多訊號依 30 日成交額優先 */
function capped(recs: Rec[], max = 10): Rec[] {
  const sorted = recs.filter(r => r.status === 'done' || r.status === 'open')
    .sort((a, b) => a.signalT - b.signalT || b.vol30 - a.vol30);
  const active: number[] = [];
  const out: Rec[] = [];
  for (const r of sorted) {
    const enter = r.entryT;
    for (let i = active.length - 1; i >= 0; i--) if (active[i] <= enter) active.splice(i, 1);
    if (active.length >= max) continue;
    active.push(r.status === 'done' ? r.exitT : Infinity);
    out.push(r);
  }
  return out;
}

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('缺 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  const r = new Redis({ url, token });
  const meta = ((await r.hgetall('paper:meta')) ?? {}) as Rec;

  console.log('═'.repeat(92));
  console.log('  紙上策略報表（只記錄、不下單）');
  console.log('═'.repeat(92));
  if (!meta['strategyA.lastRunDay'] && !meta['video.lastRunDay']) {
    console.log('  還沒開始：Redis 沒有 paper:meta。部署後 /api/analyze 在 UTC 00:20 之後第一次掃描會開始記錄。');
    return;
  }
  const fmtT = (t: unknown) => (t ? new Date(Number(t)).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—');
  console.log(`  策略 A 起點 ${fmtT(meta['trackStart.strategyA'])}，最後執行 ${fmtT(meta['strategyA.lastRunDay'])}`);
  console.log(`  影片   起點 ${fmtT(meta['trackStart.video'])}，最後執行 ${fmtT(meta['video.lastRunDay'])}`);

  for (const strat of ['strategyA', 'videoA', 'videoB', 'videoC']) {
    const open = Object.values((await r.hgetall(`paper:${strat}:open`)) ?? {}).map(parse);
    const fin = Object.values((await r.hgetall(`paper:${strat}:done`)) ?? {}).map(parse);
    const all = [...open, ...fin];
    const done = fin.filter(x => x.status === 'done').sort((a, b) => a.exitT - b.exitT);
    const start = Number(meta[strat === 'strategyA' ? 'trackStart.strategyA' : 'trackStart.video']) || Date.now();
    const weeks = Math.max((Date.now() - start) / WEEK, 1 / 7);
    const cnt = (s: string) => all.filter(x => x.status === s).length;
    const spec = SPEC[strat];

    console.log(`\n── ${NAME[strat]} ${'─'.repeat(Math.max(0, 70 - NAME[strat].length * 2))}`);
    console.log(`  紀錄 ${all.length}：已結束 ${done.length}、持倉中 ${cnt('open')}、掛單中 ${cnt('pending')}、`
      + `未成交 ${cnt('nofill')}、同幣已有持倉而略過 ${cnt('busy')}、不交易 ${cnt('skip')}`);
    if (!done.length) { console.log('  還沒有已結束的交易。'); continue; }
    const net = done.map(x => x.netR), gross = done.map(x => x.grossR);
    const s = summarize(net);
    const wins = net.filter(x => x > 0), losses = net.filter(x => x <= 0);
    console.log(`  每週 ${(done.length / weeks).toFixed(1)} 筆（回測 ${spec.perWk}）  勝率 ${(s.win * 100).toFixed(1)}%（回測 ${(spec.win * 100).toFixed(0)}%）  `
      + `每筆淨 ${f(s.mean)}R（回測 ${f(spec.avgR, 2)}）  毛 ${f(mean(gross))}R`);
    console.log(`  95%CI [${f(s.ci[0])}, ${f(s.ci[1])}]  盈虧比 ${losses.length ? (mean(wins) / -mean(losses)).toFixed(2) : '—'}  `
      + `PF ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}  合計 ${f(net.reduce((a, b) => a + b, 0), 1)}R  最大回撤 ${maxDrawdownR(net).toFixed(1)}R`);
    if (strat === 'strategyA') {
      const cap = capped(all).filter(x => x.status === 'done').map(x => x.netR);
      if (cap.length) console.log(`  套用持倉上限 10 筆：${cap.length} 筆、每筆 ${f(mean(cap))}R、勝率 ${(cap.filter(x => x > 0).length / cap.length * 100).toFixed(1)}%`);
      const n = done.length;
      const warn = n >= 50 && (s.win < 0.45 || s.mean < 0);
      console.log(`  判準：${spec.rule} → ${n < 50 ? `還不能判（${n}/50 筆）` : warn ? '⚠ 觸發，應停止並檢查' : '✅ 未觸發'}`);
    } else {
      const n = done.length;
      const pass = n >= 100 && s.mean > 0.15 && s.win > spec.win + 0.05;
      console.log(`  判準：100 筆後每筆 > +0.15R 且勝率明顯優於回測 → ${n < 100 ? `還不能判（${n}/100 筆）` : pass ? '✅ 可考慮小資金' : '❌ 未達標，應停止'}`);
    }
  }
  console.log('\n' + '─'.repeat(92));
  console.log('  在達到筆數門檻之前，數字只是進度，不要據此決定上線或放棄。');
}

main().catch(e => { console.error('paper-report error:', e); process.exit(1); });

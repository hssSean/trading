#!/usr/bin/env npx tsx
/**
 * F1 前向紙上追蹤報表（唯讀）。
 *
 *   ENV_FILE=env.txt npm run f1-paper
 *
 * 讀 route.ts 寫進 Redis 的 f1p:open／f1p:done（見 src/lib/f1PaperRunner.ts），對照
 * 2026-09-28 事先寫死的判準：
 *
 *   滿 6 個月且 n ≥ 300：淨 R 95% CI 下界 > 0 且月加總 t ≥ 2，才考慮接真倉。
 *
 * 另外跑「同期間、同幣種、每 72h 無條件做多」對照組——回測時 F1 的優勢是「比隨便
 * 做多好」，前向也要看這個差距還在不在，不然大盤漲一波就會誤判成策略有效。
 */
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { fetchKlines, fetchFunding } from './lib/binanceData';
import { mean, f, row, tStat, bootstrapCI } from './lib/rstats';
import { F1, F1_UNIVERSE, atrSeries, simulateHold, type F1PaperTrade } from '../src/lib/f1Paper';

const H4 = 4 * 3_600_000;
const parse = (v: unknown): F1PaperTrade => (typeof v === 'string' ? JSON.parse(v) : v) as F1PaperTrade;

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('缺 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  const r = new Redis({ url, token });
  const [openRaw, doneRaw, metaRaw] = await Promise.all([
    r.hgetall('f1p:open'), r.hgetall('f1p:done'), r.hgetall('f1p:meta'),
  ]);
  const open = Object.values(openRaw ?? {}).map(parse);
  const all = Object.values(doneRaw ?? {}).map(parse);
  const done = all.filter(t => t.status === 'done').sort((a, b) => (a.exitT ?? 0) - (b.exitT ?? 0));
  const voided = all.filter(t => t.status === 'void');
  const lastT = Number((metaRaw as Record<string, unknown> | null)?.lastT);

  console.log('═'.repeat(88));
  console.log('  F1 資金費率極端值反向——前向紙上追蹤（不下單）');
  console.log('═'.repeat(88));
  if (!Number.isFinite(lastT)) {
    console.log('  還沒開始：Redis 裡沒有 f1p:meta。部署後 /api/analyze 第一次跑到就會開始記錄。');
    return;
  }
  const startT = Math.min(lastT, ...[...open, ...all].map(t => t.settlementT));
  const months = (Date.now() - startT) / (30 * 24 * 3_600_000);
  console.log(`  追蹤起點 ${new Date(startT).toISOString().slice(0, 16)}Z（${months.toFixed(1)} 個月）  最後掃描 ${new Date(lastT).toISOString().slice(0, 16)}Z`);
  console.log(`  未結算 ${open.length} 筆  已結算 ${done.length} 筆  作廢 ${voided.length} 筆`);
  if (!done.length) { console.log('\n  還沒有已結算的單（每筆要 72 小時）。'); return; }

  const net = done.map(t => t.netR!);
  console.log('');
  console.log(row('淨 R', net));
  console.log(row('做多', done.filter(t => t.dir === 1).map(t => t.netR!)));
  console.log(row('做空', done.filter(t => t.dir === -1).map(t => t.netR!)));
  const byMonth = new Map<string, number>();
  for (const t of done) { const k = new Date(t.exitT!).toISOString().slice(0, 7); byMonth.set(k, (byMonth.get(k) ?? 0) + t.netR!); }
  const monthly = Array.from(byMonth.values());
  console.log(`  月份：${Array.from(byMonth.entries()).map(([k, v]) => `${k.slice(2)} ${f(v, 1)}`).join('  ')}`);
  console.log(`  月加總 t=${f(tStat(monthly), 2)}`);

  // ── 對照組：同期間無條件做多 ──
  const end = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const from = Math.floor((startT - 25 * H4) / 86_400_000) * 86_400_000;
  const ctrl: number[] = [];
  for (const s of F1_UNIVERSE) {
    try {
      const c = await fetchKlines(s, '4h', from, end);
      const fu = await fetchFunding(s, from, end);
      const a = atrSeries(c);
      for (let i = F1.ATR_N; i < c.length; i += F1.HOLD_BARS) {
        if (c[i].openTime < startT) continue;
        const h = simulateHold(c, i, 1, F1.STOP_ATR * a[i - 1], F1.HOLD_BARS, fu);
        if (h) ctrl.push(h.netR);
      }
    } catch { /* 下架或抓不到就略過 */ }
  }
  const longs = done.filter(t => t.dir === 1).map(t => t.netR!);
  console.log('');
  console.log(row('對照：無條件做多', ctrl));
  if (longs.length && ctrl.length) console.log(`  F1 做多 − 無條件做多 = ${f(mean(longs) - mean(ctrl))}R/筆（回測時兩批幣分別約 +0.10 與 +0.04）`);

  // ── 判準 ──
  const ci = bootstrapCI(net);
  const tM = tStat(monthly);
  console.log('\n' + '─'.repeat(88));
  const ready = months >= 6 && done.length >= 300;
  if (!ready) {
    console.log(`  判定：還不能判（需滿 6 個月且 n ≥ 300；目前 ${months.toFixed(1)} 個月、n=${done.length}）`);
    console.log('  在那之前的數字只是進度，不要據此決定上線或放棄。');
  } else {
    const pass = ci[0] > 0 && tM >= 2;
    console.log(`  判定：${pass ? '✅ 通過——可以討論接真倉' : '❌ 未通過'}  CI [${f(ci[0])}, ${f(ci[1])}]  月 t=${f(tM, 2)}`);
  }
  console.log('─'.repeat(88));
}

main().catch(e => { console.error('f1-paper-report error:', e); process.exit(1); });

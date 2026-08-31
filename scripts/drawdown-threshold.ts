#!/usr/bin/env npx tsx
/**
 * 用資料訂回撤停機門檻 —— 取代目前那個「因為卡住所以從 8 調成 12」的暫定值。
 *
 * ## 這個門檻該回答什麼問題
 *
 * 回撤停機的用意是「策略可能失效，停下來讓人工檢查」。所以門檻要訂在
 * **「純靠運氣不太會發生」的位置**——訂太低會被雜訊反覆觸發（8/29 就發生了，
 * 而且那次還是假資料造成的），訂太高則等於這道關卡不存在。
 *
 * 正確的問法不是「多少 R 算大」，而是：
 *
 *   **假設策略完全沒有邊際（期望值 = 0），連續交易 N 筆，最大回撤的分布長怎樣？**
 *
 * 超過那個分布的高分位數，才是「這不像運氣」的證據。
 *
 * ## 方法
 *
 * 拿 2026-08-30 對帳得到的真實 R 序列（`npm run audit-exits` 產生的 JSON），
 * 做 bootstrap 重抽：
 *
 *   1. 從觀測到的 R 分布裡有放回地抽 N 筆，組成一條假想的權益曲線
 *   2. 算這條曲線的最大回撤
 *   3. 重複很多次，得到最大回撤的分布
 *
 * 這樣保留了真實的厚尾與波動（單筆 R 從 -1 到 +4.6 都有），不需要假設常態。
 *
 * **去均值版本才是訂門檻的依據**：觀測到的平均是負的（-0.107R），直接用會把
 * 「策略確實在虧」這件事也算進「正常波動」，門檻就會被訂得過寬。去掉漂移、
 * 只留波動，問的才是「純雜訊能造成多大回撤」。
 *
 * 用法：
 *   npx tsx scripts/drawdown-threshold.ts [報告.json] [每段筆數] [模擬次數]
 */

import { readFileSync, existsSync } from 'fs';

const reportPath = process.argv[2] ?? 'audit-fabricated-exits-2026-08-30.json';
const N = Number(process.argv[3] ?? 50);      // 一段觀察期大約幾筆交易
const RUNS = Number(process.argv[4] ?? 20000);

/** 一條權益曲線的最大回撤（從高點到之後谷底的最大跌幅，R）。 */
function maxDrawdown(rs: number[]): number {
  let equity = 0, peak = 0, worst = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > worst) worst = dd;
  }
  return worst;
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i];
}

function simulate(pool: number[], n: number, runs: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < runs; k++) {
    const path: number[] = [];
    for (let i = 0; i < n; i++) path.push(pool[Math.floor(Math.random() * pool.length)]);
    out.push(maxDrawdown(path));
  }
  return out.sort((a, b) => a - b);
}

function main() {
  if (!existsSync(reportPath)) {
    throw new Error(`找不到 ${reportPath}——先跑 npm run audit-exits`);
  }
  const findings = (JSON.parse(readFileSync(reportPath, 'utf-8')).findings ?? []) as
    { realR: number | null }[];
  const observed = findings
    .map(f => f.realR)
    .filter((r): r is number => r != null && Number.isFinite(r));

  if (observed.length < 20) throw new Error(`樣本太少（${observed.length}），結論不會有意義`);

  const mean = observed.reduce((s, v) => s + v, 0) / observed.length;
  const sd = Math.sqrt(observed.reduce((s, v) => s + (v - mean) ** 2, 0) / (observed.length - 1));
  const demeaned = observed.map(v => v - mean); // 去漂移，只留波動

  console.log(`樣本 n=${observed.length}  每筆 ${mean.toFixed(3)}R  sd ${sd.toFixed(2)}`);
  console.log(`模擬：每段 ${N} 筆 × ${RUNS} 次 bootstrap 重抽\n`);

  const rows: Array<[string, number[]]> = [
    ['期望值=0（訂門檻用這個）', simulate(demeaned, N, RUNS)],
    ['照觀測分布（含負漂移）', simulate(observed, N, RUNS)],
  ];

  console.log('最大回撤分布（R）');
  console.log('                              中位數    p90     p95     p99');
  for (const [label, dd] of rows) {
    console.log(`  ${label.padEnd(26)}`
      + `${percentile(dd, 0.5).toFixed(2).padStart(6)}  `
      + `${percentile(dd, 0.9).toFixed(2).padStart(6)}  `
      + `${percentile(dd, 0.95).toFixed(2).padStart(6)}  `
      + `${percentile(dd, 0.99).toFixed(2).padStart(6)}`);
  }

  const nullDd = rows[0][1];
  const p95 = percentile(nullDd, 0.95);
  const p99 = percentile(nullDd, 0.99);

  console.log(`\n目前設定 MAX_DRAWDOWN_R = 12（暫定值，原本是 8）`);
  const pctAbove = (t: number) => nullDd.filter(d => d >= t).length / nullDd.length * 100;
  for (const t of [8, 10, 12]) {
    console.log(`  門檻 ${String(t).padStart(2)}R → 純雜訊觸發率 ${pctAbove(t).toFixed(1)}%（每 ${N} 筆一段）`);
  }

  console.log(`\n建議：p95 = ${p95.toFixed(1)}R、p99 = ${p99.toFixed(1)}R`);
  console.log(`  取 p95 代表「每 20 段會有 1 段被雜訊誤觸發」——那不算失控，`);
  console.log(`  因為解除只需要人看一眼按一顆按鈕，而漏擋的代價是繼續虧。`);
  console.log(`\n⚠ 這個結果會隨樣本改變。n 還小（檢定力邊界 |mean R| > 0.31R），`);
  console.log(`  累積更多乾淨交易後要重跑。不要把它當成定案。`);
}

try { main(); } catch (e) {
  console.error('中止：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}

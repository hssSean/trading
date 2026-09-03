#!/usr/bin/env npx tsx
/**
 * 策略結構體檢 —— 回答「這套設計本身站不站得住」，而不是「它有沒有邊際」。
 *
 * ## 為什麼要跟顯著性檢定分開
 *
 * `audit-exits` 回答的是「平均 R 是不是 ≠ 0」，那需要大樣本（sd=1.30 之下要
 * n≈680）。但有些問題**不需要等樣本**就能看出來：
 *
 *   1. **成本占比** —— 手續費與資金費率是確定性的支出，不是隨機變數。
 *      如果淨虧損有一半來自成本，那問題在交易頻率／持倉時間，不在訊號品質。
 *   2. **賠率結構** —— 勝率配上平均賺賠比，直接決定期望值的正負。
 *      如果觀測到的結構在數學上就是負的，那不是運氣問題。
 *   3. **集中度** —— 總報酬如果全靠少數幾筆撐著，代表策略脆弱：那幾筆換成
 *      平庸的結果，整體就崩掉。這在小樣本下特別容易被誤讀成「有效」。
 *
 * 這三個都是**結構性**的，看得出來就是看得出來，不必等統計顯著。
 *
 * 用法：
 *   npx tsx scripts/strategy-health.ts [報告.json] [天數]
 *
 * 報告來自 `npm run audit-exits`（需要 realR）。成本從幣安 income 直接抓。
 */

import { readFileSync, existsSync } from 'fs';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../src/engine/binanceClient';
import { sumTradingIncome } from '../src/lib/dailyLossCap';

const reportPath = process.argv[2] ?? 'audit-fabricated-exits-2026-09-02.json';
const DAYS = Number(process.argv[3] ?? 90);

const fmt = (n: number, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '—';
const pad = (s: string | number, n: number) => String(s).padStart(n);

async function main() {
  reportEnvLoad(loadEnvFile());
  if (!existsSync(reportPath)) throw new Error(`找不到 ${reportPath}——先跑 npm run audit-exits`);

  const findings = (JSON.parse(readFileSync(reportPath, 'utf-8')).findings ?? []) as
    Array<{ realR: number | null; realizedPnlUsdt: number | null; symbol: string }>;
  const rs = findings.map(f => f.realR).filter((r): r is number => r != null && Number.isFinite(r));
  if (rs.length < 10) throw new Error(`樣本太少（${rs.length}）`);

  // ── 1. 賠率結構 ──
  //
  // 期望值 = 勝率 × 平均賺 + 敗率 × 平均賠。這是恆等式，不是估計——只要
  // 三個數字量準了，正負就定了。所以它能在樣本不足以做顯著性檢定時，
  // 仍然告訴你「這個結構有沒有機會是正的」。
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r <= 0);
  const winRate = wins.length / rs.length;
  const avgWin = wins.length ? wins.reduce((s, v) => s + v, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  // 讓期望值 = 0 所需的勝率。avgLoss 是負數，取絕對值。
  const breakevenWR = Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss));

  console.log(`\n${'='.repeat(70)}`);
  console.log(`賠率結構（n=${rs.length}）`);
  console.log('='.repeat(70));
  console.log(`  勝率          ${pad(fmt(winRate * 100, 1), 7)}%   （${wins.length} 勝 / ${losses.length} 敗）`);
  console.log(`  平均賺        ${pad(fmt(avgWin, 3), 7)}R`);
  console.log(`  平均賠        ${pad(fmt(avgLoss, 3), 7)}R`);
  console.log(`  期望值        ${pad(fmt(expectancy, 3), 7)}R / 筆`);
  console.log(`  損益兩平勝率  ${pad(fmt(breakevenWR * 100, 1), 7)}%   ← 目前 ${fmt(winRate * 100, 1)}%`);
  const gap = winRate - breakevenWR;
  console.log(`  ${gap >= 0 ? '✅ 勝率高於兩平點' : `⚠ 勝率低於兩平點 ${fmt(Math.abs(gap) * 100, 1)} 個百分點`}`);

  // ── 2. 集中度 ──
  //
  // 總報酬全靠少數幾筆撐著＝脆弱。小樣本下這件事特別容易被誤讀：拿掉那幾筆
  // 就翻負的策略，其實只是「剛好抽到幾根長尾」，不是有邊際。
  const sorted = [...rs].sort((a, b) => b - a);
  const total = rs.reduce((s, v) => s + v, 0);
  console.log(`\n${'='.repeat(70)}`);
  console.log('集中度：報酬有多依賴少數幾筆');
  console.log('='.repeat(70));
  console.log(`  合計                ${pad(fmt(total), 8)}R`);
  for (const k of [1, 3, 5]) {
    if (k > sorted.length) break;
    const topSum = sorted.slice(0, k).reduce((s, v) => s + v, 0);
    const without = total - topSum;
    console.log(`  拿掉最好的 ${k} 筆     ${pad(fmt(without), 8)}R   （那 ${k} 筆貢獻 ${fmt(topSum)}R）`);
  }
  console.log(`  拿掉贏家就大幅惡化＝報酬集中在長尾，小樣本下不能當成邊際的證據。`);

  // ── 3. 成本占比 ──
  //
  // 手續費與資金費率是**確定性支出**，不是隨機變數——它們不會因為樣本變大
  // 就往 0 收斂。所以如果淨虧損有相當比例來自成本，那是可以直接處理的問題
  // （降低頻率、縮短持倉），跟訊號品質無關。
  if (process.env.BINANCE_TESTNET_API_KEY) {
    const client = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
    const since = Date.now() - DAYS * 24 * 3600 * 1000;
    const WINDOW = 7 * 24 * 3600 * 1000;
    const rows: Array<{ incomeType: string; income: string; time: number }> = [];
    for (let s = since; s < Date.now(); s += WINDOW) {
      const batch = await client.getIncome({
        startTime: s, endTime: Math.min(s + WINDOW, Date.now()), limit: 1000,
      });
      rows.push(...batch);
      await new Promise(r => setTimeout(r, 250));
    }

    const by = (t: string) => rows.filter(r => r.incomeType === t)
      .reduce((s, r) => s + (parseFloat(r.income) || 0), 0);
    const pnl = by('REALIZED_PNL');
    const fee = by('COMMISSION');
    const fund = by('FUNDING_FEE');
    const net = sumTradingIncome(rows, since);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`成本結構（${DAYS} 天，交易所帳）`);
    console.log('='.repeat(70));
    console.log(`  毛已實現損益   ${pad(fmt(pnl), 10)} USDT`);
    console.log(`  手續費         ${pad(fmt(fee), 10)} USDT`);
    console.log(`  資金費率       ${pad(fmt(fund), 10)} USDT`);
    console.log(`  ────────────────────────────`);
    console.log(`  淨             ${pad(fmt(net), 10)} USDT`);

    const costs = Math.abs(fee) + Math.abs(fund);
    if (net < 0) {
      console.log(`\n  成本占淨虧損 ${fmt(costs / Math.abs(net) * 100, 1)}%`);
      if (costs > Math.abs(net) * 0.5) {
        console.log(`  ⚠ **成本是虧損的主要來源。** 這是交易頻率／持倉時間的問題，`);
        console.log(`     不是訊號品質的問題——調評分權重不會改善它。`);
      } else if (pnl < 0) {
        console.log(`  毛損益本身就是負的（${fmt(pnl)} USDT），成本只是加重。`);
      }
    } else {
      console.log(`\n  淨為正。`);
    }
  } else {
    console.log('\n（未設 BINANCE_TESTNET_API_KEY，跳過成本分析）');
  }
  console.log('');
}

main().catch(e => {
  console.error('中止：', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

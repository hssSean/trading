#!/usr/bin/env npx tsx
/**
 * Backtest framework — Phase 7 (standalone; zero production impact)
 *
 * Usage:
 *   npx tsx scripts/backtest.ts [SYMBOL] [MONTHS]
 *   npx tsx scripts/backtest.ts BTCUSDT 12
 *   npx tsx scripts/backtest.ts ETHUSDT 6
 *
 * Fetches Binance perpetual-futures 1H klines, runs Strategy A + B signal
 * generators on a rolling window, simulates trades with fees and slippage,
 * and prints per-strategy statistics.
 *
 * 規則與成本模型：scripts/lib/liveReplica.ts（與 verify-strategy.ts 共用）
 *   進場：限價掛單 4 根內成交（Maker 0.02%），先碰 TP1 取消；夠強時市價（Taker 0.05% + 滑價 0.03%）
 *   出場：TP1 50% 部分停利、0.5R 保本、2×ATR 移動止損、8 根停滯、24h 到期；同根 TP/SL 判 SL
 *   出場手續費一律 Taker（條件單觸發後市價）；止損類再加 0.05% 滑價
 */

import axios from 'axios';
import { pathToFileURL } from 'node:url';
import type { Candle, TradingSignal } from '../src/types';
import { generateSignals, generateMeanReversionSignals } from '../src/analysis/signals';
import { shouldEnterAtMarket, shiftSignalToMarketEntry } from '../src/lib/marketEntryException';
import { BASELINE, rollingAtr } from './exit-compare';
import {
  LIVE, MAKER, TAKER, ENTRY_SLIP, STOP_SLIP, aggregate4h, makeFourHView, adx4hAt, RegimeTracker,
  closes4hWithForming, ema200Bias, simulateFill, simulateExitAfterFill, tradeCostR,
} from './lib/liveReplica';

// ── Constants ─────────────────────────────────────────────────
const WARMUP      = 250;     // candles consumed as indicator warmup (not traded)
const WINDOW_1H   = 200;     // rolling 1H candle window passed to signal generators
// 2026-08-26：這兩個值原本是 70 / 15，而註解寫著「matches route.ts」——**是錯的**。
// route.ts 實際是 STRONG_THRESHOLD = 65、STRONG_THRESHOLD_B = 13。
//
// 影響不是小數點：真實資料顯示 65-70 那一格是所有分數區間裡**最賠的**
// （n=21，每筆 -0.351R），而那整段被回測排除掉了。也就是回測與所有依賴它的
// 模擬（exit-compare / entry-compare）都跑在比線上更嚴格、更好看的子集上，
// 基準線會系統性偏樂觀。
//
// 改動門檻會改變回測產生的訊號集合，所以這個 commit 之前跑出來的模擬數字
// 不能跟之後的直接比較——要比就整批重跑。
const MIN_SCORE_A = LIVE.STRONG_THRESHOLD;      // Strategy A: 0-100 scale — route.ts STRONG_THRESHOLD
const MIN_SCORE_B = LIVE.STRONG_THRESHOLD_B;      // Strategy B: 0-19 scale  — route.ts STRONG_THRESHOLD_B

const client = axios.create({
  baseURL: 'https://fapi.binance.com/fapi/v1',
  timeout: 15_000,
});

// ── Fetch helpers ─────────────────────────────────────────────
async function fetchPage(
  symbol: string,
  startTime: number,
  limit = 1000,
): Promise<Candle[]> {
  const { data } = await client.get('/klines', {
    params: { symbol, interval: '1h', startTime, limit },
  });
  return (data as unknown[][]).map(k => ({
    openTime:  k[0] as number,
    open:      parseFloat(k[1] as string),
    high:      parseFloat(k[2] as string),
    low:       parseFloat(k[3] as string),
    close:     parseFloat(k[4] as string),
    volume:    parseFloat(k[5] as string),
    closeTime: k[6] as number,
  }));
}

export async function fetchHistorical(symbol: string, months: number): Promise<Candle[]> {
  const totalMs = months * 30 * 24 * 3_600_000;
  // Fetch extra warmup bars so the first tradeable candle already has full indicator history
  const startMs = Date.now() - totalMs - WARMUP * 3_600_000;
  const endMs   = Date.now() - 3_600_000; // exclude the current incomplete candle

  const all: Candle[] = [];
  let from = startMs;

  while (from < endMs) {
    const batch = await fetchPage(symbol, from);
    if (!batch.length) break;
    all.push(...batch);
    from = batch[batch.length - 1].openTime + 3_600_000;
    if (batch.length < 1000) break; // last page
    await new Promise(r => setTimeout(r, 250)); // stay under Binance rate limit
  }

  // Deduplicate by openTime (safety net for overlapping pages)
  const seen = new Set<number>();
  return all.filter(c => {
    if (seen.has(c.openTime)) return false;
    seen.add(c.openTime);
    return true;
  });
}

// ── Simulation ────────────────────────────────────────────────
//
// 2026-09-24（scripts/verify-strategy.ts 檢查 B3/B4/B5/B9/B10）：這裡原本自己
// 寫了一份 regime 與出場模型，全部跟線上分岔——
//   B3  ADX >25／<20 且沒有遲滯（線上 ≥23／≤18，18-23 沿用前一狀態）
//   B4  htfBias 傳 null（線上傳 4H EMA200 方向，逆向的 1H 單被 confluence 擋）
//   B5  碰到 TP1 就全部平倉、同根 TP1+SL 判 TP1 贏，沒有部分停利／保本／移動
//       止損／停滯／到期，進場也不是限價掛單
//   B9  4H 用陣列長度對齊，不在 UTC 4H 邊界上
//   B10 「540 根 4H」實際只切 540 根 1H（= 135 根 4H）
// `npm run backtest` 量到的是另一個策略。現在改用 scripts/lib/liveReplica.ts
// （verify-strategy.ts 也用這一份），只保留 runBacktest／SimTrade 的介面給
// universe-compare.ts。完整的線上重現（BTC 大盤濾網、冷卻、資金費率）請用
// scripts/verify-strategy.ts；這支只用 1H K 線，沒有那些需要額外資料的關卡。
export interface SimTrade {
  openIdx:   number;
  closeIdx:  number;
  direction: 'LONG' | 'SHORT';
  strategy:  'A' | 'B';
  entry:     number; // 實際成交價
  sl:        number;
  tp1:       number;
  tp2:       number;
  exitReason: string;
  result:    'WIN_TP2' | 'WIN_TP1' | 'LOSS';
  pnlPct:    number; // 淨報酬 %（扣手續費＋滑價），= 淨 R × 止損距離 %
  month:     string; // YYYY-MM for monthly bucketing
}

export function runBacktest(symbol: string, candles: Candle[]): SimTrade[] {
  const trades: SimTrade[] = [];
  const v4 = makeFourHView(aggregate4h(candles));
  const atr = rollingAtr(candles);
  const tracker = new RegimeTracker();
  let busyUntilIdx = -1;
  // Track consecutive strategy-B stop-outs per symbol for pause logic
  let stratBConsecLoss = 0;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const T = candles[i].closeTime + 1;
    const a = adx4hAt(v4, T);
    if (isNaN(a)) continue;
    const regime = tracker.next(a); // 遲滯狀態每根都推進
    if (i <= busyUntilIdx || regime === 'transitional') continue;

    const window1h = candles.slice(Math.max(0, i - WINDOW_1H + 1), i + 1);
    let sig: TradingSignal | undefined;
    let bias: 'LONG' | 'SHORT' | null = null;
    if (regime === 'ranging' && stratBConsecLoss < 2) {
      sig = generateMeanReversionSignals(symbol, '1h', window1h)
        .filter(s => s.score >= MIN_SCORE_B)
        .sort((x, y) => y.score - x.score)[0];
    } else {
      bias = ema200Bias(closes4hWithForming(v4, T, candles[i].close, 250));
      sig = generateSignals(symbol, '1h', window1h, bias, regime)
        .filter(s => s.tier || s.score >= MIN_SCORE_A)
        .sort((x, y) => y.score - x.score)[0];
      if (sig && !(bias === null || bias === sig.direction)) continue; // confluence
    }
    if (!sig) continue;

    const isLong = sig.direction === 'LONG';
    let lv = { entry: sig.entry, stopLoss: sig.stopLoss, tp1: sig.takeProfits[0], tp2: sig.takeProfits[1] ?? sig.takeProfits[0], isLong };
    const market = shouldEnterAtMarket(sig, MIN_SCORE_A + 10, bias === sig.direction);
    if (market) {
      const s = shiftSignalToMarketEntry(sig);
      lv = { ...lv, entry: s.entry, stopLoss: s.stopLoss, tp1: s.takeProfits[0], tp2: s.takeProfits[1] ?? s.takeProfits[0] };
    }

    const fill = simulateFill(candles, i, lv, market);
    if (fill.kind !== 'filled') { busyUntilIdx = i + LIVE.WAITING_EXPIRY_BARS; continue; }
    const riskPct = Math.abs(fill.price - lv.stopLoss) / fill.price;
    if (!(riskPct > 0)) continue;
    const ex = simulateExitAfterFill(candles, atr, fill.idx, fill.price, lv, market, BASELINE);
    if (!ex) break; // 資料尾端

    const netR = ex.grossR - tradeCostR(riskPct, market, ex.reason, ex.tp1Hit);
    const result: SimTrade['result'] =
      ex.reason === 'tp2' ? 'WIN_TP2' : ex.reason === 'stop' ? 'LOSS' : netR > 0 ? 'WIN_TP1' : 'LOSS';
    const dt = new Date(candles[ex.exitIdx].openTime);
    const strategy = sig.strategy === 'B' ? 'B' : 'A';
    trades.push({
      openIdx: fill.idx, closeIdx: ex.exitIdx, direction: sig.direction, strategy,
      entry: fill.price, sl: lv.stopLoss, tp1: lv.tp1, tp2: lv.tp2, exitReason: ex.reason, result,
      pnlPct: parseFloat((netR * riskPct * 100).toFixed(4)),
      month: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`,
    });
    if (strategy === 'B') stratBConsecLoss = ex.reason === 'stop' ? stratBConsecLoss + 1 : 0;
    busyUntilIdx = ex.exitIdx;
  }

  return trades;
}


// ── Statistics ────────────────────────────────────────────────
function printStats(trades: SimTrade[], label: string): void {
  if (trades.length === 0) {
    console.log(`\n── ${label} ──\n  (no trades)`);
    return;
  }

  const wins   = trades.filter(t => t.result !== 'LOSS');
  const losses = trades.filter(t => t.result === 'LOSS');
  const pnls   = trades.map(t => t.pnlPct);
  const winPnl  = wins.map(t => t.pnlPct);
  const lossPnl = losses.map(t => t.pnlPct);

  const winRate   = wins.length / trades.length;
  const avgWin    = winPnl.length  ? winPnl.reduce((s, v)  => s + v, 0) / winPnl.length  : 0;
  const avgLoss   = lossPnl.length ? lossPnl.reduce((s, v) => s + v, 0) / lossPnl.length : 0;
  const rrRatio   = avgLoss < 0    ? -avgWin / avgLoss : NaN;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const cumPnl    = pnls.reduce((s, v) => s + v, 0);

  // Max drawdown (peak-to-trough on equity curve)
  let peak = 0, maxDD = 0, equity = 0;
  for (const p of pnls) {
    equity += p;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Monthly PnL buckets
  const monthly: Record<string, number> = {};
  trades.forEach(t => { monthly[t.month] = (monthly[t.month] ?? 0) + t.pnlPct; });
  const monthVals  = Object.values(monthly);
  const meanMonth  = monthVals.reduce((s, v) => s + v, 0) / (monthVals.length || 1);
  const stdMonth   = monthVals.length > 1
    ? Math.sqrt(monthVals.reduce((s, v) => s + (v - meanMonth) ** 2, 0) / (monthVals.length - 1))
    : 0;
  const sharpe = stdMonth > 0 ? (meanMonth / stdMonth) * Math.sqrt(12) : 0;

  console.log(`
── ${label} ──
  Trades        : ${trades.length}  (wins: ${wins.length}, losses: ${losses.length})
  Win rate      : ${(winRate * 100).toFixed(1)}%
  Avg win       : +${avgWin.toFixed(2)}%
  Avg loss      : ${avgLoss.toFixed(2)}%
  P&L ratio     : ${isNaN(rrRatio) ? 'N/A' : rrRatio.toFixed(2) + 'x'}
  Expectancy    : ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}% / trade
  Cumulative PnL: ${cumPnl >= 0 ? '+' : ''}${cumPnl.toFixed(2)}%
  Max drawdown  : -${maxDD.toFixed(2)}%
  Sharpe (ann.) : ${sharpe.toFixed(2)}

  Monthly PnL:`);
  Object.entries(monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([m, v]) =>
      console.log(`    ${m}  ${v >= 0 ? '+' : ''}${v.toFixed(2)}%  ${v >= 0 ? '▲' : '▼'}`));
}

// ── Entry point ───────────────────────────────────────────────
async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? 'BTCUSDT').toUpperCase();
  const months = Math.max(1, parseInt(process.argv[3] ?? '12', 10));

  console.log('='.repeat(60));
  console.log(`  Backtest: ${symbol}  |  ${months} months`);
  console.log(`  Fee: maker ${(MAKER * 100).toFixed(2)}% / taker ${(TAKER * 100).toFixed(2)}%   Slippage: entry ${(ENTRY_SLIP * 100).toFixed(2)}% / stop ${(STOP_SLIP * 100).toFixed(2)}%`);
  console.log('='.repeat(60));
  console.log('Fetching historical 1H candles from Binance futures...');

  const candles = await fetchHistorical(symbol, months);
  if (candles.length < WARMUP + 10) {
    console.error(`Not enough candles (${candles.length}) — try more months.`);
    process.exit(1);
  }

  const from = new Date(candles[0].openTime).toISOString().slice(0, 10);
  const to   = new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10);
  console.log(`Loaded ${candles.length} candles  (${from} → ${to})\n`);
  console.log('Running simulation...');

  const trades = runBacktest(symbol, candles);

  const tradesA = trades.filter(t => t.strategy === 'A');
  const tradesB = trades.filter(t => t.strategy === 'B');

  console.log(`\nTotal trades executed: ${trades.length}  (A=${tradesA.length}, B=${tradesB.length})`);

  printStats(tradesA, 'Strategy A — Trend Following');
  printStats(tradesB, 'Strategy B — Mean Reversion');
  printStats(trades,  'Combined');
}

// 只有直接執行這支腳本時才跑 main。加這個判斷是為了讓 universe-compare.ts
// 能 import runBacktest/fetchHistorical 重用同一套模擬邏輯——複製一份出去
// 遲早會跟這裡分岔，而兩個群組如果跑在不同管線上，比較結果就沒有意義了。
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(err => {
    console.error('Backtest error:', err);
    process.exit(1);
  });
}

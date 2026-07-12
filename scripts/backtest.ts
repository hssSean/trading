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
 * Cost model
 *   Fee:      0.05% per side (Binance maker/taker)
 *   Slippage: 0.03% adverse on entry (applied to the limit/entry price)
 *   Exit:     at exact TP1 / TP2 / SL price (no exit slippage assumed for limit orders)
 */

import axios from 'axios';
import type { Candle, TradingSignal } from '../src/types';
import { generateSignals, generateMeanReversionSignals } from '../src/analysis/signals';
import { adx } from '../src/analysis/indicators';

// ── Constants ─────────────────────────────────────────────────
const FEE         = 0.0005;  // 0.05% per side
const SLIP        = 0.0003;  // 0.03% adverse slippage on entry
const WARMUP      = 250;     // candles consumed as indicator warmup (not traded)
const WINDOW_1H   = 200;     // rolling 1H candle window passed to signal generators
const WINDOW_4H   = 540;     // rolling 4H candle count for ADX regime (90 days)
const MIN_SCORE_A = 70;      // Strategy A: 0-100 scale (matches STRONG_THRESHOLD in route.ts)
const MIN_SCORE_B = 15;      // Strategy B: 0-19 scale  (matches STRONG_THRESHOLD_B)

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

async function fetchHistorical(symbol: string, months: number): Promise<Candle[]> {
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

// ── 4H derivation from 1H candles ────────────────────────────
function derive4h(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  // Align to the most-recent complete 4H block
  const rem = candles.length % 4;
  const start = rem === 0 ? 0 : rem; // skip incomplete leading block
  for (let i = start; i + 3 < candles.length; i += 4) {
    const g = candles.slice(i, i + 4);
    out.push({
      openTime:  g[0].openTime,
      open:      g[0].open,
      high:      Math.max(...g.map(c => c.high)),
      low:       Math.min(...g.map(c => c.low)),
      close:     g[3].close,
      volume:    g.reduce((s, c) => s + c.volume, 0),
      closeTime: g[3].closeTime,
    });
  }
  return out;
}

// ── Regime determination ──────────────────────────────────────
type Regime = 'trending' | 'ranging' | 'transitional';

function getRegime(candles1h: Candle[], upToIdx: number): Regime {
  const start4h = Math.max(0, upToIdx - WINDOW_4H + 1);
  const slice4h = derive4h(candles1h.slice(start4h, upToIdx + 1));
  const { adx: adxVal } = adx(slice4h, 14);
  if (isNaN(adxVal)) return 'ranging'; // fallback to Strategy A-eligible (safe)
  if (adxVal > 25)   return 'trending';
  if (adxVal < 20)   return 'ranging';
  return 'transitional';
}

// ── Simulation types ──────────────────────────────────────────
interface SimTrade {
  openIdx:   number;
  closeIdx:  number;
  direction: 'LONG' | 'SHORT';
  strategy:  'A' | 'B';
  entry:     number;
  sl:        number;
  tp1:       number;
  tp2:       number;
  exitPrice: number;
  result:    'WIN_TP2' | 'WIN_TP1' | 'LOSS';
  pnlPct:    number; // net % including 2× fee + entry slippage
  month:     string; // YYYY-MM for monthly bucketing
}

// ── Core simulation ───────────────────────────────────────────
function runBacktest(symbol: string, candles: Candle[]): SimTrade[] {
  const trades: SimTrade[] = [];
  let openTrade: { signal: TradingSignal; openIdx: number } | null = null;
  // Track consecutive strategy-B losses per symbol for pause logic
  let stratBConsecLoss = 0;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const c      = candles[i];
    const isLong = openTrade?.signal.direction === 'LONG';

    // ── If there is an open trade, scan this candle for TP/SL ──
    if (openTrade) {
      const sig = openTrade.signal;
      const tp1 = sig.takeProfits[0];
      const tp2 = sig.takeProfits[1] ?? tp1;
      const sl  = sig.stopLoss;

      // Same-candle conflict ordering: TP1 first → TP2 → SL
      // (mirrors live monitorActiveTrades logic)
      const hitTp1 = isLong ? c.high >= tp1 : c.low  <= tp1;
      const hitTp2 = isLong ? c.high >= tp2 : c.low  <= tp2;
      const hitSl  = isLong ? c.low  <= sl  : c.high >= sl;

      let exitPrice: number | null = null;
      let result:    SimTrade['result'] | null = null;

      if (hitTp1 && hitSl && !hitTp2) {
        // Same candle — TP1 wins (conservative: price touched TP1 first)
        exitPrice = tp1; result = 'WIN_TP1';
      } else if (hitTp2) {
        exitPrice = tp2; result = 'WIN_TP2';
      } else if (hitTp1) {
        exitPrice = tp1; result = 'WIN_TP1';
      } else if (hitSl) {
        exitPrice = sl;  result = 'LOSS';
      }

      if (exitPrice !== null && result !== null) {
        const entry  = sig.entry;
        const gross  = sig.direction === 'LONG'
          ? (exitPrice - entry) / entry
          : (entry - exitPrice) / entry;
        const net    = gross - 2 * FEE; // fee on entry + exit; slippage already baked into entry
        const dt     = new Date(c.openTime);

        const simTrade: SimTrade = {
          openIdx:   openTrade.openIdx,
          closeIdx:  i,
          direction: sig.direction,
          strategy:  (sig.strategy ?? 'A') as 'A' | 'B',
          entry,
          sl,
          tp1,
          tp2,
          exitPrice,
          result,
          pnlPct:    parseFloat((net * 100).toFixed(4)),
          month:     `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`,
        };
        trades.push(simTrade);

        // Update strategy B consecutive-loss counter
        if (simTrade.strategy === 'B') {
          stratBConsecLoss = result === 'LOSS' ? stratBConsecLoss + 1 : 0;
        }

        openTrade = null;
      }
      continue;
    }

    // ── No open trade — look for new signal ─────────────────────
    const regime = getRegime(candles, i);
    if (regime === 'transitional') continue;

    const window1h = candles.slice(Math.max(0, i - WINDOW_1H + 1), i + 1);
    let bestSig: TradingSignal | null = null;

    if (regime === 'ranging') {
      // Strategy B pause: 2 consecutive losses → skip
      if (stratBConsecLoss >= 2) continue;
      const sigs = generateMeanReversionSignals(symbol, '1h', window1h);
      bestSig = sigs
        .filter(s => s.score >= MIN_SCORE_B)
        .sort((a, b) => b.score - a.score)[0] ?? null;
    } else {
      // Strategy A — trending
      const sigs = generateSignals(symbol, '1h', window1h, null, regime);
      bestSig = sigs
        .filter(s => s.score >= MIN_SCORE_A)
        .sort((a, b) => b.score - a.score)[0] ?? null;
    }

    if (!bestSig) continue;

    // Apply entry slippage adversely
    const slippedEntry = bestSig.direction === 'LONG'
      ? bestSig.entry * (1 + SLIP)
      : bestSig.entry * (1 - SLIP);

    openTrade = {
      signal: { ...bestSig, entry: slippedEntry },
      openIdx: i,
    };
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
  console.log(`  Fee: ${(FEE * 100).toFixed(2)}% / side   Slippage: ${(SLIP * 100).toFixed(2)}% (entry)`);
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

main().catch(err => {
  console.error('Backtest error:', err);
  process.exit(1);
});

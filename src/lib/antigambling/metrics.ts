// 移植自 core/metrics/performance.py（逐函式對照）。
// 同時看多個互補角度：單看勝率會騙人，單看總獲利也會騙人。

import { AgTradeLog, contractValue, holdingDays, isDayTrade, returnPct, sortedByTime } from './models';

// 當沖佔比門檻：超過（含）此值視為「以當沖為主」
export const INTRADAY_RATIO_THRESHOLD = 0.7;

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;

  winRate: number;
  avgWin: number;
  avgLoss: number;       // 取正值
  payoffRatio: number;   // 可能為 Infinity（無虧損 → 不適用）
  profitFactor: number;

  expectancy: number;
  expectancyR: number;

  totalPnl: number;
  totalFees: number;
  grossProfit: number;
  grossLoss: number;

  maxDrawdown: number;
  maxDrawdownPct: number;
  maxConsecutiveLosses: number;
  sharpe: number;
  sortino: number;

  rMultiples: number[];
  largestWin: number;
  largestLoss: number;
  topTradePnlShare: number;

  avgHoldingDays: number;
  isMostlyIntraday: boolean;
  drawdownPctReliable: boolean;
}

function emptyMetrics(): PerformanceMetrics {
  return {
    totalTrades: 0, wins: 0, losses: 0, breakeven: 0,
    winRate: 0, avgWin: 0, avgLoss: 0, payoffRatio: 0, profitFactor: 0,
    expectancy: 0, expectancyR: 0,
    totalPnl: 0, totalFees: 0, grossProfit: 0, grossLoss: 0,
    maxDrawdown: 0, maxDrawdownPct: 0, maxConsecutiveLosses: 0, sharpe: 0, sortino: 0,
    rMultiples: [], largestWin: 0, largestLoss: 0, topTradePnlShare: 0,
    avgHoldingDays: 0, isMostlyIntraday: false, drawdownPctReliable: true,
  };
}

/** 「缺資料歸零」型除法（勝率、平均）。 */
function safeDiv(a: number, b: number): number {
  return b ? a / b : 0.0;
}

/** 「上界無限」型除法：無虧損時的盈虧比/獲利因子是「不適用」→ Infinity。 */
function ratio(num: number, den: number): number {
  if (den) return num / den;
  if (num > 0) return Infinity;
  if (num < 0) return -Infinity;
  return 0.0;
}

/** 比率顯示：Infinity → 「∞（無虧損/無下行）」，絕不印成 0。 */
export function fmtRatio(x: number, decimals = 2): string {
  if (!Number.isFinite(x)) return x > 0 ? '∞（無虧損/無下行）' : 'N/A';
  return x.toFixed(decimals);
}

/** 從交易紀錄計算完整績效指標 —— 對照 compute_metrics。 */
export function computeMetrics(log: AgTradeLog): PerformanceMetrics {
  const m = emptyMetrics();
  const trades = sortedByTime(log).trades;
  m.totalTrades = trades.length;
  if (trades.length === 0) return m;

  const pnls = trades.map(t => t.pnl);
  const returns = trades.map(t => returnPct(t));

  const winPnls = pnls.filter(p => p > 0);
  const lossPnls = pnls.filter(p => p < 0);

  m.wins = winPnls.length;
  m.losses = lossPnls.length;
  m.breakeven = m.totalTrades - m.wins - m.losses;

  m.winRate = safeDiv(m.wins, m.totalTrades);
  let gp = 0; for (const p of winPnls) gp += p;
  let gl = 0; for (const p of lossPnls) gl += p;
  m.grossProfit = gp;
  m.grossLoss = Math.abs(gl);
  let tp = 0; for (const p of pnls) tp += p;
  m.totalPnl = tp;
  let tf = 0; for (const t of trades) tf += t.fees;
  m.totalFees = tf;

  m.avgWin = safeDiv(m.grossProfit, m.wins);
  m.avgLoss = safeDiv(m.grossLoss, m.losses);
  m.payoffRatio = ratio(m.avgWin, m.avgLoss);
  m.profitFactor = ratio(m.grossProfit, m.grossLoss);

  // 期望值：E = 勝率 × 平均獲利 − 敗率 × 平均虧損
  const lossRate = safeDiv(m.losses, m.totalTrades);
  m.expectancy = m.winRate * m.avgWin - lossRate * m.avgLoss;

  // R-multiple：以「平均虧損」為 1R 的代理；完全沒有虧損時誠實留空
  if (m.avgLoss > 0) {
    const oneR = m.avgLoss;
    m.rMultiples = pnls.map(p => p / oneR);
    let rs = 0; for (const r of m.rMultiples) rs += r;
    m.expectancyR = safeDiv(rs, m.rMultiples.length);
  } else {
    m.rMultiples = [];
    m.expectancyR = 0.0;
  }

  m.largestWin = winPnls.length ? Math.max(...winPnls) : 0.0;
  m.largestLoss = lossPnls.length ? Math.min(...lossPnls) : 0.0;
  m.topTradePnlShare = safeDiv(pnls.length ? Math.max(...pnls) : 0.0, m.grossProfit);

  // 回撤：全程因果 —— 峰值用當下高水位、資本基準用「至今最大部位」逐筆更新
  let equity = 0.0;
  let peak = 0.0;
  let maxDd = 0.0;
  let maxDdPct = 0.0;
  let runningCapital = 0.0;
  for (let i = 0; i < trades.length; i++) {
    runningCapital = Math.max(runningCapital, contractValue(trades[i]));
    equity += pnls[i];
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    const denomNow = runningCapital + peak;
    if (denomNow > 0) {
      const ddPct = dd / denomNow;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
    }
  }
  m.maxDrawdown = maxDd;
  m.maxDrawdownPct = maxDdPct;
  m.drawdownPctReliable = runningCapital > 0;

  // 最長連續虧損
  let streak = 0;
  let longest = 0;
  for (const p of pnls) {
    if (p < 0) { streak++; longest = Math.max(longest, streak); }
    else streak = 0;
  }
  m.maxConsecutiveLosses = longest;

  // 夏普/索提諾（每筆交易口徑，非年化）
  const n = returns.length;
  let rSum = 0; for (const r of returns) rSum += r;
  const meanRet = safeDiv(rSum, n);
  if (n > 1) {
    let varAcc = 0; for (const r of returns) varAcc += (r - meanRet) ** 2;
    const std = Math.sqrt(varAcc / (n - 1));
    m.sharpe = ratio(meanRet, std);
    // 下行偏差：分母用 n-1（與夏普一致），對每筆取 min(r,0)²
    let dAcc = 0; for (const r of returns) dAcc += Math.min(r, 0.0) ** 2;
    const dstd = Math.sqrt(dAcc / (n - 1));
    m.sortino = ratio(meanRet, dstd);
  }

  // 交易風格
  const holding = trades.map(t => holdingDays(t));
  let hSum = 0; for (const h of holding) hSum += h;
  m.avgHoldingDays = safeDiv(hSum, holding.length);
  const intradayCount = trades.filter(t => isDayTrade(t)).length;
  m.isMostlyIntraday = safeDiv(intradayCount, trades.length) >= INTRADAY_RATIO_THRESHOLD;

  return m;
}

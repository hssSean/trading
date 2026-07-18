// 移植自 core/metrics/breakeven.py（逐函式對照）。
// 轉正數字：把定性勸告變成可執行目標（勝率要到多少 / 盈虧比要拉到多少）。

import { PerformanceMetrics } from './metrics';

export interface BreakEvenTargets {
  currentWinRate: number;
  currentPayoffRatio: number;
  currentExpectancy: number;

  requiredWinRate: number | null;
  winRateGap: number | null;

  requiredPayoffRatio: number | null;
  payoffGap: number | null;

  feeCutToBreakeven: number | null;

  alreadyPositive: boolean;
  structurallyHard: boolean;
  messages: string[];
}

const pct0 = (x: number) => `${Math.round(x * 100)}%`;

/** 計算轉正所需的勝率 / 盈虧比 / 成本削減目標 —— 對照 compute_break_even。 */
export function computeBreakEven(metrics: PerformanceMetrics): BreakEvenTargets {
  const winRate = metrics.winRate;
  const avgWin = metrics.avgWin;
  const avgLoss = metrics.avgLoss; // 已是正值
  const payoff = metrics.payoffRatio;
  const expectancy = metrics.expectancy;

  const t: BreakEvenTargets = {
    currentWinRate: winRate,
    currentPayoffRatio: payoff,
    currentExpectancy: expectancy,
    requiredWinRate: null,
    winRateGap: null,
    requiredPayoffRatio: null,
    payoffGap: null,
    feeCutToBreakeven: null,
    alreadyPositive: false,
    structurallyHard: false,
    messages: [],
  };

  if (expectancy > 0) {
    t.alreadyPositive = true;
    t.messages.push('你的期望值已經為正 —— 目標是「維持」，別讓它衰退。');
    return t;
  }

  // 固定盈虧比 → 轉正所需最低勝率：win_rate* = avg_loss / (avg_win + avg_loss)
  if (avgWin + avgLoss > 0) {
    const reqWr = avgLoss / (avgWin + avgLoss);
    if (reqWr < 0.9) {
      t.requiredWinRate = reqWr;
      t.winRateGap = reqWr - winRate;
      t.messages.push(
        `維持現在的盈虧比（${payoff.toFixed(2)}），勝率要從 ${pct0(winRate)} 提高到 ${pct0(reqWr)}（差 ${Math.round(t.winRateGap * 100)} 個百分點）才會轉正。`,
      );
    } else {
      t.structurallyHard = true;
      t.messages.push(
        `以你目前的盈虧比，要轉正得有近 ${pct0(reqWr)} 的勝率，實務上幾乎不可能 —— 問題出在「賺太少賠太多」的結構，必須提高盈虧比（減少虧損、增加獲利）。`,
      );
    }
  }

  // 固定勝率 → 轉正所需最低盈虧比：payoff* = (1 − win_rate)/win_rate
  if (winRate > 0) {
    const reqPayoff = (1 - winRate) / winRate;
    t.requiredPayoffRatio = reqPayoff;
    t.payoffGap = reqPayoff - payoff;
    if (payoff > 0) {
      t.messages.push(
        `維持現在的勝率（${pct0(winRate)}），盈虧比要從 ${payoff.toFixed(2)} 拉到 ${reqPayoff.toFixed(2)}（差 ${t.payoffGap.toFixed(2)}）才會轉正 —— 也就是讓平均獲利更大、或平均虧損更小。`,
      );
    }
  } else {
    t.structurallyHard = true;
    t.messages.push('你幾乎沒有獲利交易，光調盈虧比救不了 —— 進場規則本身要重做。');
  }

  // 若每筆少付多少成本就轉正
  if (metrics.totalTrades > 0) {
    const avgFee = metrics.totalFees / metrics.totalTrades;
    if (avgFee > 0 && expectancy + avgFee > 0) {
      const needed = -expectancy;
      t.feeCutToBreakeven = needed;
      t.messages.push(
        `你的每筆平均成本約 ${avgFee.toFixed(2)}，而期望值只差 ${needed.toFixed(2)} 就轉正 —— 只要每筆能省下約 ${needed.toFixed(2)} 的成本（換低費率券商、降低交易頻率），就可能由負翻正。問題可能不在策略，而在被成本吃掉。`,
      );
    }
  }

  return t;
}

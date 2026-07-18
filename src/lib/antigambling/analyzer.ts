// 移植自 core/analyzer.py（一行呼叫跑完整分析；不含 out-of-scope 的
// profiler / skeleton / text report —— UI 用結構化資料自行呈現）。

import { BreakEvenTargets, computeBreakEven } from './breakeven';
import { computeMetrics, PerformanceMetrics } from './metrics';
import { AgTradeLog } from './models';
import { holdoutValidate, OutOfSampleReport } from './oos';
import {
  counterfactualDropWorst,
  CounterfactualResult,
  followTheGuru,
  FollowGuruResult,
  perTagVerdicts,
  TagVerdict,
} from './pertag';
import { judge, Verdict } from './verdict';

export interface AnalysisResult {
  log: AgTradeLog;
  metrics: PerformanceMetrics;
  verdict: Verdict;
  outOfSample: OutOfSampleReport;
  tagVerdicts: TagVerdict[];
  counterfactual: CounterfactualResult | null;
  followGuru: FollowGuruResult | null;
  breakeven: BreakEvenTargets;
}

/** 遞迴把 Infinity/NaN 轉 null（語意是「不適用」）—— 對照 sanitize_json。 */
export function sanitizeJson<T>(obj: T): unknown {
  if (typeof obj === 'number' && !Number.isFinite(obj)) return null;
  if (Array.isArray(obj)) return obj.map(sanitizeJson);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = sanitizeJson(v);
    }
    return out;
  }
  return obj;
}

/** 對一份已載入的 TradeLog 跑完整分析 —— 對照 analyze_log。 */
export function analyzeLog(
  log: AgTradeLog,
  opts: { nBootstrap?: number } = {},
): AnalysisResult {
  const nBootstrap = opts.nBootstrap ?? 5000;

  const metrics = computeMetrics(log);
  const verdict = judge(log, { metrics, nBootstrap });
  const outOfSample = holdoutValidate(log, { nBootstrap });
  const tagVerdicts = perTagVerdicts(log);
  const counterfactual = counterfactualDropWorst(log, { tagVerdicts });
  const followGuru = followTheGuru(log, { nBootstrap });
  const breakeven = computeBreakEven(metrics);

  return { log, metrics, verdict, outOfSample, tagVerdicts, counterfactual, followGuru, breakeven };
}

/**
 * 對齊 Python `AnalysisResult.as_dict()` 的輸出形狀（供 golden 檔比對；
 * `profile` 為 out-of-scope 略去）。鍵名用 snake_case 與 Python 一致。
 */
export function toComparableDict(r: AnalysisResult): unknown {
  const m = r.metrics;
  const sig = r.verdict.significance;
  const req = (m.expectancy || 0) <= 0 ? null : r.verdict.requiredTrades;
  return sanitizeJson({
    verdict: {
      level: r.verdict.level,
      should_discourage: r.verdict.shouldDiscourage,
      required_trades: req,
      metrics: {
        total_trades: m.totalTrades,
        wins: m.wins,
        losses: m.losses,
        breakeven: m.breakeven,
        win_rate: m.winRate,
        avg_win: m.avgWin,
        avg_loss: m.avgLoss,
        payoff_ratio: m.payoffRatio,
        profit_factor: m.profitFactor,
        expectancy: m.expectancy,
        expectancy_r: m.expectancyR,
        total_pnl: m.totalPnl,
        total_fees: m.totalFees,
        gross_profit: m.grossProfit,
        gross_loss: m.grossLoss,
        max_drawdown: m.maxDrawdown,
        max_drawdown_pct: m.maxDrawdownPct,
        max_consecutive_losses: m.maxConsecutiveLosses,
        sharpe: m.sharpe,
        sortino: m.sortino,
        largest_win: m.largestWin,
        largest_loss: m.largestLoss,
        top_trade_pnl_share: m.topTradePnlShare,
        avg_holding_days: m.avgHoldingDays,
        is_mostly_intraday: m.isMostlyIntraday,
        drawdown_pct_reliable: m.drawdownPctReliable,
        r_multiples_count: m.rMultiples.length,
      },
      significance: {
        n: sig.n,
        mean: sig.mean,
        std: sig.std,
        t_stat: sig.tStat,
        p_value_t: sig.pValueT,
        p_value_bootstrap: sig.pValueBootstrap,
        ci_low: sig.ciLow,
        ci_high: sig.ciHigh,
        is_significant: sig.isSignificant,
      },
      red_flags: r.verdict.redFlags.map(f => ({ code: f.code, severity: f.severity })),
    },
    out_of_sample: {
      in_sample: segDict(r.outOfSample.inSample),
      out_sample: segDict(r.outOfSample.outSample),
      edge_persisted: r.outOfSample.edgePersisted,
      degradation: r.outOfSample.degradation,
    },
    tag_verdicts: r.tagVerdicts.map(tv => ({
      tag: tv.tag,
      n_trades: tv.nTrades,
      expectancy: tv.expectancy,
      total_pnl: tv.totalPnl,
      win_rate: tv.winRate,
      profit_factor: tv.profitFactor,
      low_sample: tv.lowSample,
      is_losing: tv.isLosing,
    })),
    follow_guru: r.followGuru
      ? {
          n_trades: r.followGuru.nTrades,
          expectancy: r.followGuru.expectancy,
          total_pnl: r.followGuru.totalPnl,
          level: r.followGuru.level,
        }
      : null,
    counterfactual: r.counterfactual
      ? {
          worst_tag: r.counterfactual.worstTag,
          before_expectancy: r.counterfactual.beforeExpectancy,
          after_expectancy: r.counterfactual.afterExpectancy,
          before_total_pnl: r.counterfactual.beforeTotalPnl,
          after_total_pnl: r.counterfactual.afterTotalPnl,
        }
      : null,
    breakeven: {
      already_positive: r.breakeven.alreadyPositive,
      structurally_hard: r.breakeven.structurallyHard,
      required_win_rate: r.breakeven.requiredWinRate,
      required_payoff_ratio: r.breakeven.requiredPayoffRatio,
      fee_cut_to_breakeven: r.breakeven.feeCutToBreakeven,
    },
  });
}

function segDict(s: OutOfSampleReport['inSample']) {
  return {
    label: s.label,
    n_trades: s.nTrades,
    win_rate: s.winRate,
    expectancy: s.expectancy,
    profit_factor: s.profitFactor,
    total_pnl: s.totalPnl,
    p_value_bootstrap: s.significance.pValueBootstrap,
    is_significant: s.significance.isSignificant,
  };
}

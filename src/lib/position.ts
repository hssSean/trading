// ── Position sizing plan ───────────────────────────────────────
// Turns "risk X% of the account" into a concrete order the user can place:
//   倉位 (notional) = riskUSDT / stopDistance
//   本金 (margin)   = ~20% of account per trade, stretched only when the
//                     leverage cap would otherwise shrink the position
//   槓桿 (leverage) = notional / margin, clamped to [1, maxLev]
// Shared by SignalCard, trades journal, and the server push notifications so
// every surface quotes identical numbers.

export interface PositionPlan {
  riskUSDT: number;      // max loss when SL is hit
  positionUSDT: number;  // notional position size
  marginUSDT: number;    // 本金 to allocate
  leverage: number;      // 槓桿, 1 decimal
  belowMinNotional: boolean; // notional under Binance's ~5 USDT futures minimum
}

export function calcPositionPlan(
  accountSize: number,
  riskPct: number,       // per-trade risk in % (already tier-adjusted by caller)
  entry: number,
  stopLoss: number,
  maxLev = 10,
): PositionPlan | null {
  if (accountSize <= 0 || riskPct <= 0 || entry <= 0) return null;
  const stopDist = Math.abs(entry - stopLoss) / entry;
  if (stopDist <= 0) return null;

  const riskUSDT     = accountSize * riskPct / 100;
  const positionUSDT = riskUSDT / stopDist;

  const marginBudget = accountSize * 0.2; // per-trade margin target: 20% of account
  let leverage = positionUSDT / marginBudget;
  leverage = Math.min(Math.max(leverage, 1), maxLev);
  leverage = Math.round(leverage * 10) / 10;
  const marginUSDT = positionUSDT / leverage;

  return {
    riskUSDT:     Math.round(riskUSDT * 100) / 100,
    positionUSDT: Math.round(positionUSDT * 10) / 10,
    marginUSDT:   Math.round(marginUSDT * 10) / 10,
    leverage,
    belowMinNotional: positionUSDT < 5,
  };
}

// Compact zh-TW one-liner for notifications: 倉位 13.3U（本金 4U ×3.3倍）
export function formatPlanLine(plan: PositionPlan): string {
  const base = `倉位 ${plan.positionUSDT}U（本金 ${plan.marginUSDT}U ×${plan.leverage}倍）`;
  return plan.belowMinNotional ? `${base}⚠低於交易所最低5U` : base;
}

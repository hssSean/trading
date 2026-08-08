// ── Position sizing plan ───────────────────────────────────────
// Turns "risk X% of the account" into a concrete order the user can place:
//   倉位 (notional) = riskUSDT / stopDistance
//   本金 (margin)   = ~20% of account per trade, stretched only when the
//                     leverage cap would otherwise shrink the position
//   槓桿 (leverage) = notional / margin, clamped to [1, maxLev]
// Shared by SignalCard, trades journal, and the server push notifications so
// every surface quotes identical numbers.

// Alt-bucket slot cap: same-direction altcoin risk is bucketed at ≤1.0% total
// (see checkSameDirectionRisk in api/analyze/route.ts), subdivided into ~3 slots
// of ALT_SLOT_RISK each. This must be the SAME multiplier used for the real
// position size shown to the user — otherwise the risk gate's bookkeeping and
// the actual $ risked on an order diverge (bucket accounts 0.33%, order sizes at
// the full 1.0% tier rate).
export const ALT_SLOT_RISK = 0.33;

// Fraction of the user's acctRiskPct actually put on a given signal: tier alone
// (A=100%, B=50%) for BTC/ETH; capped at ALT_SLOT_RISK for altcoins, since an alt
// slot's bookkeeping in checkSameDirectionRisk is capped there too.
export function tierRiskMultiplier(symbol: string, tier: string | null | undefined): number {
  const base = tier === 'B' ? 0.5 : 1.0;
  const isAlt = !symbol.startsWith('BTC') && !symbol.startsWith('ETH');
  return isAlt ? Math.min(base, ALT_SLOT_RISK) : base;
}

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

// 2026-08-08：從 api/analyze/route.ts 搬過來，讓 DB 模擬版（route.ts）跟
// 真倉自動化（src/engine/tradeBridge.ts）用同一個上限，不要各自維護一份會
// 走鐘的數字。
//
// 這是「持倉數量，按波動性加權」的量測代理值，NOT 真實帳戶風險% ——
// suggested_risk_pct 是系統依 ATR 波動性給的建議倉位大小（0.5/1.0/1.5，
// 資訊性質，使用者自己決定要不要照做），跟使用者自己設的 acctRiskPct
// 完全無關。2026-07-31 把顯示文案（拒絕原因/BtcStatusBar/ScanStatusPanel）
// 改過，不再暗示這是真實帳戶風險，數字/門檻本身沒動，只是改了怎麼稱呼它。
export const MAX_TOTAL_RISK_PCT = 5;

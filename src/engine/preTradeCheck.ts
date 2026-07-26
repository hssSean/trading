// Pure pre-trade validation. Every check that must pass before an order reaches
// Binance. Returns ALL failures (not just the first) so a rejected order's log
// entry explains everything wrong at once, not just whichever check ran first.
//
// This is the layer closest to "how do I not blow up the account" — see
// docs/TODO.md 自動化交易 section for the full five-layer defense this sits in.

import { SymbolFilters, meetsMinNotional } from './precision';

// Isolated-margin liquidation price, simplified (ignores funding accrual and the
// taker-fee reserve Binance adds internally — conservative enough for a SAFETY
// MARGIN check, not meant to match the exchange's cent-exact value). Real
// maintenance margin rate is tiered by notional bracket — pull it from
// /fapi/v1/leverageBracket per symbol; use a conservative default (e.g. 0.5%)
// only if that lookup is unavailable.
export function estimateLiquidationPrice(
  entry: number, leverage: number, isLong: boolean, maintenanceMarginRate: number,
): number {
  return isLong
    ? entry * (1 - 1 / leverage + maintenanceMarginRate)
    : entry * (1 + 1 / leverage - maintenanceMarginRate);
}

// Liquidation distance must be at least this many multiples of the stop-loss
// distance. At 3x, the stop fires long before liquidation is reachable even if
// the stop order fails to execute on the first attempt (slippage, thin book).
export const MIN_LIQUIDATION_BUFFER_R = 3;

export interface PreTradeCheckInput {
  symbol: string;
  isLong: boolean;
  entry: number;
  stopLoss: number;
  quantity: number;               // already rounded to stepSize by the caller
  leverage: number;
  maintenanceMarginRate: number;  // from leverageBracket; conservative default if unavailable
  filters: SymbolFilters;

  accountEquity: number;          // current total account equity (USDT)
  equityFloor: number;            // refuse all new orders once equity drops below this
  currentMarginUsed: number;      // margin already committed to other open positions
  maxMarginUsageRatio: number;    // e.g. 0.5 = never commit more than 50% of equity total

  killSwitchActive: boolean;
  todayRealizedPnl: number;       // negative = loss
  dailyLossCapUsdt: number;       // positive number; today's loss must not exceed this
}

export interface PreTradeCheckResult {
  ok: boolean;
  failures: string[]; // empty when ok
  liquidationPrice?: number; // surfaced for logging even on success
}

export function canPlaceOrder(input: PreTradeCheckInput): PreTradeCheckResult {
  const failures: string[] = [];

  // Kill switch and hard equity floor are checked first and independently —
  // even a single malformed numeric input elsewhere shouldn't mask these.
  if (input.killSwitchActive) {
    failures.push('kill switch 已啟動，禁止新單');
  }
  if (input.accountEquity < input.equityFloor) {
    failures.push(`帳戶權益 ${input.accountEquity} 低於硬地板 ${input.equityFloor}`);
  }
  if (-input.todayRealizedPnl >= input.dailyLossCapUsdt) {
    failures.push(`當日已實現虧損 ${(-input.todayRealizedPnl).toFixed(2)} 達上限 ${input.dailyLossCapUsdt}`);
  }

  const riskDist = Math.abs(input.entry - input.stopLoss);
  if (riskDist <= 0) {
    failures.push('進場價與止損價相同，無法計算風險距離');
  }

  let liquidationPrice: number | undefined;
  if (input.leverage > 0 && riskDist > 0) {
    liquidationPrice = estimateLiquidationPrice(
      input.entry, input.leverage, input.isLong, input.maintenanceMarginRate,
    );
    const liqDist = Math.abs(input.entry - liquidationPrice);
    const bufferR = liqDist / riskDist;
    if (bufferR < MIN_LIQUIDATION_BUFFER_R) {
      failures.push(
        `強平緩衝 ${bufferR.toFixed(1)}x 低於最低要求 ${MIN_LIQUIDATION_BUFFER_R}x（估計強平價 ${liquidationPrice.toFixed(4)}）`,
      );
    }
  }

  const notional = input.quantity * input.entry;
  const marginForThisTrade = input.leverage > 0 ? notional / input.leverage : notional;
  const totalMarginAfter = input.currentMarginUsed + marginForThisTrade;
  const marginRatioAfter = input.accountEquity > 0 ? totalMarginAfter / input.accountEquity : Infinity;
  if (marginRatioAfter > input.maxMarginUsageRatio) {
    failures.push(
      `保證金使用率 ${(marginRatioAfter * 100).toFixed(1)}% 會超過上限 ${(input.maxMarginUsageRatio * 100).toFixed(0)}%`,
    );
  }

  if (!meetsMinNotional(input.quantity, input.entry, input.filters.minNotional)) {
    failures.push(`名目 ${notional.toFixed(2)} 低於交易所最低 ${input.filters.minNotional}`);
  }
  if (input.quantity <= 0) {
    failures.push('數量為 0（可能是 stepSize 無條件捨去後歸零）');
  }

  return { ok: failures.length === 0, failures, liquidationPrice };
}

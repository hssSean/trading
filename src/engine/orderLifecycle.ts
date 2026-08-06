// Pure decision functions for the two most dangerous state transitions in
// automated execution: partially closing a position at TP1, and moving a
// trailing stop. Both mirror behavior that already exists in api/analyze/route.ts
// (candle-scan based, DB-only) — this module answers the same questions but in
// terms of "what order do I send to the exchange", for the not-yet-built runner.
//
// Nothing here calls BinanceFuturesClient. Callers execute the returned actions
// and are responsible for error handling, retries, and watchdog reconciliation.
// Keeping this pure means the ordering logic (which action goes first) can be
// tested without mocking network calls — see docs/ANALYSIS-2026-08-06-自動交易缺口清單.md
// §三 #6/#9 for the behavior this replicates and why it's risky.

import { PlaceOrderParams } from './binanceClient';
import { SymbolFilters, roundToStepSize, roundToTickSize } from './precision';
import { TP1_PARTIAL_FRACTION } from '@/lib/monitorMath';

// ── TP1 partial close ──────────────────────────────────────────────────────
//
// App-side (blendTp1PartialPnl) already treats TP1 as "50% locked in" for R
// accounting. This function is what makes that true on the exchange: a
// reduceOnly MARKET order for TP1_PARTIAL_FRACTION of the current position,
// immediately once TP1 is confirmed touched.

export interface Tp1PartialCloseInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  positionQty: number;      // absolute filled quantity currently open (from positionRisk, always positive)
  filters: SymbolFilters;
}

export type Tp1PartialCloseDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams; closeQty: number; remainingQty: number };

export function decideTp1PartialClose(input: Tp1PartialCloseInput): Tp1PartialCloseDecision {
  if (input.positionQty <= 0) {
    return { skip: true, reason: 'positionQty <= 0 — 沒有可平的部位（可能已經平倉，避免對空部位下單）' };
  }

  // Floor, not round — closing slightly less than 50% is safe (the other half's
  // final-exit R absorbs the difference); closing MORE than the position holds
  // is a hard reject from Binance (-2022 ReduceOnly Order is rejected) at best,
  // or in a hedge-mode edge case, opens an unintended opposite position.
  const closeQty = roundToStepSize(input.positionQty * TP1_PARTIAL_FRACTION, input.filters.stepSize);
  if (closeQty <= 0) {
    return {
      skip: true,
      reason: `部位量 ${input.positionQty} × ${TP1_PARTIAL_FRACTION} 取整後為 0（stepSize ${input.filters.stepSize} 對這個部位太粗）— 跳過部分平倉，留給 TP2/移動止損處理全部`,
    };
  }

  const remainingQty = roundToStepSize(input.positionQty - closeQty, input.filters.stepSize);

  return {
    skip: false,
    closeQty,
    remainingQty,
    order: {
      symbol: input.symbol,
      side: input.isLong ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: closeQty,
      reduceOnly: true,
      // Deterministic, not time-based: a TP1 partial close only ever happens
      // once per trade, so retrying the same decision (e.g. cron re-evaluating
      // before the first attempt's result is confirmed) must produce the same
      // ID and get rejected as a duplicate (-4015) rather than double-close.
      newClientOrderId: `${input.tradeId}-tp1close`,
    },
  };
}

// ── Trailing stop replace ───────────────────────────────────────────────────
//
// The existing route.ts trailing-stop math (init at TP1∓2×ATR floored at entry,
// ratchet favorably-only per candle) is UNCHANGED here — this function only
// decides what to do with an already-computed target price against whatever
// stop order currently lives on the exchange. That "what to do" question is
// the dangerous part: a plain cancel-then-place has a window where the position
// has NO protective order at all (see docs/TODO.md 自動化交易 — 裸倉 is called out
// as the single most dangerous failure mode this whole system guards against).
//
// This function always sequences PLACE before CANCEL. Both orders briefly
// coexist with closePosition=true — that's safe: whichever triggers first
// flattens the position, and the other becomes a no-op stop with nothing to
// close (the exchange returns an error for it, which the caller/watchdog should
// recognize as expected, not an anomaly, once it fires against a flat position).
// The alternative order (cancel-then-place) trades that harmless race for a real
// naked-position window if the place call fails or is delayed — strictly worse.

export interface CurrentStopOrder {
  orderId: number;
  stopPrice: number;
}

export interface TrailingStopReplaceInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  currentStopOrder: CurrentStopOrder | null; // null = no live protective order (shouldn't happen post-fill; caller/watchdog should treat this as position_without_stop)
  desiredStopPrice: number;                   // output of the existing (unchanged) trailing-stop math
  filters: SymbolFilters;
}

export type TrailingStopAction =
  | { kind: 'none'; reason: string }
  | { kind: 'initialize'; place: PlaceOrderParams }
  | { kind: 'replace'; place: PlaceOrderParams; cancelOrderId: number };

export function decideTrailingStopReplace(input: TrailingStopReplaceInput): TrailingStopAction {
  const roundedTarget = roundToTickSize(input.desiredStopPrice, input.filters.tickSize);

  const place: PlaceOrderParams = {
    symbol: input.symbol,
    side: input.isLong ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: roundedTarget,
    closePosition: true,
    // Price-keyed, not time-based: two calls that land on the same target price
    // (e.g. the ratchet math re-runs on a cron cycle where nothing moved) must
    // collapse to the same ID and get rejected as a duplicate, not place a
    // second identical stop order next to the one already live.
    newClientOrderId: `${input.tradeId}-sl-${roundedTarget}`,
  };

  if (input.currentStopOrder === null) {
    return { kind: 'initialize', place };
  }

  const currentRounded = roundToTickSize(input.currentStopOrder.stopPrice, input.filters.tickSize);
  if (currentRounded === roundedTarget) {
    return { kind: 'none', reason: '目標價與現有止損單相同，不需要改單' };
  }

  // Ratchet is one-directional by design (route.ts:735/762 — "only moves
  // favorably"). A target that would loosen the stop is either stale math or a
  // caller bug; refusing to act here is the safe default — the existing,
  // already-favorable stop stays live untouched rather than being replaced
  // with something worse.
  const isMoreFavorable = input.isLong
    ? roundedTarget > currentRounded
    : roundedTarget < currentRounded;
  if (!isMoreFavorable) {
    return {
      kind: 'none',
      reason: `目標價 ${roundedTarget} 沒有比現有止損 ${currentRounded} 更有利，拒絕改單（棘輪只能往有利方向移動）`,
    };
  }

  return { kind: 'replace', place, cancelOrderId: input.currentStopOrder.orderId };
}

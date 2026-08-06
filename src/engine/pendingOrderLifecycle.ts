// Pure decision functions for the two new states that only exist once orders go
// to a real exchange (see docs/ANALYSIS-2026-08-06-自動交易缺口清單.md §五):
// partial fills, and the cancel/fill race. Neither concept exists in the current
// DB-only monitor (route.ts's `isFilled` is a plain boolean) — this module is
// what closes that gap for the not-yet-built runner.
//
// The four cancel TRIGGERS themselves (thesis_invalidated / ran_away / tp1_direct
// / expired — route.ts:395-443) are unchanged: they're a candle-scan read of
// already-public market data, identical whether the order lives only in our DB
// or also on the exchange. This module starts one step later: given "we decided
// to cancel this order", what do we safely do about it.

import { OpenOrder } from './binanceClient';

// ── Partial fills ───────────────────────────────────────────────────────────
//
// A limit order can be sitting 0% filled, partially filled, or fully filled at
// the moment we decide to cancel it. Only the "0% filled" case is a clean
// cancel. Anything with executedQty > 0 has created a REAL position that needs
// a stop-loss — cancelling only removes the unfilled remainder, it does not (and
// must not be assumed to) touch the filled part.

export interface PendingOrderSnapshot {
  orderId: number;
  origQty: number;
  executedQty: number; // from OpenOrder.executedQty, parsed
}

export type PendingOrderCancelPlan =
  | { action: 'cancel_only' }                                    // executedQty === 0
  | { action: 'cancel_remainder_and_protect'; filledQty: number } // 0 < executedQty < origQty
  | { action: 'already_filled'; filledQty: number };              // executedQty >= origQty — nothing to cancel

export function decidePendingOrderCancelPlan(snap: PendingOrderSnapshot): PendingOrderCancelPlan {
  if (snap.executedQty <= 0) {
    return { action: 'cancel_only' };
  }
  if (snap.executedQty >= snap.origQty) {
    return { action: 'already_filled', filledQty: snap.executedQty };
  }
  return { action: 'cancel_remainder_and_protect', filledQty: snap.executedQty };
}

export function parseOpenOrder(o: OpenOrder): PendingOrderSnapshot {
  return {
    orderId: o.orderId,
    origQty: parseFloat(o.origQty),
    executedQty: parseFloat(o.executedQty),
  };
}

// ── Cancel/fill race ─────────────────────────────────────────────────────────
//
// Decided to cancel → DELETE request in flight → order fills before it lands.
// Binance returns -2011 (Unknown order sent) for a DELETE against an order
// that's no longer open — that response looks identical whether the order
// filled a moment ago or was already cancelled/expired earlier. Treating -2011
// as "cancel succeeded" is the bug this function exists to prevent: it must
// requery positionRisk before concluding anything.

export const BINANCE_ERR_UNKNOWN_ORDER = -2011;

export interface CancelAttemptResult {
  success: boolean;
  errorCode?: number;
}

export type CancelOutcome =
  | { kind: 'cancelled' }                                   // clean cancel, no ambiguity
  | { kind: 'filled_before_cancel'; positionQty: number }    // race resolved: it filled — needs a stop-loss now, not a cancel record
  | { kind: 'ambiguous'; reason: string };                   // couldn't resolve from available info — escalate to watchdog reconciliation, don't guess

// `positionQtyAfterRequery` must come from a FRESH positionRisk call made AFTER
// the cancel attempt returned -2011 — never reuse a snapshot taken before the
// cancel was sent, that would just reproduce the same race one step earlier.
export function resolveCancelOutcome(
  result: CancelAttemptResult,
  positionQtyAfterRequery?: number,
): CancelOutcome {
  if (result.success) {
    return { kind: 'cancelled' };
  }

  if (result.errorCode !== BINANCE_ERR_UNKNOWN_ORDER) {
    return {
      kind: 'ambiguous',
      reason: `cancel 失敗但不是已知的 race 錯誤（code ${result.errorCode ?? 'unknown'}）— 不要假設任何結果，交給下一輪 watchdog 對帳`,
    };
  }

  if (positionQtyAfterRequery === undefined) {
    return {
      kind: 'ambiguous',
      reason: '收到 -2011 但沒有提供重查後的 positionQty — 呼叫端必須先重查 positionRisk 才能呼叫這個函式',
    };
  }

  if (positionQtyAfterRequery !== 0) {
    return { kind: 'filled_before_cancel', positionQty: positionQtyAfterRequery };
  }

  // -2011 with zero position afterwards means the order was gone for some other
  // reason (already cancelled by a previous attempt, expired via GTD, etc.) —
  // functionally equivalent to a successful cancel from the caller's perspective.
  return { kind: 'cancelled' };
}

// Binance's authenticated endpoints return {code, msg} in the response body on
// error (axios throws with that body under error.response.data). Pure and
// defensive — never throws, returns undefined for any shape it doesn't
// recognize so the caller falls into the "ambiguous, don't guess" path instead
// of a runtime crash.
export function extractBinanceErrorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as { response?: { data?: { code?: number } } }).response;
    if (typeof resp?.data?.code === 'number') return resp.data.code;
  }
  return undefined;
}

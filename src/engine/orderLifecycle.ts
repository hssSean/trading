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

// ── Entry order ─────────────────────────────────────────────────────────────
//
// The one piece of "訊號 → 真的開倉" that didn't exist anywhere yet. Everything
// else in this file assumes a position already exists on the exchange; this is
// what creates the first order. positionUSDT comes from calcPositionPlan
// (src/lib/position.ts) — same formula the App already shows the user, not a
// second one invented here (CLAUDE.md: 倉位計畫...勿另寫倉位公式).
//
// Deliberately does NOT place the paired stop here — see the module doc at the
// top of this file and docs/ANALYSIS-2026-08-06-自動交易缺口清單.md: the stop
// can only be sized correctly once the entry is CONFIRMED filled (exact filled
// qty, not the requested qty — a partial fill needs a smaller stop). The
// initial stop is decideTrailingStopReplace() called with currentStopOrder:
// null once the caller observes the position appear on positionRisk — that
// function's 'initialize' branch already does exactly this, no new function
// needed for it.

export interface EntryOrderInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  entry: number;
  positionUSDT: number;   // caller has already run calcPositionPlan and decided this isn't belowMinNotional
  filters: SymbolFilters;
}

export type EntryOrderDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams; quantity: number };

export function decideEntryOrder(input: EntryOrderInput): EntryOrderDecision {
  if (input.entry <= 0) {
    return { skip: true, reason: `entry ${input.entry} 無效（必須 > 0）` };
  }
  if (input.positionUSDT <= 0) {
    return { skip: true, reason: `positionUSDT ${input.positionUSDT} 無效（必須 > 0）` };
  }

  const rawQty = input.positionUSDT / input.entry;
  const quantity = roundToStepSize(rawQty, input.filters.stepSize);
  if (quantity <= 0) {
    return {
      skip: true,
      reason: `倉位 ${input.positionUSDT}U 換算數量後在 stepSize ${input.filters.stepSize} 下取整為 0，太小無法下單`,
    };
  }

  const notional = quantity * input.entry;
  if (notional < input.filters.minNotional) {
    return {
      skip: true,
      reason: `取整後名目倉位 ${notional.toFixed(2)}U 低於交易所最低 ${input.filters.minNotional}U`,
    };
  }

  return {
    skip: false,
    quantity,
    order: {
      symbol: input.symbol,
      side: input.isLong ? 'BUY' : 'SELL',
      type: 'LIMIT',
      quantity,
      price: roundToTickSize(input.entry, input.filters.tickSize),
      timeInForce: 'GTC',
      // Deterministic per trade — a re-run against the same tradeId (e.g. the
      // caller retries after a network timeout without knowing if the first
      // attempt landed) collapses to the same order and gets rejected as a
      // duplicate (-4015) instead of opening a second, unintended position.
      newClientOrderId: `${input.tradeId}-entry`,
    },
  };
}

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

// ── Full close ───────────────────────────────────────────────────────────────
//
// 策略B（均值回歸）沒有 TP1/TP2 兩階段——signals.ts 的
// generateMeanReversionSignals 故意把 takeProfits 寫成 [tp1, tp1]（見
// PriceProgressBar.tsx 那次修正），觸價就是整單了結，不走 decideTp1PartialClose
// 那條「先平一半、留一半給移動止損」的路。這是給那個情境用的。

export interface FullCloseInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  positionQty: number; // absolute filled quantity currently open
}

export type FullCloseDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams };

export function decideFullClose(input: FullCloseInput): FullCloseDecision {
  if (input.positionQty <= 0) {
    return { skip: true, reason: 'positionQty <= 0 — 沒有可平的部位' };
  }
  return {
    skip: false,
    order: {
      symbol: input.symbol,
      side: input.isLong ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: input.positionQty,
      reduceOnly: true,
      // 同一筆 trade 的整單平倉只會發生一次，冪等 ID 避免重試造成二次平倉。
      newClientOrderId: `${input.tradeId}-fullclose`,
    },
  };
}

// ── Trailing stop target price ──────────────────────────────────────────────
//
// route.ts's ATR ratchet (2026-08-08 移過來，數字/邏輯照抄，不是重新設計）：
//   初始化（TP1 剛觸及那一刻）：
//     LONG:  trailingStop = max(tp1 − 2×atr1h, entry)   — 保本地板，不會比進場價差
//     SHORT: trailingStop = min(tp1 + 2×atr1h, entry)
//   之後每次評估（TP1 已觸及後）：
//     LONG:  candidate = 現價 − 2×atr1h；只在 candidate > 現有止損 時採用
//     SHORT: candidate = 現價 + 2×atr1h；只在 candidate < 現有止損 時採用
//   只有策略 A（趨勢）有這個機制——策略 B（均值回歸）只有單一止盈目標，
//   TP1=TP2，不會走到「TP1 後移動止損」這段。
//
// route.ts 是「K 線掃描」架構，棘輪基準用每根 K 線的收盤價（c.close）；這裡
// 是給即時輪詢用的 runner 用，沒有 K 線，用當下 markPrice 代替——跟
// decideTradeAction 判斷 TP1 觸價時用 markPrice 代替 K 線 high/low 是同一類
// 簡化（架構本質差異：K 線只在收盤動一次，即時輪詢每輪都可能動，方向一致，
// 敏感度不同），不是另外設計的邏輯。
export interface TrailingStopTargetInput {
  isLong: boolean;
  entry: number;
  tp1: number;
  markPrice: number;
  atr1h: number;               // 1小時 ATR(14期)；<= 0 代表還沒有 ATR 資料
  currentTrailingStop: number; // 0 = 尚未初始化過
}

// 回傳新的目標止損價；atr1h <= 0（還沒抓到 ATR 資料）時原樣傳回
// currentTrailingStop，不亂算——route.ts 對這個情況的處理是「這輪不初始化」
// （見 route.ts atr1h===0 的 console.error 分支），不是用 0 或任何猜測值硬算。
export function calcTrailingStopTarget(input: TrailingStopTargetInput): number {
  if (input.atr1h <= 0) return input.currentTrailingStop;

  if (input.currentTrailingStop === 0) {
    return input.isLong
      ? Math.max(input.tp1 - 2 * input.atr1h, input.entry)
      : Math.min(input.tp1 + 2 * input.atr1h, input.entry);
  }

  const candidate = input.isLong
    ? input.markPrice - 2 * input.atr1h
    : input.markPrice + 2 * input.atr1h;

  const isMoreFavorable = input.isLong
    ? candidate > input.currentTrailingStop
    : candidate < input.currentTrailingStop;

  return isMoreFavorable ? candidate : input.currentTrailingStop;
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

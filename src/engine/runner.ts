// Execution orchestrator — the "how do I safely make it happen against a live
// exchange" layer. This is NOT the strategy layer: candle-scan decisions (which
// signals qualify, when a pending order's thesis is invalidated, the trailing-
// stop ratchet math) stay exactly where they are today (api/analyze/route.ts) —
// this file takes already-decided actions as plain input and sequences the
// exchange calls safely, using the pure decision functions built in
// preTradeCheck.ts / orderLifecycle.ts / pendingOrderLifecycle.ts / watchdog.ts.
//
// Deliberately NOT wired to any Next.js route or cron — see docs/TODO.md
// 自動化交易 §決策點: Vercel can't host this (no static IP, functions can be
// killed mid-sequence, 5-minute cron is too coarse for trailing-stop
// maintenance). This is meant to be imported by a standalone process on
// whatever host gets chosen (Oracle Cloud / VPS), invoked in a loop — that
// process entrypoint doesn't exist yet, this is the orchestration it will call.
//
// Dependency-injected on purpose: `RunnerClient` is a minimal interface (not
// the full BinanceFuturesClient class) so tests can supply an in-memory fake
// and exercise every branch — kill switch gating, place-before-cancel ordering,
// partial-fill handling, cancel/fill race resolution — without any network
// call or real credentials.

import { AlgoOrder, PlaceOrderParams, OpenOrder, PositionRisk } from './binanceClient';
import { KillSwitchState } from './killSwitch';
import { reconcilePositionsAndOrders, ReconcileAnomaly } from './watchdog';
import { SymbolFilters } from './precision';
import {
  decideTp1PartialClose, decideTrailingStopReplace,
  CurrentStopOrder,
} from './orderLifecycle';
import {
  decidePendingOrderCancelPlan, resolveCancelOutcome, extractBinanceErrorCode,
  BINANCE_ERR_UNKNOWN_ORDER,
} from './pendingOrderLifecycle';

export interface RunnerClient {
  getPositionRisk(symbol?: string): Promise<PositionRisk[]>;
  getOpenOrders(symbol?: string): Promise<OpenOrder[]>;
  // 條件單（止損/止盈）2025-12 遷移後查詢端點跟 getOpenOrders 分開了，見
  // watchdog.ts 頂部註解——沒有這個，watchdog 對每個有保護的部位都會誤報裸倉。
  getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]>;
  placeOrder(params: PlaceOrderParams): Promise<{ orderId: number; clientOrderId: string; status: string }>;
  // isAlgoOrder：見 binanceClient.ts cancelOrder 的同名參數說明。
  cancelOrder(symbol: string, orderId: number, isAlgoOrder?: boolean): Promise<{ orderId: number; status: string }>;
}

export interface RunnerDeps {
  client: RunnerClient;
  getKillSwitchState: () => Promise<KillSwitchState>;
}

// ── Input: already-decided actions ──────────────────────────────────────────
// Everything here is "what should happen", computed elsewhere (the strategy
// layer). The runner's job is only "how to make it happen safely".

export interface PendingCancelAction {
  symbol: string;
  orderId: number;
  origQty: number;
  executedQty: number; // from a fresh OpenOrder snapshot the caller already fetched
}

export interface Tp1CloseAction {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  positionQty: number;
  filters: SymbolFilters;
}

export interface TrailingStopUpdateAction {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  currentStopOrder: CurrentStopOrder | null;
  desiredStopPrice: number;
  filters: SymbolFilters;
}

export interface RunnerCycleInput {
  pendingCancels: PendingCancelAction[];
  tp1Closes: Tp1CloseAction[];
  trailingStopUpdates: TrailingStopUpdateAction[];
}

export interface RunnerCycleResult {
  killSwitchActive: boolean;
  reconcileAnomalies: ReconcileAnomaly[];
  actionsTaken: string[];
  actionsSkipped: string[];
  errors: string[];
}

function emptyResult(): RunnerCycleResult {
  return { killSwitchActive: false, reconcileAnomalies: [], actionsTaken: [], actionsSkipped: [], errors: [] };
}

export async function runMonitorCycle(deps: RunnerDeps, input: RunnerCycleInput): Promise<RunnerCycleResult> {
  const result = emptyResult();

  // Layer 4 (kill switch) is checked FIRST, before any exchange read even —
  // if this call itself fails, we fail closed (treat as active) rather than
  // silently proceeding to place orders on an unknown kill-switch state.
  let ks: KillSwitchState;
  try {
    ks = await deps.getKillSwitchState();
  } catch (e) {
    result.errors.push(`讀取 kill switch 狀態失敗，視為已啟動（fail closed）: ${String(e)}`);
    result.killSwitchActive = true;
    return result;
  }
  result.killSwitchActive = ks.active;

  // Layer 3 (watchdog) always runs, even with the kill switch active — its
  // findings need to stay visible while the account is halted, not go dark.
  try {
    const [positions, openOrders, openAlgoOrders] = await Promise.all([
      deps.client.getPositionRisk(),
      deps.client.getOpenOrders(),
      deps.client.getOpenAlgoOrders(),
    ]);
    result.reconcileAnomalies = reconcilePositionsAndOrders(positions, openOrders, openAlgoOrders);
  } catch (e) {
    result.errors.push(`對帳讀取失敗: ${String(e)}`);
  }

  if (ks.active) {
    result.actionsSkipped.push(`kill switch 啟動中（${ks.reason ?? '無原因記錄'}）— 跳過所有下單/改單動作`);
    return result;
  }

  // Pending-order cancels first: this branch can only shrink or neutralize
  // exposure (cancel cleanly, or protect a partial fill) — never opens new
  // risk, so it's safe to run before anything else.
  for (const c of input.pendingCancels) {
    const plan = decidePendingOrderCancelPlan({ orderId: c.orderId, origQty: c.origQty, executedQty: c.executedQty });

    if (plan.action === 'already_filled') {
      result.actionsSkipped.push(`${c.symbol} 訂單 ${c.orderId} 已全部成交（${plan.filledQty}），跳過取消——需要走成交後的止損流程`);
      continue;
    }

    const outcome = await attemptCancel(deps.client, c.symbol, c.orderId, result, false);
    if (outcome.kind === 'filled_before_cancel') {
      result.actionsTaken.push(
        `${c.symbol} 訂單 ${c.orderId} 撤單前已成交（race，最終部位 ${outcome.positionQty}）——需要走成交後的止損流程，不是取消`,
      );
    } else if (outcome.kind === 'cancelled') {
      const suffix = plan.action === 'cancel_remainder_and_protect'
        ? `（部分成交 ${plan.filledQty} 已保留為真實部位，需要補止損）`
        : '';
      result.actionsTaken.push(`${c.symbol} 訂單 ${c.orderId} 已取消${suffix}`);
    } else {
      result.errors.push(`${c.symbol} 訂單 ${c.orderId} 撤單結果無法判定：${outcome.reason}——交給下一輪 watchdog 對帳，不要用猜的`);
    }
  }

  // TP1 partial closes — reduceOnly, can only shrink the position.
  for (const t of input.tp1Closes) {
    const decision = decideTp1PartialClose(t);
    if (decision.skip) {
      result.actionsSkipped.push(`${t.symbol} TP1 部分平倉跳過：${decision.reason}`);
      continue;
    }
    try {
      await deps.client.placeOrder(decision.order);
      result.actionsTaken.push(`${t.symbol} TP1 部分平倉 ${decision.closeQty}（剩餘 ${decision.remainingQty}）已送出`);
    } catch (e) {
      result.errors.push(`${t.symbol} TP1 部分平倉下單失敗: ${String(e)}`);
    }
  }

  // Trailing stop updates last — the one operation that can (briefly) touch
  // existing protection. orderLifecycle.decideTrailingStopReplace already
  // enforces place-before-cancel; this loop just executes that decision as-is.
  for (const t of input.trailingStopUpdates) {
    const action = decideTrailingStopReplace(t);
    if (action.kind === 'none') continue; // not worth logging every cycle when nothing changed

    try {
      await deps.client.placeOrder(action.place);
    } catch (e) {
      // New stop failed to place — the OLD stop (if any) is untouched, so the
      // position is still protected. Do not proceed to cancel anything.
      result.errors.push(`${t.symbol} 移動止損新單下單失敗，保留舊止損不動: ${String(e)}`);
      continue;
    }

    if (action.kind === 'replace') {
      // isAlgoOrder=true：這裡撤的一定是舊的 STOP_MARKET 移動止損單，2025-12
      // 遷移後所有條件單都活在 algoOrder 端點，不是 order 端點。
      const outcome = await attemptCancel(deps.client, t.symbol, action.cancelOrderId, result, true);
      if (outcome.kind === 'ambiguous') {
        // New stop is live either way — an unresolved old-stop cancel means two
        // protective orders briefly coexist, which orderLifecycle.ts's design
        // note says is safe (whichever fires first flattens the position).
        result.errors.push(`${t.symbol} 移動止損：新單已送出，但舊單 ${action.cancelOrderId} 撤單結果無法判定：${outcome.reason}`);
      }
    }
    result.actionsTaken.push(
      `${t.symbol} 移動止損${action.kind === 'initialize' ? '初始化' : '更新'} → ${action.place.stopPrice}`,
    );
  }

  return result;
}

// Shared cancel-with-race-resolution helper — used by both the pending-order
// and trailing-stop-replace paths above so the -2011 handling (must requery
// positionRisk, never assume success) lives in exactly one place.
async function attemptCancel(
  client: RunnerClient, symbol: string, orderId: number, result: RunnerCycleResult, isAlgoOrder: boolean,
) {
  try {
    await client.cancelOrder(symbol, orderId, isAlgoOrder);
    return resolveCancelOutcome({ success: true });
  } catch (e) {
    const code = extractBinanceErrorCode(e);
    if (code !== BINANCE_ERR_UNKNOWN_ORDER) {
      return resolveCancelOutcome({ success: false, errorCode: code });
    }
    try {
      const positions = await client.getPositionRisk(symbol);
      const qty = positions[0] ? parseFloat(positions[0].positionAmt) : 0;
      return resolveCancelOutcome({ success: false, errorCode: code }, qty);
    } catch (requeryErr) {
      result.errors.push(`${symbol} 撤單 race 重查 positionRisk 失敗: ${String(requeryErr)}`);
      return resolveCancelOutcome({ success: false, errorCode: code }); // no positionQtyAfterRequery → resolves to 'ambiguous'
    }
  }
}

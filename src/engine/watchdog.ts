// Reconciliation: compares live exchange state (positions, open orders) against
// what SHOULD be true — every open position must have a protective stop order.
// This is the last line of defense against a "naked" position (see docs/TODO.md
// 自動化交易 — 裸倉 is the single most dangerous failure mode this system guards
// against: a fill that succeeds while the paired stop order never lands, or a
// stop that gets cancelled without the position being closed).
//
// Pure — takes plain position/order snapshots, returns a list of anomalies. The
// caller (a polling loop, not included here) is responsible for fetching those
// snapshots via BinanceFuturesClient and for deciding what to DO about each
// anomaly (page the human, attempt an auto-repair order, or escalate to the
// kill switch via shouldAutoActivateKillSwitch's consecutiveUnreconciledScans).

import { AlgoOrder, OpenOrder, PositionRisk } from './binanceClient';

export type AnomalyKind = 'position_without_stop' | 'orphan_stop_order';

export interface ReconcileAnomaly {
  kind: AnomalyKind;
  symbol: string;
  detail: string;
}

const STOP_ORDER_TYPES = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);

// 2026-08-08：幣安 2025-12 遷移後，STOP_MARKET/TAKE_PROFIT_MARKET 都活在
// /fapi/v1/openAlgoOrders，不會出現在 openOrders 裡了——只看 openOrders 會
// 對每個真的有保護的部位誤報 position_without_stop。openOrders 這個參數還是
// 留著（保留舊資料相容、也讓現有測試不用改），但真正的保護單來源現在是
// openAlgoOrders。
export function reconcilePositionsAndOrders(
  positions: PositionRisk[],
  openOrders: OpenOrder[],
  openAlgoOrders: AlgoOrder[] = [],
): ReconcileAnomaly[] {
  const anomalies: ReconcileAnomaly[] = [];

  const openPositionSymbols = new Set(
    positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol),
  );

  const stopOrdersBySymbol = new Map<string, Array<{ orderId: number; type: string }>>();
  for (const o of openOrders) {
    if (!STOP_ORDER_TYPES.has(o.type)) continue;
    const list = stopOrdersBySymbol.get(o.symbol) ?? [];
    list.push({ orderId: o.orderId, type: o.type });
    stopOrdersBySymbol.set(o.symbol, list);
  }
  for (const a of openAlgoOrders) {
    if (!STOP_ORDER_TYPES.has(a.orderType)) continue;
    const list = stopOrdersBySymbol.get(a.symbol) ?? [];
    list.push({ orderId: a.algoId, type: a.orderType });
    stopOrdersBySymbol.set(a.symbol, list);
  }

  // Every open position needs at least one live protective stop order.
  for (const p of positions) {
    const amt = parseFloat(p.positionAmt);
    if (amt === 0) continue;
    const stops = stopOrdersBySymbol.get(p.symbol) ?? [];
    if (stops.length === 0) {
      anomalies.push({
        kind: 'position_without_stop',
        symbol: p.symbol,
        detail: `持倉 ${amt}（entry ${p.entryPrice}）沒有對應的止損/止盈單`,
      });
    }
  }

  // A stop order referencing a symbol with no open position is an orphan —
  // usually leftover from a position that closed without the paired order
  // being cancelled. Not dangerous by itself, but it clutters open-order
  // limits and can confuse the next reconcile pass.
  stopOrdersBySymbol.forEach((stops, symbol) => {
    if (!openPositionSymbols.has(symbol)) {
      for (const o of stops) {
        anomalies.push({
          kind: 'orphan_stop_order',
          symbol,
          detail: `訂單 ${o.orderId}（${o.type}）沒有對應的持倉`,
        });
      }
    }
  });

  return anomalies;
}

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
  // 2026-08-18：orphan_stop_order 專用——原本訂單編號只寫在 detail 字串裡，
  // 呼叫端想真的把這張孤兒單撤掉還得去解析字串。獨立欄位讓「偵測」跟「善後」
  // 可以接起來（見 live-runner 全帳戶對帳那段的自動撤單）。
  orderId?: number;
  /** orphan_stop_order 專用：true = 平倉用或 S3 自己的單，可以自動撤；false = 可能是手動條件進場單，只回報 */
  cancellable?: boolean;
}

const STOP_ORDER_TYPES = new Set(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
// 2026-11-11：只有「平倉方向的止損類單」才算保護。原本 TAKE_PROFIT_MARKET 也算，而且不看方向——
// S3-B 的加碼單是 BUY STOP_MARKET（非 reduceOnly），止損單不見時它會讓多單看起來「有保護」；
// 只剩止盈單的部位在價格往下時同樣沒有任何東西擋。
const PROTECTIVE_TYPES = new Set(['STOP_MARKET', 'STOP', 'TRAILING_STOP_MARKET']);

interface CondOrder { orderId: number; type: string; side: string; reduceOnly: boolean; closePosition: boolean; clientId: string }

/** 這張孤兒條件單可以自動撤嗎：只撤「平倉用」（reduceOnly／closePosition）或 S3 自己掛的（s3a-）。
 *  手機 App 手動掛的條件進場單（沒有持倉、非 reduceOnly）不碰——撤掉等於替使用者取消下單。 */
export function isAutoCancellableOrphan(o: { reduceOnly?: boolean; closePosition?: boolean; clientId?: string }): boolean {
  return !!o.reduceOnly || !!o.closePosition || (o.clientId ?? '').startsWith('s3a-');
}

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

  const condBySymbol = new Map<string, CondOrder[]>();
  const add = (symbol: string, o: CondOrder) => {
    const list = condBySymbol.get(symbol) ?? [];
    list.push(o);
    condBySymbol.set(symbol, list);
  };
  for (const o of openOrders) {
    if (!STOP_ORDER_TYPES.has(o.type) && !PROTECTIVE_TYPES.has(o.type)) continue;
    add(o.symbol, { orderId: o.orderId, type: o.type, side: o.side, reduceOnly: !!o.reduceOnly, closePosition: !!o.closePosition, clientId: o.clientOrderId ?? '' });
  }
  for (const a of openAlgoOrders) {
    if (!STOP_ORDER_TYPES.has(a.orderType) && !PROTECTIVE_TYPES.has(a.orderType)) continue;
    add(a.symbol, { orderId: a.algoId, type: a.orderType, side: a.side, reduceOnly: !!a.reduceOnly, closePosition: !!a.closePosition, clientId: a.clientAlgoId ?? '' });
  }

  // 每個持倉都要有至少一張「平倉方向」的止損類條件單（多單 → SELL，空單 → BUY）。
  for (const p of positions) {
    const amt = parseFloat(p.positionAmt);
    if (amt === 0) continue;
    const closeSide = amt > 0 ? 'SELL' : 'BUY';
    const conds = condBySymbol.get(p.symbol) ?? [];
    const stops = conds.filter(o => PROTECTIVE_TYPES.has(o.type) && o.side === closeSide);
    if (stops.length === 0) {
      const others = conds.length ? `（只有 ${conds.map(o => `${o.side} ${o.type}`).join('、')}，不算止損）` : '';
      anomalies.push({
        kind: 'position_without_stop',
        symbol: p.symbol,
        detail: `持倉 ${amt}（entry ${p.entryPrice}）沒有平倉方向的止損單${others}`,
      });
    }
  }

  // 條件單所在的 symbol 沒有持倉 = 孤兒。通常是部位平掉後沒撤乾淨的止盈／止損。
  // cancellable 告訴呼叫端能不能自動撤（見 isAutoCancellableOrphan）。
  condBySymbol.forEach((orders, symbol) => {
    if (!openPositionSymbols.has(symbol)) {
      for (const o of orders) {
        anomalies.push({
          kind: 'orphan_stop_order',
          symbol,
          detail: `訂單 ${o.orderId}（${o.side} ${o.type}${o.reduceOnly ? ' reduceOnly' : ''}${o.clientId ? ` ${o.clientId}` : ''}）沒有對應的持倉`,
          orderId: o.orderId,
          cancellable: isAutoCancellableOrphan(o),
        });
      }
    }
  });

  return anomalies;
}

// 交易所上還掛著、但 DB 已經不追蹤的進場限價單。
//
// 2026-09-23 實測：SOLUSDT trade-1788234624219-hgtbb 與 ZECUSDT
// trade-1788234921181-s8m8j——DB 在 09-01 就記成 `live_entry_expired`
// （decideTradeAction 判定「進場單消失且查無成交」），兩張 LIMIT 單卻一直
// 掛在幣安上三週。當時 openOrders 為什麼沒看到它們已不可考，但後果是確定的：
// 價格一碰到就成交，變成一個沒有止損、live-runner 也不認得的部位（它只管
// closed_at IS NULL 的 trade）。
//
// 全帳戶對帳原本只清「沒有持倉的條件單」，進場限價單不在範圍內。這裡補上：
// clientOrderId 是我們自己的格式 `${tradeId}-entry`，而那個 tradeId 不在
// open trades 裡 → 撤掉。不是這個格式的單（手機 App 手動下的）一律不碰。

const ENTRY_CLIENT_ID = /^(trade-.+)-entry$/;

export interface OrphanEntryOrder {
  symbol: string;
  orderId: number;
  tradeId: string;
}

export function findOrphanEntryOrders(
  openOrders: ReadonlyArray<{ symbol: string; orderId: number; clientOrderId?: string }>,
  openTradeIds: ReadonlySet<string>,
): OrphanEntryOrder[] {
  const out: OrphanEntryOrder[] = [];
  for (const o of openOrders) {
    const m = ENTRY_CLIENT_ID.exec(o.clientOrderId ?? '');
    if (!m) continue;
    if (openTradeIds.has(m[1])) continue;
    out.push({ symbol: o.symbol, orderId: o.orderId, tradeId: m[1] });
  }
  return out;
}

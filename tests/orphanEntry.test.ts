import { describe, it, expect } from 'vitest';
import { findOrphanEntryOrders } from '../src/lib/orphanEntry';

// 2026-09-23 實測：SOLUSDT trade-1788234624219-hgtbb、ZECUSDT
// trade-1788234921181-s8m8j——DB 在 09-01 就記成 live_entry_expired（「進場單
// 消失、查無成交」），但兩張 LIMIT 進場單其實一直掛在幣安上三週。價格一碰到
// 就成交，變成一個沒有止損、系統也不認得的部位。

const o = (symbol: string, orderId: number, clientOrderId: string) => ({ symbol, orderId, clientOrderId });

describe('findOrphanEntryOrders', () => {
  it('trade 已不在 open 清單 → 孤兒', () => {
    const r = findOrphanEntryOrders(
      [o('SOLUSDT', 1, 'trade-1788234624219-hgtbb-entry'), o('BTCUSDT', 2, 'trade-1790150125377-3i0n3-entry')],
      new Set(['trade-1790150125377-3i0n3']),
    );
    expect(r).toEqual([{ symbol: 'SOLUSDT', orderId: 1, tradeId: 'trade-1788234624219-hgtbb' }]);
  });

  it('不是我們下的單（手動單、其他格式）→ 不碰', () => {
    const r = findOrphanEntryOrders(
      [o('ETHUSDT', 3, 'web_abc123'), o('ETHUSDT', 4, 'trade-1-fullclose'), o('ETHUSDT', 5, '')],
      new Set(),
    );
    expect(r).toEqual([]);
  });

  it('open 清單為空 → 所有我們的進場單都是孤兒', () => {
    const r = findOrphanEntryOrders([o('ZECUSDT', 6, 'trade-1788234921181-s8m8j-entry')], new Set());
    expect(r.map(x => x.orderId)).toEqual([6]);
  });

  it('clientOrderId 缺值不當機', () => {
    expect(findOrphanEntryOrders([{ symbol: 'X', orderId: 7 } as never], new Set())).toEqual([]);
  });
});

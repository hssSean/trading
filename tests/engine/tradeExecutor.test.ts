import { describe, expect, it } from 'vitest';
import { executeTradeAction, TradeExecutorClient, TradePersistence } from '../../src/engine/tradeExecutor';
import { PlaceOrderParams } from '../../src/engine/binanceClient';
import { TradeAction } from '../../src/engine/tradeBridge';

// 跟 runner.test.ts 同一套風格：in-memory fake，記錄呼叫順序/參數，
// 沒有真的網路或 DB。
class FakeClient implements TradeExecutorClient {
  placeOrderCalls: PlaceOrderParams[] = [];
  cancelOrderCalls: Array<{ symbol: string; orderId: number; isAlgoOrder?: boolean }> = [];
  nextOrderId = 1000;

  async placeOrder(params: PlaceOrderParams) {
    this.placeOrderCalls.push(params);
    return { orderId: this.nextOrderId++, clientOrderId: params.newClientOrderId ?? '', status: 'NEW' };
  }
  async cancelOrder(symbol: string, orderId: number, isAlgoOrder?: boolean) {
    this.cancelOrderCalls.push({ symbol, orderId, isAlgoOrder });
    return { orderId, status: 'CANCELED' };
  }
}

class FakePersist implements TradePersistence {
  entryOrderIds: Array<{ tradeId: string; orderId: number }> = [];
  stopAlgoIds: Array<{ tradeId: string; algoId: number }> = [];
  tp1HitCalls: string[] = [];
  finalizeCalls: Array<{ tradeId: string; result: unknown }> = [];

  async setEntryOrderId(tradeId: string, orderId: number) { this.entryOrderIds.push({ tradeId, orderId }); }
  async setStopAlgoId(tradeId: string, algoId: number) { this.stopAlgoIds.push({ tradeId, algoId }); }
  async markTp1Hit(tradeId: string) { this.tp1HitCalls.push(tradeId); }
  async finalizeClosed(tradeId: string, result: unknown) { this.finalizeCalls.push({ tradeId, result }); }
}

const order: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 65000 };

describe('executeTradeAction — place_entry', () => {
  it('places the order and persists the resulting orderId', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'place_entry', order, quantity: 0.01 };

    const r = await executeTradeAction(client, persist, 'trade-1', action);

    expect(r.executed).toBe(true);
    expect(client.placeOrderCalls).toEqual([order]);
    expect(persist.entryOrderIds).toEqual([{ tradeId: 'trade-1', orderId: 1000 }]);
  });
});

describe('executeTradeAction — place_initial_stop', () => {
  it('places the stop order and persists the algoId', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const stopOrder: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 64000, closePosition: true };
    const action: TradeAction = { kind: 'place_initial_stop', order: stopOrder };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([stopOrder]);
    expect(persist.stopAlgoIds).toEqual([{ tradeId: 'trade-1', algoId: 1000 }]);
  });
});

describe('executeTradeAction — tp1_partial_close', () => {
  it('places the partial-close order and marks TP1 hit', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const closeOrder: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.005, reduceOnly: true };
    const action: TradeAction = { kind: 'tp1_partial_close', order: closeOrder, closeQty: 0.005, remainingQty: 0.005 };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([closeOrder]);
    expect(persist.tp1HitCalls).toEqual(['trade-1']);
  });
});

describe('executeTradeAction — close_full_position', () => {
  it('places the closing order but does NOT write a final result (next cycle reconciles)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const closeOrder: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.01, reduceOnly: true };
    const action: TradeAction = { kind: 'close_full_position', order: closeOrder };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([closeOrder]);
    expect(persist.finalizeCalls).toEqual([]); // 刻意不寫，交給下一輪 sync_closed_position
  });
});

describe('executeTradeAction — update_trailing_stop', () => {
  it('places the new stop BEFORE cancelling the old one (place-before-cancel)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const place: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 67000, closePosition: true };
    const action: TradeAction = { kind: 'update_trailing_stop', place, cancelOrderId: 222 };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([place]);
    expect(client.cancelOrderCalls).toEqual([{ symbol: 'BTCUSDT', orderId: 222, isAlgoOrder: true }]);
    expect(persist.stopAlgoIds).toEqual([{ tradeId: 'trade-1', algoId: 1000 }]);
  });

  it('skips the cancel step when there was no previous stop (cancelOrderId undefined)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const place: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 64000, closePosition: true };
    const action: TradeAction = { kind: 'update_trailing_stop', place };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.cancelOrderCalls).toEqual([]);
  });
});

describe('executeTradeAction — sync_closed_position', () => {
  it('writes the final result via persist.finalizeClosed', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'sync_closed_position', avgExitPrice: 67000, realizedPnl: 15, result: 'WIN_TP1' };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([]); // 沒有交易所動作，只有 DB 寫入
    expect(persist.finalizeCalls).toEqual([
      { tradeId: 'trade-1', result: { result: 'WIN_TP1', exitPrice: 67000, realizedPnl: 15 } },
    ]);
  });
});

describe('executeTradeAction — no-op actions', () => {
  it('does not touch the client or persistence for skip_entry/wait_for_fill/needs_reconcile/hold', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const actions: TradeAction[] = [
      { kind: 'skip_entry', reason: 'x' },
      { kind: 'wait_for_fill', reason: 'x' },
      { kind: 'needs_reconcile', reason: 'x' },
      { kind: 'hold', reason: 'x' },
    ];

    for (const action of actions) {
      const r = await executeTradeAction(client, persist, 'trade-1', action);
      expect(r.executed).toBe(false);
      expect(r.note).toBe('x');
    }

    expect(client.placeOrderCalls).toEqual([]);
    expect(client.cancelOrderCalls).toEqual([]);
  });
});

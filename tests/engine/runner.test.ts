import { describe, expect, it } from 'vitest';
import { runMonitorCycle, RunnerClient, RunnerDeps, RunnerCycleInput } from '../../src/engine/runner';
import { AlgoOrder, PlaceOrderParams, OpenOrder, PositionRisk } from '../../src/engine/binanceClient';
import { KillSwitchState } from '../../src/engine/killSwitch';
import { BINANCE_ERR_UNKNOWN_ORDER } from '../../src/engine/pendingOrderLifecycle';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

// In-memory fake — no network, no mocking framework. `callLog` records place/
// cancel calls in the order they actually happened so tests can assert
// place-before-cancel sequencing, not just "both were called eventually".
class FakeClient implements RunnerClient {
  positions: PositionRisk[] = [];
  openOrders: OpenOrder[] = [];
  openAlgoOrders: AlgoOrder[] = [];
  callLog: string[] = [];
  placeOrderCalls: PlaceOrderParams[] = [];
  cancelOrderCalls: Array<{ symbol: string; orderId: number; isAlgoOrder?: boolean }> = [];
  cancelOrderImpl?: (symbol: string, orderId: number) => Promise<{ orderId: number; status: string }>;
  placeOrderImpl?: (params: PlaceOrderParams) => Promise<{ orderId: number; clientOrderId: string; status: string }>;

  async getPositionRisk(symbol?: string): Promise<PositionRisk[]> {
    return symbol ? this.positions.filter(p => p.symbol === symbol) : this.positions;
  }
  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    return symbol ? this.openOrders.filter(o => o.symbol === symbol) : this.openOrders;
  }
  async getOpenAlgoOrders(symbol?: string): Promise<AlgoOrder[]> {
    return symbol ? this.openAlgoOrders.filter(o => o.symbol === symbol) : this.openAlgoOrders;
  }
  async placeOrder(params: PlaceOrderParams) {
    this.callLog.push(`place:${params.symbol}:${params.stopPrice ?? params.quantity}`);
    this.placeOrderCalls.push(params);
    if (this.placeOrderImpl) return this.placeOrderImpl(params);
    return { orderId: 999, clientOrderId: params.newClientOrderId ?? '', status: 'NEW' };
  }
  async cancelOrder(symbol: string, orderId: number, isAlgoOrder?: boolean) {
    this.callLog.push(`cancel:${symbol}:${orderId}`);
    this.cancelOrderCalls.push({ symbol, orderId, isAlgoOrder });
    if (this.cancelOrderImpl) return this.cancelOrderImpl(symbol, orderId);
    return { orderId, status: 'CANCELED' };
  }
}

function deps(client: FakeClient, ksState: KillSwitchState = { active: false, reason: null, activatedAt: null }): RunnerDeps {
  return { client, getKillSwitchState: async () => ksState };
}

function emptyInput(): RunnerCycleInput {
  return { pendingCancels: [], tp1Closes: [], trailingStopUpdates: [] };
}

describe('runMonitorCycle — kill switch gating', () => {
  it('skips all actions when the kill switch is active, but still reconciles', async () => {
    const client = new FakeClient();
    client.positions = [{ symbol: 'BTCUSDT', positionAmt: '0.01', entryPrice: '65000', liquidationPrice: '52000', leverage: '5', marginType: 'isolated', isolatedMargin: '130', unRealizedProfit: '0' }];
    // no stop order → watchdog should flag position_without_stop even though kill switch is active
    const r = await runMonitorCycle(
      deps(client, { active: true, reason: '手動啟動', activatedAt: 1 }),
      { ...emptyInput(), tp1Closes: [{ tradeId: 't1', symbol: 'BTCUSDT', isLong: true, positionQty: 0.1, filters }] },
    );
    expect(r.killSwitchActive).toBe(true);
    expect(r.actionsSkipped.some(s => s.includes('kill switch'))).toBe(true);
    expect(r.reconcileAnomalies.some(a => a.kind === 'position_without_stop')).toBe(true);
    expect(client.placeOrderCalls).toHaveLength(0);
  });

  it('fails closed when reading kill switch state throws', async () => {
    const client = new FakeClient();
    const badDeps: RunnerDeps = { client, getKillSwitchState: async () => { throw new Error('redis down'); } };
    const r = await runMonitorCycle(badDeps, emptyInput());
    expect(r.killSwitchActive).toBe(true);
    expect(r.errors.some(e => e.includes('fail closed'))).toBe(true);
  });
});

describe('runMonitorCycle — pending order cancels', () => {
  it('cancels a clean (unfilled) pending order', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      pendingCancels: [{ symbol: 'BTCUSDT', orderId: 5, origQty: 0.1, executedQty: 0 }],
    });
    expect(client.cancelOrderCalls).toEqual([{ symbol: 'BTCUSDT', orderId: 5, isAlgoOrder: false }]);
    expect(r.actionsTaken.some(a => a.includes('已取消'))).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('skips cancelling an order that already fully filled', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      pendingCancels: [{ symbol: 'BTCUSDT', orderId: 5, origQty: 0.1, executedQty: 0.1 }],
    });
    expect(client.cancelOrderCalls).toHaveLength(0);
    expect(r.actionsSkipped.some(s => s.includes('已全部成交'))).toBe(true);
  });

  it('cancels the remainder of a partial fill and flags the filled part for protection', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      pendingCancels: [{ symbol: 'BTCUSDT', orderId: 5, origQty: 0.1, executedQty: 0.04 }],
    });
    expect(client.cancelOrderCalls).toEqual([{ symbol: 'BTCUSDT', orderId: 5, isAlgoOrder: false }]);
    expect(r.actionsTaken.some(a => a.includes('部分成交 0.04') && a.includes('補止損'))).toBe(true);
  });

  it('resolves a cancel/fill race (-2011 + nonzero position) as filled, not an error', async () => {
    const client = new FakeClient();
    client.positions = [{ symbol: 'BTCUSDT', positionAmt: '0.1', entryPrice: '65000', liquidationPrice: '52000', leverage: '5', marginType: 'isolated', isolatedMargin: '130', unRealizedProfit: '0' }];
    client.cancelOrderImpl = async () => { throw { response: { data: { code: BINANCE_ERR_UNKNOWN_ORDER, msg: 'Unknown order sent.' } } }; };
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      pendingCancels: [{ symbol: 'BTCUSDT', orderId: 5, origQty: 0.1, executedQty: 0 }],
    });
    expect(r.errors).toEqual([]);
    expect(r.actionsTaken.some(a => a.includes('撤單前已成交'))).toBe(true);
  });

  it('resolves -2011 + zero position as a clean cancel (order was already gone)', async () => {
    const client = new FakeClient();
    client.positions = []; // flat
    client.cancelOrderImpl = async () => { throw { response: { data: { code: BINANCE_ERR_UNKNOWN_ORDER } } }; };
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      pendingCancels: [{ symbol: 'BTCUSDT', orderId: 5, origQty: 0.1, executedQty: 0 }],
    });
    expect(r.errors).toEqual([]);
    expect(r.actionsTaken.some(a => a.includes('已取消'))).toBe(true);
  });

  it('surfaces an unresolvable cancel failure as an error instead of guessing', async () => {
    const client = new FakeClient();
    client.cancelOrderImpl = async () => { throw { response: { data: { code: -1021, msg: 'Timestamp outside recvWindow' } } }; };
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      pendingCancels: [{ symbol: 'BTCUSDT', orderId: 5, origQty: 0.1, executedQty: 0 }],
    });
    expect(r.errors.some(e => e.includes('無法判定'))).toBe(true);
  });
});

describe('runMonitorCycle — TP1 partial close', () => {
  it('places a reduceOnly order for the correct fraction', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      tp1Closes: [{ tradeId: 'trade-1', symbol: 'BTCUSDT', isLong: true, positionQty: 0.1, filters }],
    });
    expect(client.placeOrderCalls).toHaveLength(1);
    expect(client.placeOrderCalls[0]).toMatchObject({ side: 'SELL', type: 'MARKET', quantity: 0.05, reduceOnly: true });
    expect(r.actionsTaken.some(a => a.includes('TP1 部分平倉'))).toBe(true);
  });

  it('skips and records the reason when the decision says skip (e.g. zero position)', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      tp1Closes: [{ tradeId: 'trade-1', symbol: 'BTCUSDT', isLong: true, positionQty: 0, filters }],
    });
    expect(client.placeOrderCalls).toHaveLength(0);
    expect(r.actionsSkipped.some(s => s.includes('TP1 部分平倉跳過'))).toBe(true);
  });

  it('records an error without throwing when placeOrder rejects', async () => {
    const client = new FakeClient();
    client.placeOrderImpl = async () => { throw new Error('insufficient margin'); };
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      tp1Closes: [{ tradeId: 'trade-1', symbol: 'BTCUSDT', isLong: true, positionQty: 0.1, filters }],
    });
    expect(r.errors.some(e => e.includes('TP1 部分平倉下單失敗'))).toBe(true);
  });
});

describe('runMonitorCycle — trailing stop replace', () => {
  it('initializes a stop when none exists yet (place only, no cancel)', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      trailingStopUpdates: [{ tradeId: 't1', symbol: 'BTCUSDT', isLong: true, currentStopOrder: null, desiredStopPrice: 65100, filters }],
    });
    expect(client.placeOrderCalls).toHaveLength(1);
    expect(client.cancelOrderCalls).toHaveLength(0);
    expect(r.actionsTaken.some(a => a.includes('初始化'))).toBe(true);
  });

  it('places the new stop BEFORE cancelling the old one when ratcheting', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      trailingStopUpdates: [{
        tradeId: 't1', symbol: 'BTCUSDT', isLong: true,
        currentStopOrder: { orderId: 111, stopPrice: 64900 },
        desiredStopPrice: 65200,
        filters,
      }],
    });
    expect(client.callLog).toEqual(['place:BTCUSDT:65200', 'cancel:BTCUSDT:111']);
    expect(r.actionsTaken.some(a => a.includes('更新'))).toBe(true);
    // 舊止損單是條件單（STOP_MARKET），撤單要走 algoOrder 端點，不是 order——
    // 標錯會撤到一個不存在的普通訂單，實際的舊止損完全沒被清掉。
    expect(client.cancelOrderCalls).toEqual([{ symbol: 'BTCUSDT', orderId: 111, isAlgoOrder: true }]);
  });

  it('does nothing when the target is not more favorable than the current stop', async () => {
    const client = new FakeClient();
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      trailingStopUpdates: [{
        tradeId: 't1', symbol: 'BTCUSDT', isLong: true,
        currentStopOrder: { orderId: 111, stopPrice: 65000 },
        desiredStopPrice: 64800, // worse
        filters,
      }],
    });
    expect(client.placeOrderCalls).toHaveLength(0);
    expect(client.cancelOrderCalls).toHaveLength(0);
  });

  it('does NOT cancel the old stop when placing the new one fails (keeps existing protection)', async () => {
    const client = new FakeClient();
    client.placeOrderImpl = async () => { throw new Error('rate limited'); };
    const r = await runMonitorCycle(deps(client), {
      ...emptyInput(),
      trailingStopUpdates: [{
        tradeId: 't1', symbol: 'BTCUSDT', isLong: true,
        currentStopOrder: { orderId: 111, stopPrice: 64900 },
        desiredStopPrice: 65200,
        filters,
      }],
    });
    expect(client.cancelOrderCalls).toHaveLength(0);
    expect(r.errors.some(e => e.includes('保留舊止損不動'))).toBe(true);
  });
});

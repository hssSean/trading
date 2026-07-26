import { describe, expect, it } from 'vitest';
import { OpenOrder, PositionRisk } from '../../src/engine/binanceClient';
import { reconcilePositionsAndOrders } from '../../src/engine/watchdog';

function position(overrides: Partial<PositionRisk> = {}): PositionRisk {
  return {
    symbol: 'BTCUSDT',
    positionAmt: '0.01',
    entryPrice: '65000',
    liquidationPrice: '52000',
    leverage: '5',
    marginType: 'isolated',
    isolatedMargin: '130',
    unRealizedProfit: '0',
    ...overrides,
  };
}

function stopOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    symbol: 'BTCUSDT',
    orderId: 1,
    clientOrderId: 'trade-1-sl',
    side: 'SELL',
    type: 'STOP_MARKET',
    status: 'NEW',
    origQty: '0',
    executedQty: '0',
    stopPrice: '64350',
    closePosition: true,
    ...overrides,
  };
}

describe('reconcilePositionsAndOrders', () => {
  it('reports no anomalies when every position has a matching stop order', () => {
    const anomalies = reconcilePositionsAndOrders([position()], [stopOrder()]);
    expect(anomalies).toEqual([]);
  });

  it('reports no anomalies when there are no positions and no stop orders', () => {
    expect(reconcilePositionsAndOrders([], [])).toEqual([]);
  });

  it('flags a position with zero matching stop orders (the naked-position case)', () => {
    const anomalies = reconcilePositionsAndOrders([position()], []);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('position_without_stop');
    expect(anomalies[0].symbol).toBe('BTCUSDT');
  });

  it('ignores flat positions (positionAmt "0") even without a stop order', () => {
    const anomalies = reconcilePositionsAndOrders([position({ positionAmt: '0' })], []);
    expect(anomalies).toEqual([]);
  });

  it('recognizes a short position (negative positionAmt) as needing a stop too', () => {
    const anomalies = reconcilePositionsAndOrders([position({ positionAmt: '-0.01' })], []);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('position_without_stop');
  });

  it('flags a stop order whose symbol has no open position (orphan)', () => {
    const anomalies = reconcilePositionsAndOrders([], [stopOrder()]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('orphan_stop_order');
  });

  it('does not treat a TAKE_PROFIT_MARKET order as satisfying the requirement differently from STOP_MARKET', () => {
    const anomalies = reconcilePositionsAndOrders(
      [position()],
      [stopOrder({ type: 'TAKE_PROFIT_MARKET', orderId: 2 })],
    );
    expect(anomalies).toEqual([]);
  });

  it('does not flag a plain LIMIT entry order as satisfying the stop requirement (it is not protective)', () => {
    const anomalies = reconcilePositionsAndOrders(
      [position()],
      [stopOrder({ type: 'LIMIT', orderId: 3 })],
    );
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('position_without_stop');
  });

  it('handles multiple symbols independently', () => {
    const anomalies = reconcilePositionsAndOrders(
      [position({ symbol: 'BTCUSDT' }), position({ symbol: 'ETHUSDT' })],
      [stopOrder({ symbol: 'BTCUSDT' })], // ETHUSDT position has no stop
    );
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].symbol).toBe('ETHUSDT');
  });
});

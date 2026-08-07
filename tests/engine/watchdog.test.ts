import { describe, expect, it } from 'vitest';
import { AlgoOrder, OpenOrder, PositionRisk } from '../../src/engine/binanceClient';
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

function algoStopOrder(overrides: Partial<AlgoOrder> = {}): AlgoOrder {
  return {
    algoId: 3000000000003505,
    clientAlgoId: 'trade-1-sl',
    symbol: 'BTCUSDT',
    side: 'SELL',
    orderType: 'STOP_MARKET',
    algoStatus: 'NEW',
    triggerPrice: '64350',
    quantity: '0',
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

// 2026-08-08：幣安 2025-12 遷移後條件單活在 openAlgoOrders，不再出現在
// openOrders 裡——這組測試沒過，代表 watchdog 會對每個真的有保護的部位誤報
// position_without_stop（見對話紀錄：live-runner 第一次接上真帳戶就撞到這個）。
describe('reconcilePositionsAndOrders — openAlgoOrders (2025-12 遷移後的條件單來源)', () => {
  it('recognizes a stop order that only exists in openAlgoOrders (not openOrders) as protection', () => {
    const anomalies = reconcilePositionsAndOrders([position()], [], [algoStopOrder()]);
    expect(anomalies).toEqual([]);
  });

  it('still flags a naked position when openAlgoOrders is empty too', () => {
    const anomalies = reconcilePositionsAndOrders([position()], [], []);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('position_without_stop');
  });

  it('does not treat a TAKE_PROFIT_MARKET algo order as satisfying the requirement differently from STOP_MARKET', () => {
    const anomalies = reconcilePositionsAndOrders(
      [position()], [], [algoStopOrder({ orderType: 'TAKE_PROFIT_MARKET', algoId: 2 })],
    );
    expect(anomalies).toEqual([]);
  });

  it('flags an orphan algo stop order whose symbol has no open position', () => {
    const anomalies = reconcilePositionsAndOrders([], [], [algoStopOrder()]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('orphan_stop_order');
  });

  it('combines both sources: an openOrders stop AND an openAlgoOrders stop both count toward the same symbol', () => {
    const anomalies = reconcilePositionsAndOrders(
      [position({ symbol: 'BTCUSDT' }), position({ symbol: 'ETHUSDT' })],
      [stopOrder({ symbol: 'BTCUSDT' })],
      [algoStopOrder({ symbol: 'ETHUSDT', algoId: 2 })],
    );
    expect(anomalies).toEqual([]);
  });
});

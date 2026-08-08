import { describe, expect, it } from 'vitest';
import { decideTradeAction, BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput } from '../../src/engine/tradeBridge';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

function tradeRow(overrides: Partial<BridgeTradeRow> = {}): BridgeTradeRow {
  return {
    id: 'trade-1', symbol: 'BTCUSDT', isLong: true,
    entry: 65000, stopLoss: 64000, tp1: 67000,
    exchangeEntryOrderId: null, exchangeStopAlgoId: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BridgeExchangeSnapshot> = {}): BridgeExchangeSnapshot {
  return {
    positionQty: 0, entryOrderStillOpen: false, currentStop: null,
    markPrice: 65000, filters,
    ...overrides,
  };
}

function risk(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    positionUSDT: 650, totalOpenRiskPct: 0, thisTradeRiskPct: 1,
    liquidation: { isolatedMarginUSDT: 500, maintMarginRatio: 0.004, maintAmount: 0 },
    ...overrides,
  };
}

describe('decideTradeAction — no entry order placed yet', () => {
  it('places the entry order when risk and liquidation checks pass', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk());
    expect(a.kind).toBe('place_entry');
  });

  it('skips when the global risk cap would be exceeded', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk({ totalOpenRiskPct: 4.5, thisTradeRiskPct: 1 }));
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('全局風險上限');
  });

  it('skips when liquidation would happen before the stop-loss (leverage too high)', () => {
    // isolatedMarginUSDT 很小（高槓桿）讓強平價比止損更早觸發
    const a = decideTradeAction(
      tradeRow({ entry: 100, stopLoss: 90 }),
      snapshot(),
      risk({ positionUSDT: 1000, liquidation: { isolatedMarginUSDT: 15, maintMarginRatio: 0, maintAmount: 0 } }),
    );
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('強平價');
  });

  it('skips when the resulting position would be below minNotional', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk({ positionUSDT: 0.001 }));
    expect(a.kind).toBe('skip_entry');
  });
});

describe('decideTradeAction — entry order placed, waiting for fill', () => {
  it('waits when the entry order is still open and no position exists yet', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true }),
      risk(),
    );
    expect(a.kind).toBe('wait_for_fill');
  });
});

describe('decideTradeAction — needs reconcile', () => {
  it('flags for reconcile when the position is flat AND the entry order is gone (ambiguous: cancelled vs closed)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false }),
      risk(),
    );
    expect(a.kind).toBe('needs_reconcile');
  });
});

describe('decideTradeAction — filled position, no stop yet (the naked-position window)', () => {
  it('places the initial stop as top priority', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0.01, currentStop: null }),
      risk(),
    );
    expect(a.kind).toBe('place_initial_stop');
    if (a.kind !== 'place_initial_stop') return;
    expect(a.order.type).toBe('STOP_MARKET');
    expect(a.order.closePosition).toBe(true);
  });
});

describe('decideTradeAction — TP1 partial close', () => {
  it('triggers TP1 partial close when price touches tp1 and the stop is still the original one', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 }, // 等於 trade.stopLoss → 還是初始止損
        markPrice: 67100, // >= tp1
      }),
      risk(),
    );
    expect(a.kind).toBe('tp1_partial_close');
  });

  it('does NOT re-trigger TP1 close once the stop has already moved off the original stopLoss', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.005,
        currentStop: { algoId: 222, triggerPrice: 65500 }, // 已經移動過，不是原始 stopLoss 64000
        markPrice: 67100,
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('holds when price has not reached tp1 yet', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 66000, // < tp1 (67000)
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('mirrors TP1 touch direction for SHORT (price at or below tp1)', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 62900, // <= tp1
      }),
      risk(),
    );
    expect(a.kind).toBe('tp1_partial_close');
  });
});

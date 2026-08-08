import { describe, expect, it } from 'vitest';
import {
  decideTradeAction, summarizeClosingTrades,
  BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput,
} from '../../src/engine/tradeBridge';
import { UserTrade } from '../../src/engine/binanceClient';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

function tradeRow(overrides: Partial<BridgeTradeRow> = {}): BridgeTradeRow {
  return {
    id: 'trade-1', symbol: 'BTCUSDT', isLong: true,
    entry: 65000, stopLoss: 64000, tp1: 67000, strategy: 'A',
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

  it('resolves to sync_closed_position when the caller has already fetched recentTrades', () => {
    const trades: UserTrade[] = [
      { id: 1, orderId: 999, symbol: 'BTCUSDT', side: 'SELL', price: '67000', qty: '0.01', quoteQty: '670', realizedPnl: '15', commission: '0.5', commissionAsset: 'USDT', time: 1, maker: false, buyer: false },
    ];
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: trades }),
      risk(),
    );
    expect(a.kind).toBe('sync_closed_position');
    if (a.kind !== 'sync_closed_position') return;
    expect(a.avgExitPrice).toBe(67000);
    expect(a.realizedPnl).toBe(15);
  });

  it('falls back to needs_reconcile when recentTrades is provided but empty', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: [] }),
      risk(),
    );
    expect(a.kind).toBe('needs_reconcile');
  });
});

describe('summarizeClosingTrades', () => {
  it('returns null for an empty list', () => {
    expect(summarizeClosingTrades([])).toBeNull();
  });

  it('computes a quantity-weighted average exit price across multiple fills at different prices', () => {
    const trades: UserTrade[] = [
      { id: 1, orderId: 1, symbol: 'BTCUSDT', side: 'SELL', price: '66000', qty: '0.006', quoteQty: '396', realizedPnl: '6', commission: '0.3', commissionAsset: 'USDT', time: 1, maker: true, buyer: false },
      { id: 2, orderId: 1, symbol: 'BTCUSDT', side: 'SELL', price: '68000', qty: '0.004', quoteQty: '272', realizedPnl: '9', commission: '0.2', commissionAsset: 'USDT', time: 2, maker: false, buyer: false },
    ];
    const s = summarizeClosingTrades(trades);
    expect(s).not.toBeNull();
    if (!s) return;
    // (396+272)/(0.006+0.004) = 668/0.01 = 66800 — 加權平均，不是 (66000+68000)/2
    expect(s.avgExitPrice).toBeCloseTo(66800, 6);
    expect(s.totalQty).toBeCloseTo(0.01, 8);
    expect(s.totalRealizedPnl).toBeCloseTo(15, 8);
    expect(s.totalCommission).toBeCloseTo(0.5, 8);
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

describe('decideTradeAction — strategy B (single take-profit target, tp1==tp2)', () => {
  it('closes the FULL position (not a partial) once price touches the target', () => {
    const a = decideTradeAction(
      tradeRow({ strategy: 'B', exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 67100, // >= tp1
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.order.quantity).toBe(0.01); // 全部部位，不是 50%
  });

  it('holds when price has not reached the target yet', () => {
    const a = decideTradeAction(
      tradeRow({ strategy: 'B', exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 66000, // < tp1
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });
});

describe('decideTradeAction — strategy A trailing stop after TP1', () => {
  it('updates the trailing stop when atr1h is available and the target is more favorable', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.005,
        currentStop: { algoId: 222, triggerPrice: 66000 }, // 已經初始化過，不等於原始 stopLoss(64000)
        markPrice: 68000,
        atr1h: 500, // candidate = 68000-1000=67000 > 66000 → 更有利
      }),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(67000);
    expect(a.cancelOrderId).toBe(222);
  });

  it('holds without moving the stop when no ATR data is available yet', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.005,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 68000,
        // atr1h 未提供
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('holds when the target is not more favorable than the current stop (no unnecessary order)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({
        positionQty: 0.005,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 66200,
        atr1h: 500, // candidate = 66200-1000=65200 < 66000 → 沒有更有利
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });
});

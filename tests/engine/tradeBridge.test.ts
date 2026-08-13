import { describe, expect, it } from 'vitest';
import {
  decideTradeAction, summarizeClosingTrades, deriveLiveCloseReason,
  BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput,
} from '../../src/engine/tradeBridge';
import { UserTrade } from '../../src/engine/binanceClient';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

function tradeRow(overrides: Partial<BridgeTradeRow> = {}): BridgeTradeRow {
  return {
    id: 'trade-1', symbol: 'BTCUSDT', isLong: true,
    entry: 65000, stopLoss: 64000, tp1: 67000, strategy: 'A',
    timeframe: '1h', filledAt: 0, // filledAt=now=0 → 時間止損兩個門檻都不會觸發，不干擾既有測試
    openedAt: 0, // 同上，跟 snapshot.now=0 同值，掛單過期判斷不會誤觸發
    entryQty: null,
    exchangeEntryOrderId: null, exchangeStopAlgoId: null, exchangeTp1AlgoId: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BridgeExchangeSnapshot> = {}): BridgeExchangeSnapshot {
  return {
    positionQty: 0, entryOrderStillOpen: false, currentStop: null,
    markPrice: 65000, filters, now: 0,
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

  // 2026-08-11：實測撞到——SOLUSDT 掛單等了 15 小時 28 分還沒成交，
  // decideTradeAction 從沒判斷過「這張單本身是不是已經掛太久了」，只會
  // 無限期回 wait_for_fill。規格 §3-A：掛單有效期最多 4 根該時框 K 線
  // （1h timeframe = 4 小時）。
  it('cancels the stale entry order once it has been open longer than 4 bars of its timeframe (1h → 4h)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '1h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 4 * 60 * 60_000 }), // exactly 4h later
      risk(),
    );
    expect(a.kind).toBe('cancel_stale_entry');
    if (a.kind !== 'cancel_stale_entry') return;
    expect(a.symbol).toBe('BTCUSDT');
    expect(a.orderId).toBe(111);
  });

  it('still waits when the entry order has not yet reached the expiry window', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '1h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 3 * 60 * 60_000 }), // 3h < 4h expiry
      risk(),
    );
    expect(a.kind).toBe('wait_for_fill');
  });

  it('scales the expiry window to the timeframe (4h bars → 16h expiry)', () => {
    const stillWaiting = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '4h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 15 * 60 * 60_000 }),
      risk(),
    );
    expect(stillWaiting.kind).toBe('wait_for_fill');

    const expired = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '4h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 16 * 60 * 60_000 }),
      risk(),
    );
    expect(expired.kind).toBe('cancel_stale_entry');
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
    expect(a.result).toBe('WIN_TP1'); // positive realizedPnl → 粗分類為贏
  });

  it('classifies a negative realizedPnl as LOSS (not WIN_TP1)', () => {
    const trades: UserTrade[] = [
      { id: 1, orderId: 999, symbol: 'BTCUSDT', side: 'SELL', price: '64000', qty: '0.01', quoteQty: '640', realizedPnl: '-10', commission: '0.5', commissionAsset: 'USDT', time: 1, maker: false, buyer: false },
    ];
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: trades }),
      risk(),
    );
    expect(a.kind).toBe('sync_closed_position');
    if (a.kind !== 'sync_closed_position') return;
    expect(a.result).toBe('LOSS');
  });

  it('resolves to entry_never_filled when recentTrades was queried and is confirmed empty (entry order vanished, never actually filled)', () => {
    // 2026-08-09：實測撞到 SOLUSDT——LIMIT 進場單在交易所端自己消失（過期/
    // 取消），從未真的成交過，getUserTrades 查回來自然是空陣列，不是查
    // 詢失敗。這種情況不該卡在 needs_reconcile：查過、確認過，答案就是
    // 「這筆單沒開過倉」。
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: [] }),
      risk(),
    );
    expect(a.kind).toBe('entry_never_filled');
  });

  it('still falls back to needs_reconcile when recentTrades was never queried (undefined, not empty)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false }), // recentTrades undefined
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

describe('decideTradeAction — TP1 order placement (strategy A, partial)', () => {
  it('places the TP1 condition order when none is placed yet and TP1 has not happened', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: null }),
      snapshot({
        positionQty: 0.01, // 還是滿倉，等於 entryQty
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind !== 'place_tp1_order') return;
    expect(a.order.type).toBe('TAKE_PROFIT_MARKET');
    expect(a.order.quantity).toBe(0.005); // 一半，不是全部
    expect(a.order.side).toBe('SELL');
  });

  it('mirrors side for SHORT', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, exchangeEntryOrderId: 111, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 66000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind !== 'place_tp1_order') return;
    expect(a.order.side).toBe('BUY');
  });

  it('holds (waiting for the exchange to trigger it) once the TP1 order is already placed and position has not shrunk', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01, // 還是滿倉
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });
});

describe('decideTradeAction — pre-TP1 breakeven arm (策略修改.md 修改1, 真倉鏡像)', () => {
  // tradeRow 預設 entry=65000, stopLoss=64000, tp1=67000 → riskDist=1000,
  // 0.8R 門檻 = entry + 800 = 65800（LONG）。
  it('moves the stop to breakeven once markPrice reaches +0.8R, before TP1 happens', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01, // TP1 還沒發生（entryQty 沒有變小）
        currentStop: { algoId: 222, triggerPrice: 64000 }, // 原始止損，還沒 arm 過
        markPrice: 65800, // entry(65000) + 0.8×riskDist(1000) = 65800
      }),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(65000); // 進場價（保本）
    expect(a.cancelOrderId).toBe(222);
  });

  it('holds without arming when markPrice has not yet reached the 0.8R threshold', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 65700, // 差 100，還沒到 0.8R
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('is idempotent — does not re-replace once already armed at breakeven', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 65000 }, // 已經 arm 過（= entry）
        markPrice: 65800,
      }),
      risk(),
    );
    expect(a.kind).toBe('hold'); // decideTrailingStopReplace 回 'none'（目標沒有更有利）
  });

  it('mirrors for SHORT — favorable move is price falling', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 64200, // entry(65000) - 0.8×riskDist(1000) = 64200
      }),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(65000);
  });
});

describe('decideTradeAction — strategy B (single take-profit target, tp1==tp2)', () => {
  it('places a full-close TP1 condition order (closePosition) when none is placed yet', () => {
    const a = decideTradeAction(
      tradeRow({ strategy: 'B', exchangeEntryOrderId: 111, exchangeTp1AlgoId: null }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind !== 'place_tp1_order') return;
    expect(a.order.closePosition).toBe(true);
    expect(a.order.quantity).toBeUndefined();
  });

  it('holds once the TP1 condition order is already placed', () => {
    const a = decideTradeAction(
      tradeRow({ strategy: 'B', exchangeEntryOrderId: 111, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });
});

describe('decideTradeAction — strategy A trailing stop after TP1', () => {
  it('updates the trailing stop when atr1h is available and the target is more favorable', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.005, // < entryQty * 0.99 → TP1 已發生
        currentStop: { algoId: 222, triggerPrice: 66000 },
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
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
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
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
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

  it('does not treat a partially-filled entry (entryQty null) as TP1 having happened', () => {
    // entryQty 是 null（理論上不該發生在有止損的情況，但保守起見不能誤判）
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: null, exchangeTp1AlgoId: null }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order'); // 沒把 entryQty=null 誤判成「已經 TP1」
  });
});

describe('decideTradeAction — time stop forces a close_full_position with the real reason attached', () => {
  it('fires stall (progress stuck near breakeven for 8+ bars, pre-TP1)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, filledAt: 0, exchangeTp1AlgoId: 333, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.01, // 還沒 TP1
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 65100, // progress = 0.1R，卡在 -0.3~0.3 之間
        now: 8.5 * 3600_000, // 8.5 小時 = 8.5 根 1h K 線，超過 8 根門檻
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.closeReason).toBe('time_stop_stall');
  });

  it('fires expiry (24h age limit, pre-TP1, progress not stuck)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, filledAt: 0, exchangeTp1AlgoId: 333, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 65600, // progress = 0.6R，不在停滯區間，不會被 stall 攔截
        now: 25 * 3600_000, // 25 小時，超過 intraday 24h 上限
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.closeReason).toBe('time_stop_expiry');
  });

  it('fires expiry_post_tp1 (24h age limit reached after TP1 already happened)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, filledAt: 0, exchangeTp1AlgoId: 333, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.005, // < entryQty * 0.99 → TP1 已發生
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 66500,
        now: 25 * 3600_000,
        // atr1h 未提供 → 不會走移動止損分支，直接落到 holdOrTimeStop
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.closeReason).toBe('time_stop_expiry_post_tp1');
  });
});

describe('deriveLiveCloseReason', () => {
  // LONG example: entry 100, stopLoss 95 — used across the LOSS-branch tests
  // below since distinguishing pre_tp1_breakeven vs stop_loss now needs a
  // real entry/stopLoss/avgExitPrice comparison, not just the binary result.
  const longParams = { entry: 100, stopLoss: 95 };

  it('trusts our own pending reason when we forced the close ourselves — no guessing', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: 'time_stop_stall', strategy: 'A', result: 'LOSS',
      ...longParams, avgExitPrice: 95,
    })).toBe('time_stop_stall');
    expect(deriveLiveCloseReason({
      pendingCloseReason: 'time_stop_expiry_post_tp1', strategy: 'A', result: 'WIN_TP1',
      ...longParams, avgExitPrice: 110,
    })).toBe('time_stop_expiry_post_tp1');
  });

  it('falls back to stop_loss for a LOSS with no pending reason — exit price is close to the original stop', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'A', result: 'LOSS',
      ...longParams, avgExitPrice: 94.98, // near stopLoss=95, far from entry=100
    })).toBe('stop_loss');
  });

  // 2026-08-13（策略修改.md 修改1）：pre-TP1 保本止損上線後，LOSS 不再
  // 保證是原始止損——出場價貼近 entry（跟 stopLoss 有明顯距離）代表是
  // 保本止損觸發，不是原始止損。
  it('distinguishes pre_tp1_breakeven from stop_loss by comparing exit price to both known levels', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'A', result: 'LOSS',
      ...longParams, avgExitPrice: 99.95, // near entry=100 (slippage), far from stopLoss=95
    })).toBe('pre_tp1_breakeven');
  });

  it('falls back to tp2 for a strategy B WIN — its take-profit is a single full-close target', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'B', result: 'WIN_TP1',
      ...longParams, avgExitPrice: 110,
    })).toBe('tp2');
  });

  it('falls back to trailing_stop for a strategy A WIN — position could only hit zero after TP1 partial-filled', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'A', result: 'WIN_TP1',
      ...longParams, avgExitPrice: 108,
    })).toBe('trailing_stop');
  });
});

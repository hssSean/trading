import { describe, expect, it } from 'vitest';
import {
  calcTrailingStopTarget,
  decideEntryOrder,
  decideFullClose,
  decideTp1OrderPlacement,
  decideTrailingStopReplace,
  EntryOrderInput,
  FullCloseInput,
  Tp1OrderInput,
  TrailingStopReplaceInput,
  TrailingStopTargetInput,
} from '../../src/engine/orderLifecycle';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

function tp1Input(overrides: Partial<Tp1OrderInput> = {}): Tp1OrderInput {
  return {
    tradeId: 'trade-1',
    symbol: 'BTCUSDT',
    isLong: true,
    strategy: 'A',
    positionQty: 0.1,
    tp1: 67000,
    filters,
    ...overrides,
  };
}

function entryInput(overrides: Partial<EntryOrderInput> = {}): EntryOrderInput {
  return {
    tradeId: 'trade-1',
    symbol: 'BTCUSDT',
    isLong: true,
    entry: 65000,
    positionUSDT: 650, // → 0.01 BTC at entry=65000
    filters,
    ...overrides,
  };
}

describe('decideEntryOrder', () => {
  it('places a LIMIT order for the correct quantity (LONG → BUY)', () => {
    const d = decideEntryOrder(entryInput());
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.quantity).toBe(0.01);
    expect(d.order).toEqual({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 0.01,
      price: 65000,
      timeInForce: 'GTC',
      newClientOrderId: 'trade-1-entry',
    });
  });

  it('mirrors side for SHORT (SELL)', () => {
    const d = decideEntryOrder(entryInput({ isLong: false }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.side).toBe('SELL');
  });

  it('rounds price to the NEAREST tickSize (not floored — a limit price can round either way)', () => {
    const d = decideEntryOrder(entryInput({ entry: 65000.37, filters: { stepSize: 0.001, tickSize: 0.1, minNotional: 5 } }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.price).toBe(65000.4);
  });

  it('skips when entry price is invalid', () => {
    const d = decideEntryOrder(entryInput({ entry: 0 }));
    expect(d.skip).toBe(true);
  });

  it('skips when positionUSDT is invalid', () => {
    const d = decideEntryOrder(entryInput({ positionUSDT: 0 }));
    expect(d.skip).toBe(true);
  });

  it('skips with a stepSize-rounding message when quantity rounds all the way down to 0', () => {
    // 4.9 USDT at entry=65000 → rawQty ≈ 0.0000754, floors to 0 at stepSize=0.001
    const d = decideEntryOrder(entryInput({ positionUSDT: 4.9, entry: 65000, filters: { stepSize: 0.001, tickSize: 0.1, minNotional: 5 } }));
    expect(d.skip).toBe(true);
    if (!d.skip) return;
    expect(d.reason).toContain('取整為 0');
  });

  it('skips with a minNotional message when quantity rounds to something nonzero but still too small', () => {
    // A low-priced coin: 4.9 USDT / 1 = 4.9 qty, survives stepSize rounding but the
    // resulting notional (4.9) is still under minNotional=5 — a different failure
    // mode than the stepSize-floors-to-zero case above, must produce a different reason.
    const d = decideEntryOrder(entryInput({ positionUSDT: 4.9, entry: 1, filters: { stepSize: 0.001, tickSize: 0.0001, minNotional: 5 } }));
    expect(d.skip).toBe(true);
    if (!d.skip) return;
    expect(d.reason).toContain('低於交易所最低');
  });

  it('is idempotent — same tradeId always produces the same newClientOrderId', () => {
    const d1 = decideEntryOrder(entryInput());
    const d2 = decideEntryOrder(entryInput());
    if (d1.skip || d2.skip) throw new Error('unexpected skip');
    expect(d1.order.newClientOrderId).toBe(d2.order.newClientOrderId);
  });
});

describe('decideTp1OrderPlacement — strategy A (partial, quantity-based)', () => {
  it('places a TAKE_PROFIT_MARKET order for 50% of the position, reduceOnly (LONG → SELL)', () => {
    const d = decideTp1OrderPlacement(tp1Input());
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order).toEqual({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: 67000,
      quantity: 0.05,
      reduceOnly: true,
      newClientOrderId: 'trade-1-tp1order',
    });
  });

  it('mirrors side for SHORT (BUY to reduce a short)', () => {
    const d = decideTp1OrderPlacement(tp1Input({ isLong: false }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.side).toBe('BUY');
  });

  it('rounds stopPrice to tickSize', () => {
    const d = decideTp1OrderPlacement(tp1Input({ tp1: 67012.34 }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.stopPrice).toBe(67012.3);
  });

  it('floors to stepSize rather than rounding up (never close more than intended)', () => {
    // 0.0033 * 0.5 = 0.00165 → floors to 0.001 at stepSize 0.001, not 0.002
    const d = decideTp1OrderPlacement(tp1Input({ positionQty: 0.0033 }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.quantity).toBe(0.001);
  });

  it('skips when the halved quantity floors to zero (stepSize too coarse)', () => {
    const d = decideTp1OrderPlacement(tp1Input({ positionQty: 0.0015, filters: { ...filters, stepSize: 0.01 } }));
    expect(d.skip).toBe(true);
  });

  it('skips when there is no position left to protect', () => {
    const d = decideTp1OrderPlacement(tp1Input({ positionQty: 0 }));
    expect(d.skip).toBe(true);
  });

  it('produces a deterministic clientOrderId so retries dedupe instead of double-placing', () => {
    const d1 = decideTp1OrderPlacement(tp1Input());
    const d2 = decideTp1OrderPlacement(tp1Input());
    expect(d1.skip).toBe(false);
    expect(d2.skip).toBe(false);
    if (d1.skip || d2.skip) return;
    expect(d1.order.newClientOrderId).toBe(d2.order.newClientOrderId);
  });
});

describe('decideTp1OrderPlacement — strategy B (full close, closePosition-based)', () => {
  it('places a TAKE_PROFIT_MARKET order with closePosition=true, no quantity (LONG → SELL)', () => {
    const d = decideTp1OrderPlacement(tp1Input({ strategy: 'B' }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order).toEqual({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: 67000,
      closePosition: true,
      newClientOrderId: 'trade-1-tp1order',
    });
  });

  it('mirrors side for SHORT', () => {
    const d = decideTp1OrderPlacement(tp1Input({ strategy: 'B', isLong: false }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.side).toBe('BUY');
  });

  it('skips when there is no position left to protect', () => {
    const d = decideTp1OrderPlacement(tp1Input({ strategy: 'B', positionQty: 0 }));
    expect(d.skip).toBe(true);
  });
});

function trailInput(overrides: Partial<TrailingStopReplaceInput> = {}): TrailingStopReplaceInput {
  return {
    tradeId: 'trade-1',
    symbol: 'BTCUSDT',
    isLong: true,
    currentStopOrder: null,
    desiredStopPrice: 65100,
    filters,
    ...overrides,
  };
}

describe('decideTrailingStopReplace', () => {
  it('initializes when there is no live stop order yet', () => {
    const a = decideTrailingStopReplace(trailInput());
    expect(a.kind).toBe('initialize');
    if (a.kind !== 'initialize') return;
    expect(a.place).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: 65100,
      closePosition: true,
    });
    // 2026-08-17：clientOrderId 的價格部分改成固定 6 碼雜湊（見 hashPrice
    // 註解），不再是原始價格字串——只斷言格式，不鎖死雜湊實作細節。
    expect(a.place.newClientOrderId).toMatch(/^trade-1-sl-[0-9a-z]{6}$/);
  });

  it('newClientOrderId 永遠不超過幣安 36 字元上限，即使是需要很多小數位的低價幣', () => {
    // 2026-08-17 實測撞到的真實 bug：COTIUSDT 這種低價幣，止損價需要多位
    // 小數才能表示 tick size，加上 JS 浮點數轉字串偶爾冒出的誤差位數
    // （如 0.011066999999999999），舊版直接把價格字串接在 ID 後面，超過
    // 36 字元被幣安用 -4015 拒絕——止損單永遠掛不出去，部位裸奔。
    const a = decideTrailingStopReplace(trailInput({
      tradeId: 'trade-1786684938436-spsm2', // 真實撞到的 tradeId 格式，25 字元
      symbol: 'COTIUSDT',
      desiredStopPrice: 0.011066999999999999,
      filters: { stepSize: 1, tickSize: 0.0001, minNotional: 5 },
    }));
    expect(a.kind).toBe('initialize');
    if (a.kind !== 'initialize') return;
    expect(a.place.newClientOrderId).toBeDefined();
    expect(a.place.newClientOrderId!.length).toBeLessThan(36);
  });

  it('mirrors side for SHORT (BUY closes a short)', () => {
    const a = decideTrailingStopReplace(trailInput({ isLong: false }));
    expect(a.kind).toBe('initialize');
    if (a.kind !== 'initialize') return;
    expect(a.place.side).toBe('BUY');
  });

  it('replaces (place-before-cancel) when the new target is more favorable — LONG moves up', () => {
    const a = decideTrailingStopReplace(trailInput({
      currentStopOrder: { orderId: 111, stopPrice: 64900 },
      desiredStopPrice: 65200,
    }));
    expect(a.kind).toBe('replace');
    if (a.kind !== 'replace') return;
    expect(a.cancelOrderId).toBe(111);
    expect(a.place.stopPrice).toBe(65200);
  });

  it('replaces when the new target is more favorable — SHORT moves down', () => {
    const a = decideTrailingStopReplace(trailInput({
      isLong: false,
      currentStopOrder: { orderId: 222, stopPrice: 65500 },
      desiredStopPrice: 65200,
    }));
    expect(a.kind).toBe('replace');
    if (a.kind !== 'replace') return;
    expect(a.cancelOrderId).toBe(222);
    expect(a.place.stopPrice).toBe(65200);
  });

  it('refuses to loosen the stop — LONG target below current is a no-op', () => {
    const a = decideTrailingStopReplace(trailInput({
      currentStopOrder: { orderId: 111, stopPrice: 65000 },
      desiredStopPrice: 64800, // worse than current — should never happen from real ratchet math, but must be refused
    }));
    expect(a.kind).toBe('none');
  });

  it('refuses to loosen the stop — SHORT target above current is a no-op', () => {
    const a = decideTrailingStopReplace(trailInput({
      isLong: false,
      currentStopOrder: { orderId: 111, stopPrice: 65000 },
      desiredStopPrice: 65200,
    }));
    expect(a.kind).toBe('none');
  });

  it('is a no-op when the target rounds to the same price as the current stop', () => {
    const a = decideTrailingStopReplace(trailInput({
      currentStopOrder: { orderId: 111, stopPrice: 65100.04 }, // rounds to 65100 at tickSize 0.1
      desiredStopPrice: 65100,
    }));
    expect(a.kind).toBe('none');
  });

  it('rounds the target to tickSize before comparing or placing', () => {
    const a = decideTrailingStopReplace(trailInput({
      currentStopOrder: { orderId: 111, stopPrice: 65000 },
      desiredStopPrice: 65123.456,
    }));
    expect(a.kind).toBe('replace');
    if (a.kind !== 'replace') return;
    expect(a.place.stopPrice).toBe(65123.5); // nearest 0.1
  });

  it('produces a price-keyed clientOrderId so a repeated identical decision dedupes', () => {
    const a1 = decideTrailingStopReplace(trailInput());
    const a2 = decideTrailingStopReplace(trailInput());
    expect(a1.kind).toBe('initialize');
    expect(a2.kind).toBe('initialize');
    if (a1.kind !== 'initialize' || a2.kind !== 'initialize') return;
    expect(a1.place.newClientOrderId).toBe(a2.place.newClientOrderId);
  });
});

function targetInput(overrides: Partial<TrailingStopTargetInput> = {}): TrailingStopTargetInput {
  return {
    isLong: true, entry: 65000, tp1: 67000, markPrice: 67000,
    atr1h: 500, currentTrailingStop: 0,
    ...overrides,
  };
}

describe('calcTrailingStopTarget', () => {
  it('leaves currentTrailingStop unchanged when atr1h is not available yet (<=0)', () => {
    const t = calcTrailingStopTarget(targetInput({ atr1h: 0, currentTrailingStop: 66000 }));
    expect(t).toBe(66000);
  });

  it('initializes at tp1 - 2*atr1h for LONG when that beats the entry floor', () => {
    // tp1=67000, atr1h=500 → 67000-1000=66000, entry=65000 → max(66000,65000)=66000
    const t = calcTrailingStopTarget(targetInput());
    expect(t).toBe(66000);
  });

  it('floors the LONG initial stop at entry when tp1-2*atr1h would be worse', () => {
    // tp1=65500, atr1h=2000 → 65500-4000=61500, entry=65000 → max(61500,65000)=65000
    const t = calcTrailingStopTarget(targetInput({ tp1: 65500, atr1h: 2000 }));
    expect(t).toBe(65000);
  });

  it('initializes at tp1 + 2*atr1h for SHORT when that beats the entry floor (mirror)', () => {
    // entry=65000, tp1=63000, atr1h=500 → 63000+1000=64000, min(64000,65000)=64000
    const t = calcTrailingStopTarget(targetInput({ isLong: false, entry: 65000, tp1: 63000, atr1h: 500 }));
    expect(t).toBe(64000);
  });

  it('ratchets forward (LONG) when the new candidate is more favorable than the current stop', () => {
    // already initialized at 66000; price moved to 68000, atr1h=500 → candidate=68000-1000=67000 > 66000
    const t = calcTrailingStopTarget(targetInput({ currentTrailingStop: 66000, markPrice: 68000, atr1h: 500 }));
    expect(t).toBe(67000);
  });

  it('does NOT ratchet backward (LONG) when the candidate would be worse than the current stop', () => {
    // price pulled back to 66200, atr1h=500 → candidate=65700 < currentTrailingStop=66000 → keep 66000
    const t = calcTrailingStopTarget(targetInput({ currentTrailingStop: 66000, markPrice: 66200, atr1h: 500 }));
    expect(t).toBe(66000);
  });

  it('ratchets forward (SHORT) when the new candidate is more favorable (mirror)', () => {
    // already initialized at 64000 (SHORT); price dropped to 62000, atr1h=500 → candidate=62000+1000=63000 < 64000
    const t = calcTrailingStopTarget(targetInput({
      isLong: false, currentTrailingStop: 64000, markPrice: 62000, atr1h: 500,
    }));
    expect(t).toBe(63000);
  });
});

function fullCloseInput(overrides: Partial<FullCloseInput> = {}): FullCloseInput {
  return { tradeId: 'trade-1', symbol: 'BTCUSDT', isLong: true, positionQty: 0.1, ...overrides };
}

describe('decideFullClose', () => {
  it('closes the ENTIRE position with a reduceOnly MARKET order (LONG → SELL)', () => {
    const d = decideFullClose(fullCloseInput());
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order).toEqual({
      symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET',
      quantity: 0.1, reduceOnly: true, newClientOrderId: 'trade-1-fullclose',
    });
  });

  it('mirrors side for SHORT', () => {
    const d = decideFullClose(fullCloseInput({ isLong: false }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.side).toBe('BUY');
  });

  it('skips when there is no position to close', () => {
    const d = decideFullClose(fullCloseInput({ positionQty: 0 }));
    expect(d.skip).toBe(true);
  });
});

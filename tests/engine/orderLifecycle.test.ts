import { describe, expect, it } from 'vitest';
import {
  decideTp1PartialClose,
  decideTrailingStopReplace,
  Tp1PartialCloseInput,
  TrailingStopReplaceInput,
} from '../../src/engine/orderLifecycle';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

function tp1Input(overrides: Partial<Tp1PartialCloseInput> = {}): Tp1PartialCloseInput {
  return {
    tradeId: 'trade-1',
    symbol: 'BTCUSDT',
    isLong: true,
    positionQty: 0.1,
    filters,
    ...overrides,
  };
}

describe('decideTp1PartialClose', () => {
  it('closes 50% of the position with a reduceOnly MARKET order (LONG → SELL)', () => {
    const d = decideTp1PartialClose(tp1Input());
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.closeQty).toBe(0.05);
    expect(d.remainingQty).toBe(0.05);
    expect(d.order).toEqual({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 0.05,
      reduceOnly: true,
      newClientOrderId: 'trade-1-tp1close',
    });
  });

  it('mirrors side for SHORT (BUY to reduce a short)', () => {
    const d = decideTp1PartialClose(tp1Input({ isLong: false }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.order.side).toBe('BUY');
  });

  it('floors to stepSize rather than rounding up (never close more than intended)', () => {
    // 0.0033 * 0.5 = 0.00165 → floors to 0.001 at stepSize 0.001, not 0.002
    const d = decideTp1PartialClose(tp1Input({ positionQty: 0.0033 }));
    expect(d.skip).toBe(false);
    if (d.skip) return;
    expect(d.closeQty).toBe(0.001);
  });

  it('skips when the halved quantity floors to zero (stepSize too coarse)', () => {
    const d = decideTp1PartialClose(tp1Input({ positionQty: 0.0015, filters: { ...filters, stepSize: 0.01 } }));
    expect(d.skip).toBe(true);
  });

  it('skips when there is no position left to close', () => {
    const d = decideTp1PartialClose(tp1Input({ positionQty: 0 }));
    expect(d.skip).toBe(true);
  });

  it('produces a deterministic clientOrderId so retries dedupe instead of double-closing', () => {
    const d1 = decideTp1PartialClose(tp1Input());
    const d2 = decideTp1PartialClose(tp1Input());
    expect(d1.skip).toBe(false);
    expect(d2.skip).toBe(false);
    if (d1.skip || d2.skip) return;
    expect(d1.order.newClientOrderId).toBe(d2.order.newClientOrderId);
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
    expect(a.place).toEqual({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: 65100,
      closePosition: true,
      newClientOrderId: 'trade-1-sl-65100',
    });
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

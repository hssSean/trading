import { describe, expect, it } from 'vitest';
import {
  decidePendingOrderCancelPlan,
  resolveCancelOutcome,
  parseOpenOrder,
  extractBinanceErrorCode,
  BINANCE_ERR_UNKNOWN_ORDER,
  PendingOrderSnapshot,
} from '../../src/engine/pendingOrderLifecycle';
import { OpenOrder } from '../../src/engine/binanceClient';

function snap(overrides: Partial<PendingOrderSnapshot> = {}): PendingOrderSnapshot {
  return { orderId: 1, origQty: 0.1, executedQty: 0, ...overrides };
}

describe('decidePendingOrderCancelPlan', () => {
  it('cancel_only when nothing has filled', () => {
    const p = decidePendingOrderCancelPlan(snap({ executedQty: 0 }));
    expect(p).toEqual({ action: 'cancel_only' });
  });

  it('cancel_remainder_and_protect when partially filled', () => {
    const p = decidePendingOrderCancelPlan(snap({ origQty: 0.1, executedQty: 0.04 }));
    expect(p).toEqual({ action: 'cancel_remainder_and_protect', filledQty: 0.04 });
  });

  it('already_filled when executedQty reaches origQty', () => {
    const p = decidePendingOrderCancelPlan(snap({ origQty: 0.1, executedQty: 0.1 }));
    expect(p).toEqual({ action: 'already_filled', filledQty: 0.1 });
  });

  it('already_filled when executedQty exceeds origQty (defensive — should not normally happen)', () => {
    const p = decidePendingOrderCancelPlan(snap({ origQty: 0.1, executedQty: 0.11 }));
    expect(p).toEqual({ action: 'already_filled', filledQty: 0.11 });
  });
});

describe('parseOpenOrder', () => {
  it('parses string quantities from the raw Binance response', () => {
    const raw: OpenOrder = {
      symbol: 'BTCUSDT', orderId: 42, clientOrderId: 'x', side: 'BUY', type: 'LIMIT',
      status: 'PARTIALLY_FILLED', origQty: '0.100', executedQty: '0.040', stopPrice: '0', closePosition: false,
    };
    expect(parseOpenOrder(raw)).toEqual({ orderId: 42, origQty: 0.1, executedQty: 0.04 });
  });
});

describe('resolveCancelOutcome', () => {
  it('cancelled when the cancel call succeeded outright', () => {
    expect(resolveCancelOutcome({ success: true })).toEqual({ kind: 'cancelled' });
  });

  it('ambiguous on an unexpected error code — refuses to guess', () => {
    const r = resolveCancelOutcome({ success: false, errorCode: -1021 });
    expect(r.kind).toBe('ambiguous');
  });

  it('ambiguous on -2011 without a requery — refuses to guess without fresh position data', () => {
    const r = resolveCancelOutcome({ success: false, errorCode: BINANCE_ERR_UNKNOWN_ORDER });
    expect(r.kind).toBe('ambiguous');
  });

  it('filled_before_cancel when -2011 and requery shows a live position', () => {
    const r = resolveCancelOutcome({ success: false, errorCode: BINANCE_ERR_UNKNOWN_ORDER }, 0.05);
    expect(r).toEqual({ kind: 'filled_before_cancel', positionQty: 0.05 });
  });

  it('cancelled when -2011 but requery shows zero position (order was already gone, not a race)', () => {
    const r = resolveCancelOutcome({ success: false, errorCode: BINANCE_ERR_UNKNOWN_ORDER }, 0);
    expect(r).toEqual({ kind: 'cancelled' });
  });

  it('handles a negative positionQty (short fill) as a real fill, not zero', () => {
    const r = resolveCancelOutcome({ success: false, errorCode: BINANCE_ERR_UNKNOWN_ORDER }, -0.05);
    expect(r).toEqual({ kind: 'filled_before_cancel', positionQty: -0.05 });
  });
});

describe('extractBinanceErrorCode', () => {
  it('reads code from a well-formed axios-style error', () => {
    const err = { response: { data: { code: -2011, msg: 'Unknown order sent.' } } };
    expect(extractBinanceErrorCode(err)).toBe(-2011);
  });

  it('returns undefined for a network error with no response body', () => {
    expect(extractBinanceErrorCode(new Error('ECONNRESET'))).toBeUndefined();
  });

  it('returns undefined for null/undefined/non-object input', () => {
    expect(extractBinanceErrorCode(null)).toBeUndefined();
    expect(extractBinanceErrorCode(undefined)).toBeUndefined();
    expect(extractBinanceErrorCode('not an error object')).toBeUndefined();
  });

  it('returns undefined when code is present but not a number', () => {
    const err = { response: { data: { code: 'not-a-number' } } };
    expect(extractBinanceErrorCode(err)).toBeUndefined();
  });
});

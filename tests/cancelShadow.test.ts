import { describe, expect, it } from 'vitest';
import {
  startCancelShadow,
  advanceCancelShadow,
  aggregateCancelShadows,
  CANCEL_SHADOW_FOLLOW_MS,
  type CancelShadow,
} from '../src/lib/cancelShadow';
import { applyStopSlippage, type WalkCandle } from '../src/lib/monitorMath';

function candle(high: number, low: number, close: number, closeTime: number): WalkCandle {
  return { high, low, close, closeTime };
}

const baseParams = {
  id: 'trade-1',
  symbol: 'BTCUSDT',
  direction: 'LONG' as const,
  timeframe: '1h',
  hypotheticalEntry: 100,
  stopLoss: 95,
  tp1: 105,
  tp2: 110,
  trigger: 'cancel_ran_away' as const,
  cancelledAt: 1000,
};

describe('startCancelShadow', () => {
  it('builds a live shadow with tp1Hit=false and lastCheckedAt=cancelledAt', () => {
    const s = startCancelShadow(baseParams);
    expect(s.status).toBe('live');
    expect(s.tp1Hit).toBe(false);
    expect(s.lastCheckedAt).toBe(1000);
  });
});

describe('advanceCancelShadow', () => {
  it('does not mutate the input object (pure)', () => {
    const s = startCancelShadow(baseParams);
    const frozen = JSON.stringify(s);
    advanceCancelShadow(s, [candle(111, 109, 110.5, 2000)], 2000);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('no candles touch anything → stays live, lastCheckedAt updated', () => {
    const s = startCancelShadow(baseParams);
    const next = advanceCancelShadow(s, [candle(102, 98, 100, 2000)], 2000);
    expect(next.status).toBe('live');
    expect(next.lastCheckedAt).toBe(2000);
  });

  it('walks to WIN_TP2 through TP1 across two candles', () => {
    const s = startCancelShadow(baseParams);
    const candles = [
      candle(106, 104, 105.5, 2000),
      candle(111, 109, 110.5, 3000),
    ];
    const next = advanceCancelShadow(s, candles, 3000);
    expect(next.status).toBe('done');
    expect(next.result).toBe('WIN_TP2');
    expect(next.exitPrice).toBe(110);
    expect(next.tp1Hit).toBe(true);
  });

  it('walks straight to LOSS without TP1', () => {
    const s = startCancelShadow(baseParams);
    const next = advanceCancelShadow(s, [candle(102, 94, 95, 2000)], 2000);
    expect(next.status).toBe('done');
    expect(next.result).toBe('LOSS');
    expect(next.exitPrice).toBe(applyStopSlippage(95, true));
  });

  it('already-done shadow is returned unchanged (no re-simulation)', () => {
    const s: CancelShadow = { ...startCancelShadow(baseParams), status: 'done', result: 'LOSS', exitPrice: 95, closedAt: 2000 };
    const next = advanceCancelShadow(s, [candle(111, 109, 110.5, 3000)], 3000);
    expect(next).toBe(s);
  });

  it('past the 7-day follow window with no resolution → STILL_OPEN, exit = last close', () => {
    const s = startCancelShadow(baseParams);
    const farFuture = baseParams.cancelledAt + CANCEL_SHADOW_FOLLOW_MS + 1;
    const candles = [candle(102, 98, 101.2, farFuture)];
    const next = advanceCancelShadow(s, candles, farFuture);
    expect(next.status).toBe('done');
    expect(next.result).toBe('STILL_OPEN');
    expect(next.exitPrice).toBe(101.2);
  });

  it('past the follow window but TP1 already hit → STILL_OPEN exit pinned at tp1 (locked gain, not last price)', () => {
    const s: CancelShadow = { ...startCancelShadow(baseParams), tp1Hit: true };
    const farFuture = baseParams.cancelledAt + CANCEL_SHADOW_FOLLOW_MS + 1;
    const candles = [candle(102, 98, 101.2, farFuture)];
    const next = advanceCancelShadow(s, candles, farFuture);
    expect(next.result).toBe('STILL_OPEN');
    expect(next.exitPrice).toBe(105);
  });
});

describe('aggregateCancelShadows', () => {
  it('separates stats by trigger and computes netR (no real R baseline — order never filled)', () => {
    const shadows: CancelShadow[] = [
      { ...startCancelShadow({ ...baseParams, id: 'a', trigger: 'cancel_tp1_direct' }),
        status: 'done', result: 'WIN_TP1', exitPrice: 105 },
      { ...startCancelShadow({ ...baseParams, id: 'b', trigger: 'cancel_tp1_direct' }),
        status: 'done', result: 'LOSS', exitPrice: 95 },
      { ...startCancelShadow({ ...baseParams, id: 'c', trigger: 'cancel_expired' }),
        status: 'live' },
    ];
    const stats = aggregateCancelShadows(shadows);
    expect(stats.cancel_tp1_direct.win).toBe(1);
    expect(stats.cancel_tp1_direct.loss).toBe(1);
    // (105-100)/5=1R win, then -1R loss => net 0
    expect(stats.cancel_tp1_direct.netR).toBe(0);
    expect(stats.cancel_expired.live).toBe(1);
    expect(stats.cancel_expired.win).toBe(0);
  });

  it('SHORT direction R is computed in the correct sign', () => {
    const shortBase = { ...baseParams, direction: 'SHORT' as const, hypotheticalEntry: 100, stopLoss: 105, tp1: 95, tp2: 90 };
    const shadows: CancelShadow[] = [
      { ...startCancelShadow({ ...shortBase, id: 'a' }),
        status: 'done', result: 'WIN_TP1', exitPrice: 95 },
    ];
    const stats = aggregateCancelShadows(shadows);
    // (100-95)/5 = 1R
    expect(stats.cancel_ran_away.netR).toBe(1);
  });

  it('STILL_OPEN with a locked exitPrice contributes its partial R', () => {
    const shadows: CancelShadow[] = [
      { ...startCancelShadow({ ...baseParams, id: 'a', trigger: 'cancel_expired' }),
        status: 'done', result: 'STILL_OPEN', exitPrice: 102 },
    ];
    const stats = aggregateCancelShadows(shadows);
    expect(stats.cancel_expired.stillOpen).toBe(1);
    // (102-100)/5 = 0.4R
    expect(stats.cancel_expired.netR).toBe(0.4);
  });
});

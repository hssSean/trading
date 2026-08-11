import { describe, expect, it } from 'vitest';
import {
  startTimeStopShadow,
  advanceTimeStopShadow,
  aggregateTimeStopShadows,
  TIME_STOP_SHADOW_FOLLOW_MS,
  type TimeStopShadow,
} from '../src/lib/timeStopShadow';
import { applyStopSlippage, type WalkCandle } from '../src/lib/monitorMath';

function candle(high: number, low: number, close: number, closeTime: number): WalkCandle {
  return { high, low, close, closeTime };
}

const baseParams = {
  id: 'trade-1',
  symbol: 'BTCUSDT',
  direction: 'LONG' as const,
  timeframe: '1h',
  entry: 100,
  stopLoss: 95,
  tp1: 105,
  tp2: 110,
  trigger: 'stall' as const,
  realExitPrice: 100.5,
  realClosedAt: 1000,
};

describe('startTimeStopShadow', () => {
  it('builds a live shadow with tp1Hit=false and lastCheckedAt=realClosedAt', () => {
    const s = startTimeStopShadow(baseParams);
    expect(s.status).toBe('live');
    expect(s.tp1Hit).toBe(false);
    expect(s.lastCheckedAt).toBe(1000);
  });
});

describe('advanceTimeStopShadow', () => {
  it('does not mutate the input object (pure)', () => {
    const s = startTimeStopShadow(baseParams);
    const frozen = JSON.stringify(s);
    advanceTimeStopShadow(s, [candle(111, 109, 110.5, 2000)], 2000);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('no candles touch anything → stays live, lastCheckedAt updated', () => {
    const s = startTimeStopShadow(baseParams);
    const next = advanceTimeStopShadow(s, [candle(102, 98, 100, 2000)], 2000);
    expect(next.status).toBe('live');
    expect(next.lastCheckedAt).toBe(2000);
  });

  it('walks to WIN_TP2 through TP1 across two candles', () => {
    const s = startTimeStopShadow(baseParams);
    const candles = [
      candle(106, 104, 105.5, 2000),
      candle(111, 109, 110.5, 3000),
    ];
    const next = advanceTimeStopShadow(s, candles, 3000);
    expect(next.status).toBe('done');
    expect(next.result).toBe('WIN_TP2');
    expect(next.exitPrice).toBe(110);
    expect(next.tp1Hit).toBe(true);
  });

  it('walks straight to LOSS without TP1', () => {
    const s = startTimeStopShadow(baseParams);
    const next = advanceTimeStopShadow(s, [candle(102, 94, 95, 2000)], 2000);
    expect(next.status).toBe('done');
    expect(next.result).toBe('LOSS');
    expect(next.exitPrice).toBe(applyStopSlippage(95, true));
  });

  it('already-done shadow is returned unchanged (no re-simulation)', () => {
    const s: TimeStopShadow = { ...startTimeStopShadow(baseParams), status: 'done', result: 'LOSS', exitPrice: 95, closedAt: 2000 };
    const next = advanceTimeStopShadow(s, [candle(111, 109, 110.5, 3000)], 3000);
    expect(next).toBe(s);
  });

  it('past the 7-day follow window with no resolution → STILL_OPEN, exit = last close', () => {
    const s = startTimeStopShadow(baseParams);
    const farFuture = baseParams.realClosedAt + TIME_STOP_SHADOW_FOLLOW_MS + 1;
    const candles = [candle(102, 98, 101.2, farFuture)];
    const next = advanceTimeStopShadow(s, candles, farFuture);
    expect(next.status).toBe('done');
    expect(next.result).toBe('STILL_OPEN');
    expect(next.exitPrice).toBe(101.2);
  });

  it('past the follow window but TP1 already hit → STILL_OPEN exit pinned at tp1 (locked gain, not last price)', () => {
    const s: TimeStopShadow = { ...startTimeStopShadow(baseParams), tp1Hit: true };
    const farFuture = baseParams.realClosedAt + TIME_STOP_SHADOW_FOLLOW_MS + 1;
    const candles = [candle(102, 98, 101.2, farFuture)];
    const next = advanceTimeStopShadow(s, candles, farFuture);
    expect(next.result).toBe('STILL_OPEN');
    expect(next.exitPrice).toBe(105);
  });
});

describe('aggregateTimeStopShadows', () => {
  it('separates stats by trigger and computes netR vs realNetR', () => {
    const shadows: TimeStopShadow[] = [
      { ...startTimeStopShadow({ ...baseParams, id: 'a', trigger: 'stall', realExitPrice: 100 }),
        status: 'done', result: 'WIN_TP1', exitPrice: 105 },
      { ...startTimeStopShadow({ ...baseParams, id: 'b', trigger: 'stall', realExitPrice: 98 }),
        status: 'done', result: 'LOSS', exitPrice: 95 },
      { ...startTimeStopShadow({ ...baseParams, id: 'c', trigger: 'expiry', realExitPrice: 102 }),
        status: 'live' },
    ];
    const stats = aggregateTimeStopShadows(shadows);
    expect(stats.stall.win).toBe(1);
    expect(stats.stall.loss).toBe(1);
    // (105-100)/5=1R win, then -1R loss => net 0
    expect(stats.stall.netR).toBe(0);
    // real exits: (100-100)/5=0R, (98-100)/5=-0.4R => -0.4
    expect(stats.stall.realNetR).toBe(-0.4);
    expect(stats.expiry.live).toBe(1);
    expect(stats.expiry.win).toBe(0);
  });

  it('SHORT direction R is computed in the correct sign', () => {
    const shortBase = { ...baseParams, direction: 'SHORT' as const, entry: 100, stopLoss: 105, tp1: 95, tp2: 90 };
    const shadows: TimeStopShadow[] = [
      { ...startTimeStopShadow({ ...shortBase, id: 'a', realExitPrice: 100 }),
        status: 'done', result: 'WIN_TP1', exitPrice: 95 },
    ];
    const stats = aggregateTimeStopShadows(shadows);
    // (100-95)/5 = 1R
    expect(stats.stall.netR).toBe(1);
  });
});

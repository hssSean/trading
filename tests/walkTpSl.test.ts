import { describe, expect, it } from 'vitest';
import { walkTpSl, applyStopSlippage, type WalkCandle } from '../src/lib/monitorMath';

// Shared by reject-funnel shadow sim and time-stop shadow sim (docs/TODO.md P1 #1).
// Extracted verbatim from route.ts's simulateShadow active-phase loop — these tests
// lock the exact TP1/TP2/SL sequencing so the refactor can't silently change behavior.

function candle(high: number, low: number, close: number, closeTime: number): WalkCandle {
  return { high, low, close, closeTime };
}

const LONG_PARAMS = { entry: 100, stopLoss: 95, tp1: 105, tp2: 110, isLong: true };
const SHORT_PARAMS = { entry: 100, stopLoss: 105, tp1: 95, tp2: 90, isLong: false };

describe('walkTpSl', () => {
  it('no candles after afterMs touch anything → still live', () => {
    const candles = [candle(102, 98, 100, 1000)];
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({ tp1Hit: false, done: false });
  });

  it('candles at or before afterMs are ignored even if they would have hit', () => {
    const candles = [candle(120, 90, 100, 500)]; // would hit both TP2 and SL, but closeTime<=afterMs
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({ tp1Hit: false, done: false });
  });

  it('LONG: straight to SL without TP1 → LOSS, exit price includes unfavorable slippage', () => {
    const candles = [candle(102, 94, 95, 1000)];
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({
      tp1Hit: false, done: true, result: 'LOSS',
      exitPrice: applyStopSlippage(95, true), closedAt: 1000,
    });
  });

  it('LONG: straight to TP2 without TP1 first (gap) → WIN_TP2', () => {
    const candles = [candle(112, 108, 111, 1000)];
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({ tp1Hit: false, done: true, result: 'WIN_TP2', exitPrice: 110, closedAt: 1000 });
  });

  it('LONG: TP1 hit first (no close), then later candle hits TP2 → WIN_TP2', () => {
    const candles = [
      candle(106, 104, 105.5, 1000), // hits TP1 only
      candle(111, 109, 110.5, 2000), // hits TP2
    ];
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({ tp1Hit: true, done: true, result: 'WIN_TP2', exitPrice: 110, closedAt: 2000 });
  });

  it('LONG: TP1 hit first, then later candle hits SL (breakeven-lock exit at stopLoss) → WIN_TP1', () => {
    const candles = [
      candle(106, 104, 105.5, 1000),
      candle(101, 94,  95,    2000),
    ];
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({
      tp1Hit: true, done: true, result: 'WIN_TP1',
      exitPrice: applyStopSlippage(95, true), closedAt: 2000,
    });
  });

  it('LONG: same candle touches both TP1 and SL → TP1-before-SL rule wins, not closed this candle', () => {
    const candles = [
      candle(106, 94, 100, 1000), // low<=95 (SL) AND high>=105 (TP1) in the same candle
      candle(102, 98, 101, 2000), // neither TP2 nor SL touched next candle
    ];
    const r = walkTpSl(candles, 500, LONG_PARAMS, false);
    expect(r).toEqual({ tp1Hit: true, done: false });
  });

  it('LONG: resuming with tp1HitAlready=true only checks TP2/SL, not TP1 again', () => {
    const candles = [candle(111, 109, 110.5, 1000)];
    const r = walkTpSl(candles, 500, LONG_PARAMS, true);
    expect(r).toEqual({ tp1Hit: true, done: true, result: 'WIN_TP2', exitPrice: 110, closedAt: 1000 });
  });

  it('SHORT: straight to SL without TP1 → LOSS, exit price includes unfavorable slippage', () => {
    const candles = [candle(106, 98, 105, 1000)];
    const r = walkTpSl(candles, 500, SHORT_PARAMS, false);
    expect(r).toEqual({
      tp1Hit: false, done: true, result: 'LOSS',
      exitPrice: applyStopSlippage(105, false), closedAt: 1000,
    });
  });

  it('SHORT: TP1 hit first, then later candle hits TP2 → WIN_TP2', () => {
    const candles = [
      candle(96, 94, 94.5, 1000), // hits TP1 (low<=95)
      candle(91, 89, 89.5, 2000), // hits TP2 (low<=90)
    ];
    const r = walkTpSl(candles, 500, SHORT_PARAMS, false);
    expect(r).toEqual({ tp1Hit: true, done: true, result: 'WIN_TP2', exitPrice: 90, closedAt: 2000 });
  });

  it('SHORT: TP1 hit first, then later candle hits SL → WIN_TP1', () => {
    const candles = [
      candle(96, 94, 94.5, 1000),
      candle(106, 99, 105, 2000),
    ];
    const r = walkTpSl(candles, 500, SHORT_PARAMS, false);
    expect(r).toEqual({
      tp1Hit: true, done: true, result: 'WIN_TP1',
      exitPrice: applyStopSlippage(105, false), closedAt: 2000,
    });
  });
});

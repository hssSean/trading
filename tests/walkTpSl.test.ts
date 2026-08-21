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

// ── tieBreak：同一根K線同時觸及 TP 和 SL 時判哪一邊 ─────────────────
//
// K線只有 OHLC，看不出誰先到。原本一律判 TP 贏（最樂觀）。影子模擬全部
// 走這支函數，而真倉是靠即時報價監控、看得到真實順序——所以偏誤是單向的：
// 每一次「被擋掉的訊號其實會賺」的比較都偏向「應該放寬」。加 pessimistic
// 是為了讓上層把淨R顯示成區間，兩端同號才算穩健結論。
describe('walkTpSl tieBreak', () => {
  // 這根同時碰到 SL(95) 和 TP1(105)：high 106 / low 94
  const ambiguousTp1 = [candle(106, 94, 100, 1000)];
  // 這根同時碰到 SL(95) 和 TP2(110)
  const ambiguousTp2 = [candle(111, 94, 100, 1000)];

  it('預設維持 optimistic（既有 shadow_trades 都是這個假設累積的）', () => {
    const def = walkTpSl(ambiguousTp1, 500, LONG_PARAMS, false);
    const opt = walkTpSl(ambiguousTp1, 500, LONG_PARAMS, false, 'optimistic');
    expect(def).toEqual(opt);
    expect(def.tp1Hit).toBe(true);
    expect(def.done).toBe(false); // TP1 達標後繼續等 TP2
  });

  it('pessimistic：同根同時觸及 TP1 和 SL 判賠', () => {
    const r = walkTpSl(ambiguousTp1, 500, LONG_PARAMS, false, 'pessimistic');
    expect(r.done).toBe(true);
    expect(r.result).toBe('LOSS');
    expect(r.exitPrice).toBe(applyStopSlippage(95, true));
  });

  it('pessimistic：同根同時觸及 TP2 和 SL 也判賠（不是 WIN_TP2）', () => {
    const opt = walkTpSl(ambiguousTp2, 500, LONG_PARAMS, false, 'optimistic');
    expect(opt.result).toBe('WIN_TP2');
    const pess = walkTpSl(ambiguousTp2, 500, LONG_PARAMS, false, 'pessimistic');
    expect(pess.result).toBe('LOSS');
  });

  it('pessimistic：TP1 已達標後，同根同時觸及 TP2 和 SL 收在 WIN_TP1', () => {
    const opt = walkTpSl(ambiguousTp2, 500, LONG_PARAMS, true, 'optimistic');
    expect(opt.result).toBe('WIN_TP2');
    const pess = walkTpSl(ambiguousTp2, 500, LONG_PARAMS, true, 'pessimistic');
    // TP1 之後止損已在保本以上，碰到它不是虧損，是 WIN_TP1 收尾
    expect(pess.result).toBe('WIN_TP1');
    expect(pess.exitPrice).toBe(applyStopSlippage(95, true));
  });

  it('沒有歧義時兩種假設結果完全相同（LONG）', () => {
    const clean = [candle(106, 99, 105, 1000), candle(111, 104, 110, 2000)];
    const opt = walkTpSl(clean, 500, LONG_PARAMS, false, 'optimistic');
    const pess = walkTpSl(clean, 500, LONG_PARAMS, false, 'pessimistic');
    expect(pess).toEqual(opt);
    expect(opt.result).toBe('WIN_TP2');
  });

  it('SHORT 同樣適用：同根同時觸及 TP1(95) 和 SL(105) 判賠', () => {
    const amb = [candle(106, 94, 100, 1000)];
    expect(walkTpSl(amb, 500, SHORT_PARAMS, false, 'optimistic').tp1Hit).toBe(true);
    const pess = walkTpSl(amb, 500, SHORT_PARAMS, false, 'pessimistic');
    expect(pess.result).toBe('LOSS');
    expect(pess.exitPrice).toBe(applyStopSlippage(105, false));
  });

  it('只碰到 SL 沒碰到 TP：兩種假設都判賠', () => {
    const slOnly = [candle(101, 94, 96, 1000)];
    const opt = walkTpSl(slOnly, 500, LONG_PARAMS, false, 'optimistic');
    const pess = walkTpSl(slOnly, 500, LONG_PARAMS, false, 'pessimistic');
    expect(opt.result).toBe('LOSS');
    expect(pess).toEqual(opt);
  });
});

import { Candle, TechnicalIndicators, BollingerBands, DonchianChannel } from '../types';

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

export function rsi(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs);
  }

  return result;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);

  const macdLine = closes.map((_, i) =>
    isNaN(fastEMA[i]) || isNaN(slowEMA[i]) ? NaN : fastEMA[i] - slowEMA[i],
  );

  const validMacd = macdLine.filter((v) => !isNaN(v));
  const rawSignal = ema(validMacd, signal);

  const signalLine: number[] = new Array(closes.length).fill(NaN);
  let si = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(macdLine[i])) {
      signalLine[i] = rawSignal[si++] ?? NaN;
    }
  }

  const histogram = macdLine.map((m, i) =>
    isNaN(m) || isNaN(signalLine[i]) ? NaN : m - signalLine[i],
  );

  return { macdLine, signalLine, histogram };
}

// ── ADX (Average Directional Index) ──────────────────────────
// Returns { adx, plusDI, minusDI } for the last candle.
// Uses Wilder's smoothing (same period for TR, +DM, -DM).
export function adx(candles: Candle[], period = 14): { adx: number; plusDI: number; minusDI: number } {
  const nan = { adx: NaN, plusDI: NaN, minusDI: NaN };
  if (candles.length < period * 2 + 1) return nan;

  const trs: number[]  = [];
  const plusDMs: number[]  = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];
    const upMove   = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }

  // Wilder smooth: first value = sum of first `period` items
  let smoothTR    = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlus  = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];

  for (let i = period; i < trs.length; i++) {
    smoothTR    = smoothTR    - smoothTR    / period + trs[i];
    smoothPlus  = smoothPlus  - smoothPlus  / period + plusDMs[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDMs[i];

    const pdi = smoothTR === 0 ? 0 : (smoothPlus  / smoothTR) * 100;
    const mdi = smoothTR === 0 ? 0 : (smoothMinus / smoothTR) * 100;
    const dx  = pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return nan;

  // ADX = Wilder smooth of DX values
  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
  }

  // Recompute final +DI / -DI from last smoothed values
  const pdi = smoothTR === 0 ? 0 : (smoothPlus  / smoothTR) * 100;
  const mdi = smoothTR === 0 ? 0 : (smoothMinus / smoothTR) * 100;

  return { adx: adxVal, plusDI: pdi, minusDI: mdi };
}

// ── Bollinger Bands ───────────────────────────────────────────
export function bollingerBands(candles: Candle[], period = 20, stdDevMult = 2): BollingerBands {
  const closes = candles.map(c => c.close);
  if (closes.length < period) return { upper: NaN, middle: NaN, lower: NaN, bandwidth: NaN };

  const slice  = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const stdDev   = Math.sqrt(variance);
  const upper    = middle + stdDevMult * stdDev;
  const lower    = middle - stdDevMult * stdDev;
  const bandwidth = middle === 0 ? 0 : (upper - lower) / middle;

  return { upper, middle, lower, bandwidth };
}

// ── Donchian Channel ─────────────────────────────────────────
export function donchianChannel(candles: Candle[], period = 20): DonchianChannel {
  if (candles.length < period) return { upper: NaN, lower: NaN, middle: NaN };
  // Use all candles except the last (last candle is the current forming one)
  const slice = candles.slice(-period - 1, -1);
  const upper = Math.max(...slice.map(c => c.high));
  const lower = Math.min(...slice.map(c => c.low));
  return { upper, lower, middle: (upper + lower) / 2 };
}

// ── ATR History Series ────────────────────────────────────────
// Computes rolling 14-period Wilder ATR for each candle (for percentile ranking).
export function calcAtrHistory(candles: Candle[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return [];
  const atrs: number[] = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrs.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }
  return atrs;
}

// ── ATR Percentile ────────────────────────────────────────────
// Returns 0-100 position of the current ATR in the given ATR history.
export function calcAtrPercentile(currentAtr: number, atrHistory: number[]): number {
  if (atrHistory.length === 0) return 50;
  const below = atrHistory.filter(v => v <= currentAtr).length;
  return Math.round((below / atrHistory.length) * 100);
}

export function computeIndicators(candles: Candle[]): TechnicalIndicators {
  const closes = candles.map((c) => c.close);
  const n = closes.length - 1;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsiValues = rsi(closes, 14);
  const { macdLine, signalLine, histogram } = macd(closes);

  const currentEma20 = ema20[n];
  const currentEma50 = ema50[n];
  const currentEma200 = ema200[n];
  const currentPrice = closes[n];

  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  const bullishCount = [
    currentPrice > currentEma20,
    currentPrice > currentEma50,
    currentPrice > currentEma200,
    currentEma20 > currentEma50,
  ].filter(Boolean).length;

  if (bullishCount >= 3) trend = 'bullish';
  else if (bullishCount <= 1) trend = 'bearish';

  const adxResult = adx(candles, 14);
  const bb        = bollingerBands(candles, 20, 2);
  const donchian  = donchianChannel(candles, 20);

  return {
    rsi: rsiValues[n] ?? 50,
    macd: macdLine[n] ?? 0,
    macdSignal: signalLine[n] ?? 0,
    macdHistogram: histogram[n] ?? 0,
    ema20: currentEma20,
    ema50: currentEma50,
    ema200: currentEma200,
    trend,
    adx:      adxResult.adx,
    adxPlus:  adxResult.plusDI,
    adxMinus: adxResult.minusDI,
    bb,
    donchian,
  };
}

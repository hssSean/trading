import { Candle, TechnicalIndicators } from '../types';

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

  return {
    rsi: rsiValues[n] ?? 50,
    macd: macdLine[n] ?? 0,
    macdSignal: signalLine[n] ?? 0,
    macdHistogram: histogram[n] ?? 0,
    ema20: currentEma20,
    ema50: currentEma50,
    ema200: currentEma200,
    trend,
  };
}

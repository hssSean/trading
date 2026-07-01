import { Candle, OrderBlock, FairValueGap, SwingPoint, MarketStructure } from '../types';

const SWING_LOOKBACK = 3;
const OB_MOVE_THRESHOLD = 0.008; // 0.8% minimum move to qualify as "strong"

export function findSwingPoints(candles: Candle[]): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];

  for (let i = SWING_LOOKBACK; i < candles.length - SWING_LOOKBACK; i++) {
    const c = candles[i];

    const isSwingHigh = candles
      .slice(i - SWING_LOOKBACK, i)
      .concat(candles.slice(i + 1, i + SWING_LOOKBACK + 1))
      .every((nb) => c.high >= nb.high);

    const isSwingLow = candles
      .slice(i - SWING_LOOKBACK, i)
      .concat(candles.slice(i + 1, i + SWING_LOOKBACK + 1))
      .every((nb) => c.low <= nb.low);

    if (isSwingHigh) {
      highs.push({ type: 'high', price: c.high, time: c.openTime, index: i });
    }
    if (isSwingLow) {
      lows.push({ type: 'low', price: c.low, time: c.openTime, index: i });
    }
  }

  return { highs, lows };
}

export function analyzeMarketStructure(candles: Candle[]): MarketStructure {
  const { highs, lows } = findSwingPoints(candles);

  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'ranging', lastBOS: null, lastChoCH: null, swingHighs: highs, swingLows: lows };
  }

  let lastBOS: MarketStructure['lastBOS'] = null;
  let lastChoCH: MarketStructure['lastChoCH'] = null;

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  const currentClose = candles[candles.length - 1].close;

  // BOS up: broke above previous swing high
  if (currentClose > prevHigh.price) {
    lastBOS = { direction: 'bullish', price: prevHigh.price, time: lastHigh.time };
  }
  // BOS down: broke below previous swing low
  else if (currentClose < prevLow.price) {
    lastBOS = { direction: 'bearish', price: prevLow.price, time: lastLow.time };
  }

  // ChoCH: higher high series broken → bearish ChoCH; lower low series broken → bullish ChoCH
  const higherHighs = lastHigh.price > prevHigh.price;
  const lowerLows = lastLow.price < prevLow.price;

  if (higherHighs && currentClose < lastLow.price) {
    lastChoCH = { direction: 'bearish', price: lastLow.price, time: lastLow.time };
  } else if (lowerLows && currentClose > lastHigh.price) {
    lastChoCH = { direction: 'bullish', price: lastHigh.price, time: lastHigh.time };
  }

  let trend: MarketStructure['trend'] = 'ranging';
  if (higherHighs && lastLow.price > prevLow.price) trend = 'bullish';
  else if (!higherHighs && lowerLows) trend = 'bearish';

  return { trend, lastBOS, lastChoCH, swingHighs: highs, swingLows: lows };
}

export function findOrderBlocks(candles: Candle[]): OrderBlock[] {
  const obs: OrderBlock[] = [];
  const currentPrice = candles[candles.length - 1].close;

  for (let i = 1; i < candles.length - 3; i++) {
    const c = candles[i];
    const isBearish = c.close < c.open;
    const isBullish = c.close > c.open;

    // Look for a strong move after this candle
    const lookAhead = candles.slice(i + 1, i + 4);
    const maxMove = lookAhead.reduce((max, lc) => {
      const up = (lc.high - c.close) / c.close;
      const down = (c.close - lc.low) / c.close;
      return Math.max(max, up, down);
    }, 0);

    if (maxMove < OB_MOVE_THRESHOLD) continue;

    const upMoves = lookAhead.filter((lc) => lc.close > c.high).length;
    const downMoves = lookAhead.filter((lc) => lc.close < c.low).length;

    // Bullish OB: last bearish candle before strong bullish move
    if (isBearish && upMoves >= 2) {
      const alreadyMitigated = candles
        .slice(i + 1)
        .some((lc) => lc.low <= c.high && lc.high >= c.low);

      const isNearPrice = Math.abs(currentPrice - c.high) / currentPrice < 0.03;

      obs.push({
        type: 'bullish',
        high: c.high,
        low: c.low,
        open: c.open,
        close: c.close,
        time: c.openTime,
        strength: Math.min(Math.round(maxMove * 200), 5),
        mitigated: alreadyMitigated && !isNearPrice,
      });
    }

    // Bearish OB: last bullish candle before strong bearish move
    if (isBullish && downMoves >= 2) {
      const alreadyMitigated = candles
        .slice(i + 1)
        .some((lc) => lc.high >= c.low && lc.low <= c.high);

      const isNearPrice = Math.abs(currentPrice - c.low) / currentPrice < 0.03;

      obs.push({
        type: 'bearish',
        high: c.high,
        low: c.low,
        open: c.open,
        close: c.close,
        time: c.openTime,
        strength: Math.min(Math.round(maxMove * 200), 5),
        mitigated: alreadyMitigated && !isNearPrice,
      });
    }
  }

  return obs;
}

export function findFairValueGaps(candles: Candle[]): FairValueGap[] {
  const fvgs: FairValueGap[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: gap between prev.high and next.low
    if (next.low > prev.high) {
      const filled = candles
        .slice(i + 2)
        .some((c) => c.low <= next.low && c.high >= prev.high);
      fvgs.push({
        type: 'bullish',
        top: next.low,
        bottom: prev.high,
        time: curr.openTime,
        filled,
      });
    }

    // Bearish FVG: gap between next.high and prev.low
    if (next.high < prev.low) {
      const filled = candles
        .slice(i + 2)
        .some((c) => c.high >= next.high && c.low <= prev.low);
      fvgs.push({
        type: 'bearish',
        top: prev.low,
        bottom: next.high,
        time: curr.openTime,
        filled,
      });
    }
  }

  return fvgs;
}

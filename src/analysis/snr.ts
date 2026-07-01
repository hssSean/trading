import { Candle, SRLevel } from '../types';

const CLUSTER_THRESHOLD = 0.005; // 0.5% price cluster tolerance
const MIN_TOUCHES = 2;

export function findSRLevels(candles: Candle[]): SRLevel[] {
  const rawLevels: { price: number; time: number; isHigh: boolean }[] = [];

  // Collect swing highs and lows as raw SR candidates
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const prevHigher = candles[i - 1].high < c.high && candles[i - 2].high < c.high;
    const nextLower = candles[i + 1].high < c.high && candles[i + 2].high < c.high;
    if (prevHigher && nextLower) {
      rawLevels.push({ price: c.high, time: c.openTime, isHigh: true });
    }

    const prevLower = candles[i - 1].low > c.low && candles[i - 2].low > c.low;
    const nextHigher = candles[i + 1].low > c.low && candles[i + 2].low > c.low;
    if (prevLower && nextHigher) {
      rawLevels.push({ price: c.low, time: c.openTime, isHigh: false });
    }
  }

  // Cluster nearby levels
  const clusters: Array<{ prices: number[]; times: number[]; isHigh: boolean[] }> = [];

  for (const level of rawLevels) {
    const existing = clusters.find(
      (cl) =>
        Math.abs(cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length - level.price) /
          level.price <
        CLUSTER_THRESHOLD,
    );

    if (existing) {
      existing.prices.push(level.price);
      existing.times.push(level.time);
      existing.isHigh.push(level.isHigh);
    } else {
      clusters.push({ prices: [level.price], times: [level.time], isHigh: [level.isHigh] });
    }
  }

  const currentPrice = candles[candles.length - 1].close;

  const srLevels: SRLevel[] = clusters
    .filter((cl) => cl.prices.length >= MIN_TOUCHES)
    .map((cl) => {
      const avgPrice = cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length;
      const highCount = cl.isHigh.filter(Boolean).length;
      const type: SRLevel['type'] = avgPrice > currentPrice ? 'resistance' : 'support';

      return {
        price: avgPrice,
        type,
        strength: cl.prices.length,
        lastTouchTime: Math.max(...cl.times),
        touchCount: cl.prices.length,
      };
    })
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));

  return srLevels;
}

export function nearestSupport(srLevels: SRLevel[], price: number): SRLevel | null {
  const supports = srLevels.filter((l) => l.type === 'support' && l.price < price);
  if (!supports.length) return null;
  return supports.reduce((a, b) => (b.price > a.price ? b : a));
}

export function nearestResistance(srLevels: SRLevel[], price: number): SRLevel | null {
  const resistances = srLevels.filter((l) => l.type === 'resistance' && l.price > price);
  if (!resistances.length) return null;
  return resistances.reduce((a, b) => (b.price < a.price ? b : a));
}

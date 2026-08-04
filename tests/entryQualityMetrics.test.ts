import { describe, it, expect } from 'vitest';
import { generateSignals } from '../src/analysis/signals';
import type { Candle } from '../src/types';

// A rising, gently oscillating series with a volume surge on the final bars.
// The oscillation keeps RSI/MACD out of the pinned extremes a straight line
// produces, and the volume surge supplies the last few points needed to clear
// the tier-B score floor — without it the raw long score lands at 54 and
// generateSignals correctly returns nothing, leaving the assertions below
// vacuous. Tuned deliberately: the point is to get *a* real signal object out
// so the metric fields can be asserted on, not to model a realistic market.
function risingWithVolumeSurge(n: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = price * 1.0035;
    const mid = price * (1 + 0.012 * Math.sin(i / 6));
    const open = mid * (1 - 0.0015);
    const close = mid;
    out.push({
      openTime: i * 3_600_000,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: i >= n - 3 ? 5000 : 1000 + (i % 7) * 100,
      closeTime: i * 3_600_000 + 3_599_999,
    });
  }
  return out;
}

describe('進場品質量測（scoreBreakdown 的 extensionAtr / entryDistAtr）', () => {
  const candles = risingWithVolumeSurge(260);
  const signals = generateSignals('BTCUSDT', '1h', candles, 'LONG', 'trending');

  it('sanity: 這組合成K線確實產出訊號（否則下面的斷言全是空轉）', () => {
    expect(signals.length).toBeGreaterThan(0);
  });

  it('每個訊號都帶有兩個新的量測欄位，且為有限數值', () => {
    for (const s of signals) {
      const b = s.scoreBreakdown;
      expect(b).toBeDefined();
      expect(Number.isFinite(b!.extensionAtr!)).toBe(true);
      expect(Number.isFinite(b!.entryDistAtr!)).toBe(true);
    }
  });

  it('持續上漲的多單 extensionAtr 為正（價格在 EMA20 上方＝已朝訊號方向延伸）', () => {
    const longs = signals.filter(s => s.direction === 'LONG');
    expect(longs.length).toBeGreaterThan(0);
    for (const s of longs) {
      expect(s.scoreBreakdown!.extensionAtr!).toBeGreaterThan(0);
    }
  });

  it('entryDistAtr 正負號跟「進場價 vs 訊號當下價」一致（多單掛下方＝正值）', () => {
    for (const s of signals) {
      const px = s.signalPrice!;
      const expected = s.direction === 'LONG'
        ? Math.sign(px - s.entry)
        : Math.sign(s.entry - px);
      if (expected !== 0) {
        expect(Math.sign(s.scoreBreakdown!.entryDistAtr!)).toBe(expected);
      }
    }
  });

  it('純量測、不參與評分——score 仍等於基礎分 40 + 各組加總', () => {
    for (const s of signals) {
      const b = s.scoreBreakdown!;
      const summed = 40 + b.trend + b.momentum + b.structure + b.volume + b.priceAction + b.penalties;
      expect(summed).toBe(s.score);
    }
  });
});

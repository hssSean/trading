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
//
// 2026-08-07：growth/oscillation 從 1.0035/0.012 調到 1.002/0.02——原本的
// 陡峭趨勢讓拉回進場位跟現價差了 3.19×ATR，超過同一天新增的
// MAX_ENTRY_DIST_ATR（2.5）濾網，訊號被正確擋掉，斷言全部空轉。這裡改的
// 是合成資料本身的參數（漲幅趨緩、震盪加大讓拉回位靠近現價），不是放寬
// 濾網去遷就測試。
function risingWithVolumeSurge(n: number, growth = 1.002, osc = 0.02): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = price * growth;
    const mid = price * (1 + osc * Math.sin(i / 6));
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

describe('MAX_ENTRY_DIST_ATR 濾網（docs/ANALYSIS-2026-08-06B 方法1）', () => {
  it('掛單距離現價超過門檻時不發訊號——原本 1.0035/0.012 的陡峭趨勢實測 entryDistAtr=3.19，本測試就是靠這組參數觸發濾網', () => {
    const steepCandles = risingWithVolumeSurge(260, 1.0035, 0.012);
    const dbg: { long?: number; short?: number } = {};
    const signals = generateSignals('BTCUSDT', '1h', steepCandles, 'LONG', 'trending', dbg);
    // 分數本身仍然合格（dbg.long 遠高於 60 分門檻），純粹是距離濾網擋掉——
    // 證明這是濾網在生效，不是分數不夠這種別的原因造成的假陽性。
    expect(dbg.long).toBeGreaterThanOrEqual(60);
    expect(signals.length).toBe(0);
  });

  it('掛單距離在門檻內時正常發訊號——調過的 1.002/0.02 實測 entryDistAtr=1.53，遠低於 2.5 門檻', () => {
    const closeCandles = risingWithVolumeSurge(260, 1.002, 0.02);
    const signals = generateSignals('BTCUSDT', '1h', closeCandles, 'LONG', 'trending');
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(Math.abs(s.scoreBreakdown!.entryDistAtr!)).toBeLessThan(2.5);
    }
  });
});

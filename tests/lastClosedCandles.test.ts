import { describe, it, expect } from 'vitest';
import { generateSignals } from '../src/analysis/signals';
import type { Candle } from '../src/types';

// 跟 entryQualityMetrics.test.ts 的 risingWithVolumeSurge 同一套合成資料手法，
// 差別是這裡的時間軸釘死在「最後一根真正收盤」= 現在這一小時開始前一刻，
// 這樣才能在尾巴接一根「還在跑」的未收盤棒（closeTime 還沒到）來重現
// 2026-08-17 查到的 bug：signals.ts 原本直接拿陣列最後一根棒（可能還在跑）
// 算成交量比/K棒方向/K棒型態，混進去會嚴重失真。
function risingWithVolumeSurge(n: number, endCloseTime: number, growth = 1.002, osc = 0.02): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  const barMs = 3_600_000;
  const lastOpen = endCloseTime - barMs + 1;
  const startOpen = lastOpen - barMs * (n - 1);
  for (let i = 0; i < n; i++) {
    price = price * growth;
    const mid = price * (1 + osc * Math.sin(i / 6));
    const open = mid * (1 - 0.0015);
    const close = mid;
    const openTime = startOpen + i * barMs;
    out.push({
      openTime,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: i >= n - 3 ? 5000 : 1000 + (i % 7) * 100,
      closeTime: openTime + barMs - 1,
    });
  }
  return out;
}

describe('generateSignals 不能被陣列尾端「還在跑」的未收盤棒污染成交量/方向判斷', () => {
  const now = Date.now();
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const lastClosedEnd = hourStart - 1; // 最後一根已收盤棒的 closeTime
  const baseline = risingWithVolumeSurge(260, lastClosedEnd);

  it('sanity：只用已收盤棒能正常出訊號、帶放量理由（否則下面比較沒有意義）', () => {
    const signals = generateSignals('BTCUSDT', '1h', baseline, 'LONG', 'trending');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some(s => s.reasons.some(r => r.includes('量能')))).toBe(true);
  });

  it('尾巴多接一根量能趨近0的未收盤棒，訊號仍出現且放量理由不消失', () => {
    const cur = baseline[baseline.length - 1].close;
    // 這個小時才剛開始，幾乎沒有量、開高低收幾乎持平——真實的「進行中」棒長相
    const inProgress: Candle = {
      openTime: hourStart,
      open: cur,
      high: cur * 1.0002,
      low: cur * 0.9998,
      close: cur * 1.00005,
      volume: 3,
      closeTime: hourStart + 3_600_000 - 1, // 還沒到，這根棒還在跑
    };
    const signals = generateSignals('BTCUSDT', '1h', [...baseline, inProgress], 'LONG', 'trending');

    // 修好之前：calcVolRatio 會拿這根量=3的棒去除前20棒均量，比值趨近0，
    // 放量分數整組歸零，risingWithVolumeSurge 自己的註解就說了「沒有放量
    // 分數的話原始分數只有54分」——會直接跌破 MIN_SCORE，訊號整個消失。
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some(s => s.reasons.some(r => r.includes('量能')))).toBe(true);
  });
});

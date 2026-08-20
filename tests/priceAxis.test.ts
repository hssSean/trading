import { describe, it, expect } from 'vitest';
import { calcAxisPositions, calcPriceZone, AxisInput } from '../src/lib/priceAxis';

// 2026-08-21：軸位置直接影響交易判斷（誤以為快到 TP1 就提早動作），所以用
// 使用者實際回報那張 BNB 的真實數字當主要案例，而不是隨便編的整數。
const BNB: AxisInput = {
  direction: 'LONG',
  stopLoss: 632.3014,
  entry:    641.9850,
  tp1:      661.3521,
  tp2:      675.8775,
  current:  652.7200,
};

describe('calcAxisPositions — 標籤要落在真實比例上', () => {
  it('BNB 實測案例：進場在 22.2%，不是舊版平均分佈的 33%', () => {
    const p = calcAxisPositions(BNB);
    // (641.9850 - 632.3014) / (675.8775 - 632.3014) = 9.6836 / 43.5761
    expect(p.entry).toBeCloseTo(22.22, 1);
    // 舊版 justify-between 會把它擺在 1/3 處——差了 11 個百分點，就是
    // 「看起來已經越過進場價、其實還差 1.67%」的來源。
    expect(Math.abs(p.entry - 33.33)).toBeGreaterThan(10);
  });

  it('BNB 實測案例：現價 46.9%、TP1 66.7%，現價確實還沒到 TP1', () => {
    const p = calcAxisPositions(BNB);
    expect(p.current).toBeCloseTo(46.86, 1);
    expect(p.tp1).toBeCloseTo(66.67, 1);
    expect(p.current).toBeLessThan(p.tp1);
  });

  it('兩端固定是 0 和 100', () => {
    const p = calcAxisPositions(BNB);
    expect(p.stopLoss).toBe(0);
    expect(p.tp2).toBe(100);
  });

  it('SHORT 用同一套視覺尺度：左＝止損、右＝TP2，不因為原始價格遞減而顛倒', () => {
    const p = calcAxisPositions({
      direction: 'SHORT',
      stopLoss: 110, entry: 100, tp1: 90, tp2: 80, current: 95,
    });
    expect(p.stopLoss).toBe(0);
    expect(p.entry).toBeCloseTo(33.33, 1);
    expect(p.tp1).toBeCloseTo(66.67, 1);
    expect(p.tp2).toBe(100);
    expect(p.current).toBeCloseTo(50, 1);
  });

  it('價格跑到軸外面時夾在 0-100，標記不會畫出界', () => {
    expect(calcAxisPositions({ ...BNB, current: 600 }).current).toBe(0);
    expect(calcAxisPositions({ ...BNB, current: 900 }).current).toBe(100);
  });

  it('止損等於 TP2 這種壞資料不會回 NaN', () => {
    const p = calcAxisPositions({ ...BNB, stopLoss: 100, tp2: 100, current: 100 });
    expect(Number.isFinite(p.current)).toBe(true);
    expect(Number.isFinite(p.entry)).toBe(true);
  });
});

describe('calcPriceZone — 越過 TP1 要能分辨出來（換色的依據）', () => {
  it('LONG 五段都分得出來', () => {
    const z = (current: number) => calcPriceZone({ ...BNB, current });
    expect(z(630.00)).toBe('below_stop');
    expect(z(638.00)).toBe('below_entry');
    expect(z(652.72)).toBe('in_profit');   // 使用者那張的實際位置
    expect(z(665.00)).toBe('past_tp1');    // ← 這裡開始換色
    expect(z(680.00)).toBe('past_tp2');
  });

  it('剛好踩在 TP1 上算已達標（含等號），不是差一點', () => {
    expect(calcPriceZone({ ...BNB, current: BNB.tp1 })).toBe('past_tp1');
  });

  it('剛好踩在進場價上算已進場', () => {
    expect(calcPriceZone({ ...BNB, current: BNB.entry })).toBe('in_profit');
  });

  it('SHORT 方向相反但分段語意一致', () => {
    const s: AxisInput = { direction: 'SHORT', stopLoss: 110, entry: 100, tp1: 90, tp2: 80, current: 0 };
    expect(calcPriceZone({ ...s, current: 112 })).toBe('below_stop');
    expect(calcPriceZone({ ...s, current: 105 })).toBe('below_entry');
    expect(calcPriceZone({ ...s, current: 95 })).toBe('in_profit');
    expect(calcPriceZone({ ...s, current: 85 })).toBe('past_tp1');
    expect(calcPriceZone({ ...s, current: 78 })).toBe('past_tp2');
  });

  it('策略B（tp1===tp2 單一止盈）越過就是 past_tp2，不卡在到不了的中間態', () => {
    // signals.ts generateMeanReversionSignals 的 takeProfits: [tp1, tp1]
    const b: AxisInput = { direction: 'LONG', stopLoss: 90, entry: 100, tp1: 110, tp2: 110, current: 115 };
    expect(calcPriceZone(b)).toBe('past_tp2');
    expect(calcPriceZone({ ...b, current: 105 })).toBe('in_profit');
  });
});

import { describe, expect, it } from 'vitest';
import { meetsMinNotional, parseSymbolFilters, roundToStepSize, roundToTickSize } from '../../src/engine/precision';

describe('roundToStepSize', () => {
  it('floors to the nearest step (never rounds up — would exceed risk budget)', () => {
    expect(roundToStepSize(0.1234, 0.001)).toBe(0.123);
  });

  it('handles integer step sizes (e.g. whole-coin symbols)', () => {
    expect(roundToStepSize(12.9, 1)).toBe(12);
  });

  it('handles very small step sizes without float noise (e.g. 1000PEPE-style)', () => {
    expect(roundToStepSize(123456.789, 1)).toBe(123456);
  });

  it('leaves an already-aligned quantity unchanged', () => {
    expect(roundToStepSize(0.5, 0.001)).toBe(0.5);
  });

  // 2026-09-08 真倉事故（SOLUSDT trade-1788765628400-wb2hq）：進場 16.24 張，
  // 保本止損觸發時送出的平倉數量是 16.23——`16.24 / 0.01` 在二進位浮點下是
  // 1623.9999999999998，Math.floor 直接削掉一整格。剩下的 0.01 張讓部位永遠
  // 不歸零，於是 live-runner 的「部位變小 = TP1 發生了」自我修復把這筆標成
  // tp1_hit 並推播了一則假的 TP1 通知，13 小時後那 0.01 張才被原始止損掃掉，
  // 帳上記成完整 −1R 的 LOSS（真實出場其實是保本）。
  //
  // 這不是罕見的巧合：1..1000 之間 step 0.01 有 9.1%、step 0.001 有 12.9%
  // 的合法數量會被削掉一格。
  it('已經對齊的數量不能因為浮點誤差被削掉一格（2026-09-08 SOL 灰塵殘留事故）', () => {
    expect(roundToStepSize(16.24, 0.01)).toBe(16.24);
    expect(roundToStepSize(8.12, 0.01)).toBe(8.12);
    expect(roundToStepSize(0.29, 0.01)).toBe(0.29);
    expect(roundToStepSize(0.667, 0.001)).toBe(0.667);
  });

  it('全數量平倉在任何合法數量下都不留灰塵', () => {
    for (const step of [0.01, 0.001]) {
      const bad: number[] = [];
      for (let units = 1; units <= 20000; units++) {
        const qty = parseFloat((units * step).toFixed(6));
        if (roundToStepSize(qty, step) !== qty) bad.push(qty);
      }
      expect({ step, bad: bad.slice(0, 5), count: bad.length }).toEqual({ step, bad: [], count: 0 });
    }
  });

  // 仍然是 floor：真的介於兩格之間就要往下取，不能為了修浮點誤差改成四捨五入
  // （往上取 = 平掉比部位還多的量，那正是 2026-09-06 UNI 翻倉的形狀）。
  it('介於兩格之間仍然往下取，不四捨五入', () => {
    expect(roundToStepSize(16.249, 0.01)).toBe(16.24);
    expect(roundToStepSize(16.2499999, 0.01)).toBe(16.24);
    expect(roundToStepSize(0.9999, 0.001)).toBe(0.999);
  });
});

describe('roundToTickSize', () => {
  it('rounds to the nearest tick (price can go either direction)', () => {
    expect(roundToTickSize(64432.108, 0.1)).toBe(64432.1);
  });

  it('rounds up when closer to the next tick', () => {
    expect(roundToTickSize(64432.16, 0.1)).toBe(64432.2);
  });

  it('handles sub-cent tick sizes without float noise', () => {
    expect(roundToTickSize(0.0028859123, 0.0000001)).toBe(0.0028859);
  });
});

describe('meetsMinNotional', () => {
  it('rejects a position below the exchange minimum', () => {
    expect(meetsMinNotional(0.00005, 64432, 5)).toBe(false);
  });

  it('accepts a position at or above the minimum', () => {
    expect(meetsMinNotional(0.001, 6000, 5)).toBe(true);
  });
});

describe('parseSymbolFilters', () => {
  it('extracts stepSize/tickSize/minNotional from a raw exchangeInfo symbol entry', () => {
    const raw = {
      symbols: [
        {
          symbol: 'BTCUSDT',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.10' },
            { filterType: 'LOT_SIZE', stepSize: '0.001' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        },
      ],
    };
    const map = parseSymbolFilters(raw);
    expect(map.get('BTCUSDT')).toEqual({ stepSize: 0.001, tickSize: 0.1, minNotional: 5 });
  });

  it('falls back to the legacy minNotional field name', () => {
    const raw = {
      symbols: [{
        symbol: 'ETHUSDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
          { filterType: 'LOT_SIZE', stepSize: '0.001' },
          { filterType: 'MIN_NOTIONAL', minNotional: '5' },
        ],
      }],
    };
    expect(parseSymbolFilters(raw).get('ETHUSDT')?.minNotional).toBe(5);
  });

  it('skips a symbol missing LOT_SIZE or PRICE_FILTER rather than producing NaN', () => {
    const raw = { symbols: [{ symbol: 'BROKEN', filters: [] }] };
    expect(parseSymbolFilters(raw).has('BROKEN')).toBe(false);
  });
});

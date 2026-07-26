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

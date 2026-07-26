import { describe, expect, it } from 'vitest';
import { canPlaceOrder, estimateLiquidationPrice, PreTradeCheckInput } from '../../src/engine/preTradeCheck';

// Baseline: a healthy BTC LONG that should pass every check. Individual tests
// mutate one field at a time to isolate exactly one failure mode.
function baseInput(overrides: Partial<PreTradeCheckInput> = {}): PreTradeCheckInput {
  return {
    symbol: 'BTCUSDT',
    isLong: true,
    entry: 65000,
    stopLoss: 64350,       // 1% risk distance
    quantity: 0.001,       // notional 65, margin 13 at 5x — realistic scale for a $100 account
    leverage: 5,
    maintenanceMarginRate: 0.005,
    filters: { stepSize: 0.001, tickSize: 0.1, minNotional: 5 },
    accountEquity: 100,
    equityFloor: 70,
    currentMarginUsed: 0,
    maxMarginUsageRatio: 0.5,
    killSwitchActive: false,
    todayRealizedPnl: 0,
    dailyLossCapUsdt: 5,
    ...overrides,
  };
}

describe('canPlaceOrder — healthy case', () => {
  it('passes when every constraint is satisfied', () => {
    const r = canPlaceOrder(baseInput());
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe('canPlaceOrder — kill switch', () => {
  it('blocks unconditionally when the kill switch is active, regardless of other values', () => {
    const r = canPlaceOrder(baseInput({ killSwitchActive: true }));
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('kill switch'))).toBe(true);
  });
});

describe('canPlaceOrder — equity floor', () => {
  it('blocks when equity has dropped below the hard floor', () => {
    const r = canPlaceOrder(baseInput({ accountEquity: 65, equityFloor: 70 }));
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('權益'))).toBe(true);
  });
});

describe('canPlaceOrder — daily loss cap', () => {
  it('blocks once today\'s realized loss reaches the cap', () => {
    const r = canPlaceOrder(baseInput({ todayRealizedPnl: -5, dailyLossCapUsdt: 5 }));
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('虧損'))).toBe(true);
  });

  it('does not block on unrealized-only gains (todayRealizedPnl positive)', () => {
    const r = canPlaceOrder(baseInput({ todayRealizedPnl: 3 }));
    expect(r.ok).toBe(true);
  });
});

describe('canPlaceOrder — liquidation buffer', () => {
  it('blocks when leverage is high enough that liquidation sits close to the stop', () => {
    // At a 1% stop distance and 0.5% mmr, the buffer only drops under 3x past ~29x
    // leverage — 50x comfortably breaches it while staying clear of the margin cap.
    const r = canPlaceOrder(baseInput({ leverage: 50 }));
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('強平緩衝'))).toBe(true);
  });

  it('passes at conservative leverage where liquidation is far beyond the stop', () => {
    const r = canPlaceOrder(baseInput({ leverage: 3 }));
    expect(r.ok).toBe(true);
  });

  it('mirrors correctly for SHORT (liquidation above entry, not below)', () => {
    const r = canPlaceOrder(baseInput({
      isLong: false, entry: 65000, stopLoss: 65650, leverage: 3,
    }));
    expect(r.ok).toBe(true);
  });
});

describe('canPlaceOrder — margin usage cap', () => {
  it('blocks when this trade would push total margin usage past the ratio cap', () => {
    const r = canPlaceOrder(baseInput({
      currentMarginUsed: 45, maxMarginUsageRatio: 0.5, accountEquity: 100,
      leverage: 5, quantity: 0.1, entry: 65000, // notional 6500, margin 1300 alone — deliberately huge
    }));
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('保證金使用率'))).toBe(true);
  });
});

describe('canPlaceOrder — precision / min notional', () => {
  it('blocks a position below the exchange minimum notional', () => {
    const r = canPlaceOrder(baseInput({ quantity: 0.00001 })); // 0.00001 * 65000 = 0.65 < 5
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('名目'))).toBe(true);
  });

  it('blocks a zero quantity (e.g. stepSize floor rounded a tiny order to nothing)', () => {
    const r = canPlaceOrder(baseInput({ quantity: 0 }));
    expect(r.ok).toBe(false);
    expect(r.failures.some(f => f.includes('數量為 0'))).toBe(true);
  });
});

describe('canPlaceOrder — multiple simultaneous failures', () => {
  it('reports every failing check, not just the first', () => {
    const r = canPlaceOrder(baseInput({ killSwitchActive: true, quantity: 0 }));
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
  });
});

describe('estimateLiquidationPrice', () => {
  it('LONG liquidation sits below entry', () => {
    const liq = estimateLiquidationPrice(65000, 5, true, 0.005);
    expect(liq).toBeLessThan(65000);
  });

  it('SHORT liquidation sits above entry', () => {
    const liq = estimateLiquidationPrice(65000, 5, false, 0.005);
    expect(liq).toBeGreaterThan(65000);
  });

  it('higher leverage moves liquidation closer to entry', () => {
    const liqLow  = estimateLiquidationPrice(65000, 3, true, 0.005);
    const liqHigh = estimateLiquidationPrice(65000, 20, true, 0.005);
    expect(liqHigh).toBeGreaterThan(liqLow); // closer to entry (65000) from below
  });
});

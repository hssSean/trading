import { describe, expect, it } from 'vitest';
import { calcLiquidationPrice, checkLiquidationSafety, findMarginBracket } from '../../src/engine/liquidation';

describe('calcLiquidationPrice', () => {
  // 用最基礎的槓桿/保證金常識手算驗證，不依賴幣安公式本身：maintMarginRatio
  // 設 0（忽略維持保證金率），這時「強平」單純等於「保證金正好虧光」——
  // 這個邊界情況可以獨立用算術反推，交叉驗證公式代數沒寫錯。
  it('with maintMarginRatio=0, liquidation is exactly where the margin is fully lost (LONG)', () => {
    // margin=100, positionQty=10, entry=100 → notional=1000（10倍槓桿）
    // 保證金 100 全虧光時：(100-LP)×10 = 100 → LP = 90
    const lp = calcLiquidationPrice({
      entry: 100, positionQty: 10, isLong: true,
      isolatedMarginUSDT: 100, maintMarginRatio: 0, maintAmount: 0,
    });
    expect(lp).toBeCloseTo(90, 6);
  });

  it('with maintMarginRatio=0, liquidation is exactly where the margin is fully lost (SHORT)', () => {
    // SHORT：(LP-100)×10 = 100 → LP = 110
    const lp = calcLiquidationPrice({
      entry: 100, positionQty: 10, isLong: false,
      isolatedMarginUSDT: 100, maintMarginRatio: 0, maintAmount: 0,
    });
    expect(lp).toBeCloseTo(110, 6);
  });

  it('a nonzero maintMarginRatio brings the liquidation price CLOSER to entry (less room before liquidation)', () => {
    const base = { entry: 100, positionQty: 10, isLong: true, isolatedMarginUSDT: 100, maintAmount: 0 };
    const lpNoMmr = calcLiquidationPrice({ ...base, maintMarginRatio: 0 });
    const lpWithMmr = calcLiquidationPrice({ ...base, maintMarginRatio: 0.01 });
    // LONG: liquidation price 更高（更靠近 entry）代表安全邊際變小
    expect(lpWithMmr).toBeGreaterThan(lpNoMmr);
  });

  it('a positive maintAmount (cum) pushes the liquidation price further from entry (more room)', () => {
    const base = { entry: 100, positionQty: 10, isLong: true, isolatedMarginUSDT: 100, maintMarginRatio: 0.01 };
    const lpNoCum = calcLiquidationPrice({ ...base, maintAmount: 0 });
    const lpWithCum = calcLiquidationPrice({ ...base, maintAmount: 5 });
    expect(lpWithCum).toBeLessThan(lpNoCum);
  });

  it('more leverage (smaller isolatedMarginUSDT for the same notional) brings liquidation closer to entry', () => {
    const highMargin = calcLiquidationPrice({
      entry: 100, positionQty: 10, isLong: true,
      isolatedMarginUSDT: 500, maintMarginRatio: 0.01, maintAmount: 0,
    });
    const lowMargin = calcLiquidationPrice({
      entry: 100, positionQty: 10, isLong: true,
      isolatedMarginUSDT: 50, maintMarginRatio: 0.01, maintAmount: 0,
    });
    // 保證金越少（槓桿越高），強平價越靠近進場價，離場的緩衝越小
    expect(lowMargin).toBeGreaterThan(highMargin);
  });
});

describe('checkLiquidationSafety', () => {
  it('flags as safe when the stop-loss sits well before the liquidation price (LONG)', () => {
    // liquidation ≈ 90（見上面驗證過的案例），止損設在 95，比強平價更早觸發
    const r = checkLiquidationSafety({
      entry: 100, positionQty: 10, isLong: true,
      isolatedMarginUSDT: 100, maintMarginRatio: 0, maintAmount: 0,
      stopLoss: 95,
    });
    expect(r.safe).toBe(true);
    expect(r.liquidationPrice).toBeCloseTo(90, 6);
  });

  it('flags as UNSAFE when leverage is so high the liquidation price sits before the stop-loss (LONG)', () => {
    // 同樣本金 100、10倍槓桿，liquidation≈90，但把止損設在比強平價更遠
    // （更靠近進場價的反方向）—— 85 比 90 更早跌破，SL 永遠不會先觸發。
    const r = checkLiquidationSafety({
      entry: 100, positionQty: 10, isLong: true,
      isolatedMarginUSDT: 100, maintMarginRatio: 0, maintAmount: 0,
      stopLoss: 80, // 比 liquidation price(90) 更遠 → 強平會先發生
    });
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('止損單形同虛設');
  });

  it('mirrors the logic for SHORT (liquidation must be ABOVE the stop-loss)', () => {
    const safe = checkLiquidationSafety({
      entry: 100, positionQty: 10, isLong: false,
      isolatedMarginUSDT: 100, maintMarginRatio: 0, maintAmount: 0,
      stopLoss: 105, // liquidation≈110，止損 105 比強平更早觸發 → 安全
    });
    expect(safe.safe).toBe(true);

    const unsafe = checkLiquidationSafety({
      entry: 100, positionQty: 10, isLong: false,
      isolatedMarginUSDT: 100, maintMarginRatio: 0, maintAmount: 0,
      stopLoss: 120, // 比 liquidation price(110) 更遠 → 強平先發生
    });
    expect(unsafe.safe).toBe(false);
  });
});

describe('findMarginBracket', () => {
  const brackets = [
    { notionalCap: 50000, maintMarginRatio: 0.004, cum: 0 },
    { notionalCap: 250000, maintMarginRatio: 0.005, cum: 50 },
    { notionalCap: 1000000, maintMarginRatio: 0.01, cum: 1300 },
  ];

  it('picks the first bracket whose notionalCap covers the position notional', () => {
    expect(findMarginBracket(brackets, 30000)).toEqual(brackets[0]);
    expect(findMarginBracket(brackets, 100000)).toEqual(brackets[1]);
    expect(findMarginBracket(brackets, 500000)).toEqual(brackets[2]);
  });

  it('falls back to the highest bracket when notional exceeds every cap', () => {
    expect(findMarginBracket(brackets, 5000000)).toEqual(brackets[2]);
  });

  it('is order-independent — works even if the input array is not pre-sorted', () => {
    const shuffled = [brackets[2], brackets[0], brackets[1]];
    expect(findMarginBracket(shuffled, 100000)).toEqual(brackets[1]);
  });
});

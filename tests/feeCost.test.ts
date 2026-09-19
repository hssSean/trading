import { describe, it, expect } from 'vitest';
import {
  feeCostInR, formatFeeWarning, roundTripFeePct,
  MAKER_FEE_PCT, TAKER_FEE_PCT, FEE_R_WARN_THRESHOLD,
} from '../src/lib/feeCost';

// 「這筆的手續費占多少 R」是**算術**不是統計：費率% ÷ 止損距離%。
// CLAUDE.md 已經記了止損距離下限「測過了，無效（2026-09-07）」——那份測的是
// 「clamp／skip 會不會提升淨 R」，測不出來。但「這筆成本高」除法就能證明，
// 兩件事不衝突。2026-09-20 使用者決定：只標示、不擋單、超過門檻才標。

describe('roundTripFeePct', () => {
  it('掛單進場 + 條件單出場 = maker + taker', () => {
    expect(roundTripFeePct(true)).toBeCloseTo(MAKER_FEE_PCT + TAKER_FEE_PCT, 10);
  });

  it('市價進場 = taker 兩次', () => {
    expect(roundTripFeePct(false)).toBeCloseTo(TAKER_FEE_PCT * 2, 10);
  });
});

describe('feeCostInR', () => {
  it('止損距離 0.103% 的那筆 BTC —— 手續費吃掉超過半個 R', () => {
    // 0.07% ÷ 0.103% ≈ 0.68R
    const r = feeCostInR(100, 99.897, true);
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(0.68, 2);
  });

  it('止損距離 1.5%（典型值）→ 成本微不足道', () => {
    const r = feeCostInR(100, 98.5, true) as number;
    expect(r).toBeCloseTo(0.047, 3);
    expect(r).toBeLessThan(FEE_R_WARN_THRESHOLD);
  });

  it('市價進場比掛單貴', () => {
    expect(feeCostInR(100, 99, false) as number)
      .toBeGreaterThan(feeCostInR(100, 99, true) as number);
  });

  it('止損等於進場（距離 0）→ null，不是 Infinity', () => {
    expect(feeCostInR(100, 100, true)).toBeNull();
  });

  it('進場價無效 → null', () => {
    expect(feeCostInR(0, 99, true)).toBeNull();
    expect(feeCostInR(-5, 99, true)).toBeNull();
  });

  it('SHORT（止損在上方）算出來的距離一樣是正的', () => {
    expect(feeCostInR(100, 101, true)).toBeCloseTo(feeCostInR(100, 99, true) as number, 2);
  });
});

describe('formatFeeWarning', () => {
  it('低於門檻 → 空字串，推播不多一行雜訊', () => {
    expect(formatFeeWarning(100, 98.5, true)).toBe('');
  });

  it('超過門檻 → 標出佔幾個 R', () => {
    const s = formatFeeWarning(100, 99.897, true);
    expect(s).toContain('手續費');
    expect(s).toContain('0.68R');
  });

  it('算不出來時不亂講話', () => {
    expect(formatFeeWarning(100, 100, true)).toBe('');
    expect(formatFeeWarning(0, 99, true)).toBe('');
  });

  it('門檻可以調，調高就不標', () => {
    expect(formatFeeWarning(100, 99.897, true, 10)).toBe('');
  });
});

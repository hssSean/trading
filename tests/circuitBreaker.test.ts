import { describe, it, expect } from 'vitest';
import { dailyWeightedR, consecutiveLossStreak, type BreakerTradeRow } from '../src/lib/circuitBreaker';

// 熔斷的兩個判準原本直接寫在 route.ts 的 checkCircuitBreaker 裡，吃的是
// 「今天所有 result 非 NULL 的列」。2026-09-20 的體檢抓到兩個問題，都是
// fail-open（該熔斷的沒熔斷），而且都沒有錯誤訊息：
//
//   1. CANCELLED（掛單到期撤銷）也有 result。連敗計數是
//      `if (t.result === 'LOSS') streak++; else break;`——中間夾一張撤銷的
//      掛單就會把 streak 打斷。撤銷的掛單從來沒有部位，不是一個交易結果。
//   2. 對帳判定異常的列（audit_verdict≠OK）帶著捏造的 pnl_percent 進 dailyR。
//
// 抽成純函數才測得動，跟 activeCooldowns / evaluateDrawdownHalt 同一個模式。

const t = (over: Partial<BreakerTradeRow> = {}): BreakerTradeRow => ({
  result: 'LOSS', pnl_percent: -1, entry: 100, stop_loss: 99, tier: 'A',
  audit_verdict: null, ...over,
});

describe('dailyWeightedR', () => {
  it('止損距離 1% 時 pnl_percent 直接等於 R', () => {
    expect(dailyWeightedR([t({ pnl_percent: -1 }), t({ pnl_percent: -2 })])).toBeCloseTo(-3, 6);
  });

  it('tier B 算半倉權重', () => {
    expect(dailyWeightedR([t({ pnl_percent: -2, tier: 'B' })])).toBeCloseTo(-1, 6);
  });

  it('對帳判定異常的列不算 —— 那筆 pnl_percent 是捏造的', () => {
    expect(dailyWeightedR([
      t({ pnl_percent: -1 }),
      t({ pnl_percent: -10, audit_verdict: 'SIGN_FLIP' }),
    ])).toBeCloseTo(-1, 6);
  });

  it('CANCELLED 沒有損益，不算', () => {
    expect(dailyWeightedR([
      t({ pnl_percent: -1 }),
      t({ result: 'CANCELLED', pnl_percent: -5 }),
    ])).toBeCloseTo(-1, 6);
  });

  it('缺 pnl_percent / entry / stop_loss 的列跳過，不會變成 NaN', () => {
    expect(dailyWeightedR([
      t({ pnl_percent: null }), t({ entry: null }), t({ stop_loss: null }),
    ])).toBe(0);
  });

  it('止損距離 0 會產生 Infinity，必須跳過', () => {
    expect(dailyWeightedR([t({ entry: 100, stop_loss: 100, pnl_percent: -1 })])).toBe(0);
  });
});

describe('consecutiveLossStreak', () => {
  // 傳進來的順序是「由新到舊」（route.ts 的查詢是 closed_at DESC）。
  it('連續三筆止損 → 3', () => {
    expect(consecutiveLossStreak([t(), t(), t()])).toBe(3);
  });

  it('最近一筆是獲利 → 0', () => {
    expect(consecutiveLossStreak([t({ result: 'WIN_TP1' }), t(), t()])).toBe(0);
  });

  it('中間夾一張 CANCELLED 不該打斷連敗 —— 撤銷的掛單沒有部位', () => {
    expect(consecutiveLossStreak([
      t(), t({ result: 'CANCELLED' }), t(), t(),
    ])).toBe(3);
  });

  it('對帳判定異常的列也不該打斷，也不該被算成一敗', () => {
    expect(consecutiveLossStreak([
      t(), t({ result: 'LOSS', audit_verdict: 'SIGN_FLIP' }), t(),
    ])).toBe(2);
  });

  it('獲利仍然打斷連敗', () => {
    expect(consecutiveLossStreak([t(), t({ result: 'WIN_TP2' }), t()])).toBe(1);
  });

  it('空陣列 → 0', () => {
    expect(consecutiveLossStreak([])).toBe(0);
  });
});

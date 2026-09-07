import { describe, it, expect } from 'vitest';
import { calcPositionPlan, formatPlanLine } from '../src/lib/position';

// ── 名目上限（2026-09-07）───────────────────────────────────────────────
//
// 這支守的是 docs/ANALYSIS-2026-09-07-止損距離下限.md §5 那個缺口：
// calcPositionPlan 夾住了槓桿卻沒夾住名目，所以止損距離很小時程式不是縮小
// 倉位，而是放大本金——「每筆本金約佔帳戶 20%」（marginBudget）的設計意圖
// 在止損距離 ≤ 0.5% 時就失效了。
//
// 實測（帳戶 4,847U、風險 1%、maxLev 10）：
//   止損 0.500%  名目  9,694U  本金   969U  佔 20.0%   ← 設計意圖
//   止損 0.250%  名目 19,388U  本金 1,939U  佔 40.0%
//   止損 0.103%  名目 47,059U  本金 4,706U  佔 97.1%   ← 單筆吃掉整個帳戶
//
// 既有的風控沒有一道攔得到：R 上限看不到名目（那個部位「就是 1R 風險」）、
// checkLiquidationSafety 在槓桿 10 倍時強平距離約 10%，止損 0.103% 確實先
// 觸發，所以它會判定通過。

// 用整數帳戶讓期望值一眼可驗：
//   帳戶 1000、風險 1%   → riskUSDT 10
//   marginBudget 200（20%）、maxLev 10 → 名目上限 2000
const ACCT = 1000;
const RISK = 1;

describe('calcPositionPlan — 名目上限', () => {
  it('止損距離大時完全不受影響（回歸：不改變原本的行為）', () => {
    // stopDist 2% → 名目 500，遠低於上限 2000
    const p = calcPositionPlan(ACCT, RISK, 100, 98, 10)!;
    expect(p.positionUSDT).toBe(500);
    expect(p.marginUSDT).toBe(200);
    expect(p.leverage).toBe(2.5);
    expect(p.riskUSDT).toBe(10);
    expect(p.notionalCapped).toBe(false);
  });

  it('止損 0.5% 是邊界：剛好用滿槓桿與 20% 本金，還沒被夾', () => {
    // stopDist 0.5% → 名目 10/0.005 = 2000，正好等於上限
    const p = calcPositionPlan(ACCT, RISK, 100, 99.5, 10)!;
    expect(p.positionUSDT).toBe(2000);
    expect(p.marginUSDT).toBe(200);
    expect(p.leverage).toBe(10);
    expect(p.riskUSDT).toBe(10);
    expect(p.notionalCapped).toBe(false);
  });

  it('止損 0.25% 會被夾：名目減半，本金回到帳戶的 20%', () => {
    // 未夾的話名目是 10/0.0025 = 4000，本金 400 = 帳戶 40%
    const p = calcPositionPlan(ACCT, RISK, 100, 99.75, 10)!;
    expect(p.positionUSDT).toBe(2000);
    expect(p.marginUSDT).toBe(200);
    expect(p.marginUSDT / ACCT).toBe(0.2);
    expect(p.notionalCapped).toBe(true);
  });

  // 這一條是整個修正的重點。夾了倉位卻照報原本的 riskUSDT 就是謊報風險——
  // 推播上的「止損虧 XU」會是錯的，而 tradeBridge 的風險加總也會用到它。
  it('被夾之後 riskUSDT 必須跟著降，不能照報原本的風險%', () => {
    const p = calcPositionPlan(ACCT, RISK, 100, 99.75, 10)!;
    // 實際風險 = 夾過的名目 × 止損距離 = 2000 × 0.25% = 5
    expect(p.riskUSDT).toBe(5);
    expect(p.riskUSDT).toBeLessThan(ACCT * RISK / 100);
  });

  it('極端情況：止損 0.103% 也不會讓本金超過帳戶的 20%', () => {
    const p = calcPositionPlan(ACCT, RISK, 100, 100.103, 10)!;
    expect(p.marginUSDT).toBeLessThanOrEqual(ACCT * 0.2);
    expect(p.notionalCapped).toBe(true);
    // 未夾的話是 10/0.00103 ≈ 9709，也就是帳戶的 9.7 倍
    expect(p.positionUSDT).toBe(2000);
  });

  it('做空方向同樣適用（止損在進場價上方）', () => {
    const p = calcPositionPlan(ACCT, RISK, 100, 100.25, 10)!;
    expect(p.positionUSDT).toBe(2000);
    expect(p.notionalCapped).toBe(true);
  });

  // UI 對 tier B 傳 maxLev=5（SignalCard.tsx / trades/page.tsx），上限要跟著縮。
  it('maxLev 較小時名目上限同步縮小', () => {
    // 上限 = 200 × 5 = 1000
    const p = calcPositionPlan(ACCT, RISK, 100, 99.75, 5)!;
    expect(p.positionUSDT).toBe(1000);
    expect(p.leverage).toBe(5);
    expect(p.marginUSDT).toBe(200);
    expect(p.riskUSDT).toBe(2.5);
    expect(p.notionalCapped).toBe(true);
  });

  it('belowMinNotional 用夾過之後的名目判斷', () => {
    // 帳戶極小 → 夾過的名目也極小，仍要正確標示低於交易所最低 5U
    const p = calcPositionPlan(1, RISK, 100, 99.75, 10)!;
    expect(p.belowMinNotional).toBe(true);
  });

  // 推播後面接的是「止損虧 XU」，而那個數字已經是縮小後的實際風險。不標示
  // 的話看起來就只是「風險%算錯了」。
  it('formatPlanLine 會標示倉位被縮過', () => {
    const capped = calcPositionPlan(ACCT, RISK, 100, 99.75, 10)!;
    expect(formatPlanLine(capped)).toContain('止損太近，倉位已縮至上限');

    const normal = calcPositionPlan(ACCT, RISK, 100, 98, 10)!;
    expect(formatPlanLine(normal)).not.toContain('倉位已縮');
  });

  it('無效輸入仍回 null', () => {
    expect(calcPositionPlan(0, RISK, 100, 99, 10)).toBeNull();
    expect(calcPositionPlan(ACCT, 0, 100, 99, 10)).toBeNull();
    expect(calcPositionPlan(ACCT, RISK, 100, 100, 10)).toBeNull();
  });
});

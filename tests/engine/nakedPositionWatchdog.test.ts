import { describe, expect, it } from 'vitest';
import {
  evaluateNakedPosition, NAKED_GRACE_MS, NAKED_REALERT_MS, NakedPositionState,
} from '../../src/engine/nakedPositionWatchdog';

const fresh: NakedPositionState = { nakedSince: null, lastAlertAt: null };

describe('evaluateNakedPosition — 有部位卻沒有止損單', () => {
  it('有止損 → 不告警，狀態保持乾淨', () => {
    const v = evaluateNakedPosition({ positionQty: 41, hasStop: true, now: 1000, state: fresh });
    expect(v.alert).toBe(false);
    expect(v.state.nakedSince).toBeNull();
  });

  it('沒部位 → 不告警', () => {
    const v = evaluateNakedPosition({ positionQty: 0, hasStop: false, now: 1000, state: fresh });
    expect(v.alert).toBe(false);
  });

  it('剛發現沒止損還在寬限期內 → 先記時間，不告警', () => {
    const v = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: 1000, state: fresh });
    expect(v.alert).toBe(false);
    expect(v.state.nakedSince).toBe(1000);
  });

  it('寬限期內止損補上了 → 狀態重置，不會累積成告警', () => {
    const first = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: 1000, state: fresh });
    const healed = evaluateNakedPosition({ positionQty: 41, hasStop: true, now: 2000, state: first.state });
    expect(healed.state.nakedSince).toBeNull();
    const again = evaluateNakedPosition({
      positionQty: 41, hasStop: false, now: 2000 + NAKED_GRACE_MS, state: healed.state,
    });
    expect(again.alert).toBe(false); // 重新計時，不是接續前一次
  });

  it('超過寬限期仍然沒止損 → 告警一次', () => {
    const first = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: 1000, state: fresh });
    const v = evaluateNakedPosition({
      positionQty: 41, hasStop: false, now: 1000 + NAKED_GRACE_MS, state: first.state,
    });
    expect(v.alert).toBe(true);
    expect(v.nakedForMs).toBe(NAKED_GRACE_MS);
    expect(v.state.lastAlertAt).toBe(1000 + NAKED_GRACE_MS);
  });

  it('告警之後不會每輪都發，但過了間隔會再提醒一次', () => {
    let s = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: 0, state: fresh }).state;
    const alerted = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: NAKED_GRACE_MS, state: s });
    expect(alerted.alert).toBe(true);
    s = alerted.state;

    const soon = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: NAKED_GRACE_MS + 15_000, state: s });
    expect(soon.alert).toBe(false);
    s = soon.state;

    const later = evaluateNakedPosition({
      positionQty: 41, hasStop: false, now: NAKED_GRACE_MS + NAKED_REALERT_MS, state: s,
    });
    expect(later.alert).toBe(true);
  });

  // 2026-09-08~09 UNIUSDT：止損被 "Reduce only reject" 連續拒絕 15 小時。
  it('UNI 事故的形狀：連續 15 小時沒止損，會持續提醒而不是只叫一次', () => {
    let s = fresh;
    let alerts = 0;
    const H = 3_600_000;
    for (let t = 0; t <= 15 * H; t += 15_000) {
      const v = evaluateNakedPosition({ positionQty: 41, hasStop: false, now: t, state: s });
      s = v.state;
      if (v.alert) alerts++;
    }
    // 30 分鐘一次 → 15 小時約 30 次，不是 3600 次，也不是 1 次
    expect(alerts).toBeGreaterThan(25);
    expect(alerts).toBeLessThan(35);
  });
});

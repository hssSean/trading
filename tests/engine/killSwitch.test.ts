import { describe, expect, it } from 'vitest';
import { AutoActivateInput, shouldAutoActivateKillSwitch } from '../../src/engine/killSwitch';

function baseInput(overrides: Partial<AutoActivateInput> = {}): AutoActivateInput {
  return {
    consecutiveApiErrors: 0,
    maxConsecutiveApiErrors: 5,
    accountEquity: 100,
    equityFloor: 70,
    consecutiveUnreconciledScans: 0,
    maxConsecutiveUnreconciledScans: 3,
    ...overrides,
  };
}

describe('shouldAutoActivateKillSwitch', () => {
  it('does not activate when everything is healthy', () => {
    const r = shouldAutoActivateKillSwitch(baseInput());
    expect(r.activate).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('activates once consecutive API errors reach the max', () => {
    const r = shouldAutoActivateKillSwitch(baseInput({ consecutiveApiErrors: 5 }));
    expect(r.activate).toBe(true);
    expect(r.reason).toContain('API 錯誤');
  });

  it('does not activate one error below the max (boundary check)', () => {
    const r = shouldAutoActivateKillSwitch(baseInput({ consecutiveApiErrors: 4 }));
    expect(r.activate).toBe(false);
  });

  it('activates when equity drops below the floor', () => {
    const r = shouldAutoActivateKillSwitch(baseInput({ accountEquity: 65 }));
    expect(r.activate).toBe(true);
    expect(r.reason).toContain('權益');
  });

  it('activates once consecutive unreconciled scans reach the max', () => {
    const r = shouldAutoActivateKillSwitch(baseInput({ consecutiveUnreconciledScans: 3 }));
    expect(r.activate).toBe(true);
    expect(r.reason).toContain('不一致');
  });

  it('reports the equity-floor reason when both API errors and equity are borderline but only equity breaches', () => {
    const r = shouldAutoActivateKillSwitch(baseInput({ consecutiveApiErrors: 4, accountEquity: 69 }));
    expect(r.activate).toBe(true);
    expect(r.reason).toContain('權益');
  });
});

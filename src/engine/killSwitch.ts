// Redis-backed kill switch. Checking this is the FIRST thing any order-placing
// code path does (see preTradeCheck.ts's killSwitchActive input). Activating it
// only sets a flag — it does not by itself cancel orders or close positions;
// call flattenAccount-style logic (in the watchdog/runner, not here) separately
// once this module confirms the switch is on.
//
// Split into I/O wrappers (need a live Redis client) and a pure decision function
// (shouldAutoActivate) so the "when do we trip" logic is unit-testable without
// mocking Redis.

import type { Redis } from '@upstash/redis';

const KEY = 'kill_switch:state';

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  activatedAt: number | null;
}

const INACTIVE: KillSwitchState = { active: false, reason: null, activatedAt: null };

export async function getKillSwitchState(redis: Redis): Promise<KillSwitchState> {
  const raw = await redis.get<KillSwitchState>(KEY);
  return raw ?? INACTIVE;
}

export async function activateKillSwitch(redis: Redis, reason: string): Promise<void> {
  const state: KillSwitchState = { active: true, reason, activatedAt: Date.now() };
  await redis.set(KEY, state);
}

// Deliberately requires an explicit call, not a TTL expiry — a kill switch that
// silently turns itself back off defeats the purpose. A human (or an explicit
// reconciled-and-safe check in the runner) must clear it.
export async function deactivateKillSwitch(redis: Redis): Promise<void> {
  await redis.set(KEY, INACTIVE);
}

export interface AutoActivateInput {
  consecutiveApiErrors: number;
  maxConsecutiveApiErrors: number;
  accountEquity: number;
  equityFloor: number;
  consecutiveUnreconciledScans: number;      // watchdog found anomalies N scans in a row
  maxConsecutiveUnreconciledScans: number;
}

export interface AutoActivateResult {
  activate: boolean;
  reason: string | null;
}

// Pure. The watchdog calls this each cycle with fresh counters; if it returns
// activate=true, the caller is responsible for actually calling activateKillSwitch
// AND for the flatten-account follow-up — this function only decides, never acts.
export function shouldAutoActivateKillSwitch(input: AutoActivateInput): AutoActivateResult {
  if (input.consecutiveApiErrors >= input.maxConsecutiveApiErrors) {
    return {
      activate: true,
      reason: `連續 ${input.consecutiveApiErrors} 次 API 錯誤（上限 ${input.maxConsecutiveApiErrors}）`,
    };
  }
  if (input.accountEquity < input.equityFloor) {
    return {
      activate: true,
      reason: `帳戶權益 ${input.accountEquity} 跌破硬地板 ${input.equityFloor}`,
    };
  }
  if (input.consecutiveUnreconciledScans >= input.maxConsecutiveUnreconciledScans) {
    return {
      activate: true,
      reason: `連續 ${input.consecutiveUnreconciledScans} 次掃描偵測到持倉/掛單不一致（上限 ${input.maxConsecutiveUnreconciledScans}）`,
    };
  }
  return { activate: false, reason: null };
}

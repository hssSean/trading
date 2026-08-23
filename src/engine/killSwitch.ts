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
  // 2026-08-23：false = Redis 讀取失敗，上面那些值是安全預設而不是真實狀態。
  // 呼叫端必須看得出這個差別才能大聲抱怨，而不是安靜地當作「沒啟動」。
  readable?: boolean;
}

const INACTIVE: KillSwitchState = { active: false, reason: null, activatedAt: null };

// 2026-08-23 實際踩到：Upstash 免費額度用盡後這裡的裸 redis.get 開始丟例外，
// 而 live-runner 的 runCycle 在**所有持倉監控之前**呼叫它、且沒有 try/catch，
// 於是每一輪都在監控開始前就整個中斷。主迴圈接得住例外所以 process 沒死，
// 只是每 15 秒印一行「這輪整個失敗」，什麼都沒做——移動止損不動、TP1 保本
// 不觸發、時間止損不觸發、對帳停擺，而且完全沒有人發現。
//
// 讀不到時回 active:false（繼續監控）而不是 active:true（停止整輪），理由是
// 兩種失敗的代價不對稱：kill switch 是罕用的人工緊急開關，暫時失去它的代價，
// 遠小於失去移動止損與對帳——後者每一輪都在保護既有部位。硬止損掛在交易所
// 那側不受影響，但利潤保護全靠這支。
//
// readable:false 讓呼叫端有機會把這件事吼出來，不要重蹈「靜默失效一整週」。
export async function getKillSwitchState(redis: Redis): Promise<KillSwitchState> {
  try {
    const raw = await redis.get<KillSwitchState>(KEY);
    return { ...(raw ?? INACTIVE), readable: true };
  } catch {
    return { ...INACTIVE, readable: false };
  }
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

// 「live-runner 掛掉時要不要推播告訴使用者」。
//
// 2026-10-12：decideLiveRunnerHandoff 判定 runner 停了之後，route.ts 只會
// console.log 一行然後接手舊策略的 DB 模擬——使用者完全不會知道。但 S3 真倉
// （s3a-live:*）的移動止損、B 加碼、每天 UTC 00:00:30～02:00 的進場只有
// live-runner 會做，route.ts 接不了。交易所上的硬止損還在，但其餘全停，
// 而 S3 的獲利集中在少數大趨勢，漏掉一天的進場代價很高。
//
// 狀態存在 Redis（上次告警時間）：
//   null      = 沒有告警紀錄
//   數值      = 上次告警時間
//   undefined = Redis 查不到（掛了），沒辦法節流——退而求其次，只在每小時
//               第一輪（分鐘 < 5，cron 每 5 分鐘一輪）告警
// 不另外寫 Supabase：多一個欄位要 ALTER TABLE，而 Redis 與 runner 同時掛掉
// 時每小時推一次是可以接受的雜訊。

import type { HandoffDecision } from './liveRunnerHandoff';

/** 停多久才告警。大於交接判斷的 4 分鐘，讓 EC2 上 git pull＋重啟不會誤報。 */
export const RUNNER_ALERT_GRACE_MS = 10 * 60_000;
/** 持續掛著時多久再提醒一次。 */
export const RUNNER_ALERT_REPEAT_MS = 3 * 60 * 60_000;

export interface RunnerAlertInput {
  handoff: HandoffDecision['reason'];
  /** Supabase 心跳：undefined = 查不到，null = 從沒寫過 */
  dbHeartbeatAt: number | null | undefined;
  /** Redis 上次告警時間：undefined = Redis 查不到，null = 沒告警過 */
  lastAlertAt: number | null | undefined;
  now: number;
}

export type RunnerAlertDecision =
  | { action: 'none' }
  | { action: 'recovered' }
  /** downMs = null 表示不知道停了多久 */
  | { action: 'alert'; downMs: number | null };

export function decideRunnerAlert(input: RunnerAlertInput): RunnerAlertDecision {
  const { handoff, dbHeartbeatAt, lastAlertAt, now } = input;
  const dead = handoff === 'both-dead' || handoff === 'no-signal';

  if (!dead) {
    return typeof lastAlertAt === 'number' ? { action: 'recovered' } : { action: 'none' };
  }

  const downMs = typeof dbHeartbeatAt === 'number' ? now - dbHeartbeatAt : null;
  if (downMs !== null && downMs < RUNNER_ALERT_GRACE_MS) return { action: 'none' };

  if (lastAlertAt === undefined) {
    const minuteOfHour = Math.floor((now % 3_600_000) / 60_000);
    return minuteOfHour < 5 ? { action: 'alert', downMs } : { action: 'none' };
  }
  if (lastAlertAt !== null && now - lastAlertAt < RUNNER_ALERT_REPEAT_MS) return { action: 'none' };

  return { action: 'alert', downMs };
}

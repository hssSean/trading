import { describe, it, expect } from 'vitest';
import { decideRunnerAlert, RUNNER_ALERT_GRACE_MS, RUNNER_ALERT_REPEAT_MS } from '../src/lib/liveRunnerAlert';

// 這支守的是「live-runner 掛掉時有沒有人告訴使用者」。route.ts 接手監控的只有
// 舊策略的 DB 模擬；S3 真倉的移動止損、加碼、進場只有 live-runner 會做，
// 所以 runner 掛掉一定要推播，不能只寫 console.log。

const T = 1_800_000_000_000;
const MIN = 60_000;

describe('decideRunnerAlert', () => {
  it('活著、沒有告警紀錄：什麼都不做', () => {
    expect(decideRunnerAlert({ handoff: 'redis-alive', dbHeartbeatAt: T, lastAlertAt: null, now: T }))
      .toEqual({ action: 'none' });
  });

  it('活著、之前告警過：發恢復通知', () => {
    expect(decideRunnerAlert({ handoff: 'db-alive', dbHeartbeatAt: T, lastAlertAt: T - 30 * MIN, now: T }))
      .toEqual({ action: 'recovered' });
  });

  it('剛停不久（例如 git pull 重啟）：寬限期內不告警', () => {
    const r = decideRunnerAlert({ handoff: 'both-dead', dbHeartbeatAt: T - 5 * MIN, lastAlertAt: null, now: T });
    expect(r).toEqual({ action: 'none' });
  });

  it('停超過寬限期：告警，並帶出停了多久', () => {
    const r = decideRunnerAlert({ handoff: 'both-dead', dbHeartbeatAt: T - 25 * MIN, lastAlertAt: null, now: T });
    expect(r).toEqual({ action: 'alert', downMs: 25 * MIN });
  });

  it('Supabase 從沒寫過心跳、Redis 也過期：直接告警（不知道停多久）', () => {
    expect(decideRunnerAlert({ handoff: 'both-dead', dbHeartbeatAt: null, lastAlertAt: null, now: T }))
      .toEqual({ action: 'alert', downMs: null });
  });

  it('已告警過且未滿重複間隔：不重複推播', () => {
    const r = decideRunnerAlert({
      handoff: 'both-dead', dbHeartbeatAt: T - 60 * MIN, lastAlertAt: T - RUNNER_ALERT_REPEAT_MS + MIN, now: T,
    });
    expect(r).toEqual({ action: 'none' });
  });

  it('已告警過且滿重複間隔：再提醒一次', () => {
    const r = decideRunnerAlert({
      handoff: 'both-dead', dbHeartbeatAt: T - 200 * MIN, lastAlertAt: T - RUNNER_ALERT_REPEAT_MS, now: T,
    });
    expect(r).toEqual({ action: 'alert', downMs: 200 * MIN });
  });

  it('兩個心跳來源都查不到（no-signal）：也要告警，這是最危險的狀態', () => {
    expect(decideRunnerAlert({ handoff: 'no-signal', dbHeartbeatAt: undefined, lastAlertAt: null, now: T }))
      .toEqual({ action: 'alert', downMs: null });
  });

  it('Redis 掛了（lastAlertAt 查不到）：只在每小時第一輪告警，避免每 5 分鐘狂推', () => {
    const top = Math.floor(T / (60 * MIN)) * 60 * MIN; // 整點
    expect(decideRunnerAlert({ handoff: 'no-signal', dbHeartbeatAt: undefined, lastAlertAt: undefined, now: top + 2 * MIN }))
      .toEqual({ action: 'alert', downMs: null });
    expect(decideRunnerAlert({ handoff: 'no-signal', dbHeartbeatAt: undefined, lastAlertAt: undefined, now: top + 7 * MIN }))
      .toEqual({ action: 'none' });
  });

  it('Redis 掛了但 runner 活著（db-alive）：不發恢復通知（不知道之前有沒有告警過）', () => {
    expect(decideRunnerAlert({ handoff: 'db-alive', dbHeartbeatAt: T, lastAlertAt: undefined, now: T }))
      .toEqual({ action: 'none' });
  });

  it('寬限期常數合理：大於交接判斷的 4 分鐘，小於半小時', () => {
    expect(RUNNER_ALERT_GRACE_MS).toBeGreaterThan(240_000);
    expect(RUNNER_ALERT_GRACE_MS).toBeLessThanOrEqual(30 * MIN);
  });
});

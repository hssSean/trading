import { describe, expect, it } from 'vitest';
import { AutoActivateInput, shouldAutoActivateKillSwitch, getKillSwitchState } from '../../src/engine/killSwitch';

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

// 2026-08-23：Upstash 額度用盡後，getKillSwitchState 裡的裸 redis.get 開始
// 丟例外。live-runner 的 runCycle 在**所有持倉監控之前**呼叫它、且沒有
// try/catch，於是每一輪都在監控開始前就整個中斷——主迴圈接得住例外所以
// process 沒死，只是每 15 秒印一行「這輪整個失敗」，移動止損不動、TP1 保本
// 不觸發、對帳停擺，整整一週沒人發現。這幾個測試守的就是「Redis 壞掉不能
// 讓風控靜默消失」。
describe('getKillSwitchState 對 Redis 故障的行為', () => {
  const fakeRedis = (impl: () => unknown) => ({ get: async () => impl() }) as never;

  it('Redis 丟例外時回未啟動 + readable=false，而不是往外拋', async () => {
    const s = await getKillSwitchState(fakeRedis(() => { throw new Error('ERR max requests limit exceeded'); }));
    expect(s.active).toBe(false);
    expect(s.readable).toBe(false);
  });

  it('讀到 null（沒設定過）回未啟動 + readable=true', async () => {
    const s = await getKillSwitchState(fakeRedis(() => null));
    expect(s.active).toBe(false);
    expect(s.readable).toBe(true);
  });

  // readable 是呼叫端唯一能分辨「真的沒啟動」與「讀不到所以當作沒啟動」的
  // 依據。少了它就會重蹈靜默失效。
  it('真的啟動時原樣回傳並標記 readable=true', async () => {
    const s = await getKillSwitchState(fakeRedis(() => ({ active: true, reason: '手動', activatedAt: 123 })));
    expect(s.active).toBe(true);
    expect(s.reason).toBe('手動');
    expect(s.readable).toBe(true);
  });
});

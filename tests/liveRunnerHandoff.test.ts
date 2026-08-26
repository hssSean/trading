import { describe, it, expect } from 'vitest';
import { decideLiveRunnerHandoff, type HandoffInput } from '../src/lib/liveRunnerHandoff';

// 這支守的是「持倉到底有沒有人在管」。8/23-8/26 那次無聲空窗就是這個判斷
// 只依賴 Redis 一個來源造成的：Redis 掛掉 → route.ts 假設 live-runner 活著
// 不接手，而 live-runner 同時也因為 Redis 掛掉每輪中斷 → 沒有任何東西在
// 監控持倉，TP1 條件單從沒掛上，而且完全沒有錯誤訊息。
//
// 兩種誤判的代價不對稱：
//   誤判成死掉（實際活著）→ 兩邊同時操作同一批 trades，會動到真實部位
//   誤判成活著（實際死掉）→ 這一輪沒人監控，下一輪還有機會修正
// 所以測試偏重「什麼情況**不可以**接手」。

const T = 1_800_000_000_000;
const STALE = 240_000;
const base = (o: Partial<HandoffInput> = {}): HandoffInput => ({
  redisHeartbeat: null, dbHeartbeatAt: null, now: T, staleMs: STALE, ...o,
});

describe('decideLiveRunnerHandoff', () => {
  it('Redis 說活著 → 不接手', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: T - 1000 }));
    expect(r.takeOver).toBe(false);
    expect(r.reason).toBe('redis-alive');
  });

  // 這是新補的那條路：Redis 掛了，但 live-runner 還在寫 Supabase 心跳。
  // 沒有這條，8/23 那次就會（也確實）誤判。
  it('Redis 查不到但 DB 心跳新鮮 → 不接手', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: undefined, dbHeartbeatAt: T - 60_000 }));
    expect(r.takeOver).toBe(false);
    expect(r.reason).toBe('db-alive');
  });

  it('兩個來源都說死掉 → 接手', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: null, dbHeartbeatAt: T - STALE - 1 }));
    expect(r.takeOver).toBe(true);
    expect(r.reason).toBe('both-dead');
  });

  // 核心防線：任一來源說活著就不接手，因為「兩邊搶著操作同一批 trades」
  // 是會動到真實部位的錯，比「這一輪沒人監控」嚴重。
  it('Redis 說過期但 DB 心跳新鮮 → 仍然不接手', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: null, dbHeartbeatAt: T - 1000 }));
    expect(r.takeOver).toBe(false);
    expect(r.reason).toBe('db-alive');
  });

  it('Redis 說活著但 DB 心跳老舊 → 仍然不接手', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: T, dbHeartbeatAt: T - STALE - 99_999 }));
    expect(r.takeOver).toBe(false);
    expect(r.reason).toBe('redis-alive');
  });

  // 兩個來源都拿不到就沒有任何資訊。維持保守（不接手），但呼叫端要大聲記錄
  // ——這個狀態代表監控可能整個斷掉而沒人知道，正是 8/23 那次的處境。
  it('兩個來源都拿不到 → 維持保守不接手，reason 要能分辨', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: undefined, dbHeartbeatAt: undefined }));
    expect(r.takeOver).toBe(false);
    expect(r.reason).toBe('no-signal');
  });

  it('只有 DB 可用且從沒寫過心跳 → 接手（live-runner 沒跑起來過）', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: undefined, dbHeartbeatAt: null }));
    expect(r.takeOver).toBe(true);
  });

  it('DB 心跳剛好在過期邊界上算死', () => {
    const edge = T - STALE;
    expect(decideLiveRunnerHandoff(base({ redisHeartbeat: undefined, dbHeartbeatAt: edge })).takeOver).toBe(true);
    expect(decideLiveRunnerHandoff(base({ redisHeartbeat: undefined, dbHeartbeatAt: edge + 1 })).takeOver).toBe(false);
  });

  // 時鐘不同步或 DB 寫入時間在未來時，不該被判成過期。
  it('DB 心跳在未來（時鐘偏移）視為活著', () => {
    const r = decideLiveRunnerHandoff(base({ redisHeartbeat: undefined, dbHeartbeatAt: T + 10_000 }));
    expect(r.takeOver).toBe(false);
  });
});

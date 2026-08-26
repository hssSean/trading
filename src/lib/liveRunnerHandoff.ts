// 「這個使用者的持倉現在該由誰監控」——live-runner 還是 route.ts 的 DB 模擬。
//
// 2026-08-26：8/23–8/26 那次「TP1 打到卻沒平 50%」的根因是兩個各自合理的
// 保守設計疊在一起：
//
//   route.ts     Redis 查心跳失敗 → 假設 live-runner 還活著 → 整批排除不接手
//   live-runner  Redis 一掛 → getKillSwitchState 丟例外 → 每輪在監控前就中斷
//
// 疊起來就是**沒有任何東西在管持倉，而且完全無聲**。live-runner 那半已在
// f0c51f9 修掉（Redis 掛掉也會繼續監控），這裡補另一半：交接判斷不要只依賴
// Redis 一個來源。
//
// 通則：兩個元件都 fail-safe 到「對方會處理」時，兩邊同時壞掉就是靜默的
// 全面失效。任何交接設計都要有一方能偵測到「沒有人在做」。
//
// ── 為什麼「任一來源說活著就算活著」──
//
// 兩種誤判的代價不對稱：
//   誤判成死掉（實際活著）→ 兩邊同時操作同一批 trades，會互相覆蓋狀態、
//                          重複下單，這是會動到真實部位的錯
//   誤判成活著（實際死掉）→ 這一輪沒人監控，下一輪還有機會修正
// 所以只有在**所有拿得到的來源都說死掉**時才接手。

export interface HandoffInput {
  /**
   * Redis 心跳讀值。undefined = 查詢失敗（Redis 掛了），null = key 已過期
   * 或不存在，數值 = 活著。三態不能混——「查不到」跟「確定過期」意義相反。
   */
  redisHeartbeat: number | null | undefined;
  /**
   * Supabase profiles 的心跳時間戳。undefined = 欄位不存在或查詢失敗，
   * null = 從沒寫過，數值 = 最後一次寫入的時間。
   * Redis 有 TTL 自動過期，Supabase 沒有，所以這邊要自己比對 staleMs。
   */
  dbHeartbeatAt: number | null | undefined;
  now: number;
  /** 超過這麼久沒更新就視為停止。應該大於 live-runner 的寫入間隔數倍。 */
  staleMs: number;
}

export type HandoffDecision =
  /** live-runner 在跑，route.ts 讓路 */
  | { takeOver: false; reason: 'redis-alive' | 'db-alive' | 'no-signal' }
  /** 確定沒人在管，route.ts 接手 */
  | { takeOver: true; reason: 'both-dead' };

export function decideLiveRunnerHandoff(input: HandoffInput): HandoffDecision {
  const { redisHeartbeat, dbHeartbeatAt, now, staleMs } = input;

  const redisAvailable = redisHeartbeat !== undefined;
  const dbAvailable = dbHeartbeatAt !== undefined;

  // 兩個來源都拿不到 → 沒有任何資訊可以判斷。維持原本的保守行為（假設活著、
  // 不接手），因為「兩邊搶著操作同一批 trades」比「這一輪沒人監控」更危險。
  // 但呼叫端應該把這個狀態大聲記錄下來——它代表監控可能整個斷掉而沒人知道。
  if (!redisAvailable && !dbAvailable) return { takeOver: false, reason: 'no-signal' };

  if (redisAvailable && redisHeartbeat !== null) return { takeOver: false, reason: 'redis-alive' };
  if (dbAvailable && dbHeartbeatAt !== null && now - dbHeartbeatAt < staleMs) {
    return { takeOver: false, reason: 'db-alive' };
  }

  // 所有拿得到的來源都說死掉了才接手。
  return { takeOver: true, reason: 'both-dead' };
}

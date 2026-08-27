// 從 Supabase 的已平倉紀錄直接推導「這個 symbol+方向現在還在冷卻中嗎」。
//
// 2026-08-26：冷卻原本只存在 Redis（`loss_cd:{symbol}:{direction}`，TTL 24h）。
// route.ts 讀取時是「記憶體優先、再查 Redis」，但那個記憶體是 Vercel 單一實例
// 的、冷啟就空，實質上等於只有 Redis；live-runner 寫入更是純 Redis、連記憶體
// fallback 都沒有。
//
// 於是 8/23 Upstash 額度用盡之後，**冷卻完全失效**——連續虧損的同一個標的
// 同方向可以立刻再發一次。這是 Redis 死掉時唯一還會讓人真的虧錢的缺口
// （其他都是量測或顯示問題：熔斷本來就會 fallback 去 Supabase 重算，回撤停機
// 本來就讀 Supabase）。
//
// ── 為什麼用推導而不是雙寫 ──
//
// 冷卻需要的資訊**已經全部在 trades 表裡**：result / close_reason / closed_at /
// symbol / direction。多存一份到 Supabase 只會多一個要維護、會跟事實漂移的
// 副本。推導的版本不可能跟實際成交紀錄不一致，也不需要 migration。
// 跟同一天修 -4141 無限迴圈用的是同一個模式。
//
// Redis 那條路徑刻意保留：它比較快（一次 get vs 一次查詢），而且兩者是
// **聯集**——任一邊說在冷卻就擋。對風控來說「多擋」的代價遠小於「漏擋」。

/** 止損出場：只鎖同方向 24h。止損是對「這個方向錯了」的診斷，反向可能是對的。 */
export const LOSS_COOLDOWN_MS = 24 * 3600 * 1000;

/**
 * 時間止損：鎖**雙向** 4h。判定依據是「8 根 K 線都卡在 ±0.3R」——那是對
 * 「這個標的現在在盤整」的診斷，不是對方向的診斷。只鎖同向的話，剛砍掉
 * 停滯的多單，下一輪反向空單完全暢通，等於在同一個盤整區來回付手續費
 * （2026-08-05 使用者實際踩到）。
 */
export const TIME_STOP_COOLDOWN_MS = 4 * 3600 * 1000;

const TIME_STOP_REASONS = new Set([
  'time_stop_stall', 'time_stop_expiry', 'time_stop_expiry_post_tp1',
]);

export interface ClosedTradeForCooldown {
  symbol: string;
  direction: string;
  result?: string | null;
  close_reason?: string | null;
  closed_at?: number | null;
}

export function cooldownKey(symbol: string, direction: string): string {
  return `${symbol}:${direction}`;
}

/**
 * 回傳現在仍在冷卻中的 `${symbol}:${direction}` 集合。
 *
 * 純函數：呼叫端負責查詢，這裡只判斷，時間邊界才測得動。兩個方向的錯都是
 * 靜默的——漏擋會讓剛證偽的 setup 立刻重進（正是這個機制要防的事），
 * 誤擋則是少一個候選。所以缺 closed_at 時選擇「視為仍在冷卻」。
 */
export function activeCooldowns(rows: ClosedTradeForCooldown[], now: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.symbol || !r.direction) continue;

    const isLoss = r.result === 'LOSS';
    const isTimeStop = !!r.close_reason && TIME_STOP_REASONS.has(r.close_reason);
    if (!isLoss && !isTimeStop) continue;

    // 缺 closed_at 無從判斷是否過期。選安全的那邊：視為仍在冷卻。
    const window = isLoss ? LOSS_COOLDOWN_MS : TIME_STOP_COOLDOWN_MS;
    if (r.closed_at != null && now - r.closed_at >= window) continue;

    if (isLoss) {
      out.add(cooldownKey(r.symbol, r.direction));
    }
    if (isTimeStop) {
      // 雙向都鎖，跟 route.ts 對 timeStopFired 的處理一致。
      out.add(cooldownKey(r.symbol, 'LONG'));
      out.add(cooldownKey(r.symbol, 'SHORT'));
    }
  }
  return out;
}

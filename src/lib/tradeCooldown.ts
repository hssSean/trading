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

// ── 訊號冷卻與同蠟燭：從 trades.opened_at 推導 ─────────────────────────
//
// 2026-09-04：route.ts 的 6h 訊號冷卻與「同 4h 蠟燭」兩道關卡都掛在 `tlock`
// 上，而 `tlock` **只存 Redis**（fallback 是 module-level Map，Vercel 冷啟就空，
// 實質等於只有 Redis）。所以 8/23 Upstash 額度用盡後，這兩道一起 fail-open。
//
// 實測後果：同一支幣在 0–1 分鐘內反覆進出，全部同方向。7 筆快速重進的日期
// （08-24、08-26、08-27×2、08-30×2）**全部落在 Redis 空窗期內**：
//
//   ZEC  0 分  LOSS/pre_tp1_breakeven    ETH  0 分  WIN_TP1/trailing_stop
//   ETH  0 分  LOSS/stop_loss            SOL  1 分  WIN_TP1/trailing_stop
//   BTC  1 分  MANUAL_CLOSE              DOGE 1 分  MANUAL_CLOSE
//
// 這是純成本流失：同一段行情付兩次手續費，而且讓對帳的 FIFO 配對更難成立。
//
// 用推導而不是雙寫的理由同 activeCooldowns：資訊已經全在 trades 表裡
// （symbol / direction / opened_at）。兩條路徑是**聯集**，任一邊說在冷卻就擋。

/** 同一 symbol 兩次訊號之間的最小間隔。對齊 route.ts 的 COOLDOWN_MS。 */
export const SIGNAL_COOLDOWN_MS = 6 * 3600 * 1000;

const CANDLE_MS = 4 * 3600 * 1000;

export interface RecentSignalRow {
  symbol: string;
  direction: string;
  /** 訊號發出時間（= tlock 的 sentAt）。 */
  opened_at?: number | null;
}

/**
 * 「還在訊號冷卻中」的 symbol 集合（**不分方向**）。
 *
 * 不分方向是刻意的，跟 route.ts 既有的 `onCooldown` 一致：這道關卡防的是
 * 「同一支幣被反覆推薦」，不是對方向的判斷。方向性的冷卻是 activeCooldowns
 * （止損同向 24h）。
 *
 * 缺 `opened_at` 的列**跳過**而不是保守擋下——這裡跟 activeCooldowns 相反。
 * opened_at 是每筆單必有的欄位，缺了代表資料異常而不是「時間未知」，而把
 * 異常資料變成無限期封鎖某個 symbol 是更糟的失效模式。
 */
export function symbolsOnSignalCooldown(
  rows: RecentSignalRow[], now: number, windowMs: number = SIGNAL_COOLDOWN_MS,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.symbol || r.opened_at == null) continue;
    if (now - r.opened_at < windowMs) out.add(r.symbol);
  }
  return out;
}

/**
 * 「這根 4h 蠟燭內已經發過同方向訊號」的 `symbol:direction` 集合。
 *
 * 蠟燭邊界用固定的 4h 網格（跟 route.ts 的 current4hBucket 同一個算法），
 * 不是「距今 4 小時內」——兩者不一樣，用錯會讓剛跨過整點的訊號被誤擋。
 */
export function symbolsInSameCandle(rows: RecentSignalRow[], now: number): Set<string> {
  const bucket = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.symbol || !r.direction || r.opened_at == null) continue;
    if (Math.floor(r.opened_at / CANDLE_MS) * CANDLE_MS === bucket) {
      out.add(cooldownKey(r.symbol, r.direction));
    }
  }
  return out;
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

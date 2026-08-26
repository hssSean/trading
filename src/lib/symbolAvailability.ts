// 「這個幣安交易對目前不能下單」的記憶。
//
// 2026-08-26 實測：使用者一直收到同一個幣的推薦單，下單被幣安回 -4141
// （Symbol is closed）取消，然後下一輪再發一次，無限循環——每 5 分鐘燒一次
// 完整的指標計算 + 一則推播，而 Vercel 的 Fluid Active CPU 額度剛好爆掉。
//
// ── 為什麼會無限循環 ──
//
// live-runner 撞到 -4141 時做的事是對的：標記 CANCELLED、close_reason 寫
// 'symbol_unavailable'、不重試那筆單。但它呼叫
//   cleanupAfterTradeClosed(binance, redis, row, false, false)
// 最後那個 false 是「不設冷卻」，理由寫在註解裡：「不是 LOSS，不用設冷卻」。
//
// 那個推論在「冷卻＝避免追虧損單」的框架下是對的，但這裡冷卻的用途完全不同
// ——是**阻止系統對一個根本下不了單的幣重複發訊號**。少了它，訊號產生器對
// 這件事毫無記憶，下一輪照發。
//
// ── 為什麼一開始就會發出來 ──
//
// 掃描的幣種來自 fapi.binance.com（正式站）的 status === 'TRADING'，但下單
// 打的是 demo-fapi（測試網）。**兩邊的可交易清單不一樣**——正式站開著、測試網
// 關著的幣就會進到掃描清單卻下不了單。2026-08-09 的 MMTUSDT 是同一件事，
// 當時只修了「不要無限重試那筆單」，沒修「不要再發那個幣」。
//
// ── 為什麼記在 Supabase 而不是 Redis ──
//
// Redis 是這種短期狀態的自然歸屬，但 2026-08-23 Upstash 免費額度用盡，
// 所有 Redis 呼叫都在丟例外——正是這個迴圈失控的期間。把記憶放在當下真的
// 活著的儲存上，而 close_reason='symbol_unavailable' 本來就已經寫進 trades
// 表了，不需要新表也不需要 migration。

/** 一個 symbol 被判定不可交易後，多久之內不再對它發訊號。 */
export const SYMBOL_UNAVAILABLE_COOLDOWN_MS = 24 * 3600 * 1000;

/** live-runner 撞到不可重試的幣安錯誤時寫進 trades.close_reason 的值。 */
export const SYMBOL_UNAVAILABLE_REASON = 'symbol_unavailable';

export interface ClosedTradeRow {
  symbol: string;
  close_reason?: string | null;
  closed_at?: number | null;
}

/**
 * 從最近的已結束交易裡，挑出「還在冷卻期內、不該再發訊號」的 symbol。
 *
 * 純函數：呼叫端負責查詢，這裡只負責判斷，才測得動時間邊界——寫錯的後果是
 * 靜默的（永不過期＝這個幣再也不會出現；永不生效＝迴圈繼續燒額度）。
 */
export function unavailableSymbols(
  rows: ClosedTradeRow[],
  now: number,
  cooldownMs: number = SYMBOL_UNAVAILABLE_COOLDOWN_MS,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.close_reason !== SYMBOL_UNAVAILABLE_REASON) continue;
    // 沒有 closed_at 就無從判斷是否過期。當作**仍在冷卻**比較安全：
    // 誤擋一個幣只是少一個候選，誤放行則是繼續無限迴圈燒額度。
    if (r.closed_at == null) { out.add(r.symbol); continue; }
    if (now - r.closed_at < cooldownMs) out.add(r.symbol);
  }
  return out;
}

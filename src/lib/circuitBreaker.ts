// 當日熔斷的兩個判準 —— 純函數，查詢留在呼叫端。
//
// ## 為什麼抽出來
//
// 這兩段原本直接寫在 `route.ts` 的 `checkCircuitBreaker` 裡，吃的是
// 「今天所有 `result` 非 NULL 的列」。2026-09-20 的體檢抓到兩個問題，
// 都是 **fail-open**（該熔斷的沒熔斷），而且都沒有任何錯誤訊息：
//
//   1. **`CANCELLED` 會打斷連敗計數。** 原本是
//      `if (t.result === 'LOSS') streak++; else break;`，而掛單到期撤銷的列
//      `result='CANCELLED'` 也非 NULL，於是「虧、撤銷、虧、虧」只算 1 連敗。
//      撤銷的掛單從來沒有部位，根本不是一個交易結果，不該出現在這個序列裡。
//      實測全表 434 筆裡 236 筆是 CANCELLED，撞到的機率不低。
//
//   2. **對帳判定異常的列帶著捏造的 `pnl_percent` 進 dailyR。** 那 8 筆
//      SIGN_FLIP 的 DB 損益跟幣安實際方向相反（見 cleanPeriod.ts 的說明）。
//
// 跟 `activeCooldowns`、`evaluateDrawdownHalt` 同一個模式：呼叫端負責查詢，
// 這裡只判斷，邊界條件才測得動。

import { isAuditClean, type AuditMarked } from './cleanPeriod';

export interface BreakerTradeRow extends AuditMarked {
  result?: string | null;
  pnl_percent?: number | null;
  entry?: number | null;
  stop_loss?: number | null;
  tier?: string | null;
}

/** 不是一筆「交易結果」的 result 值。跟 tradeCooldown 的同名概念一致。 */
const NON_TRADE_RESULTS = new Set(['CANCELLED']);

/**
 * 這一列能不能代表一個交易結果。
 *
 * 兩個排除理由不同但後果一樣（污染判準）：CANCELLED 從來沒有部位；
 * 對帳異常的列有部位但損益數字是捏造的。
 */
function isRealOutcome(t: BreakerTradeRow): boolean {
  if (t.result == null || NON_TRADE_RESULTS.has(t.result)) return false;
  return isAuditClean(t);
}

/**
 * 當日的 tier 加權 R 合計。
 *
 * 口徑跟 `drawdownHalt.toEquityPoints` 一致：R 倍數 × tier 權重（B 是半倉）。
 * 算不出 R 的列（缺欄位、止損距離 0 會產生 Infinity）一律跳過。
 */
export function dailyWeightedR(rows: BreakerTradeRow[]): number {
  return rows.reduce((s, t) => {
    if (!isRealOutcome(t)) return s;
    if (t.pnl_percent == null || !t.entry || !t.stop_loss) return s;
    const stopPct = Math.abs(t.entry - t.stop_loss) / t.entry * 100;
    if (!(stopPct > 0)) return s;
    const rMultiple = t.pnl_percent / stopPct;           // 例：-12% / 12% = -1R
    return s + rMultiple * (t.tier === 'B' ? 0.5 : 1.0);
  }, 0);
}

/**
 * 從最新往回數，連續幾筆止損。
 *
 * @param rows 由新到舊排序（呼叫端的查詢是 `closed_at` DESC）。
 *
 * 不是交易結果的列（CANCELLED、對帳異常）**跳過而不是打斷**——它們既不是
 * 一敗，也不構成「這段連敗結束了」的證據。只有真的獲利才打斷。
 */
export function consecutiveLossStreak(rows: BreakerTradeRow[]): number {
  let streak = 0;
  for (const t of rows) {
    if (!isRealOutcome(t)) continue;
    if (t.result === 'LOSS') streak++;
    else break;
  }
  return streak;
}

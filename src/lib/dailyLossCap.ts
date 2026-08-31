// 日虧損上限 —— 用「絕對金額」而不是 R 倍數的硬性停機。
//
// ## 為什麼需要一個金額上限
//
// 這個系統現有的每一道上限都是 R 倍數或百分比：`MAX_TOTAL_RISK_PCT`、
// `MAX_DRAWDOWN_R`、熔斷、`suggested_risk_pct`。**R 的分母是止損距離，而止損
// 距離是 ATR 衍生的、會隨波動浮動。** 同樣「1R」在低波動時可能是 5 USDT、
// 在高波動時是 50 USDT。所以 R 上限不等於金額上限——帳戶可以在完全沒有違反
// 任何 R 上限的情況下被打穿。
//
// 規格書 §4 說損益一律用 R 衡量，那是對的：R 是**評估策略**的正確單位。
// 但**保護帳戶**要用錢的單位。兩件事不衝突，這道關卡補的是後者。
//
// ## 為什麼用交易所的帳而不是我們的 trades 表
//
// 2026-08-30 的對帳證明 DB 記的損益相對真實成交有統計顯著的系統性偏誤
// （低估 67.6%，符號檢定 z=2.91）。拿一個已知會說謊的來源當硬性風控的依據
// 沒有意義。`/fapi/v1/income` 是交易所自己的帳，而且已經含手續費與資金費率
// ——那些同樣把餘額吃掉，日虧損不能漏算。
//
// ## 為什麼 fail-closed
//
// 這個專案其餘的關卡都刻意 fail-open（查詢失敗就放行），理由是「不要因為
// 基礎設施故障就凍結整個系統」。**這一道刻意相反。**
//
// 兩邊的代價不對稱：fail-open 的下檔是「無上限虧損」，fail-closed 的下檔是
// 「錯過一些單」。而且 2026-08 的教訓正是 fail-open 的風控在 Redis 掛掉時
// 全部靜默失效。既然這道關卡的存在意義就是「最後一道防線」，它不該有在
// 故障時自動讓開的性質。
//
// 只在**有設定上限**時才 fail-closed——沒設定就是使用者選擇不啟用，那不是故障。

/** `/fapi/v1/income` 一筆流水裡我們用得到的欄位。 */
export interface IncomeLike {
  incomeType: string;
  income: string;
  time: number;
}

/**
 * 會影響交易損益的流水類型。
 *
 * `TRANSFER`（自己入金出金）刻意排除——那不是交易結果，把它算進來會讓一次
 * 提領看起來像巨額虧損而觸發停機。手續費與資金費率則**必須**算：它們是真的
 * 從餘額扣掉的錢，只看 REALIZED_PNL 會系統性低估當日虧損。
 */
export const TRADING_INCOME_TYPES = new Set([
  'REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE',
]);

/** 加總指定區間內的交易損益（USDT）。正數獲利、負數虧損。 */
export function sumTradingIncome(records: IncomeLike[], since?: number, until?: number): number {
  let total = 0;
  for (const r of records) {
    if (!TRADING_INCOME_TYPES.has(r.incomeType)) continue;
    if (since != null && r.time < since) continue;
    if (until != null && r.time > until) continue;
    const v = parseFloat(r.income);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/** UTC 當日的起點（毫秒）。幣安的日界線是 UTC，跟它對齊才不會跟對帳兜不攏。 */
export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface DailyLossCapInput {
  /** 今日已實現損益（USDT，交易所口徑）。`null` = 查不到。 */
  realizedUsdt: number | null;
  /** 上限（正數，USDT）。`null`/`0`/負數 = 停用這道關卡。 */
  capUsdt: number | null | undefined;
}

export interface DailyLossCapResult {
  /** true = 擋下新倉。既有部位不受影響（它們的止損還在交易所上）。 */
  blocked: boolean;
  reason: string | null;
}

/**
 * 判斷今天是否該停止開新倉。
 *
 * **只擋新倉，不平既有部位。** 自動平倉的破壞性遠高於暫停開倉——既有部位的
 * 止損已經掛在交易所上，讓它們照原計畫走比在觸發瞬間市價砍掉更安全，也避免
 * 「上限誤觸發 → 全部市價平掉」這種不可逆的錯誤。
 */
export function evaluateDailyLossCap(input: DailyLossCapInput): DailyLossCapResult {
  const cap = input.capUsdt;
  if (cap == null || !Number.isFinite(cap) || cap <= 0) {
    return { blocked: false, reason: null }; // 未設定 = 使用者選擇不啟用
  }

  // 有設定上限卻查不到今日損益 —— fail-closed。見檔頭說明。
  if (input.realizedUsdt == null || !Number.isFinite(input.realizedUsdt)) {
    return {
      blocked: true,
      reason: `無法取得今日已實現損益，日虧損上限 ${cap} USDT 無法驗證——保守起見暫停開新倉`,
    };
  }

  // 虧損以負數表示。realized = -100、cap = 80 → 已虧 100 超過 80。
  const loss = -input.realizedUsdt;
  if (loss >= cap) {
    return {
      blocked: true,
      reason: `今日已實現虧損 ${loss.toFixed(2)} USDT 已達上限 ${cap} USDT — 暫停開新倉至 UTC 隔日`,
    };
  }
  return { blocked: false, reason: null };
}

/** 從環境變數讀上限。沒設或設成 0 就是停用。 */
export function readDailyLossCapFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.MAX_DAILY_LOSS_USDT;
  if (!raw) return null;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

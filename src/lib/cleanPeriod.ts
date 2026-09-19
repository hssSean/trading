// 「哪些交易的統計可以拿來判斷策略好壞」的分界線。
//
// 2026-08-25：戰績卡的 totalR 算的是 closedResults——**所有歷史已結束交易，
// 沒有任何日期篩選**。實際拆開來看：
//
//   全部已成交            103 筆   +16.82R
//     其中沒有策略標籤的     27 筆   +16.14R   ← 8/4 前的舊資料
//   8/18 之後（乾淨）      21 筆    −2.64R
//
// 也就是首頁那個大正數幾乎全部來自已知不可信的資料，而乾淨期間是負的。
// 使用者說「感覺只有大漲那天有營利」時，畫面顯示 +25.8R——**體感是對的，
// 畫面是錯的**，而且那個誤導的數字每天都在影響他對策略的判斷。
//
// 這跟「沒有即時價卻印出進場價當現價」是同一類問題：畫面在陳述一件資料
// 不支持的事。修法不是把舊資料藏起來（那是另一種不誠實），是把期間講清楚。
//
// ── 為什麼是 8/18 ──
// 三個同時成立的污染源都在 2026-08-18 當天修掉
// （見 docs/ANALYSIS-2026-08-25-三層量測全部無鑑別力.md §「8/18 前的資料
// 仍然不可信」）：
//   1. 未收盤 K 棒 → 成交量組實質死碼、K線型態組變雜訊（滿分 100 有 20 分是垃圾）
//   2. 真倉獲利保護因幣安 -4130 從沒生效 → 真倉單全程只有固定原始止損
//   3. App 統計混了模擬與真倉 → 系統性偏樂觀

/** 2026-08-18 00:00 UTC。三個污染源都在這天修掉，之後累積的才可信。 */
export const CLEAN_DATA_SINCE = Date.UTC(2026, 7, 18);

/**
 * 額度用盡導致風控失效的區間。這段期間 Redis 掛掉，訊號鎖／冷卻／熔斷的
 * fallback 都是「不擋」，可能有重複發單——資料不是錯的，但特性不同，
 * 要能單獨排除。Upstash 免費額度每月 1 號重置。
 */
export const RISK_CONTROL_GAP_START = Date.UTC(2026, 7, 23);
export const RISK_CONTROL_GAP_END = Date.UTC(2026, 8, 1);

export interface DatedTrade {
  /** 平倉時間（ms）。沒有就代表還沒結束，不列入任何統計。 */
  closedAt?: number;
}

/** 這筆是否落在乾淨期（8/18 之後平倉）。 */
export function isCleanPeriod(t: DatedTrade, since: number = CLEAN_DATA_SINCE): boolean {
  return t.closedAt != null && t.closedAt >= since;
}

/** 這筆是否落在風控失效的區間。 */
export function isInRiskControlGap(t: DatedTrade): boolean {
  return t.closedAt != null
    && t.closedAt >= RISK_CONTROL_GAP_START
    && t.closedAt < RISK_CONTROL_GAP_END;
}

// ── 對帳判定：哪些列可以進風控算式 ─────────────────────────────────────
//
// 2026-09-19 的 `npm run audit-exits` 把 28 筆標成 `audit_verdict ≠ OK`，
// 其中 **8 筆是硬證據的捏造出場**：DB 記 −0.05%（保本出場的簽名），幣安上
// 那個部位實際是 +1.6%～+4.2%。成因是 DB 模擬用**收盤價 K 線**判定出場，
// 幣安用**標記價**觸發——下影線碰到但標記價沒到，就會造出一筆從沒發生過的
// 出場（見 route.ts 的 `excludeExchangeManaged` 檔頭）。
//
// 這些假虧損進過回撤計算。2026-08-27 那次把權益回撤推到 13R > 當時的 12R
// 門檻，**整個系統被自己捏造的虧損停機**。跟 2026-08-19 那次（8.01R vs 8R，
// 程式碼註解自己寫「這 8R 回撤是用有 bug 的系統跑出來的」）是同一個病。
//
// 2026-09-20 使用者決定：**回撤與熔斷先排除，顯示層（戰績卡）不動。**
// 理由是這兩道會「自己把系統停掉」，誤停的代價具體且已經發生過；戰績卡只是
// 顯示，改了反而會讓使用者看到的數字突然跳動、跟過去的印象對不起來。
//
// 缺欄位／沒對帳過一律視為乾淨：`audit_verdict` 只有跑過 audit-exits 的單
// 才有值，把「沒查過」當成「有問題」會讓絕大多數單被排除，那是更糟的失效
// 方向（風控直接失去資料 → n=0 → 不擋）。

/** 對帳判定為「這筆可以用」的值。null／undefined／空字串＝沒對帳過，同樣算乾淨。 */
const AUDIT_CLEAN_VERDICTS = new Set(['OK']);

export interface AuditMarked {
  /** `audit-exits` 寫入的對帳判定。沒跑過對帳的單是 null。 */
  audit_verdict?: string | null;
}

/**
 * 這一列的損益數字可不可以拿去餵風控算式（回撤、熔斷）。
 *
 * **不要拿來過濾顯示用的統計**——那是另一個決定，見上面的檔頭說明。
 */
export function isAuditClean(t: AuditMarked): boolean {
  const v = t.audit_verdict;
  if (v == null || v === '') return true;
  return AUDIT_CLEAN_VERDICTS.has(v);
}

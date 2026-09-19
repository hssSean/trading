// 「這一筆的來回手續費佔多少 R」——純算術，不是統計。
//
// ## 為什麼這件事值得單獨標示
//
// R = 損益% ÷ 止損距離%。手續費也是一個百分比，所以
//
//     手續費佔的 R = 來回費率% ÷ 止損距離%
//
// 是**除法**，不需要樣本、不需要顯著性。止損距離 0.103% 的單（實際存在：
// `BTC trade-1788739523052-vca5z`，2026-09-07）光是開平倉就吃掉 0.68R——
// 也就是說那筆就算完全照計畫走到保本出場，帳面也是輸的。
//
// ## 這跟「止損距離下限」不是同一件事
//
// CLAUDE.md 記了止損距離下限「測過了，無效（2026-09-07）」，那份測的是
// **「clamp／skip 會不會提升淨 R」**——clamp／skip 兩種修法各四個門檻全部
// `|t| < 1`。那個結論沒有被推翻，這裡也**不做任何擋單或改價**。
//
// 兩者的差別是「這筆成本高」（除法就能證明）vs「改了會比較好」（要實測，
// 而實測測不出來）。所以這裡只做第三件事：**告訴使用者，讓他自己決定跟不跟。**
// 2026-09-20 使用者選的就是這一條：標示、超過門檻才標、不擋單。
//
// ## 費率從哪來
//
// 幣安 USDⓈ-M 永續合約一般用戶：maker 0.0200%、taker 0.0500%。
// 進場是限價掛單（maker）、出場是條件單觸發後的市價（taker），所以典型的
// 來回是 0.07%；市價進場例外（`marketEntryException.ts`）兩邊都是 taker，
// 0.10%。VIP 等級或 BNB 折抵會讓實際值更低——這裡刻意取**不打折的值**，
// 寧可高估成本也不要讓使用者低估。

/** 幣安 USDⓈ-M 永續，一般用戶掛單方（限價單成為流動性提供者）。 */
export const MAKER_FEE_PCT = 0.02;
/** 幣安 USDⓈ-M 永續，一般用戶吃單方（市價單、條件單觸發後的成交）。 */
export const TAKER_FEE_PCT = 0.05;

/**
 * 預設警示門檻：手續費佔 0.3R。
 *
 * 校準邏輯：0.07% ÷ 0.3 = 0.233%，也就是止損距離要近到 0.233% 以內才會觸發。
 * 系統典型的 ATR 止損距離是 1%～2%（對應 0.035R～0.07R），所以這道標示
 * **平常不會出現**，只在那種「近到不合理」的單上跳出來。實測 434 筆裡只有
 * 兩筆會中（0.103% → 0.68R、0.172% → 0.41R）。
 *
 * 門檻訂太低的代價不是誤擋（這裡不擋單），是每則推播都多一行雜訊而讓人
 * 開始忽略它——那等於這個功能白做。
 */
export const FEE_R_WARN_THRESHOLD = 0.3;

/** 一趟完整交易（進場 + 出場）的費率合計，百分比。 */
export function roundTripFeePct(isLimitEntry: boolean): number {
  return (isLimitEntry ? MAKER_FEE_PCT : TAKER_FEE_PCT) + TAKER_FEE_PCT;
}

/**
 * 來回手續費相當於幾個 R。
 *
 * 止損距離為 0（或進場價無效）時回傳 `null` 而不是 `Infinity`——呼叫端要能
 * 分辨「成本無限大」與「算不出來」，前者會讓推播印出 `Infinity R`。
 */
export function feeCostInR(
  entry: number, stopLoss: number, isLimitEntry: boolean,
): number | null {
  if (!(entry > 0)) return null;
  const stopDistPct = Math.abs(entry - stopLoss) / entry * 100;
  if (!(stopDistPct > 0)) return null;
  return roundTripFeePct(isLimitEntry) / stopDistPct;
}

/**
 * 推播要附加的成本警示。低於門檻或算不出來時回傳空字串。
 *
 * 回傳值直接串在推播 body 後面，所以自帶前綴分隔符號。
 */
export function formatFeeWarning(
  entry: number, stopLoss: number, isLimitEntry: boolean,
  threshold: number = FEE_R_WARN_THRESHOLD,
): string {
  const r = feeCostInR(entry, stopLoss, isLimitEntry);
  if (r == null || !(r >= threshold)) return '';
  const distPct = Math.abs(entry - stopLoss) / entry * 100;
  return `\n⚠止損僅 ${distPct.toFixed(3)}%，來回手續費約佔 ${r.toFixed(2)}R`;
}

// TP1 標記的欄位語意 —— **唯一的定義處**。
//
// ## 為什麼需要這個檔
//
// 不變量只有一條：`status === 'tp1_hit'` ⇒ `result === 'WIN_TP1'`。
// 問題是寫入這張表的有兩個人，而他們對這條的認知曾經不一致：
//
//     route.ts（DB 模擬）       標 TP1 時寫 status + result + exit_price + pnl
//     live-runner（真倉）       markTp1Hit 只寫 status
//
// 單看每一邊都說得通。出事的是**交接處**：route.ts 關一筆已經是 tp1_hit 的
// 單時走 `isFinalClosingTp1` 分支，該分支刻意不覆寫 `result`（它假設 TP1
// 當下已經寫過 'WIN_TP1' 了）。所以 live-runner 標記、route.ts 關單的那些
// 單，`result` 從頭到尾都是 NULL。
//
// 代價全部是靜默的，沒有任何錯誤訊息：
//
//   - `activeCooldowns` 用 `result === 'LOSS'` 判冷卻 → NULL 的虧損單
//     **拿不到 24 小時同向鎖定**，剛被證偽的 setup 可以立刻再進一次。
//   - `checkStratBPaused` 的連兩敗暫停漏算。
//   - 勝率／戰績卡／回撤基準全部少算這些單。
//
// 2026-09-19 實測 DB 裡有 3 筆這種列（ENA/BNB/HYPE，全是 trailing_stop 出場、
// pnl 為正），由 `npm run audit-invariants` 的 CLOSED_NO_RESULT 檢查抓到。
//
// 跟 `drawdownHalt.ts` 的 `DEFAULT_MAX_DRAWDOWN_R` 同一個模式：這個專案反覆
// 出事的形狀就是「同一件事在兩個地方各維護一份」，所以把它收斂成一份。

/** `status='tp1_hit'` 的單一定帶這個 result。 */
export const TP1_RESULT = 'WIN_TP1';

/** 標記 TP1 已觸發。兩條執行路徑共用，不要在別處另寫一份。 */
export function tp1MarkPayload(): { status: 'tp1_hit'; result: typeof TP1_RESULT } {
  return { status: 'tp1_hit', result: TP1_RESULT };
}

/**
 * 把誤判的 TP1 標記退回。
 *
 * live-runner 有一段反向自我修復：DB 說 tp1_hit，但那張 TP1 條件單此刻還掛
 * 在交易所上（還掛著 = 一定沒成交），代表部位變小另有原因（手動平倉、ADL、
 * 部分強平、取整灰塵）。既然標記時會寫 result，回滾就必須一起清掉，否則會
 * 留下一筆「還在跑、卻已經記成 WIN_TP1」的活單。
 */
export function tp1RollbackPayload(): { status: 'active'; result: null } {
  return { status: 'active', result: null };
}

/**
 * 關閉一筆 `status='tp1_hit'` 的單時，`result` 欄位要怎麼寫。
 *
 * 回傳的是「要合併進 update payload 的片段」：空物件代表**不要碰 result**。
 *
 *   - 走到 TP2      → 升級成 'WIN_TP2'
 *   - 已經有 result → 不動（維持既有行為：TP1 已經落袋，最終不管打到止損
 *                     還是保本，這筆仍然算 WIN_TP1，損益用 blendTp1PartialPnl
 *                     的加權平均表示）
 *   - result 是空的 → 補寫 'WIN_TP1'。這是上面說的交接漏洞的修補點：
 *                     即使標記端漏寫了，關單端也不會讓它以 NULL 收場。
 */
export function resultOnTp1FinalClose(
  currentResult: string | null | undefined,
  closeResult: string,
): { result: string } | Record<string, never> {
  if (closeResult === 'WIN_TP2') return { result: 'WIN_TP2' };
  if (currentResult == null || currentResult === '') return { result: TP1_RESULT };
  return {};
}

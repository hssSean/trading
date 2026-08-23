// 影子模擬的「這筆到底有沒有變」判斷。
//
// 2026-08-23：Upstash 額度爆掉後查帳，寫入 249,658 次（10,870/天）比我能指認
// 的來源多出約 4 倍。差額追到三個影子處理迴圈都長這樣：
//
//   for (const st of group) {
//     simulateShadow(st, candles, now);
//     st.lastCheckedAt = now;              // ← 每筆都改
//     writes[st.id] = JSON.stringify(st);  // ← 於是每筆都要寫回
//   }
//
// 影子單推進的是 1 小時 K 線，而推進節流是 10 分鐘一次——絕大多數輪次裡
// K 線根本沒收新的一根，模擬結果一個字都沒變，唯一變的是 lastCheckedAt。
// 等於每 10 分鐘把整包影子單重寫一次，只為了記錄「我看過了」。
//
// lastCheckedAt 全專案只被寫、沒有任何地方讀它來做判斷（純診斷欄位），
// 所以「沒變就不寫」不會影響任何行為。
//
// 三個 hash（shadow_trades / time_stop_shadows / cancel_shadows）共用這支，
// 避免同一個判斷寫三份然後其中一份忘記跟上。

/**
 * 比較影子單推進前後有沒有實質變化，忽略 lastCheckedAt。
 *
 * 用 JSON 字串比較而不是逐欄位比對：影子單的欄位會隨策略演進增加
 * （例如 2026-08-22 才加的 pessResult/pessExitPrice），逐欄位比對每次
 * 加欄位都要記得同步更新，忘了就會變成「有變化卻沒寫回」——那是靜默
 * 遺失資料，比多寫幾次嚴重得多。
 *
 * 兩邊都把 lastCheckedAt 正規化成 0；覆寫既有的鍵不會改變它在物件裡的
 * 順序，所以字串比較是穩定的。
 */
export function shadowChanged<T extends { lastCheckedAt: number }>(before: T, after: T): boolean {
  return JSON.stringify({ ...before, lastCheckedAt: 0 })
      !== JSON.stringify({ ...after,  lastCheckedAt: 0 });
}

/** 給就地修改型的推進函數用的淺快照（影子單都是扁平的小物件）。 */
export function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

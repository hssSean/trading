// 2026-08-22：偵測「這個分頁跑的是舊版程式碼」。
//
// 背景是實際踩到的事：使用者回報分類按鈕的 bug 仍在，查了幾輪才發現他的分頁
// 已經開了 1478 分鐘（24.6 小時），跑的是修法部署前的 bundle。SPA 的 JS 不會
// 熱抽換，分頁不重載就永遠停在載入當下那一版。next.config.js 的註解早就寫過
// 「a PWA tab can sit open on a stale bundle for days」，但當時只做了在設定頁
// 顯示版本，沒有人會主動去看。
//
// 這件事的代價不只是「修法晚幾天生效」，而是**回饋迴路壞掉**：使用者說「還在
// 壞」時，我無法分辨那是修法無效，還是他根本沒拿到修法。所以驗收結果不可信。
//
// 特別糟的組合：有些 bug（例如 React 漏刪 DOM 節點那個）**只在開很久沒重載的
// 分頁上發生**——而那正好就是永遠拿不到修法的分頁。

export interface UpdatePromptInput {
  // 打包進當前 bundle 的 commit sha（NEXT_PUBLIC_BUILD_SHA，建置時寫死）
  local: string | undefined;
  // 跟伺服器現在要到的 sha（/api/build，永遠是最新部署）
  server: string | undefined;
  // 使用者已經對這個 sha 按過關閉，就別再煩他
  dismissed: string | null;
}

export function shouldPromptUpdate({ local, server, dismissed }: UpdatePromptInput): boolean {
  // 本機開發沒有 VERCEL_GIT_COMMIT_SHA，兩邊都是空字串——不要在 dev 一直跳。
  if (!local || !server) return false;
  // 取不到或相同都不提示。
  if (local === server) return false;
  // 同一版只煩一次。之後又出新版（server 變成別的 sha）還是會再提示。
  if (dismissed === server) return false;
  return true;
}

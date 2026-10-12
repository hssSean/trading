# CLAUDE.md — 專案指引

## 語言規定
**所有回覆一律使用繁體中文。**

---

## 編碼規定
**所有檔案皆使用 UTF-8 編碼，Claude 讀寫檔案時也一律使用 UTF-8。**
檔案寫入（如 `event_record.txt`、逐字稿、快取 JSON）必須明確指定 `encoding='utf-8'`，避免 Windows 預設編碼（CP950）導致閃退或亂碼。

---

## 專案概觀

加密貨幣永續合約自動交易系統（Crypto Trader）：Next.js 14 App Router PWA，部署於 Vercel（sin1）。跑研究端交付的 S3／S1 策略：EC2 上的 live-runner 在幣安 testnet 真下單（S3-A＋S3-B），Vercel 的 `/api/analyze`（外部 cron）跑三個模擬帳本與告警，App 顯示真倉、訊號與帳本。

- **資料庫**：Supabase PostgreSQL（`profiles`、`push_subscriptions`；`trades` 只剩舊策略的歷史紀錄，`/legacy` 唯讀顯示）
- **快取/狀態**：Upstash Redis（S3 真倉 `s3a-live:*`、模擬帳本與快照 `s3s1:*`、心跳、kill switch）
- **行情來源**：Binance Futures 公開 REST API（免金鑰）

### ⚠️ 2026-10-07 起交易策略已換成 S3／S1（舊的評分策略只剩出場管理）

研究端《策略部署總整理》（`docs/strategy-deploy-2026-10-06.md`，驗收用參考交易 `docs/s3-reference-trades.csv`、`docs/s1-reference-trades.csv`）：

| | 做什麼 | 跑在哪 | 紀錄 |
|---|---|---|---|
| **S3-A＋S3-B 真倉** | 日線唐奇安突破＋分數 = 2。A 每筆 4%；B 每筆 3%＋1R 加碼；各自風險加總 ≤ 20%。**同一個 testnet 帳戶、同幣合併成一個部位、內部分帳**（2026-10-07 使用者決定，設計 `docs/superpowers/specs/2026-10-07-s3b-live-shared-account-design.md`） | live-runner（testnet 真下單），UTC 00:00:30～02:00 進場 | Redis `s3a-live:*`（pos／done／meta／signals；meta 裡 A 無前綴、B 前綴 `b.`） |
| S3-A／S3-B／S1 模擬帳本 | 三個 100 USDT 的帳本，S3-B 有 1R 加碼、S1 是 12H Keltner | Vercel `/api/analyze`（prep 00:05、S3 01:05、S1 每個 12H 收盤 +1h05） | Redis `s3s1:*`（meta／<帳戶>:open／done／signals／prep:<日>） |

- **規則只有一份：`src/lib/s3s1/rules.ts`**（帳本 `engine.ts`、真倉 `src/engine/s3aLive.ts` 都用它）。改規則前先跑 `npm run s3s1-acceptance`（S3 35 筆、S1 15 筆、廣度 50 天，誤差 1e-6，必須全過）。
- **舊 v2.1 評分策略 2026-10-12 已整個移除**（掃描、DB 模擬監控、live-runner 逐筆管理、回測與稽核腳本、`/funnel`／`/attribution` 診斷頁；移除前確認持倉、掛單、未平倉紀錄全為 0）。最後的完整程式在 git tag **`legacy-v2.1-final`**，找回單一檔案：`git checkout legacy-v2.1-final -- <路徑>`。`/legacy` 三頁與 `/analysis` 保留唯讀。S3-A 遇到交易所上已有該幣持倉或掛單（例如手動單）就不進場。
- 真倉開關：live-runner 的 shell 設 `S3A_DRY_RUN=1` = 只印不下單（A、B 一起）；kill switch 也會擋新倉。試跑：`ENV_FILE=env.txt npm run s3a-dryrun [-- --at-open | --day=YYYY-MM-DD]`（讀線上狀態、不下單、不寫 Redis；`--day` 用 7 天內某天的訊號快照走一次進場）。
- 真倉分帳的要點（`src/engine/s3aLive.ts`）：交易所上一個部位、一張止損（數量變了就先掛新再撤舊）、一張止盈（A、B 各 1/3）、一張 B 加碼 STOP_MARKET BUY（非 reduceOnly）。部位數量變了**只有「不見的條件單」能解釋時才當成成交**（`checkPosition`）；條件單不見但部位沒變要連續兩輪才當成被拒絕（避免觸發後市價單還在路上就重複下單）。出場依成交紀錄分帳（`splitResult`）。
- **紙上登記（策略 A、影片 A/B/C）與 F1 前向追蹤已於 2026-10-07 停用並刪除程式碼**；Redis 的 `paper:*`、`f1p:*` 舊資料保留未刪。
- **App 2026-10-07 起以 S3 為主**（設計 `docs/superpowers/specs/2026-10-07-s3-app-redesign-design.md`）：首頁＝S3-A 真倉總覽、`/signals`＝S3／S1 訊號（含被擋掉的）、`/ledgers`＝三個帳本、`/trades`＝S3-A 真倉紀錄。資料走唯讀 API `/api/s3/{overview,signals,ledgers,trades}`（回應型別 `src/lib/s3s1/apiTypes.ts`，畫面計算 `src/lib/s3s1/view.ts`，統計 `src/lib/s3s1/stats.ts`）。舊策略的首頁／信號／紀錄搬到 `/legacy`、`/legacy/signals`、`/legacy/trades`，設定也收進設定頁最下方「舊策略（已停用）」；`/strategies` 轉址到 `/ledgers`。live-runner 每小時把 testnet 錢包權益與模式寫進 `s3a-live:meta`（`wallet`／`walletAt`／`mode`）。月報（文件 §7）：`ENV_FILE=env.txt npm run s3s1-report [-- YYYY-MM]` 寫到 `reports/`（不進版控）。手動補跑帳本：`npm run s3s1-run`。
- **每日前向對帳**（2026-10-12）：研究端 `C:\trading_stratage\s3_xcheck.py` 用研究端自己的函數重算最近 7 天的 S3（廣度、BTC 條件、D 與 X 兩天的幣池前 100、突破候選、分數、資金費）與 S1 候選（12H Keltner 突破、止損），跟 `s3s1:prep:<X>`／`s3s1:signals` 比對，結果寫 Redis `s3s1:xcheck`。使用者電腦的工作排程器「S3 每日對帳」每天 09:30 跑（錯過會在開機後補）。route.ts 每天約 UTC 02:00 讀結果，有不一致或超過 3 天沒跑就推播（`src/lib/s3s1/xcheckAlert.ts`）。改 `rules.ts` 後若這支開始報不一致，先確認研究端是否同步改了。
- **2026-10-12 S1 空幣池事故**：prep 在 UTC 00:05 只有已收盤日線，`universeOn(raw, X)` 卻要求 X 那根存在 → 快照 `uni[X]` 永遠空的，S1 上線 5 天 10 個決策點 0 候選、完全無聲。驗收測試用完整歷史資料所以抓不到。已修（`6c5106b`），快照重建、S1 從追蹤起點重播（`scripts/s1-replay-2026-10-12.ts`，舊快照備份在 `reports/`）。**教訓：「線上當下」與「歷史回放」的資料可得性不同，驗收全過不代表線上對；每日對帳要比線上實際讀的那一份。**
- 轉實盤（主網）條件已預先登記：`C:\trading_stratage\docs\轉實盤條件_預先登記.md`（主網 500 USDT、只跑 S3-A；監控基準 +0.70R/筆，是套 20% 總風險上限後的數字，不是全部訊號的 +0.96R）。
- **分數影子追蹤**（2026-10-12，`src/lib/s3s1/shadow.ts`）：S3 帳本工作每天把「通過所有濾網、算到分數」的候選（2 分的也收，當對照組）記進 Redis `s3s1:s3x`，用同一套 S3 規則（不加碼、不受持倉上限）模擬到出場。這是驗證分數門檻唯一的方法；`npm run status` 印「2 分 vs 被擋」的平均 R。每月約 2～4 筆，**少於 30 筆前不要拿它下結論**。
- 停用條件（文件 §8）程式會自己判、自己停開新倉（真倉 A、B 各自判）：S3-A 回撤 > 35% 或連虧 7；S3-B > 40% 或連虧 15；S1 > 60% 或近 50 筆勝率 < 45%。
- 誠實提醒：S3 的分數門檻是看過歷史資料後挑的（研究端自己也說新資料才驗得了），S1 標為實驗性。

### ⚠️ 兩條執行路徑（搞錯這個會誤診很多問題）

| | Vercel `/api/analyze` | `scripts/live-runner.ts`（AWS EC2 常駐） |
|---|---|---|
| 跑在哪 | Vercel cron，5 分鐘一輪 | AWS EC2 上 `npm run live-runner`，15 秒一輪 |
| 做什麼 | S3／S1 模擬帳本、分數影子、live-runner 停止告警、對帳告警（2026-10-12 起舊策略掃描與 DB 模擬已移除） | **S3-A＋S3-B 真倉在幣安 testnet 下單**、管理、出場；心跳、kill switch、全帳戶殘留條件單清理（2026-10-12 起舊策略逐筆管理已移除） |
| 對誰生效 | `live_trading_enabled=false` 的使用者 | `live_trading_enabled=true` 的那一位 |
| 發哪些推播 | live-runner 停止／恢復、S3 對帳不一致 | S3 進場／止盈／加碼／移動止損／出場 |

2026-10-12 起 route.ts 不再監控任何持倉（舊策略的 DB 模擬已移除），所有真倉事件的推播都來自 live-runner。所以：

- **進出場推播收不到 = live-runner 那側的推播掛了**，不是推播機制壞掉。第一個要查的是 live-runner 的 shell 有沒有 VAPID 金鑰（2026-08-12 實測就是這個原因，已加啟動警告）。
- 🔴 **`env.txt` 不是 shell 腳本，絕對不要 `source`／`. ./env.txt`**。裡面混了筆記與指令（含 `npm run live-runner`），2026-10-12 被 source 時真的在本機啟動了 live-runner（因缺變數立刻退出，沒下單），還把金鑰印到終端。要載入一律用 `ENV_FILE=env.txt` ＋ `scripts/loadEnvFile.ts`。
- live-runner **不會載入 `.env`**（專案沒裝 dotenv），所有環境變數都得在啟動它的 shell 裡設好，清單見 `.env.local.example`。
- live-runner 是常駐腳本，**改完 code 要使用者到 EC2 `git pull` 並重啟才生效**（Vercel 那側 push 完自動部署）。
- live-runner 停止超過 10 分鐘，route.ts 會推播「⚠ live-runner 停止了」（`src/lib/liveRunnerAlert.ts`，2026-10-12）。沒有任何東西能接手：**S3 真倉的移動止損／加碼／進場在 runner 停止期間沒人做**（交易所上的硬止損仍在）。重啟要避開台灣 08:00～10:00（S3 進場窗口）。

## 常用指令

```bash
npm run dev          # 本機開發（localhost:3000）
npx tsc --noEmit     # 型別檢查（改完程式必跑）
npm test             # vitest 全套（= npx vitest run）
npx next build       # production build（push 前的最後檢查）
npm run live-runner  # 真倉常駐腳本（testnet，會真的下單）——只在 EC2 跑，本機不要開（會跟 EC2 搶同一個帳戶）
npm run s3s1-acceptance   # 改 rules.ts 前後必跑：S3 35 筆、S1 15 筆、廣度 50 天，誤差 1e-6
ENV_FILE=env.txt npm run s3a-dryrun [-- --at-open | --day=YYYY-MM-DD]   # S3 真倉試跑（讀線上狀態、不下單、不寫 Redis）
ENV_FILE=env.txt npm run s3s1-report [-- YYYY-MM]   # 月報（文件 §7），寫到 reports/
npm run s3s1-run     # 手動補跑帳本工作（prep → s3 → s1）
```

### 診斷

**回答「現在到底怎麼了」之前先跑這個，不要靠猜或開一堆網頁。** 這個專案發生過多次
「靜默停擺好幾天才發現」（live-runner 整週沒監控持倉、S1 五天 0 候選），成因都是狀態
分散在 Vercel／Supabase／Upstash／幣安四個地方。

```bash
ENV_FILE=env.txt npm run status   # S3 真倉（模式、權益、今天的決策、持倉與交易所止損止盈單）、
                                  # 模擬帳本、分數影子、每日對帳、心跳、孤兒部位
```

它最後會印判語（✅／⚠／🔴，邏輯在 `src/lib/s3s1/statusCheck.ts`）。Redis 讀不到時照樣印
Supabase 心跳與交易所部位。舊策略只在還有未平倉時展開（`-- --legacy` 強制展開）。

另一道防線是研究端的**每日前向對帳**（`C:\trading_stratage\s3_xcheck.py`，見上方），
它回答 status 回答不了的問題：「線上算出來的東西跟研究端一不一樣」。

金鑰放 `.env.local`，或用 `ENV_FILE=env.txt` 指定別的檔案。載入器只印變數名不印值
（`scripts/loadEnvFile.ts`）。**`env.txt` 絕對不要 source**（見上方）。

## 部署流程

`git push origin main` → Vercel 自動部署（1-2 分鐘）。live-runner 要使用者到 EC2 `git pull` 並重啟。使用者已授權直接 push main；破壞性操作（force push、改歷史）仍須先確認。

## 關鍵檔案

| 檔案 | 職責 |
|---|---|
| `src/lib/s3s1/rules.ts` | S3／S1 規則（訊號、分數、幣池、廣度、出場模擬）——**唯一一份**，帳本與真倉都用它 |
| `src/lib/s3s1/engine.ts` | 三個模擬帳本（prep／s3／s1 工作）＋分數影子 `runS3Shadow` |
| `src/engine/s3aLive.ts` | S3-A＋S3-B 真倉：進場、分帳、止損／止盈／加碼條件單、出場結算 |
| `scripts/live-runner.ts` | EC2 常駐迴圈：心跳、kill switch、全帳戶殘留條件單清理、S3 真倉。檔頭註解是這支「現在實際做什麼」最準的來源 |
| `src/app/api/analyze/route.ts` | cron 入口（約 300 行）：live-runner 停止告警、S3／S1 帳本工作、對帳告警 |
| `src/app/api/s3/*` | App 用的唯讀 API（overview／signals／ledgers／trades） |
| `scripts/status.ts` | 診斷第一步（見上） |
| `src/engine/binanceClient.ts`、`precision.ts` | 幣安 API 與數量／價格取整 |
| `docs/strategy-deploy-2026-10-06.md` | 研究端交付的 S3／S1 部署規格 |
| `docs/LEGACY-v2.1-教訓.md` | 舊策略測過、沒用的東西與量測陷阱 |
| `docs/TODO.md` | 待辦與優先級。已完成的搬到 `docs/TODO-archive.md` |

## 專案慣例

- **舊 v2.1 評分策略的調參史與實作教訓搬到 `docs/LEGACY-v2.1-教訓.md`**（2026-10-12）。要對 S3／S1 加濾網、調止損、看拒絕統計之前先讀——很多「看起來該改」的已驗證無效，量測陷阱（假的悲觀值、被灌水的 n、目標變近冒充發現）同樣適用。**不要再試「另一組技術指標」**（`docs/ANALYSIS-2026-09-27-修改還是換策略.md`）；新策略研究一律在研究端 `C:\trading_stratage` 做，並先登記到它的 `docs/試驗登記表.md`。
- **損益一律用 R 倍數**（損益 ÷ 1R 風險）與帳戶實際損益衡量，不用原始價格 %——ATR 止損的原始 % 會嚴重誤導（舊策略熔斷曾因此誤鎖整天）。
- **倉位的絕對金額要另外把關**：名目 = 風險金額 ÷ 止損距離，止損距離趨近 0 時名目會爆炸，而每一道 R／百分比上限都不會有反應。
- **數量取整不能留灰塵**：`Math.floor(qty / step)` 會被浮點誤差削掉一整格（`16.24 / 0.01 = 1623.9999…`），少平一格 = 部位永遠不歸零、下游全錯（2026-09-08 舊策略實測）。一律走 `precision.ts`／`engine.ts` 的 `floorStep`（帶 1e-9 容差），**任何新的「算數量」路徑都要記得**。
- **條件單「觸發」不等於「成交」**：幣安條件單觸發後可能被拒絕（`algoStatus=REJECTED`，例：`Reduce only reject`、testnet 流動性薄的 PERCENT_PRICE），被拒絕的單會從 openAlgoOrders 消失。**「不見了」要當成「可能被拒絕」**，不能當成「已成交」——S3 的 `checkPosition` 就是照這條設計的（部位數量變了才算成交，條件單不見但部位沒變連兩輪才算被拒絕）。
- **「部位變小」不等於「止盈發生」**：手動平倉（這個帳戶會用手機 App 直接下單）、ADL、部分強平、取整灰塵都會讓部位變小。
- **「線上當下」與「歷史回放」的資料可得性不同**（2026-10-12 S1 空幣池事故）：驗收用完整歷史資料全過，不代表線上 00:05 那一刻拿得到同樣的東西。新規則要用「線上實際讀的那一份」驗。
- **Supabase 缺欄位**：insert 對 `42703`/`PGRST204` 有兩段式 fallback；新增欄位時要同步更新 fallback 剝除清單並提醒使用者跑 `ALTER TABLE`。
- **Redis 指令數要省**：批次讀寫（hash/hgetall、單次 lpush 多值），避免迴圈內逐鍵操作；Upstash 免費額度有限（2026-08-23 真的燒完過）。
- **CPU 要省**：外部 cron 每 60 秒打一次（`scan-run-lock` TTL 240 秒節流），只能砍每次呼叫的計算量。
- 改完程式：`npx tsc --noEmit` → `npx vitest run` → 有 UI 變更盡量預覽驗證 → `npx next build` → commit（訊息附 Co-Authored-By）→ push。
- 本機預覽的登入需真實 Supabase session，placeholder 環境會卡在載入 spinner；純函數改用 node 單元測試驗證。

## 工具規定

### 🔴 本專案的強制觸發（不是建議，是規定）

下面每一條都對應**這個專案真的踩過的坑**。純目錄式的工具清單（見文末）不會讓
工具被用到，只有綁定具體情境才會。

| 情境 | 必用 | 為什麼 |
|---|---|---|
| 使用者說「壞了／怪怪的／沒反應」 | `npm run status` **先跑**，再談修法 | 這個專案發生過多次「靜默停擺一週」。2026-09-04 那次 `status` 一跑就看到孤兒部位，省掉整輪猜測 |
| 任何 bug／非預期行為 | `superpowers:systematic-debugging` | 2026-08 有兩次「憑猜測改兩輪都沒中」，第三輪才實測。先量測再修是硬規定 |
| 要說「修好了」之前 | `npx tsc --noEmit` → `npx vitest run` → `npx next build` 三個都跑 | 這輪修 UNI 孤兒時，第一版修正**引入了更糟的 bug**（撤掉真倉的保護單），是測試擋下來的 |
| 要新增功能／重構／「要不要重做」 | `superpowers:brainstorming` | 2026-09-03「策略要不要重建」那次我直接跳到數據分析，跳過了發散階段 |
| 動任何策略參數之前 | 讀 `docs/ANALYSIS-*` 最新那份 | 四個層面都測過了，很多「看起來該改」的已驗證無效 |
| 宣稱某個統計結論 | 先看**樣本量、顯著性、涵蓋率**三個 | 這一個月抓到七個量測錯誤，每個在被抓到前都長得像結論 |
| 要理解跨檔呼叫關係 | `/graphify .` 或 `claude-mem:smart-explore` | `route.ts` 超過 3500 行，整檔讀既慢又容易漏 |
| 查「這個之前做過嗎」 | `claude-mem:mem-search` | 避免重跑已經做過的分析 |
| 抓外部網頁／API 文件 | `WebFetch`／`WebSearch` | firecrawl MCP 已於 2026-09-05 從 `.mcp.json` 移除（無 key，呼叫一律回 `Unauthorized: Invalid token`）。要復用：`.mcp.json` 加回 `firecrawl` server + 設 user 環境變數 `FIRECRAWL_API_KEY` |

### ⚠ 外掛設定的坑（2026-09-05 全數修復，記錄供日後參考）

- **RTK 一度被誤判成「完全沒生效」，其實一直在運作。** 當時 `rtk init --show`
  回報 `[--] Hook: not found`，每次 Bash 呼叫也都印 `/!\ No hook installed`，
  看起來像 hook 沒裝。實測 `rtk gain` 才發現：2512 筆指令、省下 10.1M token
  （96%），hook 從頭到尾都在跑。
  真正壞掉的是 **rtk 的自我偵測**——它拿 `rtk hook claude` 做字面字串比對，而
  `settings.json` 當時寫的是絕對路徑 `"C:\...\rtk.exe" hook claude`，比對不中。
  代價不是零：那行警告**被塞進每一次 Bash 輸出**，本身就在燒 token。
  修法是把 hook 指令改成裸 `rtk hook claude`（三份 rtk 二進位檔 hash 相同，
  PATH 解析到哪一份都一樣）。
  ⚠️ **不要直接跑 `rtk init -g --auto-patch`**：rtk 認不得那筆絕對路徑 hook，
  auto-patch 可能是「再追加一筆」而非取代，變成每次 Bash 跑兩次 rewrite。
- **caveman statusline**：已設定。`settings.json` 的 `statusLine` 指向
  `~/.claude/plugins/cache/caveman/caveman/<版本雜湊>/src/hooks/caveman-statusline.ps1`。
  那段**版本雜湊會隨外掛更新改變**，狀態列變空白時先去該目錄看新的雜湊。
- **教訓**：「工具沒生效」這種判斷要拿工具自己的用量統計去證實，不要只信它的
  自我檢查——這次自我檢查說沒裝，用量統計說省了 10.1M。

---

## 已安裝的外掛與指令總覽

> 2026-08-12 盤點。三個外掛：**superpowers**（流程紀律）、**claude-mem**（跨 session 記憶）、**caveman**（回覆壓縮）。
> 這些是**工作方式**的工具，跟本專案的交易邏輯無關，但用對了能省下大量重複探索。

### superpowers（v6.1.1）— 流程紀律，全是 skill 沒有斜線指令

最常用的四個，遇到對應情境**應該主動用**：

| Skill | 什麼時候用 |
|---|---|
| `superpowers:brainstorming` | 要做新功能／新元件前。**先腦力激盪再進 plan mode** |
| `superpowers:systematic-debugging` | 遇到任何 bug／測試失敗／非預期行為，**在提出修法之前** |
| `superpowers:test-driven-development` | 實作功能或修 bug，寫實作碼之前 |
| `superpowers:verification-before-completion` | 要宣稱「做完了／修好了」之前，強制實跑驗證 |

其餘：`writing-plans`（有規格要寫多步驟計畫）、`executing-plans`（照既有計畫在新 session 執行）、`subagent-driven-development`（同 session 用子代理跑獨立任務）、`dispatching-parallel-agents`（2+ 個無相依任務）、`requesting-code-review` / `receiving-code-review`、`using-git-worktrees`（要跟現有工作區隔離）、`finishing-a-development-branch`（實作完成要決定怎麼整合）、`writing-skills`（建立/修改 skill）、`using-superpowers`（skill 使用總則）。

### claude-mem（v13.12.4）— 跨 session 記憶 + 程式碼探索

| Skill | 用途 |
|---|---|
| `claude-mem:mem-search` | 查跨 session 記憶：「這個之前做過嗎？」 |
| `claude-mem:smart-explore` | tree-sitter AST 結構搜尋，**取代整檔讀取**，省 token |
| `claude-mem:learn-codebase` | 一次讀完整個 repo 建立記憶（約 5 分鐘，選用） |
| `claude-mem:make-plan` | 產出分階段實作計畫（含文件探索） |
| `claude-mem:do` | 用子代理執行分階段計畫 |
| `claude-mem:pathfinder` | 把 codebase 畫成依功能分組的流程圖，找重複關注點 |
| `claude-mem:what-the` | 把技術細節翻成白話 |
| `claude-mem:timeline-report` / `weekly-digests` | 專案開發歷程敘事報告 |
| `claude-mem:standup` | 跨 worktree／branch／PR 的唯讀進度比對 |
| `claude-mem:babysit` | 盯著 PR／review 循環直到可合併 |
| `claude-mem:knowledge-agent` | 從觀察記錄建 AI 知識庫並查詢 |
| `claude-mem:oh-my-issues` | 依根因把 GitHub issue backlog 分群 |
| `claude-mem:how-it-works` | 解釋 claude-mem 自己怎麼運作 |
| `claude-mem:version-bump` / `cloud-sync` / `design-is` / `wowerpoint` | 版號發布／雲端同步／Rams 設計審查／簡報產生 |

也提供 MCP 搜尋工具（`mcp__plugin_claude-mem_mcp-search__*`）：`smart_search`、`smart_outline`、`smart_unfold`、`timeline`、`query_corpus` 等。

### caveman — 回覆壓縮（目前為本專案預設啟用）

斜線指令：

```
/caveman lite|full|ultra   # 切換壓縮強度（預設 full）
/caveman-commit            # 產生精簡 commit message
/caveman-review            # 一行式 code review
/caveman-stats             # token 用量與節省統計（--share 產可推文字串）
/caveman-init              # 把 always-on 規則寫進當前 repo
```

關閉：說「stop caveman」或「normal mode」。
**注意**：commit message／PR／安全警告一律寫正常中文，不套壓縮風格。

附三個子代理（用 Agent 工具，`subagent_type` 指定）：

| 子代理 | 用途 |
|---|---|
| `caveman:cavecrew-investigator` | 唯讀定位：「X 在哪定義」「誰呼叫 Y」，回 file:line 表 |
| `caveman:cavecrew-builder` | 外科式 1-2 檔編輯，3 檔以上會拒絕 |
| `caveman:cavecrew-reviewer` | diff／branch／檔案審查，一行一個問題附嚴重度 |

### 其他非外掛但常用

- `/code-review`（含 `ultra` 多代理雲端審查，使用者觸發、計費，我不能自己叫）
- `/verify`、`/run`、`/simplify`、`/security-review`
- **RTK**（`~/.claude/RTK.md`）：token 優化 CLI proxy，hook 會自動改寫指令；`rtk gain` 看節省統計。

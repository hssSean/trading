# CLAUDE.md — 專案指引

## 語言規定
**所有回覆一律使用繁體中文。**

---

## 編碼規定
**所有檔案皆使用 UTF-8 編碼，Claude 讀寫檔案時也一律使用 UTF-8。**
檔案寫入（如 `event_record.txt`、逐字稿、快取 JSON）必須明確指定 `encoding='utf-8'`，避免 Windows 預設編碼（CP950）導致閃退或亂碼。

---

## 專案概觀

加密貨幣永續合約訊號推薦系統（Crypto Trader）：Next.js 14 App Router PWA，部署於 Vercel（sin1），外部 cron 每 5 分鐘打 `/api/analyze` 掃描幣安成交量前 15 名，產生訊號後寫入 Supabase 並以 Web Push 推播。

- **資料庫**：Supabase PostgreSQL（`profiles`、`trades`、`push_subscriptions`）
- **快取/狀態**：Upstash Redis（訊號鎖、熔斷、ADX 遲滯狀態、拒絕漏斗、影子交易）
- **行情來源**：Binance Futures 公開 REST API（免金鑰）

### ⚠️ 兩條執行路徑（搞錯這個會誤診很多問題）

| | Vercel `/api/analyze` | `scripts/live-runner.ts`（本機常駐） |
|---|---|---|
| 跑在哪 | Vercel cron，5 分鐘一輪 | 使用者本機 `npm run live-runner`，15 秒一輪 |
| 做什麼 | 產生訊號 + **DB 模擬**監控 | **真的在幣安 testnet 下單**、監控、關單 |
| 對誰生效 | `live_trading_enabled=false` 的使用者 | `live_trading_enabled=true` 的那一位 |
| 發哪些推播 | 新推薦單（**不受 live 影響，一律由這裡發**） | 進場成交／TP1／移動止損／出場／推薦單失效 |

`live_trading_enabled=true` 時，route.ts 的**監控階段**會排除該使用者（訊號產生不受影響）。所以：

- **「只收得到推薦單通知」= live-runner 那側的推播掛了**，不是推播機制壞掉。第一個要查的是 live-runner 的 shell 有沒有 VAPID 金鑰（2026-08-12 實測就是這個原因，已加啟動警告）。
- live-runner **不會載入 `.env`**（專案沒裝 dotenv），所有環境變數都得在啟動它的 shell 裡設好，清單見 `.env.local.example`。
- live-runner 是常駐腳本，**改完 code 要使用者手動重啟才生效**（Vercel 那側 push 完自動部署）。

## 常用指令

```bash
npm run dev          # 本機開發（localhost:3000）
npx tsc --noEmit     # 型別檢查（改完程式必跑）
npm test             # vitest 全套（= npx vitest run）
npx next build       # production build（push 前的最後檢查）
npm run live-runner  # 真倉常駐腳本（testnet，會真的下單）
npm run backtest     # 回測
npm run testnet-reconcile   # testnet 交易所介面煙霧測試（會真的下單）
curl -s "http://localhost:3000/api/analyze"   # 本機無 WEBHOOK_SECRET 時可直接跑真實掃描
```

### 診斷工具（2026-08/09 新增，全部唯讀）

**回答「現在到底怎麼了」之前先跑這些，不要靠猜或開一堆網頁。** 這個專案發生過
多次「靜默停擺一週才發現」（live-runner 整週沒監控持倉、DB 模擬捏造出場把系統
自己停掉），成因都是狀態分散在 Vercel／Supabase／Upstash／幣安四個地方。

```bash
npm run status          # 系統活著嗎：最後訊號時間、持倉、保護單、回撤、心跳
npm run audit-exits     # 拿幣安真實成交對帳 DB 的損益紀錄
npm run funnel-verdict  # 各風控濾網到底在保護還是在害（含悲觀覆蓋率把關）
npx tsx scripts/drawdown-threshold.ts   # 用 bootstrap 訂回撤門檻
npx tsx scripts/apply-audit-marks.ts <報告.json> [--apply]   # 標記髒資料，預設試跑
```

金鑰放 `.env.local`，或用 `ENV_FILE=env.txt` 指定別的檔案。載入器只印變數名
不印值（`scripts/loadEnvFile.ts`）。

**`npm run status` 是排查任何「為什麼沒訊號／為什麼沒平倉」的第一步**——它會
直接算出回撤、列出每筆真倉的止損止盈單，並分辨「TP1 已觸發」與「TP1 單根本
沒掛上」。後者是 2026-08-23 那次「打到 TP1 卻沒出 50%」的形狀。

## 部署流程

`git push origin main` → Vercel 自動部署（1-2 分鐘）。使用者已授權直接 push main；破壞性操作（force push、改歷史）仍須先確認。

## 關鍵檔案

| 檔案 | 職責 |
|---|---|
| `src/app/api/analyze/route.ts` | 掃描主流程：regime 判定、風控關卡、DB 寫入、推播、持倉監控、漏斗與影子模擬 |
| `src/analysis/signals.ts` | v2.1 分組計分（基礎 40 + 五組上限）、tier 門檻（A/B 目前都是 65，B 已名存實亡）、策略 B 均值回歸 |
| `src/analysis/indicators.ts` | EMA/RSI/MACD/ADX/BB/Donchian；`computeIndicators` 附帶前一根值（勿再算兩次） |
| `src/lib/position.ts` | 倉位計畫（倉位/本金/槓桿），前後端共用，勿另寫倉位公式 |
| `src/lib/monitorMath.ts` | 監控純數學：TP1 部分停利、滑價模型、MFE/MAE、`walkTpSl`（三個影子模擬共用） |
| `src/store/useStore.ts` | Zustand + localStorage persist + Supabase 同步 |
| `scripts/live-runner.ts` | 真倉常駐迴圈（testnet）。檔頭註解是這支「現在實際做什麼」最準的來源 |
| `src/engine/tradeBridge.ts` | 真倉決策純函數（該下單／該撤單／該關倉），live-runner 的大腦 |
| `src/lib/dailyLossCap.ts` | 日虧損上限。**唯一用「錢」而不是 R 衡量、也是唯一 fail-closed 的關卡**，兩個性質都跟專案其餘部分相反，改之前先讀檔頭 |
| `src/lib/exitAudit.ts` | 對帳配對（幣安成交 ↔ 我們的 trade），判語分硬/軟證據兩級 |
| `docs/TODO.md` | 待辦與優先級。已完成的搬到 `docs/TODO-archive.md` |
| `docs/ANALYSIS-*.md` | 歷次策略體檢；**調參前先讀最新那份**，很多「看起來該改」的東西已經驗證過無效 |
| `加密貨幣合約推薦單系統-策略規格書-v2.1.md`（使用者 Downloads） | 策略規格書；調參前先讀 |

## 專案慣例

- **調參紀律（規格書 §4）**：一次只動一個濾網，先看拒絕漏斗與影子模擬的淨 R 數據再決定放寬或收緊；淨 R ≤ 0 的關卡代表擋得對，不要動。
  - **看漏斗淨 R 之前先看悲觀覆蓋率**（`npm run funnel-verdict` 會自動把關）。`29b2499` 之前結案的影子單永遠沒有悲觀值，`netRPess` 是 0，而 0 會讓「兩端同號」的判斷失效——樂觀 +24 配悲觀 0 看起來像跨零，實際上只是沒算。2026-09-01 實測八道關卡只有 `circuit_breaker` 覆蓋率達標。
  - **目前狀態：不要調參。** 真實成交 n=78 每筆 −0.081R、t=−0.55，跟三層模擬結論一致（測不出邊際）。檢定力 sd=1.31，偵測 +0.1R/筆 需 n≈680。詳見 `docs/ANALYSIS-2026-08-30-真實成交對帳.md`。
- **損益一律用 R 倍數**（損益% ÷ 止損距離%）與帳戶實際損益衡量，不用原始價格 %——ATR 止損的原始 % 會嚴重誤導（熔斷曾因此誤鎖整天）。
- **Supabase 缺欄位**：insert 對 `42703`/`PGRST204` 有兩段式 fallback；新增欄位時要同步更新 fallback 剝除清單並提醒使用者跑 `ALTER TABLE`。
- **Redis 指令數要省**：批次讀寫（hash/hgetall、單次 lpush 多值），避免迴圈內逐鍵操作；Upstash 免費額度有限。
- **CPU 要省**：外部 cron 頻率不可控，只能砍每次呼叫的計算量；只算需要的指標（如只要 ADX 就別跑 `computeIndicators`）。
- 改完程式：`npx tsc --noEmit` → 有 UI 變更盡量預覽驗證 → `npx next build` → commit（訊息附 Co-Authored-By）→ push。
- 本機預覽的登入需真實 Supabase session，placeholder 環境會卡在載入 spinner；純函數改用 node 單元測試驗證。

## 工具規定

- **graphify**：需要理解本專案架構、檔案關聯、跨檔呼叫關係時，先用 `/graphify .`（或 graphify 指令）建知識圖，不要單靠讀檔猜關聯。
- **firecrawl MCP**：需要抓取外部網頁內容（文件、API 說明、第三方資料）時，優先用 firecrawl MCP 工具，不用裸 WebFetch 硬爬。需先在環境變數設定 `FIRECRAWL_API_KEY`（見 `.mcp.json`）。

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

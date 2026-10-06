# App 改版：以 S3／S1 策略為主

2026-10-07。使用者要求「整個 App 改為以這個策略為主的風格」，選定做法 A（全面改，舊東西收進「舊策略（已停用）」）。
策略本身見 `docs/strategy-deploy-2026-10-06.md`；後端（帳本、真倉）已於 `460cbe6` 部署。

## 背景

改版前 App 的五個分頁（首頁／信號／紀錄／體檢／設定）全部圍繞舊的評分策略：首頁是自選幣清單＋瀏覽器端
跑舊策略分析迴圈，信號與紀錄是 Supabase `trades` 的推薦單，設定一半是舊策略參數。新策略只在「設定 → 診斷 →
策略帳戶」一頁。舊策略 2026-10-07 起停止開新倉，目前 0 筆持倉。

## 導覽與頁面

| 分頁 | 路徑 | 內容 |
|---|---|---|
| 首頁 | `/` | S3-A 真倉總覽 |
| 訊號 | `/signals` | S3／S1 訊號流（真倉 `s3a-live:signals` ＋ 三帳本 `s3s1:signals`） |
| 帳本 | `/ledgers` | 三個模擬帳戶並排＋文件 §9 回測基準 |
| 紀錄 | `/trades` | S3-A 真倉交易（成交、滑價、手續費、資金費、事件），可匯出 CSV |
| 設定 | `/settings` | 帳號、推播、資料管理、策略狀態；最下方「舊策略（已停用）」 |

- 舊頁面搬家：`/` → `/legacy`（自選幣與舊分析）、`/signals` → `/legacy/signals`、`/trades` → `/legacy/trades`。
  漏斗 `/funnel`、歸因 `/attribution`、體檢 `/health-check`、個幣分析 `/analysis/[symbol]` 路徑不變，入口移到「舊策略」區。
- `/strategies` 改成轉址到 `/ledgers`（舊書籤不壞）。
- 底部導覽的徽章：訊號＝今天新增的 S3-A 開倉數；紀錄＝S3-A 持倉數。舊 store 的未讀數不再顯示。
- 設定頁：舊策略專用的區塊（自動監控、帳戶資金、推薦單失效通知、最低信號強度、本地分析間隔、預設週期、監控幣種、
  診斷按鈕）移進可收合的「舊策略（已停用）」區；新增「策略」區（S3-A 模式、停用狀態、進場時間窗說明、月報指令）。

## 首頁（由上到下）

1. **狀態列**：live-runner 心跳（既有 `live-runner:heartbeat:<userId>`；> 2 分鐘＝紅色「沒在跑」）、
   模式（真下單／DRY RUN）、停用狀態。
2. **今天**：下次 S3 決策倒數（下一個 UTC 00:00:30）、BTC 條件、市場廣度（vs 0.93）、今天候選數／開倉數／擋掉數與理由。
   今天的 prep 快照不存在時顯示「今天的資料 UTC 00:05（台灣 08:05）後產生」。
3. **帳戶**：testnet 錢包權益、已實現損益、報酬、回撤；停用條件兩條進度（回撤 x/35%、連虧 x/7）。
4. **持倉卡**：幣、進場價、止損、+1R 止盈價、現價（App 既有的 `usePriceStore` 正式站價格）、浮動 R、
   已平 1/3、止損移動紀錄（`events`）。無持倉時提示「S3 一個月約 2 筆，沒單是常態」。
- 首頁不再跑舊策略的瀏覽器端分析迴圈。

## 資料

- 唯讀 API，一頁一支（彼此失敗不連累），Supabase JWT 驗證（比照現有）：
  - `/api/s3/overview`：`s3a-live:meta`、`s3a-live:pos`、今天的 `s3s1:prep:<X>`（只取 breadth／btcOk／s3 候選）、
    心跳、`s3a-live:signals` 前 50 筆中屬於今天的。
  - `/api/s3/signals`：`s3a-live:signals` 與 `s3s1:signals` 各前 300 筆。
  - `/api/s3/ledgers`：三帳本摘要、持倉、近期交易、擋單統計（即現有 `/api/strategies` 的帳本部分，之後刪掉 `/api/strategies`）。
  - `/api/s3/trades`：`s3a-live:done` 全部＋`s3a-live:pos`。
- live-runner 寫入 `s3a-live:meta`：`wallet`（錢包餘額）、`walletAt`、`mode`（`live`／`dry`）。
  每小時一次，加上每次進場／出場後一次。一次 HSET＝1 個 Redis 指令。
- 純函數（`src/lib/s3s1/view.ts`，有單元測試）：`nextDecisionAt(now)`、`haltProgress(meta)`、
  `unrealizedR(pos, price)`、`todaySummary(snapshot, signals, X)`。

## 錯誤處理

- 每張卡片各自處理載入失敗與空資料。
- API 讀不到 Redis 回 500 與理由；頁面顯示理由，不顯示假的 0。
- 心跳缺值視同「沒在跑」。

## 測試與驗證

- `view.ts` 純函數單元測試。
- `npx tsc --noEmit` → `npx vitest run` → `npx next build`。
- 本機 `npm run dev` 盡量預覽（登入需真實 session）。

## 不做

- 不加新的推播種類（S3-A 進出場推播已由 live-runner 發）。
- 不刪舊頁面與舊資料。
- 不改視覺主題（沿用深色主題與既有色票）。

# 像素辦公室頁 `/office` 設計

日期：2026-11-13
狀態：已確認，待寫實作計畫

## 目的

把系統現有的各個模組畫成一間像素風辦公室：每個模組是一位 Clawd 員工，狀態一眼可見；底部的 SQUAWK 跑馬燈顯示最近的訊號與擋單理由。靈感來自「7 個 Grok Bot 交易研究團隊」那篇貼文，但**沒有 LLM、不改任何交易邏輯**，只是換一種方式呈現既有資料。

LLM 模擬帳本已評估後放棄（2026-11-13，使用者決定）。

## 範圍

- 新頁 `/office`，純前端。
- 首頁「今天」卡片加一個「🏢 辦公室」入口。底部導覽不動。
- **不新增 API、不加 Redis 指令**：只用現有的 `/api/s3/overview`、`/api/s3/signals`、`/api/s3/ledgers`。頁面開著時每 60 秒重抓，跟首頁一樣。
- 不做：每日對帳（XCHECK）座位（要多一次 Redis 讀取，之後要再加）、LLM、音效。

## 座位（8 個）

| id | 標籤 | 對應模組 | 資料來源 | 狀態判斷 |
|---|---|---|---|---|
| chief | CHIEF | live-runner | `overview.heartbeatAt` | 心跳超過 `HEARTBEAT_STALE_MS` 或沒有 = 異常；有持倉 = 工作中；否則閒置 |
| scan | SCAN | prep 幣池快照 | `overview.snapshot` | 沒快照 = 異常（UTC 00:05 前顯示閒置，見下）；有快照 = 閒置，泡泡顯示廣度與 BTC 狀態 |
| s3a | S3-A | 真倉 A 腿 | `overview.positions`（有 A 腿）、`overview.signals`、`overview.meta` 停用 | 停用 = 異常；今天有 `decision='open'` = 慶祝；有持倉 = 工作中；否則閒置 |
| s3b | S3-B | 真倉 B 腿 | 同上，B 腿與 `b.` 前綴的 meta | 同上 |
| s1 | S1 | S1 帳本 | `ledgers.accounts` 中 key=`s1` | `halted` = 異常；最近 24 小時有開倉訊號 = 慶祝；`open > 0` = 工作中；否則閒置 |
| br | BR | BR 做空帳本 | `ledgers.accounts` 中 key=`br` | 同 S1 |
| ctrend | CTREND | CTREND 週帳本 | `ledgers.ctrend` | null 或 `stale` = 異常；有 `openWeek` = 工作中；否則閒置 |
| risk | RISK | 風控 | `overview.meta`（kill switch／停用）、`ledgers.accounts[].blocked`、今天被擋的真倉訊號 | kill switch 開 = 異常；今天有擋單 = 工作中（泡泡「擋下 N 筆」）；否則閒置 |

「今天」的定義跟首頁一致（UTC 日界，`view.ts` 的既有函數）。SCAN 在當日 UTC 00:05 前沒快照是正常的，顯示閒置不算異常。

實作時先讀既有的 `view.ts`（`haltProgress`、`todaySummary`、`regimeNote`）並重用，不另外重寫判斷。meta 的實際欄位名稱（kill switch、停用）以程式現況為準。

### 四種狀態 → 桌寵動畫

角色移植自使用者的桌寵 `~/.claude/desktop-pet/pet.py`（`draw_clawd` 等函數的格子座標）。

| 座位狀態 | 桌寵狀態 | 畫面 |
|---|---|---|
| `working` | running | 坐在鍵盤前打字，背後終端機滾動彩色程式碼行，眼睛看鍵盤 |
| `celebrate` | done | 雙手交替舉起，眼睛 `^ ^` |
| `alert` | ask | 紅色驚嘆號閃爍，單手揮動、腳踏步 |
| `idle` | none | 瞇眼，飄 zzz |
| `unknown`（API 失敗） | — | 灰階、頭上「？」 |

另外有隨機眨眼（間隔 2.5～5.5 秒），閒置時眼睛追滑鼠；觸控裝置改追最後點擊位置。

### 角色區分（配件）

身體顏色沿用桌寵 `#de8a6c`／`#c4704f`，BR 換成偏紫配色（做空）。配件：CHIEF 領帶（尺寸大一號、坐中間）、SCAN 望遠鏡、S3-A／S3-B 胸前名牌 A／B、S1 時鐘、CTREND 月曆、RISK 盾牌。

## SQUAWK 跑馬燈

合併 `overview.signals`（真倉）與 `signals.ledger`（帳本），依 `at` 由新到舊取 30 筆：

```
08:00  S3-A  BTCUSDT · 擋：<reason>
07:05  S1    SOLUSDT · 開倉 分數 3
```

時間用台灣時間 HH:mm。開倉顯示綠色，擋單顯示灰色並附 `reason`。標籤：真倉依 `legs` 標 S3-A／S3-B，帳本依 `acct`。

## 互動

點座位會打開詳細卡（bottom sheet），內容是該模組的幾個關鍵數字，加一個連到原頁面的連結：真倉 → `/`、訊號 → `/signals`、帳本／CTREND → `/ledgers`。

## 版面與畫面

- 背景是暖色像素木地板與桌子（參考貼文第一張圖），SQUAWK 是深色終端框（參考第五張圖）。
- 手機直式：CHIEF 在最上方置中，其餘 7 個排成 2 欄；寬螢幕排成 4 欄。頁寬沿用 App 的 `max-w-xl`。
- 角色是 SVG `<rect>`，用 `shape-rendering="crispEdges"`。
- 動畫：整頁共用一個時鐘（`requestAnimationFrame`，節流到 8fps），把 `t` 傳給所有角色；分頁隱藏（`document.hidden`）時暫停。尊重 `prefers-reduced-motion`：停在靜態影格。

## 程式切分

| 檔案 | 職責 |
|---|---|
| `src/lib/office/seats.ts` | 純函數 `buildSeats(overview, signals, ledgers, now)` 轉成 `Seat[]`，`buildSquawk(...)` 轉成 `SquawkLine[]`。所有判斷邏輯都在這裡。任一輸入為 null（API 失敗）時，相關座位回傳 `unknown` |
| `src/lib/office/seats.test.ts` | vitest：每個座位的四種狀態、API 失敗、SQUAWK 排序與截斷 |
| `src/components/office/Clawd.tsx` | 角色 SVG：props 為 `state`、`accessory`、`palette`、`t`、`look` |
| `src/components/office/PixelSeat.tsx` | 桌子＋角色＋泡泡＋狀態燈 |
| `src/components/office/Squawk.tsx` | 跑馬燈 |
| `src/components/office/useTick.ts` | 共用 8fps 時鐘 hook |
| `src/app/office/page.tsx` | 抓三支 API、排版、詳細卡 |
| `src/components/s3/HomeCards.tsx` | 「今天」卡片加入口連結 |

型別：`Seat = { id, label, state, bubble, details: {k: string, v: string}[], href }`。

## 錯誤處理

- 三支 API 各自獨立抓；失敗的那支以 null 傳入 `buildSeats`，對應座位顯示 `unknown`，其他照常。
- 未登入：跟其他頁一樣（API 回 401 → 既有的登入導向）。
- 全部失敗：辦公室照樣畫出來，全部是灰色問號，上方一行錯誤訊息。

## 測試與驗收

- `seats.test.ts` 涵蓋上面的狀態表。
- `npx tsc --noEmit`、`npx vitest run`、`npx next build` 全過。
- 本機預覽截圖給使用者看外觀，再調整。登入需要真實 Supabase session；如果卡住，就另做一個不登入、餵假資料的預覽方式（只在開發環境用，不進 production）。

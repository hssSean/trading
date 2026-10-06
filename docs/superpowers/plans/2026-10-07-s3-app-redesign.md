# App 改版（S3 為主）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 App 的五個分頁改成以 S3-A 真倉與 S3／S1 帳本為主，舊策略頁面收進 `/legacy` 與設定頁的「舊策略（已停用）」。

**Architecture:** 新頁面全部透過唯讀 API `/api/s3/*` 讀 Redis（`s3a-live:*`、`s3s1:*`、心跳），一頁一支。
畫面需要的計算抽成 `src/lib/s3s1/view.ts` 純函數並單元測試。live-runner 每小時把 testnet 錢包權益寫進
`s3a-live:meta`。舊頁面原封不動搬到 `/legacy/*`。

**Tech Stack:** Next.js 14 App Router、Zustand、Upstash Redis、Supabase JWT、Tailwind、vitest。

## Global Constraints

- 所有檔案 UTF-8；回覆與 UI 文字繁體中文。
- 視覺沿用深色主題與既有色票（`#0A0D11` 背景、`#0D0D16` 卡片、`#1B222B` 邊框、`text-accent`、`text-up`、`text-down`、`num` 字型 class）。
- 每支新 API：Supabase JWT 驗證（比照 `/api/reject-funnel`），`export const dynamic = 'force-dynamic'`，`maxDuration = 10`。
- Redis 指令要省：一支 API 用一次 `Promise.all` 批次讀；live-runner 寫錢包權益最多每小時一次（另加進出場後各一次）。
- 不刪舊頁面、不刪舊資料、不加新推播。
- 完成前：`npx tsc --noEmit` → `npx vitest run` → `npx next build` 三個都過。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/lib/s3s1/view.ts`（新） | 畫面計算純函數：`nextDecisionAt`、`haltProgress`、`unrealizedR`、`todaySummary`、`HEARTBEAT_STALE_MS` |
| `src/lib/s3s1/benchmarks.ts`（新） | 文件 §9 回測基準常數 |
| `src/lib/apiAuth.ts`（新） | `checkUserSession(req)`、`getRedisOrNull()` 給新 API 共用 |
| `src/app/api/s3/{overview,signals,ledgers,trades}/route.ts`（新） | 唯讀 API |
| `src/lib/s3s1/useS3Api.ts`（新） | 前端 hook：帶 JWT 打 `/api/s3/*`，回 `{data,error,loading,reload}` |
| `src/store/useS3Store.ts`（新） | 導覽徽章用：`todayOpens`、`openCount` |
| `src/components/s3/*.tsx`（新） | `StatusStrip`、`TodayCard`、`LiveAccountCard`、`LivePositionCard`、`LedgerCard`、`SignalRow`、`ui.tsx`（格式化與小元件） |
| `src/app/page.tsx`（改寫） | 首頁 |
| `src/app/signals/page.tsx`、`src/app/ledgers/page.tsx`、`src/app/trades/page.tsx`（新／改寫） | 三個分頁 |
| `src/app/legacy/{page,signals/page,trades/page}.tsx`（搬家） | 舊首頁、舊信號、舊紀錄原封不動 |
| `src/app/strategies/page.tsx` | 改成 `redirect('/ledgers')` |
| `src/components/BottomNav.tsx` | 新導覽與徽章 |
| `src/store/usePriceStore.ts`、`src/components/PriceFeed.tsx` | 新增 `extraSymbols`，讓 S3-A 持倉幣也有即時價 |
| `src/engine/s3aLive.ts` | 寫 `wallet`／`walletAt`／`mode` 到 `s3a-live:meta` |
| `src/app/settings/page.tsx` | 新「策略」區；舊策略區塊收進可收合區 |

---

### Task 1: 畫面計算純函數 `view.ts`

**Files:** Create `src/lib/s3s1/view.ts`、`tests/s3View.test.ts`

**Interfaces — Produces:**
```ts
export const HEARTBEAT_STALE_MS = 120_000;
export function nextDecisionAt(now: number): number;          // 下一個 UTC 00:00:30（now 剛好在 00:00:30 之前同一天則回當天）
export function haltProgress(meta: Record<string, unknown>): { ddPct: number; ddLimit: 35; streak: number; streakLimit: 7; halted: string | null };
export function unrealizedR(p: { entry: number; stop0: number; qty0: number; partial: boolean; tpQty: number }, price: number): number | null;
export interface TodaySummary { X: number; ready: boolean; btcOk: boolean | null; breadth: number | null; candidates: number; opened: string[]; blocked: { symbol: string; reason: string }[] }
export function todaySummary(snap: { X: number; breadth: number; btcOk: Record<string, boolean>; s3: { symbol: string }[] } | null, signals: { symbol: string; signalDay: number; decision: 'open' | 'skip'; reason?: string }[], now: number): TodaySummary;
```
`unrealizedR`：已平 1/3 時 = (1/3 × 1R 已實現) + (剩餘 2/3 × (price−entry)/(entry−stop0))，以 qty 比例計算；未平時 = (price−entry)/(entry−stop0)；price ≤ 0 回 null。
`haltProgress` 的 ddPct 與 `stats.summarizeLive` 同口徑：`(peakRealized − realized) / (baseEquity + peakRealized) × 100`。

- [ ] Step 1：寫測試（倒數跨日、00:00:10 回當天 00:00:30、ddPct 計算、unrealizedR 兩種情況與 price=0、todaySummary 快照缺／有、只算 signalDay = X−1 的訊號）。
- [ ] Step 2：`npx vitest run tests/s3View.test.ts` 確認失敗。
- [ ] Step 3：實作。
- [ ] Step 4：測試通過。
- [ ] Step 5：commit `feat: S3 畫面計算純函數（倒數、停用進度、浮動 R、今日彙整）`。

### Task 2: live-runner 寫錢包權益與模式

**Files:** Modify `src/engine/s3aLive.ts`

- [ ] 在 `runS3aLive` 開頭（讀完 meta 後）：若 `now − Number(meta.walletAt ?? 0) ≥ 3_600_000`，或本輪有進場／出場，則 `getBalance()` 取 USDT `balance`，`store.hset('s3a-live:meta', { wallet, walletAt: String(now), mode: ctx.dryRun ? 'dry' : 'live' })`。dryRun 也寫（`s3a-dryrun` 用的是記憶體 Overlay，不會寫到線上）。失敗只記 log。
- [ ] 目前「沒有持倉也不是每日時段就 return」的早退要放在寫錢包之後，否則沒持倉時永遠不更新。
- [ ] `npx tsc --noEmit`、`npx vitest run tests/s3aLive.test.ts`；commit `feat: S3-A 每小時寫入 testnet 錢包權益與模式`。

### Task 3: 唯讀 API `/api/s3/*`

**Files:** Create `src/lib/apiAuth.ts`、`src/app/api/s3/overview/route.ts`、`signals/route.ts`、`ledgers/route.ts`、`trades/route.ts`；Delete `src/app/api/strategies/route.ts`

- overview：`hgetall s3a-live:meta`、`hgetall s3a-live:pos`、`get s3s1:prep:<X>`、`get live-runner:heartbeat:<TRADING_USER_ID>`、`lrange s3a-live:signals 0 49`。回 `{ ok, now, meta, positions, snapshot: {X, breadth, btcOk, s3:[{symbol}]} | null, heartbeatAt, signals }`。`TRADING_USER_ID` 沒設時改用登入者的 user id。
- signals：`lrange s3a-live:signals 0 299`、`lrange s3s1:signals 0 299` → `{ ok, live, ledger }`。
- ledgers：現有 `/api/strategies` 的帳本部分（accounts、trackStart、lastRun）。
- trades：`hgetall s3a-live:done`、`hgetall s3a-live:pos`、`hgetall s3a-live:meta` → `{ ok, open, done, summary: summarizeLive(...) }`。
- [ ] 實作、`tsc`；commit `feat: /api/s3/* 唯讀 API`。

### Task 4: 前端基礎（hook、徽章 store、價格源、共用元件）

**Files:** Create `src/lib/s3s1/useS3Api.ts`、`src/store/useS3Store.ts`、`src/components/s3/ui.tsx`；Modify `src/store/usePriceStore.ts`、`src/components/PriceFeed.tsx`

- `useS3Api<T>(path: string, intervalMs?: number)`：用 `supabase.auth.getSession()` 取 JWT，fetch，回 `{ data: T | null, error: string, loading: boolean, reload: () => void }`；有 interval 時頁面可見才輪詢。
- `useS3Store`：`{ todayOpens: number; openCount: number; set(p) }`（不 persist）。
- `usePriceStore` 加 `extraSymbols: string[]`、`setExtraSymbols(s: string[])`；`PriceFeed.trackedSymbols()` 併入。
- `ui.tsx`：`fmtR`、`fmtPct`、`fmtPx`、`fmtD`、`fmtT`、`color`、`coin`、`Card`、`Stat`、`Row`、`Empty`、`ErrorBox`、`PageHeader`（從現有 `/strategies` 頁抽出）。
- [ ] 實作、`tsc`；commit。

### Task 5: 舊頁面搬家＋新導覽

**Files:** `git mv src/app/page.tsx src/app/legacy/page.tsx`、`src/app/signals/page.tsx → src/app/legacy/signals/page.tsx`、`src/app/trades/page.tsx → src/app/legacy/trades/page.tsx`；Modify `src/components/BottomNav.tsx`；`src/app/strategies/page.tsx` → `redirect('/ledgers')`

- 導覽：首頁 `/`（Home）、訊號 `/signals`（Radar）、帳本 `/ledgers`（BookOpen）、紀錄 `/trades`（ClipboardList）、設定 `/settings`（Settings）。徽章：訊號＝`todayOpens`、紀錄＝`openCount`。首頁 active 判斷改成 `pathname === '/'`；`/legacy*`、`/analysis*`、`/funnel`、`/attribution`、`/health-check` 歸設定。
- 舊頁面標題加「（舊策略）」小字，並加「返回設定」按鈕。

### Task 6: 首頁

**Files:** Rewrite `src/app/page.tsx`；Create `src/components/s3/StatusStrip.tsx`、`TodayCard.tsx`、`LiveAccountCard.tsx`、`LivePositionCard.tsx`

- 每 30 秒 `useS3Api('/api/s3/overview', 30_000)`；倒數每秒更新（本地 state）。
- 寫 `useS3Store`（todayOpens = summary.opened.length、openCount = positions.length）與 `setExtraSymbols(positions.map(p=>p.symbol))`。
- 依設計文件「首頁」四段實作；空狀態與錯誤各自處理。

### Task 7: 訊號、帳本、紀錄頁

- `/signals`：篩選 `全部｜真倉 S3-A｜帳本 S3-A｜S3-B｜S1` 與 `全部｜開倉｜擋掉`；列出時間、幣、收盤、止損、分數三分項、決策與理由；上方擋單理由統計（`reasonKey`）。
- `/ledgers`：三個 `LedgerCard`（由現有 `/strategies` 的 `AcctCard` 搬出）＋每張顯示 §9 基準（`benchmarks.ts`）。
- `/trades`：S3-A 真倉持倉＋已平倉列表（進出場、R、淨損益、手續費、資金費、滑價 bp、事件時間軸可展開），「匯出 CSV」按鈕（前端產生、UTF-8 BOM）。
- 刪除 `src/app/strategies` 的舊內容（已改轉址）。

### Task 8: 設定頁

- 最上方新「策略」區：S3-A 模式、停用狀態、進場時間窗（台灣 08:00–10:00）、每筆 4%、上限說明、月報指令。
- 「帳號」「推播」「雲端同步」「資料管理」保留在外。
- 其餘舊區塊（自動監控設定、帳戶資金、推薦單失效通知、最低信號強度、本地分析間隔、預設週期、監控幣種、診斷）收進 `<details>`「舊策略（已停用）」，並加舊首頁／舊信號／舊紀錄／體檢入口。

### Task 9: 文件、驗證、push

- CLAUDE.md：App 分頁與 `/legacy`、新 API、`s3a-live:meta` 新欄位。
- `npx tsc --noEmit` → `npx vitest run` → `npx next build`；`npm run dev` 盡量預覽。
- commit、`git push origin main`。

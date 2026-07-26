# Crypto Trader — 系統架構文件

> 最後更新：2026-07-26
> 這份文件描述系統「現在實際是什麼樣子」，不是規劃書。改動程式後請同步更新。
> 策略規格的權威來源是《加密貨幣合約推薦單系統-策略規格書-v2.1.md》（使用者 Downloads），
> 本文只記錄實作現況與規格的落差。

---

## 1. 這是什麼

加密貨幣永續合約**訊號推薦**系統。掃描幣安成交量前 15 名，用技術分析產生進場建議，
推播給使用者。**系統只產生推薦單，不自動下單**——所有下單由使用者手動執行。

- 前端：Next.js 14 App Router PWA
- 部署：Vercel（新加坡 sin1）— 專案名 `tradding_app`，網域 `traddingapp-nu.vercel.app`
- 觸發：外部 cron（UptimeRobot）每 5 分鐘打 `/api/analyze`
- 資料庫：Supabase PostgreSQL
- 快取/狀態：Upstash Redis
- 行情：Binance Futures 公開 REST API（免金鑰）
- 推播：Web Push（主要）／LINE（**已棄用**，月配額用完，程式碼保留未維護）

> ⚠️ Vercel 專案有兩個並存：`tradding_app`（**正在跑的**）與 `trading`（廢棄部署）。
> 查 log 要認明 `traddingapp-nu.vercel.app` 這個 host。

---

## 2. 資料流

```
外部 cron（每 5 分鐘）
   │
   ▼
GET /api/analyze ──────────────────────────────────────────┐
   │                                                        │
   ├─ [A] monitorActiveTrades()  持倉監控（先跑）            │
   │     ├─ Phase 1：waiting 單 → 掃 K 線判成交 / 取消      │
   │     └─ Phase 2：active 單 → 掃 K 線判 TP/SL / 移動止損 │
   │                                                        │
   └─ [B] 掃描迴圈  for symbol of coins（成交量前 15）       │
         ├─ 4H ADX → regime（trending / ranging / transitional）
         ├─ regime 分派：A 策略（多時框趨勢）/ B 策略（均值回歸）
         ├─ 風控關卡鏈（見 §5）
         ├─ 通過 → insert trades + 推播 + 上鎖
         └─ 被擋 → 寫入 reject_funnel + 影子模擬
```

**客戶端**（瀏覽器）獨立於上述流程：

```
StoreHydration（每 2 分鐘 + 事件觸發）
   ├─ loadFromSupabase()      下載 DB 狀態
   ├─ reconcileFromServer()   打 /api/trade-status 取權威 status（service role）
   ├─ reconcileIncorrectlyActiveTrades()  價格回補判定（僅本地顯示修正，不寫 DB）
   └─ saveToSupabase()        上傳（每 ≤4 秒 debounce）

首頁 pickupPending（每 15 秒）
   └─ POST /api/analyze → 撿 Redis 的 pending_signals → 觸發 loadFromSupabase
```

---

## 3. 檔案地圖

| 路徑 | 職責 |
|---|---|
| `src/app/api/analyze/route.ts` | **核心**（~2200 行）。掃描主流程 + 持倉監控 + 風控 + 推播 + 影子模擬 |
| `src/analysis/signals.ts` | v2.1 分組計分、雙層門檻、策略 A/B 訊號產生 |
| `src/analysis/indicators.ts` | EMA/RSI/MACD/ADX/BB/Donchian。`computeIndicators` 附帶前一根值 |
| `src/analysis/smc.ts` / `snr.ts` | Smart Money Concepts（OB/FVG/BOS/ChoCH）／支撐阻力 |
| `src/lib/position.ts` | 倉位計畫（倉位/本金/槓桿）+ `tierRiskMultiplier`。**前後端共用，勿另寫倉位公式** |
| `src/lib/tradeSync.ts` | 客戶端同步決策純函數（`resolveServerOutcome` 等）。有測試 |
| `src/lib/monitorMath.ts` | 監控迴圈抽出的純數值邏輯（`clampAutoCloseAfterTp1`）。有測試 |
| `src/components/StoreHydration.tsx` | 客戶端同步層（~900 行）。所有 client↔DB 的協調都在這 |
| `src/store/useStore.ts` | Zustand + localStorage persist |
| `src/api/binance.ts` | Binance 公開 API client（**無認證，只讀行情**） |
| `src/lib/antigambling/` | 績效體檢統計引擎（移植自 mars-tw/anti-gambling-trader-tw，MIT） |

### API 路由

| 路由 | 用途 |
|---|---|
| `GET /api/analyze` | 主掃描（cron 打這個）。`?secret=` 或 `x-webhook-secret` |
| `POST /api/analyze` | 回傳 pending_signals 給客戶端撿 |
| `DELETE /api/analyze` | 解除所有幣種鎖定 |
| `POST /api/trade-status` | 用 service role 讀 status/signal_price/current_stop（客戶端讀不到這些欄位） |
| `GET /api/scan-status` | 最近一次掃描的逐幣摘要 |
| `GET /api/reject-funnel?days=N` | 拒絕漏斗聚合 + 影子模擬淨 R |
| `POST /api/reset` | 全清（交易 + Redis），跨裝置同步 |
| `POST /api/push-subscribe` / `push-test` | Web Push 訂閱管理 |

---

## 4. 訂單生命週期（狀態機）

```
訊號通過關卡
   │
   ├─ isLimitOrder = |entry − signalPrice| / signalPrice > 0.3%
   │
   ├─ 是 → status='waiting'  （掛限價單）
   │        │
   │        ├─ K 線觸及 entry ────────────────► status='active', filled_at 寫入
   │        │
   │        └─ 取消四路徑（Phase 1）：
   │             ├─ 結構突破（收盤越過 SL）      → thesis_invalidated（不保留 bias）
   │             ├─ 行情走遠（≥1R，錨定 signal_price）→ opportunity_expired
   │             ├─ TP1 直達                      → opportunity_expired
   │             └─ 逾期 4 根該時框 K 線          → opportunity_expired
   │             取消 = DELETE 該列 + unlockSymbol + （opportunity_expired 時）setBiasHold 12 根
   │
   └─ 否 → status='active'（市價入場）
            │
            ├─ 觸及 TP2 ──────────────► result='WIN_TP2', closed_at
            ├─ 觸及 TP1 ──────────────► result='WIN_TP1', status='tp1_hit', closed_at=NULL
            │                            └─ 啟動 2×ATR 移動止損，**地板 = entry（保本）**
            │                               ├─ 觸及移動止損 → result='WIN_TP1', closed_at
            │                               └─ 24h 到期    → 出場價夾在地板以上（clampAutoCloseAfterTp1）
            ├─ 觸及原始 SL ───────────► result='LOSS'（未達 TP1）
            ├─ 時間止損（8 根 K 線停滯 ±0.3R，**未達 TP1 才適用**）→ result='MANUAL_CLOSE'
            └─ 24h 自動平倉 ──────────► result='MANUAL_CLOSE'
```

### status 欄位語意

| status | 意義 |
|---|---|
| `waiting` | 限價單掛著，未成交 |
| `active` | 已成交，監控 TP/SL 中 |
| `tp1_hit` | TP1 已達標，`closed_at=NULL` 代表仍在等 TP2 |
| `NULL` | **異常**。insert fallback 剝掉 status 時發生。已改為併入 waiting 池處理 |

`closed_at` 是**關單的唯一權威**。有值 = 真的結束；`result` 有值但 `closed_at=NULL` = TP1 等 TP2 中。

---

## 5. 風控關卡鏈（依序檢查，先中先擋）

程式順序見 `route.ts` 的 skipKey 判斷鏈。

| 關卡 | gate id | 說明 |
|---|---|---|
| 事件過濾 | `event_filter` | 重大事件 ±30 分鐘 |
| 當日熔斷 | `circuit_breaker` | 當日累計帳戶虧損 ≤ −3% 或連續 3 虧 |
| 總風險上限 | `total_risk_cap` | `MAX_TOTAL_RISK_PCT = 5%` ⚠️ **死碼，見 §8** |
| 持倉鎖定 | `locked` | 該幣已有未平倉單 |
| 同 4H 蠟燭 | `same_candle` | 同一根 4H K 線內同方向不重複 |
| 冷卻中 | `cooldown` | 同幣 2 小時內不重複發訊號 |
| 多框架未確認 | `confluence` | ≥2 時框同向，或進場時框與 4H EMA200 bias 一致 |
| BTC 逆向 | `btc_direction` | BTC 偏多擋山寨空 / 偏空擋山寨多（**A、B 策略皆適用**） |
| BTC 急漲跌暫停 | `btc_pause` | BTC 1H 波動 >2.5×ATR → 暫停 2 小時 |
| 反向 bias 保留 | `bias_hold` | 掛單逾期取消後，12 根 K 線內禁反向 |
| 同向風險上限 | `same_dir_cap` | 見下方 |
| 止損後冷卻 | `loss_cooldown` | 同幣同向 24 小時（時間止損則為 4 小時） |
| 分數/組數未達 | `score_gate` | A 級 ≥65 分、B 級 55-64；策略 B 門檻 13 |

### 同向風險上限（`checkSameDirectionRisk`）

```
每筆風險貢獻 = acctRiskPct × tierRiskMultiplier(symbol, tier)

tierRiskMultiplier：
  BTC/ETH  A 級 → 1.0        B 級 → 0.5
  山寨      任何級別 → min(base, ALT_SLOT_RISK=0.33)

上限：同向合計 ≤ 2.0%；山寨桶同向 ≤ 1.0%
```

> ⚠️ **重要副作用**：使用者目前 `riskPctPerTrade = 3%`，代入後
> - BTC/ETH A 級貢獻 3.0% > 2.0% → **完全開不了單**
> - BTC/ETH B 級 1.5% → 同向最多 1 張
> - 山寨 0.99%，桶上限 1.0% → **同向也只能 1 張**（slot 制的 3 個位子實際只用得到 1 個）
>
> 如果發現訊號大量被擋，原因在這裡。

---

## 6. 關鍵常數

| 常數 | 值 | 位置 |
|---|---|---|
| 掃描幣種數 | 15 | `getDefaultCoins()` — 曾為 20，因 Vercel CPU 超額改回 |
| `STRONG_THRESHOLD` | 65（A 級） | A 策略通知門檻 |
| `STRONG_THRESHOLD_B` | 13 | B 策略門檻 |
| `COOLDOWN_MS` | 2 小時 | 同幣訊號冷卻 |
| `LOCK_TTL_SEC` | 24 小時 | 幣種鎖 TTL |
| `LOSS_COOLDOWN_SEC` | 24 小時 | 止損後冷卻（時間止損為 4 小時） |
| `WAITING_EXPIRY_BARS` | 4 | 掛單有效期（該時框 K 線根數） |
| `BIAS_HOLD_BARS` | 12 | opportunity_expired 後的反向封鎖 |
| `INTRADAY_CLOSE_HOURS` | 24 | 自動平倉（4h 時框 72h、1d 時框 168h） |
| 時間止損 | 8 根 / ±0.3R | 未達 TP1 的停滯單 |
| `MAX_TOTAL_RISK_PCT` | 5% | ⚠️ 死碼 |
| `ALT_SLOT_RISK` | 0.33 | 山寨桶每檔風險貢獻上限 |
| `HIGH_VOLIT_PCT` | 3% | ATR 超過 → 扣 3 分 |
| `B_TIER_MAX_ATR` | 4.5% | B 級單 ATR 上限 |
| ATR 硬門檻 | 6% | 超過完全不發訊號 |

---

## 7. 鐵則（違反會出事，都是踩過坑換來的）

1. **成交是單向閂鎖** — 客戶端絕不可把 `active`/`tp1_hit` 退回 `waiting`。未成交的限價單由伺服器
   走 `result` 取消，不是退回 waiting。

2. **伺服器擁有監控單的關單** — 客戶端絕不可為 `closedAt=undefined` 的單寫 `closed_at`。
   `saveToSupabase` 因此拆成 open（省略 closed_at/result）與 finalized 兩組**互斥欄位**的 upsert；
   單一 bulk upsert 會 union key 重新引入 null 覆蓋。

3. **成交判定要有時間錨** — 掃 K 線判成交必須過濾 `openTime >= opened_at`（Phase 2 用
   `filled_at ?? opened_at`）。少了這道就會把掛單前的價格算成成交（幽靈成交）。
   客戶端的 `reconcileIncorrectlyActiveTrades` 也要有同一道。

4. **損益一律用 R 倍數**（損益% ÷ 止損距離%）與帳戶實際損益衡量，不用原始價格 %。
   ATR 止損的原始 % 會嚴重誤導（熔斷曾因此誤鎖整天）。

5. **純數值邏輯必須抽成獨立檔配單元測試** — `tsc` 跟 `next build` 對數值錯誤完全是瞎的。
   `tradeSync.ts`、`monitorMath.ts` 都是這樣抽出來的。
   注意 `route.ts` 有 Next.js/Redis/Supabase 的 top-level import，**直接被 vitest 匯入會炸**。

6. **容量關卡的影子模擬 netR 不能拿來調參** — `same_dir_cap`/`total_risk_cap`/`locked`
   擋的訊號高度相關（同方向同時間窗），netR>0 是結構必然，不代表該放寬。
   只有品質關卡（`confluence`/`btc_direction`/`score_gate`）的 netR 有意義。

7. **調參紀律（規格書 §4）** — 一次只動一個濾網，先看拒絕漏斗與影子模擬的淨 R 再決定。
   淨 R ≤ 0 的關卡代表擋得對，不要動。

8. **Redis 指令要省** — 批次讀寫（hgetall、單次 lpush 多值），避免迴圈內逐鍵操作。

9. **CPU 要省** — 外部 cron 頻率不可控，只能砍每次呼叫的計算量。只算需要的指標
   （只要 ADX 就別跑 `computeIndicators`）。

10. **所有檔案 UTF-8**，寫檔明確指定 `encoding='utf-8'`（Windows CP950 會導致亂碼/閃退）。

---

## 8. 已知問題與限制

| 問題 | 影響 | 狀態 |
|---|---|---|
| `MAX_TOTAL_RISK_PCT=5` 是死碼 | 同向 2% × 兩方向 = 4% 結構天花板，5% 永遠觸不到 | 未修，需重設預算分配 |
| 名額分配先到先得 | 掃描按成交量排名跑，先觸發先佔位，非按分數擇優 | 未修，需改掃描架構 |
| insert 兩段式 fallback 會剝掉 status | 觸發時該單 status=NULL，對伺服器隱形 | 已加防呆（NULL 併入 waiting），**但原始觸發原因未查明**（Vercel Hobby log 只留 ~50 分鐘） |
| `score_gate` 無影子模擬 | 唯一沒有量測數據的品質關卡 | 未做（sub-threshold 訊號沒有價位可模擬） |
| funding-crowding 只扣 confidence | 規格 §4.2 要求扣分數 | 刻意偏離，未驗證前不收緊 |
| 限價單被暴力突破 | fill-on-touch 會成交然後止損，而非取消 | 開放設計題 |
| 本機預覽需真實登入 | placeholder 環境會卡在 spinner（supabase-js getSession 無限迴圈） | 純函數改用 vitest 驗證 |
| Vercel Fluid Active CPU | 曾超額（4h46s / 4h，30 天滾動視窗） | 已砍幣種數至 15，觀察中 |

---

## 9. 資料模型

### `trades` 表（Supabase）

```
id, user_id, signal_id, symbol, direction, timeframe, strength, score,
entry, stop_loss, tp1, tp2, reasons, entry_notes,
opened_at, filled_at, closed_at, last_monitored_at,
status, result, exit_price, pnl_percent,
current_stop, trailing_stop_active,
strategy, regime, confidence, funding_rate, signal_price,
suggested_risk_pct, suggested_leverage, tier, score_breakdown,
entry_chart_url, exit_chart_url
```

> insert 對 `42703`/`PGRST204` 有**兩段式 fallback**：
> 第一段剝 v2.1 欄位（tier、score_breakdown），第二段剝到 base。
> 新增欄位時要同步更新 fallback 剝除清單，並提醒使用者跑 `ALTER TABLE`。

其他表：`profiles`（含 settings JSONB）、`watchlist`、`push_subscriptions`

### Redis keys

| key | 用途 |
|---|---|
| `tlock:{symbol}` | 幣種訊號鎖（24h TTL） |
| `loss_cd:{symbol}:{dir}` | 止損後冷卻 |
| `bias_hold:{symbol}:{dir}` | 掛單取消後的方向保留 |
| `btc_pause:LONG` / `:SHORT` | BTC 急漲跌暫停 |
| `circuit_breaker_v2:` | 當日熔斷 |
| `adx_states` | ADX 遲滯狀態（hash） |
| `reject_funnel` | 拒絕漏斗（list，14 天） |
| `shadow_trades` | 影子交易模擬（hash，上限 300） |
| `last_scan` | 最近掃描摘要 |
| `pending_signals` | 待客戶端撿的訊號 |
| `scan-run-lock` / `monitor-run-lock` | 併發保護（SET NX） |

---

## 10. 開發與部署

```bash
npm run dev            # 本機開發（localhost:3000）
npx tsc --noEmit       # 型別檢查（改完程式必跑）
npm test               # vitest（44 個測試）
npx next build         # production build（push 前最後檢查）
```

**流程**：改程式 → `tsc` → `vitest` → `next build` → commit → `git push origin main`
→ Vercel 自動部署（1-2 分鐘）

使用者已授權直接 push main；破壞性操作（force push、改歷史）仍須先確認。

### 環境變數（Vercel）

```
WEBHOOK_SECRET, CRON_SECRET
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
ANALYSIS_TIMEFRAMES（預設 5m,15m,1h）, MIN_SCORE
SUPABASE_PROFILE_ID（可選，繞過 line_user_id 查找）
LINE_CHANNEL_TOKEN, LINE_USER_ID（已棄用）
```

### 測試

```
tests/tradeSync.test.ts       客戶端同步決策（14）
tests/autoCloseFloor.test.ts  TP1 後到期平倉地板（6）
tests/antigambling/           統計引擎 golden file 對拍（24）
```

---

## 11. UI 設計系統（終端機風格）

深色終端／看盤風。**扁平硬邊，不用發光或色塊底**。

```css
--bg: #0A0D11        --surface: #0F141A     --surface-2: #141A21
--hair: #1B222B      --hair-faint: #141A21
--t1: #EAEDF2        --t2: #97A2B0          --t3: #59616E
--accent: #2DD4BF    --up: #0ECB81          --down: #F6465D
```

規則：
- 主色薄荷青 `#2DD4BF` **只用在功能性強調**（評分、主按鈕、選中分頁），**絕不用在漲跌**
- 漲跌語意色只用於價格方向
- 數字一律加 `.num`（等寬 tabular）
- 微標用 `.tlabel`（uppercase、10px、字距）
- 圓角只用 `rounded` / `rounded-md`（全站 `rounded-2xl`/`3xl` 已清零）
- 不用裝飾性 emoji（推播訊息內的 emoji 不在此限）

共用類別：`.card` `.btn-primary` `.chip` `.chip-active` `.input-field` `.tlabel` `.num`

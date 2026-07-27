# 待辦清單

> 最後更新：2026-07-28
> 排序依「該不該現在做」，不是依技術難度。
> 標 🔬 的是**樣本不足**，動了也分不出是改對還是雜訊——刻意不做。

---

## 已完成（2026-07-28 這輪）

P1 兩項全部做完（`bc088aa`）：

| 內容 |
|---|
| **時間止損影子模擬**：被「8根K線停滯」或「24-168h到期」強制關掉的單（僅未達TP1的），繼續模擬到真正TP/SL，算模擬淨R vs 真實出場淨R。`src/lib/monitorMath.ts` 抽出共用 `walkTpSl`，新增 `src/lib/timeStopShadow.ts`，`/api/reject-funnel` 回傳 `timeStopStats`，21個測試 |
| **漏斗容量/品質關卡分區顯示**：`ScanStatusPanel.tsx` 不再混排，容量關卡（same_dir_cap/total_risk_cap/locked）獨立成區塊，同區顯示時間止損模擬統計 |

**下一步**：先讓伺服器跑一週累積時間止損樣本，展開漏斗面板看 `timeStopStats`，
再決定 8 根 K 線的停滯門檻該不該放寬（見下方 P1 #1 原始說明，決策原則不變）。

## 已完成（2026-07-27 這輪）

殭屍單復活、通知靜音、user_id 安全、LINE 拔除全量修正（詳細診斷過程見
`待修改事項.md`）；另外查出並修掉兩個新問題：

| commit | 內容 |
|---|---|
| `52ab0ab` | 推薦單一出現就顯示持倉中——client 端讀不到 status 欄位時不再捏造 'active' |
| `966b8e8` | 移除手動新增交易功能（未使用），連帶消除其逾期誤刪風險 |
| `5aaf29e` | 待修改事項.md 全量修正：殭屍單復活(P0-1)、通知靜音(P0-2)、user_id 安全(P1-1)、opened_at 覆寫(P1-2)、SignalCard 建單路徑(P1-3)、webhook fail-open(P2-1)、刪除重試佇列(P2-2)、LINE 全拔除(P2-3)、build 版本顯示(P2-4) |
| `6c311cf` | 「等待進場」看不到掛單——status=NULL 的列客戶端未比照 waiting；**順帶查明本清單 #3「insert fallback 原因」**：DB 缺 strategy/regime/confidence/funding_rate/suggested_risk_pct/suggested_leverage 欄位，insert 掉進最深層 fallback，把 status/signal_price 一併剝掉，且該分支成功時完全沒有 log。已補 `console.error`，並提供 `ALTER TABLE` 給使用者跑（已跑完） |
| `55c5bc4` | 監控幣種移除後原地復活——`removeCoin` 只刪本地，DB watchlist 列從未刪除 |
| `5106df4` | 市價單不再連發兩則推播——移除重複的「市場入場」確認訊息（LINE 時代遺留） |
| — | cron-job.org 排程被停用超過一週（非程式問題），已在使用者授權下重新啟用 |

## 已完成（2026-07-26 這輪）

| commit | 內容 |
|---|---|
| `eba55cd` | 客戶端幽靈成交（缺時間錨）+ 移除客戶端寫回 DB 的權力 |
| `ecc40e6` | `status=NULL` 的單改歸 waiting 池，不再誤當 active 監控 |
| `c58f713` | 同向風險閘門改乘實際 `riskPctPerTrade`，不再假設恆為 1% |
| `b3a69e9` | 統一山寨 slot 記帳與實際下單風險（`tierRiskMultiplier`） |
| `3049bc9` | 拒絕漏斗容量關卡不再顯示品質判詞 |
| `be1e896` | 掃描幣種 20→15，解 Vercel CPU 超額 |
| `8b696ad` | Phase 2B-3 settings/health-check/error 頁終端化（全站舊圓角清零） |
| `da30df1` | TP1 達標後 24h 到期平倉繞過保本地板 |
| — | 手動 SQL 清理 ZEC/HYPE 兩張污染單 |

---

## P1 — 值得做，隨時可動

### ~~1. 時間止損的影子模擬~~ ✅ 已完成（`bc088aa`，2026-07-28）
**為什麼**：62.5%（15/24）的單走時間止損出場，平均 +0.244R。但**完全沒有數據能回答
「如果不砍會怎樣」**——可能砍掉了正在醞釀的贏家。這是目前最大的量測盲區。

**做了什麼**：被時間止損平掉的單（僅未達TP1的）存進 Redis（`time_stop_shadows`），
繼續往後模擬到真正的 TP/SL，算淨 R，`/api/reject-funnel` 回傳、`ScanStatusPanel` 顯示。

**仍要等數據**：現在只是把量測管道建好，**還沒有樣本**。有數據才知道 8 根 K 線該不
該放寬。**沒這個數據就別動時間止損參數**——這條紀律不變，只是現在終於有辦法產生數據了。

### ~~2. 漏斗容量／品質關卡分區排版~~ ✅ 已完成（`bc088aa`，2026-07-28）
`3049bc9` 只改了判詞，原提案的「容量關卡與品質關卡分開顯示」現在做了——
`ScanStatusPanel.tsx` 拆成兩個標頭區塊，容量關卡的 netR 不會再跟品質關卡混排。

### ~~3. 查明 insert fallback 被觸發的原因~~ ✅ 已查明並修復（`6c311cf`，2026-07-27）
根因：DB 缺 `strategy/regime/confidence/funding_rate/suggested_risk_pct/suggested_leverage`
六個 v2.1 欄位，insert 掉進最深層 fallback，把 `status`/`signal_price` 一併剝掉，
且該分支成功時完全沒有 log——已無聲觸發好幾週。

已補：fallback 成功時改 `console.error` 印出原始錯誤；使用者已在 Supabase 跑
`ALTER TABLE` 補齊六個欄位，新單 `signal_price` 已驗證正常寫入（見 `5106df4` 附帶驗證）。

---

## P2 — 要先討論設計才能動

### 4. `MAX_TOTAL_RISK_PCT = 5` 是死碼
同向上限 2% × 兩方向 = 4% 結構天花板，5% 永遠觸不到。
要修得重新設計預算分配，不是改個數字。**2026-07-28 決定：先跳過**，不動。

### ~~5. 名額分配先到先得，非擇優~~ ✅ 已完成（`c1b46f6`，2026-07-28）
`for (const symbol of coins)` 按成交量排名跑，先觸發的幣拿走名額；
分數排序只發生在單一幣種內部。稀缺資源用抵達順序分配是最差的規則。

已改成兩階段：pass 1 掃描迴圈跑完整分析、收集所有合格候選（過每個幣種自己
的狀態關卡）；pass 2 依分數降冪排序後才依序判定同向上限、insert、推播——
分數高的候選先選，不再是掃描順序（成交量排名）先到先得。詳見 commit 訊息。

驗證：tsc/vitest(234)/build 全過；部署後手動觸發過一次，正常回應（實際
same_dir_cap/insert 路徑要等真的有多個候選同時競爭同向額度時才會被走到，
目前線上還沒遇到這種情況，邏輯本身已逐行核對與原本一致，只是換了執行時機）。

### 6. `isLimitOrder` 門檻 0.3% 可能過窄
對波動大的山寨，有些回測單會落進這個範圍被當市價單直接入場。
**2026-07-28 決定：先不調**，比照調參紀律，沒有影子模擬數據前不動參數。

### 7. `score_gate` 無影子模擬
漏斗 9%，是品質關卡裡唯一的量測盲區。
難點：sub-threshold 訊號沒有進場/止損價位可模擬，要先生成才能模擬。
**2026-07-28 決定：先跳過**——要改訊號產生函式加不受分數門檻限制的計算路徑，
牽動策略核心計分邏輯，風險與工作量都高於其他三項，不建議現在一起衝。

---

## 🔬 樣本不足，先觀察不要動

### 8. B 級輕倉（55-64 分）期望值可能是負的
07-26 覆盤：B 級 10 筆合計 +2.61R，但 **LTC 一筆就貢獻 +3.50R**，
扣掉之後 9 筆 = −0.89R（每筆 −0.10R）。同期 A 級 11 筆 = +0.49R/筆。

分層確實有預測力，但 B 級靠一筆運氣撐著。
**再跑一週如果還是這樣**，考慮把門檻從 55 提到 58-60。現在動樣本太小。

### 9. 策略 B 止損距離窄到噪音等級
三筆止損距離：SOL **0.43%**、PEPE 0.81%、SUI 1.01%。1h 圖上 0.43% 就是雜訊，必被掃掉。
三筆合計 −2.01R。

但 `1359cc8`（07-24）加了 `volRatio>=1.3` 硬門檻後**至今沒再出過策略 B 單**，
收緊可能過頭，也可能只是沒機會——樣本不足判斷。

**不要再動觸發條件。** 真要改就改止損距離下限（至少 1×ATR 或 0.8%）。

### 10. 時間止損 8 根 K 線是否該放寬
見 P1 #1——**做完影子模擬再說**。

---

## P3 — UI 殘留（低優先）

### 11. login 頁裝飾 emoji
`src/app/login/page.tsx` 有 1 處 📈，從未終端化過。

### 12. 零星功能性符號
`StoreHydration.tsx`（⚠/✕）、`trades/page.tsx`（✓ checkbox）、`SignalCard.tsx`（⚠/✓）
各 1-2 處。跟裝飾性 emoji 性質不同（是功能指示），要不要清可討論。

---

## P4 — 已知偏離，刻意不修

- **funding-crowding 只扣 confidence 不扣分數** — 規格 §4.2 要求扣分。未驗證前不收緊。
- **限價單被暴力突破時 fill-then-stop** — 目前 fill-on-touch 會成交然後止損，而非取消。開放設計題。

---

# 自動化交易（Binance API）— 獨立專案

> 討論於 2026-07-26。**執行引擎放哪還沒決定**（見下方決策點）。
> **第一批安全基礎設施已完成**（commit `580e2ad`，2026-07-26）——見 §進度。

## 進度

`src/engine/` 已建好，**尚未接上任何真實下單流程，也沒有任何地方呼叫這些模組**。
選這批先做是因為機器放哪都用得到，不用等決策點定案：

| 檔案 | 內容 | 測試 |
|---|---|---|
| `precision.ts` | stepSize/tickSize/minNotional 處理 | 12 |
| `preTradeCheck.ts` | 下單前置檢查（強平緩衝/保證金/精度/權益地板/kill switch/當日虧損） | 15 |
| `binanceClient.ts` | HMAC-SHA256 簽名 client（讀+寫端點都有，寫的還沒被呼叫過） | 8 |
| `killSwitch.ts` | Redis flag + 自動觸發判斷（純函數） | 6 |
| `watchdog.ts` | 持倉/掛單對帳（抓裸倉、孤兒單） | 9 |

**還沒做、真錢上線前必做**：
- watchdog 的輪詢迴圈本體（reconcile 邏輯有了，包成常駐 loop 還沒寫）
- kill switch 觸發後的實際 flatten 動作（現在只設 flag，沒有一鍵撤單平倉）
- testnet 對帳
- 部分成交、取消/成交競態的處理（見下方「掛單過期功能會怎樣」）
- `goodTillDate` 提前量在 testnet 實測
- leverageBracket 查詢接上（`preTradeCheck` 現在吃固定 `maintenanceMarginRate` 參數，
  還沒接上真實的分級查詢）

## 決策點（未定）

執行引擎放哪裡，這決定後面所有實作：

| 選項 | 靜態 IP | 持久連線 | 成本 |
|---|---|---|---|
| **Oracle Cloud Always Free 東京**（推薦） | ✓ | ✓ | $0 |
| Vultr / Linode 東京 | ✓ | ✓ | ~$5/月 |
| 自己的電腦 | ⚠️ 家用IP通常會變 | ✓ | 0（要一直開機） |
| 硬留 Vercel | ✗ | ✗ | 0（不推薦） |

**Vercel 不能用的三個理由**：
1. Hobby/Pro 沒有靜態出口 IP → Binance API key 綁不了 IP 白名單
2. serverless 可能在下單序列中途被殺 → 進場成交但止損沒送出 = 裸倉
3. 移動止損需要持續改單，5 分鐘 cron 粒度太粗；user data stream 需要持久連線

**watchdog 不該跟引擎放同一台** — 同機掛掉兩個一起死，沒人知道出事。
建議引擎+watchdog 放 VPS，Vercel cron 當死人開關（每 5 分鐘打 VPS `/health`，
打不通就推播告警）。Binance API 主要在東京，選近的機房縮小撤單/改單的競態窗口。

## 上線順序（不要跳）

1. ~~先做「怎麼停下來」~~ ✅ kill switch + watchdog 核心邏輯已完成（純函數部分）
2. ~~前置檢查做成純函數 + 測試~~ ✅ 已完成
3. testnet（`testnet.binancefuture.com`）跑到對帳零誤差 ← **下一步**
4. 真帳戶 dry-run：算出訂單參數但不送，log 出來跟手動下單比對一週
5. 真錢最小規模（名目 5-10 USDT），每天對帳，跑一週
6. 對帳零誤差才放大到策略原本的倉位

## 必做的安全控制

### 逐倉（ISOLATED）— 最關鍵
```
POST /fapi/v1/marginType {symbol, marginType: "ISOLATED"}
```
Binance **預設全倉**，全倉下單一部位虧損可吃掉整個帳戶。
逐倉把最壞情況從「帳戶歸零」降級成「賠掉那張的保證金」。

symbol 層級持久設定，有持倉時改不了 → 下第一張單前設好，每次下單前檢查。

### API key 權限
只勾 **Enable Futures**，**絕不勾提現**。

### 五層防護
1. **交易所層** — 逐倉、止損用 `closePosition=true` 的 `STOP_MARKET`、成交後立刻送
2. **下單前置檢查**（純函數 + 測試）— 強平緩衝 ≥3×、總保證金 ≤50%、精度/最小名目、
   權益硬地板、kill switch 未啟動、當日虧損未達上限
3. **watchdog**（獨立程序，不可跟下單引擎同一個會被殺的函式）— 每 30 秒對帳
   持倉 vs 掛單，「有持倉沒止損」立刻補單或市價平掉
4. **kill switch** — Redis flag 擋新單 + 一鍵撤單平倉；自動觸發條件（連續 API 錯誤、
   權益跌破地板、watchdog 連續偵測不一致）
5. **熔斷器接到下單層** — 現有熔斷器只擋訊號產生，要讓它也擋下單

## 技術清單

**簽名**：`HMAC-SHA256(queryString, secretKey)` 當 `signature`，header `X-MBX-APIKEY`，
每請求帶 `timestamp` + `recvWindow`。

**端點**：`POST /fapi/v1/leverage`（槓桿）、`POST /fapi/v1/marginType`（逐倉）、
`GET /fapi/v2/balance`、`GET /fapi/v2/positionRisk`、`GET /fapi/v1/openOrders`、
`POST`/`DELETE /fapi/v1/order`、`GET /fapi/v1/exchangeInfo`（公開）

**精度處理**（沒做會吃 `-1111` / `-4164`）：
```
LOT_SIZE.stepSize     → quantity 無條件捨去到整數倍
PRICE_FILTER.tickSize → price 必須是整數倍
MIN_NOTIONAL.notional → quantity × price ≥ 5 USDT
```

**冪等性**：`newClientOrderId = ${tradeId}-entry / -sl / -tp`。
重複送同 ID 會被拒（`-4015`）——這正是要的，cron 重跑不會重複開倉。

## 掛單過期功能會怎樣

**會保留，而且更可靠**，但機制反轉：

- **逾期 4 根 K 線** → 可以丟給交易所做（`timeInForce: GTD` + `goodTillDate`）。
  好處：系統掛掉訂單也會自己過期。（`goodTillDate` 有最小提前量限制，testnet 要實測）
- **結構突破 / 行情走遠 / TP1直達** → 動態條件，必須留在程式裡

**兩個現在完全沒有模型的新狀態**：

1. **部分成交** — 現在 `isFilled` 是 boolean，真實限價單可以只成交 30%。
   在部分成交後送取消 → 取消的是未成交部分，**已成交部分是真實持倉，需要止損不是取消**。
   判斷：讀 `executedQty`，>0 就走成交路徑補止損。

2. **取消 vs 成交競態** — 決定取消 → DELETE 在路上 → 訂單剛好成交。
   Binance 回 `-2011 Unknown order sent`。**不能當成取消成功**，必須重查 `positionRisk`。

**取消不要再刪 DB 列** — 現在是 `.delete()`，接真錢後要保留紀錄改 `status='cancelled'`，
否則對帳時發現交易所有一筆 DB 沒有的成交會完全追不到。

## 接上真錢後 monitor 會大幅簡化

現在的 Phase 1/2 是**掃 K 線猜**成交了沒、止損碰了沒。接交易所後不用猜——直接問。

**今天修的那一整類 bug 會消失**（幽靈成交、NULL status 沒人監控、客戶端覆寫伺服器），
因為交易所變成唯一真相來源，DB 只是鏡像。

代價：那幾百行 K 線掃描要重寫成「對帳」；成交判斷那段整段不需要，
但取消條件（看收盤價）還是要掃 K 線 → 迴圈會拆成兩半。

## 帳戶規模考量（100 USDT）

正常運作時**碰不到強平**——止損永遠設在強平位的 1/13 ~ 1/19 處：

| 情境 | 槓桿 | 保證金 | 強平距離 | 止損 | 緩衝 |
|---|---|---|---|---|---|
| BTC B級・止損1% | 5x | 30U | ~19.6% | 1% | 19× |
| 山寨・止損1% | 5x | 19.8U | ~19.5% | 1% | 19× |
| 山寨・止損3% | 1.65x | 20U | ~39% | 3% | 13× |

**會爆倉的不是策略，是讓部位失去止損的 bug**：裸倉、改單空窗、交易所拒單、參數錯誤、跳空。
前四項都是本專案已經有前科的 bug 類型 → 所以 watchdog 是必要的。

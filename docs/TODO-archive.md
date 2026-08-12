# TODO 已完成項目封存（2026-07-26 ~ 2026-08-04）

> 從 `docs/TODO.md` 搬出來的歷史記錄，2026-08-12 分割。
> 搬出來的理由：這些是**已完成**的項目，佔了原本 TODO 近一半篇幅，
> 讓還沒做的事很難找。內容一字未改，只是換個檔案放。
>
> **不要刪這個檔案**——這個專案的價值有很大一部分在「為什麼當初這樣改」，
> 好幾次調參決策都是回頭翻這些記錄才沒有重蹈覆轍（例如 CPU 優化踩過的
> 三次坑、tier `?? 'A'` 捏造標籤那次）。
>
> 2026-08-04 之後的已完成項目仍留在 `docs/TODO.md` 主檔。

---

## 已完成（2026-08-04）

**修移動止損從未生效的 P0 bug**（完整根因分析：`docs/ANALYSIS-2026-08-04-移動止損失效與策略數據檢討.md`）：

使用者用 CSV（107 筆已平倉）＋近 3 天漏斗數據做策略檢討時，同時回報一個
具體症狀：「碰到 TP1 會移動止損，但等的過程中碰到移動後的止損卻不會停止，
要等到碰到原始止損才會停止」。查證後發現比症狀描述更嚴重——移動止損機制
**從未被建立過**。

根因：`route.ts` Phase 2 監控迴圈的 `atr1h`（用來初始化與棘輪移動止損）
是從 `candles` 算的，而 `candles` 是**增量抓取**（`startTime` 帶
`last_monitored_at`，每輪只帶上一次掃描之後的新K線）。外部 cron 每 5 分鐘
跑一次，`candles.length` 因此恆約為 2，舊版 `candles.length >= 15` 的守衛
**永遠是 false**，`atr1h` 永遠是 0——移動止損的初始化、補種、棘輪三處全部
被跳過，`trailingStop` 恆為 0，TP1 後只能落到原始止損才出場。`current_stop`
從未被寫入 → 卡片走 fallback 顯示進場價，造成「有在保護」的錯覺（實際沒有）。

根因由兩個從程式碼推導、可否證的行為預測經使用者實機確認：(1) 從未收過
「🛡 移動止損上移」推播（該推播需要 `atr1h > 0` 才可能觸發）；(2) 卡片止損
位永遠顯示進場價、鎖定 R 永遠 `+0.0R`（`current_stop` 恆為 NULL 時的 fallback
行為）。加上 CSV 三條獨立資料佐證（ETHUSDT 出場價完全等於原始止損、
HYPEUSDT MFE 3.08R 只拿到 0.32R、107 筆裡「移動止損出場」出現 0 次），
根因確認無誤。

修法：`atr1h` 改用 `fetchCandlesCached(symbol, '1h', 20)` 額外抓一份完整
窗口（跟既有 4H regime 快取同一套機制，只補尾巴，不會每輪整包重抓），只在
`tradeStrategy === 'A'` 時才抓，Strategy B（無移動止損）不受影響。ATR 計算
本身抽成純函數 `calcSimpleAtr`（`src/lib/monitorMath.ts`）+ 6 個單元測試，
公式刻意跟修 bug 前一致（簡單 TR 均值，非 Wilder 遞迴）——這次只修資料
來源，不動算法本身，避免一次動兩個變數。`atr1h` 算出來仍是 0 時記錄
error log，避免這類靜默失效再度潛伏數週不被發現。

同一輪順手修 trades 頁兩個獨立的分類 bug（跟移動止損無關，是查移動止損
時順帶發現的）：(1) `filtered` 的 `useMemo` 裡，`filter` 是 PENDING/WAITING/
CLOSED 時直接拿 `pending`/`waiting`/`closed` 這幾個 memo 陣列的參考，後面
`base.sort()` 是就地排序，會直接改動這些陣列本身——陣列 identity 沒變，
依賴它們的其他 memo（如 `liveCounts`）不會重算，卻用到被改過順序的資料；
改成先複製一份再排序。(2)「全部」chip 顯示的數字是
`waiting+pending+closed`，但 `filter==='ALL'` 實際列出的內容還包含
`unconfirmed`（同步中），有同步中的單時數字會比實際列出的筆數少；補上
`unconfirmed.length`。

CSV 匯出補上真正的 `strategy` 欄位（新增「進場策略」欄）——原本「策略」欄
其實是 `${tier}級·${timeframe}`（改標成「級別」避免混淆），跟真正控制
移動止損開關的 `strategy`（A/B/C）欄位完全是兩件事，之前的 CSV 診斷不了
這類問題。

**尚待使用者確認**：截圖裡「按持倉卻列出等待進場的單」那個症狀，用現行
程式碼推導不出成因（`waiting`/`pending` 嚴格互斥、全專案沒有就地改動
`trade.status` 的地方、截圖數字本身自洽於 `waiting.length===0`）——最可能
是瀏覽器在跑舊 bundle，已請使用者比對設定頁的 build SHA 是否為最新
（詳見 ANALYSIS MD §5）。

驗證：tsc 0 錯、vitest 309 passed（新增 6 個）、next build 0 錯；本機預覽
無 console 錯誤。移動止損的實際效果（TP1 後鎖住多少 R）需要新持倉走完
TP1 才看得到，舊單無回溯。

---

## 已完成（2026-08-03）

**修 iOS PWA 同步永久死亡 bug**（完整根因分析：`docs/BUG-2026-08-03-同步失效與掛單狀態卡住.md`）：

使用者回報兩個症狀：(1) 手機分類按鈕要先按「同步紀錄」、把 App 完全關掉重開
才正常；(2) 明明已經打到進場價，紀錄仍顯示「已達進場 等待確認」。查證後
是同一個根因——`StoreHydration.tsx` 原本用一個 effect（`[userId, hasHydrated]`
deps）同時管「初次從 Supabase 載入」跟「四個背景監聽器（自動存檔/10分鐘
定期存檔/2分鐘定期同步/回前景同步）的註冊」，用 `syncDoneRef` 閂鎖只讓它們
跑一次。iOS standalone PWA 從背景恢復時，supabase-js 的 token 自動刷新偶爾
會有一瞬間 session 空窗（`onAuthStateChange` 先收到 null、稍後才收到恢復的
uid），userId 因此短暫變 null 又變回來：cleanup 在 userId 變 null 時被觸發，
四個監聽器全部解除；userId 恢復時 effect body 重跑，但閂鎖已是 true，直接
return——監聽器永遠沒有重新註冊。只剩手動「同步紀錄」按鈕（直接呼叫
`fullSyncFromSupabase`，不經過這個 effect）還活著，這正好對上使用者的
操作流程。決定性證據：`PriceFeed`（同一個 root layout、同樣用
`visibilitychange`）的即時價格是新的，證明事件確實有觸發，只是
StoreHydration 那組監聽器已經不在了——排除法排除了「iOS 事件不可靠」
的假設。

修法：`src/components/StoreHydration.tsx` 拆成兩個 effect——初次載入保留
`initialLoadRef` 守衛（一次性行為，deps 不變）；監聽器那個改成只依賴
`hasHydrated`（`useStore.ts` 的 `onRehydrateStorage` 只會 false→true 一次，
永不重置），不再依賴 `userId`——session 空窗不再讓監聽器被拆掉。每個回呼
內部本來就即時讀 `useStore.getState().userId` 決定要不要動作，不靠 closure
捕捉的值，拿掉依賴不影響行為。

順便修 `src/app/trades/page.tsx`：「已達進場 等待確認」改顯示
「已觸價 · 等待伺服器確認成交 · 已等 X」——伺服器判定成交用 1h K 線 +
時間錨（route.ts，刻意設計，不能改），觸價到確認之間本來就可能有近 1 根
K 線的正常延遲，顯示已等多久讓使用者分得出「正常等待」vs「真的卡住」。

已排除：Service Worker 快取（`sw.js` 的 fetch handler 是空 passthrough，
無快取邏輯）；Webhook Secret 錯誤（使用者確認沒看到警告橫幅）。

驗證：tsc 0 錯、vitest 303 passed、next build 0 錯；本機預覽（真實
Supabase session）首頁與登入頁渲染正常、無 console 錯誤。**這個 bug 依賴
iOS 背景凍結/解凍時序，自動化工具無法忠實重現**——需要使用者實機驗收：
切到別的 App 放置 10 分鐘以上，切回後不按同步、不重開，直接點分類按鈕，
應立刻正確反映最新狀態（驗收細節見 BUG-2026-08-03 §6）。

---

## 已完成（2026-08-01）

**推薦單失效影子模擬**（`src/lib/cancelShadow.ts`，跟 `timeStopShadow.ts` 同一套模式）：

8/1 使用者回報「一直收到掛單通知，但一直取消」，查 CSV 匯出發現當日 10 筆
候選全部「推薦單失效」（4 直達TP1未成交、5 逾期未成交、1 行情走遠）；查歷史
7/18-7/31（40筆）整體僅 10%（4/40）失效，但 7/29 單日高達 60%（3/5）——不是
漸漸變壞，是特定盤況才爆。根因：策略A進場邏輯（`signals.ts` 的 `longEntry`/
`shortEntry`）永遠等現價回調到 OB/支撐/EMA20 才進場，但能拿高分的訊號靠的
正是 EMA排列/BOS突破/大時框偏多空+3 這些「趨勢夠強」證據——這正是市場最
不容易回調的時候，兩者結構性矛盾。7/31 剛修的 `same_dir_cap` 讓更多這類
候選真的能掛出來，疊加上既有的成交率問題同時發生，才顯得特別誇張。

在確認改進場邏輯本身之前，先建影子模擬量測「如果當下用訊號價（signal_price）
市價進場，淨R會是多少」——比照時間止損影子模擬的做法，不影響任何真實下單
行為。掛單被取消時（Phase 1 的 `isCancelled` 分支）啟動追蹤，用 `walkTpSl`
純函數推進到真正 TP/SL（或7天上限放棄），依四種取消原因分組統計：
`cancel_tp1_direct`/`cancel_ran_away`（價格已朝有利方向走，理論上最可能
netR>0）、`cancel_expired`（原地沒動，勝負未知）、`cancel_thesis_invalidated`
（收盤已破壞止損位，理論上最可能netR≤0）。沒有真實R基準可比較（單從沒
成交，真實R固定是0）——netR本身就是完整答案：正值代表白白錯過、該考慮放寬
近市價進場；負值/接近0代表等回調是對的，不要動。

顯示位置：`/api/reject-funnel` 新增 `cancelStats` 欄位，`ScanStatusPanel.tsx`
比照時間止損影子模擬那個區塊呈現，樣本不足前只陳述數字不下判詞。

驗證：tsc 0 錯、vitest 303 passed（新增 11 個）、next build 0 錯。這是純
量測基礎設施，不改變任何策略行為——先跑數據，累積足夠樣本後才回頭決定
要不要放寬進場邏輯（三個候選方案已跟使用者討論：擴大近市價進場例外／
收窄 searchWindow／維持現狀，待這裡的數據出來再選）。

---

## 已完成（2026-07-30 這輪，續）

**MFE/MAE 記錄 + 每筆風險比例新增 5%/10%**（策略檢討的直接產物）：

CSV 檢討發現的兩個結構問題：(1) 60% 的單走時間止損出場，但完全沒有數據能回答
「TP1 設在 2R 是不是太遠」——出場價相同的兩筆單，一筆可能中途衝到 +1.8R 才回落，
一筆從沒超過 +0.3R，這是完全不同的問題（TP1 太遠 vs. 進場論點不成立），只看出場價
分不出來；(2) 小帳戶（40U）配合山寨風險折算（`ALT_SLOT_RISK=0.33`）算出來的倉位，
遇到止損距離較寬（>8%）的訊號會低於幣安 5U 最低下單額，這類單如果要下就得手動
超額下注，跟系統建議的風險比例脫鉤。

**MFE/MAE**：`src/lib/monitorMath.ts` 新增純函數 `updateMfeMae`（9 個測試），
記錄成交後價格「最有利」與「最不利」曾經到過哪裡。刻意獨立於既有的收盤判斷邏輯
（TP/SL/移動止損）之外——這是單調遞增的被動量測，不是交易決策，不需要跟收盤邏輯
共用原子寫入保護，混在一起只會增加最關鍵路徑的風險。`route.ts` 只用這一輪監控
本來就抓到的 K 線增量更新，不額外抓取；DB 寫入失敗（未跑 ALTER TABLE）只記
log，絕不阻擋真正的 TP/SL 監控。CSV 匯出新增 `MFE(R)`/`MAE(R)` 兩欄（換算成 R，
正值＝對單方向有利），刻意不接進即時 App UI——沒有解決「這幾個欄位 authenticated
role 讀不讀得回來」的既有疑慮前，先只走已經用 service role 的匯出端點。

**風險比例**：`riskPctPerTrade` 選項從 `[0.5,1,2,3]` 加到 `[0.5,1,2,3,5,10]`，
>=5% 顯示更嚴厲的警告文案（3 筆連續虧損吃掉的本金百分比）。

**未跑（需要你在 Supabase SQL Editor 執行）**：
```sql
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS mfe_price NUMERIC,
  ADD COLUMN IF NOT EXISTS mae_price NUMERIC;
```
跑之前 MFE/MAE 寫入會 42703 → 大聲 log 提醒，不影響任何既有功能；CSV 那兩欄
會是空的。跑完之後，只有**新成交、新監控到的部位**會開始累積——舊單沒有回溯資料。

驗證：tsc 0 錯、vitest 292 passed（新增 9 個）、next build 0 錯。

---

## 已完成（2026-07-30 這輪）

**4H regime 計算改真正 memoize（不只快取輸入陣列）**（P0 #0，第三次嘗試）：

7/29 的候選陣列快取（`d83e5d5`）只砍了「重新抓取＋解析 540 根 K 線」的成本，
`calcAdx`／`calcAtrHistory` 這兩個函式本身仍然**每輪都對整段 540 根重跑一次
Wilder 平滑遞迴**——這才是真正的計算大宗，候選陣列快取完全沒碰到它。
7/30 實測證實：8m6s(7/27) → 8m40s(7/29，修正後) → 推算 8m30s(7/30)，三個數字
沒有差異，等於白做。

`src/lib/regimeCache.ts`：memoize 最後一根 4H bar 的 openTime，值不變就直接
回傳快取的 `{adx, atrPct}`，完全跳過 `calcAdx`/`calcAtrHistory`——4H bar 每
4 小時才變一次，等於運算量從「每分鐘 1 次」降到「每 4 小時 1 次」（約 240 次
降到 1 次）。**特意選 memoize 而非真正的增量遞迴**（延續 smoothTR/smoothPlus/
smoothMinus/adxVal 狀態）：兩者 CPU 收益相同，但增量遞迴要求狀態跨掃描永久
延續且不能有任何誤差累積，一旦漏掉或重複一個 tick 就會悄悄偏離「重新算一次」
的真值，且沒有任何機制能偵測到這種漂移——對一個決定策略走向的 regime 分類器
來說風險不划算。memoize 沒有這個風險：快取值的定義就是「這組輸入原本會算出
的結果」，輸入一變就整段重算，不會有分毫的漂移可能。

保留原本兩個獨立 try/catch 的故障隔離（ADX 失敗不影響 ATR 百分位，反之亦然），
只在前面插入共用的 cacheHit 短路判斷；ADX 為 NaN（K線不足）時不寫入快取，
讓下一輪重新嘗試完整計算而非快取一個非值。

驗證：tsc 0 錯、vitest 283 passed（新增 9 個）、next build 0 錯。**降幅未量測**，
看 7/31。這是第三次嘗試——如果這次還是沒有效果，代表這條路本身猜錯了大宗在哪，
下一步應該去查 5m/15m/1h 的 SMC 結構分析（`findSwingPoints` 等，每根K線兩次
`slice+concat+every` 陣列配置，跑在 3 個時框 × 15 個幣種的熱路徑上），而不是
再對 4H 這條路徑做第四次嘗試。

## 已完成（2026-07-29 這輪）

**交易紀錄頁：篩選按鈕偶爾要重整才有反應**（使用者回報，`7e0a4fa`）：

systematic-debugging 排查：按鈕本身、hit-test、React 狀態更新路徑全部正常
（實測程式化點擊每次都正確切換）；沒能重現「按了沒反應」本身——自動化分頁
背景節流，測不到「切回前景那瞬間」的真實情況，所以**根因未 100% 證實**。

但排查中發現一個確定的回歸（07-28 造成）：`trades/page.tsx` 訂閱整包
`usePriceStore(s => s.prices)`，20 個幣任一個價格變動（每 3 秒一次）就讓
整頁重繪，39 張卡的重 JSX 全部重新執行一次——這正是「切回前景／解鎖後那一刻
最忙、最容易卡住」的體感所在，即使不是本因，也是值得先清掉的成本。

修法：抽出 `TradeRow`（`React.memo`），改成每張卡內部各自訂閱自己那個幣的
即時價（`usePriceStore(s => needsLivePrice ? s.prices[symbol]?.price ?? 0 : 0)`）
——已結束/已取消的卡完全不訂閱價格變動（selector 恆回 0），持倉中/等待進場/
追蹤TP2 的卡才會因為「自己那個幣」的價格變動而重繪，不再因為任何一個幣種
的價格變動就重繪全部 39 張卡。頁面層的 `priceOf`（浮盈/浮虧篩選、平倉彈窗）
不受影響，維持原樣。

驗證：tsc/vitest(265)/build 全過。**尚未在真實環境驗證按鈕問題本身是否消失**
——下次你切回 App 遇到按鈕沒反應，麻煩告訴我：改善了、還是一樣。

**4H K 線增量快取**（`d83e5d5`，P0 #0）：

`route.ts` 每輪對每個幣種抓 540 根 4H K 線（BTC regime 另外 250 根），但 4H K 線
每 4 小時才變一次，而掃描每分鐘一輪——539/540 根是完全相同的資料，卻每分鐘重新
HTTP 傳輸、`JSON.parse`、重建 540 個物件（每根 6 次 `parseFloat`）。15 個幣種
每輪約 8,100 個物件純屬重複，這才是 Active CPU 的大宗。

**快取的是「已解析的 K 線陣列」，不是「算完的指標值」**——`adx` 與 `calcAtrHistory`
都是 Wilder 遞迴平滑，每個值依賴整段前序序列，無法只用尾巴重算出相同數字。快取
輸入陣列、每輪只抓最後 5 根接上去，送進指標函式的輸入與整段重抓完全相同，輸出
必然相同，**行為零變更**。

`src/lib/candleCache.ts`：純函數 `mergeCandles`（10 個測試）負責接合，偵測到
斷層（實例閒置過久、尾巴接不回快取尾端）時回 `null` 強制整段重抓——序列有洞會
無聲汙染所有下游指標，寧可重抓。module-scope Map 在 Fluid 熱實例間存活，冷啟動
重抓一次而已，無正確性風險；有容量上限防幣種清單變動造成無限成長。

驗證：tsc 0 錯、vitest 265 passed、build 0 錯。**降幅未量測**，看 7/30。

## 已完成（2026-07-28 這輪）

**匯出報表擴充成策略診斷用**（P1 #0c，跟 #0b 同一批動機）：

原本 CSV 的「結果」欄對三種完全不同的事都寫「手動平倉」——8根K線停滯、
24/72/168h 到期、使用者自己按平倉——分不出關單原因，也沒有反事實資料
（時間止損若不砍會怎樣，只存在 Redis 影子模擬，不進 CSV）。

新增 DB 欄位 `close_reason`，`route.ts` 六種自動關單結局（`tp2`/`trailing_stop`/
`stop_loss`/`time_stop_stall`/`time_stop_expiry`/`time_stop_expiry_post_tp1`）與四種
掛單取消原因（`cancel_expired`/`cancel_ran_away`/`cancel_tp1_direct`/
`cancel_thesis_invalidated`）都寫入；判斷邏輯抽成純函數 `deriveCloseReason`
（`src/lib/monitorMath.ts`），8個測試鎖定分支優先序（例如 `autoClosedAfterTp1`
必須先於通用 WIN_TP1 判斷，否則 TP1 後到期會被誤標成移動止損）。手動平倉
（App 內按鈕）標記 `close_reason='manual'`，只在客戶端本地設定過才會推送，
不會覆蓋伺服器自動關單寫入的原因（`useStore.closeTrade`/`StoreHydration.tsx`）。

新增 `/api/trade-export`（service role），CSV 匯出改吃這個端點而非記憶體裡的
`closed` 陣列——一是不確定 `regime`/`confidence`/`funding_rate`/
`suggested_risk_pct`/`suggested_leverage`/`close_reason` 這些欄位 authenticated
role 讀不讀得回來（`/api/trade-status` 已證實 `status`/`signal_price` 有這問題），
二是本機 Zustand 只留 500 筆，直接查 Supabase 拿完整歷史。CSV 新增欄位：出場原因
（中文標籤）、R倍數、帳戶R（依tier加權）、regime、confidence、資金費率、建議風險%、
建議槓桿。

**未跑（需要你在 Supabase SQL Editor 執行）**：
```sql
ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason TEXT;
```
跑之前每次關單會 42703 → 自動 fallback 成不寫 close_reason（大聲 log 提醒），
不影響原本的關單/取消功能，只是報表那欄空著。

驗證：tsc/vitest(255)/build 全過。**尚未在真實環境驗證**——要等下一次真的有
單自動關閉，才知道 close_reason 有沒有正確落地（含跑完 ALTER TABLE 之後）。

取消掛單改軟刪（`9bd5d61`，docs/TODO.md P1 #0b）：

原本 `route.ts:484` 掛單逾期取消是整列 `.delete()`——DB 完全不留痕跡，「推薦單有多少
比例根本沒進場」無法回答。改成 `status='cancelled'`、`result='CANCELLED'`、`closed_at=now`
的軟刪，`result` 新增第 5 種值 `TradeResult`。刻意選 `result`（不是只動 `status`）是因為
客戶端本來就有一套現成的 finalize 流程（`resolveServerOutcome`/`applyServerOutcome`）只認
`result`+`closed_at`，這樣接上去零新增同步路徑。寫入失敗（例如未知的 DB CHECK constraint
擋下新值）會 fallback 回原本的硬刪除，不會卡成孤兒列。

前端影響面：`isFinallyClosed` 讓 CANCELLED 正確落進「已結束」（不再卡在持倉中），但勝率/
損益/R值/月度/評分區間/信號因子/時框/持倉時間等每一個統計數字都改吃新的 `closedResults`
桶（`closed.filter(t => t.result !== 'CANCELLED')`）——否則從沒變成部位的單會稀釋進勝率
分母，把統計做假。列表顯示與 CSV 匯出維持吃原本的 `closed`（含 CANCELLED），這正是這次
要的可見度。`RESULT_LABEL`/`RESULT_COLOR` 新增 `CANCELLED: '推薦單失效'`。

`checkSameDirectionRisk`/`checkTotalOpenRisk`/hard-stop 重複檢查全部已是
`closed_at IS NULL` 語意，設定 `closed_at` 後自動跟 DELETE 的舊行為一致，不需要额外改動。

驗證：tsc 0 錯、vitest 247 passed（新增 2 個鎖定 CANCELLED finalize 契約的測試）、
next build 0 錯。**尚未在真實環境驗證過**——要等第一張掛單真的逾期取消，才知道
`result='CANCELLED'` 有沒有被某個未知的 DB constraint 擋下（若擋下會 fallback 成
舊行為並大聲 log，不會是無聲失敗）。

效能與額度（`7eeb821`、`1d1e4a1`）：

| commit | 內容 |
|---|---|
| `7eeb821` | **現價改 3 秒全域更新**。原本三個問題疊加：記錄頁輪詢把 `status==='waiting'` 排除掉（掛單的現價/距進場永遠不動）、逐幣 await + sleep 一輪要 4-5 秒、輪詢綁在頁面上切頁就死。改成 root layout 的 `<PriceFeed>`（快迴圈 3s 現價、慢迴圈 60s 24h 漲跌、分頁隱藏暫停、429 退避 60s），價格搬進非持久化的 `usePriceStore`（留在 `WatchedCoin` 會每 3 秒重寫整包 localStorage，並且把 Supabase 的 4 秒 debounce 存檔永遠往後推）。**對 Vercel 零影響**——瀏覽器直連 `fapi.binance.com`，不經過 Vercel |
| `1d1e4a1` | **砍 `/api/analyze` 每輪純浪費**。① 移除初版就在、結果被丟掉的 `fetchTicker24h`（每輪 15 次白打）② 兩個影子模擬的「抓K線推進」節流到 10 分鐘（它們的註解還寫著 5 分鐘 cron 時代的假設，而且都是拿 1h K 線算，10 分鐘與 1 分鐘結果相同）。新候選的合併寫入維持每輪，跳過會永久遺失 |

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

## 從 TODO 主檔 P1/P2/🔬/P3 搬出的已完成項目（2026-08-12 整理）

### ~~5. 名額分配先到先得，非擇優~~ ✅ 已完成（`c1b46f6`，2026-07-28）
`for (const symbol of coins)` 按成交量排名跑，先觸發的幣拿走名額；
分數排序只發生在單一幣種內部。稀缺資源用抵達順序分配是最差的規則。

已改成兩階段：pass 1 掃描迴圈跑完整分析、收集所有合格候選（過每個幣種自己
的狀態關卡）；pass 2 依分數降冪排序後才依序判定同向上限、insert、推播——
分數高的候選先選，不再是掃描順序（成交量排名）先到先得。詳見 commit 訊息。

驗證：tsc/vitest(234)/build 全過；部署後手動觸發過一次，正常回應（實際
same_dir_cap/insert 路徑要等真的有多個候選同時競爭同向額度時才會被走到，
目前線上還沒遇到這種情況，邏輯本身已逐行核對與原本一致，只是換了執行時機）。

### ~~8. B 級輕倉（55-64 分）期望值可能是負的~~ ✅ 已處理（`169d4cf`，2026-07-30）

07-26 覆盤（10 筆樣本）：B 級合計 +2.61R，但 **LTC 一筆就貢獻 +3.50R**，
扣掉之後 9 筆 = −0.89R（每筆 −0.10R）。同期 A 級 11 筆 = +0.49R/筆。
當時記下「再跑一週如果還是這樣，考慮把門檻從 55 提到 58-60」。

**07-30 複查（樣本翻倍到 19 筆，結論不變）**：

| 分級 | 筆數 | 每筆R | 扣掉 3 筆 TP2 極端值後 |
|---|---|---|---|
| A 級 65+ | 16 | +0.399R | 不變（本來就沒有極端值，最大單筆 +2.00R） |
| B 級 55-64 | 19 | +0.514R | **16 筆 −0.044R/筆** |

三筆 TP2 達標（AKE/SHIB/LTC，各 +3.50R）**全部落在 B 級**。B 級中位數只有
+0.24R，而止損距離中位數約 1.1% → 來回手續費 0.15% ≈ **每筆 0.14R 成本**，
中位數撐不起成本。A 級則穩定 +0.399R 且不靠尾部。

已改：`MIN_SCORE_TIER_B` 55 → 60。只砍 55-59（純虧損區），60-64 保留因為
樣本還不足以單獨判定那一段。推播文案、型別註解、交易頁評分區間標籤同步更新；
評分區間多切一格「55–59（已停用）」保留歷史證據，不併回 B 級也不砍掉。

**刻意沒動**：`route.ts` 漏斗記錄的 `rawTopScore >= 55` 門檻維持 55，讓 55-59
的候選繼續以 `score_gate` 記進漏斗——那個數字是之後唯一能回答「這次升門檻擋掉
了多少單、擋得對不對」的依據。

**下一步**：看 `score_gate` 在漏斗裡的佔比變化（升門檻前只有 1%），以及 60-64
這段累積更多樣本後是否也該砍。

**2026-08-08 追加**：`MIN_SCORE_TIER_B` 再從 60 → 65（commit 訊息稱「B tier
名存實亡」——這個更動沒有留下對應的分析文件，只能從程式碼註解回推）。
**2026-08-12**：8/11 CSV（169筆）複查，B級（65分門檻後）整體還是打平
（-0.023R/30筆），但拆方向後發現不是門檻的問題——是 B 級做多結構性壞掉
（-0.268R/35%勝率/17筆），做空其實跟 A 級同水準（+0.297R/69%）。已經找到
並修好根因（見上方「已完成」：策略B做多補齊硬性放量門檻），不是門檻鬆緊
的問題，門檻本身先不要再動。

### ~~11. login 頁裝飾 emoji~~ ✅ 已完成（`6d21295`，2026-08-06）
`src/app/login/page.tsx` 的 📈 換成終端風格 `[ CT ]`（font-mono + tracking-widest），
比照其餘頁面 2A 階段的終端化。純文字/class 換行，tsc/build 過，瀏覽器驗證因本機
無真實 Supabase session 卡在 `StoreHydration.tsx` 的 `authReady` 載入圈（既有已知
限制，非本次改動造成）。

### ~~12. 零星功能性符號~~ ✅ 已完成（`243205a`，2026-08-06）
`StoreHydration.tsx`（⚠/✕）、`trades/page.tsx`（✓ checkbox）、`SignalCard.tsx`（⚠/✓）
全部換成 lucide-react 圖示或純文字。順帶拿掉 `signals.ts` 高波動 reason 字串裡
唯一的 ⚠ 前綴（其餘 reason 全是純中文），`SignalCard.tsx` 的 `isHighVol` 判斷
同步改比對新字串。tsc/vitest(480)/build 全過。

### ~~13. 「取消掛單」按鈕文案不實~~ ✅ 已完成（`f5fb48c`，2026-08-12）
`isWaiting` 分支的按鈕寫「取消掛單」/「已取消」，但實際呼叫的
`handleManualUnlock` 只清 Redis 的 symbol 追蹤鎖，不動 trades 表——按下去
卡片不會消失。跟旁邊 `isPending` 分支同一個函式卻正確寫「解鎖推播」的文案
統一。順便補上失敗時的 console.error（原本 `.catch(() => {})` 吞掉所有
錯誤，webhookSecret 沒設定時按鈕照樣顯示「已解鎖」）。


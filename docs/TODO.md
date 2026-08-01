# 待辦清單

> 最後更新：2026-08-01
> 排序依「該不該現在做」，不是依技術難度。
> 標 🔬 的是**樣本不足**，動了也分不出是改對還是雜訊——刻意不做。

## 現在的狀態一句話

策略相關的項目**全部卡在等數據**（這是本專案自己的紀律，不是拖延）；
**P0 的 Vercel CPU 額度**踩了兩次坑——7/28 的 I/O 優化與 7/29 的 4H 候選陣列快取
實測都沒讓 Active CPU 有意義下降（7/27 8m6s → 7/29 8m40s → 7/30 推算 8m30s，
全部卡在同一區間），7/30 改做真正對到熱點的修正：memoize ADX/ATR 計算結果本身
（不只快取輸入陣列），下一步等 7/31 完整日數字；
`close_reason` 欄位的 ALTER TABLE 已於 7/29 執行完畢，新關單起開始累積；
`mfe_price`/`mae_price` 欄位的 ALTER TABLE 待執行（見下方 SQL），跑完才開始累積；
7/31 修掉一個嚴重 bug：昨天新增 10% 風險選項後，同向風險上限用固定 2%／1%
比對，單筆新單風險本身就會超過（10% 主流幣單 > 2% 上限），等於把所有訊號
全部擋死，跟現有倉位是不是 0% 無關——已改成跟 acctRiskPct 等比例縮放；
同一輪順便查了其餘會擋單的關卡，發現兩處顯示文案跟真實帳戶%脫鉤（純標籤
問題，未改任何門檻數值/觸發邏輯）：熔斷訊息改顯示真實帳戶%（門檻本身仍
固定 -3R，理由見程式註解——門檻隨風險%走會導致 10% 設定下單筆 -1R 就整天
熔斷）；`total_risk_cap`（首頁/漏斗面板「總持倉風險」）其實是加總
`suggested_risk_pct`（ATR 建議值，跟 acctRiskPct 無關），改標成「持倉風險
評分」避免使用者誤讀成真實帳戶風險；
8/1 發現策略A進場機制的結構性矛盾：能拿高分的訊號靠的是趨勢夠強的證據
（EMA排列/BOS/大時框偏多空+3），但進場邏輯要求先等回調——趨勢越強越不
回調，兩者互相矛盾。當日 10 筆候選全部「推薦單失效」，7/29 也有 60%
（3/5）失效，非單一意外。已建「推薦單失效影子模擬」量測「如果當下市價
進場淨R會怎樣」，跑數據前不動進場邏輯本身；
下一個沒被擋住的是自動化交易的「執行引擎放哪」決策點。

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

## P0 — 有外部期限，唯一在跑的計時器

### 0. Vercel Fluid Active CPU 超額（4h22m / 4h，2026-07-29 實測）

Hobby 方案近 30 天 109%，99.6% 來自本專案。

**每日實測（照 UTC 分日）**：

| 日期 | Active CPU | 說明 |
|---|---|---|
| 7/5–7/19 | 12–20m/天 | cron 正常跑 |
| 7/20–7/26 | 1.5–2.5m/天 | cron-job.org 排程失效，這是 App 本身的底噪 |
| 7/27 | 8m 6s | 排程重新啟用（優化前基準） |
| 7/28 | 9m 5s | `1d1e4a1` 於 06:52 UTC 部署，當天約 7 成時間是優化後 |
| 7/29 | 1m 44s @ 19.6% | 換算全天約 8m 51s |

**⚠️ 2026-07-29 修正：`1d1e4a1` 的兩項優化對 Active CPU 完全無效。**

原因是我當時判斷錯誤：Fluid **Active** CPU 只計「函式真的在執行 JS」的時間，
**等待網路 I/O 不計費**（這正是 Fluid 計費模式的賣點）。而那兩項砍的都是
網路密集而非 CPU 密集的東西——移除 `await fetchTicker24h`（省的幾乎全是等待
時間）、影子模擬節流（省的主要是抓 K 線）。改動本身仍是對的（少打幣安、
降 rate limit 風險），但解不了額度問題。

**教訓：優化 Active CPU 前先分清楚「在等 I/O」跟「在算」，這兩者計費完全不同。**

**已做（2026-07-29）**：4H K 線增量快取，見下方。效果**尚未量測**，要看 7/30
完整日。這次不預先保證降幅。

**若 7/30 仍不足，剩下的選項**（依效果排序）：
1. 把 5m/15m/1h 也換成 `fetchCandlesCached`——它們是剩下的 56%（200+250+250
   根/幣種），機制完全相同，一行一個改。
2. 減幣種（15→10）或砍掉 5m 時框——效果直接可預測，但會漏訊號。
3. 降 cron 頻率（3 分鐘一輪 ≈ 3m/天）——一勞永逸，代價是訊號最慢晚 3 分鐘。

**不要**把 regime/ADX 的「計算結果」整包快取到 4H 邊界——ADX 有 23/18 遲滯帶，
快取住等於盤中不再更新 regime，那是行為變更不是最佳化。快取輸入陣列才是對的
（見下方）。

---

## P1 — 值得做，隨時可動

### ~~0b. 取消掛單改軟刪（`status='cancelled'`），不要 DELETE 整列~~ ✅ 已完成（`9bd5d61`，2026-07-28）

原列在 `待修改事項.md` P0-1③，標「接自動化交易前必做」，2026-07-28 重新評估後
優先級提前——它當時已經在製造量測盲區：拒絕漏斗記的是「從未成為交易的被拒訊號」，
跟「已經成為掛單、但沒回測到進場價而被取消」是兩個不同母體，後者在 DB 裡完全
不留痕跡。

已改：`route.ts` 的取消分支從 `.delete()` 改成 `.update({ status:'cancelled',
result:'CANCELLED', closed_at: now })`。選 `result`（不是只動 `status`）是因為
客戶端本來就有一套只認 `result`+`closed_at` 的 finalize 流程，接上去零新增
同步路徑。前端每一個勝率/損益類統計都改吃排除 CANCELLED 的 `closedResults`
桶，列表顯示與 CSV 匯出維持含 CANCELLED（這正是要的可見度）。寫入失敗會
fallback 回原本的硬刪除，不會卡成孤兒列。

驗證：tsc/vitest(247)/build 全過。**尚未在真實環境驗證**——要等第一張掛單
真的逾期取消，才知道 `result='CANCELLED'` 有沒有被未知的 DB constraint 擋下。

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

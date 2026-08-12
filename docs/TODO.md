# 待辦清單

> 最後更新：2026-08-12
> 排序依「該不該現在做」，不是依技術難度。
> 標 🔬 的是**樣本不足**，動了也分不出是改對還是雜訊——刻意不做。

## 現在的狀態一句話（2026-08-12）

真倉（live-runner，testnet）已經是常駐在跑的東西，不再是規劃中的獨立專案——
今天它重啟後第一次真的碰到今天新加的資金安全補丁，當場炸出一個 bug
（`setLeverage` 送小數槓桿被幣安拒絕，全部進場失敗，已修，見下方 8/12 完成清單）。
**這代表現在最大的風險不是策略參數，是「新加的 live-runner 程式碼第一次真的
跑到才會發現的 bug」**——接下來一段時間每次它跑到新分支都要盯著看。

策略相關項目維持既有紀律：全部卡在等數據，不是拖延。今天用 8/11 CSV 複查
抓到一個有具體證據的策略問題（B級做多沒有放量硬門檻，跟做空不對稱）已修複
並推送，其餘都還在等樣本。

`P0 的 Vercel CPU 額度` 這段（下面保留原文當歷史記錄）是 7/29-7/30 的舊分析，
**已知過時**——後來真正見效的是砍幣種數 20→15，其餘 I/O/快取優化實測都沒用。
現在額度狀況需要重新問使用者拿最新 Vercel 數字才能重新判斷還是不是 P0。

`close_reason`/`mfe_price`/`mae_price` 這幾個欄位在 DB 模擬版本來就在正常
累積；8/12 補齊了 live-runner 真倉版本原本完全沒有的 MFE/MAE 記錄跟關單
原因細分（time_stop vs stop_loss vs trailing_stop/tp2，不是用出場價猜的，
是用「我們自己有沒有主動關倉」這個已知事實判斷）。

---

<details>
<summary>舊分析存檔（2026-07-31 ~ 08-03，點開看歷史脈絡）</summary>

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
8/3 修掉一個 iOS PWA 才會踩到的同步死亡 bug：`StoreHydration.tsx` 用單一
effect + `syncDoneRef` 閂鎖同時管「初次載入」跟「背景監聽器註冊」，deps 是
`[userId, hasHydrated]`——iOS standalone PWA 從背景恢復時 token 刷新偶爾有
一瞬間 session 空窗，userId 短暫變 null 又變回來，cleanup 被觸發解除全部
監聽器，閂鎖卻擋住重新註冊，定期同步/回前景同步/自動存檔永久死亡，只剩
手動「同步紀錄」按鈕還活著（分類按鈕要重整才有反應、掛單卡在「已達進場
等待確認」都是這裡）。拆成兩個 effect：初次載入保留 ref 守衛，監聽器那個
改成只依賴 `hasHydrated`（只會 false→true 一次，不受 session 空窗影響）；
順便把「已達進場 等待確認」文案改顯示已等多久，讓伺服器判定成交本來就有
的最長約 1 小時延遲不再被誤讀成當機；
8/4 修掉一個嚴重 P0 bug：移動止損從未生效過。`atr1h` 是從 Phase 2 增量抓的
`candles`（每輪只帶新K線，通常 1-2 根）算的，`candles.length >= 15` 因此
恆為 false，`atr1h` 恆為 0——移動止損永遠不會初始化，TP1 後只能一路等到
原始止損才出場（100+ 筆樣本查出：從沒收過移動止損推播、卡片止損位永遠
顯示進場價、MFE 3.08R 只拿到 0.32R）。改用 `fetchCandlesCached` 額外抓
一份完整窗口算 ATR，抽成純函數 `calcSimpleAtr` + 6 個單元測試；同一輪
順便修 trades 頁兩個分類 bug：`filtered` 的 `base.sort()` 會就地改動被
`useMemo` 快取的 pending/waiting/closed 陣列（改成先複製），「全部」chip
數字漏算 unconfirmed（同步中）的單；CSV 匯出補上真正的 `strategy` 欄位
（原本「策略」欄其實是 tier，跟移動止損的開關條件是不同東西，診斷不了
這類 bug）；
8/4 拿到 Vercel 完整曲線後，**CPU③ 可以結案**：7/31 的 `186813d`
（regime memoize）跟先前 `1d1e4a1`、`d83e5d5` 一樣，實測沒有可辨識效果
（8/1-8/3 水位 8.3/7.9/5.3 分 vs 7/26-7/30 的 8.2/9.2/8.7/8.3/7.4 分）。
三次失敗指向同一個結論：真正的熱點是**每輪重跑的訊號計算本身**——
15m 時框每輪重算 3 次、1h 每輪重算 12 次（新 K 線沒收就不會變，卻照算），
這是唯一還沒被碰過、且重複倍數可以事先算出來的熱點。
**而且這件事直接卡住策略**：目前水位 ~7 分/天貼著 4h/月 上限跑，
幣種被鎖在 15 個（7/26 為了超額從 20 砍下來），導致「持倉鎖定」擋掉 25%、
「總風險上限」擋掉 64%——近 3 天 1500 候選只出 5 單。放寬品質濾網解不了
（影子淨R 除以樣本數後全在成本線），**要出更多單得先把 CPU 省出來換幣種**。
詳見 `docs/ANALYSIS-2026-08-04B-CPU曲線與容量瓶頸.md`；
同一輪動手做了 B2（訊號計算 memoize，`src/lib/signalCache.ts`）與 B4
（client 成交備援窗口 4h→1h）。B2 比照 regimeCache 的 memoize 哲學，
per-(symbol, timeframe) 快取 `generateSignals()` 完整結果，命中判斷同時比對
K線收盤時間、htfBias、regime 三者（不只K線——regime 抓取失敗時的預設值
不受K線邊界巢狀保護，必須明確比對才安全）；訊號物件會被下游就地改動
（`entrySignal.reasons.push(...)`、`s.fundingRate = ...` 等），所以快取存入
與命中讀出都做了淺複製+`reasons`陣列複製，避免這一輪的變動污染到快取，
或快取被下一輪污染。本機對同一即時資料連續打兩次 `/api/analyze`（相隔
26 秒，都在同一根K線窗口內）驗證 15 個幣種的 topScore/regime/adx4h/
confluenceMet 等全部欄位逐位元組相同，0 個差異——證明快取命中時輸出跟
沒快取時完全一致，不是行為改變，純粹省重算。CPU 是否真的下降仍要等
Vercel 曲線，前三次同類優化都曾在這一步落空；
8/4 使用者提出要投入全自動交易，先做一份體檢
（`docs/ANALYSIS-2026-08-04C-自動化前的策略體檢.md`，118 筆樣本）——結論：
扣成本後期望值 95% 信賴區間跨 0（+0.180R，區間 −0.120~+0.481R），且移除
最大兩筆贏家（各 3.50R）就從 +0.180R 掉到 +0.060R，還沒統計顯著、也依賴
極值，**先不建議放大押注**；工程面也還缺下單執行層/重複下單防護/對帳/
最大回撤停機，這些現有系統完全沒有。唯一有統計支撐的單一發現：BTC 混沌
區降級（tier B、風險0.5%）扣成本後平均 −0.007R（信賴區間跨0），非混沌單
+0.422R（信賴區間不跨0，bootstrap 96.8%勝過成本）——降級只改倉位大小
不改 R 倍數，所以差距不是「倉位下太大」，是「混沌期進場的訊號本身沒有
優勢」。改成直接跳過（比照 `btc_direction` 硬擋），新增 `btc_chaos` 這個
skipKey，納入 `SHADOW_GATES` 讓漏斗持續追蹤這個決定；
8/4 再補三項（刻意都不是調策略參數——體檢結論是扣成本後期望值還沒統計
顯著，這時候調參數等於在雜訊上做決定）：(1) 修 TP1 推播寫死「止損移至
entry」的 bug，實際保護價是 trailingStop，7/30 前 atr1h 恆為 0 所以剛好
跟事實一致沒被發現，ATR 修好後這則推播會低報鎖住的利潤；(2) 新增跨日
權益回撤停機 `drawdown_halt`——既有熔斷只看當日且每天重置，擋不住「每天
小輸、累積大輸」（每天 −2.5R 連五天從未觸發當日 −3R 門檻，累積已 −12.5R），
純函數 `calcDrawdown` + 8 個測試，門檻預設 8R（實測歷史最大回撤僅 2.01R，
約 4 倍）可用 `MAX_DRAWDOWN_R` 覆寫、設 0 停用，查詢失敗一律不擋單；
(3) 新增進場品質量測 `extensionAtr`/`entryDistAtr` 塞進既有 `score_breakdown`
JSONB（不需 ALTER TABLE），純被動記錄不參與評分，為的是未來能檢驗「A級單
分數越高平均R反而越低」是不是因為高分訊號進場位置較差；
8/5 使用者回報「持倉突然被手動出掉，出掉後又秒給同標的新掛單」——查出
兩個獨立問題：(1) 伺服器的時間止損／到期平倉都寫 `result='MANUAL_CLOSE'`，
但 `close_reason` 從來沒同步回客戶端，紀錄頁只看 result 就一律標成
「手動平倉」，使用者因此以為是自己或某個 bug 平掉的（實際是系統依 8 根
K 線停滯規則關的）。把 close_reason 一路從 `rowToRecord`/`resolveServerOutcome`
/`finalizeFromServer` 帶回本地，卡片標籤改用真正的關單原因。
(2) 時間止損只鎖「同方向」4h，但它的判定依據是「8 根 K 線卡在 ±0.3R」——
那是對「這個標的正在盤整」的診斷，不是對「做多錯了」的診斷。只鎖同向的
結果是：剛把停滯的多單砍掉，5 分鐘後反向空單訊號完全暢通，在同一個盤整
區來回付手續費，正是原註解想避免的事。改成兩個方向都鎖 4h（LOSS 維持
只鎖同向不變——止損是對方向的否定，語意不同）；
8/5 做了 `docs/ANALYSIS-2026-08-05-提升盈虧率的可動項目.md` 的第一項：
TP1 部分停利。查證：TP1 目前只是里程碑不是實際成交事件——不管碰過 TP1
沒有，最終 R 一律用「最後出場價」算 100%，等於把「碰到 TP1 又回吐」的
那段有利波動當成沒發生過。20 筆有 MFE 樣本裡，碰到 TP1 的 5 筆平均回吐
超過一半（實得合計 5.31R vs 若在 TP1 全出會是 9.74R）。改成碰到 TP1 視為
平掉 50% 部位鎖定該處的 R，剩下一半才繼續照最終出場價計算，兩段加權
平均成最終 R——固定 50%、刻意不做成可調參數（樣本只有 5 筆，決定不出
最佳比例，開放調整只會被拿去在雜訊上亂試）。不需要新增資料表欄位，
純函數 `blendTp1PartialPnl`（monitorMath.ts）+ 8 個測試，`route.ts`/
`useStore.ts` 兩個計算最終 pnl 的地方都接上，行為對「從沒碰到 TP1」的
單完全不變（只在 localTp1Hit/status==='tp1_hit' 時才啟用）。查證過程中
發現 `useStore.closeTrade` 的「已關閉」守衛把 `t.result` 當判準，但
tp1-watching 的單本來就有 result 值——「手動記錄」按鈕對這類單目前形同
無效，這是獨立的既有 bug，已用 spawn_task 另開票，不在這次改動範圍；
下一個沒被擋住的是自動化交易的「執行引擎放哪」決策點。

</details>

---

## 已完成（2026-08-12）

真倉監控完善 + CSV 複查抓到的策略/UI bug，全部 tsc/vitest/build 過，已 push：

- **資金安全**：`setLeverage` 送小數槓桿（`calcPositionPlan` 給的是 1 位小數
  顯示值）被幣安拒絕，真倉重啟後 BTC/ETH 全部跳過進場——改 `Math.ceil()`
  進位成整數（`5b08217`）。
- **MFE/MAE 記錄**：live-runner 真倉監控原本完全沒記，DB 模擬版早就有——
  複用 `updateMfeMae`，餵單一 markPrice 包成 high=low 的單根「K線」
  （`9256e69`）。
- **真倉關單原因細分**：對帳一律寫死 `close_reason='live_auto_sync'`，看不出
  是止損掃到還是時間止損強制平倉——新增 `deriveLiveCloseReason`，用「我們
  自己有沒有主動關倉」這個已知事實判斷，不猜出場價（`9ffc345`）。
- **影子模擬滑價一致化**：`walkTpSl`（三個「如果當初會怎樣」模擬共用）止損
  出場之前零滑價，但真倉記帳早就套了保守滑價，兩邊口徑不一致會讓影子模擬
  的淨R判斷基礎失真——補齊（`dbe653e`）。
- **`finalizeFromServer` 沒清 `status`**：從沒成交就被伺服器取消的掛單，卡片
  永遠顯示「等待進場」——伺服器端 result/closed_at 早就正確，只是本地
  `status` 欄位沒有跟著清掉，畫面判斷純看 `status`（`322408d`）。
- **策略B做多沒有硬性放量門檻**：7/24 只對做空加了（無量觸價會被趨勢輾過），
  做多當時漏掉。8/11 CSV 複查發現同樣失效模式在做多重現（17筆 -0.268R/35%
  勝率 vs 做空 +0.297R/69%），補齊對稱門檻（`9b1dda7`）。
- **「取消掛單」按鈕文案不實**：查證後發現它真的有打後端 API（清 Redis
  symbol 追蹤鎖），但不會動 trades 表這筆列，卡片不會消失——跟另一處同函式
  正確的「解鎖推播」文案統一（`f5fb48c`）。
- **confidence 歸因分析**：`/attribution` 頁加 confidence 分數桶 vs 結果——
  三桶目前看不出單調關係，還不到能當濾網的時候（`db12138`）。
- **regime 欄位缺三成多，查明非 bug**：2026-07-27 19:10 是清楚分界線，之前
  的交易連 strategy 欄位都是空的，regime 追蹤根本還沒上線；之後 100% 都有
  記錄。舊資料的正常缺口，跟 `score_breakdown`（8/4 才開始記）同一種情況。

**尚未決定要不要做**（見下方 P1/P2）：`#86` 盤整識別收緊濾網、
`MAX_TOTAL_RISK_PCT` 在 live-runner 真倉路徑是否仍是死碼、`score_gate`
影子模擬。

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

## P0 — 有外部期限，唯一在跑的計時器

### 0. Vercel Fluid Active CPU 額度——狀態未知，需要重新問使用者拿最新數字

下面整段 7/29-7/30 的分析**已知過時**：三次「優化 I/O/快取」實測都對 Active
CPU 無效（原因見下方摺疊區塊），後來真正見效的只有砍幣種數 20→15。現在的
額度水位、幣種數、cron 頻率都可能跟這裡記的不一樣了。**這裡不再假設是不是
P0**——真的要處理前，先問使用者要最新 Vercel Usage 頁面數字，不要憑這份舊
分析行動。

<details>
<summary>2026-07-29 舊分析（已知結論失敗，僅供理解「試過什麼沒用」）</summary>

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

之後 4H K 線增量快取、regime memoize（`186813d`）也都實測無效——三次失敗
指向同一結論：真正熱點是**每輪重跑的訊號計算本身**（15m 每輪重算 3 次、
1h 每輪重算 12 次，新K線沒收就不會變卻照算）。8/4 做了訊號計算 memoize
（`signalCache.ts`）想解這個，效果是否成立**沒有留下後續量測記錄**——
這正是現在需要問使用者要新數字的原因。**唯一有實測證據見效的是 7/26
砍幣種數 20→15**（直接降計算量，效果可預測）。

**不要**把 regime/ADX 的「計算結果」整包快取到 4H 邊界——ADX 有 23/18 遲滯帶，
快取住等於盤中不再更新 regime，那是行為變更不是最佳化。快取輸入陣列才是對的。

</details>

---

## P1 — 值得做，隨時可動

### A. `#86` 盤整識別收緊濾網——排進清單很久沒做

早期規劃的三項（等回調機制加市價例外／資金安全／盤整識別收緊）已完成前兩項
（`6e3c6a9`、`37fd123`），第三項一直沒排上——中途被使用者回報的多個 bug
（持倉中誤判、掛單過期未撤單、SOL/PUMP卡住等）打斷，後續注意力轉向真倉
監控完善跟 CSV 複查。內容細節需要重新確認（原始討論已被壓縮，只留下標題），
**開始前先跟使用者確認範圍**，不要憑標題猜。

### B. `MAX_TOTAL_RISK_PCT=5` 在 live-runner 真倉路徑可能不是死碼

見下方 P2 #4——原本「死碼」判斷只看 route.ts 的候選篩選路徑（2%×2方向=4%
結構天花板碰不到5%），但 `tradeBridge.ts`（真倉監控）也在用同一個常數當
唯一全局風險上限，這條真錢路徑沒有那個 4% 結構天花板，5% 有機會真的被
用到。2026-08-12 提出，尚未查證真倉路徑目前的實際風險曝露情況。

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

### 4. `MAX_TOTAL_RISK_PCT = 5` 在 route.ts 候選篩選路徑是死碼，**但 live-runner 真倉路徑不一定是**
同向上限 2% × 兩方向 = 4% 結構天花板，5% 在 route.ts 那條路徑永遠觸不到。
要修得重新設計預算分配，不是改個數字。**2026-07-28 決定：先跳過**，不動——
但這個判斷只看了 route.ts。**2026-08-12 補充**：`tradeBridge.ts`（真倉監控
`decideTradeAction` 第1步）也在用同一個常數當唯一全局風險上限，這條真錢
路徑沒有那個 4% 結構天花板，5% 有機會真的被用到——先前「死碼」的結論在
真倉這條路徑上可能不成立，需要重新查證，不能直接套用舊結論。見 P1 #B。

### ~~5. 名額分配先到先得，非擇優~~ ✅ 已完成（`c1b46f6`，2026-07-28）
`for (const symbol of coins)` 按成交量排名跑，先觸發的幣拿走名額；
分數排序只發生在單一幣種內部。稀缺資源用抵達順序分配是最差的規則。

已改成兩階段：pass 1 掃描迴圈跑完整分析、收集所有合格候選（過每個幣種自己
的狀態關卡）；pass 2 依分數降冪排序後才依序判定同向上限、insert、推播——
分數高的候選先選，不再是掃描順序（成交量排名）先到先得。詳見 commit 訊息。

驗證：tsc/vitest(234)/build 全過；部署後手動觸發過一次，正常回應（實際
same_dir_cap/insert 路徑要等真的有多個候選同時競爭同向額度時才會被走到，
目前線上還沒遇到這種情況，邏輯本身已逐行核對與原本一致，只是換了執行時機）。

### ~~6. `isLimitOrder` 門檻 0.3% 可能過窄~~ 已調整（見 signals.ts，日期不詳，本文件未同步記錄）
現在是 `5m: ±0.3% / 15m: ±0.5% / 1h+: ±0.7%`（原本全部固定 ±0.3%）。
**2026-08-12**：還沒有漏斗數據驗證這個新門檻夠不夠寬，可以拿現有
`entryDistAtr` 資料查，暫列 P1 觀察，不算已結案。

### 7. `score_gate` 無影子模擬
漏斗 9%，是品質關卡裡唯一的量測盲區。
難點：sub-threshold 訊號沒有進場/止損價位可模擬，要先生成才能模擬。
**2026-07-28 決定：先跳過**——要改訊號產生函式加不受分數門檻限制的計算路徑，
牽動策略核心計分邏輯，風險與工作量都高於其他三項，不建議現在一起衝。
**2026-08-12 重新評估，結論不變**：系統雖然更成熟了，但這仍然是唯一一項
要動「訊號產生函式本身」而不是「加濾網」的項目，跟其他項目風險等級不同，
維持跳過、不跟其他調參項目混在一起做。

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

**2026-08-08 追加**：`MIN_SCORE_TIER_B` 再從 60 → 65（commit 訊息稱「B tier
名存實亡」——這個更動沒有留下對應的分析文件，只能從程式碼註解回推）。
**2026-08-12**：8/11 CSV（169筆）複查，B級（65分門檻後）整體還是打平
（-0.023R/30筆），但拆方向後發現不是門檻的問題——是 B 級做多結構性壞掉
（-0.268R/35%勝率/17筆），做空其實跟 A 級同水準（+0.297R/69%）。已經找到
並修好根因（見上方「已完成」：策略B做多補齊硬性放量門檻），不是門檻鬆緊
的問題，門檻本身先不要再動。

### 9. 策略 B 止損距離——2026-08-12 複查：不是系統性過窄，是症狀不一致
原始記錄（3筆）：SOL 0.43%、PEPE 0.81%、SUI 1.01%，當時判斷「1h圖0.43%是
雜訊等級」。8/11 CSV（105筆策略B交易）複查看到更完整的圖像：DOGEUSDT
0.42%（雜訊等級，真的直接-0.98R出場，原判斷成立）；但 ZEC/HYPE 多落在
1-2%（合理範圍）；AKE/GIGGLE/BANK/LA/COTI/BLESS 這類低價幣常常 10-12%
（ATR算出來的百分比自然放大，不是門檻設錯）。**不是同一個問題，不要用
同一個下限修**——DOGE那種真的太窄的案例存在，但多數幣種止損距離其實合理，
統一調下限會誤傷大多數正常的單。

### 10. 時間止損 8 根 K 線是否該放寬——影子模擬已上線，仍在等樣本
量測管道（P1 #1）已經在跑，`/api/reject-funnel`/`ScanStatusPanel` 有數字，
但**多少樣本才夠判斷、目前累積了多少**沒有留下記錄——下次要動這個參數前，
先去這兩個地方看目前的樣本數再決定夠不夠。

### 11. confidence 分數是否夠格當第二層濾網——2026-08-12 新增，樣本不足
`computeConfidence` 算出的 0-100 分從 8/4 就存在，純顯示不影響放行。
8/11 CSV 複查：confidence 切三桶（低/中/高）平均R分別 +0.045/+0.217/+0.181，
**沒有單調關係**，低桶反而不是最差——現在說它有沒有資格當濾網還太早，
`/attribution` 頁面已經有這個分析維度，之後樣本夠了直接去看。

### 12. TP1 前利潤階梯——前提條件未滿足，暫緩
`docs/ANALYSIS-2026-08-05-提升盈虧率的可動項目.md` 項目4：時間止損砍掉的單
有一半曾經有像樣的浮盈卻完全沒保護。建議排序是「等 TP1 後移動止損（ATR倍數）
先驗證完 10+ 筆樣本，再考慮加這層，避免兩層保護互相干擾看不出各自效果」。
**前提條件（10+ 筆移動止損樣本）到 2026-08-12 為止還沒滿足**，開始前先確認
樣本數夠了沒。

---

## P3 — UI 殘留（低優先）

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

---

## P4 — 已知偏離，刻意不修

- **funding-crowding 只扣 confidence 不扣分數** — 規格 §4.2 要求扣分。未驗證前不收緊。
- **限價單被暴力突破時 fill-then-stop** — 目前 fill-on-touch 會成交然後止損，而非取消。開放設計題。

---

# 自動化交易（Binance API）— testnet 已上線，不再是「獨立專案」規劃階段

> 討論於 2026-07-26，下面決策點/上線順序/安全控制清單那時候寫的，
> **內容已大幅過時**——`scripts/live-runner.ts` 現在是真的常駐在跑的腳本，
> 已經在 testnet 上真的下單、監控、關單一段時間了，不是「還沒決定執行引擎
> 放哪」的規劃階段。這份文件底下的內容留著當歷史脈絡，**不要照著上面的
> 「決策點（未定）」「上線順序」字面意思行動**，那些多半已經定案並實作完了。
>
> 2026-08-12 現況：live-runner 重啟後撞到一個新 bug（`setLeverage` 送小數
> 槓桿被拒絕，已修，見上方「已完成（2026-08-12）」）——這代表這支腳本裡
> 這幾週陸續加的資金安全/清理/細分邏輯，很多都還沒被真的跑到過，之後每次
> 它碰到新分支都可能冒出類似的「第一次真的執行才會炸」的問題，需要持續
> 盯著 log，不能假設已經穩定。
>
> 要了解 live-runner 現在實際做到哪裡，直接讀 `scripts/live-runner.ts` 檔頭
> 的功能說明（每次改動都有更新），比讀下面這份 7/26 的舊規劃準確。

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
| `orderLifecycle.ts` | TP1 部分平倉／移動止損改單的下單決策（純函數） | 15 |
| `pendingOrderLifecycle.ts` | 部分成交感知的撤單規劃 + 撤單/成交競態裁決（純函數） | 15 |
| `runner.ts` | 執行編排骨架：串 preTradeCheck/orderLifecycle/pendingOrderLifecycle/watchdog/killSwitch 成一輪循環 | 15 |

**2026-08-06（`9beb89a`）**：接續 `db5811d`，補齊 §三/§五 剩下部分。
`pendingOrderLifecycle.ts` 的 `resolveCancelOutcome` 是撤單/成交競態的
唯一裁決點——Binance 對「剛好成交」跟「早就不存在」的訂單撤單都回
`-2011`，兩者外觀相同，硬當「取消成功」處理正是文件點名的風險，這裡
強制呼叫端先重查 `positionRisk` 才能判斷，沒給重查結果就回 `ambiguous`，
拒絕用猜的。`decidePendingOrderCancelPlan` 處理部分成交：`executedQty>0`
時撤單只清未成交餘量，已成交部分是真倉位需要補止損，不是取消。

`runner.ts` 是執行層編排骨架，把上面五個模組串成一輪監控循環——刻意
「不」碰策略判斷（訊號評分、要不要取消掛單、移動止損目標價怎麼算，
這些完全不動，還是 route.ts 現有的 candle-scan 邏輯），只負責「已經
決定要做的事，怎麼安全地對交易所執行」。依賴注入（`RunnerClient` 介面），
測試用記憶體假 client。kill switch 讀取失敗時 fail closed；watchdog
對帳在 kill switch 啟動時仍照跑；移動止損新單失敗時絕不觸碰舊止損單。
**依然沒有接上任何 Next.js route 或 cron**——執行引擎放哪還沒定案，
這是給未來獨立 process 呼叫的編排邏輯，不是給現在的 App 用的。

**2026-08-06（`db5811d`）**：`docs/ANALYSIS-2026-08-06-自動交易缺口清單.md` §三
點名的 11 種結局裡，挑最危險的兩項先做成純函數——`decideTp1PartialClose`
（reduceOnly 平倉數量，stepSize 無條件捨去，clientOrderId 固定用 tradeId 防重複
平倉）、`decideTrailingStopReplace`（撤舊單+掛新單的順序決策：**先掛新、再撤舊**，
兩張 closePosition 單短暫並存是安全的——先觸發那張會平倉，另一張之後對空倉
觸發只會報錯，不會二次出場；反過來先撤後掛，掛單一失敗就是真裸倉）。只往
有利方向棘輪、目標價沒有更好時直接拒絕改單。順便補了 `vitest.config.ts`
的 `@/` alias（第一次有 `src/engine` 需要 cross-import `src/lib`，之前
vitest 完全沒設定過，所有測試都繞開這條路用相對路徑）。

**還沒做、真錢上線前必做**：
- watchdog 的輪詢迴圈本體（reconcile 邏輯有了，`runner.ts` 也會呼叫，但
  「每 30 秒跑一次」的常駐 loop 包裝還沒寫——`runner.ts` 目前是「跑一輪」
  的函式，不是常駐程序）
- kill switch 觸發後的實際 flatten 動作（現在只設 flag，沒有一鍵撤單平倉；
  `runner.ts` 讀到 active 會跳過新動作，但不會主動平倉）
- ~~部分成交、取消/成交競態的處理~~ 決策邏輯已完成（`pendingOrderLifecycle.ts`），
  **`npm run testnet-reconcile` 腳本已寫好（`scripts/testnet-reconcile.ts`），
  但還沒有人實際跑過**——`extractBinanceErrorCode` 假設的錯誤回應格式
  （`error.response.data.code`）是照 Binance 文件推的，沒對過 testnet 的
  真實錯誤形狀。腳本會走一輪開倉→補止損→平倉的完整流程，15 個 ✅/❌ 檢查點，
  其中第 8 步專門驗證真實 -2011 的格式。使用需要自己在 demo.binance.com
  （官方整合式 Demo Trading，用一般幣安帳號登入，不是舊版獨立的
  testnet.binancefuture.com/GitHub 登入那個）申請 API key，設定成環境變數
  跑 `npm run testnet-reconcile [SYMBOL]`——下單這件事即使是假錢也刻意
  不代為執行，跑完把輸出貼回來，有 ❌ 再一起看。2026-08-06 查證：
  binanceClient.ts 的 base URL 已改成 `demo-fapi.binance.com`（照
  Binance 官方文件 usds-margined-futures/general-info 確認的目前版本，
  跟舊的 testnet.binancefuture.com 是不同網域）
- **策略層還沒接進 runner**：`runner.ts` 吃的是「已經決定好的動作」
  （`pendingCancels`/`tp1Closes`/`trailingStopUpdates`），這些動作現在
  誰來產生完全沒寫——route.ts 的 candle-scan 判斷邏輯（該不該撤單、
  移動止損目標價多少）還沒有一個「餵給 runner」的橋接層
- DB 整合——runner 不碰 Supabase，「這一輪要處理哪些 trade」的讀取/
  寫回完全還沒設計
- testnet 對帳（`extractBinanceErrorCode`/整個 runner 都要在這裡驗證）
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
3. testnet（`demo.binance.com` / API base `demo-fapi.binance.com`）
   跑到對帳零誤差 ← **下一步**（`npm run testnet-reconcile` 已寫好，待執行）
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

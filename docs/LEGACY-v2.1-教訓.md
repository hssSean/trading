# 舊 v2.1 評分策略的調參史與實作教訓

2026-10-12 從 CLAUDE.md 搬出（策略已於 2026-10-07 停開新倉、10-12 程式碼移除）。文中提到的腳本與模組（funnel-verdict、verify-strategy、strategy-candidates、sr-mechanism、real-trades-breakdown、shadowSim、tradeBridge、dailyLossCap、tradeCooldown、circuitBreaker…）都已刪除，要找回：`git checkout legacy-v2.1-final -- <路徑>`。

**為什麼還留著**：這些是「測過、沒用」的紀錄。S3／S1 或之後的策略要做類似的事（加濾網、調止損、看拒絕漏斗）之前先讀，很多「看起來該改」的東西在這裡已經驗證過無效；量測陷阱（假的悲觀值、被灌水的 n、機械效果冒充發現）也同樣適用。

- **調參紀律（規格書 §4）**：一次只動一個濾網，先看拒絕漏斗與影子模擬的淨 R 數據再決定放寬或收緊；淨 R ≤ 0 的關卡代表擋得對，不要動。
  - **看漏斗淨 R 之前先看悲觀覆蓋率**（`npm run funnel-verdict` 會自動把關）。`29b2499` 之前結案的影子單永遠沒有悲觀值，`netRPess` 是 0，而 0 會讓「兩端同號」的判斷失效——樂觀 +24 配悲觀 0 看起來像跨零，實際上只是沒算。2026-09-01 實測八道關卡只有 `circuit_breaker` 覆蓋率達標。
    - **⚠ 2026-09-20 發現：那一整個月的悲觀值本身就是假的，不要相信 2026-09-20 之前的任何漏斗判語。** `SHADOW_PESSIMISTIC` 於 2026-08-26 因 CPU 改成預設關閉，但 `simulateShadow` 關閉時**仍然會寫 `pessResult`**——樂觀軌跡結案時直接複製過去。於是 `netRPess ≡ netR`，「兩端同號」永遠成立，把關等於不存在。報表上 `circuit_breaker` −7.08／−7.08、`btc_direction` −7.00／−7.00 兩端完全同值就是這個簽名：**同值不是「結論穩健」，是「根本沒算」**。
    - 已修（`src/lib/shadowSim.ts`）：悲觀軌跡改預設開啟（成本是對已抓回的 K 線多跑一次純比較迴圈，微秒級；貴的是 `fetchCandles` 的 I/O，兩條軌跡本來就共用）；關閉時一個欄位都不寫，寧可覆蓋率 0 也不要假數字；`EXPIRED` 補上 pess 欄位（兩邊 R 都是 0，本來就該算進覆蓋率，`score_gate` 只有 49% 主因是這個）。Redis 既有的 75 筆假值已用 `scripts/reset-shadow-pess.ts --apply` 清掉。
    - **覆蓋率要約兩週才會重建。在那之前任何濾網都不要動。**
  - **2026-09-24 獲利驗證：扣成本後每筆 −0.055R（t=−2.40，12 個月 n=2079），策略 B −0.514R（t=−4.34）。** 毛邊際 ~+0.02R 小於成本 ~0.08R。詳見 `docs/ANALYSIS-2026-09-24-策略獲利能力驗證.md`。
  - **2026-09-27 決定：修改不換。策略 B 與做空預設關閉**（`ENABLE_STRATEGY_B=1`／`ALLOW_SHORT=1` 可開）。修改後 −0.007R/筆、CI 跨 0，仍測不出正邊際。另外 10 種趨勢跟隨候選在 4.7 年 × 30 檔上全部沒過事先訂的標準，純做多的獲利集中在 2023–24 牛市。**不要再試「另一組技術指標」**，詳見 `docs/ANALYSIS-2026-09-27-修改還是換策略.md`，重跑 `npm run strategy-candidates`。
  - **2026-10-01：只有 1h 能進場（`ALLOW_LTF_ENTRY` 預設關）。** 原本 ⚡15m 短線單與 Entry-TF fallback 會讓 5m/15m 頂替 1h 進場，這條路從沒被回測驗證過；當週 1h +73.6 USDT、5m/15m −89.7 USDT。5m/15m 仍掃描、仍參與 confluence。詳見 `docs/ANALYSIS-2026-10-01-週虧損檢查.md`。看某段期間的真實成交用 `real-trades-breakdown.ts --since=YYYY-MM-DD`。
  - 2026-10-03 的紙上追蹤（策略 A、影片 A/B/C）與 2026-09-28 的 F1 前向追蹤已於 2026-10-07 停用（見上方「已換成 S3／S1」）。
  - **2026-09-27B 結構性資訊也測過了：** 資金費率極端值（F1）、費率橫向排序（F3）、爆倉急跌接多（L1）三個都沒過。F1 在 2 批幣 10 個年度都贏過無條件做多（有弱資訊），但第三批幣扣成本後 −0.013R，不能單獨上線。詳見 `docs/ANALYSIS-2026-09-27B-結構性資訊候選.md`。
  - **回測規則只有一份：`scripts/lib/liveReplica.ts`。** 不要再在腳本裡複製 regime／掛單／出場邏輯——2026-09-24 查出 backtest／exit-compare 的複製品九處跟線上分岔。
  - **訊號與 regime 只吃已收盤 K 棒**（`closedCandlesOnly`）。快取以最後一根 openTime 為 key，吃形成中 K 棒會把「開盤幾分鐘」的答案凍結整根（42% 時點訊號不同）。
  - **目前狀態：不要調參。** 真實成交 n=78 每筆 −0.081R、t=−0.55，跟三層模擬結論一致（測不出邊際）。檢定力 sd=1.31，偵測 +0.1R/筆 需 n≈680。詳見 `docs/ANALYSIS-2026-08-30-真實成交對帳.md`。
  - **止損距離下限也測過了，無效（2026-09-07）。** 策略 B 沒有下限、止損可以近到 0.103%，看起來很像該修——但 clamp／skip 兩種修法各四個門檻全部 `|t| < 1`，而且 3個月×8檔時最強的變體 t=2.59，6個月×15檔重跑後掉到 t=−0.02 且符號翻面。要動之前先讀 `docs/ANALYSIS-2026-09-07-止損距離下限.md`；那份也記了一個容易誤讀的陷阱：報表的 `n=1473` 是假的，真正受影響的只有 22–77 筆（其餘訊號對成對差異貢獻 0，同時放大 n 又縮小 sd，t 值反而不動）。
  - **S/R 阻力位測不出資訊量，TP1 那段夾持不用救（2026-09-07B）。** `buildSignalLevels` 的「TP1 被最近阻力夾住」對 1h/4h/1d 是**死碼**——swing 分支的 `tp1Max` 與 `MIN_RR_SWING` 同為 2.0R，`max(min(阻力,2R),2R) ≡ 2R`，而系統 98% 的單是 1h。看起來很該修，但置換檢定（n=85，洗牌 3000 次）三個指標 p = 0.74／0.20／0.14 全不顯著，觸及率真實值還**低於**隨機。詳見 `docs/ANALYSIS-2026-09-07B-阻力位資訊量.md`，重跑 `ENV_FILE=env.txt npx tsx scripts/sr-mechanism.ts`。**這關掉了第五個參數家族。**
    - 那份示範了一個省時間的做法：**先用置換檢定問「機制存不存在」，過了才排隊跑走K線模擬**。機制檢定吃現成的 MFE 資料、幾分鐘就好；模擬要十幾分鐘，而且會把「結構有用」跟「目標變近」混在一起分不開。
    - 陷阱備忘：報表裡「TP1 夾到阻力觸及率 36.4% vs 維持 2R 的 20.8%」看起來像重大發現，其實是**目標從 2.0R 挪到 1.16R 的機械效果**——隨機給一個阻力位也做得到同樣的事。觸及率變高 ≠ 淨 R 變高。
  - **「手續費占 R」不是統計問題，是算術**（`費率% ÷ 止損距離%`）。要分清楚「這筆成本高」與「改了會比較好」——前者除法就能證明，後者得實測，而實測通常是測不出來。
- **倉位的絕對金額要另外把關**：所有風控上限都是 R 或百分比，唯獨 `dailyLossCap` 與 `calcPositionPlan` 的名目上限是用「錢」衡量的。名目 = 風險金額 ÷ 止損距離，**止損距離趨近 0 時名目會爆炸，而每一道 R 上限都不會有反應**（那個部位「就是 1R 風險」）。`checkLiquidationSafety` 也攔不到——槓桿 10 倍時強平距離約 10%，極近的止損確實會先觸發，它會判定通過。
- **平倉數量取整不能留灰塵**：2026-09-06 把保護單從 `closePosition=true` 改成 `quantity + reduceOnly`（UNI 翻倉的修法）之後，出場量才開始經過 `roundToStepSize`，而它原本的 `Math.floor(qty / stepSize)` 會被浮點誤差削掉一整格（`16.24 / 0.01 = 1623.9999999999998`；step 0.01 有 9.1%、step 0.001 有 12.9% 的合法數量會中）。少平一格 = 部位永遠不歸零，**下游全部跟著錯**：殘渣被判成 TP1（假的 `tp1_hit` + 假的 TP1 推播）、灰塵帶著止損繼續跑十幾小時、最後把保本出場記成完整 −1R。2026-09-08 已修（`precision.ts` 補 1e-9 容差、`didTp1PartialFill` 補 25% 下界），但**任何新的「算數量」路徑都要記得這件事**。
- **風控查詢要排除「有 `result` 但不是交易結果」的列。** `CANCELLED`（掛單到期撤銷，實測佔 trades 表一半以上）與未平倉的 `tp1_hit`（`result='WIN_TP1'`、`closed_at=NULL`，而 Postgres `ORDER BY ... DESC` 預設 **NULLS FIRST**，會排到最前面）兩種都會擠掉真正的交易紀錄。2026-09-20 實測有三處中招且全部 fail-open：`checkStratBPaused` 的連兩敗、熔斷的連敗 streak、以及回撤／熔斷吃到 `audit_verdict≠OK` 的捏造損益。判定一律抽成純函數（`tradeCooldown.isStratBPaused`、`circuitBreaker.*`、`cleanPeriod.isAuditClean`），**函數自己再過濾一次、自己重排，不依賴呼叫端的 SQL 有沒有寫對**。
- **條件單「觸發」不等於「成交」**：幣安條件單觸發後可能被拒絕（`algoStatus=REJECTED`，`rejectReason` 見 `getAlgoOrderHistory`）。2026-09-20~23 UNI 一檔被 `Reduce only reject` 拒絕 13 次（止損、TP1、TP2 都有），另有 PERCENT_PRICE（testnet 流動性薄）。被拒絕的單會從 openAlgoOrders 消失，但 DB 的 algoId 還在——**「不見了」要當成「可能被拒絕」處理**，不能當成「已成交」或「不用管」。2026-09-23 起 `decideTradeAction` 會補救（止損補在最後已知價位、價格已穿過就市價平倉；TP1/TP2 重掛），`npm run audit-close-fills` 會列出所有 REJECTED。
- **`place_initial_stop` 不只在剛成交時發生**，止損被拒絕後的補掛也走這條。任何寫在那裡的「成交副作用」（`markFilled`）都必須冪等，否則每補一次就重設 `filled_at`（時間止損永遠不觸發）、把 `tp1_hit` 改回 `active`（重複推播假 TP1）。
- **「部位變小」不等於「TP1 發生」**：手動平倉（這個帳戶會用手機 App 直接下單）、ADL、部分強平、取整灰塵都會讓部位變小。判準統一走 `tradeBridge.didTp1PartialFill`，別在別處重寫 `positionQty < entryQty * 0.99`。

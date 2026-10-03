# 紙上部署：策略 A（日線 Keltner）＋影片策略 A/B/C

> 2026-10-03。規格來源：`C:\trading_stratage\docs\策略A_自動交易規格.md`、`影片策略_自動交易規格.md`；
> 參考實作：同目錄 `engine.py`、`strategies.py`（keltner）、`scan.py`、`yt_strats.py`、`ict_engine.py`、`msnr.py`。
> 使用者授權由 Claude 決定所有設計問題。

## 決定

| 問題 | 決定 | 理由 |
|---|---|---|
| 真單或紙上 | **四套全部紙上**，不下任何單 | 兩份規格都要求先紙上；影片策略規格明說回測無優勢 |
| 影片策略範圍 | A、B、C 三套主版本（不跑變體） | 變體與主版本差異小，多跑只增加運算與多重比較 |
| 跑在哪 | Vercel 新路由 `/api/paper`，Vercel cron 每日 00:20 UTC | 決策都在已收盤 K 線上，紙上不需即時；不必使用者重啟任何東西 |
| 狀態 | Redis：訂單一產生就凍結參數；每天推進成交／出場；結束後凍結 | 用近期視窗重算指標時，舊訂單不會因暖機長度不同而漂移 |
| 持倉上限 | 紀錄不套上限；策略 A 報表另算「上限 10 筆」 | 才能跟規格的回測數字（不設上限）直接比較 |
| 成本 | 照參考實作：策略 A 每邊 0.07%；影片：限價 0.02%、市價／止損／時間出場 0.07%、止盈 0.02%；皆加實際資金費率 | 與回測同口徑 |

## 元件

- `src/lib/paper/ind.ts`：EMA（span）、Wilder ATR、分形擺動點 `lastSwing`、`bosState`。
- `src/lib/paper/keltner.ts`：策略 A 訊號＋單筆模擬（1H 走止損／1R 部分止盈，日線收盤跌破 EMA20 隔日開盤出場）。
- `src/lib/paper/video.ts`：影片 A/B/C 訂單產生器（1H/4H/1D、時間戳對齊「已收盤」）＋ `runOrders` 執行（照 `ict_engine.simulate`，以 1H 執行）。
- `src/lib/paper/universe.ts`：近 30 日平均成交額前 N（排除股票、商品、穩定幣）。
- `src/lib/paper/runner.ts`：抓資料、產生新訂單、推進未結束訂單、寫 Redis（依賴注入，可單元測試）。
- `src/app/api/paper/route.ts`：cron 入口。
- `scripts/paper-acceptance.ts`：對兩份規格的驗收 CSV 逐筆比對（上線前必須通過）。
- `scripts/paper-report.ts`：四套策略分開的績效報表，含規格的停止條件。

## Redis

`paper:<strat>:open`（hash，未結束的紀錄，執行器讀寫）、`paper:<strat>:done`（hash，已結束，只寫；報表讀）、
`paper:meta`（<job>.lastT、<job>.lastRunDay、trackStart、busy:<strat>:<symbol>）、`paper:univ`（day → 當日幣池）。

## 驗收

- 策略 A：BTC/ETH/SOL 2024-01～2026-08，signal_day／entry_day 100% 相同、stop 誤差 < 0.5%、gross_R 誤差 < 0.05R。
- 影片 A/B/C：ETHUSDT 2025-06，訂單時間、方向、價格、止損、止盈相同（誤差 < 0.1%）。
  參考實作以 5 分鐘 K 線執行、本實作以 1H 執行，成交與出場欄位可能不同，不列入判定。

## 實作結果（2026-10-03）

- 驗收：策略 A 36/36 筆完全一致（stop 誤差 0.000%、gross_R 一致）；影片 A/B/C 參考表 24/24 筆
  訂單一致。參考 CSV 每套只列前 8 列（strat_a 先跑完做多才跑做空，所以 A 的 8 筆全是做多），
  本實作多出的訂單都在參考表截斷之後。以 1H 執行的成交／出場結果也與參考（5 分鐘）24/24 相同。
- 參考實作照抄的怪處：影片 A 做空時「波段起點被破」用的是 `l[j]`（規格寫應該反過來用高點），
  為了對上驗收照原樣移植，註解在 `video.ts`。
- 排程改為掛在 `/api/analyze`（外部 cron 每 5 分鐘一定會打），每天 UTC 00:20～06:00 之間：
  第一次掃描跑 strategyA、下一次跑 video；`/api/paper` 留作手動觸發。原因：Vercel 的
  `CRON_SECRET` 是否設定無法確認，新增 Vercel cron 可能 401 而靜默不跑。
- 本機試跑（回溯 4 天）：strategyA 2.0 秒、video 4.5 秒。
- 指令：`ENV_FILE=env.txt npm run paper-run -- all`（從本機立刻執行／補跑，寫線上 Redis）、`npm run paper-acceptance`（驗收）、`ENV_FILE=env.txt npm run paper-report`（報表）、
  `npx tsx scripts/paper-dryrun.ts [天數]`（本機試跑，不碰線上 Redis）。
- 第一次執行只記起點；第一筆紀錄最快在起點的隔天。

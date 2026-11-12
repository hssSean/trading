# CTREND 前向驗證週帳本 — 設計

2026-11-13。背景：研究端重現 Fieberg 等（JFQA 2025）的 CTREND 橫截面趨勢因子，2023-01～2026-10 回測扣成本後 +0.81%/週（t 1.83，Sharpe 0.94），沒達到事先訂的 t > 2.5，但前後兩半都為正，是目前唯一在論文發表後的新資料上仍為正的候選（研究端 `docs/試驗登記表.md`、`ctrend.py`）。不調參數再回測，改做前向驗證。

## 目標與非目標

- 目標：每週一用固定規則算 CTREND、記一筆模擬多空組合的報酬，累積到能判斷為止。
- 非目標：不下單、不接 testnet、不改任何現有策略（S3／S1／BR）、不在 Vercel 計算。

## 規則（凍結，等於回測 `ctrend.py`）

- 幣池：USDT 計價、`PERPETUAL`、`underlyingType` 為 `COIN`／`PREMARKET`（同 `isCryptoPerp`），上市（有日線）≥ 200 天，過去 30 天平均成交額 ≥ 100 萬美元。
- 指標（28 個，日線，資料到週日收盤）：rsi14、stochK14、stochD、stochRSI14、cci20、sma{3,5,10,20,50,100,200}/收盤、macd、macd−訊號、volsma{3,5,10,20,50,100,200}/當日成交額、volmacd、volmacd−訊號、chaikin20、布林下／中／上/收盤、布林寬。
- 每週橫截面排名轉 [−0.5, 0.5]；每個指標做「成交額加權」單變量橫截面迴歸，係數取前 52 週平均得到該指標的預測；用前 52 週的預測與報酬做合併 elastic net（l1_ratio 0.5，λ 依 AICc），保留 θ > 0 的預測取平均＝CTREND（沒有保留就全取）。
- 組合：CTREND 五分位，最高組做多、最低組放空，各腿以過去 30 天成交額加權，週一 00:00 UTC 開盤進、下週一開盤出。
- 成本：每邊 0.07% × 換手；資金費照實際（做多付、放空收）。
- 主要追蹤「全部合格」；「成交額前 100」只記錄。

## 架構

```
EC2 systemd timer（每週一 01:30 UTC，Persistent=true）
  └─ research/ctrend/ctrend_forward.py（Python venv）
       ├─ 幣安公開 API：exchangeInfo、1d klines（limit 1000）、fundingRate（上一週）
       ├─ ctrend_core.py：指標 → 迴歸 → elastic net → 組合（純函式）
       └─ Upstash REST：寫 ctrend:*
Vercel
  ├─ /api/s3/ledgers：讀 ctrend:meta、ctrend:open、最近 N 週 → 帳本頁卡片
  └─ /api/analyze：每天檢查 ctrend:meta.lastRun，> 9 天沒更新就推播
本機：npm run status 印一行 CTREND（> 8 天沒更新顯示 ⚠）
研究端：ctrend.py 改為 import tradding_app/research/ctrend/ctrend_core.py（只有一份算法）
```

和 live-runner 是不同程序；CTREND 失敗不影響真倉。

## 每週流程（ctrend_forward.py）

1. 讀 `ctrend:meta.lastWeek`；從下一個週一起，對每個「已經開盤的週一」依序處理（漏跑就補）。
2. 抓所需資料（一次抓 1000 天日線，供所有補算週使用）。
3. 結算上一週持倉：用本週一開盤價算各腿報酬，扣手續費（依新舊權重的換手）與該週資金費 → 寫一筆週紀錄。
4. 用到本週日收盤的資料算 CTREND，組本週持倉 → 寫 `ctrend:open`。
5. 更新 `ctrend:meta`（lastRun、lastWeek、週數、平均淨報酬、t、版本）。
6. 本機 CSV 副本：`research/ctrend/out/weeks.csv`（不進版控）。

起點：2026-10-26（回測資料只到 2026-10-19 那週，之後是沒看過的資料）。

## Redis 鍵（每次執行只寫幾個指令）

- `ctrend:meta`（JSON）：`{ lastRun, lastWeek, weeks, meanNet, tNet, startWeek, version }`
- `ctrend:weeks`（hash，週一日期 → JSON）：`{ wk, gross, net, fund, turnover, nLong, nShort, nUniverse, kept, top100: { gross, net } }`
- `ctrend:open`（JSON）：本週持倉 `{ wk, long: [[sym, w]], short: [[sym, w]] }`

## 錯誤處理

- 任何一步失敗：不寫 meta（下次照樣從 lastWeek 繼續補算），程式以非零結束碼結束，systemd 會記錄。
- 單一幣的資料抓不到：該幣該週不納入幣池（記在週紀錄的 `skipped` 數）。
- 告警：status 與推播看的是 `lastRun`，所以「整週沒跑」一定會被發現。

## 判定（寫進研究端登記表，事先訂）

- 前 26 週不看結果、不調整。
- 滿 52 週：扣成本平均每週 > 0 且 t > 1.5 → 才考慮小額試行（要另外設計與登記）；平均 ≤ 0 → 結案；介於中間 → 累積到 104 週再判。

## 測試

- 一致性驗收（本機一次）：用研究端完整資料（`data/ext`）跑 `ctrend_core`，逐週比對研究端 `results/ctrend.pkl` 的 gross／net，誤差 < 1e-9。
- Python 單元測試（`research/ctrend/test_core.py`，pytest）：假資料檢查排名轉換範圍、加權迴歸、elastic net 只保留 θ > 0、五分位與權重加總。
- App（vitest）：卡片計算函式；告警函式（沒資料／剛更新／超過 9 天）。
- `npx tsc --noEmit`、`npx vitest run`、`npx next build`。

## 部署

- `deploy/ctrend.service`、`deploy/ctrend.timer`、`deploy/install-ctrend.sh`（建 venv、裝 `research/ctrend/requirements.txt`、安裝並啟用 timer、手動試跑一次並印出結果）、`docs/EC2-ctrend.md`。
- 使用者在 EC2：`git pull` → `bash deploy/install-ctrend.sh`，把輸出貼回來確認。
- 使用者名稱與路徑照 `docs/EC2-live-runner.md` 的寫法，標出要照實際修改的地方；Redis 金鑰沿用 live-runner 的環境變數檔。

# 待辦清單

> 最後更新：2026-11-12（重寫）。舊版（到 2026-08-30，幾乎都是已移除的 v2.1 評分策略）搬到
> `docs/TODO-legacy-v2.1.md`，其他文件裡「見 TODO.md 某節」指的是那一份。
> 排序依「該不該現在做」。**樣本不足的事刻意不做**——動了也分不出是改對還是雜訊。

## 🔴 需要人工執行（Claude 做不到）

1. **EC2：`git pull` 並重啟 live-runner**（避開台灣 08:00～10:00）。還沒生效的修正：
   - 2026-11-11 稽核：進場送單逾時仍接手管理、止損判定只認平倉方向的止損單、孤兒條件單只撤自己的、
     設逐倉只吞 -4046、啟動檢查持倉模式、有倉沒止損推播。
   - 2026-11-12：絕對金額硬閘（`S3_MAX_DAILY_LOSS_USDT`、`S3_MAX_NOTIONAL_USDT`，testnet 可不設）、
     幣池只收加密貨幣合約（`isCryptoPerp`）。
2. **註冊「研究端新資料追蹤」排程**（Claude 的權限不允許建立排程）。用系統管理員身分開 PowerShell 貼上：
   ```powershell
   $a = New-ScheduledTaskAction -Execute 'C:\trading_stratage\run_monthly.cmd'
   $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 10:30
   $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
   Register-ScheduledTask -TaskName '研究端新資料追蹤' -Action $a -Trigger $t -Settings $s
   ```
   沒註冊的話每月初手動雙擊 `C:\trading_stratage\run_monthly.cmd` 也可以。
3. **EC2 改用 systemd 讓 live-runner 自動重啟**：照 `docs/EC2-live-runner.md`（可以跟第 1 項的重啟一起做）。
4. **EC2 安裝 CTREND 前向週帳本**（2026-11-13）：`cd ~/tradding_app && git pull` → `bash deploy/install-ctrend.sh`，
   輸出整段貼回來確認（`docs/EC2-ctrend.md`）。不用重啟 live-runner。
5. **換 webhook secret**：舊文件記錄它是 `abc123`，而且放在 cron 網址的 query string。testnet 期間沒有
   財務風險；轉主網前換成隨機長字串並改用 `x-webhook-secret` header。順序：先設 Vercel 環境變數 →
   等重新部署 → 再改 cron-job.org。

## 🔴 轉主網之前必須完成

條件已預先登記在 `C:\trading_stratage\docs\轉實盤條件_預先登記.md`（主網 500 USDT、只跑 S3-A）。程式面：

- [x] 絕對金額的單日虧損上限、單筆名目上限（2026-11-12，`s3aLive.ts` `S3aCtx.limits`）。
      **主網必設**兩個環境變數；`--live` 開放時要加「沒設就 exit」的檢查（`live-runner.ts` 檔頭已註明）。
- [x] 一鍵全平：`ENV_FILE=env.txt npm run flatten`（預覽）／`-- --yes`（執行）／`-- --resume`（解除 kill switch）。
      **還沒在有持倉的情況下實際演練過**——下次 testnet 有 S3 持倉時演練一次（任務書 §10）。
- [ ] API 金鑰：關閉提幣、綁 EC2 的 IP。
- [ ] 用 `/fapi/v1/commissionRate` 查實際手續費，對照回測假設（每邊 0.07% 含滑價）。
- [ ] 換 webhook secret（見上）。
- [ ] `flatten.ts` 與 `live-runner.ts` 目前都寫死 testnet，主網開放時一起改。
- [ ] live-runner 在 EC2 上的自動重啟：設定與步驟已寫好（`deploy/`、`docs/EC2-live-runner.md`），**還沒在機器上套用與驗證**。

## 在等樣本的（不要提前下結論、不要提前調）

| 項目 | 現況（2026-11-12） | 判定點 |
|---|---|---|
| S3 真倉 | 10/07 上線以來 0 筆：BTC 在日線 EMA50 之下，設計上不開倉 | BTC 回到 EMA50 之上才有單 |
| S3 分數影子（`s3s1:s3x`） | 2 分 0 筆、被擋 2 筆 | 30 筆 |
| BR 空頭反彈做空帳本 | 13 筆 +0.21R | **100 筆**：平均 R > 0 且訊號日 t > 1 才考慮接 testnet 真倉；≤ 0 結案（研究端登記表 2026-11-12） |
| S3 × FOMC 標記（`ind.fomc`） | 只標記不擋單 | 新資料累積後再看 |
| S1 帳本 | 19 筆 −0.08R；標為實驗性、不轉實盤 | — |
| CTREND 前向週帳本（`ctrend:*`，EC2） | 2026-11-13 建好，等 EC2 安裝；起點 2026-10-26 | **前 26 週不看**；52 週：平均淨 > 0 且 t > 1.5 才考慮小額試行（另外設計與登記），≤ 0 結案，中間累積到 104 週（研究端登記表 2026-11-13） |

研究端新資料（`fresh_oos.py`，2026-09～10）：S3 分數 2 有 11 筆、平均 −0.36R（9/22 一天 6 筆、5 筆止損）。
`s3_fresh_check.py`：若回測為真，5 個進場日合計 ≤ −4.0R 的機率約 4～5%（回測自己的歷史裡 7% 的時段這麼差）；
若完全沒有優勢約 45%。**警訊但非定論**——不改規則、testnet 照跑；主網的決定要等新資料累積。`npm run status` 會印最新摘要。

## 例行

- **每月初**：研究端 `run_monthly.cmd`（排程註冊後自動）補資料並更新 `s3s1:fresh`；看 `reports/monthly/<月份>.md`，把重點加進試驗登記表。
- **每月**：`ENV_FILE=env.txt npm run s3s1-report`（月報）。
- **2027 年 1 月**：核對 `src/lib/s3s1/rules.ts` 的 `FOMC_DAYS`（2027 的日期是憑暫定日程寫的）。

## 可以做、不急

- 研究端：CPI／非農的事件檢驗（需要可靠的歷史公布日曆；FOMC 與「BTC 衝擊日」已測，見登記表 2026-11-12）。
- 研究端：對 S3-A 算依試驗次數調整後的門檻（累計試驗已超過 2,000 組）。
- 再清一輪舊策略殘留：`/api/reset`、`/api/scan-status`、`/api/trade-status`、`/api/trade-export`、`/api/reject-funnel`
  只剩 `/legacy` 頁與設定頁在用；`src/lib/drawdownHalt.ts` 已沒有任何地方引用（只剩測試）。
- 稽核任務書（`docs/trading-system-audit.md`）第 14 節的事件行事曆／斷路器：FOMC 只夠做標記；
  市場反應型斷路器（BTC 衝擊日）回測對三個策略都沒用，**不做**。

## 已結案、不要再試（細節在研究端 `docs/試驗登記表.md`）

- ICT／SMC／SNR（5 分鐘～4 小時，1,800 多組）；SNR 故事線修正前視錯誤後不達標。
- 空方突破、恐慌買反彈、新上市做空、橫截面多空、BTC／ETH 動量做空、BTC 對沖突破。
- S3 擴大幣池（前 30／50／100）、BR 加分數、S1 出場微調、S1 廣度濾網。
- 資金費套利：紙上通過，但獲利來自沒有現貨可對沖的小幣；大幣近兩年年化 0～1%。
  重啟條件：取得現貨價格資料並限定「幣安有現貨」的幣重測。
- 需要付費資料的（未平倉量／清算事件）：使用者 2026-11-12 決定先不做。

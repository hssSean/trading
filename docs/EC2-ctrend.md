# EC2 上的 CTREND 前向週帳本

每週一 01:30 UTC（台灣 09:30），EC2 的 systemd timer 跑 `research/ctrend/ctrend_forward.py`：
結算上週的模擬多空組合、算本週的 CTREND 分數與新持倉，寫進 Upstash（`ctrend:meta`／`ctrend:weeks`／`ctrend:open`）。
**只記帳、不下單**，跟 live-runner 是不同程序，失敗不影響真倉。設計：
`docs/superpowers/specs/2026-11-13-ctrend-forward-ledger-design.md`；判定標準在研究端 `docs/試驗登記表.md`。

## 第一次安裝（兩行）

```bash
cd ~/tradding_app && git pull
bash deploy/install-ctrend.sh
```

腳本會：建 venv（`research/ctrend/.venv`）→ 裝套件 → 跑單元測試 → 建 `~/ctrend.env`（只放 UPSTASH 兩行，
從 `~/live-runner.env` 或執行中的 live-runner 的環境變數複製，不印值）→ 安裝並啟用 `ctrend.timer` →
立刻跑一次（第一次從 2026-10-26 補算到最近的週一）。**不碰 live-runner、不需要重啟它。**
最後印出 log 與 timer 狀態，整段貼回來確認。

找不到金鑰時腳本會停下來，照它印的說明手動建 `~/ctrend.env` 再重跑。

## 平常更新

`git pull` 就好。timer 每次都用磁碟上最新的程式；`requirements.txt` 有變才需要重跑 `bash deploy/install-ctrend.sh`。

## 看狀態

```bash
journalctl -u ctrend -n 60 --no-pager      # 最近一次的輸出
systemctl list-timers 'ctrend*' --no-pager  # 下次什麼時候跑
cat ~/tradding_app/research/ctrend/out/weeks.csv
```

自己的電腦：`ENV_FILE=env.txt npm run status` 有一行 CTREND（超過 8 天沒更新顯示 ⚠）；超過 9 天沒更新 App 會推播。

## 手動補跑／試跑

```bash
sudo systemctl start ctrend.service          # 補跑（從 lastWeek 接著算，重跑無害）
research/ctrend/.venv/bin/python research/ctrend/ctrend_forward.py --dry   # 只印、不寫 Redis
```

## 停用

```bash
sudo systemctl disable --now ctrend.timer
```

## 幣安 API

用公開端點（`fapi.binance.com`，免金鑰）。主機所在地區被擋（HTTP 451）時，在 `~/ctrend.env` 加
`CTREND_FAPI=<可用的鏡像網址>`。

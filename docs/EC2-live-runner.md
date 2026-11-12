# EC2 上的 live-runner：更新、重啟、自動重啟

live-runner 是 S3 真倉唯一的執行者。它停掉時，交易所上的硬止損還在，但移動止損、加碼、進場都沒人做；
Vercel 那側只會在停止超過 10 分鐘時推播，**不會把它叫起來**。這份文件讓它當機或主機重開後自己起來。

> 這份是 2026-11-12 寫的，寫的人沒有登入過那台 EC2：使用者名稱、專案路徑、目前是用什麼方式跑的
> （tmux／nohup／pm2）都要先在機器上確認，再照實際情況改 `deploy/live-runner.service`。

## 平常更新（每次 push 之後）

**避開台灣 08:00～10:00**（UTC 00:00～02:00 是 S3 的進場窗口）。有 S3 持倉時重啟是安全的：狀態都在 Redis，
重啟後第一輪就會跟交易所對帳。

```bash
cd ~/tradding_app
git pull
npm install            # package.json 沒變可以省略
sudo systemctl restart live-runner      # 還沒裝 systemd 服務的話，照原本的方式停掉再啟動
journalctl -u live-runner -n 30 --no-pager
```

啟動後的 log 要看到這幾行：

- `✅ Web Push 已啟用`（沒有的話 VAPID 金鑰沒設，進出場推播全部收不到）
- `✅ 持倉模式：單向`（顯示雙向就要到幣安改，否則 S3 的單全部會被拒）
- `絕對金額上限：單日虧損 … 、單筆名目 …`（testnet 顯示「未設定」是正常的）
- `S3-A＋S3-B：真的下單（testnet）`

回到自己的電腦跑 `ENV_FILE=env.txt npm run status`，心跳要是「剛剛」。

## 第一次：改成 systemd 服務

1. **先確認現在是怎麼跑的**，把舊的停掉（兩支同時跑會搶同一個帳戶、重複下單）：

   ```bash
   ps aux | grep -E "live-runner|tsx" | grep -v grep
   tmux ls 2>/dev/null; pm2 ls 2>/dev/null
   ```

2. **環境變數檔**。不要用 `env.txt`（它混了筆記與指令）：

   ```bash
   cp ~/tradding_app/deploy/live-runner.env.example ~/live-runner.env
   chmod 600 ~/live-runner.env
   nano ~/live-runner.env        # 填值；一行一個 KEY=VALUE
   ```

3. **安裝服務**（先打開 `deploy/live-runner.service`，把 `User`、`WorkingDirectory`、`EnvironmentFile` 改成實際的；
   `which npm` 如果不在 `/usr/bin` 或 `/usr/local/bin`——例如用 nvm 裝的——把 `ExecStart` 改成 npm 的完整路徑）：

   ```bash
   sudo cp ~/tradding_app/deploy/live-runner.service /etc/systemd/system/live-runner.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now live-runner
   systemctl status live-runner --no-pager
   journalctl -u live-runner -f
   ```

4. **驗證會自己起來**（在沒有 S3 持倉、非進場窗口時做）：

   ```bash
   sudo systemctl kill -s SIGKILL live-runner     # 模擬當機
   sleep 15; systemctl status live-runner --no-pager   # 應該是 active (running)，啟動時間是剛剛
   ```

## 常用

```bash
journalctl -u live-runner -f                 # 即時 log
journalctl -u live-runner --since "today"    # 今天的
sudo systemctl stop live-runner              # 停（真的要停時）
sudo systemctl restart live-runner
systemctl is-enabled live-runner             # enabled = 開機會自己起來
```

服務在 5 分鐘內連續失敗 10 次會停止重試（通常是環境變數沒設好，log 第一行就有 ❌）。修好後：

```bash
sudo systemctl reset-failed live-runner && sudo systemctl start live-runner
```

## 緊急狀況

- **全部平掉並停止交易**：在自己的電腦 `ENV_FILE=env.txt npm run flatten -- --yes`（見 CLAUDE.md）。
  不需要登入 EC2；kill switch 會讓 live-runner 整輪跳過。
- **只想暫停開新倉**：在 `~/live-runner.env` 加 `S3A_DRY_RUN=1` 再重啟（只印不下單；既有持倉的管理也會變成只印，
  所以有持倉時不要用這個——用 kill switch）。

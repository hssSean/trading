# Crypto Trader — 完整部署指南

## 架構說明

```
你的手機瀏覽器
      ↕
Vercel（免費） ← UptimeRobot 每 5 分鐘觸發分析
      ↕
Binance API（抓 K 線）
      ↓
Telegram Bot → 推送訊號通知到你手機
```

電腦完全不需要開著。

---

## Step 1：本地測試

```bash
cd C:\tradding_app
npm run dev
```

瀏覽器開 http://localhost:3000 確認畫面正常。

---

## Step 2：申請 Telegram Bot（免費，5 分鐘完成）

1. 手機開 Telegram，搜尋 **@BotFather**
2. 傳 `/newbot`，按指示填入 Bot 名稱
3. 取得 **Bot Token**（格式：`123456:ABC-DEF...`）
4. 傳一則任意訊息給你的 Bot
5. 瀏覽器開：`https://api.telegram.org/bot[你的Token]/getUpdates`
6. 找到 `"chat":{"id":...}` 那個數字 → 這是 **Chat ID**

---

## Step 3：部署到 Vercel（免費永久託管）

### 3a. 安裝 Vercel CLI
```bash
npm install -g vercel
```

### 3b. 初始化 Git（如果還沒有）
```bash
cd C:\tradding_app
git init
git add .
git commit -m "init crypto trader web app"
```

### 3c. 部署
```bash
vercel
```
按照提示登入（或先在 vercel.com 申請帳號），選「Create new project」，
Vercel 會自動偵測 Next.js 並部署。

你會得到一個 URL，例如：`https://crypto-trader-xxx.vercel.app`

### 3d. 設定環境變數
到 Vercel 控制台 → 你的專案 → Settings → Environment Variables，新增：

| 變數名稱 | 值 |
|---------|-----|
| `TELEGRAM_BOT_TOKEN` | 你在 Step 2 取得的 Token |
| `TELEGRAM_CHAT_ID` | 你在 Step 2 取得的 Chat ID |
| `WATCH_COINS` | `BTCUSDT,ETHUSDT,SOLUSDT`（依需求修改） |
| `ANALYSIS_TIMEFRAMES` | `4h,1h` |
| `WEBHOOK_SECRET` | 任意密碼，例如 `my-secret-abc` |

設定後回到 Deployments → 重新部署一次。

---

## Step 4：設定 UptimeRobot（免費背景監控）

UptimeRobot 是免費的服務，可以每 5 分鐘 ping 一個 URL。
我們用它來自動觸發分析。

1. 到 **uptimerobot.com** 免費註冊
2. 點「Add New Monitor」
3. 選「HTTP(s)」
4. URL 填入：
   ```
   https://你的vercel網址.vercel.app/api/analyze?secret=你設的WEBHOOK_SECRET&coins=BTCUSDT,ETHUSDT
   ```
5. 「Monitoring Interval」選 **5 minutes**
6. 儲存

完成！之後每 5 分鐘 UptimeRobot 會觸發分析，有信號就發 Telegram 通知。

---

## Step 5：手機安裝（像 App 一樣）

**iPhone（Safari）：**
1. 手機 Safari 開 `https://你的vercel網址.vercel.app`
2. 下方點選「分享」→「加入主畫面」
3. 命名後確認，桌面會出現 App 圖示

**Android（Chrome）：**
1. Chrome 開網址
2. 右上選單 → 「加到主畫面」

---

## 使用說明

| 功能 | 操作 |
|------|------|
| 新增幣種 | 首頁「+ 新增」，輸入 BTC / ETH / SOL |
| 立即分析 | 首頁「重新分析」，或進入個別幣種頁面 |
| 查看信號 | 底部「信號」頁，金邊 = 新訊號 |
| 刪除幣種 | 設定頁 → 監控幣種管理 → 移除 |
| 設定通知 | 設定頁 → Telegram 通知設定 |

## 分析邏輯

- **SMC**：Order Block（機構訂單塊）、FVG（公平價值缺口）、BOS/ChoCH（結構突破）
- **SNR**：歷史高低點支撐阻力，依觸碰次數評估強度  
- **RSI**：超賣 <30 / 超買 >70
- **MACD**：黃金/死亡交叉
- **EMA**：20/50/200 均線趨勢方向
- 綜合得分 ≥7 且風險回報比 ≥1.5:1 才發出信號

## Telegram 通知格式

```
🟢 做多 ▲ BTC/USDT [4h]
強度：強 ⭐⭐⭐ (14pt)

📌 入場：$65,200.00
🎯 止盈 TP1：$67,000.00
🎯 止盈 TP2：$69,500.00
🛑 止損 SL：$64,100.00
📊 風險回報比：2.5:1

分析依據：
• 突破結構 BOS ↑
• 看漲訂單塊 OB (強度 4)
• RSI 偏低 (38.2)
• MACD 黃金交叉 ↑
```

---

本 App 僅供學習參考，不構成投資建議。

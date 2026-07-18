# CLAUDE.md — 專案指引

## 語言規定
**所有回覆一律使用繁體中文。**

---

## 編碼規定
**所有檔案皆使用 UTF-8 編碼，Claude 讀寫檔案時也一律使用 UTF-8。**
檔案寫入（如 `event_record.txt`、逐字稿、快取 JSON）必須明確指定 `encoding='utf-8'`，避免 Windows 預設編碼（CP950）導致閃退或亂碼。

---

## 專案概觀

加密貨幣永續合約訊號推薦系統（Crypto Trader）：Next.js 14 App Router PWA，部署於 Vercel（sin1），外部 cron 每 5 分鐘打 `/api/analyze` 掃描幣安成交量前 15 名，產生訊號後寫入 Supabase 並以 Web Push 推播（LINE 為備用管道）。系統只產生推薦單，不自動下單。

- **資料庫**：Supabase PostgreSQL（`profiles`、`trades`、`push_subscriptions`）
- **快取/狀態**：Upstash Redis（訊號鎖、熔斷、ADX 遲滯狀態、拒絕漏斗、影子交易）
- **行情來源**：Binance Futures 公開 REST API（免金鑰）

## 常用指令

```bash
npm run dev          # 本機開發（localhost:3000）
npx tsc --noEmit     # 型別檢查（改完程式必跑）
npx next build       # production build（push 前的最後檢查）
curl -s "http://localhost:3000/api/analyze"   # 本機無 WEBHOOK_SECRET 時可直接跑真實掃描
```

## 部署流程

`git push origin main` → Vercel 自動部署（1-2 分鐘）。使用者已授權直接 push main；破壞性操作（force push、改歷史）仍須先確認。

## 關鍵檔案

| 檔案 | 職責 |
|---|---|
| `src/app/api/analyze/route.ts` | 掃描主流程：regime 判定、風控關卡、DB 寫入、推播、持倉監控、漏斗與影子模擬 |
| `src/analysis/signals.ts` | v2.1 分組計分（基礎 40 + 五組上限）、雙層門檻（A 65+/B 55+）、策略 B 均值回歸 |
| `src/analysis/indicators.ts` | EMA/RSI/MACD/ADX/BB/Donchian；`computeIndicators` 附帶前一根值（勿再算兩次） |
| `src/lib/position.ts` | 倉位計畫（倉位/本金/槓桿），前後端共用，勿另寫倉位公式 |
| `src/store/useStore.ts` | Zustand + localStorage persist + Supabase 同步 |
| `加密貨幣合約推薦單系統-策略規格書-v2.1.md`（使用者 Downloads） | 策略規格書；調參前先讀 |

## 專案慣例

- **調參紀律（規格書 §4）**：一次只動一個濾網，先看拒絕漏斗與影子模擬的淨 R 數據再決定放寬或收緊；淨 R ≤ 0 的關卡代表擋得對，不要動。
- **損益一律用 R 倍數**（損益% ÷ 止損距離%）與帳戶實際損益衡量，不用原始價格 %——ATR 止損的原始 % 會嚴重誤導（熔斷曾因此誤鎖整天）。
- **Supabase 缺欄位**：insert 對 `42703`/`PGRST204` 有兩段式 fallback；新增欄位時要同步更新 fallback 剝除清單並提醒使用者跑 `ALTER TABLE`。
- **Redis 指令數要省**：批次讀寫（hash/hgetall、單次 lpush 多值），避免迴圈內逐鍵操作；Upstash 免費額度有限。
- **CPU 要省**：外部 cron 頻率不可控，只能砍每次呼叫的計算量；只算需要的指標（如只要 ADX 就別跑 `computeIndicators`）。
- 改完程式：`npx tsc --noEmit` → 有 UI 變更盡量預覽驗證 → `npx next build` → commit（訊息附 Co-Authored-By）→ push。
- 本機預覽的登入需真實 Supabase session，placeholder 環境會卡在載入 spinner；純函數改用 node 單元測試驗證。

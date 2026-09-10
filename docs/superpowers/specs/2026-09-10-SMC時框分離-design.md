# 2026-09-10 SMC 時框分離：HTF 定結構 / LTF 執行進場

> 設計文件。實作計畫另開。
>
> **讀這份之前先讀** `docs/ANALYSIS-2026-08-25`、`ANALYSIS-2026-08-30`、
> `ANALYSIS-2026-09-07`、`ANALYSIS-2026-09-07B`——它們共同證明了五個參數家族
> 沒有可調的槓桿。本設計**不是**又一輪調參，動的是那五輪從沒碰過的東西：
> 進場點本身。

---

## 一、為什麼改

### 使用者的三個判斷依據

1. 帳戶在虧錢
2. 對照 SMC 教材，覺得現有邏輯不對
3. 系統一直出 bug

第 1 點與第 3 點是事實。第 2 點需要修正：**現有系統已經是 SMC**——
`analyzeMarketStructure`（BOS/CHoCH）、Order Block、breaker block、HTF bias、
盤整不發單、保本、分批停利全都在裡面。真正缺的只有四項：流動性掃描、FVG、
溢價/折扣區、D1 偏向。

### 虧損是算術，不是規則寫錯

```
賺賠比 2.2:1、勝率 27.5%
EV = 0.275 × 2.2 − 0.725 × 1 = −0.12R      實測 −0.081 ~ −0.107R，對得上
2.2:1 的兩平勝率 = 1/(1+2.2) = 31.3%        差 3.8 個百分點
手續費 −94.60 USDT ÷ 90 天淨虧 −469.69 = 20%
```

要修正 EV 只有兩條路，而兩條都已經測死：

| 路 | 已測結論 |
|---|---|
| 把 TP 推遠（提高賠率） | `tp1AtR` 推到 +2.5R，n=705 t=2.13，不過 Bonferroni 門檻 2.94。雜訊 |
| 把 SL 拉近（提高賠率） | 止損距離下限 clamp/skip 各四門檻全部 \|t\| < 1（ANALYSIS-2026-09-07） |

**第三條路沒測過：不動 TP、不改 SL 公式，改「在哪裡進場」。** 進場點換到
流動性掃描剛結束的位置，止損放掃描影線外——止損距離變小是**進場位置的
副產品**，不是把既有止損往內縮。這是那兩份文件真正的主張
（策略四：「以極小的止損換取高盈虧比」）。

### 五輪測試的共同盲點

進場評分、出場管理、掛單機制、TP 位置、止損距離下限——**五個家族全部是
「在同一個進場點上調參數」**。沒有一輪動過進場點的決定方式。

---

## 二、目標與非目標

### 目標

1. **系統不再靜默停擺**（工程層，可在幾週內驗證）
2. **策略含流動性掃描 / FVG / 溢價折扣 / D1 偏向**（產品層，可驗證是否實作）
3. **帳戶曲線轉正**（無法在 n < 665 前驗證，見下）

### 明確記錄的限制

sd ≈ 1.3，偵測 +0.1R/筆需 n ≈ 665，以每天 1.9 筆計約一年。
**目標 3 在本設計完成後仍然無法被證明或證偽。** 這不是保守，是 n 與 sd
算出來的。任何「改完之後曲線轉正」的觀察，在 n 夠大之前都無法跟運氣區分。

寫在這裡是為了讓未來的人（包括未來的我）不要把短期曲線當成驗證。

### 非目標

- 不追求把 TP 推遠來達成 1:3（已測死）
- 不重寫評分系統（五組因子無鑑別力，但檢定力邊界 \|rho\| > 0.23，
  「看不見」不等於「沒用」，砍掉會損失可能有用的東西）
- 不換選幣（使用者明確表示這部分沒問題）
- 不動時間止損（目前第二強的正面證據：省下 14.66R）

---

## 三、架構

### 現況

```
Vercel 1h 掃描 → 完整 signal(entry/sl/tp1/tp2) → trades(status='waiting')
live-runner   → 讀 waiting → 掛 LIMIT @ entry → 等成交 → 管理
```

進場價在掃描那一刻寫死，之後只是等它被碰到。8 根 1h K 線沒碰到就取消，
成交率約 55%。

### 目標架構

```
Vercel 1h 掃描 → setup（方向 + 進場區域 + 失效價 + TP 結構 + trigger_spec）
               → trades(status='waiting', trigger_spec = {...})
               （4h regime 沿用既有的 getRegimeCache 路徑，不變）

執行端 每輪    → 對有 trigger_spec 的 waiting 單，取 5m K 線評估觸發
               → 觸發 → 算出真正的 entry / stopLoss / 數量 → 進場
               → 清空 trigger_spec → 之後的管理邏輯完全不動
```

**5m K 線不再進主掃描迴圈**（Phase 0a 把 `ANALYSIS_TIMEFRAMES` 收成 `1h`），
只在「有 `trigger_spec` 的 waiting 單」時單獨抓該 symbol 的 5m。
waiting 單通常 0–3 筆，對照原本的 15 幣 × 全套 `generateSignals`，是淨減少。

「執行端」有兩個，共用同一個純函數：

| | live-runner | route.ts |
|---|---|---|
| 節奏 | 15 秒 | 每次掃描 |
| 對誰 | `live_trading_enabled=true` 那位 | 其餘使用者（DB 模擬） |
| 行為 | 真的下單 | 模擬成交 |

### 決定 1：不新增 status，只加可為 null 的 `trigger_spec`

這個專案九成的 bug 是狀態同步。新增 `'armed'` status 會讓現有每一處
`status === 'waiting'` 的判斷變成潛在漏洞。

用可選欄位的話：

- **沒有 `trigger_spec` 的單，行為跟今天逐字相同**
- `WAITING_EXPIRY_BARS` 的過期機制原封不動變成 setup 有效期，不用另外發明
- 回滾 = 停止寫入這個欄位，不需要 migration、不需要改判斷

Supabase 新增欄位要同步更新 insert 的 `42703`/`PGRST204` 兩段式 fallback
剝除清單，並提醒使用者跑 `ALTER TABLE`（專案慣例）。

### 決定 2：觸發判定是純函數，兩條路徑共用

`live-runner` 與 `route.ts` **必須呼叫同一個 `evaluateEntryTrigger`**。

前例：TP2 在真倉路徑從來沒被執行過，DB 模擬會在觸及 TP2 時平倉並記
`WIN_TP2`，真倉卻只有移動止損——2026-09-06 才發現。同樣的形狀不能再發生。

### 決定 3：上線前先做機制檢定

純函數拆成獨立積木之後，能直接吃現成歷史資料跑**置換檢定**，
問「這個機制有沒有資訊量」。

這是 2026-09-07B 省下大量時間的做法：機制檢定吃現成 MFE 資料、幾分鐘就好；
走 K 線模擬要十幾分鐘，而且會把「結構有用」跟「目標變近」混在一起分不開。

**如果 sweep+CHoCH 的置換檢定跟阻力位一樣不顯著，那就在寫任何交易邏輯之前
就知道了。** 這是 Phase 1 的 go/no-go 閘門。

---

## 四、模組切分

新目錄 `src/analysis/smc/`，每個檔案一個關注點，全部純函數、可獨立測試。

| 檔案 | 職責 | 輸入 → 輸出 |
|---|---|---|
| `swings.ts` | 擺動高低點偵測 | `Candle[]` → `Swing[]` |
| `sweep.ts` | 流動性掃描（影線刺穿但收盤收回） | `Candle[], level, dir` → `SweepEvent \| null` |
| `choch.ts` | 結構轉換 | `Swing[], dir` → `ChochEvent \| null` |
| `fvg.ts` | 公允價值缺口（三根 K 線失衡） | `Candle[]` → `Fvg[]` |
| `fib.ts` | 溢價/折扣區 | `swingHigh, swingLow, price` → `0..1` |
| `trigger.ts` | 組合上述，回傳進場決定 | `TriggerSpec, Candle[]` → `TriggerResult \| null` |

`trigger.ts` 是唯一有策略意見的檔案，其餘五個是可獨立驗證的偵測器。

### `TriggerSpec` 契約

Vercel 寫入、執行端讀取。**這是兩條路徑之間唯一的介面**，欄位改動要同時
更新兩端與型別。

```ts
interface TriggerSpec {
  version: 1;                    // 契約版本，執行端遇到不認得的版本一律略過
  ltf: '5m' | '15m';             // 執行時框
  direction: 'LONG' | 'SHORT';
  zoneLow: number;               // 進場區域（OB / FVG）
  zoneHigh: number;
  invalidation: number;          // 失效價：碰到就放棄這個 setup
  requireSweep: boolean;         // 是否要求流動性掃描
  requireChoch: boolean;         // 是否要求結構轉換
  sweepLevel: number | null;     // 預期被掃的流動性位置
  expiresAt: number;             // 毫秒；跟 WAITING_EXPIRY_BARS 一致
}
```

`TriggerResult` 回傳 `{ entry, stopLoss, evidence }`。`evidence` 記錄哪幾個
條件成立、對應的 K 線索引——**這是事後對帳與除錯的唯一線索**，不能省。

---

## 五、護欄

### 1. 最小止損距離（由名目上限倒推）

`calcPositionPlan` 已有 `notionalCapped`：止損太近時名目會被夾到
`marginBudget × maxLev`，倉位縮水。

**問題不是名目爆炸，是被夾之後這筆單的實際風險 < 1R，而每一道 R 上限
都不會有反應，下游所有 R 統計全部失真。** 目前 `notionalCapped` 只在
`describePlan` 顯示一行提示，沒有任何攔阻。

SMC 止損比現有的 ATR/OB 止損近得多，`notionalCapped` 會從罕見變成常態。

**要求**：`evaluateEntryTrigger` 算出 `stopLoss` 後，若該止損距離會導致
`notionalCapped === true`，**放棄這個觸發**（不是夾住倉位繼續進場）。
理由：一筆 R 不明的單對統計的傷害大於錯過一次進場。

這是倒推的硬約束，不是可調參數。

### 2. setup 有效期

沿用 `WAITING_EXPIRY_BARS`。不發明新常數。

### 3. 執行端掛掉時的行為

live-runner 死掉時，有 `trigger_spec` 的單會自然過期取消，不會變殭屍部位
（因為它從沒送到交易所）。這比現況安全——現況是 LIMIT 單已經掛在交易所上。

### 4. 回滾

停止在 Vercel 寫入 `trigger_spec`，系統立刻回到今天的行為。
不需要 migration、不需要改判斷、不需要重啟 live-runner。

---

## 六、額度預算

### Vercel CPU

現況 108%（8/31 實測 4h20m/4h），13 分鐘/日投影為 162%。**已經超標。**
所以這批不能只加不減。

#### ⚠ 更正（2026-09-10，量測後）：砍 5m/15m 不是那個槓桿

本節原本寫「`ANALYSIS_TIMEFRAMES` → `1h` 可省 ×0.35」，依據是
「三個時框成本大致相等，而 5m/15m 只產出 2.2% 的訊號」。

`scripts/scan-cpu-profile.ts` 實測（8 檔 × 3 時框 × 5 次）：

```
時框   解析/次   產訊號/次   每小時合計   佔比
5m      0.08ms      0.15ms          3ms   40.2%
15m     0.12ms      0.30ms          3ms   39.0%
1h      0.08ms      0.38ms          2ms   20.8%
每檔幣每小時合計 8ms
```

推論的前半沒錯——三個時框成本確實相等。錯在**它們加起來根本不是大頭**：

```
15 檔 × 8ms/小時 = 120ms/小時 = 2.9 秒/天
Vercel 實測                    = 780 秒/天（13 分鐘）
訊號產生 + K 線解析佔           0.4%
```

**砍 5m/15m 實際上省 0.3%，卻要賠掉 2.2% 的訊號。不划算，不做。**

這是本專案第八個「長得像結論的量測錯誤」。記錄在這裡的理由跟前七個一樣：
它在被量到之前，看起來完全合理。

#### 真正的大頭在哪：還不知道，但範圍縮小了

TODO 記錄「Redis 死 → 鎖失效 → 100% 都做完整工作 → **正好 2×**」。
如果冷啟動／模組初始化是大頭，拿掉鎖只會微幅增加而不會剛好翻倍。
剛好 2× 代表**掃描工作本身幾乎就是全部的 CPU**：

```
13 分鐘/日 ÷ 360 次完整掃描 ≈ 2.17 秒 CPU / 次
其中訊號產生 + 解析 ≈ 5ms
```

剩下的 2.16 秒在別處。候選：`monitorActiveTrades`（每筆持倉抓 168 根 K 線 +
`walkTpSl`）、`processShadowTrades`（三個影子模擬）、`regimeAtr`（540 根 4h +
ADX + ATR 百分位）、`fundingRate`、Supabase 讀寫。

**本機量不到**——沒有 Supabase 時 `monitored: 0`，監控階段是空跑。
所以 `src/lib/scanTiming.ts` 的計時點已經鋪到這五段，靠 production log 定案。

#### 修正後的動作表

| 動作 | 效果 | 狀態 |
|---|---|---|
| `scan-run-lock` TTL 70 → 240 秒 | ×0.50 | 已改。獨立成立——「正好 2×」證明完整掃描次數就是 CPU 的線性因子 |
| 計時器鋪到五個階段 | 0 | 已改。下次部署後讀 Vercel log |
| `ANALYSIS_TIMEFRAMES` → `1h` | ×0.997 | **不做**（實測只省 0.3%） |
| 觸發器（新增） | 待測 | Phase 1 |

TTL 改動的代價（已評估）：

1. DB 模擬的持倉監控從 120 秒變 240 秒一輪。安全——監控用 1h K 線的
   high/low 判斷觸發，不是當下報價，兩次掃描之間的事件不會漏。
   真倉走 live-runner 的 15 秒迴圈，不受影響。
2. 掃描中途 crash 時鎖多卡 240 秒而非 70 秒。對 1h 訊號無所謂。

### Upstash Redis

**零增量。** 兩個設計決定就是為了這個：

- `trigger_spec` 存 Supabase，不進 Redis
- 5m K 線用 module-level `Map`（同 `signalCache.ts:81` 的模式），不進 Redis

TTL 70 → 240 會讓 `scan-run-lock` 的寫入次數掉到 1/4。

⚠ 未知數：五處修正（心跳 TTL 90→240、寫入 15→60、killswitch 快取 60 秒、
前端輪詢 15→60、scan-status 快取）之後的實際月用量。需要使用者從 Upstash
console 取得。設計增量為零，所以不影響要不要做，但影響現在安不安全。

---

## 七、階段

### Phase 0a — 額度與流量（機械式，無策略變更）

1. ~~掃描迴圈加 per-TF 計時 log~~ ✅ `src/lib/scanTiming.ts` + 五個階段計時點
2. ~~`scan-run-lock` TTL 70 → 240 秒~~ ✅
3. ~~`ANALYSIS_TIMEFRAMES` → `1h`~~ ❌ **取消**，實測只省 0.3%（見第六節更正）
4. 部署後讀 Vercel log 的 `[analyze][cpu]` 行，定位那 2.16 秒
5. 跑 `npm run status` 確認沒有殘留的孤兒部位／裸倉

**驗收**：下一個計費週期 Vercel CPU < 60%（TTL 減半的直接效果）；
`[analyze][cpu]` log 指出佔比最高的階段；`npm run status` 全綠。

### Phase 0b — 機制檢定（go/no-go 閘門）

1. 實作 `swings.ts` / `sweep.ts` / `choch.ts` / `fvg.ts` / `fib.ts` + 單元測試
2. 寫 `scripts/smc-mechanism.ts`：對歷史資料做置換檢定，
   問四個機制各自有沒有資訊量（洗牌 3000 次，比照 `sr-mechanism.ts`）

**驗收**：至少一個機制 **p < 0.0125** 且方向正確。

⚠ 不是 0.05。一次測四個機制，「至少一個 p < 0.05」純靠運氣的機率是
`1 − 0.95⁴ ≈ 18.5%`。Bonferroni 校正後門檻是 `0.05 / 4 = 0.0125`。
這個專案已經在同一個坑裡跌過：掛單機制一次測 7 個政策、TP 位置一次測 15 個
變體，兩次都是靠校正後的門檻才擋下假結論。

**全部不顯著 → 停在這裡，不做 Phase 1。** 那個結果本身就是有價值的答案，
而且只花了幾天而不是幾個月。

### Phase 1 — 觸發器接線

1. Supabase `ALTER TABLE trades ADD COLUMN trigger_spec JSONB`
2. insert fallback 剝除清單同步更新
3. `trigger.ts` + `evaluateEntryTrigger`
4. `signals.ts` 產生 `TriggerSpec`
5. live-runner 與 route.ts 兩端接上同一個純函數
6. 護欄 1（`notionalCapped` 放棄觸發）

**驗收**：`npx tsc --noEmit` + `npx vitest run` + `npx next build` 三個都過；
`trigger_spec` 為 null 的單行為逐字不變（回歸測試）。

### Phase 2 — 上線與量測

1. 先只對 DB 模擬路徑開，觀察一週
2. 再對 live-runner 開
3. 新舊策略用 `strategy` 欄位區分，可分開統計

---

## 八、測試策略

| 層 | 方法 |
|---|---|
| 五個偵測器 | 單元測試，手工構造的 K 線序列，正反例各一組 |
| `evaluateEntryTrigger` | golden case，取真實 5m K 線（含已知的掃描與非掃描案例） |
| 回歸 | `trigger_spec === null` 時，`decideTradeAction` 的輸出與現況逐字相同 |
| 整合 | `scripts/backtest.ts` 走 5m 觸發路徑 |

專案硬規定：宣稱「修好了」之前，`npx tsc --noEmit` → `npx vitest run` →
`npx next build` 三個都要跑。

---

## 九、需要使用者執行的事

我做不到的，全部列在這裡。

1. **Upstash console 取當月 commands 數**（判斷 Redis 現在安不安全）
2. **Vercel 環境變數**：確認 `ANALYSIS_TIMEFRAMES` 沒有被設值覆寫
   （若有設，改程式碼預設不會生效）
3. **`WEBHOOK_SECRET` 從 `abc123` 換掉** — 現在任何知道網址的人都能無限
   觸發掃描，直接燒 CPU 額度（denial of wallet），而且 secret 在 URL query
   string 裡會被中間節點記錄。要同時改 Vercel 環境變數與 cron-job.org
   （job 7981693）的網址
4. **`MAX_DRAWDOWN_R` 12 → 18 的決定**（bootstrap p95 ≈ 18R，12R 有 24.9%
   機率被純雜訊觸發，一週擋掉 191 個候選）。
   **這是風控門檻的放寬，需要你明確決定，我不自己改**
5. **Supabase `ALTER TABLE`**（Phase 1 開始時）
6. **重啟 live-runner**（改完 code 不會自動生效）

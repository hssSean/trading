# merge-notes — anti-gambling-trader 統計引擎移植筆記

日期：2026-07-18 ｜ 對照來源：`reference/anti-gambling-trader-tw`（clone 於本地，已加入 .gitignore）

## 現有專案技術棧

- Next.js 14 App Router + TypeScript（strict）、Tailwind、Zustand + localStorage persist
- 深色主題 tokens：背景 `#0A0A0F`、卡片 `#12121A`、邊框 `#1E1E2E`、主色 `#F0B90B`、文字 `#EAEAF4`/`#606080`
- 無圖表庫（trades 頁的權益曲線為手刻 SVG path）→ 體檢頁同樣手刻 SVG，不引入依賴
- 無測試框架 → 新增 vitest（devDependency，spec §9.3 允許）
- 導覽：`src/components/BottomNav.tsx` 底部分頁；新頁掛 `src/app/health-check/page.tsx`（'use client'，計算全在瀏覽器）

## 移植對照表（Python → TS）

| Python | TS 目標 | 備註 |
|---|---|---|
| `core/models.py` | `src/lib/antigambling/models.ts` | Trade/TradeLog；pnl 推導（含 side 與契約乘數）、is_day_trade 用日曆日 |
| `core/markets.py` | `src/lib/antigambling/markets.ts` | infer_market 判斷順序：台期權(帶月份碼)→外匯→crypto→裸幣名 UNKNOWN→台ETF→台股→美股；乘數白名單 |
| `core/ingest/costs.py` | `src/lib/antigambling/costs.ts` | CostModel.estimate（單邊）、台股當沖稅減半、FINRA TAF 每股費 |
| `core/ingest/loader.py` | `src/lib/antigambling/ingest.ts` | FIELD_SYNONYMS 同義詞表、「張」×1000、有效性守門與略過原因、瀏覽器端以 TextDecoder utf-8→big5 回退 |
| `core/metrics/performance.py` | `src/lib/antigambling/metrics.ts` | 因果式回撤（running capital + 當下峰值）、R 以 avg_loss 為 1R、夏普/索提諾 per-trade n-1、`_ratio` 無虧損→Infinity |
| `core/verdict/statistics.py` | `src/lib/antigambling/significance.ts` | t 分布 CDF＝正則化不完全 beta（Lentz 連分數）；bootstrap shift-method + (n+1)/(B+1)；MAX_BOOTSTRAP_DRAWS=2000 萬 |
| `core/verdict/judge.py`（紅旗掃描） | `src/lib/antigambling/redflags.ts` | 7 個紅旗與門檻逐條相同（negative_expectancy / concentrated_profit / win_small_lose_big / thin_edge_margin / severe_drawdown / long_losing_streak / intraday_noise / thin_profit_factor） |
| `core/verdict/judge.py`（決策樹） | `src/lib/antigambling/verdict.ts` | 分支順序 A 樣本不足→B 負期望→C 不顯著→D 高紅旗/薄邊際→E 具優勢，與 Python 完全一致；中文文案照搬 |
| `core/backtest/validate.py` | `src/lib/antigambling/oos.ts` | 單一時序 holdout：n<20 特判、split=clamp(max(10, n*0.7), ≤n-10)、edge_persisted 需樣本外顯著 |
| `core/metrics/breakeven.py` | `src/lib/antigambling/breakeven.ts` | 轉正勝率 <0.9 才給、盈虧比目標、成本削減缺口 |
| `core/strategy/per_tag.py` + `antiscam/signals._FOLLOW_KEYWORDS` | `src/lib/antigambling/pertag.ts` | per-tag 刻意只做描述統計（多重比較不校正會發假優勢徽章）；反事實純會計式；跟單關鍵字清單照搬 |
| `core/analyzer.py` | `src/lib/antigambling/analyzer.ts` | analyzeLog 編排 + sanitizeJson（Infinity→null）；輸出形狀對齊 as_dict 供 golden 比對 |

## 明確不移植（spec §3.2 + 依賴鏈判定）

- `scaffold/`、`broker/`、`charts/`、`antiscam/`（除 `_FOLLOW_KEYWORDS` 常數）、`montecarlo/`、`trend/`、`forensics/`、`survivorship.py`、`report*.py`（UI 用結構化資料自行呈現）
- `strategy/profiler.py`：僅供 skeleton 產生器使用（out of scope），golden 比對時跳過 `profile` 鍵
- `statistics.welch_mean_test`：僅 trend 模組使用，不移植
- Excel 匯入：專案無 SheetJS，不加依賴（v1 CSV/JSON）

## 刻意決策與差異記錄

1. **Bootstrap PRNG**：Python 用 Mersenne Twister（`random.Random(1234).choices`），TS 用 mulberry32 —— 序列不同屬預期，spec §9 只要求固定 seed 下 p 差 < 0.02 且裁決一致。預設 seed=1234 跟隨原始碼（spec §6.2 寫「正式使用隨機 seed」，但原始碼一律固定 1234；依「以原始碼為準」原則採固定值，同一份檔案重複分析結果可重現）。
2. **求和順序**：所有 sum/迴圈保持與 Python 相同的先後順序（IEEE754 雙精度下逐位一致）。
3. **`int()`→`Math.trunc`、`math.ceil`→`Math.ceil`**；CI 分位索引 `int((alpha/2)*B)` 同為截斷。
4. **CSV 編碼回退**：Python 用 utf-8-sig→cp950；瀏覽器用 TextDecoder('utf-8', fatal)→TextDecoder('big5')，語意等價（Encoding Standard 的 big5 涵蓋 cp950 常用範圍），讀到 big5 時同樣在來源字串標註提醒。
5. **時間解析**：Python strptime 多格式表 → TS 手寫對應正則（不引依賴）；同樣去除時區（naive）。
6. **golden files**：本地 Python 3.12 跑 `core.cli analyze <example> --json`，存 `tests/antigambling/fixtures/`；比對範圍＝verdict（level/red_flags/metrics/significance）、out_of_sample、tag_verdicts、counterfactual、follow_guru、breakeven；`profile` 跳過。

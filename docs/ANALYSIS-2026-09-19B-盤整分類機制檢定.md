# B7 盤整識別收緊濾網——機制檢定：分類器本身不含資訊，收緊或放寬都沒意義

來源：`docs/修改清單-2026-09-19.md` B7。原始規格已遺失（只留標題「盤整識別
收緊濾網」），使用者把方向判斷交給我（「你幫我判斷」）。在決定往哪個方向調
之前，先問這個更基本的問題：**現在這個分類器本身有沒有在抓真的東西？**

## 測的是什麼

`signals.ts` 的 hard gate 1（343-348 行）：intraday 訊號在
`analyzeMarketStructure(candles).trend === 'ranging'` 時全部跳過。程式碼註解
自己的宣稱是「Ranging = no momentum = no clean TP target reachable in a day」
——這是一個關於**未來震幅**的宣稱，不是關於方向。`analyzeMarketStructure`
（`src/analysis/smc.ts`）只用最近兩個 swing high/swing low 的比較判斷
bullish/bearish，其餘（包含資料不足）一律算 ranging。

這個 hard gate 從沒進過 reject-funnel——它在候選評分**之前**就 `return []`，
`npm run funnel-verdict` 完全看不到它，跟 `docs/ANALYSIS-2026-09-07B` 的
阻力位死碼是同一種「看起來很重要但從沒被驗證過」。

## 檢定方法

置換檢定，不跑完整走 K 線模擬（先問機制存不存在，過了才排隊模擬——同
`sr-mechanism.ts` 的做法）。用公開 K 線（不需要 DB/金鑰）：

1. 對每根 1h K 線（每 3 根取樣一次，控制執行時間），用 signals.ts 實際會吃到
   的窗口（200 根）算一次 `analyzeMarketStructure`。
2. 量測「答案」：未來 24 根（route.ts `INTRADAY_CLOSE_HOURS`）的
   `|close 位移| / ATR`——這正是「有沒有乾淨動能可吃」的直接量化。
3. 把 trending（bullish+bearish）/ranging 標籤在樣本間洗牌 3000 次，破壞
   「這根的分類 ↔ 這根之後的震幅」配對，看真實的組間差異是不是洗牌洗得出來的。

腳本：`scripts/regime-structure-mechanism.ts`。

## 結果——兩個獨立視窗都是決定性的零

| 視窗 | n | bullish 均值 | bearish 均值 | ranging 均值 | trending−ranging | p |
|---|---|---|---|---|---|---|
| 3 個月 × 12 檔 | 8544 | 2.803 | 2.955 | 2.972 | −0.097 | **0.778** |
| 6 個月 × 8 檔 | 11456 | 2.780 | 2.714 | 2.767 | −0.020 | **0.656** |

三組（bullish/bearish/ranging）未來震幅的均值、中位數幾乎完全重疊，兩次都
遠遠不顯著（p 遠大於 0.05，不是壓線）。**這不是樣本不夠或運氣，是分類器本身
跟它宣稱要偵測的東西無關。**

## 判定

**不調門檻鬆緊——收緊或放寬都沒意義，因為調的是一個不含資訊的分類器。**
這是第七個測死的參數家族。

跟前六個不一樣的地方：前六個是「調參數會不會更好」測死，這次是「這個判斷
本身有沒有抓到東西」測死，層次更底層。真正該問的問題變成「這個 hard gate
本身要不要留」，但那已經超出「B7 收緊濾網」的原始範圍，而且動一個 intraday
唯一的結構性 gate（拿掉會讓多少候選變多、對其他濾網的交互作用）需要完整的
組合層面模擬，不是置換檢定能回答的——**這裡刻意停在「不要因為猜測去調鬆緊」
這一步，要不要動這個 gate 本身留給使用者決定要不要排進下一輪。**

## 對照：這不是在測 4H regime（route.ts 的 ADX 遲滯判斷）

容易混淆的地方：這支測的是 `signals.ts` 的 1h `structure.trend`
（swing-point-based），跟 route.ts 用 4H ADX 遲滯判斷的 `regime`
（trending/ranging/transitional，決定走 Strategy A 或 B）是**兩個不同的
分類器**，互不影響。這份分析完全沒有動到 4H regime 判斷，那個是 ADX-based、
另有一套獨立驗證歷史（`docs/ANALYSIS-2026-08-25` 前後），不在這次範圍內。

# 全站視覺改版（Coinbase 柔和風）— Design Spec

日期：2026-07-30

## 背景

現行介面（各頁面/元件）皆採極簡深色風格：色值大多直接寫死 hex（`#0F141A`、`#1B222B`、`#2DD4BF` 等）在 Tailwind 任意值 class 裡，未走 `tailwind.config.ts` 的 theme token。使用者反饋三點不滿：視覺風格通用（像預設 Tailwind 深色主題）、版面布局混亂、互動與動畫弱。

透過 mockup 反覆對比（Coinbase 柔和風 / Robinhood 大膽風 / Neutral Pro 極簡風三版），使用者選定「Coinbase 柔和風」方向並提供一張截圖作為交易紀錄頁卡片的最終定案樣式參照。原本規劃先做交易紀錄頁一個範例頁驗證，使用者確認滿意後，追加範圍到全部剩餘頁面：首頁/訊號列表、分析頁、設定頁、登入頁，以及它們共用的 7 個元件（`SignalCard`、`CoinCard`、`BottomNav`、`BtcStatusBar`、`CandlestickChart`、`ScanStatusPanel`、`StatsHero`）。本 spec 現涵蓋整站。

**改版原則（沿用交易紀錄頁已驗證的做法）**：色值就地改（每個檔案內把寫死的 hex 換成新色階的 hex/token），不建立新的全域主題抽象層、不做 codebase 大搜換的機械式重構——保持改動可讀、可個別檢查。密度高的清單（首頁 20+ 幣種列、分析頁指標格、設定頁多區塊）維持現行的緊湊列表/表格結構，只換色彩與間距，不要套用交易紀錄頁那種「大卡片+進場動畫」的重量級樣式（會拖慢掃描效率、增加不必要的重繪面）。

## 視覺規格（依定案截圖）

**卡片外殼**
- 背景 `#141922`，邊框 `1px solid rgba(255,255,255,.06)`，圓角 20px，padding 16-18px
- 已結束（win/loss）的卡片降階：背景 `#12161C`（更暗/更平），邊框更淡 `rgba(255,255,255,.04)`，內容精簡（無進度條/無倉位資訊/無底部操作按鈕，只留出場價+R值）

**卡頭**
- 左：圓形幣種頭像（32px，底色 = accent 色 14-18% 透明度，字母置中）＋ 幣對名稱（14px/500）＋ 副標「週期 · 分級 · 方向」（11px 灰）
- 右：狀態膠囊徽章（`background: accent 14%`，文字 accent 色，11px），持倉中狀態帶呼吸動畫的小圓點

**主要數據行**
- 大字 PnL（22-24px/500，accent 或 danger 色）+ 附註 R 值（11px 灰）
- 右側現價（右對齊，11px 灰標籤 + 13px 數值）

**進度軌道（取代現行 4 格網格）**
- 一條水平 slider 樣式軌道：track 高度 6-8px、圓角 full、底色 `rgba(255,255,255,.07)`
- 已完成區段填色 accent，圓形 thumb（14-16px）標示現價位置，帶淡 glow ring（`box-shadow: 0 0 0 3-4px accent/25%`）
- thumb 位置：以「風險→報酬」方向正規化（非原始價格大小）——LONG 用 `(現價-止損)/(TP2-止損)`，SHORT 用 `(止損-現價)/(止損-TP2)`，兩者結果都是 0（止損）→1（TP2）的比例，clamp 在 0-100%
- 軌道下方四個文字標籤：止損（danger 色）、進場（灰）、TP1（accent）、TP2（accent），對應軌道上的相對位置左右排列（非絕對定位對齊刻度，維持簡單的 flex space-between）

**輔助資訊 chip（取代現行倉位計算 4 格網格）**
- 兩個並排的圓角 chip（`background: rgba(255,255,255,.04)`, radius 10px），各帶一個 icon + 兩行文字（label 10px 灰 + value 12px 主文字）：「建議倉位」「止損風險」

**底部操作列**
- 分隔線 `border-top: 1px solid rgba(255,255,255,.06)`
- 膠囊按鈕（radius 99px，border 1px），icon + 文字：圖表（accent 色邊框+文字）、手動記錄（中性邊框+灰字）
- 已結束卡片不顯示操作列，只留時間戳與 R 值

**其他狀態卡片**（沿用同一殼＋依語意調整局部）
- 等待進場：邊框改 `dashed`，色系換成 amber/warning，內容只顯示「距進場位」文字，無進度軌道
- TP1 已鎖定/追蹤 TP2：邊框改實線 accent 色調（非 dashed），移動止損資訊改成一個高亮 chip（`background: accent 8%`）取代現行純文字提醒框

## 首頁／訊號列表（`src/app/page.tsx`、`CoinCard.tsx`、`SignalCard.tsx`）

- `CoinCard`（20+ 幣種同時渲染的密集表格列）：**不改結構**，只換色——列背景/hover 用新 `card-2` 色階、分隔線用新邊框透明度、數字維持等寬字體右對齊。既有 `useTick()` 逐幣訂閱的效能設計原封不動。
- `SignalCard`：形狀與 `TradeCard`（交易紀錄頁）幾乎一致（卡頭幣種+方向+分數、價格區、理由列表），直接套用新的 `TradeCard` 外殼 + `PillBadge`，價格區可視情況換成簡化版 `PriceProgressBar`（無「現價」時只顯示靜態三點：進場/止損/TP）。
- 幣種搜尋輸入框改用新的 `FormField`（見下）。

## 分析頁（`src/app/analysis/[symbol]/page.tsx`、`CandlestickChart.tsx`）

- 指標格（RSI/MACD/EMA 等 6 格）、SMC 區塊（OB/FVG/S-R）：沿用現有格狀排版，背景/邊框換新色階，不加卡片動畫（資訊密度高，動畫會干擾閱讀）。
- `CandlestickChart`：**只調色不改結構**——`createChart()` 設定裡的 grid/text/up/down 顏色常數換成新色階對應值（up/down 沿用現有 `#0ECB81`/`#F6465D` 語意色不變，只調格線/背景/文字色以貼合新卡片底色），K棒渲染邏輯、EMA/OB/FVG overlay 邏輯不動。
- 時框 tabs、解鎖/重整按鈕改用新的按鈕樣式（膠囊/圖示，同交易紀錄頁footer按鈕規格）。

## 設定頁（`src/app/settings/page.tsx`）

表單為主的頁面，需要新增兩個表單元件（原設計只有卡片/徽章/進度條，沒涵蓋輸入框）：

- **`FormField`**：文字/數字/密碼輸入框，label 在上、輸入框用新卡片色階背景 + focus 時 accent 色 ring，取代現行 `.input-field` class 的寫死色值
- **`ToggleChip`**：分段選擇按鈕（風險%、訊號強度、時框），取代現行 `.chip`/`.chip-active`，選中態用 accent 填色（非現行邊框強調）

各摺疊區塊（帳號/推播/Webhook/倉位計算/訊號強度/時框/幣種列表/資料管理）外殼統一換成新卡片色階，內部欄位改用上述兩元件，互動邏輯（Zustand `updateSettings()` 綁定）不動。

## 登入頁（`src/app/login/page.tsx`）

小範圍：卡片外殼換新色階＋圓角，email/password 欄位改用 `FormField`，登入/註冊按鈕改新按鈕樣式，登入/註冊 tab 切換改用 `ToggleChip`。Supabase 驗證邏輯完全不動。

## 共用小元件（只重上色，不重排版）

`BottomNav`、`BtcStatusBar`、`ScanStatusPanel`、`StatsHero` 四個元件維持現有版面結構（導覽列/狀態條/展開式診斷面板/戰績橫幅），只把寫死的舊 hex 換成新色階對應值，`ScanStatusPanel` 內的密集表格不套卡片動畫。`StatsHero` 的 SVG sparkline 顏色比照新 accent 色微調。

## 色彩／圓角 Token（新增，不動舊值）

在 `tailwind.config.ts` 的 `theme.extend` 新增（保留現有 `app/surface/border/accent/up/down` 供其他頁沿用）：

```
colors: {
  'card-2': '#141922',       // 新卡片殼底色
  'card-2-alt': '#12161C',   // 已結束卡片降階底色
},
borderRadius: {
  'card-lg': '20px',
},
```

透明度變化（邊框、tint 背景）用 Tailwind 既有的 `/{opacity}` 語法疊在 `accent`/`white` 上即可，不用額外定義新 token。

## 新元件（`src/components/ui/`）

| 元件 | 職責 |
|---|---|
| `TradeCard` | 卡片外殼（背景/邊框/圓角/padding），依 `variant`（active / closed / waiting）套用對應底色與邊框樣式 |
| `PriceProgressBar` | 接收 `stopLoss, entry, tp1, tp2, current` 算 thumb 位置與填色比例，畫軌道+thumb+四個標籤 |
| `PillBadge` | 狀態/方向徽章，接收 `color` + `pulse?: boolean`（呼吸動畫開關） |
| `StatChip` | icon + label + value 的資訊 chip |
| `FormField` | 文字/數字/密碼輸入框，label+input，focus accent ring |
| `ToggleChip` | 分段選擇按鈕，選中態 accent 填色 |

`TradeRow`（`src/app/trades/page.tsx`）、`SignalCard`、設定頁各表單欄位、登入頁表單改用上述元件組裝，資料邏輯（filter/sort/計算/R值/倉位計算/表單送出）完全不動，只換渲染層。

## 動畫

不新增 npm 依賴（不裝 framer-motion）。全部用 CSS transition + class/style 切換：
- 卡片進場：`opacity`/`translateY` fade-in（掛載時觸發一次，非每次 re-render）
- 進度條填色寬度／thumb 位置：`transition: width/left 1s cubic-bezier(...)`，資料變動時自然過渡
- 持倉中狀態燈：CSS `@keyframes` 呼吸動畫（opacity 循環），純 CSS 不用 JS timer

## 效能約束（沿用專案既有慣例）

`TradeRow` 現用 `React.memo` + 各卡自訂閱自己 symbol 的即時價（見檔案內既有註解與 `7e0a4fa` commit），避免整頁因單一價格 tick 重繪。拆成 `TradeCard`/`PriceProgressBar` 等子元件後：
- 子元件必須維持 props 淺比較穩定（不得傳入每次 render 新建的 inline object/array）
- `PriceProgressBar` 的位置計算可以放函式內就地算，不需要額外 memo（計算量微小）
- 呼吸動畫用純 CSS `@keyframes`，不得用 JS `setInterval` 逐卡跑（40+ 卡同時跑 timer 會抵銷先前重繪優化的成果）

## 範圍界線

**這次做**：
- `tailwind.config.ts` 新 token（`card-2`/`card-2-alt`/`card-lg`）
- `src/components/ui/` 六個新元件：`TradeCard`、`PriceProgressBar`、`PillBadge`、`StatChip`、`FormField`、`ToggleChip`
- `src/app/trades/page.tsx`（`TradeRow`）、`src/app/page.tsx` + `CoinCard.tsx` + `SignalCard.tsx`、`src/app/analysis/[symbol]/page.tsx` + `CandlestickChart.tsx`、`src/app/settings/page.tsx`、`src/app/login/page.tsx`、`BottomNav.tsx`、`BtcStatusBar.tsx`、`ScanStatusPanel.tsx`、`StatsHero.tsx` 全部重上色/重排版（依上述各節規格，密集列表類只換色不換結構）

**這次不做**：資料邏輯變動（filter/sort/計算/表單驗證/API 呼叫皆不動）、新增 npm 套件（不裝 framer-motion 等）、`CandlestickChart` 的圖表庫或指標運算邏輯重寫（只調顏色常數）、CSV 匯出格式或任何後端/API route 改動。

## 驗收標準

- 交易紀錄頁五種卡片狀態、首頁訊號/幣種列表、分析頁、設定頁、登入頁的視覺都套上新色階與新元件，風格與定案截圖／mockup 一致
- `npx tsc --noEmit` 通過
- 本機 `npm run dev` 用瀏覽器逐頁預覽確認：卡片/表單渲染正確、進度條 thumb 位置隨即時價變動、按鈕與表單可正常互動、首頁 20+ 幣種與分析頁圖表捲動/更新流暢無明顯重繪卡頓
- 登入（Supabase 驗證）、設定頁儲存（Zustand `updateSettings`）、交易紀錄操作（關閉/刪除/同步）等既有功能行為不變

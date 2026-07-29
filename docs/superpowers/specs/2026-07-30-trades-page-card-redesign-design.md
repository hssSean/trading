# 交易紀錄頁卡片重設計 — Design Spec

日期：2026-07-30

## 背景

現行交易紀錄頁（`src/app/trades/page.tsx` 的 `TradeRow`）採極簡深色風格：`#0F141A` 底、細邊框、4 格純數字網格顯示進場/TP1/TP2/止損、純文字徽章。使用者反饋三點不滿：視覺風格通用（像預設 Tailwind 深色主題）、版面布局混亂、互動與動畫弱。

透過 mockup 反覆對比（Coinbase 柔和風 / Robinhood 大膽風 / Neutral Pro 極簡風三版），使用者選定「Coinbase 柔和風」方向並提供一張截圖作為最終定案樣式參照。本 spec 只涵蓋設計系統 token 更新 + 交易紀錄頁一個範例頁的重做，其餘頁面（首頁/分析頁/設定頁/登入頁）暫不動，待此範例驗證滿意後再擴散。

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

`TradeRow`（`src/app/trades/page.tsx`）改用上述元件組裝，資料邏輯（filter/sort/計算/R值/倉位計算）完全不動，只換渲染層。

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

**這次做**：`tailwind.config.ts` 新 token、`src/components/ui/` 四個新元件、`TradeRow` 改用新元件重繪五種狀態（等待進場/持倉中/追蹤TP2/已結束獲利/已結束虧損）。

**這次不做**：首頁/分析頁/設定頁/登入頁改版、資料邏輯變動、新增 npm 套件、`StatsHero`/篩選列的重設計（維持現狀，之後若對整體滿意再排下一輪）。

## 驗收標準

- 交易紀錄頁五種卡片狀態的視覺與提供的截圖及 mockup 一致
- `npx tsc --noEmit` 通過
- 本機 `npm run dev` 用瀏覽器預覽確認：卡片渲染正確、進度條 thumb 位置隨即時價變動、按鈕可點擊、40+ 筆紀錄時捲動流暢無明顯重繪卡頓
- 其餘頁面未受影響（`tailwind.config.ts` 只新增 token，未修改既有色值）

# 分析頁重繪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把設計系統色階套到分析頁（`src/app/analysis/[symbol]/page.tsx`）與 K 線圖（`CandlestickChart.tsx`）。這是全站改版第三階段。

**Architecture:** 純換色，不改版面結構（指標格/SMC區塊/SR清單/OB清單維持現行格狀排版，資訊密度高不適合大卡片動畫）。`CandlestickChart` 只調整圖表框架色（背景/格線/座標軸文字/邊框），K棒/EMA/OB/S-R/訊號線等語意色完全不動。

**Tech Stack:** Next.js 14、React 18、Tailwind CSS 3、lightweight-charts（既有依賴）、既有 `src/components/ui/*`（本階段不需要新元件）。

**依據 spec：** `docs/superpowers/specs/2026-07-30-trades-page-card-redesign-design.md`（分析頁章節）

## Global Constraints

- 不新增 npm 套件。
- 不改任何運算/資料邏輯（`analyze()`、`computeIndicators`、`findOrderBlocks`、`findSRLevels`、K 線資料處理）——只換顏色/class。
- `CandlestickChart` 的語意色（K棒漲跌、EMA20/50/200、S/R、OB、訊號線）維持現行 hex 值不變，只調背景/格線/座標軸文字/邊框這幾個框架色，貼合新卡片底色 `#141922`。
- 不修改全站共用的 `.card`/`.chip`/`.input-field` class（定義在 `src/app/globals.css`）——這些還被其他未改版頁面使用，這次分析頁的區塊改成各自寫明確的 class，不動共用定義。
- 驗證：`npx tsc --noEmit`；`CandlestickChart` 是圖表框架色調整，不易用 tsc 驗證視覺，靠人工預覽（若本機 Supabase session 不可用，退回確認編譯無誤 + console 無錯誤）。

---

## 檔案總覽

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/components/CandlestickChart.tsx` | 修改 | 圖表框架色調整（背景/格線/邊框/文字），語意色不動 |
| `src/app/analysis/[symbol]/page.tsx` | 修改 | 頁面 chrome（header/tabs/HTF徽章）+ 內容區塊（指標格/SMC/SR/OB/訊號區）換色，`Section`/`IndBox`/`LevelRow` 三個子元件跟著換 |

---

### Task 1: `CandlestickChart` 框架色調整

**Files:**
- Modify: `src/components/CandlestickChart.tsx`

**Interfaces:**
- Consumes: 無
- Produces: `CandlestickChart` 對外 props 不變

- [ ] **Step 1: 換圖表框架色常數**

在 `createChart()` 設定物件裡（目前第 41-62 行），把：

```typescript
        layout: {
          background: { type: ColorType.Solid, color: '#0A0D11' },
          textColor:  '#8A94A2',
          fontSize:   11,
        },
        grid: {
          vertLines: { color: '#141A21' },
          horzLines: { color: '#141A21' },
        },
        crosshair:       { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1B222B', minimumWidth: 72 },
        timeScale: {
          borderColor:    '#1B222B',
          timeVisible:    true,
          secondsVisible: false,
        },
```

換成：

```typescript
        layout: {
          background: { type: ColorType.Solid, color: '#141922' },
          textColor:  '#97A2B0',
          fontSize:   11,
        },
        grid: {
          vertLines: { color: '#1E252E' },
          horzLines: { color: '#1E252E' },
        },
        crosshair:       { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#242C37', minimumWidth: 72 },
        timeScale: {
          borderColor:    '#242C37',
          timeVisible:    true,
          secondsVisible: false,
        },
```

**不要動**以下語意色（漲跌/EMA/S-R/OB/訊號線/marker 全部原樣保留）：candlestick series 的 `upColor`/`downColor`/`wickUpColor`/`wickDownColor`（`#0ECB81`/`#F6465D`）、EMA 線色（`#2DD4BF55`/`#60A5FA55`/`#A855F7`）、S/R price line 色（`#0ECB8175`/`#F6465D75`）、order block 色（依 `ob.type` 算出的 `col`）、最佳訊號線色（`#3B82F6`/`#C084FC`/`#F6465D`/`#0ECB81`/`#00A040`）、marker 色。這些都在 Step 1 範圍以外，不要一起改。

- [ ] **Step 2: Legend 文字換 token**

把（目前第 170 行）：

```tsx
          <span key={label} className="flex items-center gap-1 text-[9px] text-[#3A424E]">
```

換成：

```tsx
          <span key={label} className="flex items-center gap-1 text-[9px] text-text-m">
```

Legend 裡每個項目的 `color`/`dot` 值（EMA20/50/200、支撐/阻力、OB▲/OB▼ 的顏色）維持不動——那些是圖例本身要對應圖表上的語意色，不能換。

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 4: Commit**

```bash
git add src/components/CandlestickChart.tsx
git commit -m "$(cat <<'EOF'
style: K 線圖框架色調整貼合新卡片底色

背景/格線/邊框/座標軸文字換新色階，K棒/EMA/OB/S-R/訊號線等語意色完全不動。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 分析頁換色

**Files:**
- Modify: `src/app/analysis/[symbol]/page.tsx`

**Interfaces:**
- Consumes: 無新元件（沿用既有 `SignalCard`/`CandlestickChart`，這兩個元件對外介面不變）
- Produces: `AnalysisPage` 對外行為不變（route/props 不變）

- [ ] **Step 1: Header 換色**

把（目前第 173-213 行）：

```tsx
      <div className="px-3 pt-14 pb-2 safe-top flex items-center gap-3 border-b border-[#1B222B]">
        <button
          onClick={() => router.back()}
          className="w-8 h-8 rounded border border-[#232B35] flex items-center justify-center text-[#2DD4BF] text-lg shrink-0"
        >
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-[#565E6B] text-[11px] num">{symbol}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-[#E8ECF1] text-[20px] num">
              {fmtPrice(currentPrice)}
            </span>
            {coin && (
              <span className={`text-sm num ${isUp ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                {isUp ? '+' : ''}{tick.changePct24h.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={handleUnlock}
            className={`text-[11px] border rounded px-2.5 py-1 transition-colors active:opacity-70 ${
              unlockFlash
                ? 'text-[#0ECB81] border-[#0ECB81]/50'
                : 'text-[#565E6B] border-[#1B222B]'
            }`}
            title="解除 LINE 推播鎖定，允許此幣種再次推薦新信號"
          >
            {unlockFlash ? '已解鎖' : '解鎖推播'}
          </button>
          <button
            onClick={() => analyze(tf)}
            disabled={loading}
            className="text-[#2DD4BF] text-[11px] border border-[#2DD4BF]/40 rounded px-2.5 py-1 disabled:opacity-40 active:opacity-70"
          >
            {loading ? '分析中…' : '重新整理'}
          </button>
        </div>
      </div>

      {/* ── Timeframe tabs ── */}
      <div className="flex gap-1.5 px-3 py-2.5">
        {TFS.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`flex-1 py-1.5 rounded text-[12px] num transition-all border ${
              tf === t
                ? 'text-[#2DD4BF] border-[#2DD4BF]/50'
                : 'text-[#565E6B] border-[#1B222B]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── K線圖 ── */}
      <div className="border-b border-[#1B222B]">
        {/* HTF bias badge */}
        {htfLabel && (
          <div className="px-3 pt-2 pb-0">
            <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border ${
              htfBias === 'LONG'  ? 'text-[#0ECB81] border-[#0ECB81]/30' :
              htfBias === 'SHORT' ? 'text-[#F6465D] border-[#F6465D]/30' :
              'text-[#565E6B] border-[#1B222B]'
            }`}>
              {htfLabel}
            </span>
          </div>
        )}
```

換成：

```tsx
      <div className="px-3 pt-14 pb-2 safe-top flex items-center gap-3 border-b border-white/[0.06]">
        <button
          onClick={() => router.back()}
          className="w-8 h-8 rounded-full border border-white/[0.08] flex items-center justify-center text-accent text-lg shrink-0"
        >
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-text-m text-[11px] num">{symbol}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-text-p text-[20px] num">
              {fmtPrice(currentPrice)}
            </span>
            {coin && (
              <span className={`text-sm num ${isUp ? 'text-up' : 'text-down'}`}>
                {isUp ? '+' : ''}{tick.changePct24h.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={handleUnlock}
            className={`text-[11px] border rounded-full px-2.5 py-1 transition-colors active:opacity-70 ${
              unlockFlash
                ? 'text-up border-up/50'
                : 'text-text-m border-white/[0.08]'
            }`}
            title="解除 LINE 推播鎖定，允許此幣種再次推薦新信號"
          >
            {unlockFlash ? '已解鎖' : '解鎖推播'}
          </button>
          <button
            onClick={() => analyze(tf)}
            disabled={loading}
            className="text-accent text-[11px] border border-accent/40 rounded-full px-2.5 py-1 disabled:opacity-40 active:opacity-70"
          >
            {loading ? '分析中…' : '重新整理'}
          </button>
        </div>
      </div>

      {/* ── Timeframe tabs ── */}
      <div className="flex gap-1.5 px-3 py-2.5">
        {TFS.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`flex-1 py-1.5 rounded-full text-[12px] num transition-all border ${
              tf === t
                ? 'text-accent border-accent/50'
                : 'text-text-m border-white/[0.08]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── K線圖 ── */}
      <div className="border-b border-white/[0.06]">
        {/* HTF bias badge */}
        {htfLabel && (
          <div className="px-3 pt-2 pb-0">
            <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${
              htfBias === 'LONG'  ? 'text-up border-up/30' :
              htfBias === 'SHORT' ? 'text-down border-down/30' :
              'text-text-m border-white/[0.08]'
            }`}>
              {htfLabel}
            </span>
          </div>
        )}
```

- [ ] **Step 2: 內容區塊換色**

把（目前第 259-421 行，主內容區的 error 區塊到檔案 return 結尾）：

```tsx
        {/* Error state */}
        {error && (
          <div className="card mb-4 border-[#F6465D]/30">
            <p className="text-[#F6465D] text-sm text-center">{error}</p>
            <button
              onClick={() => analyze(tf)}
              className="mt-3 w-full py-2 rounded border border-[#F6465D]/30 text-[#F6465D] text-sm"
            >
              重試
            </button>
          </div>
        )}
```

換成：

```tsx
        {/* Error state */}
        {error && (
          <div className="bg-card-2 border border-down/30 rounded-xl p-3.5 mb-4">
            <p className="text-down text-sm text-center">{error}</p>
            <button
              onClick={() => analyze(tf)}
              className="mt-3 w-full py-2 rounded-full border border-down/30 text-down text-sm"
            >
              重試
            </button>
          </div>
        )}
```

再把 SR 清單那一段（目前第 342-362 行）：

```tsx
                return (
                  <div key={i} className="flex items-center justify-between border border-[#1B222B] rounded px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${l.type === 'support' ? 'bg-[#0ECB81]' : 'bg-[#F6465D]'}`} />
                      <span className="text-[#E8ECF1] text-xs num">
                        {fmtPrice(l.price)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[#565E6B] text-[10px] num">觸碰 {l.touchCount}×</span>
                      <span className={`text-[10px] num ${dist > 0 ? 'text-[#F6465D]' : 'text-[#0ECB81]'}`}>
                        {dist > 0 ? '+' : ''}{dist.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                );
```

換成：

```tsx
                return (
                  <div key={i} className="flex items-center justify-between border border-white/[0.06] rounded-[10px] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${l.type === 'support' ? 'bg-up' : 'bg-down'}`} />
                      <span className="text-text-p text-xs num">
                        {fmtPrice(l.price)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-text-m text-[10px] num">觸碰 {l.touchCount}×</span>
                      <span className={`text-[10px] num ${dist > 0 ? 'text-down' : 'text-up'}`}>
                        {dist > 0 ? '+' : ''}{dist.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                );
```

再把 Order Blocks 清單那一段（目前第 371-385 行）：

```tsx
                <div key={i} className={`flex items-center justify-between rounded px-3 py-2 border ${ob.type === 'bullish' ? 'border-[#0ECB81]/20' : 'border-[#F6465D]/20'}`}>
                  <div>
                    <p className={`text-xs ${ob.type === 'bullish' ? 'text-[#0ECB81]' : 'text-[#F6465D]'}`}>
                      {ob.type === 'bullish' ? '看漲 OB' : '看跌 OB'} · 強度 {ob.strength}/5
                    </p>
                    <p className="text-[#565E6B] text-[10px] num mt-0.5">
                      {fmtPrice(ob.low)} — {fmtPrice(ob.high)}
                    </p>
                  </div>
                  <span className="text-[#565E6B] text-[10px] num">
                    {new Date(ob.time).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
```

換成：

```tsx
                <div key={i} className={`flex items-center justify-between rounded-[10px] px-3 py-2 border ${ob.type === 'bullish' ? 'border-up/20' : 'border-down/20'}`}>
                  <div>
                    <p className={`text-xs ${ob.type === 'bullish' ? 'text-up' : 'text-down'}`}>
                      {ob.type === 'bullish' ? '看漲 OB' : '看跌 OB'} · 強度 {ob.strength}/5
                    </p>
                    <p className="text-text-m text-[10px] num mt-0.5">
                      {fmtPrice(ob.low)} — {fmtPrice(ob.high)}
                    </p>
                  </div>
                  <span className="text-text-m text-[10px] num">
                    {new Date(ob.time).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
```

再把交易信號區塊標題與空狀態（目前第 391-416 行）：

```tsx
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[#E8ECF1] text-sm font-medium">
            交易信號 {coin?.signals.length ? `(${coin.signals.length})` : ''}
          </h3>
          {coin?.signals.length ? (
            <span className="text-[#565E6B] text-xs num">{tf} 週期</span>
          ) : null}
        </div>

        {loading && !coin?.signals.length ? (
          <div className="space-y-3">
            {[1, 2].map((k) => (
              <div key={k} className="card h-32 animate-pulse" />
            ))}
          </div>
        ) : coin?.signals.length ? (
          coin.signals.map((s) => <SignalCard key={s.id} signal={s} />)
        ) : (
          !loading && (
            <div className="card text-center py-8">
              <p className="text-[#2A323D] text-xl mb-2 num">?</p>
              <p className="text-[#8A94A2] text-sm">此時間週期暫無符合條件的信號</p>
              <p className="text-[#565E6B] text-xs mt-1">需要：得分 ≥9 且風險回報比 ≥2.0:1</p>
            </div>
          )
        )}
```

換成：

```tsx
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-text-p text-sm font-medium">
            交易信號 {coin?.signals.length ? `(${coin.signals.length})` : ''}
          </h3>
          {coin?.signals.length ? (
            <span className="text-text-m text-xs num">{tf} 週期</span>
          ) : null}
        </div>

        {loading && !coin?.signals.length ? (
          <div className="space-y-3">
            {[1, 2].map((k) => (
              <div key={k} className="bg-card-2 rounded-xl h-32 animate-pulse" />
            ))}
          </div>
        ) : coin?.signals.length ? (
          coin.signals.map((s) => <SignalCard key={s.id} signal={s} />)
        ) : (
          !loading && (
            <div className="bg-card-2 rounded-xl text-center py-8">
              <p className="text-text-m text-xl mb-2 num">?</p>
              <p className="text-text-s text-sm">此時間週期暫無符合條件的信號</p>
              <p className="text-text-m text-xs mt-1">需要：得分 ≥9 且風險回報比 ≥2.0:1</p>
            </div>
          )
        )}
```

- [ ] **Step 3: `Section`／`IndBox`／`LevelRow` 三個子元件換色**

把（目前第 424-499 行，`Section`/`colorMap`/`IndBox`/`LevelRow` 定義）：

```tsx
function Section({
  title,
  loading,
  children,
}: {
  title: string;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="card mb-3">
      <h3 className="text-[#E8ECF1] text-sm font-medium mb-3">{title}</h3>
      {loading ? (
        <div className="h-20 flex items-center justify-center">
          <div className="w-5 h-5 border-[1.5px] border-[#2DD4BF] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

type ColorType = 'green' | 'red' | 'neutral';
const colorMap: Record<ColorType, string> = {
  green: 'text-[#0ECB81]',
  red: 'text-[#F6465D]',
  neutral: 'text-[#E8ECF1]',
};

function IndBox({
  label,
  value,
  color,
  tag,
}: {
  label: string;
  value: string;
  color: ColorType;
  tag?: string;
}) {
  return (
    <div className="border border-[#1B222B] rounded p-2.5">
      <p className="tlabel mb-1 truncate">{label}</p>
      <p className={`${colorMap[color]} text-xs num truncate`}>{value}</p>
      {tag && <p className={`${colorMap[color]} text-[10px] mt-0.5 opacity-75`}>{tag}</p>}
    </div>
  );
}

function LevelRow({
  label,
  range,
  color,
  badge,
}: {
  label: string;
  range: string;
  color: 'green' | 'red';
  badge: string;
}) {
  const c = color === 'green' ? 'text-[#0ECB81]' : 'text-[#F6465D]';
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#1B222B] last:border-0">
      <div>
        <p className={`${c} text-xs`}>{label}</p>
        <p className="text-[#E8ECF1] text-xs num mt-0.5">{range}</p>
      </div>
      <span className={`${c} text-[10px] border px-1.5 py-0.5 rounded num`} style={{ borderColor: 'currentColor', opacity: 0.7 }}>
        {badge}
      </span>
    </div>
  );
}
```

換成：

```tsx
function Section({
  title,
  loading,
  children,
}: {
  title: string;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card-2 border border-white/[0.06] rounded-xl p-3.5 mb-3">
      <h3 className="text-text-p text-sm font-medium mb-3">{title}</h3>
      {loading ? (
        <div className="h-20 flex items-center justify-center">
          <div className="w-5 h-5 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

type ColorType = 'green' | 'red' | 'neutral';
const colorMap: Record<ColorType, string> = {
  green: 'text-up',
  red: 'text-down',
  neutral: 'text-text-p',
};

function IndBox({
  label,
  value,
  color,
  tag,
}: {
  label: string;
  value: string;
  color: ColorType;
  tag?: string;
}) {
  return (
    <div className="border border-white/[0.06] rounded-[10px] p-2.5">
      <p className="tlabel mb-1 truncate">{label}</p>
      <p className={`${colorMap[color]} text-xs num truncate`}>{value}</p>
      {tag && <p className={`${colorMap[color]} text-[10px] mt-0.5 opacity-75`}>{tag}</p>}
    </div>
  );
}

function LevelRow({
  label,
  range,
  color,
  badge,
}: {
  label: string;
  range: string;
  color: 'green' | 'red';
  badge: string;
}) {
  const c = color === 'green' ? 'text-up' : 'text-down';
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/[0.06] last:border-0">
      <div>
        <p className={`${c} text-xs`}>{label}</p>
        <p className="text-text-p text-xs num mt-0.5">{range}</p>
      </div>
      <span className={`${c} text-[10px] border px-1.5 py-0.5 rounded num`} style={{ borderColor: 'currentColor', opacity: 0.7 }}>
        {badge}
      </span>
    </div>
  );
}
```

（`Section`/`IndBox`/`LevelRow` 原本都靠共用 `.card`/裸 hex 撐視覺，這裡改成各自明確的 class，不動 `globals.css` 的 `.card` 定義本身。）

- [ ] **Step 4: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 5: Commit**

```bash
git add "src/app/analysis/[symbol]/page.tsx"
git commit -m "$(cat <<'EOF'
style: 分析頁換色套用新設計系統

header/timeframe tabs/指標格/SMC區塊/SR清單/OB清單/訊號區全部換色階，
版面結構、資料/運算邏輯完全不動；不動全站共用 .card class 定義。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 逐項比對確認零遺漏

**Files:**
- 無新檔案，這是驗證任務

**Interfaces:**
- 無

- [ ] **Step 1: 抓兩個版本的快照**

```bash
SCRATCH="$(mktemp -d)"
git log --oneline -5   # 找出 Task 1 commit 之前的那個 commit hash，記下來，下面用它取代 <BASE>
git show <BASE>:src/components/CandlestickChart.tsx > "$SCRATCH/old_chart.tsx"
git show <BASE>:"src/app/analysis/[symbol]/page.tsx" > "$SCRATCH/old_analysis.tsx"
cp src/components/CandlestickChart.tsx "$SCRATCH/new_chart.tsx"
cp "src/app/analysis/[symbol]/page.tsx" "$SCRATCH/new_analysis.tsx"
echo "$SCRATCH"
```

- [ ] **Step 2: 派 subagent 逐項比對**

比照這個專案先前對交易紀錄頁／首頁重繪做過的稽核方式：讀完整份新舊 `CandlestickChart.tsx`／分析頁，確認——

- `CandlestickChart`：所有語意色（K棒漲跌/EMA/S-R/OB/訊號線/marker）數值完全沒變，只有框架色（背景/格線/邊框/文字）換了；resize/生命週期邏輯沒被動到。
- 分析頁：header 的價格/漲跌%/解鎖推播/重新整理都在；timeframe tabs 全部 5 個週期都在且可切換樣式正確；HTF 偏多/偏空/盤整三種徽章文字與顏色邏輯都在；技術指標 6 格（RSI/MACD/趨勢/EMA20/50/200）的數值、顏色判斷（漲=green/跌=red/中性）、tag 文字都在；SMC 關鍵位置區塊（OB/FVG/SR 三種來源）都在；完整 SR 清單（距離%正負變色）都在；完整 Order Blocks 清單（強度/日期）都在；交易信號區塊（標題/計數/週期/loading skeleton/空狀態文案）都在。

輸出格式：每項一行「[檔案] [項目] — 存在於新版？是/否 — 位置或缺失說明」，最後一行明確結論。

- [ ] **Step 3: 處理發現的缺口**

若有缺漏，補進對應檔案，重跑 Step 2 直到「零遺漏」。

- [ ] **Step 4: 最終驗證**

```bash
npx tsc --noEmit
npx vitest run
npx next build
```

若 Step 3 有補丁，commit：

```bash
git add src/components/CandlestickChart.tsx "src/app/analysis/[symbol]/page.tsx"
git commit -m "$(cat <<'EOF'
fix: 補齊分析頁/K線圖逐項比對抓出的缺漏

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 完成後

分析頁階段完成後，下一步是設定頁 + 登入頁（`ToggleChip`/`FormField` 首次真正派上用場），最後是共用小元件（`BottomNav`/`BtcStatusBar`/`ScanStatusPanel`/`StatsHero`）。

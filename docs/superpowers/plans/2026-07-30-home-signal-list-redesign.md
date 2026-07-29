# 首頁／訊號列表重繪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已定案的 Coinbase 柔和風設計系統套到首頁（`src/app/page.tsx`）、幣種列表列（`CoinCard.tsx`）、訊號卡（`SignalCard.tsx`）。這是全站改版的第二階段（第一階段：交易紀錄頁 + 共用元件，已完成並上線）。

**Architecture:** 沿用第一階段已建好的 `src/components/ui/`（`TradeCard`/`PillBadge`/`StatChip`/`FormField`）。`CoinCard` 是高密度清單（20+ 列同時渲染），依 spec 只換色不換結構；`SignalCard` 形狀與已重繪過的 `TradeRow` 高度相似，套用同一組元件重建；首頁本身只動外層 chrome（header/按鈕/提示條/新增彈窗），不碰 `BtcStatusBar`/`ScanStatusPanel`（那兩個元件排進下一階段「共用小元件」）。

**Tech Stack:** Next.js 14、React 18、Tailwind CSS 3、既有 `src/components/ui/*`、lucide-react（既有依賴，不新增套件）。

**依據 spec：** `docs/superpowers/specs/2026-07-30-trades-page-card-redesign-design.md`（首頁／訊號列表章節）

## Global Constraints

- 不新增 npm 套件。
- `CoinCard.tsx` 只能換色／間距，不能改變欄位結構、寬度斷點（`w-[96px]`/`w-[76px]`）、或 `useTick` 訂閱模式（20+ 列效能考量，見檔案內既有邏輯）。
- `SignalCard.tsx` 重繪後，**原本存在的每一個欄位／文字／按鈕狀態都必須在新版找得到對應內容**（措辭/位置可以變，資訊不能消失）——上一階段的教訓：`TradeRow` 重繪時漏掉 7 個欄位，事後三輪比對才抓完。這裡直接把「逐項比對」排進 Task 4，不要等出包才做。
- `BtcStatusBar.tsx`、`ScanStatusPanel.tsx` 這次不動（下一階段「共用小元件」處理），首頁只調整自己 render 的 chrome。
- icon 一律用既有的 `lucide-react`。
- 驗證方式：純色階/結構不變的任務（Task 1）用 `npx tsc --noEmit`；有資訊重組風險的任務（Task 2、Task 3）除了 tsc，還要過 Task 4 的逐項比對關卡才算完成。

---

## 檔案總覽

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/components/CoinCard.tsx` | 修改 | 幣種列表列，機械式換色，結構不動 |
| `src/components/SignalCard.tsx` | 修改 | 訊號卡，套用 `TradeCard`/`PillBadge`/`StatChip`，欄位需逐一比對零遺漏 |
| `src/app/page.tsx` | 修改 | 首頁 chrome（header/按鈕/提示條/新增彈窗/空狀態）換色＋搜尋框改 `FormField` |

---

### Task 1: `CoinCard` 機械式換色

**Files:**
- Modify: `src/components/CoinCard.tsx`（全檔 88 行）

**Interfaces:**
- Consumes: 無新元件
- Produces: `CoinCard` 對外 props（`{ coin: WatchedCoin }`）不變，`useTick`/`useStore` 訂閱邏輯不動

- [ ] **Step 1: 換色**

用 Edit 工具，把整個 `CoinCard` 函式的 return JSX（目前第 29-80 行）換成：

```tsx
  return (
    <Link
      href={`/analysis/${coin.symbol}`}
      className="flex items-center px-3 py-2.5 border-b border-white/[0.05] active:bg-white/[0.03]"
    >
      {/* Symbol + timeframe */}
      <div className="w-[96px] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-text-p text-[13px] num">{coin.baseAsset}</span>
          {activeTrade && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
        </div>
        <div className="text-text-m text-[10px] mt-0.5 truncate">{coin.timeframes.join(' · ')}</div>
      </div>

      {/* Price + 24h change */}
      <div className="flex-1 text-right">
        {coin.isLoading ? (
          <div className="w-16 h-3.5 bg-white/[0.04] rounded animate-pulse ml-auto" />
        ) : (
          <>
            <div className="text-text-p text-[13px] num">{fmtPrice(tick.price)}</div>
            <div className={`text-[11px] num ${isUp ? 'text-up' : 'text-down'}`}>
              {isUp ? '+' : ''}{tick.changePct24h.toFixed(2)}%
            </div>
          </>
        )}
      </div>

      {/* Signal / live position */}
      <div className="w-[76px] text-right shrink-0">
        {activeTrade && livePnl !== null ? (
          <>
            <div className={`text-[12px] num ${livePnl >= 0 ? 'text-up' : 'text-down'}`}>
              {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
            </div>
            <div className="text-text-m text-[10px]">持倉</div>
          </>
        ) : latest ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className={latest.direction === 'LONG' ? 'text-up text-[11px]' : 'text-down text-[11px]'}>
              {latest.direction === 'LONG' ? '做多' : '做空'}
            </span>
            <span className="text-accent text-[12px] num">{latest.score}</span>
            {unread > 0 && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
          </div>
        ) : (
          <span className="text-text-m text-[12px]">—</span>
        )}
      </div>
    </Link>
  );
```

不動 `fmtPrice` 函式、不動 import、不動元件開頭的 hooks/計算邏輯（第 1-27 行）。

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/CoinCard.tsx
git commit -m "$(cat <<'EOF'
style: CoinCard 換色階套用新設計系統

只換色不換結構，20+ 列表格效能設計（useTick 逐幣訂閱）不動。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `SignalCard` 套用共用元件重繪

**Files:**
- Modify: `src/components/SignalCard.tsx`（全檔 161 行）

**Interfaces:**
- Consumes: `TradeCard`（`variant`/`className`/`onClick`/`children`）、`PillBadge`（`label`/`color`）、`StatChip`（`icon`/`label`/`value`），皆為 Phase 1 已建好的元件，路徑 `@/components/ui/TradeCard` 等
- Produces: `SignalCard` 對外 props（`{ signal, onClick, compact }`）不變

- [ ] **Step 1: 改 import**

在檔案開頭 import 區塊（目前第 1-8 行）新增：

```typescript
import { TradeCard } from '@/components/ui/TradeCard';
import { PillBadge } from '@/components/ui/PillBadge';
import { StatChip } from '@/components/ui/StatChip';
import { Wallet, Layers, ShieldAlert } from 'lucide-react';
```

- [ ] **Step 2: 重寫 return JSX 與內部小元件**

把整個檔案從 `return (`（目前第 62 行）到檔案結尾（第 161 行，含 `Tag`/`Row`/`fmtPrice` 三個輔助函式）整段換成：

```tsx
  return (
    <TradeCard
      variant="active"
      onClick={onClick}
      className={`${onClick ? 'cursor-pointer' : ''} ${!signal.isRead ? '!border-accent/45' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-3">
        <div
          className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[12px] font-medium"
          style={{
            background: `${isLong ? '#1D9E75' : '#E24B4A'}24`,
            color: isLong ? '#5DCAA5' : '#F09595',
          }}
        >
          {signal.symbol.replace('USDT', '').slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[14px] font-medium text-text-p">
              {signal.symbol.replace('USDT', '')}/USDT
            </span>
            {!signal.isRead && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
          </div>
          <div className="text-[11px] text-text-s flex items-center gap-1.5 flex-wrap mt-0.5">
            <span>{signal.timeframe} · {isLong ? '做多' : '做空'}</span>
            {isIntraday && <PillBadge label="日內" color="#2DD4BF" />}
            {isLimit    && <PillBadge label="限價" color="#8A94A2" />}
            {isHighVol  && <PillBadge label="高波動" color="#E6AF5A" />}
          </div>
        </div>
        <span className="text-accent text-[14px] num shrink-0">{signal.score}</span>
      </div>

      {/* Price grid 2x2 */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mb-3">
        <Row label="ENTRY" value={signal.entry}    colorClass="text-text-p" />
        <Row label="STOP"  value={signal.stopLoss} colorClass="text-down" />
        {tp1 != null && <Row label="TP1" value={tp1} colorClass="text-up" />}
        {tp2 != null && <Row label="TP2" value={tp2} colorClass="text-up" />}
      </div>

      {/* RR / TP1% / SL% */}
      <div className="text-[11px] text-text-s num mb-3">
        <span>RR 1:{signal.riskReward}</span>
        {tp1Pct != null && <span className="text-up"> · TP1 +{tp1Pct.toFixed(1)}%</span>}
        <span className="text-down"> · SL −{slPct.toFixed(1)}%</span>
      </div>

      {/* Position sizing */}
      {plan && (
        <div className="mb-3">
          <p className="tlabel mb-1.5">倉位計算（{effRisk}% 風險）</p>
          <div className="grid grid-cols-3 gap-2">
            <StatChip icon={<Wallet className="w-4 h-4" />} label="建議倉位" value={`${plan.positionUSDT}U`} />
            <StatChip icon={<Layers className="w-4 h-4" />} label="本金×槓桿" value={`${plan.marginUSDT}U×${plan.leverage}`} />
            <StatChip icon={<ShieldAlert className="w-4 h-4" />} label="止損虧損" value={`${plan.riskUSDT}U`} />
          </div>
          {plan.belowMinNotional && (
            <p className="text-[#E6AF5A] text-[10px] mt-1.5">低於交易所最低下單額 5U</p>
          )}
        </div>
      )}

      {/* Reasons */}
      {!compact && signal.reasons.length > 0 && (
        <div className="mb-3 border-t border-white/[0.06] pt-2.5 space-y-0.5">
          {signal.reasons.slice(0, 5).map((r, i) => (
            <p key={i} className="text-text-s text-[11px] leading-relaxed">› {r}</p>
          ))}
        </div>
      )}

      {/* Time + sync */}
      {!compact && (
        <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <span className="text-text-m text-[10px]">{timeAgo}</span>
          <button
            onClick={handleSync}
            disabled={hasTrade || justAdded || syncing}
            className={`text-[11px] font-medium px-3.5 py-1.5 rounded-full transition-colors ${
              flash
                ? 'border border-up/45 text-up'
                : justAdded || hasTrade
                ? 'border border-white/[0.08] text-text-m cursor-not-allowed'
                : 'bg-accent text-[#0A0D11] active:opacity-80'
            }`}
          >
            {flash ? '✓ 已同步' : justAdded ? '已在紀錄' : hasTrade ? '已持倉' : syncing ? '同步中…' : '同步 ▸'}
          </button>
        </div>
      )}
    </TradeCard>
  );
}

function Row({ label, value, colorClass }: { label: string; value: number; colorClass: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-dotted border-white/[0.08] pb-1">
      <span className="tlabel">{label}</span>
      <span className={`text-[13px] num ${colorClass}`}>{fmtPrice(value)}</span>
    </div>
  );
}

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}
```

注意：舊版的 `Tag` 輔助函式（原第 139-145 行）不再被使用（`日內`/`限價`/`高波動` 標籤改用 `PillBadge`），連同其定義一起刪除，不要留下死 code。`Row` 函式保留但 prop 從 `color`（inline style hex）改成 `colorClass`（Tailwind class），呼叫端也要對應更新（已在上面的新 JSX 裡處理）。

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 4: Commit**

```bash
git add src/components/SignalCard.tsx
git commit -m "$(cat <<'EOF'
feat: SignalCard 套用 Coinbase 柔和風設計系統元件

改用 TradeCard/PillBadge/StatChip 組裝，資料邏輯（同步/位置計算）不動，
逐項核對舊版所有欄位（RR/TP1%/SL%/倉位計算三項/高波動限價日內標籤/
未讀提示/理由列表/同步按鈕五種狀態）皆保留。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 首頁 chrome 換色 + 搜尋框改 `FormField`

**Files:**
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `FormField`（`label`/`value`/`onChange`/`placeholder`），Phase 1 已建好，路徑 `@/components/ui/FormField`
- Produces: 無新對外介面，`HomePage`/`EmptyState` 簽名不變

- [ ] **Step 1: 改 import**

在檔案開頭 import 區塊（目前第 1-13 行）新增：

```typescript
import { FormField } from '@/components/ui/FormField';
```

- [ ] **Step 2: Header 區塊換色**

把（目前第 280-319 行）：

```tsx
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 pt-14 pb-2.5 safe-top border-b border-[#1B222B]">
        <div>
          <h1 className="text-[#E8ECF1] text-[15px] font-medium tracking-[0.05em]">幣種監控</h1>
          <p className="text-[#565E6B] text-[10px] mt-0.5 num">
            {coins.length} 監控 · {coins.filter((c) => c.signals.length > 0).length} 訊號
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex gap-1.5">
          <button
            onClick={() => loadTopCoins(false)}
            disabled={autoLoading || refreshing}
            className="text-[#8A94A2] text-[11px] px-2.5 py-1 border border-[#232B35] rounded disabled:opacity-40 active:bg-[#141A21]"
          >
            {autoLoading ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-[#8A94A2] border-t-transparent rounded-full animate-spin inline-block" />
                載入
              </span>
            ) : '熱門'}
          </button>
          <button
            onClick={analyzeAll}
            disabled={refreshing || autoLoading}
            className="text-[#2DD4BF] text-[11px] px-2.5 py-1 border border-[#2DD4BF]/40 rounded disabled:opacity-40 active:bg-[#141A21]"
          >
            {refreshing ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-[#2DD4BF] border-t-transparent rounded-full animate-spin inline-block" />
                掃描中
              </span>
            ) : '掃描'}
          </button>
          <button onClick={() => setShowAdd(true)} className="bg-[#2DD4BF] text-[#0A0D11] text-[11px] font-medium px-2.5 py-1 rounded active:opacity-80">
            +
          </button>
        </div>
      </div>
```

換成：

```tsx
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-3 pt-14 pb-2.5 safe-top border-b border-white/[0.06]">
        <div>
          <h1 className="text-text-p text-[15px] font-medium tracking-[0.05em]">幣種監控</h1>
          <p className="text-text-m text-[10px] mt-0.5 num">
            {coins.length} 監控 · {coins.filter((c) => c.signals.length > 0).length} 訊號
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex gap-1.5">
          <button
            onClick={() => loadTopCoins(false)}
            disabled={autoLoading || refreshing}
            className="text-text-s text-[11px] px-2.5 py-1 rounded-full border border-white/[0.08] disabled:opacity-40 active:bg-white/[0.04]"
          >
            {autoLoading ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-text-s border-t-transparent rounded-full animate-spin inline-block" />
                載入
              </span>
            ) : '熱門'}
          </button>
          <button
            onClick={analyzeAll}
            disabled={refreshing || autoLoading}
            className="text-accent text-[11px] px-2.5 py-1 rounded-full border border-accent/40 disabled:opacity-40 active:bg-white/[0.04]"
          >
            {refreshing ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin inline-block" />
                掃描中
              </span>
            ) : '掃描'}
          </button>
          <button onClick={() => setShowAdd(true)} className="bg-accent text-[#0A0D11] text-[11px] font-medium px-2.5 py-1 rounded-full active:opacity-80">
            +
          </button>
        </div>
      </div>
```

（`tailwind.config.ts` 的 `colors` 底下任何自訂 key，Tailwind 都會自動產生對應的 `text-*`/`bg-*`/`border-*` 工具類別，所以 `border-text-s`/`border-accent` 這類寫法是有效的，不用改寫成 hex。）

- [ ] **Step 3: 提示條區塊換色**

把（目前第 324-377 行）所有 `bg-[#0F141A] border border-[#1B222B]` 換成 `bg-card-2 border border-white/[0.06]`，`text-[#8A94A2]`/`text-[#565E6B]` 換成 `text-text-s`/`text-text-m`，`text-[#2DD4BF]`/`border-[#2DD4BF]` 換成 `text-accent`/`border-accent`，`text-[#0ECB81]`/`bg-[#0ECB81]` 換成 `text-up`/`bg-up`，`text-[#F6465D]`/`bg-[#F6465D]` 換成 `text-down`/`bg-down`，`bg-[#141A21]`（sentiment bar 軌道背景）換成 `bg-white/[0.06]`。條件邏輯與文字內容完全不動，只換色值/class 名稱。

- [ ] **Step 4: 欄位標題列 + 新增彈窗換色 + 搜尋框改 `FormField`**

把欄位標題列（目前第 385-390 行）的 `border-[#1B222B]`/`bg-[#0C1116]`/`tlabel` 保留 `tlabel`，邊框換 `border-white/[0.06]`，背景換 `bg-white/[0.02]`。

新增彈窗（目前第 397-448 行）把外層 `bg-[#0F141A]`/`border-[#1B222B]` 換成 `bg-card-2`/`border-white/[0.06]`，圓角維持 `rounded-t-3xl`（modal 專屬樣式，不受 `card-lg` token 影響），內部 `chip` class（既有 `.chip`）維持不動（那是全站共用的舊 class，這次不擴大範圍去改）。

把原本的搜尋 `<input>`（目前約第 411-418 行）：

```tsx
            <input
              autoFocus
              value={input}
              onChange={(e) => { setInput(e.target.value.toUpperCase()); setAddError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="輸入代號，例如：BTC、SOL"
              className="input-field mb-2"
            />
```

換成：

```tsx
            <div className="mb-2" onKeyDown={(e) => e.key === 'Enter' && handleAdd()}>
              <FormField
                label="幣種代號"
                value={input}
                onChange={(v) => { setInput(v.toUpperCase()); setAddError(''); }}
                placeholder="輸入代號，例如：BTC、SOL"
              />
            </div>
```

（`FormField` 本身沒有 `autoFocus`/`onKeyDown` prop，用外層 `div` 包一層接住 Enter 鍵；`autoFocus` 這個次要行為可以省略——原本是方便使用者不用點兩下，不影響核心功能，若要保留可以額外加 `useEffect` + `ref`，但這不在本次「換色+搜尋框元件化」範圍內，先不做。）

搜尋結果清單（目前第 419-431 行）、錯誤訊息、取消/新增按鈕的顏色一併比照上面規則換成 token class。

- [ ] **Step 5: `EmptyState` 換色**

把 `EmptyState` 函式（目前第 453-471 行）內的 `text-[#2A323D]`/`text-[#8A94A2]`/`text-[#565E6B]`/`border-[#232B35]` 換成對應 token（`text-text-m`/`text-text-s`/`text-text-m`/`border-white/[0.08]`），`btn-primary` class 維持不動（既有全站共用 class）。

- [ ] **Step 6: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx
git commit -m "$(cat <<'EOF'
style: 首頁 chrome 換色套用新設計系統，搜尋框改用 FormField

header/提示條/新增彈窗/空狀態全部換色階；BtcStatusBar/ScanStatusPanel
排進下一階段共用小元件 plan，這次不動。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 逐項比對 `CoinCard`／`SignalCard` 舊版 vs 新版，零遺漏才算過

**Files:**
- 無新檔案，這是驗證任務

**Interfaces:**
- 無

這個任務直接把上一階段（交易紀錄頁）事後才做、且做了三輪才抓完的「新舊版本逐項比對」排進計畫本身，不要等改完才臨時想到。

- [ ] **Step 1: 抓兩個版本的快照**

```bash
SCRATCH="$(mktemp -d)"
git show HEAD~3:src/components/CoinCard.tsx > "$SCRATCH/old_coincard.tsx" 2>/dev/null || echo "調整 HEAD~N 為 Task 1 commit 前的那個 commit"
git show HEAD~2:src/components/SignalCard.tsx > "$SCRATCH/old_signalcard.tsx" 2>/dev/null || echo "調整 HEAD~N 為 Task 2 commit 前的那個 commit"
cp src/components/CoinCard.tsx "$SCRATCH/new_coincard.tsx"
cp src/components/SignalCard.tsx "$SCRATCH/new_signalcard.tsx"
echo "$SCRATCH"
```

（`HEAD~N` 的實際數字要看執行到這裡時 commit 順序而定——找出 Task 1/Task 2 commit 之前的那個 commit hash，用 `git log --oneline` 確認，不要憑感覺猜數字。）

- [ ] **Step 2: 派 subagent 逐項比對**

用一般用途 subagent，比照這份 plan 所屬專案在交易紀錄頁重繪後做的稽核方式：讀完整份新舊 `CoinCard`/`SignalCard`，列出舊版每一個資訊點/按鈕/條件分支，逐一確認新版是否存在對應內容（樣式/位置可以變，資訊不能消失）。輸出格式：每項一行「[元件] [項目] — 存在於新版？是/否 — 位置或缺失說明」，最後一行明確結論。

- [ ] **Step 3: 處理發現的缺口**

若發現任何缺漏，回頭補進 `CoinCard.tsx`/`SignalCard.tsx`，補完後重跑 Step 2 直到結論是「零遺漏」。

- [ ] **Step 4: 最終驗證 + commit（若有補丁）**

```bash
npx tsc --noEmit
npx vitest run
npx next build
```

若 Step 3 有補丁，commit：

```bash
git add src/components/CoinCard.tsx src/components/SignalCard.tsx
git commit -m "$(cat <<'EOF'
fix: 補齊 CoinCard/SignalCard 逐項比對抓出的缺漏

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

若 Step 2 一次就零遺漏，這個任務不需要額外 commit，直接標記完成。

---

## 完成後

首頁/訊號列表階段完成後，下一步是分析頁（`src/app/analysis/[symbol]/page.tsx` + `CandlestickChart.tsx`），再來是設定頁+登入頁（含 `ToggleChip` 首次派上用場），最後是共用小元件（`BottomNav`/`BtcStatusBar`/`ScanStatusPanel`/`StatsHero`）。

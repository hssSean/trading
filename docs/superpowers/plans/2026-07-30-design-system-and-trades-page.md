# 設計系統基礎元件 + 交易紀錄頁重繪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 6 個共用 UI 元件（Coinbase 柔和風設計語言）並套用到交易紀錄頁的 `TradeRow`，取代現行極簡深色/純數字網格風格。這是全站改版的第一份 plan（後續首頁/分析頁/設定頁/登入頁各自另開 plan，重用這裡建的元件）。

**Architecture:** 純前端視覺層變更。新元件放 `src/components/ui/`（無外部依賴，純 Tailwind + CSS transition），一個純函數 `calcProgressRatio` 抽到 `src/lib/priceProgress.ts` 供 vitest 測試。`TradeRow` 的資料邏輯（filter/sort/R值/倉位計算/即時價訂閱）完全不動，只換 JSX 渲染層。

**Tech Stack:** Next.js 14 App Router、React 18、Tailwind CSS 3、Zustand（既有，不變）、vitest（既有，不新增依賴）、lucide-react（既有 icon 套件，不新增依賴）。

**依據 spec：** `docs/superpowers/specs/2026-07-30-trades-page-card-redesign-design.md`

## Global Constraints

- 不新增 npm 套件（不裝 framer-motion / class-variance-authority 等）——動畫全部用 CSS transition/`@keyframes` + `animate-pulse`（Tailwind 內建）。
- `tailwind.config.ts` 只能新增 key，不可修改/刪除既有 `colors`/`fontFamily`/`screens` 的既有值（其他頁面還在用）。
- icon 一律用專案既有的 `lucide-react`（見 `src/components/BottomNav.tsx` 的 import 慣例），不要引入其他 icon 套件。
- 這批新元件是純展示元件（無業務邏輯），本身不寫 RTL/snapshot 測試（專案沒有這個慣例，見 `package.json` 只有 vitest 跑 `tests/*.test.ts` 純函數測試）。每個元件任務的驗證方式是 `npx tsc --noEmit` 型別檢查通過；唯一有真正邏輯分支的 `calcProgressRatio` 用 vitest 寫實際單元測試（跟 `tests/deriveCloseReason.test.ts` 同慣例：`tests/<name>.test.ts` import `../src/lib/<name>`）。
- 完整視覺驗證（瀏覽器預覽）留到最後一個整合任務（Task 8），逐元件單獨驗證會需要重複起 dev server，效率低。
- 修改既有檔案前用 `Read` 工具確認目前行號，因為每個任務完成後行號可能偏移——下面標的行號以本 plan撰寫時讀到的內容為準，執行時請以實際檔案內容為準做字串比對（用 Edit 工具的 old_string 精確比對，不要單純依賴行號）。

---

## 檔案總覽

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/lib/priceProgress.ts` | 新建 | `calcProgressRatio` 純函數：依方向正規化現價在 SL→TP2 區間的位置比例 |
| `tests/priceProgress.test.ts` | 新建 | `calcProgressRatio` 單元測試 |
| `src/app/globals.css` | 修改 | 新增 `card-enter` keyframe + utility class |
| `tailwind.config.ts` | 修改 | 新增 `card-2`/`card-2-alt` 色彩、`card-lg` 圓角 token |
| `src/components/ui/TradeCard.tsx` | 新建 | 卡片外殼（active/closed/waiting 三種 variant） |
| `src/components/ui/PillBadge.tsx` | 新建 | 狀態/方向膠囊徽章，支援呼吸動畫 |
| `src/components/ui/StatChip.tsx` | 新建 | icon+label+value 資訊 chip |
| `src/components/ui/PriceProgressBar.tsx` | 新建 | SL→Entry→TP1→TP2 視覺進度條 |
| `src/components/ui/FormField.tsx` | 新建 | 文字/數字/密碼輸入框（本 plan 先建好，設定頁/登入頁的 plan 會用到） |
| `src/components/ui/ToggleChip.tsx` | 新建 | 分段選擇按鈕（同上，先建好備用） |
| `src/app/trades/page.tsx` | 修改 | `TradeRow` 改用上述元件重繪五種狀態，移除已死的 `PriceCell` |

---

### Task 1: `calcProgressRatio` 純函數

**Files:**
- Create: `src/lib/priceProgress.ts`
- Test: `tests/priceProgress.test.ts`

**Interfaces:**
- Produces: `calcProgressRatio(params: { direction: 'LONG' | 'SHORT'; stopLoss: number; tp2: number; current: number }): number` — 回傳 clamp 在 `[0, 1]` 的比例，供 Task 5 的 `PriceProgressBar` 使用

- [ ] **Step 1: 寫失敗測試**

Create `tests/priceProgress.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { calcProgressRatio } from '../src/lib/priceProgress';

describe('calcProgressRatio', () => {
  it('LONG: 現價在止損位 → 0', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 100 })).toBe(0);
  });

  it('LONG: 現價在 TP2 → 1', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 200 })).toBe(1);
  });

  it('LONG: 現價在中點 → 0.5', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 150 })).toBe(0.5);
  });

  it('LONG: 現價跌破止損 → clamp 到 0', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 80 })).toBe(0);
  });

  it('LONG: 現價超過 TP2 → clamp 到 1', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 200, current: 250 })).toBe(1);
  });

  it('SHORT: 現價在止損位（價格較高）→ 0', () => {
    expect(calcProgressRatio({ direction: 'SHORT', stopLoss: 200, tp2: 100, current: 200 })).toBe(0);
  });

  it('SHORT: 現價在 TP2（價格較低）→ 1', () => {
    expect(calcProgressRatio({ direction: 'SHORT', stopLoss: 200, tp2: 100, current: 100 })).toBe(1);
  });

  it('SHORT: 現價在中點 → 0.5', () => {
    expect(calcProgressRatio({ direction: 'SHORT', stopLoss: 200, tp2: 100, current: 150 })).toBe(0.5);
  });

  it('止損等於 TP2（分母為 0）不噴例外，回傳 0', () => {
    expect(calcProgressRatio({ direction: 'LONG', stopLoss: 100, tp2: 100, current: 100 })).toBe(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/priceProgress.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/priceProgress'`）

- [ ] **Step 3: 寫最小實作**

Create `src/lib/priceProgress.ts`:

```typescript
export interface CalcProgressRatioParams {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  tp2: number;
  current: number;
}

// Normalizes current price into a 0 (stop loss) → 1 (TP2) ratio along the
// risk→reward direction, so LONG and SHORT trades share the same visual
// scale regardless of which raw price is numerically larger.
export function calcProgressRatio({ direction, stopLoss, tp2, current }: CalcProgressRatioParams): number {
  const span = direction === 'LONG' ? tp2 - stopLoss : stopLoss - tp2;
  if (span === 0) return 0;
  const progressed = direction === 'LONG' ? current - stopLoss : stopLoss - current;
  const ratio = progressed / span;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/priceProgress.test.ts`
Expected: PASS（9 個測試全過）

- [ ] **Step 5: Commit**

```bash
git add src/lib/priceProgress.ts tests/priceProgress.test.ts
git commit -m "$(cat <<'EOF'
feat: 新增 calcProgressRatio 純函數，供交易卡片進度條使用

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Tailwind token + 進場動畫 CSS + `TradeCard` 元件

**Files:**
- Modify: `tailwind.config.ts`
- Modify: `src/app/globals.css`
- Create: `src/components/ui/TradeCard.tsx`

**Interfaces:**
- Consumes: 無
- Produces: `TradeCard` React 元件 `({ variant, className, onClick, children }: { variant: 'active' | 'closed' | 'waiting'; className?: string; onClick?: () => void; children: React.ReactNode }) => JSX.Element`，Tailwind class `bg-card-2`/`bg-card-2-alt`/`rounded-card-lg`，CSS class `card-enter`

- [ ] **Step 1: 在 `tailwind.config.ts` 新增 token**

Modify `tailwind.config.ts` — 在 `theme.extend.colors` 物件內、`red` 那組之後加入新 key（不動任何既有 key）：

```typescript
        red: { 300: '#F87088', 400: '#F6465D', 500: '#F6465D', 600: '#D93A4E' },
        'card-2': '#141922',
        'card-2-alt': '#12161C',
      },
      borderRadius: {
        'card-lg': '20px',
      },
      fontFamily: {
```

（即在既有 `colors: { ... red: {...}, }` 的收尾大括號前插入 `'card-2'`/`'card-2-alt'` 兩行，並在 `colors` 物件結束後、`fontFamily` 之前插入新的 `borderRadius` 區塊。）

- [ ] **Step 2: 在 `globals.css` 新增進場動畫**

Modify `src/app/globals.css` — 在 `@layer utilities { ... }` 區塊內、`.tlabel` 規則之後加入：

```css
  .tlabel {
    @apply text-[#565E6B] text-[10px] tracking-[0.08em];
  }
  /* Card mount-in animation — Coinbase-calm redesign micro-interaction */
  .card-enter {
    animation: card-enter .4s ease-out both;
  }
}

@keyframes card-enter {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
```

（`.card-enter` 規則放在 `@layer utilities` 內，`@keyframes` 放在 layer 外面——PostCSS/Tailwind 的 `@layer` 不支援巢狀 `@keyframes`。）

- [ ] **Step 3: 建立 `TradeCard` 元件**

Create `src/components/ui/TradeCard.tsx`:

```tsx
import { ReactNode } from 'react';

export type TradeCardVariant = 'active' | 'closed' | 'waiting';

interface TradeCardProps {
  variant: TradeCardVariant;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}

const VARIANT_CLASS: Record<TradeCardVariant, string> = {
  active:  'bg-card-2 border border-white/[0.06]',
  closed:  'bg-card-2-alt border border-white/[0.04]',
  waiting: 'bg-card-2 border border-dashed border-amber-500/30',
};

export function TradeCard({ variant, className = '', onClick, children }: TradeCardProps) {
  return (
    <div
      onClick={onClick}
      className={`relative rounded-card-lg p-4 mb-3 card-enter ${VARIANT_CLASS[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤（`TradeCard.tsx` 目前無消費者，但語法/型別需通過）

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.ts src/app/globals.css src/components/ui/TradeCard.tsx
git commit -m "$(cat <<'EOF'
feat: 新增 card-2 色彩 token 與 TradeCard 共用卡片外殼

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `PillBadge` 元件

**Files:**
- Create: `src/components/ui/PillBadge.tsx`

**Interfaces:**
- Produces: `PillBadge` 元件 `({ label, color, pulse }: { label: string; color: string; pulse?: boolean }) => JSX.Element`

- [ ] **Step 1: 建立元件**

Create `src/components/ui/PillBadge.tsx`:

```tsx
interface PillBadgeProps {
  label: string;
  color: string;
  pulse?: boolean;
}

export function PillBadge({ label, color, pulse = false }: PillBadgeProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap"
      style={{ background: `${color}24`, color }}
    >
      {pulse && (
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: color }}
        />
      )}
      {label}
    </span>
  );
}
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/PillBadge.tsx
git commit -m "$(cat <<'EOF'
feat: 新增 PillBadge 共用徽章元件

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `StatChip` 元件

**Files:**
- Create: `src/components/ui/StatChip.tsx`

**Interfaces:**
- Produces: `StatChip` 元件 `({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) => JSX.Element`

- [ ] **Step 1: 建立元件**

Create `src/components/ui/StatChip.tsx`:

```tsx
import { ReactNode } from 'react';

interface StatChipProps {
  icon: ReactNode;
  label: string;
  value: string;
}

export function StatChip({ icon, label, value }: StatChipProps) {
  return (
    <div className="flex-1 flex items-center gap-2.5 rounded-[10px] bg-white/[0.04] px-3 py-2.5 min-w-0">
      <span className="text-text-s shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] text-text-s truncate">{label}</div>
        <div className="text-[12px] text-text-p num mt-0.5 truncate">{value}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/StatChip.tsx
git commit -m "$(cat <<'EOF'
feat: 新增 StatChip 共用資訊卡片元件

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `PriceProgressBar` 元件

**Files:**
- Create: `src/components/ui/PriceProgressBar.tsx`

**Interfaces:**
- Consumes: `calcProgressRatio` from `src/lib/priceProgress.ts`（Task 1）
- Produces: `PriceProgressBar` 元件 `({ direction, stopLoss, entry, tp1, tp2, current, formatPrice }: { direction: 'LONG' | 'SHORT'; stopLoss: number; entry: number; tp1: number; tp2: number; current: number; formatPrice: (n: number) => string }) => JSX.Element`

- [ ] **Step 1: 建立元件**

Create `src/components/ui/PriceProgressBar.tsx`:

```tsx
import { calcProgressRatio } from '@/lib/priceProgress';

interface PriceProgressBarProps {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  entry: number;
  tp1: number;
  tp2: number;
  current: number;
  formatPrice: (n: number) => string;
}

export function PriceProgressBar({ direction, stopLoss, entry, tp1, tp2, current, formatPrice }: PriceProgressBarProps) {
  const ratio = calcProgressRatio({ direction, stopLoss, tp2, current });
  const pct = ratio * 100;

  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-white/[0.07] mb-2">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-accent transition-[width] duration-1000 ease-out"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-accent shadow-[0_0_0_3px_rgba(45,212,191,0.25)] transition-[left] duration-1000 ease-out"
          style={{ left: `${pct}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>
      <div className="flex justify-between text-[10px] num">
        <span className="text-down">止損 {formatPrice(stopLoss)}</span>
        <span className="text-text-s">進場 {formatPrice(entry)}</span>
        <span className="text-accent">TP1 {formatPrice(tp1)}</span>
        <span className="text-accent">TP2 {formatPrice(tp2)}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤（確認 `@/lib/priceProgress` path alias 解析正確——專案既有 `@/*` alias，見其他檔案 `import { useStore } from '@/store/useStore'` 慣例）

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/PriceProgressBar.tsx
git commit -m "$(cat <<'EOF'
feat: 新增 PriceProgressBar 價格區間視覺進度條元件

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `FormField` 元件

**Files:**
- Create: `src/components/ui/FormField.tsx`

**Interfaces:**
- Produces: `FormField` 元件 `({ label, type, value, onChange, placeholder }: { label: string; type?: 'text' | 'number' | 'password' | 'email'; value: string; onChange: (v: string) => void; placeholder?: string }) => JSX.Element`（本 plan 先建好，交易紀錄頁不消費；設定頁/登入頁的後續 plan 會用到）

- [ ] **Step 1: 建立元件**

Create `src/components/ui/FormField.tsx`:

```tsx
interface FormFieldProps {
  label: string;
  type?: 'text' | 'number' | 'password' | 'email';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export function FormField({ label, type = 'text', value, onChange, placeholder }: FormFieldProps) {
  return (
    <label className="block">
      <span className="block text-[11px] text-text-s mb-1.5">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-card-2 border border-white/[0.06] rounded-[10px] px-3 py-2.5 text-[13px] text-text-p outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 transition-colors placeholder:text-text-m"
      />
    </label>
  );
}
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/FormField.tsx
git commit -m "$(cat <<'EOF'
feat: 新增 FormField 共用輸入框元件（設定頁/登入頁預備）

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `ToggleChip` 元件

**Files:**
- Create: `src/components/ui/ToggleChip.tsx`

**Interfaces:**
- Produces: `ToggleChip` 元件 `({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => JSX.Element`（本 plan 先建好，交易紀錄頁不消費；設定頁/登入頁的後續 plan 會用到）

- [ ] **Step 1: 建立元件**

Create `src/components/ui/ToggleChip.tsx`:

```tsx
interface ToggleChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

export function ToggleChip({ label, active, onClick }: ToggleChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
        active ? 'bg-accent/20 border-accent/40 text-accent' : 'border-white/[0.08] text-text-s'
      }`}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/ToggleChip.tsx
git commit -m "$(cat <<'EOF'
feat: 新增 ToggleChip 共用分段選擇元件（設定頁/登入頁預備）

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `TradeRow` 改用新元件重繪五種狀態

**Files:**
- Modify: `src/app/trades/page.tsx`（`TradeRow` 元件，目前約在 133-520 行；`PriceCell` 定義約在 1561-1568 行，重繪後不再被使用要一併刪除）

**Interfaces:**
- Consumes: `TradeCard`（Task 2）、`PillBadge`（Task 3）、`StatChip`（Task 4）、`PriceProgressBar`（Task 5）、`calcRMultiple`/`accountPnlPct`/`isWinTrade`/`isLossTrade`/`fmtPrice`/`fmtDate`/`fmtDuration`/`RESULT_LABEL`/`RESULT_COLOR`/`Tag`（既有，同檔案內，不動）
- Produces: `TradeRow` 元件對外 props 簽名不變（`TradeRowProps` interface 不動），呼叫端（`TradesPage` 內的 `filtered.map(t => <TradeRow ... />)`）不用改

- [ ] **Step 1: 在檔案頂部新增 import**

在 `src/app/trades/page.tsx` 現有 import 區塊（第 1-9 行）最後加入：

```typescript
import { TradeCard } from '@/components/ui/TradeCard';
import { PillBadge } from '@/components/ui/PillBadge';
import { StatChip } from '@/components/ui/StatChip';
import { PriceProgressBar } from '@/components/ui/PriceProgressBar';
import { Wallet, ShieldAlert, LineChart, FileText } from 'lucide-react';
```

- [ ] **Step 2: 刪除已死的 `PriceCell` 元件**

用 Edit 工具，把（bottom of file，約 1561-1568 行）：

```tsx
function PriceCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#0F141A] p-2 text-center">
      <div className="tlabel">{label}</div>
      <div className="text-[12px] num mt-0.5" style={{ color: color ?? '#E8ECF1' }}>{value}</div>
    </div>
  );
}

```

換成空字串（整段刪除，含前後各一個換行，避免留兩個空行）。

- [ ] **Step 3: 重寫 `TradeRow` 的 return JSX**

用 Edit 工具，把原本 `TradeRow` 函式的 `return (` 到函式結尾的 `);\n});`（原檔案第 181-520 行，從 `return (` 開始到 `TradeRow` 的收尾 `});`）整段換成：

```tsx
  const cardVariant = isWaiting ? 'waiting' : (isPending || isWatchingTp2 || isUnconfirmed) ? 'active' : 'closed';
  const displayPrice = livePx > 0 ? livePx : trade.entry;

  return (
    <TradeCard
      variant={cardVariant}
      onClick={selectMode ? () => toggleSelect(trade.id) : undefined}
      className={
        (selectMode ? 'cursor-pointer select-none ' : '') +
        (selectMode && selected ? '!border-accent/50 !bg-accent/5 ' : '') +
        (isPending && nearSL ? '!border-down/40' : '')
      }
    >
      {selectMode && (
        <div
          className="absolute top-3.5 right-3.5 w-4 h-4 rounded-full border flex items-center justify-center"
          style={{ borderColor: selected ? '#2DD4BF' : '#3A424E', background: selected ? '#2DD4BF' : 'transparent' }}
        >
          {selected && <span className="text-[#0A0D11] text-[9px] leading-none">✓</span>}
        </div>
      )}

      {/* Header: coin avatar + name + status badge */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[12px] font-medium"
            style={{
              background: `${trade.direction === 'LONG' ? '#1D9E75' : '#E24B4A'}24`,
              color: trade.direction === 'LONG' ? '#5DCAA5' : '#F09595',
            }}
          >
            {trade.symbol.replace('USDT', '').slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-text-p flex items-center gap-1.5 flex-wrap">
              {trade.symbol.replace('USDT', '')}/USDT
              {trade.tier === 'B' && <Tag text="B 輕倉 0.5%" />}
            </div>
            <div className="text-[11px] text-text-s truncate">
              {trade.timeframe} · {trade.direction === 'LONG' ? '做多' : '做空'}
              {(isPending || isWaiting || isUnconfirmed) && ` · ${fmtDuration(now - trade.openedAt)}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isWaiting ? (
            <PillBadge label="等待進場" color="#E6AF5A" />
          ) : isUnconfirmed ? (
            <PillBadge label="同步中" color="#565E6B" />
          ) : isPending ? (
            <PillBadge label={isTp1Hit ? 'TP1·等TP2' : '持倉中'} color="#5DCAA5" pulse={!isTp1Hit} />
          ) : isWatchingTp2 ? (
            <PillBadge label="TP1·等TP2" color="#5DCAA5" />
          ) : (() => {
            const isManual = trade.result === 'MANUAL_CLOSE';
            const color = isManual
              ? (isWin ? '#5DCAA5' : isLossTrade(trade) ? '#F09595' : '#2DD4BF')
              : RESULT_COLOR[trade.result!];
            return <PillBadge label={RESULT_LABEL[trade.result!]} color={color} />;
          })()}
          <span className="text-accent text-[12px] num">{trade.score}</span>
        </div>
      </div>

      {/* Waiting: distance to entry */}
      {isWaiting && (
        <div className="text-[12px] mb-3">
          {livePx > 0 ? (
            <>
              <span className={distToEntry > 0 ? 'text-[#E6AF5A]' : 'text-accent'}>
                {distToEntry > 0 ? `距進場位 還差 ${distToEntry.toFixed(2)}%` : '已達進場 等待確認'}
              </span>
              <span className="text-text-s ml-2 num">現價 {fmtPrice(livePx)}</span>
            </>
          ) : (
            <span className="text-text-s">等待即時價格…</span>
          )}
        </div>
      )}

      {/* Pending: PnL + live price */}
      {isPending && livePx > 0 && (
        <div className="flex items-baseline justify-between mb-3">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[22px] font-medium num ${livePnl >= 0 ? 'text-accent' : 'text-down'}`}>
              {livePnl >= 0 ? '+' : ''}{livePnl.toFixed(2)}%
            </span>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-text-s">現價</div>
            <div className="text-[13px] text-text-p num">{fmtPrice(livePx)}</div>
          </div>
        </div>
      )}

      {/* Progress bar: shown whenever the trade has an active price range to visualize */}
      {(isPending || isWatchingTp2) && (
        <div className="mb-3">
          <PriceProgressBar
            direction={trade.direction}
            stopLoss={trade.stopLoss}
            entry={trade.entry}
            tp1={trade.tp1}
            tp2={trade.tp2}
            current={displayPrice}
            formatPrice={fmtPrice}
          />
        </div>
      )}

      {isWatchingTp2 && (
        <div className="flex items-baseline gap-2 mb-2 text-[12px]">
          <span className="text-accent text-[15px] font-medium num">
            {distTP2 > 0 ? `距TP2 還差 ${distTP2.toFixed(2)}%` : `已超過TP2 ${Math.abs(distTP2).toFixed(2)}%`}
          </span>
        </div>
      )}

      {/* Live trailing stop for TP1-watching trades */}
      {isWatchingTp2 && (() => {
        const stopLvl = trade.currentStop && trade.currentStop > 0 ? trade.currentStop : trade.entry;
        const lockedR = Math.abs(trade.entry - trade.stopLoss) > 0
          ? (trade.direction === 'LONG' ? stopLvl - trade.entry : trade.entry - stopLvl) / Math.abs(trade.entry - trade.stopLoss)
          : 0;
        return (
          <div className="flex items-center justify-between bg-accent/[0.08] rounded-[10px] px-3 py-2 mb-3">
            <span className="text-[11px] text-text-s">移動止損（請移到這）</span>
            <span className="text-[12px] text-accent num">
              {fmtPrice(stopLvl)} · {lockedR >= 0.05 ? `已鎖 +${lockedR.toFixed(1)}R` : '保本'}
            </span>
          </div>
        );
      })()}

      {/* Position sizing */}
      {isPending && (() => {
        const effRisk = riskPct * tierRiskMultiplier(trade.symbol, trade.tier);
        const plan = calcPositionPlan(accountSize, effRisk, trade.entry, trade.stopLoss, trade.tier === 'B' ? 5 : 10);
        if (!plan) return null;
        return (
          <div className="flex gap-2 mb-3">
            <StatChip icon={<Wallet className="w-4 h-4" />} label="建議倉位" value={`${plan.positionUSDT}U`} />
            <StatChip icon={<ShieldAlert className="w-4 h-4" />} label="止損風險" value={`${plan.riskUSDT}U · ${effRisk}%`} />
          </div>
        );
      })()}

      {/* TP1 hit: breakeven reminder */}
      {isTp1Hit && (
        <div className="mb-3 bg-accent/[0.06] rounded-[10px] px-3 py-2">
          <p className="text-accent/85 text-[11px]">TP1 已達標，建議將止損移至成本 <span className="num text-accent">{fmtPrice(trade.entry)}</span>，繼續持有等待 TP2</p>
        </div>
      )}

      {/* Auto-generated entry reasons */}
      {trade.reasons && trade.reasons.length > 0 && (
        <div className="mb-2 border-t border-white/[0.06] pt-2">
          <p className="tlabel mb-1">分析依據</p>
          {trade.scoreBreakdown && (
            <p className="text-[#5A7A8A] text-[10px] leading-[1.5] mb-1 num">
              評分：趨勢{trade.scoreBreakdown.trend} · 動能{trade.scoreBreakdown.momentum} · 結構{trade.scoreBreakdown.structure} · 量能{trade.scoreBreakdown.volume} · K線{trade.scoreBreakdown.priceAction}
              {trade.scoreBreakdown.penalties < 0 ? ` · 扣分${trade.scoreBreakdown.penalties}` : ''}
            </p>
          )}
          {trade.reasons.map((r, i) => (
            <p key={i} className="text-[#5A7A8A] text-[10px] leading-[1.5]">› {r}</p>
          ))}
        </div>
      )}

      {/* Personal notes (editable) */}
      {editing ? (
        <div className="mt-2">
          <textarea
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="個人備註、市場觀察…"
            rows={2}
            className="w-full bg-card-2 border border-white/[0.06] rounded-[10px] px-3 py-2 text-xs text-text-p resize-none outline-none mb-2"
          />
          <div className="flex gap-2">
            <button onClick={() => { updateTrade(trade.id, { entryNotes: noteText }); setEditingNote(null); }}
              className="flex-1 py-1.5 rounded-full bg-accent text-[#0A0D11] text-xs font-medium">儲存</button>
            <button onClick={() => setEditingNote(null)}
              className="px-3 py-1.5 rounded-full border border-white/[0.08] text-text-s text-xs">取消</button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {trade.entryNotes
              ? <p className="text-text-s text-xs leading-5 border-l border-white/[0.08] pl-2">{trade.entryNotes}</p>
              : !selectMode && <button onClick={() => { setEditingNote(trade.id); setNoteText(''); }}
                  className="text-text-m text-xs">＋ 個人備註</button>
            }
          </div>
          {trade.entryNotes && !selectMode && (
            <button onClick={() => { setEditingNote(trade.id); setNoteText(trade.entryNotes ?? ''); }}
              className="text-text-m text-[11px] shrink-0">編輯</button>
          )}
        </div>
      )}

      {/* Result row for closed trades */}
      {!isPending && !isWaiting && trade.exitPrice !== undefined && (() => {
        const r    = calcRMultiple(trade);
        const acct = accountPnlPct(trade);
        return (
          <div className="flex items-center justify-between mt-1 pt-2 border-t border-white/[0.05]">
            <span className="text-text-m text-[11px] num">出場 {fmtPrice(trade.exitPrice)}</span>
            <span className="text-right">
              <span className={`text-[13px] num ${isWin ? 'text-accent' : 'text-down'}`}>
                {trade.pnlPercent !== undefined ? `${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent}%` : '—'}
              </span>
              {r !== null && (
                <span className="block text-[10px] text-text-m num">
                  {r >= 0 ? '+' : ''}{r.toFixed(1)}R{acct !== null ? ` · 帳戶 ${acct >= 0 ? '+' : ''}${acct.toFixed(2)}%` : ''}
                </span>
              )}
            </span>
          </div>
        );
      })()}

      {/* Timestamp + actions */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/[0.06]">
        <span className="text-text-m text-[11px] num">{fmtDate(trade.openedAt)}</span>
        {!selectMode && <div className="flex gap-2 flex-wrap justify-end">
          <a
            href={`https://www.tradingview.com/chart/?symbol=BINANCE:${trade.symbol}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full text-accent border border-accent/25 active:opacity-70"
          >
            <LineChart className="w-3.5 h-3.5" />圖表
          </a>
          {isWaiting && (
            <button
              onClick={() => handleManualUnlock(trade.symbol)}
              title="手動取消掛單並解鎖推播"
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                unlocked
                  ? 'text-accent border-accent/30'
                  : 'text-[#E6AF5A] border-[#E6AF5A]/30 active:opacity-70'
              }`}
            >
              {unlocked ? '已取消' : '取消掛單'}
            </button>
          )}
          {(isPending || isWatchingTp2) && (
            <>
              <button
                onClick={() => handleManualUnlock(trade.symbol)}
                title="解除 LINE 推播鎖定"
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  unlocked
                    ? 'text-accent border-accent/30'
                    : 'text-text-m border-white/[0.08] active:opacity-70'
                }`}
              >
                {unlocked ? '已解鎖' : '解鎖推播'}
              </button>
              <button
                onClick={() => setCloseModal({
                  id: trade.id, symbol: trade.symbol, direction: trade.direction,
                  entry: trade.entry, tp1: trade.tp1, tp2: trade.tp2, sl: trade.stopLoss,
                })}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-white/[0.08] text-text-s active:opacity-70"
              >
                <FileText className="w-3.5 h-3.5" />手動記錄
              </button>
            </>
          )}
          <button
            onClick={() => {
              const label = trade.result ? `已結束的 ${trade.symbol.replace('USDT', '')} 紀錄` : `${trade.symbol.replace('USDT', '')} 持倉紀錄`;
              if (window.confirm(`確定永久刪除${label}？\n此操作無法復原，雲端同步後也會移除。`)) {
                deleteTradePermanently(trade.id);
              }
            }}
            className="text-[11px] px-2 py-1 rounded-full text-text-m active:opacity-70"
          >
            刪除
          </button>
        </div>}
      </div>
    </TradeCard>
  );
});
```

- [ ] **Step 4: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤。若報 `text-p`/`text-s`/`text-m`/`accent`/`down` 這幾個 Tailwind class 找不到——這些其實是既有 `tailwind.config.ts` 裡的 `colors.text-p`/`text-s`/`text-m`/`accent`/`down`，不是新 token，tsc 不會檢查 Tailwind class 名稱本身，只會檢查 TS/JSX 語法，所以這裡不會有這類錯誤；若真的跑出型別錯誤，逐一比對是否有變數名稱打錯（例如 `trade.currentStop`、`plan.positionUSDT` 等既有欄位名稱要跟 `src/types` 定義一致）。

- [ ] **Step 5: 啟動本機開發伺服器手動預覽**

Run: `npm run dev`

開啟瀏覽器到 `http://localhost:3000/trades`。若卡在登入畫面（本機預覽需要真實 Supabase session，見專案 CLAUDE.md 慣例），至少確認：頁面編譯無報錯、瀏覽器 console 無紅字 error。若有真實登入 session，額外確認：
- 持倉中卡片顯示圓形頭像、大字 PnL、進度條 thumb 隨即時價移動
- 已結束（win/loss）卡片明顯降階（更暗、無按鈕列）
- 等待進場卡片邊框是虛線
- 40+ 筆紀錄捲動時無明顯卡頓

- [ ] **Step 6: Commit**

```bash
git add src/app/trades/page.tsx
git commit -m "$(cat <<'EOF'
feat: 交易紀錄頁卡片改用 Coinbase 柔和風設計系統元件

TradeRow 改用 TradeCard/PillBadge/StatChip/PriceProgressBar 組裝，
移除舊有 4 格價格網格與已死的 PriceCell，資料邏輯不動。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 完成後

這份 plan 完成後，交易紀錄頁 + 6 個共用元件到位。下一步分別針對首頁/訊號列表、分析頁、設定頁+登入頁、共用小元件（BottomNav/BtcStatusBar/ScanStatusPanel/StatsHero）各開一份新 plan，重用這裡建好的 `TradeCard`/`PillBadge`/`StatChip`/`PriceProgressBar`/`FormField`/`ToggleChip`。

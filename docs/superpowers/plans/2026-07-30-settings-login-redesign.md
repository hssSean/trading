# 設定頁＋登入頁重繪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把設計系統套到登入頁（`src/app/login/page.tsx`）與設定頁（`src/app/settings/page.tsx`，824 行，全站最大的表單頁）。這是第四階段，也是 `FormField`／`ToggleChip` 兩個從 Phase 1 建好、一直沒有消費者的元件第一次真正派上用場。

**Architecture:** 表單輸入框（email/密碼/webhook密鑰/帳戶資金）改用 `FormField`；純二選一或多選一的分段按鈕（登入/註冊 tab、風險%、靜音開關、分析間隔、預設時框）改用 `ToggleChip`；帶說明文字的單選卡片（信號強度 WEAK/MODERATE/STRONG）維持現有客製卡片結構只換色（`ToggleChip` 沒有說明文字欄位，硬套會砍資訊）；其餘區塊（推播狀態、監控診斷、幣種清單、雲端同步、資料管理）維持現有結構只換色階。所有 `useState`/`useEffect`/API 呼叫/business 邏輯完全不動。

**Tech Stack:** Next.js 14、React 18、Tailwind CSS 3、既有 `src/components/ui/*`（`FormField`/`ToggleChip`，Phase 1 已建好）、Supabase Auth（既有）。

**依據 spec：** `docs/superpowers/specs/2026-07-30-trades-page-card-redesign-design.md`（設定頁／登入頁章節）

## Global Constraints

- 不新增 npm 套件。
- **零邏輯變動**：`useState`/`useEffect`/所有 handler 函式（`handle`/`handleLogout`/`enablePush`/`disablePush`/`sendTestPush`/`handleResetAllLocks`/`handleFullReset`/`saveWebhookSecret`/`runDiag`/`copyUrl` 等）、Supabase 呼叫、`updateSettings()` 呼叫的參數，全部逐字不動，只換 JSX 的 className 與部分元件替換（input→`FormField`、按鈕群組→`ToggleChip`）。
- `FormField` 只有 `label`/`type`/`value`/`onChange`/`placeholder` props，沒有 `onKeyDown`/`autoFocus`/`onBlur`/`inputMode`。需要 Enter 送出的地方用外層 `<div onKeyDown={...}>` 包住（比照 Phase 2 首頁搜尋框的做法）；帳戶資金輸入框需要 `onBlur`/`inputMode="decimal"` 這種 `FormField` 不支援的行為，這種情況維持原生 `<input>` 只換色階，不強套 `FormField`（元件形狀不合就不要硬套，這是本專案一貫原則）。
- `ToggleChip` 只有 `label`/`active`/`onClick`，沒有說明文字欄位。「最低信號強度」區塊每個選項底下有一行說明文字，不能塞進 `ToggleChip`，維持現有客製卡片按鈕結構，只換色階。
- 不修改 `.card`/`.chip`/`.input-field`/`.btn-primary`（`globals.css` 共用 class 定義本身）——這幾個還被其他檔案用（如尚未改版的地方）；本次頁面內用到 `.card`/`.chip`/`.input-field`/`.btn-primary` 的地方，直接把該處的 class 換成明確的新 token class（不動全域定義）。
- **色階換色對照表**（沿用 Phase 1-3 已建立的規則，逐字套用）：

  | 舊值 | 新值 |
  |---|---|
  | `#0A0D11`（頁面底色） | `#0A0D11` 不動（頁面最外層背景維持現有 `--bg`，這次改版只動卡片/元件層，不動 app 最外層背景） |
  | `#E8ECF1` | `text-text-p` |
  | `#565E6B` | `text-text-m` |
  | `#8A94A2` | `text-text-s` |
  | `#3A424E` | `text-text-m` |
  | `#2DD4BF` | `text-accent` / `border-accent` / `bg-accent` |
  | `#0ECB81` | `text-up` / `border-up` / `bg-up` |
  | `#F6465D` | `text-down` / `border-down` / `bg-down` |
  | `#1B222B` / `#232B35`（邊框） | `border-white/[0.06]` 或 `border-white/[0.08]`（依原本粗細對應） |
  | `#141A21`（次底色，如 `bg-[#141A21]`） | `bg-white/[0.04]`（沿用 Phase 2/3 已用過的對應） |
  | `#C99A2E`（既有 amber warning 色，settings 頁專屬） | 維持 `#C99A2E` 不變（這是既有語意色，非本次設計系統新色，不在換色範圍內——只換 `.card`/`.chip` 這類容器色階，語意警示色不動，比照分析頁 K 線圖語意色不動的原則） |
  | `.card` class 用法 | `bg-card-2 border border-white/[0.06] rounded-xl p-3.5` |
  | `rounded`（純圓角，無特別語意） | `rounded-full`（按鈕/pill）或 `rounded-[10px]`（清單列/資訊框），依原本視覺角色判斷，跟 Phase 3 分析頁的判斷方式一致 |

- 驗證：`npx tsc --noEmit`；`FormField`/`ToggleChip` 換上去的地方要確認 `value`/`onChange`/`active`/`onClick` 正確接回原本的 state/handler，不能只是換皮忘記接邏輯。

---

## 檔案總覽

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/app/login/page.tsx` | 修改 | email/密碼改 `FormField`、登入/註冊 tab 改 `ToggleChip`、卡片換色 |
| `src/app/settings/page.tsx` | 修改（分 4 個子任務，依區塊切） | 見下 |

---

### Task 1: 登入頁重繪

**Files:**
- Modify: `src/app/login/page.tsx`（全檔 98 行）

**Interfaces:**
- Consumes: `FormField`（`@/components/ui/FormField`）、`ToggleChip`（`@/components/ui/ToggleChip`）
- Produces: `LoginPage` 對外行為不變（route 不變，`supabase.auth`/`router.replace` 呼叫不動）

- [ ] **Step 1: 加 import**

在檔案開頭（目前第 1-4 行）加入：

```typescript
import { FormField } from '@/components/ui/FormField';
import { ToggleChip } from '@/components/ui/ToggleChip';
```

- [ ] **Step 2: 重寫 return JSX**

把（目前第 34-96 行，從 `return (` 到最後一個 `</div>` 收尾前）整段換成：

```tsx
  return (
    <div className="min-h-dvh bg-app flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">📈</div>
          <h1 className="text-text-p text-2xl font-extrabold">Crypto Trader</h1>
          <p className="text-text-m text-sm mt-1">加密貨幣交易信號分析</p>
        </div>

        <div className="bg-card-2 border border-white/[0.06] rounded-xl p-4">
          <div className="flex gap-2 mb-5">
            {(['login', 'signup'] as const).map(m => (
              <ToggleChip
                key={m}
                label={m === 'login' ? '登入' : '註冊'}
                active={mode === m}
                onClick={() => { setMode(m); setErr(''); }}
              />
            ))}
          </div>

          <div onKeyDown={e => e.key === 'Enter' && handle()} className="mb-1">
            <FormField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="your@email.com"
            />
          </div>

          <div onKeyDown={e => e.key === 'Enter' && handle()} className="mt-3 mb-1">
            <FormField
              label={`密碼${mode === 'signup' ? '（至少 6 位）' : ''}`}
              type="password"
              value={pass}
              onChange={setPass}
              placeholder="••••••••"
            />
          </div>

          {err && <p className="text-down text-xs mt-3 bg-down/10 rounded-lg px-3 py-2">{err}</p>}

          <button
            onClick={handle}
            disabled={!email || !pass || loading}
            className="w-full py-3 mt-4 rounded-xl btn-primary font-bold text-sm disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-[#0A0D11] border-t-transparent rounded-full animate-spin" />
                {mode === 'login' ? '登入中…' : '建立帳號…'}
              </span>
            ) : mode === 'login' ? '登入' : '建立帳號'}
          </button>
        </div>

        <p className="text-text-m text-xs text-center mt-6 leading-5">
          資料儲存於個人帳號，換裝置登入即可同步<br />
          <span className="text-down/60">本 App 僅供參考，不構成投資建議</span>
        </p>
      </div>
    </div>
  );
}
```

（`bg-app` 是既有 tailwind token，對應原本寫死的 `#0A0D11`，不是新色；`btn-primary` 是 `globals.css` 既有共用 class，這裡不動它的定義，只是繼續沿用。）

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "$(cat <<'EOF'
feat: 登入頁套用設計系統，email/密碼改 FormField、tab 改 ToggleChip

Supabase 驗證邏輯完全不動。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 設定頁 — 帳號 + 手機推播區塊

**Files:**
- Modify: `src/app/settings/page.tsx`（只動 `{/* Account */}` 到 `{/* Monitor URL + Diag */}` 之前的區塊，目前約第 363-478 行，含檔案最後的 `Section` 輔助元件第 817-824 行）

**Interfaces:**
- Consumes: 無新元件（這兩個區塊沒有適合套 `FormField`/`ToggleChip` 的欄位——推播狀態是多分支條件渲染，不是表單）
- Produces: 無新對外介面

- [ ] **Step 1: 換色**

用上面 Global Constraints 的換色對照表，把頁面 header（目前第 364-368 行）、`Section` 輔助元件定義（目前第 817-824 行）、「帳號」區塊（目前第 373-387 行）、「手機推播」區塊（目前第 390-478 行，含 `unsupported`/`ios-hint`/`denied`/`disabled`/`loading`/`enabled` 六種分支狀態）套用色階替換。`Section` 換成：

```tsx
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card-2 border border-white/[0.06] rounded-xl p-3.5">
      <h2 className="tlabel mb-4">{title}</h2>
      {children}
    </div>
  );
}
```

其餘照對照表逐一替換：邊框圓角一律用 `rounded-[10px]`（這些都是資訊框，不是按鈕），連結/按鈕用 `rounded-full`。所有分支的文字內容、條件判斷（`pushStatus === 'unsupported'` 等）一個字都不要動，只換 class。

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "$(cat <<'EOF'
style: 設定頁「帳號」「手機推播」區塊換色套用新設計系統

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 設定頁 — 自動監控設定 + 帳戶資金區塊

**Files:**
- Modify: `src/app/settings/page.tsx`（`{/* Monitor URL + Diag */}` 到 `{/* Cancel-push mute */}` 之前，目前約第 480-623 行）

**Interfaces:**
- Consumes: `FormField`（webhook 密鑰輸入框）
- Produces: 無新對外介面

- [ ] **Step 1: Webhook 密鑰輸入框改 `FormField`**

把（目前第 482-488 行）：

```tsx
          <div className="mb-3">
            <p className="text-[#565E6B] text-xs mb-1.5">Webhook 密鑰（要和 Vercel 環境變數一致）</p>
            <div className="flex gap-2">
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="WEBHOOK_SECRET" className="input-field flex-1" />
              <button onClick={saveWebhookSecret} className="btn-primary px-4 rounded text-sm shrink-0">存</button>
            </div>
          </div>
```

換成：

```tsx
          <div className="mb-3 flex items-end gap-2">
            <div className="flex-1">
              <FormField
                label="Webhook 密鑰（要和 Vercel 環境變數一致）"
                value={secret}
                onChange={setSecret}
                placeholder="WEBHOOK_SECRET"
              />
            </div>
            <button onClick={saveWebhookSecret} className="btn-primary px-4 py-2.5 rounded-[10px] text-sm shrink-0">存</button>
          </div>
```

- [ ] **Step 2: 帳戶資金輸入框只換色（不用 `FormField`）**

帳戶資金輸入框（目前第 581-596 行）需要 `onBlur`/`inputMode="decimal"`，`FormField` 不支援，維持原生 `<input>`：

```tsx
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              value={acctInput ?? String(settings.accountSize)}
              onChange={(e) => {
                setAcctInput(e.target.value);
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v > 0) updateSettings({ accountSize: v });
              }}
              onBlur={() => setAcctInput(null)}
              placeholder="1000"
              className="w-full bg-card-2 border border-white/[0.06] rounded-[10px] px-3 py-2.5 text-[13px] text-text-p outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 transition-colors flex-1"
            />
            <span className="text-text-m text-sm shrink-0">USDT</span>
          </div>
```

（這段的 class 值直接抄 `FormField` 內部 input 的樣式，讓視覺一致，只是這裡沒辦法用 `FormField` 元件本身。）

- [ ] **Step 3: 風險% 按鈕群組改 `ToggleChip`**

把（目前第 599-614 行）：

```tsx
          <div className="flex gap-1.5 flex-wrap">
            {[0.5, 1, 2, 3].map(p => (
              <button
                key={p}
                onClick={() => updateSettings({ riskPctPerTrade: p })}
                className={`text-xs px-3 py-1.5 rounded num border transition-colors ${
                  (settings.riskPctPerTrade ?? 1) === p
                    ? p >= 2 ? 'border-[#C99A2E]/50 text-[#C99A2E]'
                    :          'border-[#2DD4BF]/50 text-[#2DD4BF]'
                    : 'border-[#1B222B] text-[#565E6B]'
                }`}
              >
                {p}%
              </button>
            ))}
          </div>
```

換成：

```tsx
          <div className="flex gap-1.5 flex-wrap">
            {[0.5, 1, 2, 3].map(p => (
              <ToggleChip
                key={p}
                label={`${p}%`}
                active={(settings.riskPctPerTrade ?? 1) === p}
                onClick={() => updateSettings({ riskPctPerTrade: p })}
              />
            ))}
          </div>
```

（原本 ≥2% 時選中態會變成 amber 警示色，`ToggleChip` 沒有這個分支能力；資訊沒有消失——下面緊接著的「高風險模式」提醒文字段落原封不動保留，一樣會在 ≥2% 時顯示警示語，只是選中的 chip 本身統一用 accent 色，不再額外變 amber。這是元件能力邊界內的合理簡化，不是砍功能。）

- [ ] **Step 4: 加 import**

在檔案開頭 import 區塊（目前第 1-7 行）加入：

```typescript
import { FormField } from '@/components/ui/FormField';
import { ToggleChip } from '@/components/ui/ToggleChip';
```

- [ ] **Step 5: 其餘文字/框線換色**

這個區塊裡剩下的純色階替換（監控 URL 說明文字、`bg-[#141A21]` 資訊框、診斷結果顯示、Vercel 環境變數說明框）全部照 Global Constraints 的對照表替換，語意色（診斷結果的 `#0ECB81`已通知/`#C99A2E`持倉鎖定/`#F6465D`錯誤 三態顏色邏輯）保留，只是換成 `text-up`/`#C99A2E`（不變）/`text-down` 對應 token。

- [ ] **Step 6: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 7: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "$(cat <<'EOF'
feat: 設定頁「自動監控設定」「帳戶資金」區塊套用 FormField/ToggleChip

Webhook 密鑰欄位改 FormField，風險% 選擇改 ToggleChip，
帳戶資金欄位因需要 onBlur/inputMode 維持原生 input 只換色。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 設定頁 — 靜音/信號強度/分析間隔/時框區塊

**Files:**
- Modify: `src/app/settings/page.tsx`（`{/* Cancel-push mute */}` 到 `{/* Coins */}` 之前，目前約第 625-710 行）

**Interfaces:**
- Consumes: `ToggleChip`
- Produces: 無新對外介面

- [ ] **Step 1: 推薦單失效通知（靜音開關）改 `ToggleChip`**

把（目前第 631-648 行）：

```tsx
          <div className="flex gap-2">
            {[
              { v: false, label: '推播（預設）' },
              { v: true,  label: '靜音' },
            ].map(({ v, label }) => (
              <button
                key={String(v)}
                onClick={() => updateSettings({ muteCancelPush: v })}
                className={`flex-1 py-2.5 rounded text-sm border transition-all ${
                  (settings.muteCancelPush ?? false) === v
                    ? 'border-[#2DD4BF] text-[#2DD4BF]'
                    : 'border-[#1B222B] bg-[#141A21] text-[#565E6B]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
```

換成：

```tsx
          <div className="flex gap-2">
            {[
              { v: false, label: '推播（預設）' },
              { v: true,  label: '靜音' },
            ].map(({ v, label }) => (
              <div key={String(v)} className="flex-1">
                <ToggleChip
                  label={label}
                  active={(settings.muteCancelPush ?? false) === v}
                  onClick={() => updateSettings({ muteCancelPush: v })}
                />
              </div>
            ))}
          </div>
```

（`ToggleChip` 內部按鈕沒有 `flex-1`，外面包一層 `div` 撐滿寬度，維持原本兩顆等寬並排的版面。）

- [ ] **Step 2: 最低信號強度區塊只換色（維持客製卡片，不套 `ToggleChip`）**

把（目前第 654-667 行）的 `border-[#2DD4BF]`/`text-[#2DD4BF]`/`border-[#1B222B] bg-[#141A21] text-[#8A94A2]`/`text-[#2DD4BF]/70`/`text-[#565E6B]` 依對照表換成 `border-accent`/`text-accent`/`border-white/[0.06] bg-card-2 text-text-s`/`text-accent/70`/`text-text-m`，圓角 `rounded` 換 `rounded-[10px]`。`label`/`desc` 兩行文字內容、`STRENGTHS` 資料、`onClick` 邏輯完全不動。

- [ ] **Step 3: 分析間隔改 `ToggleChip`**

把（目前第 676-690 行）：

```tsx
          <div className="flex gap-2">
            {INTERVALS.map((v) => (
              <button
                key={v}
                onClick={() => updateSettings({ analysisIntervalMinutes: v })}
                className={`flex-1 py-2.5 rounded text-sm num border transition-all ${
                  settings.analysisIntervalMinutes === v
                    ? 'border-[#2DD4BF] text-[#2DD4BF]'
                    : 'border-[#1B222B] bg-[#141A21] text-[#565E6B]'
                }`}
              >
                {v}m
              </button>
            ))}
          </div>
```

換成：

```tsx
          <div className="flex gap-2">
            {INTERVALS.map((v) => (
              <div key={v} className="flex-1">
                <ToggleChip
                  label={`${v}m`}
                  active={settings.analysisIntervalMinutes === v}
                  onClick={() => updateSettings({ analysisIntervalMinutes: v })}
                />
              </div>
            ))}
          </div>
```

- [ ] **Step 4: 預設分析週期改 `ToggleChip`**

把（目前第 695-709 行）：

```tsx
          <div className="flex gap-2">
            {TFS.map((t) => (
              <button
                key={t}
                onClick={() => {
                  const cur = settings.defaultTimeframes;
                  const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
                  if (next.length > 0) updateSettings({ defaultTimeframes: next });
                }}
                className={`chip num ${settings.defaultTimeframes.includes(t) ? 'chip-active' : ''}`}
              >
                {t}
              </button>
            ))}
          </div>
```

換成：

```tsx
          <div className="flex gap-2">
            {TFS.map((t) => (
              <ToggleChip
                key={t}
                label={t}
                active={settings.defaultTimeframes.includes(t)}
                onClick={() => {
                  const cur = settings.defaultTimeframes;
                  const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
                  if (next.length > 0) updateSettings({ defaultTimeframes: next });
                }}
              />
            ))}
          </div>
```

（這裡原本用全站共用的 `.chip`/`.chip-active` class，換成 `ToggleChip` 後不再用那兩個 class——首頁新增幣種彈窗還在用 `.chip`，那邊不動，`.chip`/`.chip-active` 定義本身不能刪。）

- [ ] **Step 5: 加 import（若前一個 Task 已經加過就跳過）**

確認檔案開頭有：

```typescript
import { ToggleChip } from '@/components/ui/ToggleChip';
```

- [ ] **Step 6: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 7: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "$(cat <<'EOF'
feat: 設定頁靜音開關/分析間隔/預設時框改用 ToggleChip

信號強度區塊因需要說明文字維持客製卡片，只換色。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 設定頁 — 幣種清單/雲端同步/資料管理區塊

**Files:**
- Modify: `src/app/settings/page.tsx`（`{/* Coins */}` 到檔案結尾（不含 `Section` 元件定義，那個在 Task 2 已處理），目前約第 712-815 行）

**Interfaces:**
- Consumes: 無新元件
- Produces: 無新對外介面

- [ ] **Step 1: 換色**

「監控幣種」區塊（目前第 713-734 行）：幣種列 `bg-[#141A21]` 換 `bg-white/[0.04]`，`rounded` 換 `rounded-[10px]`，文字色依對照表換，移除按鈕的紅色邊框/文字換 `border-down/20 text-down`。

「雲端同步」區塊（目前第 737-749 行）：綠色資訊框 `border-[#0ECB81]/20` 換 `border-up/20`，文字色依對照表換，圓角換 `rounded-[10px]`。

「資料管理」區塊（目前第 752-803 行）：三個危險操作按鈕（重置推播鎖定=amber `#C99A2E`維持不變、清除歷史信號=`border-down/30 text-down`、清空所有紀錄=`border-down/50 text-down`）圓角換 `rounded-full`（這些是操作按鈕不是資訊框），結果訊息框（`resetMsg`/`fullResetMsg`）依成功/失敗換 `border-up/30 text-up` 或 `border-down/30 text-down`，圓角換 `rounded-[10px]`，分隔線 `border-[#1B222B]` 換 `border-white/[0.06]`，其餘說明文字依對照表換。

Build version 那行（目前第 807-809 行）文字色換 `text-text-m`。

所有按鈕的 `onClick`/`disabled` 條件、`confirm()` 對話框文字、API 呼叫完全不動。

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "$(cat <<'EOF'
style: 設定頁「監控幣種」「雲端同步」「資料管理」區塊換色

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 逐項比對確認零遺漏

**Files:**
- 無新檔案，這是驗證任務

**Interfaces:**
- 無

- [ ] **Step 1: 抓兩個版本的快照**

```bash
SCRATCH="$(mktemp -d)"
git log --oneline -8   # 找出 Task 1 commit 之前的那個 commit hash，記下來，下面用它取代 <BASE>
git show <BASE>:src/app/login/page.tsx > "$SCRATCH/old_login.tsx"
git show <BASE>:src/app/settings/page.tsx > "$SCRATCH/old_settings.tsx"
cp src/app/login/page.tsx "$SCRATCH/new_login.tsx"
cp src/app/settings/page.tsx "$SCRATCH/new_settings.tsx"
echo "$SCRATCH"
```

- [ ] **Step 2: 派 subagent 逐項比對**

比照這個專案先前每個階段做過的稽核方式，讀完整份新舊 `login/page.tsx`／`settings/page.tsx`，確認以下都在（措辭/位置可變，資訊/功能不能消失）：

- 登入頁：login/signup 兩個 tab 切換、email/密碼兩個欄位（含 signup 模式下密碼欄位「至少 6 位」提示文字）、Enter 鍵送出、錯誤訊息顯示、loading 狀態文字、底部兩行免責聲明文字。
- 設定頁：帳號 email + 登出按鈕；推播六種狀態分支（unsupported/ios-hint/denied/disabled/loading/enabled，含 iOS 教學 4 步驟、測試推播按鈕與錯誤訊息、endpoint 顯示）；webhook 密鑰欄位＋存按鈕；監控 URL 顯示＋複製按鈕；手動觸發診斷按鈕與三種診斷結果顯示（skipped/成功/失敗，含逐幣種明細：已通知/持倉鎖定/分數/TF同向/note/error）；Vercel 環境變數說明框（全部 9 行環境變數＋色彩分類說明）；帳戶資金輸入＋USDT單位；風險% 4 個選項＋≥2%警示文字＋每筆最大虧損試算；靜音開關 2 個選項＋說明文字；信號強度 3 個選項＋各自說明文字；分析間隔 4 個選項＋說明文字；預設時框 5 個可複選 chip；監控幣種清單（含空狀態文案）與移除按鈕；雲端同步說明（2 段文字）；資料管理三個危險操作（重置鎖定/清除歷史/完整重置，含各自的結果訊息、確認對話框文字、說明文字）；build 版本號。

輸出格式：每項一行「[檔案] [區塊] [項目] — 存在於新版？是/否 — 位置或缺失說明」，最後一行明確結論。

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
git add src/app/login/page.tsx src/app/settings/page.tsx
git commit -m "$(cat <<'EOF'
fix: 補齊設定頁/登入頁逐項比對抓出的缺漏

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 完成後

設定頁＋登入頁完成後，最後一階段是共用小元件：`BottomNav`／`BtcStatusBar`／`ScanStatusPanel`／`StatsHero`，四個都只換色不換結構。

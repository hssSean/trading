# 共用小元件重繪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把設計系統套到最後 4 個共用小元件：`BottomNav`（底部導覽列）、`BtcStatusBar`（首頁狀態條）、`ScanStatusPanel`（伺服器掃描診斷面板）、`StatsHero`（戰績橫幅）。這是全站改版第五階段，也是最後一階段。

**Architecture:** 純換色，不改版面結構、不改任何 API 呼叫/計算邏輯。`BottomNav`/`BtcStatusBar` 是常駐 chrome（導覽列/狀態條），背景色維持既有 `#0C1116`（比照登入頁維持 `bg-app` 最外層底色不動的原則，chrome 類元件不套卡片色階）；`ScanStatusPanel`/`StatsHero` 是內容面板，背景套用既有的 `bg-card-2`（Phase 1 已建立的 token）。

**Tech Stack:** Next.js 14、React 18、Tailwind CSS 3、既有 `src/components/ui/*`（本階段不需要新元件，這 4 個都是資訊密度導向，不套卡片動畫）。

**依據 spec：** `docs/superpowers/specs/2026-07-30-trades-page-card-redesign-design.md`（共用小元件章節）

## Global Constraints

- 不新增 npm 套件。
- 零邏輯變動：`useState`/`useEffect`/`fetch` 呼叫/`setInterval`/所有條件判斷完全不動，只換 JSX className 與少數色彩對照表（如 `REGIME_LABEL`/`BTC_REGIME_LABEL` 裡的 `cls` 值）。
- `BottomNav`/`BtcStatusBar` 的背景色 `#0C1116` 維持不變（這是常駐 chrome 的既有底色，比照登入頁「最外層背景不動」的原則，不套 `bg-card-2`）。
- `ScanStatusPanel`/`StatsHero` 的背景從 `bg-[#0F141A] border-[#1B222B] rounded-md` 換成 `bg-card-2 border-white/[0.06] rounded-xl`（這兩個是內容面板，跟分析頁 `Section` 元件的處理方式一致）。
- `#C99A2E`（既有 amber 語意色）維持不變，不在這次換色範圍內（沿用 Phase 4 已建立的規則）。
- 色階換色對照表：`#E8ECF1`→`text-text-p`、`#565E6B`/`#59616E`/`#3A424E`→`text-text-m`、`#8A94A2`→`text-text-s`、`#2DD4BF`→`text-accent`/`border-accent`/`bg-accent`、`#0ECB81`→`text-up`/`bg-up`/`border-up`、`#F6465D`→`text-down`/`bg-down`/`border-down`、`#1B222B`（邊框）→`border-white/[0.06]`、`#141A21`（次底色/軌道背景）→`bg-white/[0.06]`。
- 驗證：`npx tsc --noEmit`；這 4 個元件都嵌在其他頁面裡渲染，本機視覺驗證受限於既有的 Supabase session 限制，退回確認編譯無誤。

---

## 檔案總覽

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/components/BottomNav.tsx` | 修改 | 底部導覽列換色（49 行，全檔） |
| `src/components/BtcStatusBar.tsx` | 修改 | 首頁狀態條換色（63 行，全檔） |
| `src/components/StatsHero.tsx` | 修改 | 戰績橫幅換色（76 行，全檔） |
| `src/components/ScanStatusPanel.tsx` | 修改 | 掃描診斷面板換色（293 行） |

---

### Task 1: `BottomNav` 換色

**Files:**
- Modify: `src/components/BottomNav.tsx`（全檔 49 行）

**Interfaces:**
- Consumes: 無
- Produces: `BottomNav` 對外行為不變

- [ ] **Step 1: 換色**

把整個 `BottomNav` 函式（目前第 15-48 行）換成：

```tsx
export function BottomNav() {
  const pathname = usePathname();
  const unread        = useStore((s) => s.allSignals.filter((sg) => !sg.isRead).length);
  const pendingTrades = useStore((s) => s.trades.filter((t) => !t.result).length);

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-[#0C1116] border-t border-white/[0.06] flex safe-bottom z-50">
      {NAV.map(({ href, label, Icon }) => {
        const active   = href === '/' ? pathname === '/' || pathname.startsWith('/analysis') : pathname.startsWith(href);
        const badge    = href === '/signals' ? unread : href === '/trades' ? pendingTrades : 0;
        const badgeCls = href === '/signals' ? 'bg-down text-white' : 'bg-accent text-[#08110F]';
        return (
          <Link
            key={href}
            href={href}
            className="flex-1 flex flex-col items-center justify-center pt-2.5 pb-1 gap-1"
          >
            <span className="relative">
              <Icon size={21} strokeWidth={1.75} color={active ? '#2DD4BF' : '#59616E'} />
              {badge > 0 && (
                <span className={`absolute -top-1.5 -right-2.5 ${badgeCls} text-[9px] font-medium rounded-full min-w-[15px] h-[15px] flex items-center justify-center px-[3px] num`}>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span className={`text-[11px] ${active ? 'text-accent font-medium' : 'text-text-m'}`}>
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
```

（`Icon color={...}` 這個 prop 是 lucide-react 圖示元件的 SVG 顏色，吃的是 CSS color 值不是 Tailwind class，這裡沒辦法用 token class，維持 hex 字面值不變——跟 K 線圖表框架色同樣道理，第三方元件的顏色 prop 沒辦法套 Tailwind token。）

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/BottomNav.tsx
git commit -m "$(cat <<'EOF'
style: BottomNav 換色套用新設計系統

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `BtcStatusBar` 換色

**Files:**
- Modify: `src/components/BtcStatusBar.tsx`（全檔 63 行）

**Interfaces:**
- Consumes: 無
- Produces: `BtcStatusBar` 對外行為不變

- [ ] **Step 1: 換色**

`BTC` 常數物件（目前第 13-17 行）的 `color` 值是語意色（bullish/bearish/chaotic），維持不變：

```typescript
const BTC: Record<string, { label: string; hint: string; color: string }> = {
  bullish: { label: 'BTC 偏多', hint: '順勢做多 · 山寨空暫停', color: '#0ECB81' },
  bearish: { label: 'BTC 偏空', hint: '順勢做空 · 山寨多暫停', color: '#F6465D' },
  chaotic: { label: 'BTC 混沌', hint: '降級 B 級輕倉 0.5%',    color: '#2DD4BF' },
};
```

（這幾個 hex 值透過 `style={{ color: info.color }}` inline style 使用，不是 Tailwind class，不用換。）

把 `BtcStatusBar` 函式的 return（目前第 44-61 行）換成：

```tsx
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0C1116] border-b border-white/[0.06] text-[11px]">
      <span style={{ color: info.color }}>●</span>
      <span className="font-medium" style={{ color: info.color }}>{info.label}</span>
      <span className="text-text-m">|</span>
      <span className="text-text-s truncate">{info.hint}</span>
      <span className="flex-1" />
      {blocked ? (
        <span className="text-down font-medium">{scan.circuitBreaker ? '熔斷中' : '事件窗口'}</span>
      ) : (
        <>
          <span className="text-text-s num">{scan.notified.length} 訊號</span>
          <span className="text-text-m">|</span>
          <span className="text-text-m num">RISK {scan.totalOpenRisk}%</span>
        </>
      )}
    </div>
  );
```

其中 `info = BTC[scan.btcRegime] ?? { label: ..., hint: '大盤中性', color: '#8A94A2' }`（目前第 41 行）的 fallback color 維持 `#8A94A2` 不變（inline style，跟上面同理）。

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/BtcStatusBar.tsx
git commit -m "$(cat <<'EOF'
style: BtcStatusBar 換色套用新設計系統

BTC regime 語意色（bullish/bearish/chaotic）維持不變。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `StatsHero` 換色

**Files:**
- Modify: `src/components/StatsHero.tsx`（全檔 76 行）

**Interfaces:**
- Consumes: 無
- Produces: `StatsHero` 對外 props 不變

- [ ] **Step 1: 換色**

`col()` 函式（目前第 14 行）的 fallback 色與正負號判斷色是語意色，用 hex 字面值（給 inline `style={{ color }}` 用），維持：

```typescript
const col  = (v: number | null) => (v == null ? '#E8ECF1' : v >= 0 ? '#0ECB81' : '#F6465D');
```

`Spark` 元件（目前第 17-36 行）的 SVG `stroke` 色維持不變（`#0ECB81`/`#F6465D`，語意色）。

`Cell` 元件（目前第 38-45 行）的邊框換色：

```tsx
function Cell({ label, value, color, border }: { label: string; value: string; color: string; border?: boolean }) {
  return (
    <div className={`flex-1 px-3 ${border ? 'border-l border-white/[0.06]' : ''}`}>
      <div className="tlabel">{label}</div>
      <div className="text-[15px] font-medium num mt-1" style={{ color }}>{value}</div>
    </div>
  );
}
```

`StatsHero` 函式的 return（目前第 49-74 行）換成：

```tsx
  return (
    <div className="bg-card-2 border border-white/[0.06] rounded-xl px-3.5 py-3 mb-2.5">
      <div className="flex items-center">
        <span className="tlabel">累積績效</span>
        <span className="flex-1" />
        <span className="text-text-m text-[10px] num">{closedCount} 結束 · {pendingCount} 持倉</span>
      </div>

      <div className="flex items-end gap-3 mt-2">
        <span className="text-[29px] font-medium leading-none num" style={{ color: col(totalR) }}>
          {totalR == null ? '—' : `${sign(totalR)}${totalR.toFixed(1)}R`}
        </span>
        {avgR != null && (
          <span className="text-[12px] num pb-0.5 text-text-s">每筆 {sign(avgR)}{avgR.toFixed(2)}R</span>
        )}
        <span className="flex-1" />
        <Spark data={equity} />
      </div>

      <div className="flex mt-3 pt-3 border-t border-white/[0.06] -mx-3.5">
        <Cell label="近 7 日" value={weekR == null ? '—' : `${sign(weekR)}${weekR.toFixed(1)}R`} color={col(weekR)} />
        <Cell label="勝率" value={winRate == null ? '—' : `${winRate}%`} color="#E8ECF1" border />
        <Cell label="每筆期望" value={ev == null ? '—' : `${ev >= 0 ? '+' : ''}${expectedValue}%`} color={ev == null ? '#E8ECF1' : ev >= 0 ? '#0ECB81' : '#F6465D'} border />
      </div>
    </div>
  );
```

（`Cell` 的 `color` prop 是傳進去給 inline style 用的值，`#E8ECF1`/`#0ECB81`/`#F6465D` 這幾個呼叫端傳入值維持字面值不變，因為 `Cell` 內部是用 `style={{ color }}` 不是 class。）

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 3: Commit**

```bash
git add src/components/StatsHero.tsx
git commit -m "$(cat <<'EOF'
style: StatsHero 換色套用新設計系統

盈虧語意色（正綠負紅）維持不變。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `ScanStatusPanel` 換色

**Files:**
- Modify: `src/components/ScanStatusPanel.tsx`（293 行）

**Interfaces:**
- Consumes: 無
- Produces: `ScanStatusPanel` 對外行為不變

- [ ] **Step 1: 換色對照表標籤物件**

把（目前第 25-29 行）：

```typescript
const REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  trending:     { text: '趨勢', cls: 'text-[#0ECB81]' },
  ranging:      { text: '震盪', cls: 'text-[#2DD4BF]' },
  transitional: { text: '過渡', cls: 'text-[#565E6B]' },
};
```

換成：

```typescript
const REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  trending:     { text: '趨勢', cls: 'text-up' },
  ranging:      { text: '震盪', cls: 'text-accent' },
  transitional: { text: '過渡', cls: 'text-text-m' },
};
```

把（目前第 89-93 行）：

```typescript
const BTC_REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  bullish: { text: 'BTC 偏多', cls: 'text-[#0ECB81]' },
  bearish: { text: 'BTC 偏空', cls: 'text-[#F6465D]' },
  chaotic: { text: 'BTC 混沌', cls: 'text-[#2DD4BF]' },
};
```

換成：

```typescript
const BTC_REGIME_LABEL: Record<string, { text: string; cls: string }> = {
  bullish: { text: 'BTC 偏多', cls: 'text-up' },
  bearish: { text: 'BTC 偏空', cls: 'text-down' },
  chaotic: { text: 'BTC 混沌', cls: 'text-accent' },
};
```

`REJECT_LABEL`/`TIME_STOP_LABEL` 兩個物件（目前第 32-51、84-87 行）純文字對照表，沒有顏色，不用動。

- [ ] **Step 2: `FunnelReasonRow` 換色**

把整個 `FunnelReasonRow` 函式（目前第 97-122 行）換成：

```tsx
function FunnelReasonRow({ r }: { r: FunnelStats['reasons'][number] }) {
  const sh = r.shadow;
  const decided = sh ? sh.win + sh.loss + sh.other : 0;
  return (
    <div className="text-[10px] leading-4 mb-0.5">
      <div className="flex items-center gap-2">
        <span className="text-text-m w-24 shrink-0 truncate">{REJECT_LABEL[r.key] ?? r.key}</span>
        <div className="flex-1 h-1 bg-white/[0.06] overflow-hidden">
          <div className="h-full bg-down/50" style={{ width: `${r.pctOfRejected}%` }} />
        </div>
        <span className="text-text-m w-14 shrink-0 text-right num">{r.count} ({r.pctOfRejected}%)</span>
      </div>
      {sh && decided > 0 && (
        CAPACITY_GATES.has(r.key) ? (
          <p className="pl-2 num text-text-m">
            └ 模擬被擋訊號：賺{sh.win} 虧{sh.loss}{sh.other > 0 ? ` 其他${sh.other}` : ''} · 淨 {sh.netR >= 0 ? '+' : ''}{sh.netR}R（容量關卡，非品質判斷，數字僅供參考）
          </p>
        ) : (
          <p className={`pl-2 num ${sh.netR <= 0 ? 'text-up/70' : 'text-[#C99A2E]/90'}`}>
            └ 模擬被擋訊號：賺{sh.win} 虧{sh.loss}{sh.other > 0 ? ` 其他${sh.other}` : ''} · 淨 {sh.netR >= 0 ? '+' : ''}{sh.netR}R {sh.netR <= 0 ? '（這關擋得對）' : '（擋掉了賺錢單）'}
          </p>
        )
      )}
    </div>
  );
}
```

（`#C99A2E` 維持不變，沿用 Phase 4 已建立的規則。）

- [ ] **Step 3: `ScanStatusPanel` 主體換色**

把整個 `ScanStatusPanel` 函式的 return 之前的部分（`if (!scan)` 判斷，目前第 170-176 行）換成：

```tsx
  if (!scan) {
    return errMsg ? (
      <div className="mt-2 px-3 py-2 bg-card-2 border border-white/[0.06] rounded-xl">
        <p className="text-text-m text-xs">{errMsg}</p>
      </div>
    ) : null;
  }
```

把 return JSX（目前第 184-292 行）換成：

```tsx
  return (
    <div className="mt-2 bg-card-2 border border-white/[0.06] rounded-xl overflow-hidden">
      {/* Summary row — always visible */}
      <button onClick={() => { setExpanded(e => !e); if (!expanded) fetchStatus(); }}
        className="w-full px-3 py-2 flex items-center gap-2 text-left">
        <span className="text-text-s text-[11px] shrink-0">伺服器掃描</span>
        <span className="text-text-m text-[10px] shrink-0 num">{timeAgo(scan.at)}</span>
        <span className={`text-[10px] shrink-0 ${btc.cls}`}>{btc.text}</span>
        {blockers.length > 0 && (
          <span className="text-down text-[10px] shrink-0">{blockers.join(' ')}</span>
        )}
        <span className="flex-1" />
        {scan.notified.length > 0 && (
          <span className="text-up text-[10px] shrink-0 num">{scan.notified.length} 訊號</span>
        )}
        <span className="text-text-m text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded: per-coin table */}
      {expanded && (
        <div className="px-3 pb-2.5 border-t border-white/[0.06]">
          {(scan.circuitBreaker || scan.eventFilter) && (
            <p className="text-down/80 text-[10px] mt-2">
              {typeof scan.circuitBreaker === 'string' ? scan.circuitBreaker : ''}
              {typeof scan.eventFilter === 'string' ? ` ${scan.eventFilter}` : ''}
            </p>
          )}
          <div className="mt-2 space-y-1">
            {scan.coins.map(c => {
              const reg = c.regime ? (REGIME_LABEL[c.regime] ?? { text: c.regime, cls: 'text-text-m' }) : null;
              const isNotified = scan.notified.includes(c.symbol);
              return (
                <div key={c.symbol} className="flex items-center gap-2 text-[10px] leading-4">
                  <span className="text-text-p w-16 shrink-0 truncate num">{c.symbol.replace('USDT', '')}</span>
                  <span className={`w-10 shrink-0 num ${c.topScore >= 65 ? 'text-accent' : 'text-text-m'}`}>
                    {c.topScore > 0 ? `${c.topScore}分`
                      : (c.rawTopScore ?? 0) > 0 ? `${c.rawTopScore}未達` : '—'}
                  </span>
                  {reg && <span className={`w-7 shrink-0 ${reg.cls}`}>{reg.text}</span>}
                  <span className="text-text-m w-14 shrink-0 num">ADX {c.adx4h ?? '?'}</span>
                  <span className="flex-1 text-text-s truncate">
                    {isNotified ? '已發訊號' : (c.note ?? '無合格訊號')}
                  </span>
                </div>
              );
            })}
          </div>
          {funnel && funnel.total > 0 && (() => {
            const qualityReasons  = funnel.reasons.filter(r => !CAPACITY_GATES.has(r.key)).slice(0, 5);
            const capacityReasons = funnel.reasons.filter(r =>  CAPACITY_GATES.has(r.key));
            return (
              <div className="mt-2.5 pt-2 border-t border-white/[0.06]">
                <p className="tlabel mb-1">
                  近3天訊號漏斗 — 候選 {funnel.total} · 出單 <span className="text-up num">{funnel.sent}</span>
                </p>
                {qualityReasons.length > 0 && (
                  <div className="mb-1.5">
                    <p className="text-text-m text-[9px] mb-0.5">品質關卡</p>
                    {qualityReasons.map(r => <FunnelReasonRow key={r.key} r={r} />)}
                  </div>
                )}
                {capacityReasons.length > 0 && (
                  <div>
                    <p className="text-text-m text-[9px] mb-0.5">容量關卡（曝險上限，非品質判斷）</p>
                    {capacityReasons.map(r => <FunnelReasonRow key={r.key} r={r} />)}
                  </div>
                )}
                {funnel.reasons.length === 0 && (
                  <p className="text-text-m text-[10px]">尚無被拒紀錄</p>
                )}
              </div>
            );
          })()}
          {funnel?.timeStopStats && (Object.keys(funnel.timeStopStats).length > 0) && (
            <div className="mt-2.5 pt-2 border-t border-white/[0.06]">
              <p className="tlabel mb-1">時間止損影子模擬</p>
              {(['stall', 'expiry'] as const).map(trigger => {
                const s = funnel.timeStopStats?.[trigger];
                if (!s) return null;
                const decided = s.win + s.loss + s.stillOpen;
                return (
                  <p key={trigger} className="text-[10px] leading-4 mb-0.5 num text-text-m">
                    {TIME_STOP_LABEL[trigger]}：真實淨 {s.realNetR >= 0 ? '+' : ''}{s.realNetR}R
                    {decided > 0 && (
                      <> · 若不砍模擬淨 {s.netR >= 0 ? '+' : ''}{s.netR}R（賺{s.win} 虧{s.loss}{s.stillOpen > 0 ? ` 未平${s.stillOpen}` : ''}）</>
                    )}
                    {s.live > 0 && <span className="text-text-m"> · {s.live} 筆追蹤中</span>}
                  </p>
                );
              })}
            </div>
          )}
          <p className="text-text-m text-[9px] mt-2 num">
            總持倉風險 {scan.totalOpenRisk}% · 每 5 分鐘自動掃描 · 點擊標題可收合
          </p>
        </div>
      )}
    </div>
  );
}
```

所有 `useState`/`useEffect`/`fetchStatus`/`fetchFunnel`/`timeAgo` 函式、`btc`/`blockers` 變數計算完全不動，只有上面列出的 JSX 區塊換色。

- [ ] **Step 4: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤

- [ ] **Step 5: Commit**

```bash
git add src/components/ScanStatusPanel.tsx
git commit -m "$(cat <<'EOF'
style: ScanStatusPanel 換色套用新設計系統

REGIME/BTC_REGIME 標籤色改用 token；#C99A2E 語意色維持不變；
所有 fetch/計算邏輯不動。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 逐項比對確認零遺漏（全站改版最終關卡）

**Files:**
- 無新檔案，這是驗證任務

**Interfaces:**
- 無

這是全站五階段改版的最後一次逐項比對。

- [ ] **Step 1: 抓兩個版本的快照**

```bash
SCRATCH="$(mktemp -d)"
git log --oneline -6   # 找出 Task 1 commit 之前的那個 commit hash，記下來，下面用它取代 <BASE>
for f in BottomNav BtcStatusBar StatsHero ScanStatusPanel; do
  git show <BASE>:"src/components/$f.tsx" > "$SCRATCH/old_$f.tsx"
  cp "src/components/$f.tsx" "$SCRATCH/new_$f.tsx"
done
echo "$SCRATCH"
```

- [ ] **Step 2: 派 subagent 逐項比對**

比照這個專案先前每個階段做過的稽核方式，讀完整份新舊 4 個檔案，確認：

- `BottomNav`：5 個導覽項目（首頁/信號/紀錄/體檢/設定）、active 狀態判斷（含首頁涵蓋 `/analysis` 路徑的特殊規則）、訊號未讀數字徽章、持倉中數字徽章（99+ 上限文案）、圖示顏色邏輯都在。
- `BtcStatusBar`：三種 BTC regime（bullish/bearish/chaotic）文字與顏色、未知 regime 的 fallback 顯示、熔斷/事件窗口的封鎖狀態文字、訊號數與風險%顯示都在。
- `StatsHero`：累積績效標題、結束/持倉計數、總 R 值（含正負號與顏色）、每筆平均 R、sparkline 曲線、近7日/勝率/每筆期望三個 Cell（含各自的 `—`空值 fallback、期望值正負色）都在。
- `ScanStatusPanel`：摘要列（掃描時間/BTC regime/封鎖狀態/訊號數/展開箭頭）、展開後的逐幣種列表（分數/regime/ADX/備註）、訊號漏斗（品質關卡/容量關卡兩組，含影子模擬文字的三種措辭：容量關卡中性/品質關卡擋對/品質關卡擋錯）、時間止損影子模擬（stall/expiry 兩種，含追蹤中筆數）、底部總風險%說明都在。

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
git add src/components/BottomNav.tsx src/components/BtcStatusBar.tsx src/components/StatsHero.tsx src/components/ScanStatusPanel.tsx
git commit -m "$(cat <<'EOF'
fix: 補齊共用小元件逐項比對抓出的缺漏

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 完成後

這是全站視覺改版的最後一個 plan。完成並 push 後，五個階段（交易紀錄頁+共用元件、首頁/訊號列表、分析頁、設定頁+登入頁、共用小元件）全部完成，整站套用 Coinbase 柔和風設計系統。

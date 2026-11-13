# 像素辦公室頁 `/office` 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/office` 頁，把 8 個系統模組畫成 Clawd 像素員工，底部有 SQUAWK 跑馬燈；資料只用現有 3 支 API。

**Architecture:** 所有判斷都放在純函數 `src/lib/office/seats.ts`（API 回應 → `Seat[]`／`SquawkLine[]`），角色圖形放在純函數 `src/lib/office/sprite.ts`（狀態＋時間 → 矩形清單），兩者都用 vitest 測。React 元件只負責畫：`Clawd`（SVG）、`PixelSeat`、`Squawk`。頁面用既有的 `useS3Api` 抓資料。開發環境可用 `?demo=1` 吃假資料預覽，不需要登入。

**Tech Stack:** Next.js 14 App Router、React 18、Tailwind 3、vitest。不新增套件。

設計：`docs/superpowers/specs/2026-11-13-office-view-design.md`

## Global Constraints

- 不新增 API route、不新增 Redis 指令；只讀 `/api/s3/overview`、`/api/s3/signals`、`/api/s3/ledgers`。
- 不新增 npm 套件。
- 所有檔案 UTF-8，註解與畫面文字用繁體中文。
- 輪詢間隔 60 秒（`useS3Api(path, 60_000)`，它已處理分頁不可見時暫停）。
- 動畫 8fps，`document.hidden` 時暫停；`prefers-reduced-motion` 時固定 `t = 0`。
- `?demo=1` 只在 `process.env.NODE_ENV !== 'production'` 生效。
- 與設計文件的差異：overview API 沒有 kill switch 狀態，RISK 的「異常」改成「任一策略或帳本停用」（不加讀取）。
- 改完必跑：`npx tsc --noEmit` → `npx vitest run` → `npx next build`。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/lib/office/seats.ts` | 新增 | `buildSeats`、`buildSquawk`、`fmtHm`、型別 |
| `src/lib/office/demo.ts` | 新增 | 假資料（測試與 `?demo=1` 共用） |
| `tests/officeSeats.test.ts` | 新增 | seats 測試 |
| `src/lib/office/sprite.ts` | 新增 | `clawdRects` 像素矩形 |
| `tests/officeSprite.test.ts` | 新增 | sprite 測試 |
| `src/components/office/useTick.ts` | 新增 | 8fps 共用時鐘 |
| `src/components/office/Clawd.tsx` | 新增 | SVG 角色 |
| `src/components/office/PixelSeat.tsx` | 新增 | 一個座位 |
| `src/components/office/Squawk.tsx` | 新增 | 跑馬燈 |
| `src/app/office/page.tsx` | 新增 | 頁面 |
| `src/components/s3/HomeCards.tsx` | 修改 | 「今天」卡片加入口 |

---

### Task 1: 座位與跑馬燈的純函數＋假資料

**Files:**
- Create: `src/lib/office/seats.ts`
- Create: `src/lib/office/demo.ts`
- Test: `tests/officeSeats.test.ts`

**Interfaces:**
- Consumes: `OverviewResp`、`SignalsResp`、`LedgersResp`（`src/lib/s3s1/apiTypes.ts`）；`HEARTBEAT_STALE_MS`、`todaySummary`（`src/lib/s3s1/view.ts`）；`legMeta`、`legsOf`、`LEG_KEYS`、`type Leg`（`src/engine/s3aLive.ts`）。
- Produces:
  - `type SeatState = 'working' | 'celebrate' | 'alert' | 'idle' | 'unknown'`
  - `type SeatId = 'chief' | 'scan' | 's3a' | 's3b' | 's1' | 'br' | 'ctrend' | 'risk'`
  - `type Accessory = 'tie' | 'scope' | 'badgeA' | 'badgeB' | 'clock' | 'short' | 'calendar' | 'shield'`
  - `interface Seat { id: SeatId; label: string; role: string; state: SeatState; bubble: string; details: { k: string; v: string }[]; href: string; accessory: Accessory }`
  - `interface SquawkLine { key: string; at: number; tag: string; text: string; tone: 'open' | 'skip' }`
  - `buildSeats(ov: OverviewResp | null, sig: SignalsResp | null, led: LedgersResp | null, now: number): Seat[]`（固定 8 個、順序 chief, scan, s3a, s3b, s1, br, ctrend, risk）
  - `buildSquawk(ov: OverviewResp | null, sig: SignalsResp | null, limit?: number): SquawkLine[]`
  - `fmtHm(at: number): string`（台灣時間 HH:mm）
  - `demo.ts`：`DEMO_NOW: number`、`demoOverview(): OverviewResp`、`demoSignals(): SignalsResp`、`demoLedgers(): LedgersResp`

- [ ] **Step 1: 寫假資料 `src/lib/office/demo.ts`**

```ts
// /office 的假資料：單元測試與開發環境 ?demo=1 預覽共用。不進 production 畫面（page.tsx 擋 NODE_ENV）。
import type { LedgersResp, OverviewResp, SignalsResp } from '@/lib/s3s1/apiTypes';
import type { LivePos, LiveSignal } from '@/engine/s3aLive';
import type { SignalLog } from '@/lib/s3s1/engine';
import type { AcctSummary } from '@/lib/s3s1/stats';

const DAY = 86_400_000;
/** 2026-11-13 03:00 UTC（台灣 11:00）——當天的 prep 已經跑過 */
export const DEMO_NOW = Date.UTC(2026, 10, 13, 3, 0, 0);
const X = Math.floor(DEMO_NOW / DAY) * DAY;
const D = X - DAY;

const pos = (symbol: string, legs: LivePos['legs']): LivePos => ({
  symbol, signalDay: D - DAY, entryDay: D, entryAt: D + 60_000, entry: 100, stop0: 90, stop: 95,
  qty0: 10, tpQty: 3.33, partial: false, stopAlgoId: 1, tpAlgoId: 2, legs,
} as LivePos);

const liveSig = (symbol: string, decision: 'open' | 'skip', at: number, extra: Partial<LiveSignal> = {}): LiveSignal => ({
  symbol, signalDay: D, decision, at, close: 100, hh20: 99, atr14: 3, stop: 92, ret7: 0.1,
  btcOk: true, btcExt: 1.2, breadth: 0.3, ...extra,
});

export function demoOverview(): OverviewResp {
  return {
    ok: true, now: DEMO_NOW,
    meta: { mode: 'live', wallet: 5000, baseEquity: 2500, realized: 120, 'b.baseEquity': 2500, 'b.realized': -40 },
    positions: [pos('SOLUSDT', { A: { qty0: 6, tpQty: 2, equityAtEntry: 2500, minQtyUsed: false } })],
    snapshot: { X, breadth: 0.31, btcOk: { [String(D)]: true }, btcExt: { [String(D)]: 1.4 }, s3: [{ symbol: 'SOLUSDT' }, { symbol: 'AVAXUSDT' }] },
    heartbeatAt: DEMO_NOW - 30_000,
    signals: [
      liveSig('SOLUSDT', 'open', X + 31_000, { score: 3, legs: { A: 'open', B: '同幣已有部位' } }),
      liveSig('AVAXUSDT', 'skip', X + 32_000, { reason: '分數 1 < 2', score: 1, legs: { A: '分數 1 < 2', B: '分數 1 < 2' } }),
    ],
  };
}

const ledSig = (acct: SignalLog['acct'], symbol: string, decision: 'open' | 'skip', at: number, reason?: string): SignalLog => ({
  acct, symbol, signalT: at - 3_600_000, decision, reason, close: 10, stop: 9, btcOk: true, breadth: 0.3, ind: {}, at,
});

export function demoSignals(): SignalsResp {
  return {
    ok: true,
    live: demoOverview().signals,
    ledger: [
      ledSig('s1', 'ETHUSDT', 'open', DEMO_NOW - 2 * 3_600_000),
      ledSig('br', 'DOGEUSDT', 'skip', DEMO_NOW - 5 * 3_600_000, '資金費 ≤ −0.05%'),
      ledSig('s3a', 'SOLUSDT', 'open', X + 3_900_000),
    ],
  };
}

const summary = (key: AcctSummary['key'], name: string, open: number, halted: string | null = null): AcctSummary => ({
  key, name, initial: 100, equity: 104.2, retPct: 4.2, ddPct: 1, maxDdPct: 5, trades: 12, wins: 6, winRate: 0.5,
  avgR: 0.2, sumR: 2.4, lossStreak: 1, halted, open, riskOpenPct: open * 0.04,
});

export function demoLedgers(): LedgersResp {
  return {
    ok: true,
    trackStart: { s3: X - 30 * DAY, s1: X - 30 * DAY },
    lastRun: { s3: X + 3_900_000, s1: DEMO_NOW - 2 * 3_600_000 },
    accounts: [
      { summary: summary('s3a', 'S3-A', 1), open: [], recent: [], blocked: { '分數不足': 4 } },
      { summary: summary('s3b', 'S3-B', 1), open: [], recent: [], blocked: {} },
      { summary: summary('s1', 'S1', 2), open: [], recent: [], blocked: { 'BTC 條件': 3 } },
      { summary: summary('br', 'BR', 0), open: [], recent: [], blocked: { '資金費': 1 } },
    ],
    ctrend: {
      weeks: 3, cumNet: 0.012, meanNet: 0.004, tNet: 0.8, lastRun: DEMO_NOW - 4 * DAY, lastWeek: '2026-W46',
      stale: false, recent: [], openWeek: '2026-W46', topLong: ['BTCUSDT'], topShort: ['XRPUSDT'],
    },
  };
}
```

- [ ] **Step 2: 寫失敗的測試 `tests/officeSeats.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildSeats, buildSquawk, fmtHm, type SeatId } from '@/lib/office/seats';
import { DEMO_NOW, demoLedgers, demoOverview, demoSignals } from '@/lib/office/demo';

const seat = (id: SeatId, ...a: Parameters<typeof buildSeats>) => buildSeats(...a).find(s => s.id === id)!;
const all = () => [demoOverview(), demoSignals(), demoLedgers(), DEMO_NOW] as const;

describe('buildSeats', () => {
  it('固定 8 個座位、固定順序', () => {
    expect(buildSeats(...all()).map(s => s.id)).toEqual(['chief', 'scan', 's3a', 's3b', 's1', 'br', 'ctrend', 'risk']);
  });

  it('全部 API 失敗 → 全部 unknown', () => {
    expect(buildSeats(null, null, null, DEMO_NOW).every(s => s.state === 'unknown')).toBe(true);
  });

  it('CHIEF：心跳新鮮且有持倉 = working；心跳過期 = alert', () => {
    expect(seat('chief', ...all()).state).toBe('working');
    const ov = { ...demoOverview(), heartbeatAt: DEMO_NOW - 10 * 60_000 };
    expect(seat('chief', ov, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('alert');
    const ov2 = { ...demoOverview(), positions: [] };
    expect(seat('chief', ov2, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('idle');
  });

  it('SCAN：有今天快照 = idle 並顯示廣度；UTC 00:10 前沒快照 = idle；之後沒快照 = alert', () => {
    const s = seat('scan', ...all());
    expect(s.state).toBe('idle');
    expect(s.bubble).toContain('31%');
    const X = Math.floor(DEMO_NOW / 86_400_000) * 86_400_000;
    const ov = { ...demoOverview(), snapshot: null };
    expect(seat('scan', ov, null, null, X + 5 * 60_000).state).toBe('idle');
    expect(seat('scan', ov, null, null, X + 60 * 60_000).state).toBe('alert');
  });

  it('S3-A：今天 A 腿開倉 = celebrate；S3-B：B 腿被擋、沒持倉 = idle', () => {
    expect(seat('s3a', ...all()).state).toBe('celebrate');
    expect(seat('s3b', ...all()).state).toBe('idle');
  });

  it('S3-B：停用 = alert', () => {
    const ov = demoOverview();
    ov.meta = { ...ov.meta, 'b.halted': '連虧 15' };
    expect(seat('s3b', ov, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('alert');
  });

  it('S3-A：今天沒訊號但有 A 腿持倉 = working', () => {
    const ov = { ...demoOverview(), signals: [] };
    expect(seat('s3a', ov, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('working');
  });

  it('S1：24 小時內有開倉 = celebrate；BR：沒持倉沒開倉 = idle；停用 = alert', () => {
    expect(seat('s1', ...all()).state).toBe('celebrate');
    expect(seat('br', ...all()).state).toBe('idle');
    const led = demoLedgers();
    led.accounts[3].summary.halted = '回撤 > 60%';
    expect(seat('br', demoOverview(), demoSignals(), led, DEMO_NOW).state).toBe('alert');
  });

  it('S1：訊號 API 失敗時不慶祝，有持倉 = working', () => {
    expect(seat('s1', demoOverview(), null, demoLedgers(), DEMO_NOW).state).toBe('working');
  });

  it('CTREND：有持倉週 = working；過期 = alert；還沒跑過 = alert', () => {
    expect(seat('ctrend', ...all()).state).toBe('working');
    const led = demoLedgers();
    led.ctrend = { ...led.ctrend!, stale: true };
    expect(seat('ctrend', demoOverview(), demoSignals(), led, DEMO_NOW).state).toBe('alert');
    expect(seat('ctrend', demoOverview(), demoSignals(), { ...demoLedgers(), ctrend: null }, DEMO_NOW).state).toBe('alert');
  });

  it('RISK：今天有擋單 = working 並寫出筆數；任一停用 = alert', () => {
    const r = seat('risk', ...all());
    expect(r.state).toBe('working');
    expect(r.bubble).toContain('1');
    const led = demoLedgers();
    led.accounts[2].summary.halted = '勝率 < 45%';
    expect(seat('risk', demoOverview(), demoSignals(), led, DEMO_NOW).state).toBe('alert');
  });
});

describe('buildSquawk', () => {
  it('合併真倉與帳本訊號，新到舊', () => {
    const lines = buildSquawk(demoOverview(), demoSignals());
    expect(lines.length).toBe(5);
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1].at).toBeGreaterThanOrEqual(lines[i].at);
  });

  it('擋單寫理由、開倉是 open', () => {
    const lines = buildSquawk(demoOverview(), demoSignals());
    expect(lines.find(l => l.text.startsWith('AVAX'))!.text).toContain('分數 1 < 2');
    expect(lines.find(l => l.text.startsWith('SOL') && l.tag === 'S3')!.tone).toBe('open');
  });

  it('limit 截斷、輸入都是 null 回空陣列', () => {
    expect(buildSquawk(demoOverview(), demoSignals(), 2).length).toBe(2);
    expect(buildSquawk(null, null)).toEqual([]);
  });
});

describe('fmtHm', () => {
  it('台灣時間', () => {
    expect(fmtHm(Date.UTC(2026, 10, 13, 0, 5))).toBe('08:05');
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/officeSeats.test.ts`
Expected: FAIL，`Failed to resolve import "@/lib/office/seats"`

- [ ] **Step 4: 實作 `src/lib/office/seats.ts`**

```ts
// /office 像素辦公室：把 /api/s3/{overview,signals,ledgers} 轉成 8 個座位與 SQUAWK 跑馬燈。純函數，測試在 tests/officeSeats.test.ts。
// 設計：docs/superpowers/specs/2026-11-13-office-view-design.md
import type { LedgersResp, OverviewResp, SignalsResp } from '@/lib/s3s1/apiTypes';
import { HEARTBEAT_STALE_MS, todaySummary } from '@/lib/s3s1/view';
import { LEG_KEYS, legMeta, legsOf, type Leg } from '@/engine/s3aLive';

export type SeatState = 'working' | 'celebrate' | 'alert' | 'idle' | 'unknown';
export type SeatId = 'chief' | 'scan' | 's3a' | 's3b' | 's1' | 'br' | 'ctrend' | 'risk';
export type Accessory = 'tie' | 'scope' | 'badgeA' | 'badgeB' | 'clock' | 'short' | 'calendar' | 'shield';
export interface Seat {
  id: SeatId; label: string; role: string; state: SeatState; bubble: string;
  details: { k: string; v: string }[]; href: string; accessory: Accessory;
}
export interface SquawkLine { key: string; at: number; tag: string; text: string; tone: 'open' | 'skip' }

const DAY = 86_400_000;
/** prep 在 UTC 00:05 跑；給 5 分鐘緩衝，00:10 後還沒有快照才算異常 */
const PREP_GRACE_MS = 10 * 60_000;
const coin = (s: string) => s.replace(/USDT$/, '');
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

/** 台灣時間 HH:mm（不依賴瀏覽器時區） */
export const fmtHm = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(11, 16);

type Base = Pick<Seat, 'id' | 'label' | 'role' | 'href' | 'accessory'>;
const BASE: Record<SeatId, Base> = {
  chief:  { id: 'chief',  label: 'CHIEF',  role: 'live-runner 主控', href: '/',        accessory: 'tie' },
  scan:   { id: 'scan',   label: 'SCAN',   role: '每日幣池快照',     href: '/signals', accessory: 'scope' },
  s3a:    { id: 's3a',    label: 'S3-A',   role: 'S3-A 真倉',        href: '/',        accessory: 'badgeA' },
  s3b:    { id: 's3b',    label: 'S3-B',   role: 'S3-B 真倉',        href: '/',        accessory: 'badgeB' },
  s1:     { id: 's1',     label: 'S1',     role: 'S1 12H 帳本',      href: '/ledgers', accessory: 'clock' },
  br:     { id: 'br',     label: 'BR',     role: 'BR 做空帳本',      href: '/ledgers', accessory: 'short' },
  ctrend: { id: 'ctrend', label: 'CTREND', role: 'CTREND 週帳本',    href: '/ledgers', accessory: 'calendar' },
  risk:   { id: 'risk',   label: 'RISK',   role: '風控與停用條件',   href: '/signals', accessory: 'shield' },
};
const unknown = (id: SeatId): Seat => ({ ...BASE[id], state: 'unknown', bubble: '讀不到資料', details: [] });

function chief(ov: OverviewResp | null, now: number): Seat {
  if (!ov) return unknown('chief');
  const alive = ov.heartbeatAt != null && now - ov.heartbeatAt < HEARTBEAT_STALE_MS;
  const n = ov.positions.length;
  const details = [
    { k: '心跳', v: ov.heartbeatAt ? `${Math.round((now - ov.heartbeatAt) / 1000)} 秒前` : '沒有' },
    { k: '模式', v: ov.meta.mode === 'dry' ? 'DRY RUN' : ov.meta.mode === 'live' ? 'testnet 真下單' : '未知' },
    { k: '持倉', v: `${n} 個` },
  ];
  if (!alive) return { ...BASE.chief, state: 'alert', bubble: '心跳斷了！', details };
  return { ...BASE.chief, state: n > 0 ? 'working' : 'idle', bubble: n > 0 ? `盯著 ${n} 個部位` : '待命中', details };
}

function scan(ov: OverviewResp | null, now: number): Seat {
  if (!ov) return unknown('scan');
  const t = todaySummary(ov.snapshot, ov.signals, now);
  if (!t.ready) {
    const early = now - t.X < PREP_GRACE_MS;
    return { ...BASE.scan, state: early ? 'idle' : 'alert', bubble: early ? '等 08:05 的資料' : '今天沒有快照！', details: [] };
  }
  return {
    ...BASE.scan, state: 'idle',
    bubble: `廣度 ${pct(t.breadth ?? 0)} · BTC ${t.btcOk ? '✓' : '✗'}`,
    details: [
      { k: '市場廣度', v: `${pct(t.breadth ?? 0)} / 93%` },
      { k: 'BTC 站上 EMA50', v: t.btcOk ? '是' : '否' },
      { k: '突破候選', v: `${t.candidates} 個` },
    ],
  };
}

function s3Leg(ov: OverviewResp | null, leg: Leg, now: number): Seat {
  const id: SeatId = leg === 'A' ? 's3a' : 's3b';
  if (!ov) return unknown(id);
  const m = legMeta(ov.meta, leg);
  const X = Math.floor(now / DAY) * DAY;
  const today = ov.signals.filter(s => s.signalDay === X - DAY);
  const legDecision = (s: (typeof today)[number]) => s.legs?.[leg] ?? (leg === 'A' ? (s.decision === 'open' ? 'open' : s.reason ?? '') : undefined);
  const opened = today.filter(s => legDecision(s) === 'open').map(s => coin(s.symbol));
  const held = ov.positions.filter(p => legsOf(p)[leg]).map(p => coin(p.symbol));
  const details = [
    { k: '權益', v: m.base > 0 ? `${m.equity.toFixed(0)} U` : '—' },
    { k: '連虧', v: `${m.streak}` },
    { k: '持倉', v: held.length ? held.join('、') : '無' },
    { k: '今天開倉', v: opened.length ? opened.join('、') : '無' },
  ];
  if (m.halted) return { ...BASE[id], state: 'alert', bubble: `已停用：${m.halted}`, details };
  if (opened.length) return { ...BASE[id], state: 'celebrate', bubble: `進場 ${opened.join('、')}！`, details };
  if (held.length) return { ...BASE[id], state: 'working', bubble: `持倉 ${held.join('、')}`, details };
  const btcOk = ov.snapshot && ov.snapshot.X === X ? !!ov.snapshot.btcOk[String(X - DAY)] : null;
  return { ...BASE[id], state: 'idle', bubble: btcOk === false ? '空頭期休息' : '今天沒單', details };
}

function ledger(led: LedgersResp | null, sig: SignalsResp | null, key: 's1' | 'br', now: number): Seat {
  const a = led?.accounts.find(x => x.summary.key === key);
  if (!a) return unknown(key);
  const s = a.summary;
  const details = [
    { k: '權益', v: `${s.equity.toFixed(1)} U（${s.retPct >= 0 ? '+' : ''}${s.retPct.toFixed(1)}%）` },
    { k: '筆數', v: `${s.trades}（勝率 ${s.winRate == null ? '—' : pct(s.winRate)}）` },
    { k: '持倉', v: `${s.open} 個` },
  ];
  if (s.halted) return { ...BASE[key], state: 'alert', bubble: `已停用：${s.halted}`, details };
  const fresh = (sig?.ledger ?? []).filter(x => x.acct === key && x.decision === 'open' && now - x.at < DAY).map(x => coin(x.symbol));
  if (fresh.length) return { ...BASE[key], state: 'celebrate', bubble: `${key === 'br' ? '放空' : '進場'} ${fresh.join('、')}！`, details };
  if (s.open > 0) return { ...BASE[key], state: 'working', bubble: `持倉 ${s.open} · ${s.equity.toFixed(1)}U`, details };
  return { ...BASE[key], state: 'idle', bubble: `${s.equity.toFixed(1)} U`, details };
}

function ctrend(led: LedgersResp | null): Seat {
  if (!led) return unknown('ctrend');
  const c = led.ctrend;
  if (!c) return { ...BASE.ctrend, state: 'alert', bubble: '還沒跑過', details: [] };
  const cum = `${c.cumNet >= 0 ? '+' : ''}${(c.cumNet * 100).toFixed(2)}%`;
  const details = [
    { k: '週數', v: `${c.weeks}（前 26 週不看結果）` },
    { k: '累積', v: cum },
    { k: '持倉週', v: c.openWeek ?? '無' },
  ];
  if (c.stale) return { ...BASE.ctrend, state: 'alert', bubble: '超過 8 天沒跑！', details };
  return { ...BASE.ctrend, state: c.openWeek ? 'working' : 'idle', bubble: `第 ${c.weeks} 週 · ${cum}`, details };
}

function risk(ov: OverviewResp | null, led: LedgersResp | null, now: number): Seat {
  if (!ov && !led) return unknown('risk');
  const halts: string[] = [];
  if (ov) for (const k of LEG_KEYS) { const h = legMeta(ov.meta, k).halted; if (h) halts.push(`S3-${k}：${h}`); }
  for (const a of led?.accounts ?? []) if (a.summary.halted) halts.push(`${a.summary.name}：${a.summary.halted}`);
  const blockedToday = ov ? todaySummary(ov.snapshot, ov.signals, now).blocked.length : 0;
  const blockedTotal = (led?.accounts ?? []).reduce((n, a) => n + Object.values(a.blocked).reduce((x, y) => x + y, 0), 0);
  const details = [
    { k: '今天擋下（真倉）', v: `${blockedToday} 筆` },
    { k: '帳本累計擋下', v: `${blockedTotal} 筆` },
    { k: '停用中', v: halts.length ? halts.join('；') : '無' },
  ];
  if (halts.length) return { ...BASE.risk, state: 'alert', bubble: `停用 ${halts.length} 個`, details };
  if (blockedToday) return { ...BASE.risk, state: 'working', bubble: `今天擋下 ${blockedToday} 筆`, details };
  return { ...BASE.risk, state: 'idle', bubble: '沒有要擋的', details };
}

export function buildSeats(ov: OverviewResp | null, sig: SignalsResp | null, led: LedgersResp | null, now: number): Seat[] {
  return [
    chief(ov, now), scan(ov, now), s3Leg(ov, 'A', now), s3Leg(ov, 'B', now),
    ledger(led, sig, 's1', now), ledger(led, sig, 'br', now), ctrend(led), risk(ov, led, now),
  ];
}

const ACCT_TAG: Record<string, string> = { s3a: 'S3-A帳', s3b: 'S3-B帳', s1: 'S1', br: 'BR' };

export function buildSquawk(ov: OverviewResp | null, sig: SignalsResp | null, limit = 30): SquawkLine[] {
  const lines: SquawkLine[] = [];
  for (const s of ov?.signals ?? []) {
    const open = s.decision === 'open' || Object.values(s.legs ?? {}).includes('open');
    lines.push({
      key: `live:${s.symbol}:${s.at}`, at: s.at, tag: 'S3', tone: open ? 'open' : 'skip',
      text: open ? `${coin(s.symbol)} · 開倉${s.score != null ? ` 分數 ${s.score}` : ''}` : `${coin(s.symbol)} · 擋：${s.reason ?? '—'}`,
    });
  }
  for (const s of sig?.ledger ?? []) {
    lines.push({
      key: `led:${s.acct}:${s.symbol}:${s.at}`, at: s.at, tag: ACCT_TAG[s.acct] ?? s.acct, tone: s.decision === 'open' ? 'open' : 'skip',
      text: s.decision === 'open' ? `${coin(s.symbol)} · ${s.acct === 'br' ? '放空' : '開倉'}` : `${coin(s.symbol)} · 擋：${s.reason ?? '—'}`,
    });
  }
  return lines.sort((a, b) => b.at - a.at).slice(0, limit);
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/officeSeats.test.ts`
Expected: 全部 PASS。若型別欄位與 `LivePos`／`AcctSummary` 實際定義不合，修改 `demo.ts`（不改測試的意圖）。

- [ ] **Step 6: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 沒有錯誤

- [ ] **Step 7: Commit**

```bash
git add src/lib/office/seats.ts src/lib/office/demo.ts tests/officeSeats.test.ts
git commit -m "feat(office): 座位狀態與 SQUAWK 純函數＋假資料"
```

---

### Task 2: Clawd 像素圖形（純函數）

**Files:**
- Create: `src/lib/office/sprite.ts`
- Test: `tests/officeSprite.test.ts`

**Interfaces:**
- Consumes: `SeatState`、`Accessory`（Task 1）
- Produces:
  - `interface PxRect { x: number; y: number; w: number; h: number; fill: string }`（單位：格）
  - `interface Palette { body: string; dark: string }`；`PALETTE_DEFAULT`、`PALETTE_SHORT`
  - `SPRITE_W = 20`、`SPRITE_H = 22`（viewBox 格數）
  - `clawdRects(o: { state: SeatState; accessory: Accessory; palette: Palette; t: number; look: [number, number]; blink: boolean }): PxRect[]`

座標移植自 `~/.claude/desktop-pet/pet.py` 的 `draw_clawd`／`draw_terminal`／`draw_keyboard`／`draw_exclaim`／`draw_zzz`：身體左上角在 (4, 11)，身體 12×7，腳 2 格；終端機在身體上方 (3, 1) 起 14×9。

- [ ] **Step 1: 寫失敗的測試 `tests/officeSprite.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { clawdRects, PALETTE_DEFAULT, PALETTE_SHORT, SPRITE_H, SPRITE_W } from '@/lib/office/sprite';

const base = { accessory: 'tie' as const, palette: PALETTE_DEFAULT, t: 0, look: [0, 0] as [number, number], blink: false };
const has = (rs: ReturnType<typeof clawdRects>, fill: string) => rs.some(r => r.fill === fill);

describe('clawdRects', () => {
  it('所有矩形都在 viewBox 內', () => {
    for (const state of ['working', 'celebrate', 'alert', 'idle', 'unknown'] as const) {
      for (const t of [0, 0.13, 0.5, 1.7]) {
        for (const r of clawdRects({ ...base, state, t })) {
          expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(SPRITE_W); expect(r.y + r.h).toBeLessThanOrEqual(SPRITE_H);
        }
      }
    }
  });

  it('working 有終端機底色與鍵盤', () => {
    const rs = clawdRects({ ...base, state: 'working' });
    expect(has(rs, '#23222f')).toBe(true);
    expect(has(rs, '#5c7682')).toBe(true);
  });

  it('alert 有紅色驚嘆號（閃爍的亮相位）', () => {
    expect(has(clawdRects({ ...base, state: 'alert', t: 0 }), '#ff4a1c')).toBe(true);
  });

  it('idle 沒有終端機、有 zzz', () => {
    const rs = clawdRects({ ...base, state: 'idle', t: 0.3 });
    expect(has(rs, '#23222f')).toBe(false);
    expect(has(rs, '#9aa4b2')).toBe(true);
  });

  it('unknown 全部灰階', () => {
    const rs = clawdRects({ ...base, state: 'unknown' });
    expect(rs.every(r => /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$|^#([0-9a-f]{2})\4\4$/i.test(r.fill))).toBe(true);
  });

  it('palette 換色會換身體顏色', () => {
    expect(has(clawdRects({ ...base, state: 'idle', palette: PALETTE_SHORT }), PALETTE_SHORT.body)).toBe(true);
    expect(has(clawdRects({ ...base, state: 'idle', palette: PALETTE_SHORT }), PALETTE_DEFAULT.body)).toBe(false);
  });

  it('同樣輸入同樣輸出（純函數）', () => {
    expect(clawdRects({ ...base, state: 'working', t: 0.4 })).toEqual(clawdRects({ ...base, state: 'working', t: 0.4 }));
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/officeSprite.test.ts`
Expected: FAIL，`Failed to resolve import "@/lib/office/sprite"`

- [ ] **Step 3: 實作 `src/lib/office/sprite.ts`**

```ts
// Clawd 像素員工的矩形清單（單位：格）。移植自使用者的桌寵 ~/.claude/desktop-pet/pet.py（draw_clawd 等）。
// 純函數：同樣的 state／t 永遠畫出同樣的圖；眨眼與視線由呼叫端傳入。測試在 tests/officeSprite.test.ts。
import type { Accessory, SeatState } from './seats';

export interface PxRect { x: number; y: number; w: number; h: number; fill: string }
export interface Palette { body: string; dark: string }
export const PALETTE_DEFAULT: Palette = { body: '#de8a6c', dark: '#c4704f' };
export const PALETTE_SHORT: Palette = { body: '#a98bd8', dark: '#8a6cbc' };
export const SPRITE_W = 20;
export const SPRITE_H = 22;

const EYE = '#141414';
const TERM_BG = '#23222f', TERM_BAR = '#33323f';
const CODE = ['#5fd068', '#5fd068', '#7fb2ff', '#e6c35c', '#c792ea'];
const KEYB = '#5c7682', KEYB_KEY = '#8aa3ad';
const RED = '#ff4a1c', ZZZ = '#9aa4b2';
const OX = 4, OY = 11;   // 身體左上角

/** 灰階：unknown 狀態用 */
const gray = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const y = Math.round(0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255));
  const h = y.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

/** 終端機的程式碼行：用 t 決定捲動，不用亂數（純函數） */
function codeLines(t: number): { len: number; col: string; ind: number }[] {
  const step = Math.floor(t / 0.35);
  return Array.from({ length: 5 }, (_, i) => {
    const k = step + i;
    return { len: 3 + ((k * 7) % 9), col: CODE[(k * 3) % CODE.length], ind: (k * 5) % 3 };
  });
}

export function clawdRects(o: { state: SeatState; accessory: Accessory; palette: Palette; t: number; look: [number, number]; blink: boolean }): PxRect[] {
  const { state, t, look, blink } = o;
  const { body: BODY, dark: DARK } = o.palette;
  const out: PxRect[] = [];
  const px = (c: number, r: number, w = 1, h = 1, fill = BODY) => out.push({ x: OX + c, y: OY + r, w, h, fill });
  const abs = (x: number, y: number, w: number, h: number, fill: string) => out.push({ x, y, w, h, fill });

  // 背後的終端機（工作中）
  if (state === 'working') {
    abs(OX - 1, OY - 10, 14, 9, TERM_BG);
    abs(OX - 1, OY - 10, 14, 1, TERM_BAR);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => abs(OX - 0.6 + i * 0.9, OY - 9.75, 0.5, 0.5, c));
    const lines = codeLines(t);
    lines.forEach((l, i) => {
      let len = Math.min(l.len, 12 - l.ind);
      if (i === lines.length - 1) len = Math.max(1, Math.floor(len * (((t * 3) % 1) + 0.2)));
      abs(OX - 0.2 + l.ind * 0.8, OY - 8.4 + i * 1.4, Math.min(len * 0.8, 12.4 - l.ind * 0.8), 0.7, l.col);
    });
  }

  // 腳
  [1, 3, 8, 10].forEach((c, i) => {
    const lift = state === 'alert' && Math.floor(t * 6) % 2 === i % 2 ? 0.5 : 0;
    px(c, 7 - lift, 1, 2, i === 1 || i === 2 ? DARK : BODY);
  });
  // 身體
  px(0, 0, 12, 7);
  px(0, 6.5, 12, 0.5, DARK);

  // 手
  if (state === 'celebrate') {
    const up = Math.floor(t * 4) % 2;
    px(-2, 2 - up, 2, 1); px(-2, 1 - up, 1, 1);
    px(12, 1 + up, 2, 1); px(13, up, 1, 1);
  } else if (state === 'alert') {
    const wave = Math.floor(t * 6) % 2;
    px(-2, 3, 2, 1);
    px(12, 1 + wave, 2, 1); px(13, wave, 1, 1);
  } else if (state !== 'working') {
    px(-2, 3, 2, 2); px(12, 3, 2, 2);
  }

  // 眼睛
  if (state === 'idle' || state === 'unknown') {
    for (const c of [2, 9]) px(c - 0.5, 3.5, 2, 0.5, EYE);
  } else if (state === 'celebrate') {
    for (const c of [2, 9]) { px(c - 0.5, 3, 0.5, 0.5, EYE); px(c, 2.5, 1, 0.5, EYE); px(c + 1, 3, 0.5, 0.5, EYE); }
  } else if (blink) {
    for (const c of [2, 9]) px(c, 3, 1, 0.5, EYE);
  } else {
    const [ex, ey] = state === 'working' ? [0, 0.5] : state === 'alert' ? [0, 0] : look;
    for (const c of [2, 9]) px(c + ex, 2 + ey, 1, 2, EYE);
  }

  // 配件
  switch (o.accessory) {
    case 'tie': px(5.5, 4.5, 1, 0.5, '#2b4c7e'); px(5.25, 5, 1.5, 1.5, '#2b4c7e'); break;
    case 'scope': px(10.5, -1.5, 3, 1, '#3a3a46'); px(13, -1.75, 0.75, 1.5, '#7fb2ff'); break;
    case 'badgeA': case 'badgeB':
      px(4.5, 4.5, 3, 2, '#f4f1e8');
      px(5.5, 5, 1, 1, o.accessory === 'badgeA' ? '#d9534f' : '#2b7bd9'); break;
    case 'clock': px(4.5, -2, 3, 2, '#f4f1e8'); px(5.75, -1.75, 0.5, 1, EYE); px(6, -1, 1, 0.5, EYE); break;
    case 'short': px(4.5, 4.5, 3, 1, '#2c2c3a'); px(5, 5.5, 2, 1, '#2c2c3a'); break;
    case 'calendar': px(4.5, -2.5, 3, 2.5, '#f4f1e8'); px(4.5, -2.5, 3, 0.75, '#d9534f'); break;
    case 'shield': px(4.5, 4, 3, 2, '#3c8dbc'); px(5, 6, 2, 0.5, '#3c8dbc'); px(5.75, 4.5, 0.5, 1.5, '#e8ecf1'); break;
  }

  // 前方的鍵盤＋打字的手（工作中）
  if (state === 'working') {
    abs(OX - 1.5, OY + 4.5, 15, 2.5, KEYB);
    for (let row = 0; row < 2; row++) for (let col = 0; col < 13; col++) {
      abs(OX - 1.2 + col * 1.08, OY + 4.8 + row * 1.05, 0.75, 0.7, KEYB_KEY);
    }
    const tap = Math.floor(t * 8) % 2;
    px(-1, 3.5 + tap * 0.5, 2, 1); px(11, 3.5 + (1 - tap) * 0.5, 2, 1);
  }

  // 驚嘆號（閃爍）
  if (state === 'alert' && Math.floor(t * 4) % 2 === 0) {
    abs(OX + 14.5, OY - 5, 1.5, 4, RED);
    abs(OX + 14.5, OY, 1.5, 1.5, RED);
  }

  // zzz
  if (state === 'idle') {
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.6 + i / 3) % 1;
      const s = 0.5 + i * 0.25;
      abs(OX + 12.5 + ph * 2, OY - 2 - ph * 6, s, s, ZZZ);
    }
  }

  if (state === 'unknown') return out.map(r => ({ ...r, fill: gray(r.fill) }));
  return out;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/officeSprite.test.ts`
Expected: 全部 PASS。若「viewBox 內」測試失敗，回報是哪個 state、哪個矩形超界，調整該矩形的座標（不要放寬測試）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/office/sprite.ts tests/officeSprite.test.ts
git commit -m "feat(office): Clawd 像素員工圖形（移植自桌寵）"
```

---

### Task 3: 畫面元件（時鐘、角色、座位、跑馬燈）

**Files:**
- Create: `src/components/office/useTick.ts`
- Create: `src/components/office/Clawd.tsx`
- Create: `src/components/office/PixelSeat.tsx`
- Create: `src/components/office/Squawk.tsx`

**Interfaces:**
- Consumes: `clawdRects`、`PALETTE_DEFAULT`、`PALETTE_SHORT`、`SPRITE_W`、`SPRITE_H`（Task 2）；`Seat`、`SquawkLine`、`fmtHm`（Task 1）
- Produces:
  - `useTick(fps?: number): number`（秒，float）
  - `<Clawd state accessory t look? blink? size? />`
  - `<PixelSeat seat t look onClick big? />`
  - `<Squawk lines />`

- [ ] **Step 1: `src/components/office/useTick.ts`**

```ts
'use client';
// 整頁共用的動畫時鐘：requestAnimationFrame 節流到 fps，分頁隱藏時暫停；prefers-reduced-motion 時固定 0。
import { useEffect, useState } from 'react';

export function useTick(fps = 8): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now();
    let last = 0, id = 0;
    const loop = (now: number) => {
      id = requestAnimationFrame(loop);
      if (document.hidden || now - last < 1000 / fps) return;
      last = now;
      setT((now - start) / 1000);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [fps]);
  return t;
}
```

- [ ] **Step 2: `src/components/office/Clawd.tsx`**

```tsx
'use client';
// Clawd 像素員工（SVG）。圖形邏輯在 src/lib/office/sprite.ts。
import { memo } from 'react';
import { clawdRects, PALETTE_DEFAULT, PALETTE_SHORT, SPRITE_H, SPRITE_W } from '@/lib/office/sprite';
import type { Accessory, SeatState } from '@/lib/office/seats';

export const Clawd = memo(function Clawd({ state, accessory, t, look = [0, 0], blink = false, size = 80 }: {
  state: SeatState; accessory: Accessory; t: number; look?: [number, number]; blink?: boolean; size?: number;
}) {
  const rects = clawdRects({ state, accessory, t, look, blink, palette: accessory === 'short' ? PALETTE_SHORT : PALETTE_DEFAULT });
  return (
    <svg viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`} width={size} height={(size * SPRITE_H) / SPRITE_W} shapeRendering="crispEdges" aria-hidden>
      {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />)}
    </svg>
  );
});
```

- [ ] **Step 3: `src/components/office/PixelSeat.tsx`**

```tsx
'use client';
// 一個座位：泡泡＋Clawd＋木桌＋名牌＋狀態燈。點擊開詳細卡。
import type { Seat } from '@/lib/office/seats';
import { Clawd } from './Clawd';

const LAMP: Record<Seat['state'], string> = {
  working: '#f4c430', celebrate: '#3ccf4e', alert: '#ff3b30', idle: '#8d8d8d', unknown: '#555b66',
};

/** 每個座位錯開眨眼時間：用 id 算一個固定的相位 */
const phase = (id: string) => [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 47 / 10;

export function PixelSeat({ seat, t, look, onClick, big = false }: {
  seat: Seat; t: number; look: [number, number]; onClick: () => void; big?: boolean;
}) {
  const blink = (t + phase(seat.id)) % 4.2 < 0.15;
  return (
    <button type="button" onClick={onClick}
      className="group relative flex flex-col items-center pt-1 pb-2 rounded-md bg-[#3b2a1e]/40 hover:bg-[#3b2a1e]/70 transition-colors text-left">
      <span className={`max-w-full truncate px-1.5 py-0.5 mb-1 text-[10px] leading-4 font-mono rounded-sm border
        ${seat.state === 'alert' ? 'bg-[#3a1212] border-[#ff3b30]/60 text-[#ffb4ae]' : 'bg-[#f4f1e8] border-[#2a1d14] text-[#2a1d14]'}`}>
        {seat.bubble}
      </span>
      <Clawd state={seat.state} accessory={seat.accessory} t={t} look={look} blink={blink} size={big ? 104 : 76} />
      <div className="w-full h-3 -mt-1 bg-[#7a5232] border-t-2 border-[#a5744a] shadow-[0_3px_0_#4a301d]" />
      <div className="mt-2 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-[1px]" style={{ background: LAMP[seat.state], boxShadow: seat.state === 'alert' ? '0 0 6px #ff3b30' : undefined }} />
        <span className="font-mono text-[11px] tracking-wider text-[#f0dcc0] bg-[#2a1d14] px-1.5 border border-[#a5744a]">{seat.label}</span>
      </div>
    </button>
  );
}
```

- [ ] **Step 4: `src/components/office/Squawk.tsx`**

```tsx
'use client';
// SQUAWK 跑馬燈：最近的訊號（開倉綠、擋單灰附理由），新到舊。
import { fmtHm, type SquawkLine } from '@/lib/office/seats';

export function Squawk({ lines }: { lines: SquawkLine[] }) {
  return (
    <div className="rounded-lg border-2 border-[#33323f] bg-[#16151f] font-mono text-[11px] leading-5 overflow-hidden">
      <div className="flex justify-between px-2.5 py-1 bg-[#23222f] text-[#e6c35c] tracking-widest">
        <span>SQUAWK</span><span className="text-[#565E6B]">{lines.length}</span>
      </div>
      <div className="max-h-64 overflow-y-auto px-2.5 py-1.5 space-y-0.5">
        {lines.length === 0 && <p className="text-[#565E6B]">沒有訊號紀錄</p>}
        {lines.map(l => (
          <p key={l.key} className="flex gap-2 min-w-0">
            <span className="text-[#565E6B] shrink-0">{fmtHm(l.at)}</span>
            <span className={`shrink-0 w-12 ${l.tone === 'open' ? 'text-[#5fd068]' : 'text-[#7fb2ff]'}`}>{l.tag}</span>
            <span className={`truncate ${l.tone === 'open' ? 'text-[#5fd068]' : 'text-[#8A94A2]'}`}>{l.text}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 沒有錯誤

- [ ] **Step 6: Commit**

```bash
git add src/components/office
git commit -m "feat(office): 像素座位、Clawd SVG、SQUAWK 元件"
```

---

### Task 4: `/office` 頁面與首頁入口

**Files:**
- Create: `src/app/office/page.tsx`
- Modify: `src/components/s3/HomeCards.tsx`（`TodayCard` 的 `CardTitle` 那一行）

**Interfaces:**
- Consumes: `useS3Api`（`src/lib/s3s1/useS3Api.ts`）、`buildSeats`、`buildSquawk`、`demo*`（Task 1）、元件（Task 3）、`PageHeader`、`ErrorBox`（`src/components/s3/ui.tsx`）
- Produces: 路由 `/office`；`/office?demo=1`（只在非 production）

- [ ] **Step 1: 確認 `PageHeader`／`ErrorBox` 的 props**

Run: `grep -n "export function PageHeader\|export function ErrorBox" -A 3 src/components/s3/ui.tsx`
Expected: `PageHeader({ title, sub })`、`ErrorBox({ text })`。如果不一樣，Step 2 照實際 props 改。

- [ ] **Step 2: 寫 `src/app/office/page.tsx`**

```tsx
'use client';
// 像素辦公室：8 個模組畫成 Clawd 員工＋SQUAWK 跑馬燈（設計 docs/superpowers/specs/2026-11-13-office-view-design.md）。
// 只讀現有的 /api/s3/{overview,signals,ledgers}，60 秒更新。開發環境 ?demo=1 用假資料、不需登入。
import { Suspense, useMemo, useState, type PointerEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useS3Api } from '@/lib/s3s1/useS3Api';
import type { LedgersResp, OverviewResp, SignalsResp } from '@/lib/s3s1/apiTypes';
import { buildSeats, buildSquawk, type Seat } from '@/lib/office/seats';
import { DEMO_NOW, demoLedgers, demoOverview, demoSignals } from '@/lib/office/demo';
import { PixelSeat } from '@/components/office/PixelSeat';
import { Squawk } from '@/components/office/Squawk';
import { useTick } from '@/components/office/useTick';
import { ErrorBox, PageHeader } from '@/components/s3/ui';

const ALLOW_DEMO = process.env.NODE_ENV !== 'production';

export default function OfficePage() {
  // Next 14：用 useSearchParams 的 client 頁要包 Suspense，否則 next build 失敗
  return <Suspense fallback={null}><OfficeInner /></Suspense>;
}

function OfficeInner() {
  const params = useSearchParams();
  const demo = ALLOW_DEMO && params.get('demo') === '1';
  const ov = useS3Api<OverviewResp>(demo ? '' : '/api/s3/overview', demo ? undefined : 60_000);
  const sig = useS3Api<SignalsResp>(demo ? '' : '/api/s3/signals', demo ? undefined : 60_000);
  const led = useS3Api<LedgersResp>(demo ? '' : '/api/s3/ledgers', demo ? undefined : 60_000);
  const t = useTick(8);
  const [look, setLook] = useState<[number, number]>([0, 0]);
  const [open, setOpen] = useState<Seat | null>(null);

  const minute = Math.floor(Date.now() / 60_000);
  const { seats, squawk } = useMemo(() => {
    const o = demo ? demoOverview() : ov.data, s = demo ? demoSignals() : sig.data, l = demo ? demoLedgers() : led.data;
    const now = demo ? DEMO_NOW : Date.now();
    return { seats: buildSeats(o, s, l, now), squawk: buildSquawk(o, s) };
  }, [demo, ov.data, sig.data, led.data, minute]);

  // 眼睛追游標／最後點擊的位置：相對畫面中心，量化成 ±0.5 格
  const onPointer = (e: PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
    setLook([Math.round(dx * 2) / 4, Math.round(dy * 2) / 4]);
  };

  const [chief, ...rest] = seats;
  const errors = demo ? [] : [ov.error, sig.error, led.error].filter(Boolean);
  const loading = !demo && ov.loading && sig.loading && led.loading;

  return (
    <div className="min-h-screen bg-[#0A0D11] text-[#E8ECF1]" onPointerMove={onPointer} onPointerDown={onPointer}>
      <PageHeader title="辦公室" sub={demo ? '假資料預覽（?demo=1）' : '每個座位是一個正在跑的模組・60 秒更新'} />
      <div className="px-3 py-3 space-y-3 pb-20">
        {errors.length > 0 && <ErrorBox text={errors.join('；')} />}
        {loading && <p className="text-[#565E6B] text-xs text-center py-2">載入中…</p>}
        <div className="rounded-xl p-3 border-2 border-[#4a301d]"
          style={{ background: 'repeating-linear-gradient(90deg,#5a3b26 0 22px,#4f3421 22px 24px), #5a3b26' }}>
          <div className="flex justify-center mb-3">
            <div className="w-1/2 min-w-[140px]"><PixelSeat seat={chief} t={t} look={look} big onClick={() => setOpen(chief)} /></div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {rest.map(s => <PixelSeat key={s.id} seat={s} t={t} look={look} onClick={() => setOpen(s)} />)}
          </div>
        </div>
        <Squawk lines={squawk} />
      </div>

      {open && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end justify-center" onClick={() => setOpen(null)}>
          <div className="w-full max-w-xl bg-[#0D0D16] border-t-2 border-[#a5744a] rounded-t-xl p-4 pb-8" onClick={e => e.stopPropagation()}>
            <p className="font-mono text-sm text-[#f0dcc0]">{open.label}<span className="text-[#565E6B] text-xs ml-2">{open.role}</span></p>
            <p className="text-xs mt-1 text-[#8A94A2]">{open.bubble}</p>
            <dl className="mt-3 space-y-1 text-xs">
              {open.details.map(d => (
                <div key={d.k} className="flex justify-between gap-3"><dt className="text-[#565E6B]">{d.k}</dt><dd className="text-right num">{d.v}</dd></div>
              ))}
              {open.details.length === 0 && <p className="text-[#565E6B]">沒有更多資料</p>}
            </dl>
            <Link href={open.href} className="block mt-4 text-center text-xs py-2 rounded-lg border border-[#1B222B] text-[#7fb2ff]">到原頁面看 →</Link>
          </div>
        </div>
      )}
    </div>
  );
}
```

注意：`useS3Api('')` 在 demo 模式下仍會呼叫 `fetch('')`。為了不打到任何東西，Step 3 讓 `useS3Api` 在 `path` 為空字串時直接 return。

- [ ] **Step 3: `useS3Api` 加空路徑短路**

修改 `src/lib/s3s1/useS3Api.ts` 的 `load`，在 `if (busy.current) return;` 之前加：

```ts
    if (!path) { setLoading(false); return; }   // /office ?demo=1：不抓資料
```

- [ ] **Step 4: 首頁「今天」卡片加入口**

在 `src/components/s3/HomeCards.tsx`：檔頭加 `import Link from 'next/link';`，把

```tsx
      <CardTitle title="今天" right={<>下次決策 {fmtCountdown(next - now)}（台灣 08:00）</>} />
```

改成

```tsx
      <CardTitle title="今天" right={<><Link href="/office" className="text-[#7fb2ff] mr-2">🏢 辦公室</Link>下次決策 {fmtCountdown(next - now)}（台灣 08:00）</>} />
```

- [ ] **Step 5: 型別檢查＋全套測試**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 沒有型別錯誤；全部測試通過（含 Task 1、2 新增的）

- [ ] **Step 6: Commit**

```bash
git add src/app/office src/components/s3/HomeCards.tsx src/lib/s3s1/useS3Api.ts
git commit -m "feat(office): /office 頁與首頁入口"
```

---

### Task 5: 建置、預覽、推上線

**Files:** 無新檔（只有視覺調整時才改 Task 2／3 的檔）

- [ ] **Step 1: production build**

Run: `npx next build`
Expected: 成功，路由清單出現 `/office`

- [ ] **Step 2: 本機預覽**

Run（背景）：`npm run dev`，開 `http://localhost:3000/office?demo=1`，用瀏覽器工具截圖（手機寬 390px 與桌面寬各一張）。
檢查：8 個座位都出現；S3-A、S1 舉手慶祝；BR、SCAN 打瞌睡；CHIEF、CTREND、RISK 打字；SQUAWK 有 5 行；點座位會跳出詳細卡；沒有水平捲軸。

- [ ] **Step 3: 截圖給使用者確認外觀**，依回饋調 `sprite.ts`／`PixelSeat.tsx`；每次調整後重跑 `npx vitest run tests/officeSprite.test.ts`。

- [ ] **Step 4: 確認 production 不吃 demo**

用 `npx next build && npx next start` 開 `http://localhost:3000/office?demo=1`。
Expected: 沒有登入時顯示「尚未登入」錯誤，不會出現假資料。

- [ ] **Step 5: 推上線**

```bash
git push origin main
```

Vercel 自動部署。live-runner 不受影響，不用重啟。

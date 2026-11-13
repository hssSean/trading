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

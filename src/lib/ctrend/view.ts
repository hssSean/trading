// CTREND 前向驗證週帳本（EC2 research/ctrend/ctrend_forward.py 每週一寫 ctrend:*）的畫面計算、狀態行與停擺告警。
// 只記帳、不下單。設計：docs/superpowers/specs/2026-11-13-ctrend-forward-ledger-design.md

export interface CtrendMeta { lastRun: number; lastWeek: string; weeks: number; meanNet: number; tNet: number | null; startWeek: string; version: number }
export interface CtrendWeek {
  wk: string; gross: number; net: number; fund: number; turnover: number;
  nLong: number; nShort: number; nUniverse: number; kept: number; skipped: number;
  top100: { gross: number; net: number };
}
export interface CtrendOpen { wk: string; long: [string, number][]; short: [string, number][] }
export interface CtrendSummary {
  weeks: number; cumNet: number; meanNet: number; tNet: number | null;
  lastRun: number | null; lastWeek: string | null; stale: boolean;
  recent: CtrendWeek[]; openWeek: string | null; topLong: string[]; topShort: string[];
}

const DAY = 86_400_000;
export const CTREND_STALE_MS = 8 * DAY;   // status ⚠、卡片標示
export const CTREND_ALERT_MS = 9 * DAY;   // 推播

const top5 = (xs: [string, number][]) => [...xs].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5).map(x => x[0]);

export function ctrendSummary(meta: CtrendMeta | null, weeks: CtrendWeek[], open: CtrendOpen | null, now: number): CtrendSummary {
  const sorted = [...weeks].sort((a, b) => (a.wk < b.wk ? -1 : a.wk > b.wk ? 1 : 0));
  const cumNet = sorted.reduce((acc, w) => acc * (1 + w.net), 1) - 1;
  const lastRun = meta?.lastRun ?? null;
  return {
    weeks: meta?.weeks ?? sorted.length,
    cumNet,
    meanNet: meta?.meanNet ?? (sorted.length ? sorted.reduce((s, w) => s + w.net, 0) / sorted.length : 0),
    tNet: meta?.tNet ?? null,
    lastRun,
    lastWeek: meta?.lastWeek ?? null,
    stale: lastRun != null && now - lastRun > CTREND_STALE_MS,
    recent: sorted.slice(-8).reverse(),
    openWeek: open?.wk ?? null,
    topLong: open ? top5(open.long) : [],
    topShort: open ? top5(open.short) : [],
  };
}

export function decideCtrendAlert(meta: CtrendMeta | null, now: number): boolean {
  if (!meta) return false; // 還沒裝／還沒跑過：不吵
  return now - meta.lastRun > CTREND_ALERT_MS;
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

export function ctrendStatusLine(meta: CtrendMeta | null, now: number): string {
  if (!meta) return 'CTREND 週帳本：還沒跑過（EC2 要先 bash deploy/install-ctrend.sh）';
  const ageD = (now - meta.lastRun) / DAY;
  const head = now - meta.lastRun > CTREND_STALE_MS ? `⚠ CTREND 週帳本 ${ageD.toFixed(1)} 天沒更新` : 'CTREND 週帳本';
  const t = meta.tNet == null ? '—' : meta.tNet.toFixed(2);
  return `${head}：${meta.weeks} 週、平均 ${pct(meta.meanNet)}／週（t ${t}）、持倉週 ${meta.lastWeek}、${ageD.toFixed(1)} 天前更新`;
}

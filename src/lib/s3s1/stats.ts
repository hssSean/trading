// 策略帳戶的統計口徑——/strategies 頁面（/api/strategies）與 scripts/s3s1-report.ts 共用，
// 兩邊數字才會一樣。純函數，有單元測試（tests/s3s1Stats.test.ts）。
//
// 權益只算已實現損益（持倉中的單不按市價重估）：跟回測的權益曲線同一個口徑。
import { ACCTS, type AcctKey, type AcctState, type Position } from './engine';
import { LEGS, legMeta, type Leg, type LegResult } from '../../engine/s3aLive';

export interface AcctSummary {
  key: AcctKey; name: string; initial: number;
  equity: number; retPct: number;
  ddPct: number;          // 目前離高點的回撤
  maxDdPct: number;       // 追蹤以來最大回撤（已實現）
  trades: number; wins: number; winRate: number | null;
  avgR: number | null; sumR: number;
  lossStreak: number; halted: string | null;
  open: number; riskOpenPct: number;   // 持倉數、持倉風險合計佔權益
}

const done = (p: Position) => p.status === 'done';

export function summarizeAcct(k: AcctKey, state: AcctState | null, positions: Position[]): AcctSummary {
  const cfg = ACCTS[k];
  const st = state ?? { equity: cfg.initial, peak: cfg.initial, trades: 0, wins: 0, lossStreak: 0, recent: [], halted: null, lastExit: {} };
  const closed = positions.filter(done).sort((a, b) => (a.exitT ?? 0) - (b.exitT ?? 0));
  let peak = cfg.initial, maxDd = 0;
  for (const p of closed) {
    const eq = p.equityAfter ?? NaN;
    if (!Number.isFinite(eq)) continue;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  const rs = closed.map(p => p.netR ?? NaN).filter(Number.isFinite);
  const open = positions.filter(p => p.status === 'open');
  return {
    key: k, name: cfg.name, initial: cfg.initial,
    equity: st.equity, retPct: (st.equity / cfg.initial - 1) * 100,
    ddPct: st.peak > 0 ? (st.peak - st.equity) / st.peak * 100 : 0,
    maxDdPct: maxDd * 100,
    trades: st.trades, wins: st.wins, winRate: st.trades ? st.wins / st.trades : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    sumR: rs.reduce((a, b) => a + b, 0),
    lossStreak: st.lossStreak, halted: st.halted,
    open: open.length,
    riskOpenPct: st.equity > 0 ? open.reduce((a, p) => a + p.riskUsdt, 0) / st.equity * 100 : 0,
  };
}

/** testnet 上 S3-A／S3-B 的已平倉紀錄（src/engine/s3aLive.ts finalize 寫的格式） */
export interface LiveDone {
  symbol: string; entryDay: number; entryAt: number; entry: number; stop0: number; qty0: number;
  exitAt: number; exitAvg: number | null; netPnl: number; fee: number; fundingFee: number; R: number;
  partial: boolean;
  /** 分帳結果（沒有的舊紀錄 = 全部是 S3-A） */
  legRes?: Partial<Record<Leg, LegResult>>;
  addQtyFilled?: number; addEntry?: number | null;
}

export interface LiveSummary {
  leg: Leg; name: string;
  baseEquity: number | null; realized: number; retPct: number | null; ddPct: number | null;
  trades: number; wins: number; avgR: number | null; lossStreak: number; halted: string | null;
}

/** 某一筆已平倉交易裡，這個策略的那一份（沒有就回 null） */
export function legOf(x: LiveDone, leg: Leg): { net: number; R: number } | null {
  if (x.legRes) return x.legRes[leg] ?? null;
  return leg === 'A' ? { net: x.netPnl, R: x.R } : null;
}

/** testnet 真倉某個策略（A 或 B）的累計；帳在 s3a-live:meta（A 無前綴、B 前綴 b.） */
export function summarizeLive(meta: Record<string, unknown>, closed: LiveDone[], leg: Leg = 'A'): LiveSummary {
  const m = legMeta(meta, leg);
  const base = m.base > 0 ? m.base : null;
  const mine = closed.map(x => legOf(x, leg)).filter((x): x is { net: number; R: number } => x != null);
  const rs = mine.map(x => x.R).filter(Number.isFinite);
  return {
    leg, name: LEGS[leg].name,
    baseEquity: base, realized: m.realized,
    retPct: base ? m.realized / base * 100 : null,
    ddPct: base ? (m.peak - m.realized) / (base + m.peak) * 100 : null,
    trades: mine.length, wins: mine.filter(x => x.net > 0).length,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    lossStreak: m.streak, halted: m.halted,
  };
}

/** 被擋掉的訊號理由歸類：把數字換成 n，同類的擋單才會合併計數 */
export const reasonKey = (r: string | undefined) => (r ?? '?').replace(/（.*$/, '').replace(/\d+(\.\d+)?/g, 'n').trim();

/** 研究端 monthly_update.py 寫在 Redis `s3s1:fresh` 的摘要：規則定案後（2026-09 起）新資料的樣本外結果 */
export interface FreshSummary {
  month: string; at: number; ok: boolean; dataEnd?: number; error?: string;
  s3?: { n: number; avgR: number | null }; s1?: { n: number; avgR: number | null }; br?: { n: number; avgR: number | null };
  s3score2?: { n: number; avgR: number | null; sumR: number; days: number };
}
/** status 用的一行字；超過 45 天沒更新或上次失敗時加警告 */
export function freshLine(f: FreshSummary | null, now: number): string {
  if (!f) return '研究端新資料  還沒有摘要（研究端跑 run_monthly.cmd）';
  const r = (x?: { n: number; avgR: number | null }) => (x && x.n ? `${x.n} 筆 ${x.avgR! >= 0 ? '+' : ''}${x.avgR!.toFixed(2)}R` : '0 筆');
  const days = Math.floor((now - f.at) / 86_400_000);
  const warn = !f.ok ? '  ⚠ 上次執行失敗' : days > 45 ? `  ⚠ ${days} 天沒更新` : '';
  return `研究端新資料（2026-09～${f.month}）  S3 分數 2：${r(f.s3score2)}${f.s3score2?.n ? `（${f.s3score2.days} 個進場日）` : ''}｜S1：${r(f.s1)}｜BR：${r(f.br)}${warn}`;
}

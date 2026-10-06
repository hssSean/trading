// 策略帳戶的統計口徑——/strategies 頁面（/api/strategies）與 scripts/s3s1-report.ts 共用，
// 兩邊數字才會一樣。純函數，有單元測試（tests/s3s1Stats.test.ts）。
//
// 權益只算已實現損益（持倉中的單不按市價重估）：跟回測的權益曲線同一個口徑。
import { ACCTS, type AcctKey, type AcctState, type Position } from './engine';

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

/** testnet 上 S3-A 的已平倉紀錄（src/engine/s3aLive.ts finalize 寫的格式） */
export interface LiveDone {
  symbol: string; entryDay: number; entryAt: number; entry: number; stop0: number; qty0: number;
  exitAt: number; exitAvg: number | null; netPnl: number; fee: number; fundingFee: number; R: number;
  partial: boolean;
}

export interface LiveSummary {
  baseEquity: number | null; realized: number; retPct: number | null; ddPct: number | null;
  trades: number; wins: number; avgR: number | null; lossStreak: number; halted: string | null;
}

export function summarizeLive(meta: Record<string, unknown>, closed: LiveDone[]): LiveSummary {
  const base = Number(meta.baseEquity) || null;
  const realized = Number(meta.realized ?? 0);
  const peakR = Number(meta.peakRealized ?? 0);
  const rs = closed.map(x => x.R).filter(Number.isFinite);
  return {
    baseEquity: base, realized,
    retPct: base ? realized / base * 100 : null,
    ddPct: base ? (peakR - realized) / (base + peakR) * 100 : null,
    trades: closed.length, wins: closed.filter(x => x.netPnl > 0).length,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    lossStreak: Number(meta.lossStreak ?? 0), halted: meta.halted ? String(meta.halted) : null,
  };
}

/** 被擋掉的訊號理由歸類：把數字換成 n，同類的擋單才會合併計數 */
export const reasonKey = (r: string | undefined) => (r ?? '?').replace(/（.*$/, '').replace(/\d+(\.\d+)?/g, 'n').trim();

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

// Pure math extracted from the server monitor loop (api/analyze/route.ts) so it's
// unit-testable without pulling in that route's Next.js/Redis/Supabase imports.

// 2026-07-26：24h/72h/168h 到期平倉若發生在 TP1 已達標之後，出場價不可比保本
// 地板差——地板取已棘輪的 trailingStop（若有），否則退回 entry。沒有這道 clamp，
// 一段緩跌到期（每根 K 線的 low/high 都沒實際穿越 trailingStop，棘輪判定不會觸發）
// 會讓 TP1 達標的單直接照到期當下市價出場，吐回虧損（實測 ETH：TP1 後 24h 到期
// 出場價跌破 entry）。
export function clampAutoCloseAfterTp1(
  lastClose: number, trailingStop: number, entry: number, isLong: boolean,
): number {
  const floor = trailingStop > 0 ? trailingStop : entry;
  return isLong ? Math.max(lastClose, floor) : Math.min(lastClose, floor);
}

// Shared "what happens after this position is live" walk, used by both the
// reject-funnel shadow simulator (gate-rejected candidates that were never
// really taken) and the time-stop shadow simulator (real trades force-closed
// early by the 8-bar stall rule or the 24h/72h/168h expiry, continued forward
// to see what would have happened — docs/TODO.md P1 #1). Both need identical
// TP1→TP2/SL sequencing (TP1-before-SL wins on the same candle) so the two
// simulated numbers are comparable to each other and to real monitor outcomes.
//
// Pure: takes the candles + starting state, returns the outcome without
// mutating anything. Caller applies the result to its own persisted shape.
export interface WalkCandle { high: number; low: number; close: number; closeTime: number; }

export interface WalkTpSlParams {
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  isLong: boolean;
}

export interface WalkTpSlResult {
  tp1Hit: boolean;
  done: boolean;
  result?: 'WIN_TP1' | 'WIN_TP2' | 'LOSS';
  exitPrice?: number;
  closedAt?: number;
}

// Why a position closed, distinct from win/loss (closeResult) itself — two WIN_TP1
// trades can have completely different stories (one rode the ratcheted trailing
// stop after TP1, another got cut by the age limit right after TP1). Extracted so
// the branch ordering (autoClosedAfterTp1 must be checked before the generic
// WIN_TP1 fallback; timeStopFired before the generic MANUAL_CLOSE fallback) is
// covered by tests instead of only a manual read-through — docs/TODO.md 報表 work.
export type CloseReason =
  | 'tp2' | 'trailing_stop' | 'stop_loss'
  | 'time_stop_stall' | 'time_stop_expiry' | 'time_stop_expiry_post_tp1';

export function deriveCloseReason(params: {
  closeResult: string;
  timeStopFired: boolean;
  autoClosedAfterTp1: boolean;
}): CloseReason {
  const { closeResult, timeStopFired, autoClosedAfterTp1 } = params;
  if (closeResult === 'WIN_TP2') return 'tp2';
  if (closeResult === 'LOSS') return 'stop_loss';
  if (closeResult === 'MANUAL_CLOSE') return timeStopFired ? 'time_stop_stall' : 'time_stop_expiry';
  // WIN_TP1 from here on. autoClosedAfterTp1 (age limit reached post-TP1) must be
  // checked before the generic fallback — it's also reached via closeResult==='WIN_TP1'
  // but is NOT a trailing-stop exit.
  if (autoClosedAfterTp1) return 'time_stop_expiry_post_tp1';
  return 'trailing_stop'; // ratcheted trailing stop hit, or (rare, ATR unavailable) the original SL floor after TP1
}

export function walkTpSl(
  candles: WalkCandle[],
  afterMs: number,
  params: WalkTpSlParams,
  tp1HitAlready: boolean,
): WalkTpSlResult {
  const { stopLoss, tp1, tp2, isLong } = params;
  let tp1Hit = tp1HitAlready;
  for (const c of candles) {
    if (c.closeTime <= afterMs) continue;
    const hitSL  = isLong ? c.low  <= stopLoss : c.high >= stopLoss;
    const hitTP1 = isLong ? c.high >= tp1      : c.low  <= tp1;
    const hitTP2 = isLong ? c.high >= tp2      : c.low  <= tp2;
    if (tp1Hit) {
      if (hitTP2) return { tp1Hit, done: true, result: 'WIN_TP2', exitPrice: tp2,      closedAt: c.closeTime };
      if (hitSL)  return { tp1Hit, done: true, result: 'WIN_TP1', exitPrice: stopLoss, closedAt: c.closeTime };
      continue;
    }
    if (hitTP2)      return { tp1Hit, done: true, result: 'WIN_TP2', exitPrice: tp2, closedAt: c.closeTime };
    else if (hitTP1) { tp1Hit = true; continue; } // TP1-before-SL same-candle rule (matches monitor)
    else if (hitSL)  return { tp1Hit, done: true, result: 'LOSS', exitPrice: stopLoss, closedAt: c.closeTime };
  }
  return { tp1Hit, done: false };
}

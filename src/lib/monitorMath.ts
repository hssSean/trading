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

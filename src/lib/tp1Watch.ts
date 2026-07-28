import { TradeRecord } from '@/types';
import { isUnconfirmedSync } from './tradeSync';

// Client-side TP1 detection.
//
// This is *cosmetic only*: every real close (TP2, SL, TP1-final) is decided
// server-side by monitorActiveTrades. All this does is flip the card to
// "✅ TP1·等TP2" the moment price touches TP1, instead of waiting up to 2 min
// for the next Supabase sync to say so.
//
// Extracted from the old per-page price loop so the global price feed and the
// on-demand analysis path share one implementation (and so it's testable —
// the previous version was inline inside a fetch callback).

type Watchable = Pick<
  TradeRecord,
  'id' | 'symbol' | 'direction' | 'tp1' | 'result' | 'status' | 'statusConfirmed'
>;

/**
 * Returns the ids of open trades whose TP1 the given prices have reached.
 *
 * Excluded on purpose:
 * - `status === 'waiting'` — a limit order that hasn't filled has no position,
 *   so price crossing TP1 means nothing yet.
 * - `status === 'tp1_hit'` — already marked, nothing to do.
 * - `isUnconfirmedSync` — status is `undefined` because the server hasn't
 *   confirmed the row yet, not because it's active. Its real status may still
 *   be 'waiting'; marking it tp1_hit would invent a fill (see tradeSync.ts).
 *
 * @param priceOf returns 0 when no price is known for that symbol — those are skipped.
 */
export function pickTp1Hits(
  trades: Watchable[],
  priceOf: (symbol: string) => number,
): string[] {
  const hits: string[] = [];
  for (const t of trades) {
    if (t.result) continue;
    if (t.status === 'waiting' || t.status === 'tp1_hit') continue;
    if (isUnconfirmedSync(t)) continue;

    const px = priceOf(t.symbol);
    if (!(px > 0)) continue;

    const reached = t.direction === 'LONG' ? px >= t.tp1 : px <= t.tp1;
    if (reached) hits.push(t.id);
  }
  return hits;
}

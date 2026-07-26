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

// 緊急全平的計畫（純函數；執行在 scripts/flatten.ts）。
// kill switch 只擋「新的下單與改單」，不會平倉——這支補上任務書 5.6「手動緊急全平倉並停止交易的指令」。
//
// 順序是刻意的：先市價平倉、再撤單。
//   - 先撤止損再平倉：中間那幾秒部位沒有保護。
//   - live-runner 的 kill switch 有 60 秒快取，全平後它可能還會跑一兩輪：看到部位歸零會走「已平倉」
//     （撤剩下的條件單、結算），這是對的；但如果先撤單，它會把止損補掛回去，變成沒有部位的孤兒單，
//     而 kill switch 生效後整輪跳過、沒有人清。
//   - S3-B 的加碼單是 BUY STOP_MARKET（非 reduceOnly），部位平掉後不撤會開出新倉，所以平倉後立刻撤全部。
export interface FlattenPlan {
  closes: { symbol: string; side: 'BUY' | 'SELL'; quantity: number }[];
  cancelOrders: { symbol: string; orderId: number }[];
  cancelAlgos: { symbol: string; algoId: number }[];
}

export function planFlatten(
  positions: { symbol: string; positionAmt: string }[],
  openOrders: { symbol: string; orderId: number }[],
  openAlgoOrders: { symbol: string; algoId: number }[],
): FlattenPlan {
  const closes: FlattenPlan['closes'] = [];
  for (const p of positions) {
    const amt = Number(p.positionAmt);
    if (!Number.isFinite(amt) || amt === 0) continue;
    // 數量直接用交易所回報的字串轉回來（已經是合法步長），不重新取整
    closes.push({ symbol: p.symbol, side: amt > 0 ? 'SELL' : 'BUY', quantity: Math.abs(amt) });
  }
  return {
    closes,
    cancelOrders: openOrders.map(o => ({ symbol: o.symbol, orderId: o.orderId })),
    cancelAlgos: openAlgoOrders.map(a => ({ symbol: a.symbol, algoId: a.algoId })),
  };
}

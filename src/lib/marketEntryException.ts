// 2026-08-11：拒絕漏斗診斷後續 #1——cancelShadow 數據顯示 cancel_tp1_direct
// （+4.32R，25/25全勝）跟 cancel_ran_away（+5.44R，5/5全勝）：訊號夠強、
// 4H 方向確認時，死等 EMA20 回調價常常等不到，錯過整段行情，30 筆樣本全部
// 是「如果當初直接市價進場會直達 TP1／行情走遠」的案例。
//
// 門檻沿用 route.ts 既有 Entry-TF fallback 用的同一個 margin（score >=
// STRONG_THRESHOLD+10），不是另外發明的數字——那個機制已經是「例外高分
// 訊號可以繞過正常路徑」的先例，這裡是同一種判斷邏輯，用在「要不要等
// 回調」而不是「要不要採用這個時框」。
//
// 不是切換成 MARKET 單類型——entry 直接改用訊號當下市價（signalPrice），
// 止損/TP1/TP2 距離維持原本設計的絕對值不變（風報比不變，整套價位平移到
// 市價這個參考點）。decideEntryOrder（orderLifecycle.ts）送出的還是 LIMIT
// 單，但價格就在市價附近，正常流動性下會立即成交，等同市價進場的效果，
// 又不會有 MARKET 單那種無上限的滑價風險——這是刻意選的更保守做法。
//
// 純函數：不碰 route.ts 的變數作用域，呼叫端把判斷需要的欄位餵進來。

export interface MarketEntryCandidate {
  strategy?: 'A' | 'B' | 'C';
  score: number;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  signalPrice?: number;
  scoreBreakdown?: { entryDistAtr?: number };
}

export interface MarketEntryShiftResult {
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  originalEntry: number;
}

export function shouldEnterAtMarket(
  signal: MarketEntryCandidate,
  scoreThreshold: number,
  biasConfirmed: boolean,
): boolean {
  return (
    signal.strategy !== 'B' &&
    signal.score >= scoreThreshold &&
    biasConfirmed &&
    !!signal.signalPrice &&
    (signal.scoreBreakdown?.entryDistAtr ?? 0) > 0
  );
}

// 把 entry 平移到 signalPrice，止損/TP1/TP2 用同一個位移量跟著平移——
// 維持原本設計的絕對風險距離跟風報比，不重新設計價位邏輯。
export function shiftSignalToMarketEntry(signal: MarketEntryCandidate): MarketEntryShiftResult {
  const originalEntry = signal.entry;
  const shift = (signal.signalPrice ?? originalEntry) - originalEntry;
  return {
    entry: signal.signalPrice ?? originalEntry,
    stopLoss: signal.stopLoss + shift,
    takeProfits: signal.takeProfits.map(tp => tp + shift),
    originalEntry,
  };
}

// 主決策函數：「這筆 Supabase 推薦單，現在該對交易所做什麼」。這是把之前
// 分別寫好、分別測過的積木（decideEntryOrder / decideTrailingStopReplace /
// decideTp1PartialClose / checkLiquidationSafety）串成一條真的會動的線的
// 地方——runner.ts 執行「怎麼做」，這裡決定「該做什麼」。
//
// 呼叫端（live-runner 的主迴圈，還沒接）每輪對每筆開著的 trade row 呼叫一次
// 這個函數，餵進「DB 記的這筆單長怎樣」+「交易所上真實看到的快照」，拿回
// 一個動作決定。
//
// 刻意不做的（明確範圍邊界，不是漏掉）：
//   - 移動止損「目標價該設多少」——那是 route.ts 裡一大段 ATR 棘輪計算，
//     需要 K 線資料，不是單純從交易所快照能推出來的。呼叫端如果已經另外
//     算好 desiredStopPrice，直接呼叫 decideTrailingStopReplace 即可，
//     不需要透過這個函數。
//   - 部位消失但 DB 還記著開倉（needs_reconcile）——要查歷史成交
//     （getUserTrades 之類，binanceClient.ts 目前沒有這個方法）才能判斷
//     是 TP2/SL 觸發還是別的原因，這版只偵測出「需要處理」，不猜答案。
//   - 時間止損/盤整停滯關單——同樣需要 K 線資料。

import { PlaceOrderParams, UserTrade } from './binanceClient';
import { SymbolFilters } from './precision';
import {
  decideEntryOrder, decideTp1PartialClose, decideTrailingStopReplace,
} from './orderLifecycle';
import { checkLiquidationSafety, LiquidationPriceInput } from './liquidation';
import { MAX_TOTAL_RISK_PCT } from '@/lib/position';

// 對帳用：部位消失後，把 getUserTrades() 查回來的一批成交紀錄彙總成
// 「加權平均出場價 + 總實現損益」——用 quoteQty/qty 算真正的成交均價，
// 比對每筆成交價做簡單平均更準確（大單常常會拆成好幾筆不同價位成交）。
export interface ClosingTradesSummary {
  avgExitPrice: number;
  totalQty: number;
  totalRealizedPnl: number;
  totalCommission: number;
}

export function summarizeClosingTrades(trades: UserTrade[]): ClosingTradesSummary | null {
  if (trades.length === 0) return null;
  let totalQty = 0;
  let totalQuoteQty = 0;
  let totalRealizedPnl = 0;
  let totalCommission = 0;
  for (const t of trades) {
    totalQty += parseFloat(t.qty);
    totalQuoteQty += parseFloat(t.quoteQty);
    totalRealizedPnl += parseFloat(t.realizedPnl);
    totalCommission += parseFloat(t.commission);
  }
  if (totalQty <= 0) return null;
  return {
    avgExitPrice: totalQuoteQty / totalQty,
    totalQty,
    totalRealizedPnl,
    totalCommission,
  };
}

export interface BridgeTradeRow {
  id: string;
  symbol: string;
  isLong: boolean;
  entry: number;
  stopLoss: number;
  tp1: number;
  exchangeEntryOrderId: number | null;
  exchangeStopAlgoId: number | null;
}

export interface BridgeExchangeSnapshot {
  positionQty: number;          // absolute value, 0 = flat
  entryOrderStillOpen: boolean; // LIMIT 進場單還掛著（未成交也未取消）
  currentStop: { algoId: number; triggerPrice: number } | null;
  markPrice: number;
  filters: SymbolFilters;
  // 只有在部位剛消失、呼叫端已經另外查過 getUserTrades() 時才會有值——不是
  // 每輪都要查，只在真的需要對帳（positionQty 從有變 0）那一刻才查。有給
  // 就能直接算出關單結果，沒給就退回單純標記需要處理。
  recentTrades?: UserTrade[];
}

export interface RiskCheckInput {
  positionUSDT: number;      // calcPositionPlan 算好的名目倉位，呼叫端負責算
  totalOpenRiskPct: number;  // checkTotalOpenRisk 目前的加總（不含這筆）
  thisTradeRiskPct: number;  // 這筆要加的 suggested_risk_pct
  liquidation: Pick<LiquidationPriceInput, 'isolatedMarginUSDT' | 'maintMarginRatio' | 'maintAmount'>;
}

export type TradeAction =
  | { kind: 'skip_entry'; reason: string }
  | { kind: 'place_entry'; order: PlaceOrderParams; quantity: number }
  | { kind: 'wait_for_fill'; reason: string }
  | { kind: 'needs_reconcile'; reason: string }
  | { kind: 'sync_closed_position'; avgExitPrice: number; realizedPnl: number }
  | { kind: 'place_initial_stop'; order: PlaceOrderParams }
  | { kind: 'tp1_partial_close'; order: PlaceOrderParams; closeQty: number; remainingQty: number }
  | { kind: 'hold'; reason: string };

export function decideTradeAction(
  trade: BridgeTradeRow,
  snapshot: BridgeExchangeSnapshot,
  risk: RiskCheckInput,
): TradeAction {
  // 1. 還沒真的在交易所下過進場單。
  if (trade.exchangeEntryOrderId === null) {
    const wouldBeTotal = risk.totalOpenRiskPct + risk.thisTradeRiskPct;
    if (wouldBeTotal > MAX_TOTAL_RISK_PCT) {
      return {
        kind: 'skip_entry',
        reason: `全局風險上限：目前已開 ${risk.totalOpenRiskPct} + 這筆 ${risk.thisTradeRiskPct} = ${wouldBeTotal} 會超過上限 ${MAX_TOTAL_RISK_PCT}`,
      };
    }

    // 用 positionUSDT/entry 的近似數量做強平安全檢查——decideEntryOrder 會再
    // 用 stepSize 精算一次真正下單的 quantity，兩者差異遠小於強平價的安全
    // 邊際，不影響這個檢查的結論。
    const approxQty = risk.positionUSDT / trade.entry;
    const safety = checkLiquidationSafety({
      entry: trade.entry, positionQty: approxQty, isLong: trade.isLong,
      stopLoss: trade.stopLoss, ...risk.liquidation,
    });
    if (!safety.safe) {
      return { kind: 'skip_entry', reason: safety.reason };
    }

    const entryDecision = decideEntryOrder({
      tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
      entry: trade.entry, positionUSDT: risk.positionUSDT, filters: snapshot.filters,
    });
    if (entryDecision.skip) return { kind: 'skip_entry', reason: entryDecision.reason };
    return { kind: 'place_entry', order: entryDecision.order, quantity: entryDecision.quantity };
  }

  // 2. 進場單已下，還沒成交（沒部位、單還掛著）。
  if (snapshot.positionQty === 0 && snapshot.entryOrderStillOpen) {
    return { kind: 'wait_for_fill', reason: '進場單尚未成交' };
  }

  // 3. 沒部位、進場單也不在了——不知道是被取消還是已經平倉完。如果呼叫端
  //    已經另外查過 getUserTrades() 並帶進 snapshot.recentTrades，直接算出
  //    結果；沒有的話只標記需要處理，不猜答案。
  if (snapshot.positionQty === 0 && !snapshot.entryOrderStillOpen) {
    const summary = snapshot.recentTrades ? summarizeClosingTrades(snapshot.recentTrades) : null;
    if (summary) {
      return { kind: 'sync_closed_position', avgExitPrice: summary.avgExitPrice, realizedPnl: summary.totalRealizedPnl };
    }
    return {
      kind: 'needs_reconcile',
      reason: '部位為空但進場單已消失——需要查歷史成交判斷原因（呼叫端可查 getUserTrades 帶進 snapshot.recentTrades 讓這裡直接算出結果）',
    };
  }

  // 4. 有部位但沒止損——最危險的裸倉窗口，優先於任何其他判斷處理。
  if (snapshot.currentStop === null) {
    const stopDecision = decideTrailingStopReplace({
      tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
      currentStopOrder: null, desiredStopPrice: trade.stopLoss, filters: snapshot.filters,
    });
    if (stopDecision.kind === 'initialize') {
      return { kind: 'place_initial_stop', order: stopDecision.place };
    }
    // currentStopOrder: null 只會產生 'initialize'，這個分支理論上不會走到——
    // 留著是因為 TypeScript 不知道這件事，寧可回一個看得懂的 hold 也不要 unreachable throw。
    return { kind: 'hold', reason: '補止損決策回傳非預期結果' };
  }

  // 5. 有止損。觸價 TP1、且目前止損還是「初始止損」（尚未做過 TP1 部分平倉，
  //    用止損價跟 trade.stopLoss 是否相同來判斷——部分平倉後止損會被移動，
  //    不會再等於原始 stopLoss）。
  const isInitialStop = Math.abs(snapshot.currentStop.triggerPrice - trade.stopLoss) < 1e-8;
  const touchedTp1 = trade.isLong
    ? snapshot.markPrice >= trade.tp1
    : snapshot.markPrice <= trade.tp1;

  if (isInitialStop && touchedTp1) {
    const tp1Decision = decideTp1PartialClose({
      tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
      positionQty: snapshot.positionQty, filters: snapshot.filters,
    });
    if (tp1Decision.skip) return { kind: 'hold', reason: `TP1 部分平倉跳過：${tp1Decision.reason}` };
    return {
      kind: 'tp1_partial_close',
      order: tp1Decision.order, closeQty: tp1Decision.closeQty, remainingQty: tp1Decision.remainingQty,
    };
  }

  return {
    kind: 'hold',
    reason: '持有中，等待下一個關卡（移動止損目標價計算不在這個函數內，見模組頂部說明）',
  };
}

// 主決策函數：「這筆 Supabase 推薦單，現在該對交易所做什麼」。這是把之前
// 分別寫好、分別測過的積木串成一條真的會動的線的地方——runner.ts 執行
// 「怎麼做」，這裡決定「該做什麼」。
//
// 呼叫端（live-runner 的主迴圈）每輪對每筆開著的 trade row 呼叫一次這個
// 函數，餵進「DB 記的這筆單長怎樣」+「交易所上真實看到的快照」，拿回一個
// 動作決定。

import { PlaceOrderParams, UserTrade } from './binanceClient';
import { SymbolFilters } from './precision';
import {
  calcTrailingStopTarget, decideEntryOrder, decideFullClose,
  decideTp1OrderPlacement, decideTrailingStopReplace,
} from './orderLifecycle';
import { checkLiquidationSafety, LiquidationPriceInput } from './liquidation';
import { decideTimeStop, tfBarMinutes, TimeStopCloseReason, TimeStopTimeframe } from './timeStop';
import { MAX_TOTAL_RISK_PCT } from '@/lib/position';
import { CloseReason } from '@/lib/monitorMath';

// 2026-08-11：實測撞到——SOLUSDT 掛單等了 15 小時 28 分還沒成交，Redis
// 的 tlock 因此正確地一直卡著（避免同個 symbol 被重複追蹤），但表面上
// 使用者看到的是「跳過—持倉中」，誤以為是鎖沒釋放的 bug，其實根因更早：
// decideTradeAction 第 2 步（wait_for_fill）從沒判斷過「這張 LIMIT 進場
// 單本身是不是已經掛太久了」，route.ts 的 DB 模擬監控有這個機制
// （WAITING_EXPIRY_BARS=4，規格 §3-A：掛單有效期最多 4 根該時框 K 線），
// 但 live-runner 這條真倉路徑上一直沒有對應規則，導致掛單永遠不會被
// 主動撤銷，只能等它自己「碰巧」從交易所端消失才會被 entry_never_filled
// 分支撿到。門檻照抄 route.ts 那個常數，不是另外發明的數字。
const WAITING_EXPIRY_BARS = 4;

// 2026-08-13（docs/策略修改.md 修改1）：TP1 前保本保護，真倉路徑鏡像
// route.ts 的 DB 模擬版本——同一個門檻、同樣單階不做多階梯，數字照抄
// 不是另外發明（理由見 route.ts PRE_TP1_BREAKEVEN_TRIGGER_R 註解）。
// 2026-08-17：0.8→0.5，原本的 0.8 實測 0/20 虧損單觸發過，等於死碼——
// 同上，理由見 route.ts 同名常數註解。
const PRE_TP1_BREAKEVEN_TRIGGER_R = 0.5;

// 對帳用：部位消失後，把 getUserTrades() 查回來的一批成交紀錄彙總成
// 「加權平均出場價 + 總實現損益」——用 quoteQty/qty 算真正的成交均價，
// 比對每筆成交價做簡單平均更準確（大單常常會拆成好幾筆不同價位成交）。
//
// 2026-08-16 實測撞到嚴重 bug：呼叫端（live-runner）用 `startTime:
// filled_at` 查成交紀錄，查回來的是「成交之後的所有成交」——包含進場
// 那幾筆自己的成交，不只是平倉的。舊版本把整批不分方向全部平均，進場
// 成交的 realizedPnl 恆為 0，一旦平倉成交還沒同步進幣安（真實撞到過：
// positionRisk 已經歸零，userTrades 還沒跟上），summary 就只剩進場成交，
// avgExitPrice 算出來等於進場價、realizedPnl=0 恆判定成 WIN——策略B
// 因此被標成「TP2 全部達標」但帳戶實際虧損 110 USDT。
//
// 修法：只算「平倉方向」的成交（LONG 的平倉是 SELL，SHORT 的平倉是
// BUY），進場方向的成交（即使混在同一批查詢結果裡）直接濾掉。濾完一筆
// 都不剩就回 null——呼叫端本來就有這個分支（見 decideTradeAction 該
// action 產生處），summary 是 null 時會退回 needs_reconcile 等下一輪
// 幣安那邊同步完再重查，不會用不完整的資料硬算出一個看起來合理但是
// 錯的答案。
export interface ClosingTradesSummary {
  avgExitPrice: number;
  totalQty: number;
  totalRealizedPnl: number;
  totalCommission: number;
}

export function summarizeClosingTrades(trades: UserTrade[], isLong: boolean): ClosingTradesSummary | null {
  const closingSide = isLong ? 'SELL' : 'BUY';
  const closingTrades = trades.filter(t => t.side === closingSide);
  if (closingTrades.length === 0) return null;
  let totalQty = 0;
  let totalQuoteQty = 0;
  let totalRealizedPnl = 0;
  let totalCommission = 0;
  for (const t of closingTrades) {
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

// 2026-08-12：真倉關單原因細分——之前 sync_closed_position 刻意只做贏/輸
// 二元判斷（見下方該 action 產生處的長註解），理由是「多筆分批出場的加權
// 均價無法可靠反推是哪個關卡觸發的，硬猜會汙染統計」（8/6 tier `?? 'A'`
// 就是這樣出包的）。這裡不是猜——用的是已知事實，不是從出場價反推：
//   1. pendingCloseReason：如果是我們自己主動送出的 close_full_position
//      （時間止損/盤整停滯），執行時就已經把原因寫回 DB 了，這裡直接讀，
//      不用猜。
//   2. strategy：DB 裡本來就有，不是猜的。
//   3. entry/stopLoss/avgExitPrice：2026-08-13 補（策略修改.md 修改1
//      上線後新增）——這三個都是已知事實，不是反推。「LOSS 一定是原始
//      止損」這個舊假設不再成立：TP1 前保本止損上線後，真倉也會出現
//      「先浮盈到 0.8R 又跌回保本點」這種結果落在 result=LOSS（手續費/
//      滑價讓 realizedPnl 略負）的情況。entry 跟 stopLoss 一定是兩個不同
//      的價位（止損定義上不等於進場價），出場價比較接近哪一個，就是哪個
//      觸發的——這是拿已知的實際成交價去比對兩個已知候選價位，不是「從
//      模糊的加權均價反推分類」那種猜法。
export function deriveLiveCloseReason(params: {
  pendingCloseReason: TimeStopCloseReason | null;
  strategy: 'A' | 'B';
  result: 'WIN_TP1' | 'LOSS';
  entry: number;
  stopLoss: number;
  avgExitPrice: number;
}): CloseReason {
  const { pendingCloseReason, strategy, result, entry, stopLoss, avgExitPrice } = params;
  if (pendingCloseReason) return pendingCloseReason;
  if (result === 'LOSS') {
    const distToEntry    = Math.abs(avgExitPrice - entry);
    const distToStopLoss = Math.abs(avgExitPrice - stopLoss);
    return distToEntry < distToStopLoss ? 'pre_tp1_breakeven' : 'stop_loss';
  }
  return strategy === 'B' ? 'tp2' : 'trailing_stop';
}

export interface BridgeTradeRow {
  id: string;
  symbol: string;
  isLong: boolean;
  entry: number;
  stopLoss: number;
  tp1: number;
  // 策略B（均值回歸）沒有兩階段 TP——tp1/tp2 是同一個值（[tp1, tp1]，見
  // signals.ts generateMeanReversionSignals），觸價要整單了結，不是先平一半
  // 留一半給移動止損。策略A才有 TP1 部分平倉 + 移動止損那一整套。
  strategy: 'A' | 'B';
  timeframe: TimeStopTimeframe;
  filledAt: number | null; // 還沒真的成交過時是 null——這個檢查點理論上不會用到（見 decideTradeAction 內部）
  // 2026-08-11：掛單本身的建立時間（不是成交時間）——判斷「這張 LIMIT
  // 進場單掛了多久還沒成交」要用這個當基準，不能用 filledAt（成交前
  // 恆為 null）。
  openedAt: number;
  // 2026-08-10：進場確認成交那一刻的部位量，用來判斷「TP1 是否已經發生」——
  // 不再看 TP1 條件單還在不在（消失可能是成交也可能是被拒絕/取消，無法單靠
  // 這個區分），而是比較 snapshot.positionQty 是否比這個值小。null 代表還
  // 沒有基準值（理論上不會走到用它判斷的分支，見 decideTradeAction 內部）。
  entryQty: number | null;
  exchangeEntryOrderId: number | null;
  exchangeStopAlgoId: number | null;
  exchangeTp1AlgoId: number | null;
}

export interface BridgeExchangeSnapshot {
  positionQty: number;          // absolute value, 0 = flat
  entryOrderStillOpen: boolean; // LIMIT 進場單還掛著（未成交也未取消）
  currentStop: { algoId: number; triggerPrice: number } | null;
  markPrice: number;
  filters: SymbolFilters;
  // 呼叫端傳入，函式內部絕不呼叫 Date.now()——維持這個檔案所有函式「同樣
  // 輸入永遠同樣輸出」，時間止損判斷才能在測試裡固定時間戳重現。
  now: number;
  // 只有在部位剛消失、呼叫端已經另外查過 getUserTrades() 時才會有值——不是
  // 每輪都要查，只在真的需要對帳（positionQty 從有變 0）那一刻才查。有給
  // 就能直接算出關單結果，沒給就退回單純標記需要處理。
  recentTrades?: UserTrade[];
  // 1小時 ATR(14期)，只有策略A的移動止損判斷需要。<= 0 或未提供都視為
  // 「還沒有 ATR 資料」，不會亂算——見 calcTrailingStopTarget。
  atr1h?: number;
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
  | { kind: 'cancel_stale_entry'; symbol: string; orderId: number; reason: string }
  | { kind: 'needs_reconcile'; reason: string }
  | { kind: 'sync_closed_position'; avgExitPrice: number; realizedPnl: number; result: 'WIN_TP1' | 'LOSS' }
  | { kind: 'place_initial_stop'; order: PlaceOrderParams }
  | { kind: 'place_tp1_order'; order: PlaceOrderParams }
  // 2026-08-12：closeReason 帶著「我們為什麼主動關這筆倉」的第一手事實
  // （時間止損/盤整停滯的哪一種），不是事後用出場價/損益猜的——執行層
  // 會把它先寫回 trades.close_reason，下一輪 sync_closed_position 對帳到
  // 真正關倉時直接採用，不用重新推斷。跟下面 sync_closed_position 註解
  // 說的「不猜」原則一致：這裡不是猜，是記錄我們自己剛做的決定。
  | { kind: 'close_full_position'; order: PlaceOrderParams; closeReason: TimeStopCloseReason }
  | { kind: 'update_trailing_stop'; place: PlaceOrderParams; cancelOrderId?: number }
  | { kind: 'entry_never_filled'; reason: string }
  | { kind: 'hold'; reason: string };

// 任何「本來要 hold」的情況，先檢查一次時間止損（盤整停滯／到期自動平倉）
// 才真的 hold——route.ts 這兩個機制是全局的，不分策略 A/B、不分是否已過
// TP1（isTp1Hit 只影響 decideTimeStop 內部走哪個分支），見 timeStop.ts。
// filledAt 是 null（理論上不該發生在這個檢查點——都已經有 currentStop
// 了，代表一定成交過）時直接 hold，不硬跑判斷。
function holdOrTimeStop(
  trade: BridgeTradeRow,
  snapshot: BridgeExchangeSnapshot,
  isTp1Hit: boolean,
  holdReason: string,
): TradeAction {
  if (trade.filledAt !== null) {
    const timeStop = decideTimeStop({
      isLong: trade.isLong, entry: trade.entry, stopLoss: trade.stopLoss,
      timeframe: trade.timeframe, filledAt: trade.filledAt, now: snapshot.now,
      markPrice: snapshot.markPrice, isTp1Hit, trailingStop: snapshot.currentStop?.triggerPrice ?? 0,
    });
    if (timeStop.fired) {
      const closeDecision = decideFullClose({
        tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong, positionQty: snapshot.positionQty,
      });
      if (!closeDecision.skip) {
        return { kind: 'close_full_position', order: closeDecision.order, closeReason: timeStop.closeReason };
      }
    }
  }
  return { kind: 'hold', reason: holdReason };
}

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

  // 2. 進場單已下，還沒成交（沒部位、單還掛著）。掛太久（規格 §3-A：
  // WAITING_EXPIRY_BARS=4 根該時框 K 線）就主動撤單，不要放著等它「碰巧」
  // 從交易所端消失——見檔案頂部 2026-08-11 說明，這是實測撞到的真實缺口。
  if (snapshot.positionQty === 0 && snapshot.entryOrderStillOpen) {
    const ageMinutes = (snapshot.now - trade.openedAt) / 60_000;
    const expiryMinutes = WAITING_EXPIRY_BARS * tfBarMinutes(trade.timeframe);
    if (ageMinutes >= expiryMinutes && trade.exchangeEntryOrderId !== null) {
      return {
        kind: 'cancel_stale_entry',
        symbol: trade.symbol,
        orderId: trade.exchangeEntryOrderId,
        reason: `掛單超過 ${WAITING_EXPIRY_BARS} 根 ${trade.timeframe} K 線未成交，主動撤單（規格 §3-A）`,
      };
    }
    return { kind: 'wait_for_fill', reason: '進場單尚未成交' };
  }

  // 3. 沒部位、進場單也不在了——不知道是被取消還是已經平倉完。如果呼叫端
  //    已經另外查過 getUserTrades() 並帶進 snapshot.recentTrades，直接算出
  //    結果；沒有的話只標記需要處理，不猜答案。
  if (snapshot.positionQty === 0 && !snapshot.entryOrderStillOpen) {
    const summary = snapshot.recentTrades ? summarizeClosingTrades(snapshot.recentTrades, trade.isLong) : null;
    if (summary) {
      // result 刻意只做「贏/輸」二元判斷（用真實 realizedPnl 正負號，不是
      // 猜的），不嘗試從均價反推 WIN_TP1 vs WIN_TP2 這種細分類——多筆分批
      // 出場（TP1 部分平倉 + 移動止損收尾）的加權均價無法可靠反推是哪個
      // 關卡觸發的，硬猜會把不確定的分類寫進正式統計，汙染之後的策略分析
      // （這正是 8/6 分析踩過的坑：tier 欄位用 `?? 'A'` 捏造出不存在的
      // 標籤）。WIN_TP1/LOSS 這兩個值 trades/page.tsx 的 isWin() 判斷式已
      // 經夠用（勝率計算只看 WIN_TP1||WIN_TP2 是不是其中之一），細分類
      // 之後有更完整的成交歷史記錄再補。
      return {
        kind: 'sync_closed_position',
        avgExitPrice: summary.avgExitPrice,
        realizedPnl: summary.totalRealizedPnl,
        result: summary.totalRealizedPnl >= 0 ? 'WIN_TP1' : 'LOSS',
      };
    }
    // 2026-08-09：recentTrades 是「查過、確認結果」跟「根本沒查」要分開看，
    // 之前混在一起都走 needs_reconcile 卡死——實測撞到 SOLUSDT：LIMIT
    // 進場單送出後在交易所端自己消失（過期/取消），從未真的成交過，
    // getUserTrades 查回來的自然是空陣列（不是查詢失敗，是真的沒有任何
    // 成交紀錄）。這種情況跟「曾經開倉、現在要對帳最終結果」是不同問題：
    // 根本沒開過倉，沒有損益可對帳，一直卡在 needs_reconcile 只會每輪
    // 白跑一次 getUserTrades。查過且明確是空陣列 → 判定為進場單從未成交，
    // 直接標記取消。呼叫端沒查（undefined）才是真的「還不知道」，維持
    // needs_reconcile 讓下一輪帶著 recentTrades 再來一次。
    if (snapshot.recentTrades && snapshot.recentTrades.length === 0) {
      return {
        kind: 'entry_never_filled',
        reason: '進場單消失但查無任何成交紀錄——判定從未真的成交，標記取消',
      };
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

  // 5. 有止損。TP1 是否已經發生——不再看條件單還在不在（消失可能是成交也
  // 可能是被拒絕/取消），而是比較目前部位跟進場當時的部位：真的變小了才算
  // 數。entryQty 是 null（理論上不會發生在這個檢查點——有止損代表一定成交
  // 過，live-runner 的自我修復會在確認成交當下順便記錄這個基準值）時保守
  // 視為「還沒發生」，不亂判斷。
  const tp1Happened = trade.entryQty !== null && snapshot.positionQty < trade.entryQty * 0.99;

  if (trade.strategy === 'B') {
    // 策略B沒有兩階段 TP，交給預掛的 TAKE_PROFIT_MARKET（quantity=全部部位+
    // reduceOnly，不是 closePosition——見 orderLifecycle.ts 的 -4130 說明）
    // 條件單觸發整單平倉——這裡只負責「還沒掛就補掛」，不用輪詢比價。
    if (trade.exchangeTp1AlgoId === null) {
      const tp1Decision = decideTp1OrderPlacement({
        tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong, strategy: 'B',
        positionQty: snapshot.positionQty, tp1: trade.tp1, filters: snapshot.filters,
      });
      if (tp1Decision.skip) return { kind: 'hold', reason: `TP1 條件單掛單跳過：${tp1Decision.reason}` };
      return { kind: 'place_tp1_order', order: tp1Decision.order };
    }
    // 策略B從不進入 tp1_hit 這種中間態（沒有兩階段 TP），isTp1Hit 固定傳 false。
    return holdOrTimeStop(trade, snapshot, false, '策略B持有中，等待止盈條件單觸發');
  }

  // 策略A，TP1 還沒發生：確保條件單掛著（第一次補掛，或者理論上異常消失後
  // 補掛一次），沒有動作就等交易所觸發。
  if (!tp1Happened) {
    if (trade.exchangeTp1AlgoId === null) {
      const tp1Decision = decideTp1OrderPlacement({
        tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong, strategy: 'A',
        positionQty: snapshot.positionQty, tp1: trade.tp1, filters: snapshot.filters,
      });
      if (tp1Decision.skip) return { kind: 'hold', reason: `TP1 條件單掛單跳過：${tp1Decision.reason}` };
      return { kind: 'place_tp1_order', order: tp1Decision.order };
    }

    // 2026-08-13（策略修改.md 修改1）：TP1 前保本保護。浮盈首次達
    // PRE_TP1_BREAKEVEN_TRIGGER_R 時把止損移到進場價——複用
    // decideTrailingStopReplace（本來是給 TP1 後棘輪用的單向棘輪決策），
    // 不用另外記「有沒有 arm 過」的狀態：它本身只往有利方向移動，已經
    // arm 過（現有止損 ≥ 進場價）時會自然回傳 'none'，冪等安全。
    const riskDist = Math.abs(trade.entry - trade.stopLoss);
    const favorableMoveR = riskDist > 0
      ? (trade.isLong ? snapshot.markPrice - trade.entry : trade.entry - snapshot.markPrice) / riskDist
      : 0;
    if (favorableMoveR >= PRE_TP1_BREAKEVEN_TRIGGER_R) {
      const breakevenDecision = decideTrailingStopReplace({
        tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
        currentStopOrder: { orderId: snapshot.currentStop.algoId, stopPrice: snapshot.currentStop.triggerPrice },
        desiredStopPrice: trade.entry, filters: snapshot.filters,
      });
      if (breakevenDecision.kind === 'replace') {
        return { kind: 'update_trailing_stop', place: breakevenDecision.place, cancelOrderId: breakevenDecision.cancelOrderId };
      }
    }

    return holdOrTimeStop(trade, snapshot, false, '持有中，等待 TP1 條件單觸發');
  }

  // 策略A：TP1 已經發生（部位比進場量小）→ 移動止損棘輪。沒有 ATR 資料就
  // 不亂動，維持現狀。
  if (snapshot.atr1h !== undefined && snapshot.atr1h > 0) {
    const target = calcTrailingStopTarget({
      isLong: trade.isLong, entry: trade.entry, tp1: trade.tp1, markPrice: snapshot.markPrice,
      atr1h: snapshot.atr1h, currentTrailingStop: snapshot.currentStop.triggerPrice,
    });
    const stopDecision = decideTrailingStopReplace({
      tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
      currentStopOrder: { orderId: snapshot.currentStop.algoId, stopPrice: snapshot.currentStop.triggerPrice },
      desiredStopPrice: target, filters: snapshot.filters,
    });
    if (stopDecision.kind === 'replace') {
      return { kind: 'update_trailing_stop', place: stopDecision.place, cancelOrderId: stopDecision.cancelOrderId };
    }
    // kind: 'none'（目標沒有比現有止損更有利）或 'initialize'（不會發生——
    // currentStopOrder 這裡一定非 null）都落到 hold，沒有動作可做。
    return holdOrTimeStop(trade, snapshot, true, '持有中（TP1 已達標，移動止損暫無更有利的目標價）');
  }

  return holdOrTimeStop(trade, snapshot, true, '持有中（TP1 已達標，等待 ATR 資料才能開始移動止損）');
}

// I/O 執行層——把 decideTradeAction 的決定真的送到交易所 + 寫回 DB。依賴
// 注入風格：TradeExecutorClient 是最小交易所介面，TradePersistence 是 DB
// 寫入的注入介面，測試可以用假的實作驗證每個分支呼叫了什麼，不用真的連
// 網路/連 Supabase。
//
// 這裡不做任何「該不該做」的判斷——那是 tradeBridge.ts 的職責。這一層只回答
// 「decideTradeAction 已經決定要做 X，怎麼安全地把 X 做完」。

import { PlaceOrderParams } from './binanceClient';
import { TradeAction } from './tradeBridge';

export interface TradeExecutorClient {
  placeOrder(params: PlaceOrderParams): Promise<{ orderId: number; clientOrderId: string; status: string }>;
  cancelOrder(symbol: string, orderId: number, isAlgoOrder?: boolean): Promise<{ orderId: number; status: string }>;
}

// 每個方法對應一種要寫回 Supabase trades 表的變化。呼叫端（live-runner）
// 提供真正碰資料庫的實作；這裡只保證「動作執行成功之後才呼叫對應的
// persist 方法」，執行失敗絕不會誤寫 DB 讓帳目跟交易所實際狀態脫鉤。
export interface TradePersistence {
  setEntryOrderId(tradeId: string, orderId: number): Promise<void>;
  setStopAlgoId(tradeId: string, algoId: number): Promise<void>;
  setTp1AlgoId(tradeId: string, algoId: number): Promise<void>;
  // 2026-08-10：TP1 改成預掛條件單後，「TP1 真的發生了」不再是某個 action
  // 執行完當下就知道的事——是下一輪自我修復偵測到部位變小才發現。呼叫點
  // 搬到 live-runner 主迴圈（跟 waiting→active 那個自我修復同一種模式），
  // 不在這個檔案裡了，介面留著給那邊用。
  markTp1Hit(tradeId: string): Promise<void>;
  finalizeClosed(tradeId: string, result: { result: 'WIN_TP1' | 'LOSS'; exitPrice: number; realizedPnl: number }): Promise<void>;
  // 進場單消失但查無任何成交紀錄——從未真的開過倉，沒有損益可對帳，跟
  // finalizeClosed（曾經開倉、現在要記最終結果）是不同語意，分開一個方法。
  markEntryNeverFilled(tradeId: string): Promise<void>;
  // 2026-08-10：實測撞到——decideTradeAction 從沒有一步把 DB 的 status 從
  // 'waiting' 改成 'active'，place_entry 只記 orderId，place_initial_stop
  // 只記 algoId，都沒動 status。結果單真的成交、止損也補上了，App 卻一直
  // 顯示「等待進場」。place_initial_stop 這個時刻本身就隱含「已經確認
  // 成交」（decideTradeAction 第 4 步只有 positionQty>0 才會走到），是
  // 標記 filled 最自然的地方。
  markFilled(tradeId: string, filledAt: number): Promise<void>;
  // 2026-08-10：TP1「是否已發生」判斷需要一個進場當時的部位量基準——這個
  // 基準值不是某個 action 執行完當下就一定拿得到（可能是舊資料、也可能
  // 首次確認成交那一刻順便記），呼叫點在 live-runner 主迴圈的自我修復，
  // 不在這個檔案裡。
  setEntryQty(tradeId: string, entryQty: number): Promise<void>;
}

export interface ExecutionResult {
  executed: boolean;
  note: string;
}

export async function executeTradeAction(
  client: TradeExecutorClient,
  persist: TradePersistence,
  tradeId: string,
  action: TradeAction,
): Promise<ExecutionResult> {
  switch (action.kind) {
    case 'place_entry': {
      const res = await client.placeOrder(action.order);
      await persist.setEntryOrderId(tradeId, res.orderId);
      return { executed: true, note: `進場單已送出 orderId=${res.orderId}` };
    }

    case 'place_initial_stop': {
      const res = await client.placeOrder(action.order);
      const filledAt = Date.now();
      // 這裡才第一次確認「真的成交了」（decideTradeAction 第 4 步只有
      // positionQty>0 才會走到這個分支）——filledAt 用發現的當下時間，不是
      // 真正成交那一刻，最大誤差是一個輪詢週期，可接受。
      await Promise.all([
        persist.setStopAlgoId(tradeId, res.orderId),
        persist.markFilled(tradeId, filledAt),
      ]);
      return { executed: true, note: `初始止損已送出 algoId=${res.orderId}` };
    }

    case 'place_tp1_order': {
      const res = await client.placeOrder(action.order);
      await persist.setTp1AlgoId(tradeId, res.orderId);
      return { executed: true, note: `TP1 條件單已送出 algoId=${res.orderId}` };
    }

    case 'close_full_position': {
      await client.placeOrder(action.order);
      // 不在這裡寫最終結果——MARKET 單的 ACK 回應不保證帶精確成交價，下一輪
      // decideTradeAction 會偵測到 positionQty=0，走 sync_closed_position
      // 那條用真實 getUserTrades 資料的路徑，比這裡猜測更可靠。
      return { executed: true, note: '整單平倉已送出（下一輪會對帳確認最終結果）' };
    }

    case 'update_trailing_stop': {
      // Place-before-cancel：跟 orderLifecycle.ts 的設計說明一致，新止損單
      // 送出成功後才撤舊單，避免中間出現無保護窗口。新單失敗就整個中止，
      // 不去動舊單——舊止損繼續保護部位。
      const res = await client.placeOrder(action.place);
      await persist.setStopAlgoId(tradeId, res.orderId);
      if (action.cancelOrderId !== undefined) {
        await client.cancelOrder(action.place.symbol, action.cancelOrderId, true);
      }
      return { executed: true, note: `移動止損已更新 → ${action.place.stopPrice}` };
    }

    case 'sync_closed_position': {
      await persist.finalizeClosed(tradeId, {
        result: action.result, exitPrice: action.avgExitPrice, realizedPnl: action.realizedPnl,
      });
      return { executed: true, note: `關單結果已同步：${action.result} @ ${action.avgExitPrice}（實現損益 ${action.realizedPnl}）` };
    }

    case 'entry_never_filled': {
      await persist.markEntryNeverFilled(tradeId);
      return { executed: true, note: action.reason };
    }

    // skip_entry / wait_for_fill / needs_reconcile / hold：沒有動作要執行，
    // reason 已經說明原因，呼叫端可以直接記錄下來，不用另外處理。
    default:
      return { executed: false, note: action.reason };
  }
}

// I/O 執行層——把 decideTradeAction 的決定真的送到交易所 + 寫回 DB。依賴
// 注入風格：TradeExecutorClient 是最小交易所介面，TradePersistence 是 DB
// 寫入的注入介面，測試可以用假的實作驗證每個分支呼叫了什麼，不用真的連
// 網路/連 Supabase。
//
// 這裡不做任何「該不該做」的判斷——那是 tradeBridge.ts 的職責。這一層只回答
// 「decideTradeAction 已經決定要做 X，怎麼安全地把 X 做完」。

import { PlaceOrderParams } from './binanceClient';
import { TradeAction } from './tradeBridge';
import { TimeStopCloseReason } from './timeStop';

export interface TradeExecutorClient {
  placeOrder(params: PlaceOrderParams): Promise<{ orderId: number; clientOrderId: string; status: string }>;
  // executedQty：撤掉部分成交的限價單時，撤掉的只是未成交的剩餘部分，已成交
  // 那部分是**真實部位**。cancel_stale_entry 一定要看這個，才不會把「撤單
  // 成功」誤讀成「從沒開過倉」。選填是為了不強迫既有測試替身全部改寫。
  cancelOrder(symbol: string, orderId: number, isAlgoOrder?: boolean):
    Promise<{ orderId: number; status: string; executedQty?: string }>;
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
  // 2026-08-12：我們自己主動送出 close_full_position（時間止損/盤整停滯）
  // 時，先把原因寫回 DB——下一輪部位真的歸零、sync_closed_position 對帳
  // 時直接讀這個當 close_reason，不用事後從出場價猜（deriveLiveCloseReason
  // 見 tradeBridge.ts 說明）。
  markForceCloseReason(tradeId: string, reason: TimeStopCloseReason): Promise<void>;
}

export interface ExecutionResult {
  executed: boolean;
  note: string;
  /**
   * 這筆 trade **還活著**，呼叫端不可以跑「已結束」的善後流程。
   *
   * 目前唯一會設的情況：`cancel_stale_entry` 撤掉的是一張**部分成交**的
   * 限價單——撤單成功但已成交那部分是真實部位。live-runner 對
   * cancel_stale_entry 會呼叫 cleanupAfterTradeClosed（撤殘留條件單 + 解
   * Redis symbol 鎖），對還開著的部位跑那個流程等於**把保護單撤掉**，
   * 比原本的 bug 更糟。
   */
  stillOpen?: boolean;
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
      // 那條用真實 getUserTrades 資料的路徑，比這裡猜測更可靠。但「為什麼
      // 關」這個事實現在就確定了，先記下來，等對帳那一刻直接採用。
      await persist.markForceCloseReason(tradeId, action.closeReason);
      return { executed: true, note: '整單平倉已送出（下一輪會對帳確認最終結果）' };
    }

    case 'update_trailing_stop': {
      // 2026-08-18 實測撞到（COTIUSDT 連續數小時卡在 -4130）：原本是
      // place-before-cancel（先掛新單成功才撤舊單，避免無保護窗口），但這個
      // 設計跟幣安的規則直接衝突——**同一個 symbol+方向只允許存在一張
      // closePosition 條件單**，舊止損還在的時候送新止損，幣安一律回
      // -4130「An open stop or take profit order with GTE and closePosition
      // in the direction is existing」。結果是移動止損/保本永遠執行不了，
      // 每輪重試、每輪被拒，止損從頭到尾停在原地。
      //
      // 只能改成 cancel-then-place。中間確實有一個極短的無保護窗口（兩個
      // API 呼叫之間），但這是幣安規則下唯一可行的順序；而且真的在中間失敗
      // 也有兜底：下一輪 decideTradeAction 第 4 步會看到 currentStop===null
      // 立刻補一張原始止損（place_initial_stop），15 秒內自動恢復保護，
      // 不需要人工介入。用「短暫窗口 + 自動補回」換「移動止損真的能動」，
      // 比現在這種「永遠動不了」安全得多。
      if (action.cancelOrderId !== undefined) {
        await client.cancelOrder(action.place.symbol, action.cancelOrderId, true);
      }
      const res = await client.placeOrder(action.place);
      await persist.setStopAlgoId(tradeId, res.orderId);
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

    case 'cancel_stale_entry': {
      // LIMIT 進場單掛太久沒成交，主動撤——isAlgoOrder=false，這是一般
      // /fapi/v1/order 端點的單，不是條件單（跟 place_initial_stop 用的
      // algoOrder 端點不一樣）。
      const res = await client.cancelOrder(action.symbol, action.orderId, false);

      // 2026-09-01：**撤單成功不等於從沒開過倉。**
      //
      // 限價單部分成交時狀態仍算 open（PARTIALLY_FILLED），所以掛滿 4 根
      // K 線一樣會走到這裡；撤掉的只是**未成交的剩餘部分**，已成交那部分
      // 是真實部位。原本這裡無條件 markEntryNeverFilled，結果實測撞到：
      // ARBUSDT 在幣安有 1,123.2 顆部位，App 顯示「真倉進場單過期未成交
      // （真實從未開倉）」——系統不知道它存在，就沒有任何東西在管它：
      // 不移動止損、不掛 TP1、不時間止損。比「記錯損益」嚴重得多。
      //
      // 不標記的話，這筆的 exchange_entry_order_id 還在、positionQty > 0，
      // 下一輪 decideTradeAction 會走「部位已存在」那條路補掛止損、恢復
      // 正常管理。所以正確處置就是**什麼都不寫**，讓下一輪接手。
      const executed = parseFloat(res.executedQty ?? '0');
      if (Number.isFinite(executed) && executed > 0) {
        return {
          executed: true,
          stillOpen: true, // 呼叫端不可跑「已結束」的善後（那會撤掉保護單）
          note: `${action.reason}｜⚠ 但該單已部分成交 ${executed}，實際有部位——`
            + `不標記為未成交、不做結束善後，下一輪會接手補掛止損`,
        };
      }

      await persist.markEntryNeverFilled(tradeId);
      return { executed: true, note: action.reason };
    }

    // skip_entry / wait_for_fill / needs_reconcile / hold：沒有動作要執行，
    // reason 已經說明原因，呼叫端可以直接記錄下來，不用另外處理。
    default:
      return { executed: false, note: action.reason };
  }
}

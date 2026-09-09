// 主決策函數：「這筆 Supabase 推薦單，現在該對交易所做什麼」。這是把之前
// 分別寫好、分別測過的積木串成一條真的會動的線的地方——runner.ts 執行
// 「怎麼做」，這裡決定「該做什麼」。
//
// 呼叫端（live-runner 的主迴圈）每輪對每筆開著的 trade row 呼叫一次這個
// 函數，餵進「DB 記的這筆單長怎樣」+「交易所上真實看到的快照」，拿回一個
// 動作決定。

import { PlaceOrderParams, UserTrade } from './binanceClient';
import { roundToStepSize, SymbolFilters } from './precision';
import {
  calcTrailingStopTarget, decideEntryOrder, decideFullClose,
  decideTp1OrderPlacement, decideTp2OrderPlacement, decideTrailingStopReplace,
} from './orderLifecycle';
import { checkLiquidationSafety, LiquidationPriceInput } from './liquidation';
import { decideTimeStop, tfBarMinutes, TimeStopCloseReason, TimeStopTimeframe } from './timeStop';
import { MAX_TOTAL_RISK_PCT } from '@/lib/position';
import { CloseReason, TP1_PARTIAL_FRACTION } from '@/lib/monitorMath';
import { evaluateDailyLossCap } from '@/lib/dailyLossCap';

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
  /**
   * 最終止盈價。2026-09-06 新增到這個型別——在此之前 `tp2` **從來沒有進過
   * 真倉決策路徑**，所以策略 A 的最終止盈實際上不存在（只有移動止損）。
   * 選填讓還沒帶這個欄位的呼叫端維持原行為。
   */
  tp2?: number | null;
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
  /**
   * TP2 條件單的 algoId。`null` = 還沒掛。
   *
   * 2026-09-06 新增。在此之前**策略 A 的 TP2 在真倉路徑從來沒被執行過**——
   * DB 模擬會在觸及 TP2 時平倉並記 WIN_TP2，真倉卻只有移動止損棘輪，價格
   * 穿過 TP2 什麼都不會發生。選填（`?`）是為了讓還沒跑 migration 的環境
   * 維持原行為而不是壞掉。
   */
  exchangeTp2AlgoId?: number | null;
  /**
   * 這筆存續期間看過的最有利價格（MFE，多單是最高價、空單是最低價）。
   * `null` = 還沒量測過。
   *
   * 2026-09-09 新增，給 `didTp1PartialFill` 當「價格到底有沒有到過 TP1」的
   * 證據——**沒到過 TP1 的價格，TP1 條件單就不可能成交**。這是必要條件，
   * 不是啟發式判斷。live-runner 每輪都在更新 `mfe_price`（單調不回頭），
   * 這裡只是把它接進決策層。
   */
  mfePrice?: number | null;
}

export interface BridgeExchangeSnapshot {
  positionQty: number;          // absolute value, 0 = flat
  /**
   * 帶正負號的部位量（正 = 多、負 = 空）。用來驗證「交易所實際的方向」跟
   * 這筆 trade 的 `isLong` 是否一致。
   *
   * 2026-09-06 新增。在此之前 live-runner 在建快照時就 `Math.abs()` 把符號
   * 丟掉了（`live-runner.ts:296`），**所以決策層從頭到尾沒有能力分辨多空**
   * ——它無條件相信 DB 的 `direction`。
   *
   * 實測後果：UNIUSDT 的 DB 紀錄是 `LONG / entry 6.1575 / qty 31`，幣安上
   * 卻是 `-39 @ 7.088`（空單）。程式照 DB 判定要掛 SELL 止損，但對空單而言
   * SELL 是加碼不是減倉，幣安以 `-4509 Time in Force (TIF) GTE can only be
   * used with open positions` 拒絕——**每 15 秒重試一次，永遠不會成功，而那
   * 個部位一張止損都沒有**。
   *
   * 選填：舊呼叫端不帶就跳過這道檢查，維持原行為。
   */
  positionQtySigned?: number;
  /**
   * 交易所端這個 symbol 目前掛著的條件單張數（止損 + 止盈，不分是誰掛的）。
   *
   * 只有「方向不符」那道判斷用得到：`0` 代表那個部位沒有任何自動化在保護它，
   * 才會觸發自動平倉。使用者手動掛的止損也算在內——手動開的倉如果自己有
   * 保護，系統不該去平它。
   *
   * 選填：不帶就是「不知道」，維持只停手不平倉的保守行為。
   */
  protectiveOrderCount?: number;
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
  /**
   * 這筆的 TP1 條件單此刻還掛在交易所上（`openAlgoOrders` 裡找得到
   * `exchangeTp1AlgoId`）。
   *
   * 2026-09-09 新增，給 `didTp1PartialFill` 用。**還掛著 = 一定沒成交**，
   * 這個方向的推論是嚴謹的；反過來「不見了 = 成交了」才是不嚴謹的那一半
   * （可能是被拒絕/取消），所以不見時仍然要靠其他證據。
   *
   * 選填：不帶就是「不知道」，退回舊行為（不擋）。
   */
  tp1OrderStillOpen?: boolean;
}

export interface RiskCheckInput {
  positionUSDT: number;      // calcPositionPlan 算好的名目倉位，呼叫端負責算
  totalOpenRiskPct: number;  // checkTotalOpenRisk 目前的加總（不含這筆）
  thisTradeRiskPct: number;  // 這筆要加的 suggested_risk_pct
  liquidation: Pick<LiquidationPriceInput, 'isolatedMarginUSDT' | 'maintMarginRatio' | 'maintAmount'>;
  // 日虧損上限（見 src/lib/dailyLossCap.ts）。兩個都是選填——沒帶就是不啟用
  // 這道關卡，既有呼叫端與測試不受影響。
  //
  // `dailyRealizedUsdt` 必須來自**交易所**的 income 流水，不能用我們的 trades
  // 表：2026-08-30 對帳證明 DB 記的損益有統計顯著的系統性偏誤（z=2.91）。
  // 帶 `null` 表示查不到——**設了上限卻查不到會擋單（fail-closed）**，那是
  // 刻意的，理由見 dailyLossCap.ts 檔頭。
  dailyRealizedUsdt?: number | null;
  dailyLossCapUsdt?: number | null;
  /**
   * 「現在整體停止開新倉」的原因；`null`/`undefined` = 沒有停機。
   *
   * 2026-09-06：回撤停機原本**只存在於 route.ts（產生訊號那側）**，
   * live-runner（實際下單那側）完全沒有。訊號在停機之前產生、停機之後才輪到
   * live-runner 處理的話，那筆單照樣會被送出去——而排隊窗口實測可達三天
   * （UNIUSDT `opened_at 09-01 07:34` / `filled_at 09-04 04:02`）。
   *
   * 系統已經判定「策略可能失效要停」，卻還在把先前排隊的單送出去。
   * kill switch 早就做對了（live-runner 側 fail-closed 整輪跳過），這裡比照。
   *
   * 只擋新倉，既有部位不受影響——它們的止損還掛在交易所上。
   */
  haltedReason?: string | null;
}

// 2026-08-20：全局風險額度加總——**只算真的送到交易所的單**。
//
// 實測撞到死結：live-runner 原本把所有 closed_at IS NULL 的列全部加總，包含
// 「從沒送出過訂單」的 waiting 推薦單。實際發生：HYPE 1.5 + BNB 1.5 + ZEC 1.5
// + ETH 1.0 = 5.5 > 上限 5，於是每一筆算自己的時候都是「其他三筆＋自己＝5.5」
// → 四筆全部 skip_entry → 沒有任何一筆送得出去 → 沒送出就永遠不會成交、不會
// 平倉 → 這個 5.5 永遠不會降下來。四張單互相擋住對方，系統零下單卡死。
//
// 錯在把「推薦單」當成「持倉」。沒送出去的單在交易所端沒有訂單、沒有佔用
// 保證金、沒有任何曝險，不該吃風險額度。有掛單的（exchange_entry_order_id
// 不是 null）就算還沒成交也**要**算——限價單在幣安端已經佔住保證金，成交後
// 就是真部位。
//
// 純函數 + 測試：CLAUDE.md 的教訓「純數值/記帳邏輯務必抽成獨立檔配測試」，
// tsc/build 對這種數值錯誤是啞的（這個 bug 本身就是活生生的例子）。
export interface OpenRiskRow {
  exchangeEntryOrderId: number | null;
  suggestedRiskPct: number | null;
}

export function calcTotalOpenRisk(rows: OpenRiskRow[]): number {
  return rows
    .filter(r => r.exchangeEntryOrderId !== null)
    .reduce((sum, r) => sum + (r.suggestedRiskPct ?? 1), 0);
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
  | { kind: 'place_tp2_order'; order: PlaceOrderParams }
  // 2026-08-12：closeReason 帶著「我們為什麼主動關這筆倉」的第一手事實
  // （時間止損/盤整停滯的哪一種），不是事後用出場價/損益猜的——執行層
  // 會把它先寫回 trades.close_reason，下一輪 sync_closed_position 對帳到
  // 真正關倉時直接採用，不用重新推斷。跟下面 sync_closed_position 註解
  // 說的「不猜」原則一致：這裡不是猜，是記錄我們自己剛做的決定。
  | {
      kind: 'close_full_position';
      order: PlaceOrderParams;
      closeReason: TimeStopCloseReason;
      /**
       * 送出平倉單**之前**要先撤掉的保護性條件單（止損／TP1／TP2 的 algoId）。
       *
       * 2026-09-09：UNIUSDT trade-1788833416973-drr88——部位 75 張，時間止損
       * 送出的 reduceOnly MARKET 平倉單 quantity 就是 75（`positionQty` 沒
       * 算錯，推導見 tradeExecutor.ts 該分支），幣安卻只成交 34 張、`origQty`
       * 也記成 34，剩下 41 張沒有任何東西知道。送出當下掛著兩張 2026-09-06
       * 改成 `quantity + reduceOnly` 型式的條件單（TP1 37 張 + 止損 75 張），
       * 而 reduceOnly 單會佔用帳戶的「可平額度」——同一個部位後來每一張止損
       * 觸發時都被幣安以 `rejectReason: "Reduce only reject"` 打回，證明這個
       * 額度制存在而且會咬人。
       *
       * `closePosition=true` 的舊式條件單不佔額度，所以 09-06 之前這條路徑
       * 從沒出過事：08-25~09-08 共 9 張整單平倉單，數量對不上的只有 UNI 這
       * 一張，而它也是唯一一張「送出時還有 quantity+reduceOnly 條件單掛著」的。
       */
      cancelAlgoIds: number[];
      /** 殘留部位補平時的數量取整基準（同 `snapshot.filters.stepSize`）。 */
      stepSize: number;
    }
  | { kind: 'update_trailing_stop'; place: PlaceOrderParams; cancelOrderId?: number }
  | { kind: 'entry_never_filled'; reason: string }
  /**
   * 交易所上有一個「方向跟 DB 相反、而且完全沒有保護單」的部位——把它市價平掉。
   *
   * 2026-09-06 事故的補救動作，形狀見 decideTradeAction 第 0 步的註解。
   * 這是唯一一個「對著我們自己不認得的部位」下單的動作，所以下單參數刻意
   * 只用快照裡交易所自己回報的數字（方向、數量），完全不參考 DB。
   */
  | { kind: 'flatten_unmanaged_position'; order: PlaceOrderParams; reason: string }
  | { kind: 'hold'; reason: string };

// 「TP1 的部分停利到底發生了沒有」——不看條件單還在不在（消失可能是成交，
// 也可能是被拒絕/取消），而是比較目前部位與進場當時的部位。
//
// 上界 99%：留給滑價與取整的雜訊，沒真的變小就不算數。
//
// 下界 25%（＝期望殘量 50% 的一半）是 2026-09-08 補的。原本只有上界，於是
// 「部位變小」被無條件當成 TP1，而部位變小的原因不只 TP1：
//
//   SOLUSDT trade-1788765628400-wb2hq — 保本止損觸發時 16.24 張只平掉 16.23
//   （roundToStepSize 的浮點誤差，已在 precision.ts 修掉），剩 0.01 張灰塵。
//   那 0.06% 的殘渣讓系統判定「TP1 發生了」：DB 標成 tp1_hit、推播一則假的
//   「TP1 已達標」（該筆價格最高只到 +1.07R，TP1 在 2R）、卡片顯示「建議把
//   止損移到成本」，那 0.01 張再帶著止損跑了 13 小時，最後把一筆保本出場
//   記成完整 −1R 的 LOSS。
//
// 同樣形狀的還有：使用者用手機 App 手動平掉一部分（這個帳戶的 `ios_*`
// clientOrderId）、ADL、部分強平。這些都不該把系統推進「TP1 後只剩棘輪
// 保護、不再減倉」的狀態機。
//
// 為什麼下界不設更高（例如 40%）：TP1 平的是「當下部位」的 50%，成交價與
// stepSize 取整都會讓殘量偏離 50% 幾個百分點，門檻貼太近會反過來把真的
// TP1 判成沒發生——那會讓系統重新掛一次 TP1 條件單，再平一次 50%，部位
// 剩 25%。25% 離兩邊都夠遠。
//
// entryQty 是 null（舊資料，或還沒記過基準量）時保守回 false，不猜。
//
// ── 2026-09-09：光看數量永遠不夠，要有「TP1 真的成交了」的證據 ──────────────
//
// 上面那組上下界擋掉了灰塵（<25%），但擋不掉「部位剛好少了一半左右、而原因
// 不是 TP1」——那正是這個判準最容易誤判、後果也最嚴重的區間：
//
//   UNIUSDT trade-1788833416973-drr88 — 進場 75 張，時間止損（time_stop_stall）
//   的整單平倉只平掉 34 張，剩 41 張（54.7%）。價格當時最高只到 7.196，TP1 在
//   7.3724（+1.12R vs 2R）——**從來沒碰過**。但 41/75 落在 25%~99% 正中間，
//   數量判準判 true：DB 標成 tp1_hit、推播一則假的「🎯 TP1 達標」、卡片顯示
//   「TP1 已達標，建議把止損移到成本」。
//
// 數量只能說「部位變小了」，說不出「為什麼變小」。所以再要求兩個**必要條件**，
// 兩個都是「不成立就一定不是 TP1」的方向，不是加權猜測：
//
//   1. tp1OrderStillOpen — TP1 條件單此刻還掛在交易所上 ⇒ 它一定還沒成交。
//      注意這裡只用**單向**推論：「還掛著 = 沒成交」嚴謹，「不見了 = 成交了」
//      不嚴謹（可能被拒絕/取消），所以不見時不當成證據，還要看第 2 條。
//      這就是 2026-08-10 把判準從「看條件單在不在」改成「比部位大小」時
//      放棄的那半個資訊——當時連同能用的那一半一起丟掉了。
//
//   2. reachedTp1 — 價格（MFE，單調不回頭）到過 TP1。沒到過 TP1 的價格，
//      掛在 TP1 的條件單不可能觸發。
//
// 證據缺席（undefined）時一律當「不成立」，跟 entryQty=null 同一個方向：
// 寧可漏判 TP1（後果是少了移動止損棘輪），也不要捏造 TP1（後果是假推播、
// 假紀錄，而且會把這筆單推進「只剩棘輪保護、不再減倉」的狀態機）。
export const TP1_REMNANT_MIN_RATIO = (1 - TP1_PARTIAL_FRACTION) / 2;

export interface Tp1FillEvidence {
  entryQty: number | null;
  positionQty: number;
  /** TP1 條件單還掛在交易所上。undefined = 不知道，一律當「沒有證據」。 */
  tp1OrderStillOpen?: boolean;
  /** 這筆看過的最有利價（MFE）。undefined/null = 還沒量測過。 */
  mfePrice?: number | null;
  /** 這一輪的標記價——MFE 還沒被這輪更新到，這裡自己併進去。 */
  markPrice: number;
  tp1: number;
  isLong: boolean;
}

/** 價格到過 TP1 了嗎（多單看最高、空單看最低，MFE 與本輪標記價取較有利者）。 */
export function priceReachedTp1(ev: Pick<Tp1FillEvidence, 'mfePrice' | 'markPrice' | 'tp1' | 'isLong'>): boolean {
  const best = ev.isLong
    ? Math.max(ev.mfePrice ?? -Infinity, ev.markPrice)
    : Math.min(ev.mfePrice ?? Infinity, ev.markPrice);
  return ev.isLong ? best >= ev.tp1 : best <= ev.tp1;
}

export function didTp1PartialFill(ev: Tp1FillEvidence): boolean {
  if (ev.tp1OrderStillOpen !== false) return false;   // 還掛著、或不知道 → 沒成交
  if (!priceReachedTp1(ev)) return false;             // 價格沒到過 TP1 → 不可能觸發
  if (ev.entryQty === null || ev.entryQty <= 0) return false;
  if (ev.positionQty >= ev.entryQty * 0.99) return false;
  return ev.positionQty >= ev.entryQty * TP1_REMNANT_MIN_RATIO;
}

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
        return {
          kind: 'close_full_position',
          order: closeDecision.order,
          closeReason: timeStop.closeReason,
          // 這筆單自己掛出去的保護性條件單。它們是 reduceOnly，會佔用可平
          // 額度，平倉單送出前要先撤掉（見 TradeAction.cancelAlgoIds）。
          // 反正這筆單正要結束，這些條件單留著也只會變成孤兒。
          cancelAlgoIds: [
            snapshot.currentStop?.algoId,
            trade.exchangeTp1AlgoId,
            trade.exchangeTp2AlgoId,
          ].filter((id, i, all): id is number => typeof id === 'number' && all.indexOf(id) === i),
          stepSize: snapshot.filters.stepSize,
        };
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
  // 0. 交易所實際的方向跟這筆 trade 的方向不一致 —— 什麼都不要做。
  //
  // 2026-09-06 實測撞到：UNIUSDT 的 DB 紀錄是 `LONG / entry 6.1575 / qty 31`，
  // 幣安上卻是 `-39 @ 7.088`（空單）。程式照 DB 判定要掛 SELL 止損，但對空單
  // 而言 SELL 是加碼不是減倉，幣安以 `-4509 Time in Force (TIF) GTE can only
  // be used with open positions` 拒絕——每 15 秒重試一次、永遠不會成功，而那
  // 個部位**一張止損都沒有**。
  //
  // 為什麼之前偵測不到：live-runner 建快照時就 `Math.abs()` 把符號丟掉了，
  // 決策層根本沒有能力分辨多空，只能無條件相信 DB。
  //
  // **不照 DB 的方向繼續下單**——那是原本的 bug。但「停手」不等於「放著」：
  //
  // 2026-09-06 第一版只回 hold，結果那個 -39 的空單裸奔了十個小時，直到人工
  // 發現才平掉。停手的理由（在認知錯誤的狀態下送市價單更危險，可能平掉不該
  // 平的）只對「還有人在管那個部位」的情況成立。
  //
  // 所以判準收窄成兩個條件同時成立才自動平倉：
  //   (a) 交易所部位方向與 DB 相反，且
  //   (b) 交易所端**一張保護單都沒有**（protectiveOrderCount === 0）
  //
  // (b) 是為了保護使用者的手動交易：這個帳戶的使用者會用手機 App 直接下單
  // （UNI 那批 `ios_*` clientOrderId 就是），手動開的倉如果自己掛了止損，
  // 系統不該把它平掉。沒有任何保護單的反向部位才是真的沒人管。
  //
  // 平倉單用 `reduceOnly` + 「與交易所實際部位相反」的方向——不是 DB 的方向。
  // 照 DB 方向送就是加碼，那正是 -4509 那個 bug 的形狀。reduceOnly 讓它在
  // 原理上只能減倉，不可能反向開倉。
  //
  // 沒帶 protectiveOrderCount 的呼叫端（舊版、其他測試）維持只停手——這種
  // 等級的動作不該因為少傳一個欄位就默默啟用。
  if (snapshot.positionQtySigned != null && snapshot.positionQtySigned !== 0) {
    const exchangeIsLong = snapshot.positionQtySigned > 0;
    if (exchangeIsLong !== trade.isLong) {
      const detail = `DB 記 ${trade.isLong ? 'LONG' : 'SHORT'}（entry ${trade.entry}、`
        + `qty ${trade.entryQty ?? '?'}），交易所實際部位 ${snapshot.positionQtySigned}`;
      const flattenQty = roundToStepSize(Math.abs(snapshot.positionQtySigned), snapshot.filters.stepSize);

      if (snapshot.protectiveOrderCount === 0 && flattenQty > 0) {
        return {
          kind: 'flatten_unmanaged_position',
          order: {
            symbol: trade.symbol,
            side: exchangeIsLong ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: flattenQty,
            reduceOnly: true,
            newClientOrderId: `${trade.id}-unmanaged`,
          },
          reason: `⚠ 方向不符且沒有任何保護單：${detail}。`
            + ` 那個部位沒有人在管，自動市價平掉（reduceOnly ${flattenQty} 張）。`,
        };
      }

      return {
        kind: 'hold',
        reason: `⚠ 方向不符：${detail}。`
          + (snapshot.protectiveOrderCount === 0
            ? ` 部位量在 stepSize ${snapshot.filters.stepSize} 下取整為 0，連平倉單都送不出去。`
            : ` 交易所端還有 ${snapshot.protectiveOrderCount ?? '未知數量的'} 張保護單，不去碰它。`)
          + ` 停止對這筆下任何單——在認知錯誤的狀態下送單會更危險。需要人工確認。`,
      };
    }
  }

  // 1. 還沒真的在交易所下過進場單。
  if (trade.exchangeEntryOrderId === null) {
    // 整體停機（回撤／熔斷）擋在最前面：它的語意是「現在不該開任何新倉」，
    // 比任何單筆層級的檢查都優先。訊號可能在停機**之前**就產生了，所以這道
    // 一定要在執行端再問一次，不能只靠產生端擋。
    if (risk.haltedReason) {
      return { kind: 'skip_entry', reason: risk.haltedReason };
    }

    // 日虧損上限次之——它是用「錢」衡量的最後一道防線，其餘上限都是 R 或
    // 百分比，而 R 的分母（止損距離）會隨波動浮動，R 上限不等於金額上限。
    const dailyCap = evaluateDailyLossCap({
      realizedUsdt: risk.dailyRealizedUsdt ?? null,
      capUsdt: risk.dailyLossCapUsdt,
    });
    if (dailyCap.blocked) {
      return { kind: 'skip_entry', reason: dailyCap.reason ?? '日虧損上限' };
    }

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
      currentStopOrder: null, desiredStopPrice: trade.stopLoss,
      positionQty: snapshot.positionQty, filters: snapshot.filters,
    });
    if (stopDecision.kind === 'initialize') {
      return { kind: 'place_initial_stop', order: stopDecision.place };
    }
    // currentStopOrder: null 之下只可能是 'initialize' 或 'none'（部位小到
    // stepSize 取整為 0，掛不出合法數量）。後者沒有動作可做，如實回報原因。
    return {
      kind: 'hold',
      reason: stopDecision.kind === 'none' ? `補止損跳過：${stopDecision.reason}` : '補止損決策回傳非預期結果',
    };
  }

  // 5. 有止損。TP1 是否已經發生——判準見 didTp1PartialFill。
  const tp1Happened = didTp1PartialFill({
    entryQty: trade.entryQty, positionQty: snapshot.positionQty,
    tp1OrderStillOpen: snapshot.tp1OrderStillOpen,
    mfePrice: trade.mfePrice, markPrice: snapshot.markPrice,
    tp1: trade.tp1, isLong: trade.isLong,
  });

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
        desiredStopPrice: trade.entry,
        positionQty: snapshot.positionQty, filters: snapshot.filters,
      });
      if (breakevenDecision.kind === 'replace') {
        return { kind: 'update_trailing_stop', place: breakevenDecision.place, cancelOrderId: breakevenDecision.cancelOrderId };
      }
    }

    return holdOrTimeStop(trade, snapshot, false, '持有中，等待 TP1 條件單觸發');
  }

  // 策略A：TP1 已經發生（部位比進場量小）。
  //
  // 2026-09-06：先補掛 TP2 條件單。在此之前這裡直接跳到移動止損棘輪，
  // **TP2 從來沒有被執行過**——DB 模擬會在觸及 TP2 時平倉記 WIN_TP2，真倉
  // 只有移動止損，價格穿過 TP2 什麼都不會發生（使用者實測：「打到最終 TP
  // 卻沒有止盈，而且雲端機器完全沒有那筆的 log」——沒有 log 是因為決策回
  // 傳 hold，live-runner 只在 executed 為 true 時才印）。
  //
  // 排在移動止損之前：兩者不衝突（TP2 是 reduceOnly+quantity，移動止損是
  // closePosition），但先把最終出場掛上去比較安全——移動止損每輪都可能改，
  // 而 TP2 只需要掛一次。
  if (trade.exchangeTp2AlgoId == null && trade.tp2 != null) {
    const tp2Decision = decideTp2OrderPlacement({
      tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
      positionQty: snapshot.positionQty, tp2: trade.tp2, filters: snapshot.filters,
    });
    if (!tp2Decision.skip) {
      return { kind: 'place_tp2_order', order: tp2Decision.order };
    }
    // skip 不 return——掛不上 TP2（部位太小之類）時仍然要讓移動止損接手，
    // 不能因此整筆卡住不管理。
  }

  // 移動止損棘輪。沒有 ATR 資料就不亂動，維持現狀。
  if (snapshot.atr1h !== undefined && snapshot.atr1h > 0) {
    const target = calcTrailingStopTarget({
      isLong: trade.isLong, entry: trade.entry, tp1: trade.tp1, markPrice: snapshot.markPrice,
      atr1h: snapshot.atr1h, currentTrailingStop: snapshot.currentStop.triggerPrice,
    });
    const stopDecision = decideTrailingStopReplace({
      tradeId: trade.id, symbol: trade.symbol, isLong: trade.isLong,
      currentStopOrder: { orderId: snapshot.currentStop.algoId, stopPrice: snapshot.currentStop.triggerPrice },
      desiredStopPrice: target,
      positionQty: snapshot.positionQty, filters: snapshot.filters,
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

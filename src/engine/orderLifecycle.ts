// Pure decision functions for the two most dangerous state transitions in
// automated execution: partially closing a position at TP1, and moving a
// trailing stop. Both mirror behavior that already exists in api/analyze/route.ts
// (candle-scan based, DB-only) — this module answers the same questions but in
// terms of "what order do I send to the exchange", for the not-yet-built runner.
//
// Nothing here calls BinanceFuturesClient. Callers execute the returned actions
// and are responsible for error handling, retries, and watchdog reconciliation.
// Keeping this pure means the ordering logic (which action goes first) can be
// tested without mocking network calls — see docs/ANALYSIS-2026-08-06-自動交易缺口清單.md
// §三 #6/#9 for the behavior this replicates and why it's risky.

import { PlaceOrderParams } from './binanceClient';
import { SymbolFilters, roundToStepSize, roundToTickSize } from './precision';
import { TP1_PARTIAL_FRACTION } from '@/lib/monitorMath';

// 2026-08-17：幣安 clientOrderId 上限 36 字元。tradeId 固定 25 字元
// （route.ts `trade-${Date.now()}-${...}`），decideTrailingStopReplace 原本
// 直接把價格數字接在後面（`-sl-${roundedTarget}`）——高價幣（BTC「65100」
// 5碼）平常夠用，但低價幣要更多小數位才能表示 tick size（COTIUSDT
// 「0.010842」8碼），偶爾還會冒出 JS 浮點誤差位數，實測撞到 -4015
// Client order id length should be less than 36 chars：這筆單的止損單因此
// 永遠掛不出去，部位卡在裸奔（watchdog 回報 position_without_stop）。
// 改成把價格編碼成固定 6 碼雜湊，長度不再隨幣價精度變動，同時保留「同一個
// 目標價 → 同一個 ID」這個冪等性質（雜湊本身也是純函數、確定性的）。
function hashPrice(price: number): string {
  // FNV-1a 32-bit，純函數、無外部依賴。36^6 (約21.8億) < 2^32 (約42.9億)，
  // 32-bit 雜湊值直接轉 base36 有時會冒出 7 碼——先 mod 36^6 再轉，
  // 才能保證輸出「恰好」6 碼，不是「至少」6 碼（padStart 只補短不截長）。
  let h = 0x811c9dc5;
  const s = String(price);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % Math.pow(36, 6)).toString(36).padStart(6, '0');
}

// ── Entry order ─────────────────────────────────────────────────────────────
//
// The one piece of "訊號 → 真的開倉" that didn't exist anywhere yet. Everything
// else in this file assumes a position already exists on the exchange; this is
// what creates the first order. positionUSDT comes from calcPositionPlan
// (src/lib/position.ts) — same formula the App already shows the user, not a
// second one invented here (CLAUDE.md: 倉位計畫...勿另寫倉位公式).
//
// Deliberately does NOT place the paired stop here — see the module doc at the
// top of this file and docs/ANALYSIS-2026-08-06-自動交易缺口清單.md: the stop
// can only be sized correctly once the entry is CONFIRMED filled (exact filled
// qty, not the requested qty — a partial fill needs a smaller stop). The
// initial stop is decideTrailingStopReplace() called with currentStopOrder:
// null once the caller observes the position appear on positionRisk — that
// function's 'initialize' branch already does exactly this, no new function
// needed for it.

export interface EntryOrderInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  entry: number;
  positionUSDT: number;   // caller has already run calcPositionPlan and decided this isn't belowMinNotional
  filters: SymbolFilters;
}

export type EntryOrderDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams; quantity: number };

export function decideEntryOrder(input: EntryOrderInput): EntryOrderDecision {
  if (input.entry <= 0) {
    return { skip: true, reason: `entry ${input.entry} 無效（必須 > 0）` };
  }
  if (input.positionUSDT <= 0) {
    return { skip: true, reason: `positionUSDT ${input.positionUSDT} 無效（必須 > 0）` };
  }

  const rawQty = input.positionUSDT / input.entry;
  const quantity = roundToStepSize(rawQty, input.filters.stepSize);
  if (quantity <= 0) {
    return {
      skip: true,
      reason: `倉位 ${input.positionUSDT}U 換算數量後在 stepSize ${input.filters.stepSize} 下取整為 0，太小無法下單`,
    };
  }

  const notional = quantity * input.entry;
  if (notional < input.filters.minNotional) {
    return {
      skip: true,
      reason: `取整後名目倉位 ${notional.toFixed(2)}U 低於交易所最低 ${input.filters.minNotional}U`,
    };
  }

  return {
    skip: false,
    quantity,
    order: {
      symbol: input.symbol,
      side: input.isLong ? 'BUY' : 'SELL',
      type: 'LIMIT',
      quantity,
      price: roundToTickSize(input.entry, input.filters.tickSize),
      timeInForce: 'GTC',
      // Deterministic per trade — a re-run against the same tradeId (e.g. the
      // caller retries after a network timeout without knowing if the first
      // attempt landed) collapses to the same order and gets rejected as a
      // duplicate (-4015) instead of opening a second, unintended position.
      newClientOrderId: `${input.tradeId}-entry`,
    },
  };
}

// ── TP1 order placement ─────────────────────────────────────────────────────
//
// 2026-08-10：原本是「輪詢式」——每輪比較 markPrice 跟 tp1，觸價才即時送
// MARKET 單。使用者實測發現的真實風險：兩輪之間（15秒）如果價格插針式碰到
// tp1 又馬上彈回去，下一輪 markPrice 已經不在 tp1 之上，永遠不會再觸發，
// TP1 部分平倉的機會就真的錯過了。止損能預掛條件單靠交易所盤口即時觸發、
// 不怕這種插針，止盈沒道理不能一樣處理。
//
// 改成「預掛式」：一有止損就順便掛一張 TAKE_PROFIT_MARKET 條件單在交易所，
// 讓交易所自己的撮合引擎觸發，不再依賴 live-runner 剛好在那個瞬間醒著輪詢。
// 策略A（分兩階段）用 quantity 指定一半數量 + reduceOnly（不能用
// closePosition=true，那個只能整倉，做不到「平一半」）。
//
// 策略B（tp1==tp2，觸價即整單了結）原本也用 closePosition=true，跟止損
// 那張條件單同樣模式——2026-08-18 發現這是錯的：幣安不允許同一個
// symbol+方向同時存在兩張 closePosition=true 的條件單（-4130「An open
// stop or take profit order with GTE and closePosition in the direction is
// existing」），而 decideTrailingStopReplace() 的止損單一定先掛（見
// tradeBridge.ts 第4步「有部位但沒止損」優先於第5步 TP1）。所以策略B的
// TP1 這張永遠是「第二張」，永遠被拒絕，且 newClientOrderId 冪等，重試
// 也只會撞回同一個 -4130，live-runner 的 -4130 自我修復只能撿回「幣安端
// 真的存在」的 algoId，這張從未成功建立，撿不回來——策略B部位事實上
// 從來沒有掛出過 TP1 條件單，只靠止損跟 time-stop 出場。改成跟策略A同一種
// quantity + reduceOnly 模式（quantity 是全部部位，不是一半），不再跟止損
// 用 closePosition 互斥。
//
// 2026-09-06 後記：止損單自己也改用 quantity + reduceOnly 了（見
// decideTrailingStopReplace 上方的 UNI 翻倉事故說明），所以 -4130 這個互斥
// 問題在整條路徑上都不再存在。這段保留是因為它記錄了「為什麼策略B的 TP1
// 曾經整整一段時間沒掛出去」，那個教訓還有效。
//
// reduceOnly 用量的取捨：closePosition=true 部位平掉時交易所會自動連帶
// 取消該單；reduceOnly 的固定數量單不會，部位已經靠止損出場的話這張 TP1
// 會變成孤兒單留在交易所——但這已經被 live-runner 的帳戶級對帳
// （getOpenAlgoOrders 全帳戶掃描）自動偵測並取消，不是新風險。
//
// 呼叫端（tradeBridge.ts）判斷「TP1 是否已經發生」不再看這張條件單還在不
// 在（消失可能是成交、也可能是被拒絕/取消，無法單靠這個區分），而是比較
// snapshot.positionQty 跟 trade.entryQty——部位真的變小了才算數，這樣不管
// 這張條件單的下場如何都能收斂到正確狀態。

export interface Tp1OrderInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  strategy: 'A' | 'B';
  positionQty: number;      // absolute filled quantity currently open (from positionRisk, always positive)
  tp1: number;
  filters: SymbolFilters;
}

export type Tp1OrderDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams };

export function decideTp1OrderPlacement(input: Tp1OrderInput): Tp1OrderDecision {
  if (input.positionQty <= 0) {
    return { skip: true, reason: 'positionQty <= 0 — 沒有可平的部位（可能已經平倉，避免對空部位下單）' };
  }

  const stopPrice = roundToTickSize(input.tp1, input.filters.tickSize);
  const side = input.isLong ? 'SELL' : 'BUY';

  if (input.strategy === 'B') {
    // 策略B沒有兩階段 TP，觸價即整單了結——用 quantity（全部部位）+
    // reduceOnly，跟策略A的部分平倉走同一種下單模式，只是數量是全部。
    // 原因有兩層：早期是 -4130 互斥（見上方模組註解），2026-09-06 之後更根本
    // ——closePosition 的數量由交易所決定，而它算錯過（見
    // decideTrailingStopReplace 上方的 UNI 翻倉事故）。
    const fullQty = roundToStepSize(input.positionQty, input.filters.stepSize);
    if (fullQty <= 0) {
      return {
        skip: true,
        reason: `部位量 ${input.positionQty} 在 stepSize ${input.filters.stepSize} 下取整為 0，太小無法下 TP1 單`,
      };
    }
    return {
      skip: false,
      order: {
        symbol: input.symbol,
        side,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice,
        quantity: fullQty,
        reduceOnly: true,
        // 每筆 trade 只掛一次 TP1 條件單，冪等 ID 避免重試造成重複掛單。
        newClientOrderId: `${input.tradeId}-tp1order`,
      },
    };
  }

  // Floor, not round — closing slightly less than 50% is safe (the other half's
  // final-exit R absorbs the difference); closing MORE than the position holds
  // is a hard reject from Binance (-2022 ReduceOnly Order is rejected) at best,
  // or in a hedge-mode edge case, opens an unintended opposite position.
  const closeQty = roundToStepSize(input.positionQty * TP1_PARTIAL_FRACTION, input.filters.stepSize);
  if (closeQty <= 0) {
    return {
      skip: true,
      reason: `部位量 ${input.positionQty} × ${TP1_PARTIAL_FRACTION} 取整後為 0（stepSize ${input.filters.stepSize} 對這個部位太粗）— 跳過 TP1 條件單，留給移動止損處理全部`,
    };
  }

  return {
    skip: false,
    order: {
      symbol: input.symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice,
      quantity: closeQty,
      reduceOnly: true,
      newClientOrderId: `${input.tradeId}-tp1order`,
    },
  };
}

// ── TP2 conditional order（TP1 之後掛，把剩下的部位了結）────────────────────
//
// 2026-09-06：**策略 A 的 TP2 在真倉路徑從來沒被執行過。** 兩條路徑對「最終
// 止盈」的定義不一致：
//
//   DB 模擬（route.ts / walkTpSl）  價格觸及 TP2 → 平倉，result='WIN_TP2'
//   live-runner（真倉）             TP2 從不檢查，TP1 之後只有移動止損棘輪
//
// `tp2` 在整個 src/engine/ 只出現過一次，還只是策略 B 的 close-reason 標籤；
// `calcTrailingStopTarget` 也沒有任何 TP2 上限，它無限跟著價格跑。
//
// 使用者實測回報：「打到最終 TP 卻沒有止盈，網站上寫超過多少，但雲端機器
// 那筆完全沒有 log」。沒有 log 是因為決策回傳 `hold`——live-runner 只在
// `result.executed` 為 true 時才印，hold 完全靜默。
//
// 修法比照 TP1：**預掛在交易所**，不要用輪詢比價。orderLifecycle 頂部那段
// 說明講過為什麼——15 秒一輪的輪詢碰到插針式觸價又彈回就再也偵測不到。
//
// 數量用「目前剩餘部位」而不是進場量的一半：TP1 已經吃掉一部分，實際剩多少
// 只有快照知道。不用 closePosition——早期理由是 -4130 互斥，2026-09-06 之後
// 是整個專案的一致做法（closePosition 的數量由交易所決定，而它算錯過，見
// decideTrailingStopReplace 上方的 UNI 翻倉事故），所以跟 TP1 一樣走
// quantity + reduceOnly。

export interface Tp2OrderInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  /** 目前交易所端的剩餘部位量（TP1 已經平掉一部分之後的）。 */
  positionQty: number;
  tp2: number;
  filters: SymbolFilters;
}

export type Tp2OrderDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams };

export function decideTp2OrderPlacement(input: Tp2OrderInput): Tp2OrderDecision {
  if (input.positionQty <= 0) {
    return { skip: true, reason: 'positionQty <= 0 — 沒有可平的部位' };
  }
  if (!(input.tp2 > 0)) {
    return { skip: true, reason: `tp2=${input.tp2} 無效，跳過 TP2 條件單` };
  }

  // Floor 同 TP1：平少一點是安全的，平多於持倉會被幣安以 -2022 拒絕。
  const qty = roundToStepSize(input.positionQty, input.filters.stepSize);
  if (qty <= 0) {
    return {
      skip: true,
      reason: `剩餘部位 ${input.positionQty} 在 stepSize ${input.filters.stepSize} 下取整為 0，太小無法下 TP2 單`,
    };
  }

  return {
    skip: false,
    order: {
      symbol: input.symbol,
      side: input.isLong ? 'SELL' : 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: roundToTickSize(input.tp2, input.filters.tickSize),
      quantity: qty,
      reduceOnly: true,
      // 冪等 ID，避免重試造成重複掛單（同 TP1）。
      newClientOrderId: `${input.tradeId}-tp2order`,
    },
  };
}

// ── Full close ───────────────────────────────────────────────────────────────
//
// 策略B（均值回歸）沒有 TP1/TP2 兩階段——signals.ts 的
// generateMeanReversionSignals 故意把 takeProfits 寫成 [tp1, tp1]（見
// PriceProgressBar.tsx 那次修正），觸價就是整單了結，不走 decideTp1PartialClose
// 那條「先平一半、留一半給移動止損」的路。這是給那個情境用的。

export interface FullCloseInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  positionQty: number; // absolute filled quantity currently open
}

export type FullCloseDecision =
  | { skip: true; reason: string }
  | { skip: false; order: PlaceOrderParams };

export function decideFullClose(input: FullCloseInput): FullCloseDecision {
  if (input.positionQty <= 0) {
    return { skip: true, reason: 'positionQty <= 0 — 沒有可平的部位' };
  }
  return {
    skip: false,
    order: {
      symbol: input.symbol,
      side: input.isLong ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: input.positionQty,
      reduceOnly: true,
      // 同一筆 trade 的整單平倉只會發生一次，冪等 ID 避免重試造成二次平倉。
      newClientOrderId: `${input.tradeId}-fullclose`,
    },
  };
}

// ── Trailing stop target price ──────────────────────────────────────────────
//
// route.ts's ATR ratchet (2026-08-08 移過來，數字/邏輯照抄，不是重新設計）：
//   初始化（TP1 剛觸及那一刻）：
//     LONG:  trailingStop = max(tp1 − 2×atr1h, entry)   — 保本地板，不會比進場價差
//     SHORT: trailingStop = min(tp1 + 2×atr1h, entry)
//   之後每次評估（TP1 已觸及後）：
//     LONG:  candidate = 現價 − 2×atr1h；只在 candidate > 現有止損 時採用
//     SHORT: candidate = 現價 + 2×atr1h；只在 candidate < 現有止損 時採用
//   只有策略 A（趨勢）有這個機制——策略 B（均值回歸）只有單一止盈目標，
//   TP1=TP2，不會走到「TP1 後移動止損」這段。
//
// route.ts 是「K 線掃描」架構，棘輪基準用每根 K 線的收盤價（c.close）；這裡
// 是給即時輪詢用的 runner 用，沒有 K 線，用當下 markPrice 代替——跟
// decideTradeAction 判斷 TP1 觸價時用 markPrice 代替 K 線 high/low 是同一類
// 簡化（架構本質差異：K 線只在收盤動一次，即時輪詢每輪都可能動，方向一致，
// 敏感度不同），不是另外設計的邏輯。
export interface TrailingStopTargetInput {
  isLong: boolean;
  entry: number;
  tp1: number;
  markPrice: number;
  atr1h: number;               // 1小時 ATR(14期)；<= 0 代表還沒有 ATR 資料
  currentTrailingStop: number; // 0 = 尚未初始化過
}

// 回傳新的目標止損價；atr1h <= 0（還沒抓到 ATR 資料）時原樣傳回
// currentTrailingStop，不亂算——route.ts 對這個情況的處理是「這輪不初始化」
// （見 route.ts atr1h===0 的 console.error 分支），不是用 0 或任何猜測值硬算。
export function calcTrailingStopTarget(input: TrailingStopTargetInput): number {
  if (input.atr1h <= 0) return input.currentTrailingStop;

  if (input.currentTrailingStop === 0) {
    return input.isLong
      ? Math.max(input.tp1 - 2 * input.atr1h, input.entry)
      : Math.min(input.tp1 + 2 * input.atr1h, input.entry);
  }

  const candidate = input.isLong
    ? input.markPrice - 2 * input.atr1h
    : input.markPrice + 2 * input.atr1h;

  const isMoreFavorable = input.isLong
    ? candidate > input.currentTrailingStop
    : candidate < input.currentTrailingStop;

  return isMoreFavorable ? candidate : input.currentTrailingStop;
}

// ── Trailing stop replace ───────────────────────────────────────────────────
//
// The existing route.ts trailing-stop math (init at TP1∓2×ATR floored at entry,
// ratchet favorably-only per candle) is UNCHANGED here — this function only
// decides what to do with an already-computed target price against whatever
// stop order currently lives on the exchange. That "what to do" question is
// the dangerous part: a plain cancel-then-place has a window where the position
// has NO protective order at all (see docs/TODO.md 自動化交易 — 裸倉 is called out
// as the single most dangerous failure mode this whole system guards against).
//
// This function always sequences PLACE before CANCEL. Both orders briefly
// coexist — that's safe: whichever triggers first flattens the position, and the
// other becomes a reduceOnly order with nothing left to reduce (the exchange
// rejects it, which the caller/watchdog should recognize as expected, not an
// anomaly). The alternative order (cancel-then-place) trades that harmless race
// for a real naked-position window if the place call fails or is delayed —
// strictly worse.
//
// ── 為什麼數量自己算，不用 closePosition=true（2026-09-06）──────────────
// 舊版送 `closePosition: true` 不帶 quantity，等於把「要平多少」交給交易所。
// 幣安 testnet 對 UNIUSDT trade-1788511232519-z9tmu 連續四次算錯：
//   09-01 部位 82 → 平 41      09-04 部位 31 → 平 10
//   09-05 部位 21 → 平 20      09-06 部位  1 → **平 40**
// 最後一次把多單翻成 -39 的空單，而且那 39 張沒有任何保護單（決策層看到
// 方向不符只會停手，不會自己平掉）。證據：同一筆單另外 237 張未觸發的止損
// 單記錄 quantity 都是 0，數量不是我們送的；同期 TP1/TP2 那條
// quantity+reduceOnly 路徑一次都沒出錯（XRP 1496.9 全平、ZEC 精準平一半）。
// 為什麼只有 UNI 中招沒有查出來——四個資料點湊不出規則，而且那是交易所端
// 的計算，我們這邊量不到。所以改成不依賴它：數量自己算，reduceOnly 讓交易所
// 只能減倉不能開倉，翻倉在原理上不可能發生。
//
// 副作用：closePosition=true 的單在部位平掉時交易所會自動連帶取消，
// reduceOnly 的不會，會留下孤兒條件單——這跟 TP1/TP2 早就有的狀況一樣，
// live-runner 的帳戶級對帳（getOpenAlgoOrders 全帳戶掃描）已經在收，
// 不是新風險。順帶好處：不再佔用 symbol+方向唯一的 closePosition 額度，
// -4130 那類互斥問題在這條路徑上消失。

export interface CurrentStopOrder {
  orderId: number;
  stopPrice: number;
}

export interface TrailingStopReplaceInput {
  tradeId: string;
  symbol: string;
  isLong: boolean;
  currentStopOrder: CurrentStopOrder | null; // null = no live protective order (shouldn't happen post-fill; caller/watchdog should treat this as position_without_stop)
  desiredStopPrice: number;                   // output of the existing (unchanged) trailing-stop math
  positionQty: number;                        // 目前部位的絕對值（positionRisk 快照），止損單的數量
  filters: SymbolFilters;
}

export type TrailingStopAction =
  | { kind: 'none'; reason: string }
  | { kind: 'initialize'; place: PlaceOrderParams }
  | { kind: 'replace'; place: PlaceOrderParams; cancelOrderId: number };

export function decideTrailingStopReplace(input: TrailingStopReplaceInput): TrailingStopAction {
  const roundedTarget = roundToTickSize(input.desiredStopPrice, input.filters.tickSize);

  // Floor（roundToStepSize 本身就是無條件捨去）：寧可少平一點點，也不要送出
  // 比部位大的數量。reduceOnly 會再擋一層，但下單前先算對比較好對帳。
  const qty = roundToStepSize(input.positionQty, input.filters.stepSize);
  if (qty <= 0) {
    return {
      kind: 'none',
      reason: `部位量 ${input.positionQty} 在 stepSize ${input.filters.stepSize} 下取整為 0，掛不出合法的止損單`,
    };
  }

  const place: PlaceOrderParams = {
    symbol: input.symbol,
    side: input.isLong ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: roundedTarget,
    quantity: qty,
    reduceOnly: true,
    // Price-keyed, not time-based: two calls that land on the same target price
    // (e.g. the ratchet math re-runs on a cron cycle where nothing moved) must
    // collapse to the same ID and get rejected as a duplicate, not place a
    // second identical stop order next to the one already live.
    newClientOrderId: `${input.tradeId}-sl-${hashPrice(roundedTarget)}`,
  };

  if (input.currentStopOrder === null) {
    return { kind: 'initialize', place };
  }

  const currentRounded = roundToTickSize(input.currentStopOrder.stopPrice, input.filters.tickSize);
  if (currentRounded === roundedTarget) {
    return { kind: 'none', reason: '目標價與現有止損單相同，不需要改單' };
  }

  // Ratchet is one-directional by design (route.ts:735/762 — "only moves
  // favorably"). A target that would loosen the stop is either stale math or a
  // caller bug; refusing to act here is the safe default — the existing,
  // already-favorable stop stays live untouched rather than being replaced
  // with something worse.
  const isMoreFavorable = input.isLong
    ? roundedTarget > currentRounded
    : roundedTarget < currentRounded;
  if (!isMoreFavorable) {
    return {
      kind: 'none',
      reason: `目標價 ${roundedTarget} 沒有比現有止損 ${currentRounded} 更有利，拒絕改單（棘輪只能往有利方向移動）`,
    };
  }

  return { kind: 'replace', place, cancelOrderId: input.currentStopOrder.orderId };
}

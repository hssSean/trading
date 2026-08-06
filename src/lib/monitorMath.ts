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

// 2026-08-05（docs/ANALYSIS-2026-08-05-提升盈虧率的可動項目.md #1）：TP1
// 過去只是里程碑，不是實際成交事件——不管碰過 TP1 沒有，最終 R 一律用
// 「最後出場價」算 100%，等於把「碰到 TP1 又回吐」的那段有利波動當成
// 沒發生過。20 筆有 MFE 樣本裡，碰到 TP1 的 5 筆平均回吐超過一半（實得
// 合計 5.31R vs 若在 TP1 全出會是 9.74R）。
//
// 改成 TP1 部分停利：碰到 TP1 視為平掉 fraction（預設 50%）部位鎖定該處
// 的 R，剩下的部位才繼續照最終出場價計算，兩段加權平均成最終 R。不需要
// 新增資料表欄位——TP1 價格是既有固定欄位，可以隨時反推那一段的 R，不用
// 另外儲存「當時鎖定的 R」。
//
// 固定 50%、不做成使用者可調參數：分析文件明確建議「先用中庸值，不要想
// 一次調到最佳」——樣本只有 5 筆，決定不出真正的最佳比例，開放調整只會
// 被拿去在雜訊上亂試。
export const TP1_PARTIAL_FRACTION = 0.5;

// 2026-08-06（docs/ANALYSIS-2026-08-06B-策略可行性複查與修改方案.md 方法3）：
// 止損出場（原始止損、TP1後移動止損）在真實市場是 STOP_MARKET 型執行——
// 觸價後才送市價單，快速行情下實際成交可能比觸發價更差。這個系統一直假設
// 剛好在觸發價成交、零滑價：8/6 CSV 查出 8 筆止損出場全部精準 −1.00R，但
// MAE 資料顯示其中 5 筆的 K 線實際走到 −1.33/−1.10/−1.08/−1.06/−1.05R——
// 代表帳目比真實情況樂觀，而目前整體扣成本後平均只有 +0.18R/筆，這個樂觀
// 偏差不是小數目。
//
// 不是策略調參，是讓記帳誠實：套一個保守、不是照這批樣本硬湊出來的固定值，
// 跟既有 scripts/backtest.ts 的進場滑價假設（SLIP = 0.03%）同一數量級。
// 只用在止損類出場（STOP_MARKET 語意）——TP1/TP2 是限價單性質，觸及即成交
// 不會有逆price滑價，不套用這個模型。
export const STOP_EXIT_SLIPPAGE_PCT = 0.0005; // 0.05%，對交易者不利的方向

export function applyStopSlippage(stopPrice: number, isLong: boolean): number {
  return isLong ? stopPrice * (1 - STOP_EXIT_SLIPPAGE_PCT) : stopPrice * (1 + STOP_EXIT_SLIPPAGE_PCT);
}

export function blendTp1PartialPnl(
  entry: number,
  tp1: number,
  finalExitPrice: number,
  isLong: boolean,
  fraction: number = TP1_PARTIAL_FRACTION,
): number {
  const pnlAt = (price: number) =>
    isLong ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
  return fraction * pnlAt(tp1) + (1 - fraction) * pnlAt(finalExitPrice);
}

// Shared "what happens after this position is live" walk, used by both the
// reject-funnel shadow simulator (gate-rejected candidates that were never
// really taken) and the time-stop shadow simulator (real trades force-closed
// early by the 8-bar stall rule or the 24h/72h/168h expiry, continued forward
// to see what would have happened — docs/TODO.md P1 #1). Both need identical
// TP1→TP2/SL sequencing (TP1-before-SL wins on the same candle) so the two
// simulated numbers are comparable to each other and to real monitor outcomes.
//
// Pure: takes the candles + starting state, returns the outcome without
// mutating anything. Caller applies the result to its own persisted shape.
export interface WalkCandle { high: number; low: number; close: number; closeTime: number; }

export interface WalkTpSlParams {
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  isLong: boolean;
}

export interface WalkTpSlResult {
  tp1Hit: boolean;
  done: boolean;
  result?: 'WIN_TP1' | 'WIN_TP2' | 'LOSS';
  exitPrice?: number;
  closedAt?: number;
}

// Why a position closed, distinct from win/loss (closeResult) itself — two WIN_TP1
// trades can have completely different stories (one rode the ratcheted trailing
// stop after TP1, another got cut by the age limit right after TP1). Extracted so
// the branch ordering (autoClosedAfterTp1 must be checked before the generic
// WIN_TP1 fallback; timeStopFired before the generic MANUAL_CLOSE fallback) is
// covered by tests instead of only a manual read-through — docs/TODO.md 報表 work.
export type CloseReason =
  | 'tp2' | 'trailing_stop' | 'stop_loss'
  | 'time_stop_stall' | 'time_stop_expiry' | 'time_stop_expiry_post_tp1';

export function deriveCloseReason(params: {
  closeResult: string;
  timeStopFired: boolean;
  autoClosedAfterTp1: boolean;
}): CloseReason {
  const { closeResult, timeStopFired, autoClosedAfterTp1 } = params;
  if (closeResult === 'WIN_TP2') return 'tp2';
  if (closeResult === 'LOSS') return 'stop_loss';
  if (closeResult === 'MANUAL_CLOSE') return timeStopFired ? 'time_stop_stall' : 'time_stop_expiry';
  // WIN_TP1 from here on. autoClosedAfterTp1 (age limit reached post-TP1) must be
  // checked before the generic fallback — it's also reached via closeResult==='WIN_TP1'
  // but is NOT a trailing-stop exit.
  if (autoClosedAfterTp1) return 'time_stop_expiry_post_tp1';
  return 'trailing_stop'; // ratcheted trailing stop hit, or (rare, ATR unavailable) the original SL floor after TP1
}

// MFE (Maximum Favorable Excursion) / MAE (Maximum Adverse Excursion): how far
// price moved in the trade's favor / against it since fill, in raw price terms
// (converted to R at read time — CSV export does entry/stopLoss ÷ (mfe-entry) etc,
// same convention as the rest of the app's R-multiple reporting).
//
// Why this matters: the trade log only records the EXIT price, so a trade that
// ran to +1.8R before reversing to a time-stop +0.2R looks identical to one that
// only ever reached +0.3R. Those are opposite problems (TP1 too far away vs.
// entry/thesis wasn't working) needing opposite fixes — MFE/MAE is the only way
// to tell them apart (2026-07-30 strategy review).
//
// Called with only the NEW candles fetched this scan (route.ts already narrows
// to `openTime >= fillAnchor` on the first scan and to new bars on later ones),
// not the trade's whole history — the running extreme is the persisted state,
// updated incrementally each scan exactly like the trailing stop is. Pure and
// monotonic: the result only ever extends prior, never retreats.
export interface MfeMaeCandle { high: number; low: number; }

export interface MfeMaeUpdate {
  mfePrice: number | null;
  maePrice: number | null;
  changed: boolean;
}

export function updateMfeMae(
  candles: MfeMaeCandle[],
  isLong: boolean,
  priorMfe: number | null,
  priorMae: number | null,
): MfeMaeUpdate {
  let mfePrice = priorMfe;
  let maePrice = priorMae;
  for (const c of candles) {
    const favorable = isLong ? c.high : c.low;
    const adverse    = isLong ? c.low  : c.high;
    if (mfePrice === null || (isLong ? favorable > mfePrice : favorable < mfePrice)) mfePrice = favorable;
    if (maePrice === null || (isLong ? adverse   < maePrice  : adverse   > maePrice)) maePrice = adverse;
  }
  return { mfePrice, maePrice, changed: mfePrice !== priorMfe || maePrice !== priorMae };
}

// 2026-08-04（實錘：移動止損從未生效，見 docs/ANALYSIS-2026-08-04）：ATR 必須
// 從一個「完整、固定長度」的 K 線窗口算，不能從 route.ts Phase 2 那個增量抓取
// 的 `candles`（每輪只帶 last_monitored_at 之後的新K線，通常只有 1-2 根）算——
// 後者會讓 `candles.length >= 15` 恆為 false，`atr1h` 恆為 0，移動止損永遠不會
// 被初始化，TP1 後只能一路等到原始止損才出場。呼叫端改用 fetchCandlesCached
// 額外抓一份完整窗口餵這個函式，不能跟 evalCandles 共用同一份增量陣列。
//
// 簡單 TR 均值（非 Wilder 遞迴），刻意跟修 bug 前 route.ts 原本的公式一致——
// 這次只修「資料來源」，不動「ATR 算法本身」，避免一次動兩個變數。
export function calcSimpleAtr(candles: WalkCandle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const n = Math.min(period, candles.length - 1);
  let trSum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    trSum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    );
  }
  return trSum / n;
}

// 2026-08-04（docs/ANALYSIS-2026-08-04C「自動化前工程面還缺什麼」）：
// 既有熔斷只看「當日」——當日累計 −3R 或連續 3 筆止損，且每天 UTC 0 點重置。
// 這擋得住單日崩盤，但擋不住慢性失血：每天 −2.5R 連續 5 天，從來沒有任何一天
// 觸發當日 −3R 門檻，累積卻已經 −12.5R。手動操作時使用者自己看得到帳戶在縮水
// 會停手，全自動就沒有這個人為煞車了，所以補一個跨日的權益高點回撤上限。
//
// 用「已平倉單的帳戶R累積權益曲線」算：逐筆累加，記錄歷史高點，回撤 =
// 高點 − 當前。實測歷史資料（55 筆已平倉）最大回撤僅 2.01R、最大連續虧損
// 3 筆、最差單日 −1.20R，所以預設門檻 8R 約是歷史最糟的 4 倍——正常運作
// 不會碰到，碰到就代表策略行為已經脫離歷史分布，該停下來人工檢查。
//
// 刻意「不」自動解除：權益回到高點附近才會自然低於門檻而恢復。停下來之後
// 沒有新單，權益只能靠既有持倉平倉變動，所以實務上等同「停到人工介入」——
// 這正是自動交易該有的行為，不是缺陷。
export interface EquityPoint { closedAt: number; accountR: number; }

export interface DrawdownState {
  peak: number;      // 歷史權益高點（帳戶R）
  current: number;   // 目前累積權益（帳戶R）
  drawdown: number;  // peak − current，恆 >= 0
}

export function calcDrawdown(points: EquityPoint[]): DrawdownState {
  const sorted = [...points].sort((a, b) => a.closedAt - b.closedAt);
  let equity = 0, peak = 0;
  for (const p of sorted) {
    equity += p.accountR;
    if (equity > peak) peak = equity;
  }
  return { peak, current: equity, drawdown: Math.max(0, peak - equity) };
}

export function walkTpSl(
  candles: WalkCandle[],
  afterMs: number,
  params: WalkTpSlParams,
  tp1HitAlready: boolean,
): WalkTpSlResult {
  const { stopLoss, tp1, tp2, isLong } = params;
  let tp1Hit = tp1HitAlready;
  for (const c of candles) {
    if (c.closeTime <= afterMs) continue;
    const hitSL  = isLong ? c.low  <= stopLoss : c.high >= stopLoss;
    const hitTP1 = isLong ? c.high >= tp1      : c.low  <= tp1;
    const hitTP2 = isLong ? c.high >= tp2      : c.low  <= tp2;
    if (tp1Hit) {
      if (hitTP2) return { tp1Hit, done: true, result: 'WIN_TP2', exitPrice: tp2,      closedAt: c.closeTime };
      if (hitSL)  return { tp1Hit, done: true, result: 'WIN_TP1', exitPrice: stopLoss, closedAt: c.closeTime };
      continue;
    }
    if (hitTP2)      return { tp1Hit, done: true, result: 'WIN_TP2', exitPrice: tp2, closedAt: c.closeTime };
    else if (hitTP1) { tp1Hit = true; continue; } // TP1-before-SL same-candle rule (matches monitor)
    else if (hitSL)  return { tp1Hit, done: true, result: 'LOSS', exitPrice: stopLoss, closedAt: c.closeTime };
  }
  return { tp1Hit, done: false };
}

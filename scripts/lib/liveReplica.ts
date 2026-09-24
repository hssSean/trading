/**
 * 線上規則的離線重現——回測類腳本共用的那一份。
 *
 * 為什麼抽出來：2026-09-24 scripts/verify-strategy.ts 的檢查清單抓到
 * backtest.ts／exit-compare.ts 各自複製了一份 regime／4H 拼接／掛單成交邏輯，
 * 而且全部跟線上分岔了（ADX 門檻 25/20 vs 23/18、沒有遲滯、掛單 8 根 vs 4 根、
 * htfBias 傳 null、4H 沒對齊 UTC、「540 根 4H」其實只有 135 根、成交那根的
 * 止損被忽略）。複製一份出去遲早會分岔——這裡是唯一的一份，改線上規則時
 * 只要改這裡，verify-strategy.ts 的檢查清單會盯著常數有沒有跟 route.ts 一致。
 *
 * 語意是「修正後的線上」：訊號與 regime 都只吃已收盤 K 棒（見
 * src/lib/signalCache.ts closedCandlesOnly 的說明）；HTF bias 與 BTC 大盤
 * 用「已收盤 4H + 形成中那根的現價」，跟線上每輪掃描重算的行為相同。
 */
import type { Candle } from '../../src/types';
import { adx, ema } from '../../src/analysis/indicators';
import { simulateExit, type ExitBar, type ExitPolicyConfig } from '../../src/lib/exitPolicy';

export const H = 3_600_000;
export const H4 = 4 * H;

/** 與 route.ts／tradeBridge.ts 同步的線上參數。verify-strategy.ts 會逐一比對原始碼。 */
export const LIVE = {
  STRONG_THRESHOLD: 65,
  STRONG_THRESHOLD_B: 13,
  WAITING_EXPIRY_BARS: 4,
  INTRADAY_CLOSE_HOURS: 24,
  PRE_TP1_BREAKEVEN_TRIGGER_R: 0.5,
  ADX_TREND: 23,
  ADX_RANGE: 18,
  ADX_BARS_4H: 540,
  COOLDOWN_H: 6,
  LOSS_COOLDOWN_H: 24,
  TIME_STOP_COOLDOWN_H: 4,
  BIAS_HOLD_BARS: 12,
  STRAT_B_PAUSE_H: 24,
  BTC_PAUSE_H: 2,
};

// ── 成本模型 ──────────────────────────────────────────────────────
export const MAKER = 0.0002;      // 限價進場
export const TAKER = 0.0005;      // 市價進場、所有條件單出場（TAKE_PROFIT_MARKET／STOP_MARKET）
export const ENTRY_SLIP = 0.0003; // 市價進場滑價
export const STOP_SLIP = 0.0005;  // 止損類出場滑價（monitorMath.STOP_EXIT_SLIPPAGE_PCT）

/** 從 1H 拼出 UTC 對齊的 4H；只收完整的 4 根一組。 */
export function aggregate4h(c1: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 3 < c1.length; i++) {
    if (c1[i].openTime % H4 !== 0) continue;
    const g = c1.slice(i, i + 4);
    if (g[3].openTime !== g[0].openTime + 3 * H) continue; // 中間缺棒就不拼
    out.push({
      openTime: g[0].openTime, open: g[0].open,
      high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)),
      close: g[3].close, volume: g.reduce((s, x) => s + x.volume, 0), closeTime: g[0].openTime + H4 - 1,
    });
    i += 3;
  }
  return out;
}

export interface FourHView { c4: Candle[]; idx: Map<number, number> }
export const makeFourHView = (c4: Candle[]): FourHView => ({ c4, idx: new Map(c4.map((c, k) => [c.openTime, k])) });

/** T 時點最後一根已收盤 4H 的索引；沒有就 -1 */
export function lastClosed4h(v: FourHView, T: number): number {
  const blockStart = Math.floor(T / H4) * H4;
  return v.idx.get(blockStart - H4) ?? -1;
}

/** 4H ADX（只吃已收盤 4H，最多 540 根）；資料不足回 NaN */
export function adx4hAt(v: FourHView, T: number): number {
  const lc = lastClosed4h(v, T);
  if (lc < 30) return NaN;
  return adx(v.c4.slice(Math.max(0, lc - LIVE.ADX_BARS_4H + 1), lc + 1), 14).adx;
}

export type Regime = 'trending' | 'ranging' | 'transitional';

/** 無狀態版本：18-23 一律當 transitional。只給「不在乎遲滯」的分類用途。 */
export function regimeFromAdx(a: number): Regime {
  if (isNaN(a)) return 'ranging';
  if (a >= LIVE.ADX_TREND) return 'trending';
  if (a <= LIVE.ADX_RANGE) return 'ranging';
  return 'transitional';
}

/** 線上的遲滯：18-23 沿用前一狀態，沒有前一狀態才是 transitional。 */
export class RegimeTracker {
  private prev: 'trending' | 'ranging' | null = null;
  next(a: number): Regime {
    let r = regimeFromAdx(a);
    if (r === 'transitional' && this.prev) r = this.prev;
    if (r !== 'transitional') this.prev = r;
    return r;
  }
}

/** T 時點「看得到」的 4H 收盤序列：已收盤的 + 形成中那根（close = 現價）。 */
export function closes4hWithForming(v: FourHView, T: number, price: number, n = 250): number[] {
  const lc = lastClosed4h(v, T);
  const closed = lc >= 0 ? v.c4.slice(Math.max(0, lc - n + 2), lc + 1).map(c => c.close) : [];
  return [...closed, price];
}

/** route.ts 的 4H EMA200 bias：距離 EMA200 1.5% 以內算中性 */
export function ema200Bias(closes: number[]): 'LONG' | 'SHORT' | null {
  if (closes.length < 200) return null;
  const e = ema(closes, 200);
  const val = e[e.length - 1];
  const px = closes[closes.length - 1];
  if (!val || isNaN(val)) return null;
  if (Math.abs(px - val) / val < 0.015) return null;
  return px > val ? 'LONG' : 'SHORT';
}

// ── 掛單成交 + 出場 ────────────────────────────────────────────────
export interface TradeLevels { entry: number; stopLoss: number; tp1: number; tp2: number; isLong: boolean }

export type FillOutcome =
  | { kind: 'expired' }
  | { kind: 'tp1_direct'; idx: number }
  | { kind: 'filled'; idx: number; price: number };

/**
 * 限價掛單：訊號那根（signalIdx）之後最多 WAITING_EXPIRY_BARS 根內碰到 entry 才成交；
 * 成交前先碰到 TP1 → 取消（route.ts cancel_tp1_direct）。同一根兩者都碰到時判成交。
 * market=true 時直接以訊號那根收盤成交（加滑價）。
 */
export function simulateFill(c1: Candle[], signalIdx: number, lv: TradeLevels, market: boolean): FillOutcome {
  if (market) {
    const px = lv.isLong ? lv.entry * (1 + ENTRY_SLIP) : lv.entry * (1 - ENTRY_SLIP);
    return { kind: 'filled', idx: signalIdx, price: px };
  }
  const last = Math.min(signalIdx + LIVE.WAITING_EXPIRY_BARS, c1.length - 1);
  for (let k = signalIdx + 1; k <= last; k++) {
    const c = c1[k];
    if (lv.isLong ? c.low <= lv.entry : c.high >= lv.entry) return { kind: 'filled', idx: k, price: lv.entry };
    if (lv.isLong ? c.high >= lv.tp1 : c.low <= lv.tp1) return { kind: 'tp1_direct', idx: k };
  }
  return { kind: 'expired' };
}

export interface ExitResult {
  grossR: number;
  reason: string;
  exitIdx: number;
  tp1Hit: boolean;
  /** 成交那一根就打到止損（悲觀判定）——給敏感度分析用 */
  fillBarStop: boolean;
}

/**
 * 成交後走出場。成交那一根（限價單）若也碰到止損，判止損：限價單是在回調時
 * 成交的，那一根正是最容易順便打到止損的一根，忽略它是系統性樂觀。
 * 回傳 null = 資料不夠走完（呼叫端排除這筆）。
 */
export function simulateExitAfterFill(
  c1: Candle[], atr: number[], fillIdx: number, fillPrice: number, lv: TradeLevels,
  market: boolean, policy: ExitPolicyConfig, forwardBars = 200,
): ExitResult | null {
  const fb = c1[fillIdx];
  if (!market && (lv.isLong ? fb.low <= lv.stopLoss : fb.high >= lv.stopLoss)) {
    return { grossR: -1, reason: 'stop', exitIdx: fillIdx, tp1Hit: false, fillBarStop: true };
  }
  const fwd = c1.slice(fillIdx + 1, fillIdx + 1 + forwardBars);
  const bars: ExitBar[] = fwd.map(c => ({ high: c.high, low: c.low, close: c.close }));
  const o = simulateExit({
    entry: fillPrice, stopLoss: lv.stopLoss, tp1: lv.tp1, tp2: lv.tp2, isLong: lv.isLong, bars,
    atr: atr.slice(fillIdx + 1, fillIdx + 1 + forwardBars),
  }, policy);
  if (o.reason === 'open') return null;
  return { grossR: o.r, reason: o.reason, exitIdx: fillIdx + o.barsHeld, tp1Hit: o.tp1Hit, fillBarStop: false };
}

/**
 * 手續費＋滑價換算成 R（不含資金費率）。
 * 真倉的 TP/SL 全是條件單（觸發後市價）→ 出場一律 taker；滑價只加在止損類。
 */
export function tradeCostR(riskPct: number, market: boolean, reason: string, tp1Hit: boolean): number {
  const entryFee = market ? TAKER : MAKER;
  const slip = reason === 'stop' || reason === 'breakeven' || reason === 'trail' ? STOP_SLIP : 0;
  const exitCost = tp1Hit ? 0.5 * TAKER + 0.5 * (TAKER + slip) : TAKER + slip;
  return (entryFee + exitCost) / riskPct;
}

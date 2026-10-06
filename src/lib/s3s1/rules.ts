// S3（唐奇安日線趨勢＋分數）與 S1（12H Keltner）——規則的唯一一份。
//
// 來源：研究端《策略部署總整理_給部署AI》（2026-10-06，存於 docs/strategy-deploy-2026-10-06.md）與
// C:\trading_stratage 的參考實作：engine.py（simulate/_walk/universe_rank/ema/atr）、strategies.py
// （donchian、keltner）、scan.py（btc_regime）、audit_s3.py（breadth、daily_feat、門檻）、
// opt_exit.py（S1 的 daily_up 與過濾）、pyramid.py（S3-B 加碼）。
// 驗收：scripts/s3s1-acceptance.ts 對文件第 10 節的參考交易逐筆比對。
//
// 全部只用已收盤 K 線；時間一律 UTC 毫秒；K 棒時間 t = 開盤時間。
import { emaSpan, wilderAtr } from './ind';

export interface Bar { t: number; o: number; h: number; l: number; c: number; qv?: number }
export interface FundingPoint { t: number; rate: number }

export const H = 3_600_000;
export const H12 = 12 * H;
export const DAY = 24 * H;

/** 每邊成本（手續費 0.05% ＋ 滑價 0.02%），與回測相同 */
export const COST = 0.0007;
export const BREADTH_MAX = 0.93;
export const FUNDING_MAX = 0.0005;
export const MIN_RISK_FRAC = 0.002;

/** S3 分數門檻（研究端用 2020–22 的分位數算出；完整精度取自 audit_s3_full.pkl） */
export const S3_TH = { risk: 0.12984220878051442, btc: 2.1041656428039044, ret7: 0.29247984259241727 } as const;

// 文件 §2.2 排除清單（baseAsset）
const EXCLUDED_BASES = new Set([
  'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'USDE', 'BTCDOM', 'DEFI', 'BLUEBIRD', 'FOOTBALL',
  'XAU', 'XAG', 'PAXG', 'XAUT', 'XPD', 'XPT',
  'AAPL', 'AMZN', 'AVGO', 'BABA', 'COIN', 'CRCL', 'EWJ', 'EWY', 'GOOGL', 'HOOD', 'INTC', 'META', 'MSFT', 'MSTR',
  'MU', 'NVDA', 'PLTR', 'QQQ', 'SPY', 'TSLA', 'TSM', 'SNDK', 'CL', 'BZ', 'NATGAS', 'COPPER',
]);
export const isExcludedSymbol = (symbol: string) => EXCLUDED_BASES.has(symbol.replace(/USDT$/, ''));

/** 已排序 K 棒中 t 等於指定值的索引（二分搜尋） */
export function idxOf(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t === t) return m;
    if (bars[m].t < t) lo = m + 1; else hi = m - 1;
  }
  return -1;
}
/** 最後一根 t ≤ T 的索引；沒有回 −1 */
export function lastAtOrBefore(bars: { t: number }[], T: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t <= T) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

/**
 * 研究端用 1H 合成日線／12H（engine.resample），不滿半根（日線 < 12 小時、12H < 6 小時）的 K 棒會被丟掉；
 * 幣安官方 K 線則會保留上市當天那根不完整的。只有「拿到的資料從上市第一根開始」時才需要處理——
 * EMA／ATR 從第一根開始遞推，第一根不同會讓新幣的指標差到 1e-6 等級（RAVEUSDT 實測）。
 * firstHourT：該幣第一根 1H 的開盤時間（= 上市時間）。
 */
export function trimPartialFirstBar(bars: Bar[], firstHourT: number, tfMs: number): Bar[] {
  if (!bars.length) return bars;
  const b0 = bars[0];
  if (firstHourT <= b0.t || firstHourT >= b0.t + tfMs) return bars;
  const hours = (b0.t + tfMs - firstHourT) / H;
  return hours < tfMs / H / 2 ? bars.slice(1) : bars;
}

// ════════════════════════════════════════════════════════════════════
// 日線特徵（S3、BTC 條件、市場廣度、幣本身 EMA50）
// ════════════════════════════════════════════════════════════════════
export interface DailyFeat {
  bars: Bar[];
  ema50: number[];
  atr14: number[];
  /** HH20(D)：D−20～D−1 最高價（不含 D） */
  hh20: number[];
  /** LL10(D)：D−9～D 最低價（含 D） */
  ll10: number[];
  /** Close(D)/Close(D−7) − 1 */
  ret7: number[];
}

export function dailyFeatures(bars: Bar[]): DailyFeat {
  const n = bars.length;
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l);
  const hh20 = new Array<number>(n).fill(NaN), ll10 = new Array<number>(n).fill(NaN), ret7 = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i >= 20) { let m = -Infinity; for (let k = i - 20; k < i; k++) m = Math.max(m, h[k]); hh20[i] = m; }
    if (i >= 9) { let m = Infinity; for (let k = i - 9; k <= i; k++) m = Math.min(m, l[k]); ll10[i] = m; }
    if (i >= 7) ret7[i] = c[i] / c[i - 7] - 1;
  }
  return { bars, ema50: emaSpan(c, 50), atr14: wilderAtr(h, l, c, 14), hh20, ll10, ret7 };
}

/** BTC 條件：訊號日 D → BTC 在 D−1 的日線收盤 > EMA50 */
export function btcOk(btc: DailyFeat, dayD: number): boolean {
  const i = idxOf(btc.bars, dayD - DAY);
  return i >= 0 && btc.bars[i].c > btc.ema50[i];
}

/** BTC 在 D 日離 EMA50 的距離（以 ATR14 計） */
export function btcExt(btc: DailyFeat, dayD: number): number {
  const i = idxOf(btc.bars, dayD);
  return i >= 0 ? (btc.bars[i].c - btc.ema50[i]) / btc.atr14[i] : NaN;
}

/**
 * 市場廣度：在時間 T 時「最新一根已收盤日線」收盤 > 自身 EMA50 的合約比例。
 * 參考實作把每根日線的結果掛在「開盤 + 1 天」（= 收盤時間），取 ≤ T 的最後一個；
 * 分母是那一天有日線的合約（pandas concat 後 mean 會略過缺值）。
 */
export function breadthAt(all: Map<string, DailyFeat>, T: number): number {
  const day = Math.floor(T / DAY) * DAY - DAY; // ≤ T 收盤的最後一根日線的開盤
  let up = 0, n = 0;
  for (const [sym, f] of Array.from(all.entries())) {
    if (isExcludedSymbol(sym)) continue;
    const i = idxOf(f.bars, day);
    if (i < 0) continue;
    n++;
    if (f.bars[i].c > f.ema50[i]) up++;
  }
  return n ? up / n : NaN;
}

/** 資金費率：時間 ≤ T 的最新一次已結算 */
export function fundingAt(fund: FundingPoint[], T: number): number {
  const i = lastAtOrBefore(fund, T);
  return i >= 0 ? fund[i].rate : 0; // 參考實作：沒有任何結算紀錄時當 0
}

/**
 * 幣池：D 日的排名用 D−30～D−1 的平均成交額（至少 20 天），上市未滿 30 天不算。
 * engine.universe_rank：rolling(30, min_periods=20).mean().shift(1)、age ≥ 30、method="first"。
 */
export function universeOn(all: Map<string, Bar[]>, dayD: number, topN: number): { symbol: string; vol: number }[] {
  const rows: { symbol: string; vol: number }[] = [];
  for (const [symbol, bars] of Array.from(all.entries())) {
    if (isExcludedSymbol(symbol)) continue;
    const i = idxOf(bars, dayD);
    if (i < 30) continue; // age ≥ 30（當天這根之前至少 30 根）
    let s = 0, k = 0;
    for (let j = Math.max(0, i - 30); j < i; j++) if (bars[j].qv != null && Number.isFinite(bars[j].qv)) { s += bars[j].qv as number; k++; }
    if (k < 20) continue;
    rows.push({ symbol, vol: s / k });
  }
  return rows.sort((a, b) => b.vol - a.vol).slice(0, topN);
}

// ════════════════════════════════════════════════════════════════════
// S3 訊號
// ════════════════════════════════════════════════════════════════════
export interface S3Signal {
  symbol: string;
  dayD: number;          // 訊號日（日線開盤時間）
  close: number; hh20: number; atr14: number; stop: number;
  ret7: number;
}

/** 剛收盤的 D 是否觸發 S3（只看幣本身；幣池、BTC、廣度、資金費、分數由呼叫端套） */
export function s3SignalAt(symbol: string, f: DailyFeat, dayD: number): S3Signal | null {
  const i = idxOf(f.bars, dayD);
  if (i < 25) return null; // 至少 26 根日 K
  const c = f.bars[i].c, cp = f.bars[i - 1].c;
  if (!(c > f.hh20[i] && cp <= f.hh20[i - 1])) return null;
  return { symbol, dayD, close: c, hh20: f.hh20[i], atr14: f.atr14[i], stop: c - 2 * f.atr14[i], ret7: f.ret7[i] };
}

/** 分數：+1 止損距離 ≤ 門檻、+1 BTC 離 EMA50 ≥ 門檻、−1 七日漲幅 ≥ 門檻；只做 = 2 */
export function s3Score(riskFrac: number, btcExtAtr: number, ret7: number): number {
  return (riskFrac <= S3_TH.risk ? 1 : 0) + (btcExtAtr >= S3_TH.btc ? 1 : 0) - (ret7 >= S3_TH.ret7 ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════
// S1 訊號（12H Keltner）
// ════════════════════════════════════════════════════════════════════
export interface H12Feat { bars: Bar[]; ema20: number[]; atr10: number[]; upper: number[] }
export function h12Features(bars: Bar[]): H12Feat {
  const c = bars.map(b => b.c);
  const ema20 = emaSpan(c, 20);
  const atr10 = wilderAtr(bars.map(b => b.h), bars.map(b => b.l), c, 10);
  return { bars, ema20, atr10, upper: ema20.map((e, i) => e + 2 * atr10[i]) };
}

export interface S1Signal { symbol: string; barT: number; close: number; ema20: number; atr10: number; upper: number; stop: number }

export function s1SignalAt(symbol: string, f: H12Feat, barT: number): S1Signal | null {
  const i = idxOf(f.bars, barT);
  if (i < 25) return null; // 至少 26 根 12H K
  const c = f.bars[i].c, cp = f.bars[i - 1].c;
  if (!(c > f.upper[i] && cp <= f.upper[i - 1])) return null;
  return { symbol, barT, close: c, ema20: f.ema20[i], atr10: f.atr10[i], upper: f.upper[i], stop: c - 1.5 * f.atr10[i] };
}

/** S1 幣本身條件：該幣 D−1 日線收盤 > D−1 日線 EMA50 */
export function coinDailyUp(f: DailyFeat, dayD: number): boolean {
  const i = idxOf(f.bars, dayD - DAY);
  return i >= 0 && f.bars[i].c > f.ema50[i];
}

// ════════════════════════════════════════════════════════════════════
// 單筆模擬（R 倍數；與 engine.simulate／_walk、pyramid.addon 一致）
// ════════════════════════════════════════════════════════════════════
export interface TradeSim {
  entry: number;
  risk: number;
  partial: boolean;
  partialT: number | null;
  exitT: number;            // 觸發出場的那根 1H 開盤時間（參考表「出場時間」口徑）
  exitPx: number;
  exitReason: 'stop' | 'breakeven' | 'trail' | 'ema' | 'open';
  grossR: number;
  netR: number;             // 扣每邊 0.07% 與資金費率（engine：2×COST×entry ＋ 資金費 ×entry，÷ 風險）
  addR: number | null;      // S3-B 加碼單的 R（以加碼單自身風險計）；未觸發 null
}

/**
 * hourly：1H 已收盤 K 線，需涵蓋進場到現在（或到 dataEnd）。
 * kind 'S3'：止損 + 1R 平 1/3 → 保本 + LL10 移動止損（從進場那根日線的收盤起，下一根日線開始生效）。
 * kind 'S1'：止損 + 0.75R 平 1/3 → 保本 + 12H 收盤 < EMA20（含進場那根）→ 下一根 12H 開盤出場。
 * dataEnd：到這個時間資料就結束；若 forceCloseAtEnd，用最後一根收盤結算（驗收用，參考實作的做法）。
 */
export function simulateTrade(opts: {
  kind: 'S3' | 'S1';
  entryT: number;
  stop: number;
  hourly: Bar[];
  daily?: DailyFeat;   // S3
  h12?: H12Feat;       // S1
  fund: FundingPoint[];
  dataEnd?: number;
  forceCloseAtEnd?: boolean;
  withAddon?: boolean;
}): TradeSim | null {
  const { kind, entryT, stop, hourly, fund } = opts;
  const h0 = idxOf(hourly, entryT);
  if (h0 < 0) return null;
  const entry = hourly[h0].o;
  const risk = entry - stop;
  if (!Number.isFinite(risk) || risk <= entry * MIN_RISK_FRAC) return null;
  const partR = kind === 'S3' ? 1.0 : 0.75;
  const partFrac = 1 / 3;
  const end = opts.dataEnd ?? Infinity;

  // S1：第一個「收盤 < EMA20」的 12H（從進場那根起）→ 下一根 12H 開盤出場
  let sigExitT = Infinity;
  if (kind === 'S1' && opts.h12) {
    const f = opts.h12;
    const e = idxOf(f.bars, entryT);
    if (e >= 0) for (let j = e; j < f.bars.length; j++) if (f.bars[j].c < f.ema20[j]) { sigExitT = f.bars[j].t + H12; break; }
  }

  let cur = stop;
  let partial = false, partialT: number | null = null, be = false;
  let exitIdx = -1, exitPx = 0, reason: TradeSim['exitReason'] = 'open';
  let lastJ = h0;
  for (let j = h0; j < hourly.length && hourly[j].t < end; j++) {
    const b = hourly[j];
    if (b.t >= sigExitT) break;
    lastJ = j;
    if (kind === 'S3' && opts.daily) {
      // trail_stop[jd]（jd 日收盤算出）從 jd+1 日開盤起適用；只用進場那根日線（含）之後的
      const day = Math.floor(b.t / DAY) * DAY;
      const jd = idxOf(opts.daily.bars, day - DAY);
      if (jd >= 0 && opts.daily.bars[jd].t >= entryT && Number.isFinite(opts.daily.ll10[jd])) cur = Math.max(cur, opts.daily.ll10[jd]);
    }
    const sl = be ? Math.max(cur, entry) : cur;
    if (b.l <= sl) {
      exitIdx = j; exitPx = Math.min(b.o, sl);
      reason = sl === stop ? 'stop' : partial && sl === entry ? 'breakeven' : 'trail';
      break;
    }
    if (!partial && (b.h - entry) / risk >= partR) { partial = true; partialT = b.t; be = true; }
  }

  let exitT: number;
  if (exitIdx >= 0) exitT = hourly[exitIdx].t;
  else if (sigExitT !== Infinity && sigExitT < end) {
    const xb = idxOf(hourly, sigExitT);
    if (xb < 0) return { entry, risk, partial, partialT, exitT: NaN, exitPx: NaN, exitReason: 'open', grossR: NaN, netR: NaN, addR: null };
    exitPx = hourly[xb].o; exitT = sigExitT - H; reason = 'ema'; exitIdx = xb - 1;
  } else if (opts.forceCloseAtEnd) {
    exitPx = hourly[lastJ].c; exitT = hourly[lastJ].t; reason = 'open'; exitIdx = lastJ;
  } else {
    return { entry, risk, partial, partialT, exitT: NaN, exitPx: NaN, exitReason: 'open', grossR: NaN, netR: NaN, addR: null };
  }

  const rest = (exitPx - entry) / risk;
  const grossR = partial ? partFrac * partR + (1 - partFrac) * rest : rest;
  // engine._funding(t_in, exit_t + H)：結算時間 > t_in 且 < exit_t + H
  let fr = 0;
  for (const x of fund) if (x.t > entryT && x.t < exitT + H) fr += x.rate;
  const netR = grossR - (2 * COST * entry + fr * entry) / risk;

  let addR: number | null = null;
  if (opts.withAddon && kind === 'S3') addR = addonR(hourly, h0, exitT, entry, risk, partFrac, partR, grossR, fund);
  return { entry, risk, partial, partialT, exitT, exitPx, exitReason: reason, grossR, netR, addR };
}

/**
 * audit_s3b.addon_f（研究端參考表的版本）：價格到 E+1R 加一份，成交價 max(開盤, E+1R)，加碼單止損 = E；
 * 同一根碰到 E → 以 E 出場；之後碰到 E → min(開盤, E)；否則跟原單一起以原單出場價出場。
 * 扣進出各 0.07%，以及持有期間的資金費（結算時間 > 加碼那根開盤、< 出場那根 + 1H）。
 * 區間不含出場那根（參考實作 h1 = searchsorted(t, t_out)）。
 */
function addonR(hourly: Bar[], h0: number, exitT: number, entry: number, risk: number, pf: number, pr: number,
  grossR: number, fund: FundingPoint[]): number | null {
  const h1x = idxOf(hourly, exitT);
  const h1 = h1x >= 0 ? h1x : hourly.length;
  if (h1 <= h0) return null;
  let maxH = -Infinity;
  for (let j = h0; j < h1; j++) maxH = Math.max(maxH, hourly[j].h);
  const partial = (maxH - entry) / risk >= pr;
  const rRest = partial ? (grossR - pf * pr) / (1 - pf) : grossR;
  const exitPx = entry + rRest * risk;
  const lvl = entry + risk, stp = entry;
  let j = -1;
  for (let k = h0; k < h1; k++) if (hourly[k].h >= lvl) { j = k; break; }
  if (j < 0) return null;
  const px = Math.max(hourly[j].o, lvl);
  const arisk = px - stp;
  let ex: number, tEx: number;
  let later = -1;
  for (let k = j + 1; k < h1; k++) if (hourly[k].l <= stp) { later = k; break; }
  if (hourly[j].l <= stp) { ex = stp; tEx = hourly[j].t; }
  else if (later >= 0) { ex = Math.min(stp, hourly[later].o); tEx = hourly[later].t; }
  else { ex = exitPx; tEx = exitT; }
  let fr = 0;
  for (const x of fund) if (x.t > hourly[j].t && x.t < tEx + H) fr += x.rate;
  return (ex - px) / arisk - COST * (px + ex) / arisk - fr * px / arisk;
}

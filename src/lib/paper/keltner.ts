// 策略 A：日線 Keltner 突破、只做多（紙上）。
// 照 C:\trading_stratage\strategies.py keltner(stop="atr")、engine.py simulate/_walk、scan.py btc_regime 移植。
//
// 進場：日線收盤上穿 EMA20 + 2×ATR(10) 且 BTC「前一天」收盤 > EMA50 → 隔日開盤。
// 止損：訊號收盤 − 2×ATR(10)。1R 先平 1/3、剩餘止損移到進場價（下一根 1H 起生效）。
// 出場：日線收盤 < EMA20（含進場當天）→ 下一根日線開盤；或盤中止損（1H 判定，同根先算止損）。
import { emaSpan, wilderAtr, lastIndexAtOrBefore } from './ind';

export interface Bar { t: number; o: number; h: number; l: number; c: number; qv?: number }
export interface FundingPoint { t: number; rate: number }

const H = 3_600_000, D = 24 * H;
export const KELTNER = { EMA_N: 20, ATR_N: 10, MULT: 2, STOP_ATR: 2, PART_R: 1, PART_FRAC: 1 / 3, COST: 0.0007, MIN_BARS: 40 } as const;

/** BTC 大盤：key = 日線開盤時間 D → BTC 在 D 的前一天收盤 > 該天 EMA50 */
export function btcRegime(btcDaily: Bar[]): Map<number, boolean> {
  const c = btcDaily.map(b => b.c);
  const e = emaSpan(c, 50);
  const m = new Map<number, boolean>();
  btcDaily.forEach((b, i) => m.set(b.t + D, c[i] > e[i]));
  return m;
}

export interface KeltnerSignal { symbol: string; signalT: number; entryT: number; stop: number }

/** 已收盤日線上的所有訊號（不含大盤以外的過濾；幣池、持倉由呼叫端處理） */
export function keltnerSignals(symbol: string, daily: Bar[], regime: Map<number, boolean>): KeltnerSignal[] {
  if (daily.length < KELTNER.MIN_BARS) return [];
  const c = daily.map(b => b.c), h = daily.map(b => b.h), l = daily.map(b => b.l);
  const m = emaSpan(c, KELTNER.EMA_N);
  const a = wilderAtr(h, l, c, KELTNER.ATR_N);
  const up = m.map((x, i) => x + KELTNER.MULT * a[i]);
  const out: KeltnerSignal[] = [];
  const first = Math.max(KELTNER.EMA_N, KELTNER.ATR_N) + 5; // strategies.py: sig[:max(...)+5] = False
  for (let i = Math.max(first, 1); i < daily.length; i++) {
    if (!(c[i] > up[i] && c[i - 1] <= up[i - 1])) continue;
    if (regime.get(daily[i].t) !== true) continue;
    out.push({ symbol, signalT: daily[i].t, entryT: daily[i].t + D, stop: c[i] - KELTNER.STOP_ATR * a[i] });
  }
  return out;
}

export type KeltnerOutcome =
  | { status: 'skip'; reason: string }
  | { status: 'pending' }                       // 進場那根還沒開盤（資料還沒到）
  | { status: 'open'; entry: number; risk: number; partial: boolean; stopNow: number }
  | { status: 'done'; entry: number; risk: number; exitT: number; exitPx: number; partial: boolean;
      exitReason: 'stop' | 'breakeven' | 'ema'; grossR: number; netR: number };

/**
 * 單筆模擬。daily：該幣已收盤日線（需涵蓋訊號日到現在）；hourly：1H 已收盤 K 線（需涵蓋進場到現在）。
 * 規則與 engine.simulate 一致：exit_sig 從進場那根日線開始找；同一根 1H 先判止損；
 * 跳空越過止損以開盤價出場；1R 判定用 1H 最高價。
 */
export function simulateKeltner(sig: KeltnerSignal, daily: Bar[], hourly: Bar[], fund: FundingPoint[]): KeltnerOutcome {
  const T = daily.map(b => b.t);
  const eBar = T.indexOf(sig.entryT);
  const ht = hourly.map(b => b.t);
  const h0 = ht.indexOf(sig.entryT);
  if (h0 < 0) return hourly.length && ht[ht.length - 1] >= sig.entryT ? { status: 'skip', reason: '缺 1H 進場K線' } : { status: 'pending' };
  const entry = hourly[h0].o;
  const risk = entry - sig.stop;
  if (!Number.isFinite(risk) || risk <= entry * 0.002) return { status: 'skip', reason: '止損距離 < 0.2% 或在錯的一側' };

  // 收盤跌破 EMA20 → 下一根日線開盤出場（日線可能還沒收到進場那根，就當作還沒有出場訊號）
  let sigBar = -1;
  if (eBar >= 0) {
    const c = daily.map(b => b.c);
    const m = emaSpan(c, KELTNER.EMA_N);
    for (let j = eBar; j < daily.length; j++) if (c[j] < m[j]) { sigBar = j + 1; break; }
  }
  const sigT = sigBar >= 0 ? sig.entryT + (sigBar - eBar) * D : Infinity; // 出場那根日線的開盤時間

  // 走 1H：從進場那根到出場日線開盤之前
  let partial = false, be = false;
  for (let j = h0; j < hourly.length && hourly[j].t < sigT; j++) {
    const b = hourly[j];
    const sl = be ? Math.max(sig.stop, entry) : sig.stop;
    if (b.l <= sl) {
      const px = Math.min(b.o, sl);
      const rest = (px - entry) / risk;
      const gross = partial ? KELTNER.PART_FRAC * KELTNER.PART_R + (1 - KELTNER.PART_FRAC) * rest : rest;
      return finish(sig, entry, risk, b.t, px, partial, partial ? 'breakeven' : 'stop', gross, fund);
    }
    if (!partial && (b.h - entry) / risk >= KELTNER.PART_R) { partial = true; be = true; }
  }
  if (sigT !== Infinity) {
    const xb = hourly.find(b => b.t === sigT);
    if (!xb) return { status: 'open', entry, risk, partial, stopNow: partial ? entry : sig.stop }; // 出場那根 1H 還沒到
    const rest = (xb.o - entry) / risk;
    const gross = partial ? KELTNER.PART_FRAC * KELTNER.PART_R + (1 - KELTNER.PART_FRAC) * rest : rest;
    // engine.py：訊號出場的 exit_t 記為出場前最後一根 1H（= 前一天 23:00）
    return finish(sig, entry, risk, sigT - H, xb.o, partial, 'ema', gross, fund);
  }
  return { status: 'open', entry, risk, partial, stopNow: partial ? entry : sig.stop };
}

function finish(sig: KeltnerSignal, entry: number, risk: number, exitT: number, exitPx: number, partial: boolean,
  exitReason: 'stop' | 'breakeven' | 'ema', grossR: number, fund: FundingPoint[]): KeltnerOutcome {
  // engine._funding(t_in, exit_t + H)：結算時間 > t_in 且 < exit_t + H
  let f = 0;
  for (const x of fund) if (x.t > sig.entryT && x.t < exitT + H) f += x.rate;
  const netR = grossR - (2 * KELTNER.COST * entry + f * entry) / risk;
  return { status: 'done', entry, risk, exitT, exitPx, partial, exitReason, grossR, netR };
}

/** 30 日平均成交額（不含當天）——幣池排序與「同日多訊號」優先順序都用它 */
export function vol30Before(daily: Bar[], dayT: number): number | null {
  const i = lastIndexAtOrBefore(daily.map(b => b.t), dayT - D);
  if (i < 0) return null;
  const w = daily.slice(Math.max(0, i - 29), i + 1).filter(b => b.qv != null);
  if (w.length < 20) return null;
  return w.reduce((s, b) => s + (b.qv as number), 0) / w.length;
}

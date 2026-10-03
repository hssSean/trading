// 影片策略 A／B／C（交易倫 - AT）——紙上。
// 照 C:\trading_stratage\yt_strats.py 逐行移植（索引邏輯、迴圈邊界、跳躍方式都照抄，
// 因為規格的驗收 CSV 是那支程式輸出的）；執行照 ict_engine.simulate，但以 1H K 線執行
// （參考實作用 5 分鐘 K 線；規格寫的是 1H）。
//
// 時框對齊：1H 第 i 根「收盤時」可用的 4H／日線 = 收盤時間 ≤ 該 1H 收盤時間的最後一根。
import { emaSpan, wilderAtr, lastSwing, bosState } from './ind';

export interface Bar { t: number; o: number; h: number; l: number; c: number }
export interface FundingPoint { t: number; rate: number }

const H = 3_600_000, H4 = 4 * H, D = 24 * H;

export interface VideoOrder {
  strat: 'videoA' | 'videoB' | 'videoC';
  symbol: string;
  startT: number;   // 訂單生效（= 訊號 1H 收盤）時間，也是下一根 1H 的開盤
  side: 1 | -1;
  kind: 0 | 1;      // 0 市價（下一根開盤）、1 限價
  price: number;
  sl: number;
  tp: number;
  expiryT: number;  // 限價單：t < expiryT 的 1H 才能成交；市價單 = startT
  maxHoldBars: number;
}

export const VIDEO = { MAX_HOLD: 120, EXPIRY_H: 24, MAKER: 0.0002, TAKER: 0.0007 } as const;

interface Frames {
  G: Bar[]; F: Bar[]; Dd: Bar[];
  gAtr: number[];
  sF: number[]; sD: number[];
}

export function buildFrames(G: Bar[], F: Bar[], Dd: Bar[]): Frames {
  return {
    G, F, Dd,
    gAtr: wilderAtr(G.map(b => b.h), G.map(b => b.l), G.map(b => b.c), 14),
    sF: bosState(F.map(b => b.h), F.map(b => b.l), F.map(b => b.c), 3),
    sD: bosState(Dd.map(b => b.h), Dd.map(b => b.l), Dd.map(b => b.c), 3),
  };
}

/** 收盤時間 ≤ T 的最後一根（frame 的 K 棒長度 dur）；沒有回 −1。frame 依時間排序。 */
function closedIdx(frame: Bar[], dur: number, T: number): number {
  let lo = 0, hi = frame.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (frame[m].t + dur <= T) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

/** 大週期訂單流（mode both）：4H 與日線方向一致才回傳該方向，否則 0 */
function bias(fr: Frames, i: number): number {
  const T = fr.G[i].t + H;
  const fi = closedIdx(fr.F, H4, T), di = closedIdx(fr.Dd, D, T);
  if (fi < 0 || di < 0) return 0;
  const b4 = fr.sF[fi], bd = fr.sD[di];
  return b4 === bd ? b4 : 0;
}

const arr = (G: Bar[]) => ({ o: G.map(b => b.o), h: G.map(b => b.h), l: G.map(b => b.l), c: G.map(b => b.c) });

// ── A：BOS ＋ 斐波那契回調 ＋ 未回補 FVG（限價）─────────────────────────────
export function stratA(symbol: string, fr: Frames, p = { k: 3, fibLo: 0.5, fibHi: 0.786, tpR: 3, buf: 0.2, wait: 48 }): VideoOrder[] {
  const { h, l, c } = arr(fr.G);
  const n = fr.G.length;
  const atr = fr.gAtr;
  const { sh, sl: slw, shi, sli } = lastSwing(h, l, p.k);
  const rows: VideoOrder[] = [];
  for (const side of [1, -1] as const) {
    let i = p.k * 2 + 2;
    while (i < n - 1) {
      const prev = side === 1 ? sh[i - 1] : slw[i - 1];
      if (Number.isNaN(prev) || !((c[i] - prev) * side > 0 && (c[i - 1] - prev) * side <= 0)) { i++; continue; }
      if (bias(fr, i) !== side) { i++; continue; }
      const piv = side === 1 ? shi[i - 1] : sli[i - 1];
      let loI = piv;
      for (let q = piv; q <= i; q++) {
        if (side === 1 ? l[q] < l[loI] : h[q] > h[loI]) loI = q; // np.argmin/argmax：取第一個極值
      }
      const L = side === 1 ? l[loI] : h[loI];
      let ext = side === 1 ? h[i] : l[i];
      let placed = false;
      let j = i;
      for (j = i + 1; j < Math.min(i + p.wait, n - 1); j++) {
        // ⚠ 照參考實作：做空也用 l[j]（不是 h[j]）判斷波段起點被破——規格說「做空全部反過來」，
        // 但驗收 CSV 是這支程式產生的，改了就對不上。
        if ((l[j] - L) * side <= 0) break;
        const rng = (ext - L) * side;
        const zNear = ext - side * p.fibLo * rng;
        const zFar = ext - side * p.fibHi * rng;
        for (let q = j; q > loI + 1; q--) {
          let edge: number;
          if (side === 1 && l[q] > h[q - 2]) edge = l[q];
          else if (side === -1 && h[q] < l[q - 2]) edge = h[q];
          else continue;
          if (!((edge - zNear) * side <= 0 && (edge - zFar) * side >= 0)) continue;
          let mitigated = false;
          for (let r = q + 1; r <= j; r++) if (side === 1 ? l[r] <= edge : h[r] >= edge) { mitigated = true; break; }
          if (mitigated) continue;
          const stop = L - side * p.buf * atr[j];
          const risk = (edge - stop) * side;
          if (risk <= 0) continue;
          const startT = fr.G[j].t + H;
          rows.push({ strat: 'videoA', symbol, startT, side, kind: 1, price: edge, sl: stop, tp: edge + side * p.tpR * risk,
            expiryT: startT + VIDEO.EXPIRY_H * H, maxHoldBars: VIDEO.MAX_HOLD });
          placed = true;
          break;
        }
        if (placed) break;
        ext = side === 1 ? Math.max(ext, h[j]) : Math.min(ext, l[j]);
      }
      i = Math.max(i + 1, placed ? j : i + 1);
    }
  }
  return rows;
}

// ── B：流動性掃描 ＋ CHoCH ＋ 訂單塊（限價）────────────────────────────────
export function stratB(symbol: string, fr: Frames, p = { kInt: 2, kExt: 5, tpR: 3, buf: 0.2, chochWait: 12 }): VideoOrder[] {
  const { o, h, l, c } = arr(fr.G);
  const n = fr.G.length;
  const atr = fr.gAtr;
  const is = lastSwing(h, l, p.kInt), es = lastSwing(h, l, p.kExt);
  // 亞洲盤（UTC 00–08）高低點，08:00 之後才可用
  const asiaH = new Array<number>(n).fill(NaN), asiaL = new Array<number>(n).fill(NaN);
  let curD = -1, ah = -Infinity, al = Infinity;
  for (let i = 0; i < n; i++) {
    const t = fr.G[i].t, d = Math.floor(t / D), hour = Math.floor(t / H) % 24;
    if (d !== curD) { curD = d; ah = -Infinity; al = Infinity; }
    if (hour < 8) { ah = Math.max(ah, h[i]); al = Math.min(al, l[i]); }
    else if (ah > -Infinity) { asiaH[i] = ah; asiaL[i] = al; }
  }
  const rows: VideoOrder[] = [];
  let lastSig = -10;
  for (let i = p.kExt * 2 + 2; i < n - 1; i++) {
    const di = closedIdx(fr.Dd, D, fr.G[i].t); // 這根 1H 開盤前已收盤的那一天
    for (const side of [1, -1] as const) {
      if (bias(fr, i) !== side) continue;
      const cand: number[] = [];
      if (di >= 0) cand.push(side === 1 ? fr.Dd[di].l : fr.Dd[di].h);
      if (i > 0 && !Number.isNaN(asiaL[i - 1])) cand.push(side === 1 ? asiaL[i - 1] : asiaH[i - 1]);
      if (!Number.isNaN(es.sl[i - 1])) cand.push(side === 1 ? es.sl[i - 1] : es.sh[i - 1]);
      const swept = cand.filter(px => side === 1 ? (l[i] < px && px < c[i]) : (h[i] > px && px > c[i]));
      if (!swept.length || i - lastSig < 3) continue;
      let sweepPx = side === 1 ? l[i] : h[i];
      const lvl = side === 1 ? is.sh[i - 1] : is.sl[i - 1];
      if (Number.isNaN(lvl)) continue;
      for (let m = i; m < Math.min(i + p.chochWait, n - 1); m++) {
        if (side === 1 ? l[m] < sweepPx : h[m] > sweepPx) sweepPx = side === 1 ? l[m] : h[m];
        if ((c[m] - lvl) * side > 0) {
          let ep: number | null = null;
          for (let q = m; q >= i; q--) {
            if (side === 1 ? c[q] < o[q] : c[q] > o[q]) { ep = side === 1 ? h[q] : l[q]; break; }
          }
          if (ep == null || (c[m] - ep) * side <= 0) break;
          const stop = sweepPx - side * p.buf * atr[m];
          const risk = (ep - stop) * side;
          if (risk <= 0) break;
          const startT = fr.G[m].t + H;
          rows.push({ strat: 'videoB', symbol, startT, side, kind: 1, price: ep, sl: stop, tp: ep + side * p.tpR * risk,
            expiryT: startT + VIDEO.EXPIRY_H * H, maxHoldBars: VIDEO.MAX_HOLD });
          lastSig = m;
          break;
        }
      }
    }
  }
  return rows;
}

// ── C：多時框 EMA50 ＋ 1H MACD ＋ 每日樞軸點（市價）──────────────────────────
export function stratC(symbol: string, fr: Frames, p = { look: 6, minRr: 2, buf: 0.2, needD: false }): VideoOrder[] {
  const { h, l, c } = arr(fr.G);
  const n = fr.G.length;
  const atr = fr.gAtr;
  const e1 = emaSpan(c, 50);
  const fc = fr.F.map(b => b.c), dc = fr.Dd.map(b => b.c);
  const e4 = emaSpan(fc, 50), ed = emaSpan(dc, 50);
  const e12 = emaSpan(c, 12), e26 = emaSpan(c, 26);
  const macd = e12.map((x, i) => x - e26[i]);
  const sig = emaSpan(macd, 9);
  const hist = macd.map((x, i) => x - sig[i]);
  const rows: VideoOrder[] = [];
  let last = -10;
  for (let i = 60; i < n - 1; i++) {
    const T = fr.G[i].t + H;
    const fi = closedIdx(fr.F, H4, T), di = closedIdx(fr.Dd, D, T);
    if (fi < 50 || di < 50) continue;
    for (const side of [1, -1] as const) {
      if ((c[i] - e1[i]) * side <= 0 || (fc[fi] - e4[fi]) * side <= 0) continue;
      if (p.needD && (dc[di] - ed[di]) * side <= 0) continue;
      if (!(hist[i] * side > 0 && (hist[i] - hist[i - 1]) * side > 0)) continue;
      let touched = false;
      for (let q = i - p.look; q < i; q++) if (side === 1 ? l[q] <= e1[q] : h[q] >= e1[q]) { touched = true; break; }
      if (!touched || i - last < p.look) continue;
      const ep = c[i];
      let ext = side === 1 ? Infinity : -Infinity;
      for (let q = i - p.look; q <= i; q++) ext = side === 1 ? Math.min(ext, l[q]) : Math.max(ext, h[q]);
      const stop = ext - side * p.buf * atr[i];
      const risk = (ep - stop) * side;
      if (risk <= 0) continue;
      const dH = fr.Dd[di].h, dL = fr.Dd[di].l, dC = fr.Dd[di].c;
      const P = (dH + dL + dC) / 3;
      const lvls = side === 1
        ? [P, 2 * P - dL, P + (dH - dL), dH + 2 * (P - dL)]
        : [P, 2 * P - dH, P - (dH - dL), dL - 2 * (dH - P)];
      const ok = lvls.filter(x => (x - ep) * side > 0 && (x - ep) * side / risk >= p.minRr);
      if (!ok.length) continue;
      const tgt = side === 1 ? Math.min(...ok) : Math.max(...ok);
      rows.push({ strat: 'videoC', symbol, startT: T, side, kind: 0, price: ep, sl: stop, tp: tgt, expiryT: T, maxHoldBars: VIDEO.MAX_HOLD });
      last = i;
    }
  }
  return rows;
}

// ── 執行（ict_engine.simulate，以 1H）─────────────────────────────────────
export type ExecResult =
  | { status: 'pending' }                                     // 限價單還在有效期內、未成交
  | { status: 'nofill'; reason: 'expired' | 'tp_first' | 'bad_stop' }
  | { status: 'busy' }                                        // 同幣前一筆還在持倉
  | { status: 'open'; fillT: number; entry: number }
  | { status: 'done'; fillT: number; entry: number; exitT: number; exitPx: number; exitKind: 'stop' | 'target' | 'time';
      grossR: number; netR: number };

/**
 * 單筆執行。bars：該幣 1H 已收盤 K 線（依時間排序，需涵蓋 startT 到現在）。
 * 限價：先碰到止盈還沒成交 → 取消；成交價 = min(開盤, 掛單價)（做多）。
 * 成交後：止損從成交那根起算（同根成交又碰止損 = 虧損），止盈從下一根起算，同根先算止損；
 * 跳空越過止損（非成交那根）用開盤價；持有滿 maxHoldBars 根於收盤平倉。
 */
export function executeOrder(o: VideoOrder, bars: Bar[], fund: FundingPoint[]): ExecResult {
  const s = bars.findIndex(b => b.t >= o.startT);
  if (s < 0 || bars[s].t !== o.startT) return s < 0 ? { status: 'pending' } : { status: 'nofill', reason: 'expired' };
  const sd = o.side;
  let f = -1, ep = 0;
  if (o.kind === 0) { f = s; ep = bars[s].o; }
  else {
    for (let j = s; j < bars.length && bars[j].t < o.expiryT; j++) {
      const b = bars[j];
      if (sd === 1 && b.h >= o.tp && b.l > o.price) return { status: 'nofill', reason: 'tp_first' };
      if (sd === -1 && b.l <= o.tp && b.h < o.price) return { status: 'nofill', reason: 'tp_first' };
      if (sd === 1 ? b.l <= o.price : b.h >= o.price) {
        f = j;
        ep = sd === 1 ? Math.min(b.o, o.price) : Math.max(b.o, o.price);
        break;
      }
    }
    if (f < 0) {
      const lastT = bars[bars.length - 1].t;
      return lastT + H < o.expiryT ? { status: 'pending' } : { status: 'nofill', reason: 'expired' };
    }
  }
  if (sd === 1 ? ep <= o.sl : ep >= o.sl) return { status: 'nofill', reason: 'bad_stop' };
  const fillT = bars[f].t;
  const last = f + o.maxHoldBars - 1;
  for (let j = f; j <= last && j < bars.length; j++) {
    const b = bars[j];
    if (sd === 1 ? b.l <= o.sl : b.h >= o.sl) {
      let px = o.sl;
      if (j > f && (sd === 1 ? b.o < o.sl : b.o > o.sl)) px = b.o;
      return done(o, fillT, ep, b.t, px, 'stop', fund);
    }
    if (j > f && (sd === 1 ? b.h >= o.tp : b.l <= o.tp)) {
      let px = o.tp;
      if (sd === 1 ? b.o > o.tp : b.o < o.tp) px = b.o;
      return done(o, fillT, ep, b.t, px, 'target', fund);
    }
  }
  if (last < bars.length) return done(o, fillT, ep, bars[last].t, bars[last].c, 'time', fund);
  return { status: 'open', fillT, entry: ep };
}

function done(o: VideoOrder, fillT: number, entry: number, exitBarT: number, exitPx: number,
  exitKind: 'stop' | 'target' | 'time', fund: FundingPoint[]): ExecResult {
  const risk = Math.abs(entry - o.sl);
  const grossR = (exitPx - entry) * o.side / risk;
  const feeIn = o.kind === 0 ? VIDEO.TAKER : VIDEO.MAKER;
  const feeOut = exitKind === 'target' ? VIDEO.MAKER : VIDEO.TAKER;
  const tOut = exitBarT + H;
  let f = 0;
  for (const x of fund) if (x.t > fillT && x.t <= tOut) f += x.rate;
  const netR = grossR - (feeIn * entry + feeOut * exitPx + f * o.side * entry) / risk;
  return { status: 'done', fillT, entry, exitT: tOut, exitPx, exitKind, grossR, netR };
}

/**
 * 同一幣、同一策略的訂單依序執行（照 ict_engine：前一筆成交的出場之前生效的新訂單略過；
 * 未成交的掛單不擋後面的訂單）。回傳與 orders 對齊的結果。
 */
export function executeSequence(orders: VideoOrder[], bars: Bar[], fund: FundingPoint[], initialBusyUntil = -Infinity): ExecResult[] {
  const idx = orders.map((o, k) => ({ o, k })).sort((a, b) => a.o.startT - b.o.startT);
  const out = new Array<ExecResult>(orders.length);
  let busyUntil = initialBusyUntil; // 前一筆的出場 K 棒開盤時間（含）；跨次執行由呼叫端帶入
  let blocked = false;          // 前一筆還在持倉 → 之後的都擋
  let undecided = false;        // 前一筆限價還沒結果——它之後若成交會擋到後面的單，所以後面也先不判
  for (const { o, k } of idx) {
    if (undecided) { out[k] = { status: 'pending' }; continue; }
    if (blocked || o.startT <= busyUntil) { out[k] = { status: 'busy' }; continue; }
    const r = executeOrder(o, bars, fund);
    out[k] = r;
    if (r.status === 'open') blocked = true;
    if (r.status === 'done') busyUntil = r.exitT - H;
    if (r.status === 'pending') undecided = true;
  }
  return out;
}

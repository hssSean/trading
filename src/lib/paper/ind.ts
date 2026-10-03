// 紙上策略共用指標——逐行照 C:\trading_stratage 的 Python 參考實作移植。
// 公式差一點，訊號就對不上驗收 CSV，所以這裡不重用專案其他地方的 ema/atr。

/** pandas ewm(span=n, adjust=False)：ema[0] = x[0] */
export function emaSpan(x: number[], n: number): number[] {
  const a = 2 / (n + 1);
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) out[i] = i === 0 ? x[0] : a * x[i] + (1 - a) * out[i - 1];
  return out;
}

/**
 * Wilder ATR（pandas ewm(alpha=1/n, adjust=False)）：tr[0] = h[0] − l[0]，atr[0] = tr[0]。
 * engine.py 的 atr（prev close 第一根為 NaN → nanmax）與 msnr.frame（prev close 第一根用 c[0]）
 * 兩種寫法第一根都等於 h − l，所以一個函數就夠。
 */
export function wilderAtr(h: number[], l: number[], c: number[], n: number): number[] {
  const out = new Array<number>(h.length);
  for (let i = 0; i < h.length; i++) {
    const tr = i === 0 ? h[0] - l[0]
      : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    out[i] = i === 0 ? tr : out[i - 1] + (tr - out[i - 1]) / n;
  }
  return out;
}

export interface Swings { sh: number[]; sl: number[]; shi: number[]; sli: number[] }

/**
 * 分形擺動點（ict_engine.last_swing）：第 p 根是擺動高點 ⇔ high[p] 嚴格大於左右各 k 根；
 * 第 p+k 根收盤時才確認。回傳「截至第 i 根已確認的最近一個」擺動高／低點與其索引（無則 NaN／−1）。
 */
export function lastSwing(h: number[], l: number[], k: number): Swings {
  const n = h.length;
  const sh = new Array<number>(n), sl = new Array<number>(n), shi = new Array<number>(n), sli = new Array<number>(n);
  let ch = NaN, cl = NaN, chi = -1, cli = -1;
  for (let i = 0; i < n; i++) {
    const p = i - k;
    if (p - k >= 0) {
      let isH = true, isL = true;
      for (let j = p - k; j <= p + k; j++) {
        if (j === p) continue;
        if (h[j] >= h[p]) isH = false;
        if (l[j] <= l[p]) isL = false;
      }
      if (isH) { ch = h[p]; chi = p; }
      if (isL) { cl = l[p]; cli = p; }
    }
    sh[i] = ch; sl[i] = cl; shi[i] = chi; sli[i] = cli;
  }
  return { sh, sl, shi, sli };
}

/** yt_strats.bos_state：收盤站上上一個擺動高 → +1；跌破上一個擺動低 → −1；否則維持 */
export function bosState(h: number[], l: number[], c: number[], k: number): number[] {
  const { sh, sl } = lastSwing(h, l, k);
  const st = new Array<number>(c.length).fill(0);
  let cur = 0;
  for (let i = 1; i < c.length; i++) {
    if (!Number.isNaN(sh[i - 1]) && c[i] > sh[i - 1]) cur = 1;
    else if (!Number.isNaN(sl[i - 1]) && c[i] < sl[i - 1]) cur = -1;
    st[i] = cur;
  }
  return st;
}

/** 已排序的時間陣列中，最後一個 ≤ t 的索引；沒有回 −1 */
export function lastIndexAtOrBefore(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

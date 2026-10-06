// S3／S1 共用指標——逐行照 C:\trading_stratage 的 Python 參考實作移植。
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

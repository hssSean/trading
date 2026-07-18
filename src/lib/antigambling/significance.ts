// 移植自 core/verdict/statistics.py（逐函式對照）。
// 統計檢定：t 檢定（真正的 t 分布，經正則化不完全 beta）+ Bootstrap（shift method）。
// p 值語意：H0（你其實沒有優勢）成立時，純靠抽樣波動出現至少這麼極端結果的機率。

export const Z_ALPHA_ONE_SIDED = 1.6449;
export const Z_POWER_80 = 0.8416;
export const NEGATIVE_EDGE_SENTINEL = 9999;
export const MAX_BOOTSTRAP_DRAWS = 20_000_000;

export interface SignificanceResult {
  n: number;
  mean: number;
  std: number;
  tStat: number;
  pValueT: number;         // t 檢定單尾 p 值（H0: mean <= 0）
  pValueBootstrap: number; // H0 置中重抽下平均 >= 觀察值的比例（單尾）
  ciLow: number;           // bootstrap 95% CI 下界
  ciHigh: number;
  isSignificant: boolean;  // 兩檢定皆 p < alpha 且 mean > 0
}

// ── 數學基元（純手寫，不引依賴）──────────────────────────────

/** 標準常態 CDF（用 erf 的 Abramowitz-Stegun 7.1.26 近似不夠精準 —— 這裡用
 * 連分數級數實作的 erf，double 精度誤差 < 1e-15，與 Python math.erf 對齊）。 */
function erf(x: number): number {
  // 與 CPython mathmodule 同思路：|x| 小用級數，大用連分數餘項
  const ax = Math.abs(x);
  if (ax < 1.5) {
    // 泰勒級數：erf(x) = 2/√π · Σ (-1)^n x^(2n+1) / (n!(2n+1))
    let sum = x;
    let term = x;
    const x2 = x * x;
    for (let n = 1; n < 200; n++) {
      term *= -x2 / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum;
  }
  // 大 |x|：erfc 連分數（Lentz），erf = 1 - erfc
  const z = ax;
  let f = 0, c = 1e-30, d = 0;
  // erfc(z) = exp(-z²)/√π · 1/(z + 1/2/(z + 1/(z + 3/2/(z + ...))))
  let b = z;
  let a = 1;
  f = b || 1e-30;
  c = f; d = 0;
  for (let i = 1; i <= 300; i++) {
    a = i / 2;
    b = i % 2 === 0 ? z : z; // 連分數形式 b 恆為 z
    d = b + a * d;
    if (d === 0) d = 1e-30;
    c = b + a / c;
    if (c === 0) c = 1e-30;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  const erfc = Math.exp(-z * z) / Math.sqrt(Math.PI) / f;
  return x >= 0 ? 1 - erfc : erfc - 1;
}

export function normalCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.sqrt(2.0)));
}

/** lgamma（Lanczos 近似，g=7、n=9 系數；double 精度誤差 ~1e-13）。 */
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x: number): number {
  if (x < 0.5) {
    // 反射公式
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS_COEF[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEF.length; i++) a += LANCZOS_COEF[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 不完全 beta 連分數展開（Lentz 演算法）—— 對照 _betacf。 */
function betacf(a: number, b: number, x: number, maxIter = 200, eps = 1e-12): number {
  const tiny = 1e-30;
  const qab = a + b, qap = a + 1.0, qam = a - 1.0;
  let c = 1.0;
  let d = 1.0 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1.0 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1.0 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1.0 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1.0 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1.0 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1.0) < eps) break;
  }
  return h;
}

/** 正則化不完全 beta I_x(a,b) —— 對照 _reg_incomplete_beta。 */
export function regIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  const lnBeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(lnBeta + a * Math.log(x) + b * Math.log(1.0 - x));
  if (x < (a + 1.0) / (a + b + 2.0)) {
    return front * betacf(a, b, x) / a;
  }
  return 1.0 - front * betacf(b, a, 1.0 - x) / b;
}

/** Student-t 單尾存活函數 P(T > t) —— 對照 _student_t_sf（df 可為非整數，供 Welch）。 */
export function studentTSf(t: number, df: number): number {
  if (df <= 0) return 1.0;
  if (t === 0) return 0.5;
  const x = df / (df + t * t);
  const ib = regIncompleteBeta(x, df / 2.0, 0.5);
  if (t > 0) return 0.5 * ib;
  return 1.0 - 0.5 * ib;
}

// ── 可注入 seed 的 PRNG（mulberry32）────────────────────────
// Python 版用 Mersenne Twister；spec §9 明訂 bootstrap 不要求逐位一致，
// 只要求固定 seed 下 p 值差 < 0.02 且裁決相同。
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 檢定「每筆平均損益是否顯著大於 0」—— 對照 test_expectancy_positive。 */
export function testExpectancyPositive(
  pnls: number[],
  opts: { nBootstrap?: number; alpha?: number; seed?: number } = {},
): SignificanceResult {
  const alpha = opts.alpha ?? 0.05;
  let nBootstrap = opts.nBootstrap ?? 5000;
  const seed = opts.seed ?? 1234; // 跟隨原始碼：固定 1234，結果可重現

  if (nBootstrap < 1) throw new Error(`n_bootstrap 必須 >= 1，收到 ${nBootstrap}`);

  const n = pnls.length;
  if (n === 0) {
    return { n: 0, mean: 0, std: 0, tStat: 0, pValueT: 1.0, pValueBootstrap: 1.0, ciLow: 0, ciHigh: 0, isSignificant: false };
  }

  let sum = 0;
  for (const p of pnls) sum += p;
  const mean = sum / n;
  if (n < 2) {
    return { n, mean, std: 0.0, tStat: 0.0, pValueT: 1.0, pValueBootstrap: 1.0, ciLow: mean, ciHigh: mean, isSignificant: false };
  }

  if (n * nBootstrap > MAX_BOOTSTRAP_DRAWS) {
    nBootstrap = Math.max(1000, Math.floor(MAX_BOOTSTRAP_DRAWS / n));
  }

  let varAcc = 0;
  for (const p of pnls) varAcc += (p - mean) ** 2;
  const variance = varAcc / (n - 1);
  const std = Math.sqrt(variance);

  // ── t 檢定 ──
  const se = std > 0 ? std / Math.sqrt(n) : 0.0;
  let tStat: number;
  let pT: number;
  if (se > 0) {
    tStat = mean / se;
    pT = studentTSf(tStat, n - 1);
  } else {
    tStat = mean > 0 ? Infinity : mean < 0 ? -Infinity : 0.0;
    pT = mean > 0 ? 0.0 : 1.0;
  }

  // ── Bootstrap（shift method：樣本平移到 H0 均值 0 再重抽）──
  const rng = mulberry32(seed);
  const shifted = pnls.map(p => p - mean);
  const bootMeans: number[] = [];
  let nGeObs = 0;
  for (let b = 0; b < nBootstrap; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += shifted[Math.floor(rng() * n)];
    const bm0 = s / n;
    if (bm0 >= mean) nGeObs++;
    bootMeans.push(bm0 + mean);
  }
  bootMeans.sort((a, b) => a - b);
  // (n+1)/(B+1) 修正：蒙地卡羅 p 值不印「恰好 0」的假精準
  const pBoot = (nGeObs + 1) / (nBootstrap + 1);

  const loIdx = Math.trunc((alpha / 2) * nBootstrap);
  const hiIdx = Math.min(Math.trunc((1 - alpha / 2) * nBootstrap), nBootstrap - 1);
  const ciLow = bootMeans[loIdx];
  const ciHigh = bootMeans[hiIdx];

  const isSig = pT < alpha && pBoot < alpha && mean > 0;

  return { n, mean, std, tStat, pValueT: pT, pValueBootstrap: pBoot, ciLow, ciHigh, isSignificant: isSig };
}

/** 二項模型粗估所需樣本量 —— 對照 required_sample_size。 */
export function requiredSampleSize(winRate: number, payoffRatio: number): number {
  if (winRate <= 0 || winRate >= 1 || payoffRatio <= 0 || !Number.isFinite(payoffRatio)) {
    return 100;
  }
  const edge = winRate * payoffRatio - (1 - winRate);
  if (edge <= 0) return NEGATIVE_EDGE_SENTINEL;
  const variance =
    winRate * (payoffRatio - edge) ** 2 +
    (1 - winRate) * (-1 - edge) ** 2;
  const sd = Math.sqrt(variance);
  const n = ((Z_ALPHA_ONE_SIDED + Z_POWER_80) * sd / edge) ** 2;
  return Math.max(30, Math.ceil(n));
}

/** 用真實損益樣本變異估算所需樣本量 —— 對照 required_sample_size_from_pnls。 */
export function requiredSampleSizeFromPnls(
  pnls: number[],
  opts: { alpha?: number; power?: number } = {},
): number | null {
  const power = opts.power ?? 0.8;
  const n = pnls.length;
  if (n < 2) return null;
  let sum = 0;
  for (const p of pnls) sum += p;
  const mean = sum / n;
  if (mean <= 0) return null;
  let varAcc = 0;
  for (const p of pnls) varAcc += (p - mean) ** 2;
  const std = Math.sqrt(varAcc / (n - 1));
  if (std === 0) return 30;
  let z = Z_ALPHA_ONE_SIDED + Z_POWER_80;
  if (Math.abs(power - 0.8) > 1e-9) z = Z_ALPHA_ONE_SIDED + zFromPower(power);
  const need = (z * std / mean) ** 2;
  return Math.max(30, Math.ceil(need));
}

function zFromPower(power: number): number {
  let lo = -6.0, hi = 6.0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < power) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

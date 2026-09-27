/** R 倍數的統計工具（verify-strategy.ts／strategy-candidates.ts 共用） */

export const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
export const f = (x: number, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
export const tStat = (a: number[]) => { const s = sd(a); return a.length > 1 && s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
export function bootstrapCI(a: number[], iters = 10_000): [number, number] {
  if (a.length < 2) return [NaN, NaN];
  const r = rng(42);
  const ms: number[] = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let j = 0; j < a.length; j++) s += a[Math.floor(r() * a.length)]; ms.push(s / a.length); }
  ms.sort((x, y) => x - y);
  return [ms[Math.floor(iters * 0.025)], ms[Math.floor(iters * 0.975)]];
}

export interface Summary { n: number; mean: number; t: number; ci: [number, number]; win: number; pf: number }
export function summarize(rs: number[]): Summary {
  const pos = rs.filter(x => x > 0).reduce((q, x) => q + x, 0);
  const neg = -rs.filter(x => x < 0).reduce((q, x) => q + x, 0);
  return { n: rs.length, mean: mean(rs), t: tStat(rs), ci: bootstrapCI(rs), win: rs.filter(x => x > 0).length / (rs.length || 1), pf: neg > 0 ? pos / neg : Infinity };
}
export function row(label: string, rs: number[]): string {
  if (rs.length === 0) return `  ${label.padEnd(18)} n=0`;
  const s = summarize(rs);
  return `  ${label.padEnd(18)} n=${String(s.n).padStart(4)}  每筆 ${f(s.mean).padStart(7)}R  t=${f(s.t, 2).padStart(6)}  95%CI [${f(s.ci[0])}, ${f(s.ci[1])}]  勝率 ${(100 * s.win).toFixed(1).padStart(5)}%  PF ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}  合計 ${f(rs.reduce((q, x) => q + x, 0), 1)}R`;
}
export function maxDrawdownR(rs: number[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}

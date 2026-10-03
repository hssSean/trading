// 紙上策略的統計——App 頁面（/api/paper-stats）用。規格對照數字與判準跟 scripts/paper-report.ts 同口徑，
// 改其中一邊時另一邊要一起改。

export type PaperStratKey = 'strategyA' | 'videoA' | 'videoB' | 'videoC';
export const PAPER_STRATS: PaperStratKey[] = ['strategyA', 'videoA', 'videoB', 'videoC'];

export const PAPER_SPEC: Record<PaperStratKey, {
  name: string; short: string; perWk: number; win: number; avgR: number; minN: number; rule: string;
}> = {
  strategyA: { name: '策略 A｜日線 Keltner 突破（只做多）', short: '策略 A', perWk: 2.2, win: 0.51, avgR: 0.35, minN: 50,
    rule: '滿 50 筆後勝率 < 45% 或每筆平均 < 0 → 停止' },
  videoA: { name: '影片 A｜BOS＋斐波那契＋FVG', short: '影片 A', perWk: 43.4, win: 0.28, avgR: -0.03, minN: 100,
    rule: '滿 100 筆後每筆 > +0.15R 且勝率明顯優於回測才考慮小資金' },
  videoB: { name: '影片 B｜流動性掃描＋CHoCH＋訂單塊', short: '影片 B', perWk: 26.7, win: 0.26, avgR: -0.08, minN: 100,
    rule: '滿 100 筆後每筆 > +0.15R 且勝率明顯優於回測才考慮小資金' },
  videoC: { name: '影片 C｜EMA50＋MACD＋樞軸點', short: '影片 C', perWk: 96.9, win: 0.32, avgR: -0.01, minN: 100,
    rule: '滿 100 筆後每筆 > +0.15R 且勝率明顯優於回測才考慮小資金' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PaperRecord = Record<string, any>;

export interface PaperSummary {
  key: PaperStratKey;
  total: number;
  counts: { done: number; open: number; pending: number; nofill: number; busy: number; skip: number };
  perWk: number;
  win: number | null;
  avgR: number | null;
  avgGrossR: number | null;
  sumR: number;
  payoff: number | null;
  maxDdR: number;
  /** 'early'：筆數不足；'fail'：觸發停止條件；'pass'：達放行條件；'neutral'：夠多筆但沒觸發也沒達標 */
  verdict: 'early' | 'fail' | 'pass' | 'neutral';
  verdictText: string;
}

export function summarizePaper(key: PaperStratKey, records: PaperRecord[], trackStart: number, now: number): PaperSummary {
  const c = { done: 0, open: 0, pending: 0, nofill: 0, busy: 0, skip: 0 };
  for (const r of records) if (r.status in c) c[r.status as keyof typeof c]++;
  const done = records.filter(r => r.status === 'done').sort((a, b) => a.exitT - b.exitT);
  const net = done.map(r => Number(r.netR));
  const weeks = Math.max((now - trackStart) / (7 * 86_400_000), 1 / 7);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const wins = net.filter(x => x > 0), losses = net.filter(x => x <= 0);
  let eq = 0, peak = 0, dd = 0;
  for (const x of net) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const spec = PAPER_SPEC[key];
  const win = net.length ? wins.length / net.length : null;
  const avgR = avg(net);
  let verdict: PaperSummary['verdict'] = 'early';
  let verdictText = `還不能判（${done.length}/${spec.minN} 筆）`;
  if (done.length >= spec.minN && win != null && avgR != null) {
    if (key === 'strategyA') {
      verdict = win < 0.45 || avgR < 0 ? 'fail' : 'neutral';
      verdictText = verdict === 'fail' ? '⚠ 觸發停止條件，應停止並檢查' : '未觸發停止條件，繼續觀察';
    } else {
      verdict = avgR > 0.15 && win > spec.win + 0.05 ? 'pass' : 'fail';
      verdictText = verdict === 'pass' ? '達標，可考慮小資金' : '未達標，應停止';
    }
  }
  return {
    key, total: records.length, counts: c, perWk: done.length / weeks,
    win, avgR, avgGrossR: avg(done.map(r => Number(r.grossR))), sumR: net.reduce((a, b) => a + b, 0),
    payoff: wins.length && losses.length ? avg(wins)! / -avg(losses)! : null,
    maxDdR: dd, verdict, verdictText,
  };
}

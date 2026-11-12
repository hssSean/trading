import { describe, expect, it } from 'vitest';
import { ctrendStatusLine, ctrendSummary, decideCtrendAlert, type CtrendMeta, type CtrendWeek } from '@/lib/ctrend/view';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20);
const meta = (lastRun: number, extra: Partial<CtrendMeta> = {}): CtrendMeta => ({
  lastRun, lastWeek: '2026-11-16', weeks: 3, meanNet: 0.01, tNet: 1.2, startWeek: '2026-10-26', version: 1, ...extra,
});
const wk = (d: string, net: number): CtrendWeek => ({
  wk: d, gross: net, net, fund: 0, turnover: 1, nLong: 10, nShort: 10, nUniverse: 50, kept: 12, skipped: 0, top100: { gross: net, net },
});

describe('ctrendSummary', () => {
  it('累積、最近新到舊、多空前 5', () => {
    const weeks = [wk('2026-11-02', -0.02), wk('2026-10-26', 0.1), wk('2026-11-09', 0.05)];
    const open = {
      wk: '2026-11-16',
      long: [['A', 0.1], ['B', 0.3], ['C', 0.05], ['D', 0.2], ['E', 0.15], ['F', 0.2]] as [string, number][],
      short: [['X', -0.6], ['Y', -0.4]] as [string, number][],
    };
    const s = ctrendSummary(meta(NOW), weeks, open, NOW);
    expect(s.cumNet).toBeCloseTo(1.1 * 0.98 * 1.05 - 1, 12);
    expect(s.recent.map(w => w.wk)).toEqual(['2026-11-09', '2026-11-02', '2026-10-26']);
    expect(s.topLong).toEqual(['B', 'D', 'F', 'E', 'A']);
    expect(s.topShort).toEqual(['X', 'Y']);
    expect(s.openWeek).toBe('2026-11-16');
  });
  it('stale 邊界：8 天整不算、多 1 毫秒算', () => {
    expect(ctrendSummary(meta(NOW - 8 * DAY), [], null, NOW).stale).toBe(false);
    expect(ctrendSummary(meta(NOW - 8 * DAY - 1), [], null, NOW).stale).toBe(true);
    expect(ctrendSummary(null, [], null, NOW).stale).toBe(false);
  });
});

describe('decideCtrendAlert', () => {
  it('沒資料不吵、剛更新不吵、超過 9 天推播', () => {
    expect(decideCtrendAlert(null, NOW)).toBe(false);
    expect(decideCtrendAlert(meta(NOW - DAY), NOW)).toBe(false);
    expect(decideCtrendAlert(meta(NOW - 9 * DAY), NOW)).toBe(false);
    expect(decideCtrendAlert(meta(NOW - 9 * DAY - 1), NOW)).toBe(true);
  });
});

describe('ctrendStatusLine', () => {
  it('沒跑過、正常、停擺', () => {
    expect(ctrendStatusLine(null, NOW)).toContain('還沒跑過');
    expect(ctrendStatusLine(meta(NOW - DAY), NOW)).not.toContain('⚠');
    expect(ctrendStatusLine(meta(NOW - 8 * DAY - 1), NOW)).toContain('⚠');
    expect(ctrendStatusLine(meta(NOW, { tNet: null }), NOW)).toContain('t —');
  });
});

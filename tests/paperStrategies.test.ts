import { describe, it, expect } from 'vitest';
import { emaSpan, wilderAtr, lastSwing } from '../src/lib/paper/ind';
import { simulateKeltner, vol30Before, type Bar } from '../src/lib/paper/keltner';
import { executeOrder, executeSequence, type VideoOrder } from '../src/lib/paper/video';
import { dueJob, universeFor, runVideo, runStrategyA, type PaperStore, type PaperDeps } from '../src/lib/paper/runner';

const H = 3_600_000, D = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, qv = 0): Bar => ({ t, o, h, l, c, qv });
const flatHours = (t0: number, n: number, px = 100) => Array.from({ length: n }, (_, i) => bar(t0 + i * H, px, px + 0.5, px - 0.5, px));

describe('ind', () => {
  it('emaSpan matches pandas ewm(adjust=False): seeded with first value', () => {
    expect(emaSpan([10, 20], 3)).toEqual([10, 15]); // alpha = 0.5
  });
  it('wilderAtr: first value is high-low, then RMA with 1/n', () => {
    const a = wilderAtr([12, 14], [10, 11], [11, 13], 2);
    expect(a[0]).toBe(2);
    expect(a[1]).toBe(2 + (3 - 2) / 2); // tr = max(3, |14-11|, |11-11|) = 3
  });
  it('lastSwing requires a strictly higher high (ties are not swings) and confirms k bars later', () => {
    const h = [1, 2, 5, 2, 1, 1], l = [0, 0, 0, 0, 0, 0];
    const s = lastSwing(h, l, 2);
    expect(Number.isNaN(s.sh[3])).toBe(true); // not confirmed yet
    expect(s.sh[4]).toBe(5);
    expect(s.shi[4]).toBe(2);
    const tie = lastSwing([1, 5, 5, 1, 1], [0, 0, 0, 0, 0], 1);
    expect(tie.sh.every(x => Number.isNaN(x))).toBe(true);
  });
});

describe('simulateKeltner', () => {
  const t0 = 100 * D;
  const sig = { symbol: 'X', signalT: t0 - D, entryT: t0, stop: 90 };
  const daily = (closes: number[]) => closes.map((c, i) => bar(t0 - 30 * D + i * D, c, c + 1, c - 1, c));

  it('pending until the entry bar exists', () => {
    expect(simulateKeltner(sig, daily(Array(30).fill(100)), [], []).status).toBe('pending');
  });
  it('partial at 1R then breakeven stop: books 1/3 × 1R', () => {
    const hours = flatHours(t0, 10);
    hours[1] = bar(t0 + H, 100, 111, 99, 105);   // risk = 10 → 1R = 110
    hours[3] = bar(t0 + 3 * H, 104, 104, 99, 100); // back through entry → breakeven
    const o = simulateKeltner(sig, daily(Array(31).fill(200)), hours, []);
    expect(o.status).toBe('done');
    if (o.status === 'done') {
      expect(o.exitReason).toBe('breakeven');
      expect(o.grossR).toBeCloseTo(1 / 3, 6);
    }
  });
  it('same 1H bar touching stop and 1R counts as stop', () => {
    const hours = flatHours(t0, 5);
    hours[1] = bar(t0 + H, 100, 115, 85, 100);
    const o = simulateKeltner(sig, daily(Array(31).fill(200)), hours, []);
    expect(o.status === 'done' && o.exitReason === 'stop' && o.grossR).toBe(-1);
  });
  it('gap below the stop fills at the open', () => {
    const hours = flatHours(t0, 5);
    hours[2] = bar(t0 + 2 * H, 80, 81, 79, 80);
    const o = simulateKeltner(sig, daily(Array(31).fill(200)), hours, []);
    expect(o.status === 'done' && o.grossR).toBeCloseTo(-2, 6);
  });
  it('close below EMA20 exits at next day open', () => {
    const closes = [...Array(30).fill(200), 50]; // entry day closes far below EMA20
    const hours = flatHours(t0, 30);
    const o = simulateKeltner(sig, daily(closes), hours, []);
    expect(o.status === 'done' && o.exitReason).toBe('ema');
    if (o.status === 'done') expect(o.exitT).toBe(t0 + D - H);
  });
  it('vol30Before ignores the day itself and needs ≥ 20 days', () => {
    const d = Array.from({ length: 25 }, (_, i) => bar(i * D, 1, 1, 1, 1, i === 24 ? 1e9 : 10));
    expect(vol30Before(d, 24 * D)).toBe(10);
    expect(vol30Before(d.slice(0, 10), 10 * D)).toBeNull();
  });
});

describe('video executeOrder', () => {
  const t0 = 1000 * H;
  const limitLong = (o: Partial<VideoOrder> = {}): VideoOrder => ({
    strat: 'videoA', symbol: 'X', startT: t0, side: 1, kind: 1, price: 100, sl: 95, tp: 115,
    expiryT: t0 + 24 * H, maxHoldBars: 120, ...o,
  });

  it('target reached before the limit fills → cancelled', () => {
    const b = flatHours(t0, 30, 110);
    b[0] = bar(t0, 110, 116, 105, 112);
    expect(executeOrder(limitLong(), b, [])).toEqual({ status: 'nofill', reason: 'tp_first' });
  });
  it('fill and stop in the same bar is a loss (stop checked from the fill bar)', () => {
    const b = flatHours(t0, 30, 105);
    b[1] = bar(t0 + H, 104, 104, 94, 96);
    const r = executeOrder(limitLong(), b, []);
    expect(r.status === 'done' && r.exitKind).toBe('stop');
    expect(r.status === 'done' && r.grossR).toBeCloseTo(-1, 6);
  });
  it('target is only checked from the bar after the fill', () => {
    const b = flatHours(t0, 30, 105);
    b[1] = bar(t0 + H, 101, 116, 99, 110);       // fills at 100 and touches tp in the same bar
    b[2] = bar(t0 + 2 * H, 110, 116, 109, 115);
    const r = executeOrder(limitLong(), b, []);
    expect(r.status === 'done' && r.exitKind).toBe('target');
    expect(r.status === 'done' && r.exitT).toBe(t0 + 3 * H);
  });
  it('still pending inside the expiry window when data runs out', () => {
    expect(executeOrder(limitLong(), flatHours(t0, 3, 105), []).status).toBe('pending');
  });
  it('expires after 24h without a fill', () => {
    expect(executeOrder(limitLong(), flatHours(t0, 30, 105), [])).toEqual({ status: 'nofill', reason: 'expired' });
  });
  it('time exit at the close of the 120th held bar', () => {
    const r = executeOrder(limitLong({ kind: 0, maxHoldBars: 5 }), flatHours(t0, 10, 100), []);
    expect(r.status === 'done' && r.exitKind).toBe('time');
    expect(r.status === 'done' && r.exitT).toBe(t0 + 5 * H);
  });
  it('sequence: an open position blocks later orders; a pending limit defers them', () => {
    const b = flatHours(t0, 10, 100);
    const open = limitLong({ kind: 0 });
    const later = limitLong({ kind: 0, startT: t0 + 2 * H });
    expect(executeSequence([open, later], b, []).map(r => r.status)).toEqual(['open', 'busy']);
    const pend = limitLong({ price: 90, sl: 85, tp: 200 });
    expect(executeSequence([pend, later], flatHours(t0, 5, 100), []).map(r => r.status)).toEqual(['pending', 'pending']);
  });
});

class MemStore implements PaperStore {
  m = new Map<string, Map<string, string>>();
  async hgetall(k: string) { const x = this.m.get(k); return x && x.size ? Object.fromEntries(x) : null; }
  async hset(k: string, kv: Record<string, string>) { if (!this.m.has(k)) this.m.set(k, new Map()); for (const [a, b] of Object.entries(kv)) this.m.get(k)!.set(a, b); return 1; }
  async hdel(k: string, ...f: string[]) { for (const x of f) this.m.get(k)?.delete(x); return 1; }
}
const fakeDeps: PaperDeps = {
  tickers: async () => [{ symbol: 'BTCUSDT', quoteVolume: 1e9 }, { symbol: 'AAPLUSDT', quoteVolume: 9e9 }],
  klines: async (_s, interval, limit) => {
    const step = interval === '1d' ? D : interval === '4h' ? 4 * H : H;
    const end = Math.floor(Date.UTC(2026, 9, 3) / step) * step;
    return Array.from({ length: limit }, (_, i) => bar(end - (limit - i) * step, 100, 101, 99, 100, 1e6));
  },
  funding: async () => [],
};

describe('runner', () => {
  it('dueJob: nothing before 00:20 UTC, then strategyA, then video, then done', () => {
    const day = Date.UTC(2026, 9, 3);
    expect(dueJob({}, day + 10 * 60_000)).toBeNull();
    expect(dueJob({}, day + 30 * 60_000)).toBe('strategyA');
    expect(dueJob({ 'strategyA.lastRunDay': day }, day + 30 * 60_000)).toBe('video');
    expect(dueJob({ 'strategyA.lastRunDay': day, 'video.lastRunDay': day }, day + 30 * 60_000)).toBeNull();
  });
  it('first run only records the starting point — no backfill', async () => {
    const st = new MemStore();
    const now = Date.UTC(2026, 9, 3, 0, 30);
    const a = await runStrategyA(st, fakeDeps, now);
    const v = await runVideo(st, fakeDeps, now);
    expect(a.initialized && v.initialized).toBe(true);
    expect(a.newRecords + v.newRecords).toBe(0);
    expect(st.m.get('paper:meta')!.get('strategyA.lastT')).toBe(String(Date.UTC(2026, 9, 2)));
  });
  it('universeFor excludes coins with < 30 days and ranks by 30d average quote volume', () => {
    const mk = (n: number, qv: number) => Array.from({ length: n }, (_, i) => bar(i * D, 1, 1, 1, 1, qv));
    const u = universeFor(40 * D, new Map([['A', mk(40, 5)], ['B', mk(40, 9)], ['NEW', mk(20, 99)]]), 1);
    expect(u.map(x => x.symbol)).toEqual(['B']);
  });
});

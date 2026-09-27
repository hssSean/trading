import { describe, it, expect } from 'vitest';
import {
  F1, f1Direction, f1EntryTime, simulateHold, resolveF1Trade, detectF1Signals, f1ResolvableAt,
  type Bar, type F1PaperTrade,
} from '../src/lib/f1Paper';

const H4 = 4 * 3_600_000;
const flatWindow = (v = 0.0001) => new Array(F1.WINDOW).fill(v);

function bars(n: number, t0: number, px = 100, range = 1): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: t0 + i * H4, open: px, high: px + range / 2, low: px - range / 2, close: px, closeTime: t0 + (i + 1) * H4 - 1,
  }));
}

describe('f1Direction', () => {
  it('extreme positive funding (crowded longs) → contrarian short', () => {
    expect(f1Direction(flatWindow(), 0.001)).toBe(-1);
  });
  it('extreme negative funding (crowded shorts) → contrarian long', () => {
    expect(f1Direction(flatWindow(), -0.0005)).toBe(1);
  });
  it('requires absolute floors, not only percentile: top of window but only 0.02% → no trade', () => {
    const w = Array.from({ length: F1.WINDOW }, (_, i) => i * 0.000001);
    expect(f1Direction(w, 0.0002)).toBe(0);
  });
  it('needs a full window', () => {
    expect(f1Direction(flatWindow().slice(1), 0.01)).toBe(0);
  });
  it('does not mutate the caller window', () => {
    const w = [0.0003, ...flatWindow().slice(1)];
    f1Direction(w, 0.001);
    expect(w[0]).toBe(0.0003);
  });
});

describe('f1EntryTime', () => {
  it('settlement on a 4h boundary enters that bar', () => {
    expect(f1EntryTime(10 * H4)).toBe(10 * H4);
  });
  it('settlement a few ms late (exchange jitter) rounds up to the next bar', () => {
    expect(f1EntryTime(10 * H4 + 5)).toBe(11 * H4);
  });
});

describe('simulateHold', () => {
  it('holds to the last bar when stop is never touched', () => {
    const c = bars(30, 0);
    const r = simulateHold(c, 5, 1, 10, 18, [])!;
    expect(r.exitIdx).toBe(5 + 18 - 1);
    expect(r.stopped).toBe(false);
  });
  it('entry bar touching the stop counts as stopped (pessimistic)', () => {
    const c = bars(30, 0);
    c[5] = { ...c[5], low: 80 };
    const r = simulateHold(c, 5, 1, 5, 18, [])!;
    expect(r.stopped).toBe(true);
    expect(r.exitIdx).toBe(5);
    expect(r.grossR).toBeLessThan(-1); // stop slippage makes it worse than -1R
  });
  it('gap through the stop exits at the open, not the stop price', () => {
    const c = bars(30, 0);
    c[7] = { ...c[7], open: 90, low: 89, high: 91, close: 90 };
    const r = simulateHold(c, 5, 1, 5, 18, [])!;
    expect(r.exitIdx).toBe(7);
    expect(r.grossR).toBeLessThan(-1.9);
  });
  it('funding is charged to longs when positive and credited when negative', () => {
    const c = bars(30, 0);
    const pay = simulateHold(c, 5, 1, 10, 18, [{ t: c[6].openTime, rate: 0.001 }])!;
    const recv = simulateHold(c, 5, 1, 10, 18, [{ t: c[6].openTime, rate: -0.001 }])!;
    expect(recv.netR).toBeGreaterThan(pay.netR);
    expect(pay.grossR).toBeCloseTo(recv.grossR, 10);
  });
  it('returns null when data ends before the hold completes', () => {
    expect(simulateHold(bars(20, 0), 5, 1, 10, 18, [])).toBeNull();
  });
});

describe('detectF1Signals', () => {
  const fund = (rates: number[]) => rates.map((rate, i) => ({ t: i * 2 * H4, rate })); // 8h settlements

  it('only emits settlements after lastProcessedT', () => {
    const rates = [...flatWindow(), -0.001, 0.0001, -0.001];
    const f = fund(rates);
    const all = detectF1Signals('X', f, -1, -Infinity);
    expect(all.length).toBeGreaterThan(0);
    const later = detectF1Signals('X', f, f[F1.WINDOW].t, -Infinity);
    expect(later.every(s => s.settlementT > f[F1.WINDOW].t)).toBe(true);
  });
  it('one position per symbol: a second signal inside the hold window is skipped', () => {
    const rates = [...flatWindow(), -0.001, -0.001];
    const s = detectF1Signals('X', fund(rates), -1, -Infinity);
    expect(s.length).toBe(1);
  });
  it('respects busyUntil carried over from an existing open trade', () => {
    const rates = [...flatWindow(), -0.001];
    const f = fund(rates);
    expect(detectF1Signals('X', f, -1, f1EntryTime(f[F1.WINDOW].t) + 1)).toHaveLength(0);
  });
});

describe('resolveF1Trade', () => {
  const t0 = 0;
  const trade = (entryT: number): F1PaperTrade => ({ id: 'X:1', symbol: 'X', dir: 1, settlementT: entryT, fundingRate: -0.001, entryT, status: 'open' });

  it('returns null until enough bars exist after entry', () => {
    const c = bars(30, t0);
    expect(resolveF1Trade(trade(c[25].openTime), c, [], 0)).toBeNull();
  });
  it('resolves to done with R once the hold window is covered', () => {
    const c = bars(60, t0);
    const r = resolveF1Trade(trade(c[25].openTime), c, [], 123)!;
    expect(r.status).toBe('done');
    expect(r.resolvedAt).toBe(123);
    expect(Number.isFinite(r.netR)).toBe(true);
    expect(r.exitT).toBe(c[25 + F1.HOLD_BARS - 1].closeTime);
  });
  it('resolvableAt is after the last held bar', () => {
    expect(f1ResolvableAt({ entryT: 100 * H4 })).toBe(100 * H4 + F1.HOLD_BARS * H4);
  });
});

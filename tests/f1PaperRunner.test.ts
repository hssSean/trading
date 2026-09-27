import { describe, it, expect } from 'vitest';
import { runF1Paper, type F1RedisLike, type F1Deps } from '../src/lib/f1PaperRunner';
import { F1, f1ResolvableAt, type Bar, type FundingPoint } from '../src/lib/f1Paper';

const H4 = 4 * 3_600_000;

class FakeRedis implements F1RedisLike {
  store = new Map<string, Map<string, string>>();
  calls = 0;
  private h(k: string) { if (!this.store.has(k)) this.store.set(k, new Map()); return this.store.get(k)!; }
  async hgetall(key: string): Promise<Record<string, unknown> | null> {
    this.calls++;
    const m = this.store.get(key);
    return m && m.size ? Object.fromEntries(m) : null;
  }
  async hset(key: string, kv: Record<string, string>) { this.calls++; for (const [k, v] of Object.entries(kv)) this.h(key).set(k, v); return 1; }
  async hdel(key: string, ...fields: string[]) { this.calls++; for (const f of fields) this.h(key).delete(f); return 1; }
}

// 8h 結算：前 WINDOW 次平穩，最後一次極負 → 做多訊號
function fundingWithSignalAt(settleT: number): FundingPoint[] {
  const pts: FundingPoint[] = [];
  for (let i = F1.WINDOW; i >= 1; i--) pts.push({ t: settleT - i * 2 * H4, rate: 0.0001 });
  pts.push({ t: settleT, rate: -0.001 });
  return pts;
}
function bars(n: number, t0: number, px = 100): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ openTime: t0 + i * H4, open: px, high: px + 0.5, low: px - 0.5, close: px, closeTime: t0 + (i + 1) * H4 - 1 }));
}

const settleT = 1000 * H4;
const deps = (over: Partial<F1Deps> = {}): F1Deps => ({
  universe: ['XUSDT'],
  fetchFundingHistory: async () => fundingWithSignalAt(settleT),
  fetch4h: async (_s, _l, start) => bars(60, start),
  ...over,
});

describe('runF1Paper', () => {
  it('first run only initializes lastT — never backfills history', async () => {
    const r = new FakeRedis();
    const s = await runF1Paper(r, deps(), settleT + H4);
    expect(s.detected).toBe(0);
    expect(r.store.get('f1p:meta')!.get('lastT')).toBe(String(settleT + H4));
    expect(r.store.get('f1p:open')).toBeUndefined();
  });

  it('detects a settlement that happened after lastT, once', async () => {
    const r = new FakeRedis();
    await r.hset('f1p:meta', { lastT: String(settleT - H4) });
    const now = settleT + 20 * 60_000;
    const s1 = await runF1Paper(r, deps(), now);
    expect(s1.detected).toBe(1);
    expect(r.store.get('f1p:open')!.size).toBe(1);
    const s2 = await runF1Paper(r, deps(), now + 30 * 60_000);
    expect(s2.scanned).toBe(false);
    expect(s2.detected).toBe(0);
  });

  it('waits the grace period after a settlement before scanning', async () => {
    const r = new FakeRedis();
    await r.hset('f1p:meta', { lastT: String(settleT - H4) });
    const s = await runF1Paper(r, deps(), settleT + 60_000);
    expect(s.scanned).toBe(false);
  });

  it('resolves a trade once its hold window has passed, moving it open → done', async () => {
    const r = new FakeRedis();
    await r.hset('f1p:meta', { lastT: String(settleT - H4) });
    await runF1Paper(r, deps(), settleT + 20 * 60_000);
    const [trade] = Array.from(r.store.get('f1p:open')!.values()).map(v => JSON.parse(v));
    const s = await runF1Paper(r, deps(), f1ResolvableAt(trade) + 20 * 60_000);
    expect(s.resolved).toBe(1);
    expect(r.store.get('f1p:open')!.size).toBe(0);
    const done = JSON.parse(Array.from(r.store.get('f1p:done')!.values())[0]);
    expect(done.status).toBe('done');
    expect(Number.isFinite(done.netR)).toBe(true);
  });

  it('a fetch failure for one symbol does not stop the others or throw', async () => {
    const r = new FakeRedis();
    await r.hset('f1p:meta', { lastT: String(settleT - H4) });
    const s = await runF1Paper(r, deps({
      universe: ['BADUSDT', 'XUSDT'],
      fetchFundingHistory: async sym => { if (sym === 'BADUSDT') throw new Error('boom'); return fundingWithSignalAt(settleT); },
    }), settleT + 20 * 60_000);
    expect(s.errors).toBe(1);
    expect(s.detected).toBe(1);
  });

  it('gives up (void) on a trade whose data never becomes available', async () => {
    const r = new FakeRedis();
    await r.hset('f1p:meta', { lastT: String(settleT - H4) });
    await runF1Paper(r, deps(), settleT + 20 * 60_000);
    const [trade] = Array.from(r.store.get('f1p:open')!.values()).map(v => JSON.parse(v));
    const s = await runF1Paper(r, deps({ fetch4h: async () => { throw new Error('down'); } }),
      f1ResolvableAt(trade) + 4 * 24 * 3_600_000);
    expect(s.voided).toBe(1);
    expect(r.store.get('f1p:open')!.size).toBe(0);
  });

  it('keeps Redis traffic bounded: at most 2 reads + 4 writes per run', async () => {
    const r = new FakeRedis();
    await r.hset('f1p:meta', { lastT: String(settleT - H4) });
    r.calls = 0;
    await runF1Paper(r, deps({ universe: ['AUSDT', 'BUSDT', 'CUSDT'] }), settleT + 20 * 60_000);
    expect(r.calls).toBeLessThanOrEqual(6);
  });
});

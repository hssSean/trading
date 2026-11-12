// 2026-11-11：市價進場單送出後丟錯（例如 axios 10 秒逾時），但交易所其實已經成交。
// 以前：丟錯 → 「下單失敗」→ 交易所上留下沒有止損、S3 也不認得的部位。
// 現在：重查持倉，查到就接手（存進 s3a-live:pos、掛止損）。
import { describe, it, expect } from 'vitest';
import { runS3aLive, netIncome, type S3aClient, type S3aStore, type S3aCtx } from '../src/engine/s3aLive';

const DAY = 86_400_000;
const X = 2000 * DAY;
const D = X - DAY;

function memStore(init: Record<string, unknown>): S3aStore & { h: Record<string, Record<string, string>>; kv: Record<string, unknown> } {
  const h: Record<string, Record<string, string>> = {};
  const kv: Record<string, unknown> = { ...init };
  return {
    h, kv,
    async get(k) { return kv[k] ?? null; },
    async hgetall(k) { return h[k] ?? null; },
    async hset(k, o) { h[k] = { ...(h[k] ?? {}), ...o }; return 1; },
    async hdel(k, ...f) { for (const x of f) delete h[k]?.[x]; return 1; },
    async lpush() { return 1; },
    async ltrim() { return 'OK'; },
  };
}

interface Opts { marketThrows: boolean; filled: boolean; income?: Array<{ incomeType: string; income: string; time: number }> | 'throw'; limits?: S3aCtx['limits'] }
function client(opts: Opts) {
  const placed: { type: string; side: string; quantity?: number }[] = [];
  let bought = false;
  const c: S3aClient = {
    async getBalance() { return [{ asset: 'USDT', balance: '1000', availableBalance: '1000' }]; },
    async getPositionRisk(symbol?: string) {
      const amt = bought && opts.filled ? '20' : '0';
      const all = [{ symbol: 'AUSDT', positionAmt: amt, entryPrice: amt === '0' ? '0' : '10' }];
      return symbol ? all.filter(x => x.symbol === symbol) : all;
    },
    async getOpenOrders() { return []; },
    async getOpenAlgoOrders() { return []; },
    async getUserTrades() { return []; },
    async getIncome() { if (opts.income === 'throw') throw new Error('timeout'); return opts.income ?? []; },
    async setLeverage() { return {}; },
    async setMarginType() { return {}; },
    async placeOrder(p) {
      placed.push(p);
      if (p.type === 'MARKET') { bought = true; if (opts.marketThrows) throw new Error('timeout of 10000ms exceeded'); }
      return { orderId: placed.length };
    },
    async cancelOrder() { return {}; },
    async tickerPrice() { return 10; },
  };
  return { c, placed };
}

const snap = {
  X, breadth: 0.5, uni: {}, up: {},
  btcOk: { [String(D)]: true }, btcExt: { [String(D)]: 3 },
  // 止損 9.5 → 距離 5%（≤ 12.98% 得 1 分）、BTC 3 ≥ 2.10 得 1 分、7 日 0 不扣分 = 2 分
  s3: [{ symbol: 'AUSDT', close: 10, hh20: 9.9, atr14: 0.5, stop: 9.5, ret7: 0, vol: 1e9 }],
};

async function run(opts: Opts) {
  const store = memStore({ [`s3s1:prep:${X}`]: JSON.stringify(snap) });
  const { c, placed } = client(opts);
  const notes: string[] = [];
  await runS3aLive({
    client: c, store,
    filters: new Map([['AUSDT', { stepSize: 1, tickSize: 0.001, minNotional: 5, minQty: 1 }]]),
    mainnetDaily: async () => [], mainnetFunding: async () => [],
    ensurePrep: async () => undefined,
    notify: async (t) => { notes.push(t); },
    log: () => undefined,
    dryRun: false, killSwitch: false, now: X + 60_000, entryConfirmWaitMs: 0, limits: opts.limits,
  });
  return { store, placed, notes };
}

describe('S3 進場確認', () => {
  it('送單丟錯但已成交 → 接手管理並掛止損', async () => {
    const { store, placed } = await run({ marketThrows: true, filled: true });
    const pos = JSON.parse(store.h['s3a-live:pos']?.AUSDT ?? 'null');
    expect(pos).toMatchObject({ symbol: 'AUSDT', entry: 10, qty0: 20, stop0: 9.5 });
    expect(placed.some(p => p.type === 'STOP_MARKET' && p.side === 'SELL' && p.quantity === 20)).toBe(true);
  });
  it('送單丟錯且沒成交 → 不記持倉、推播下單失敗', async () => {
    const { store, placed, notes } = await run({ marketThrows: true, filled: false });
    expect(store.h['s3a-live:pos']?.AUSDT).toBeUndefined();
    expect(placed.filter(p => p.type !== 'MARKET')).toEqual([]);
    expect(notes.some(n => n.includes('下單失敗'))).toBe(true);
  });
  it('正常成交 → 照舊', async () => {
    const { store } = await run({ marketThrows: false, filled: true });
    expect(JSON.parse(store.h['s3a-live:pos'].AUSDT).qty0).toBe(20);
  });
});

describe('S3 絕對金額的硬閘（2026-11-12）', () => {
  const ok = { marketThrows: false, filled: true };
  const inc = (type: string, v: number) => ({ incomeType: type, income: String(v), time: X });
  it('netIncome 只算已實現損益、手續費、資金費', () => {
    expect(netIncome([inc('REALIZED_PNL', -80), inc('COMMISSION', -5), inc('FUNDING_FEE', 2), inc('TRANSFER', 1000)])).toBeCloseTo(-83, 9);
  });
  it('近 24 小時虧損達上限 → 不開新倉、記 lastDay、推播', async () => {
    const { store, placed, notes } = await run({ ...ok, income: [inc('REALIZED_PNL', -120), inc('COMMISSION', -3)], limits: { maxDailyLossUsdt: 100 } });
    expect(placed).toEqual([]);
    expect(store.h['s3a-live:pos']?.AUSDT).toBeUndefined();
    expect(store.h['s3a-live:meta'].lastDay).toBe(String(X));
    expect(notes.some(n => n.includes('單日虧損上限'))).toBe(true);
  });
  it('沒到上限 → 照常進場；沒設上限 → 不查流水', async () => {
    const a = await run({ ...ok, income: [inc('REALIZED_PNL', -50)], limits: { maxDailyLossUsdt: 100 } });
    expect(JSON.parse(a.store.h['s3a-live:pos'].AUSDT).qty0).toBe(20);
    const b = await run({ ...ok, income: 'throw' });
    expect(JSON.parse(b.store.h['s3a-live:pos'].AUSDT).qty0).toBe(20);
  });
  it('讀不到流水 → 不開倉，也不記 lastDay（下一輪再試）', async () => {
    const { store, placed } = await run({ ...ok, income: 'throw', limits: { maxDailyLossUsdt: 100 } });
    expect(placed).toEqual([]);
    expect(store.h['s3a-live:meta']?.lastDay).toBeUndefined();
  });
  it('單筆名目超過上限 → 這筆不做', async () => {
    // 權益各 500：A 4% ÷ 0.5 = 40 顆、B 3% ÷ 0.5 = 30 顆，合計 70 顆 × 10 = 700 USDT
    const over = await run({ ...ok, limits: { maxNotionalUsdt: 600 } });
    expect(over.placed).toEqual([]);
    const under = await run({ ...ok, limits: { maxNotionalUsdt: 800 } });
    expect(under.placed.some(p => p.type === 'MARKET' && p.quantity === 70)).toBe(true);
  });
});

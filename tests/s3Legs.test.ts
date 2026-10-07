import { describe, it, expect } from 'vitest';
import { checkPosition, splitResult, legMeta, legUpdate, legCanOpen, type LivePos, type Fill } from '../src/engine/s3aLive';

const pos = (over: Partial<LivePos> = {}): LivePos => ({
  symbol: 'AUSDT', signalDay: 0, entryDay: 100, entryAt: 1_000_000, entry: 10, stop0: 9, stop: 9,
  qty0: 50, tpQty: 16, partial: false, stopAlgoId: 1, tpAlgoId: 2, stopQty: 50, trailDay: 0, stopFailures: 0,
  legs: { A: { qty0: 30, tpQty: 10, equityAtEntry: 1000, minQtyUsed: false }, B: { qty0: 20, tpQty: 6, equityAtEntry: 1000, minQtyUsed: false } },
  addQty: 30, addAlgoId: 3, addFilled: false, miss: {},
  score: 2, dist: 0.1, btcExt: 3, ret7: 0, breadth: 0.5, funding: 0, ...over,
});
const ALL = new Set([1, 2, 3]);

describe('checkPosition（A＋B 合併部位）', () => {
  it('部位歸零 → closed', () => {
    expect(checkPosition(pos(), 0, ALL, 10)).toEqual({ kind: 'closed' });
  });
  it('止盈與加碼同時成交：50 − 16 + 30 = 64', () => {
    expect(checkPosition(pos(), 64, new Set([1]), 11)).toEqual({ kind: 'fills', tp: true, add: true, newStop: 10 });
  });
  it('只有止盈成交：34', () => {
    expect(checkPosition(pos(), 34, new Set([1, 3]), 11)).toEqual({ kind: 'fills', tp: true, add: false, newStop: 10 });
  });
  it('只有加碼成交：80', () => {
    expect(checkPosition(pos(), 80, new Set([1, 2]), 11)).toEqual({ kind: 'fills', tp: false, add: true, newStop: 10 });
  });
  it('止損單數量跟部位不同 → stop_resize', () => {
    expect(checkPosition(pos({ partial: true, stopQty: 50 }), 34, new Set([1, 3]), 10.5)).toEqual({ kind: 'stop_resize' });
  });
  it('部位變小但止盈單還在（手動平倉）→ 不算止盈，只調整止損數量', () => {
    expect(checkPosition(pos(), 40, ALL, 10)).toEqual({ kind: 'stop_resize' });
  });
  it('止損單不見 → stop_missing（標出是否已穿過）', () => {
    expect(checkPosition(pos(), 50, new Set([2, 3]), 9.5)).toEqual({ kind: 'stop_missing', priceThrough: false });
    expect(checkPosition(pos(), 50, new Set([2, 3]), 8.9)).toEqual({ kind: 'stop_missing', priceThrough: true });
  });
  it('止盈單不見、部位沒變：第一輪先等，第二輪才當成被拒絕', () => {
    expect(checkPosition(pos(), 50, new Set([1, 3]), 10.5)).toEqual({ kind: 'wait', which: 'tp' });
    expect(checkPosition(pos({ miss: { tp: 1 } }), 50, new Set([1, 3]), 10.5)).toEqual({ kind: 'tp_missing', priceThrough: false });
    expect(checkPosition(pos({ miss: { tp: 1 } }), 50, new Set([1, 3]), 11.2)).toEqual({ kind: 'tp_missing', priceThrough: true });
  });
  it('加碼單不見、部位沒變：同樣等一輪', () => {
    expect(checkPosition(pos(), 50, new Set([1, 2]), 10.5)).toEqual({ kind: 'wait', which: 'add' });
    expect(checkPosition(pos({ miss: { add: 1 } }), 50, new Set([1, 2]), 10.5)).toEqual({ kind: 'add_missing', priceThrough: false });
  });
  it('只有 A 份（沒有加碼單）照舊', () => {
    const a = pos({ qty0: 30, tpQty: 10, stopQty: 30, legs: { A: { qty0: 30, tpQty: 10, equityAtEntry: 1000, minQtyUsed: false } }, addQty: 0, addAlgoId: null });
    expect(checkPosition(a, 20, new Set([1]), 11)).toEqual({ kind: 'fills', tp: true, add: false, newStop: 10 });
    expect(checkPosition(a, 30, new Set([1, 2]), 10)).toEqual({ kind: 'ok' });
  });
});

describe('splitResult：A／B 分帳', () => {
  const f = (side: 'BUY' | 'SELL', price: number, qty: number, time: number, realizedPnl = 0, commission = 0): Fill =>
    ({ side, price: String(price), qty: String(qty), time, realizedPnl: String(realizedPnl), commission: String(commission) });
  const E = 1_000_000;

  it('止盈＋加碼後以 12 出場：加碼份 = 30 × (12 − 11)，原單依 30:20 分', () => {
    const fills = [
      f('BUY', 10, 50, E, 0, 0.5),
      f('SELL', 11, 16, E + 3_600_000, 16, 0.1),
      f('BUY', 11, 30, E + 3_600_000, 0, 0.3),
      f('SELL', 12, 64, E + 7_200_000, 16 * 0 + 34 * 2 + 30 * 1, 0.6), // 交易所的 realizedPnl 以均價計，總和才是真的
    ];
    const r = splitResult(pos({ partial: true, addFilled: true }), fills, 0);
    expect(r.gross).toBeCloseTo(16 + 98, 9);
    expect(r.addQty).toBe(30);
    expect(r.addEntry).toBeCloseTo(11, 9);
    expect(r.exitAvg).toBeCloseTo(12, 9);
    // 加碼份：毛 30、手續費 0.3 + 0.6 × 30/64
    const addNet = 30 - 0.3 - 0.6 * 30 / 64;
    const origNet = (114 - 30) - (0.5 + 0.1 + 0.6 * 34 / 64);
    expect(r.legRes.A!.net).toBeCloseTo(origNet * 30 / 50, 9);
    expect(r.legRes.B!.net).toBeCloseTo(origNet * 20 / 50 + addNet, 9);
    expect(r.legRes.A!.R).toBeCloseTo(r.legRes.A!.net / 30, 9);
    expect(r.legRes.B!.R).toBeCloseTo(r.legRes.B!.net / 20, 9);
    expect(r.net).toBeCloseTo(r.legRes.A!.net + r.legRes.B!.net, 9);
  });

  it('沒有加碼：全部依數量比例分；資金費也照比例', () => {
    const fills = [f('BUY', 10, 50, E, 0, 0.5), f('SELL', 9, 50, E + 3_600_000, -50, 0.45)];
    const r = splitResult(pos(), fills, -1);
    const net = -50 - 0.95 - 1;
    expect(r.net).toBeCloseTo(net, 9);
    expect(r.legRes.A!.net).toBeCloseTo(net * 0.6, 9);
    expect(r.legRes.A!.R).toBeCloseTo(net * 0.6 / 30, 9);
    expect(r.legRes.B!.addNet).toBe(0);
  });
});

describe('各策略的權益與停用', () => {
  it('A 用無前綴鍵、B 用 b. 前綴', () => {
    const meta = { baseEquity: '2000', realized: '100', 'b.baseEquity': '2000', 'b.realized': '-50', 'b.lossStreak': '3' };
    expect(legMeta(meta, 'A')).toMatchObject({ base: 2000, realized: 100, equity: 2100, streak: 0, halted: null });
    expect(legMeta(meta, 'B')).toMatchObject({ base: 2000, realized: -50, equity: 1950, streak: 3 });
  });
  it('結算後更新：A 連虧 7 停用；B 要 15', () => {
    const m = { baseEquity: '1000', lossStreak: '6', 'b.baseEquity': '1000', 'b.lossStreak': '6' };
    expect(legUpdate(m, 'A', -10).halted).toMatch(/連續虧損 7/);
    const b = legUpdate(m, 'B', -10);
    expect(b.kv['b.lossStreak']).toBe('7');
    expect(b.halted).toBe(null);
  });
  it('回撤門檻：A 35%、B 40%', () => {
    const m = { baseEquity: '1000', 'b.baseEquity': '1000' };
    expect(legUpdate(m, 'A', -380).halted).toMatch(/回撤/);
    expect(legUpdate(m, 'B', -380).halted).toBe(null);
    expect(legUpdate(m, 'B', -410).halted).toMatch(/回撤/);
  });
  it('獲利會重設連虧並抬高高點', () => {
    const r = legUpdate({ baseEquity: '1000', lossStreak: '3', realized: '0' }, 'A', 50);
    expect(r.kv).toMatchObject({ realized: '50', peakRealized: '50', lossStreak: '0' });
  });
});

describe('legCanOpen', () => {
  it('風險加總 20%：A 第 6 筆、B 第 7 筆被擋；停用就不開', () => {
    expect(legCanOpen('A', 4, null)).toBe(null);
    expect(legCanOpen('A', 5, null)).toMatch(/上限/);
    expect(legCanOpen('B', 6, null)).toMatch(/上限/);
    expect(legCanOpen('B', 5, null)).toBe(null);
    expect(legCanOpen('B', 0, '連續虧損 15 筆')).toMatch(/已停用/);
  });
});

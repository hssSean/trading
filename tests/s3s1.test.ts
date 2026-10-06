import { describe, it, expect } from 'vitest';
import { trimPartialFirstBar, s3Score, universeOn, breadthAt, dailyFeatures, S3_TH, DAY, H, H12, type Bar, type FundingPoint, type TradeSim } from '../src/lib/s3s1/rules';
import { stepAccount, stopCheck, dueS3S1Job, ACCTS, type AcctState, type Candidate, type Position, type SymbolFilter } from '../src/lib/s3s1/engine';
import { summarizeAcct, summarizeLive, reasonKey } from '../src/lib/s3s1/stats';

const T0 = Date.UTC(2026, 0, 1);
const bar = (t: number, c: number, qv = 1): Bar => ({ t, o: c, h: c, l: c, c, qv });
const days = (n: number, f: (i: number) => number, qv: (i: number) => number = () => 1) =>
  Array.from({ length: n }, (_, i) => bar(T0 + i * DAY, f(i), qv(i)));
const state = (equity = 100): AcctState => ({ equity, peak: equity, trades: 0, wins: 0, lossStreak: 0, recent: [], halted: null, lastExit: {} });

describe('trimPartialFirstBar', () => {
  const bars = days(3, () => 1);
  it('上市當天不滿半根（9 小時）丟掉第一根', () => {
    expect(trimPartialFirstBar(bars, T0 + 15 * H, DAY)).toHaveLength(2);
  });
  it('上市當天超過半根（18 小時）保留', () => {
    expect(trimPartialFirstBar(bars, T0 + 6 * H, DAY)).toHaveLength(3);
  });
  it('上市時間不在第一根裡（資料不是從上市開始）不動', () => {
    expect(trimPartialFirstBar(bars, T0 - DAY, DAY)).toHaveLength(3);
  });
  it('12H：上市後只剩 5 小時丟掉、剩 7 小時保留', () => {
    const b = [bar(T0, 1), bar(T0 + H12, 1)];
    expect(trimPartialFirstBar(b, T0 + 7 * H, H12)).toHaveLength(1);
    expect(trimPartialFirstBar(b, T0 + 5 * H, H12)).toHaveLength(2);
  });
});

describe('s3Score', () => {
  it('三項都在門檻上（含等號）', () => {
    expect(s3Score(S3_TH.risk, S3_TH.btc, S3_TH.ret7 - 1e-12)).toBe(2);
    expect(s3Score(S3_TH.risk + 1e-12, S3_TH.btc, 0)).toBe(1);
    expect(s3Score(0.05, S3_TH.btc, S3_TH.ret7)).toBe(1);
    expect(s3Score(0.05, NaN, 0)).toBe(1);
  });
});

describe('universeOn', () => {
  it('排除上市未滿 30 天、成交額天數不足 20、排除清單；依均成交額排名', () => {
    const D = T0 + 40 * DAY;
    const all = new Map<string, Bar[]>([
      ['AAAUSDT', days(41, () => 1, () => 100)],
      ['BBBUSDT', days(41, () => 1, () => 200)],
      ['NEWUSDT', days(41, () => 1, () => 999).slice(15)],               // 當天之前只有 25 根
      ['GAPUSDT', days(41, () => 1, i => (i < 25 ? NaN : 999))],          // 前 30 天只有 15 天有成交額
      ['XAUUSDT', days(41, () => 1, () => 999)],
    ]);
    const u = universeOn(all, D, 10);
    expect(u.map(x => x.symbol)).toEqual(['BBBUSDT', 'AAAUSDT']);
    expect(universeOn(all, D, 1)).toHaveLength(1);
  });
});

describe('breadthAt', () => {
  it('看「T 之前最後一根已收盤日線」，排除清單不算分母', () => {
    const up = days(60, i => 1 + i);         // 一路漲：收盤 > EMA50
    const down = days(60, i => 100 - i);     // 一路跌
    const all = new Map([['UPUSDT', dailyFeatures(up)], ['DNUSDT', dailyFeatures(down)], ['XAUUSDT', dailyFeatures(up)]]);
    const T = T0 + 59 * DAY + 3 * H;          // 第 59 根還沒收盤 → 看第 58 根
    expect(breadthAt(all, T)).toBe(0.5);
  });
});

describe('dueS3S1Job', () => {
  const X = T0 + 10 * DAY;
  it('00:05 前什麼都不跑；之後先 prep', () => {
    expect(dueS3S1Job({}, X + 4 * 60_000)).toBe(null);
    expect(dueS3S1Job({}, X + 6 * 60_000)).toBe('prep');
  });
  it('prep 完成、01:05 後跑 s3；s3 做完換 s1', () => {
    const m: Record<string, unknown> = { 'prep.lastDay': X };
    expect(dueS3S1Job(m, X + 30 * 60_000)).toBe('s1');   // s3 還沒到時間，但前一個 12H 時點還沒記帳
    m['s1.lastT'] = X - H12;
    expect(dueS3S1Job(m, X + 30 * 60_000)).toBe(null);
    expect(dueS3S1Job(m, X + H + 6 * 60_000)).toBe('s3');
    m['s3.lastRunDay'] = X;
    expect(dueS3S1Job(m, X + H + 6 * 60_000)).toBe('s1');   // 00:00 那個 12H 時點也到了
    m['s1.lastT'] = X;
    expect(dueS3S1Job(m, X + H + 6 * 60_000)).toBe(null);
    expect(dueS3S1Job(m, X + H12 + H + 6 * 60_000)).toBe('s1');
  });
});

describe('stopCheck（文件 §8）', () => {
  it('S3-A 回撤 > 35% 或連虧 7', () => {
    expect(stopCheck('s3a', { ...state(64), peak: 100 })).toMatch(/回撤/);
    expect(stopCheck('s3a', { ...state(66), peak: 100 })).toBe(null);
    expect(stopCheck('s3a', { ...state(), lossStreak: 7 })).toMatch(/連續虧損/);
    expect(stopCheck('s3b', { ...state(), lossStreak: 7 })).toBe(null);
  });
  it('S1 近 50 筆勝率 < 45%', () => {
    expect(stopCheck('s1', { ...state(), recent: [...Array(22).fill(1), ...Array(28).fill(-1)] })).toMatch(/勝率/);
    expect(stopCheck('s1', { ...state(), recent: [...Array(23).fill(1), ...Array(27).fill(-1)] })).toBe(null);
    expect(stopCheck('s1', { ...state(), recent: Array(49).fill(-1) })).toBe(null);
  });
});

describe('stepAccount', () => {
  const t = T0 + 30 * DAY;
  const cand = (symbol: string, vol: number, over: Partial<Candidate> = {}): Candidate => ({
    symbol, signalT: t - DAY, entryT: t, stop: 90, close: 100, vol, breadth: 0.5, btcOk: true, ind: {},
    btcExtV: 3, ret7: 0, ...over,
  });
  const hourly = async () => [bar(t, 100)];
  const fund = async (): Promise<FundingPoint[]> => [];
  const filters = new Map<string, SymbolFilter>();
  const neverExit = async (): Promise<TradeSim | null> => null;

  it('S3-A 風險加總 20% ÷ 4% = 最多 5 筆，第 6 筆起被擋；同時點依成交額排序', async () => {
    const open = new Map<string, Position>();
    const cands = Array.from({ length: 7 }, (_, i) => cand(`C${i}USDT`, i));
    const { logs } = await stepAccount('s3a', state(), open, [{ t, cands }], neverExit, filters, fund, hourly, t);
    expect(open.size).toBe(5);
    expect(logs.filter(l => l.decision === 'open').map(l => l.symbol)).toEqual(['C6USDT', 'C5USDT', 'C4USDT', 'C3USDT', 'C2USDT']);
    expect(logs.filter(l => l.decision === 'skip').every(l => /風險加總上限/.test(l.reason!))).toBe(true);
    const p = Array.from(open.values())[0];
    expect(p.riskUsdt).toBeCloseTo(4, 9);   // 100 × 4%
  });

  it('S3 分數不是 2 就不開；BTC／廣度／資金費依序擋', async () => {
    const open = new Map<string, Position>();
    const { logs } = await stepAccount('s3a', state(), open, [{ t, cands: [
      cand('LOWUSDT', 5, { btcExtV: 1 }),
      cand('BTCUSDT', 4, { btcOk: false }),
      cand('HOTUSDT', 3, { breadth: 0.93 }),
    ] }], neverExit, filters, async s => (s === 'FUNDUSDT' ? [{ t: t - H, rate: 0.0005 }] : []), hourly, t);
    expect(open.size).toBe(0);
    expect(logs.map(l => l.reason)).toEqual(['分數 1', 'BTC 條件不成立', '市場過熱（廣度 0.930）']);
  });

  it('最小下單量：最小量風險 ≤ 1.5f 用最小量，超過就不做', async () => {
    const f1 = new Map<string, SymbolFilter>([['AUSDT', { stepSize: 1, minQty: 1, minNotional: 0 }]]);
    // 權益 100、f 4% = 4U 預算；止損距離 5 → 理論 0.8 顆，最小 1 顆風險 5 ≤ 6 → 用最小量
    const open = new Map<string, Position>();
    await stepAccount('s3a', state(), open, [{ t, cands: [cand('AUSDT', 1, { stop: 95 })] }], neverExit, f1, fund, hourly, t);
    expect(Array.from(open.values())[0]).toMatchObject({ qty: 1, minQtyUsed: true });
    // 止損距離 7 → 最小 1 顆風險 7 > 6 → 不做
    const open2 = new Map<string, Position>();
    const { logs } = await stepAccount('s3a', state(), open2, [{ t, cands: [cand('AUSDT', 1, { stop: 93 })] }], neverExit, f1, fund, hourly, t);
    expect(open2.size).toBe(0);
    expect(logs[0].reason).toMatch(/低於最小下單量/);
  });

  it('出場先入帳再處理同時點的新訊號；虧到停用條件後不再開倉', async () => {
    const open = new Map<string, Position>();
    const s = { ...state(), lossStreak: 6 };
    const lose = async (p: Position): Promise<TradeSim> => ({ entry: p.entry, risk: 10, partial: false, partialT: NaN, exitT: t + DAY, exitPx: 90, exitReason: 'stop', grossR: -1, netR: -1.01, addR: null });
    const { done, logs } = await stepAccount('s3a', s, open, [
      { t, cands: [cand('AUSDT', 1)] },
      { t: t + 2 * DAY, cands: [cand('BUSDT', 1, { signalT: t + DAY, entryT: t + 2 * DAY })] },
    ], lose, filters, fund, async () => [bar(t, 100), bar(t + 2 * DAY, 100)], t + 3 * DAY);
    expect(done).toHaveLength(1);
    expect(done[0].pnlUsdt).toBeCloseTo(-4.04, 9);
    expect(s.halted).toMatch(/連續虧損 7/);
    expect(logs[1].reason).toMatch(/帳戶已停用/);
  });

  it('同幣：上一筆在訊號 K 線期間才出場就不開', async () => {
    const open = new Map<string, Position>();
    const s = { ...state(), lastExit: { AUSDT: t - DAY + H } };
    const { logs } = await stepAccount('s3a', s, open, [{ t, cands: [cand('AUSDT', 1)] }], neverExit, filters, fund, hourly, t);
    expect(logs[0].reason).toBe('上一筆在訊號 K 線期間才出場');
  });
});

describe('stats', () => {
  it('summarizeAcct：最大回撤用已平倉的權益軌跡', () => {
    const mk = (exitT: number, eq: number, r: number) => ({ id: String(exitT), acct: 's3a', symbol: 'X', kind: 'S3', signalT: 0, entryT: 0, stop: 0, entry: 0, f: 0.04,
      equityAtEntry: 100, qty: 1, riskUsdt: 4, minQtyUsed: false, vol: 0, dist: 0, breadth: 0, funding: 0, status: 'done', exitT, equityAfter: eq, netR: r }) as Position;
    const s = summarizeAcct('s3a', { ...state(110), peak: 120, trades: 3, wins: 2 }, [mk(3, 110, -2.5), mk(1, 120, 5), mk(2, 90, -7.5)]);
    expect(s.maxDdPct).toBeCloseTo(25, 9);
    expect(s.ddPct).toBeCloseTo(100 / 12, 9);
    expect(s.retPct).toBeCloseTo(10, 9);
    expect(s.avgR).toBeCloseTo(-5 / 3, 9);
    expect(s.name).toBe(ACCTS.s3a.name);
  });
  it('summarizeLive：沒有起始權益時報酬與回撤為 null', () => {
    expect(summarizeLive({}, [])).toMatchObject({ retPct: null, ddPct: null, trades: 0, avgR: null });
    expect(summarizeLive({ baseEquity: '1000', realized: '50', peakRealized: '100' }, []).ddPct).toBeCloseTo(50 / 1100 * 100, 9);
  });
  it('reasonKey 把數字收成 n', () => {
    expect(reasonKey('市場過熱（廣度 0.951）')).toBe('市場過熱');
    expect(reasonKey('分數 1')).toBe('分數 n');
  });
});

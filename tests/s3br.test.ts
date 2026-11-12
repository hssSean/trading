// BR：空頭反彈做空（2026-11-12）。規則對研究端參考交易的逐筆驗收在 scripts/s3s1-acceptance.ts（25 筆，1e-6）；
// 這裡測邊界行為與帳本的做空方向。
import { describe, it, expect } from 'vitest';
import { wilderRsi } from '../src/lib/s3s1/ind';
import { brFeatures, brSignalAt, simulateShort, H, H12, COST, type Bar, type BRFeat, type FundingPoint, type TradeSim } from '../src/lib/s3s1/rules';
import { stepAccount, stopCheck, dueS3S1Job, ACCTS, type AcctState, type Candidate, type Position, type SymbolFilter } from '../src/lib/s3s1/engine';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * H;
const state = (): AcctState => ({ equity: 100, peak: 100, trades: 0, wins: 0, lossStreak: 0, recent: [], halted: null, lastExit: {} });

describe('wilderRsi', () => {
  it('第一根 50；沒有跌過 → 50（照參考實作的 fillna，不是 100）', () => {
    expect(wilderRsi([1, 2, 3], 3)).toEqual([50, 50, 50]);
  });
  it('有漲有跌：照 Wilder 遞推', () => {
    // up: 0, 1/3, 2/9；dn: 0, 0, 1/3 → RS = (2/9)/(1/3) = 2/3 → RSI = 40
    expect(wilderRsi([10, 11, 10], 3)[2]).toBeCloseTo(40, 9);
  });
});

describe('brSignalAt', () => {
  // 先長期下跌（EMA20 < EMA50、收盤 < EMA200），最後連三根反彈把 RSI3 拉過 80
  const mk = (ups: number): Bar[] => {
    const c: number[] = [];
    for (let i = 0; i < 260; i++) c.push(1000 - i * 2);
    for (let k = 0; k < ups; k++) c.push(c[c.length - 1] + 6);
    return c.map((x, i) => ({ t: T0 + i * H12, o: x, h: x + 1, l: x - 1, c: x }));
  };
  it('下跌趨勢中 RSI3 > 80 的第一根才是訊號；止損 = 收盤 + 2×ATR14', () => {
    const f = brFeatures(mk(3));
    const hits = f.bars.map(b => brSignalAt('X', f, b.t)).filter(Boolean);
    expect(hits).toHaveLength(1);                       // 連續符合只取第一根
    const s = hits[0]!;
    const i = f.bars.findIndex(b => b.t === s.barT);
    expect(s.rsi3).toBeGreaterThan(80);
    expect(f.rsi3[i - 1]).toBeLessThanOrEqual(80);
    expect(s.stop).toBeCloseTo(s.close + 2 * f.atr14[i], 9);
  });
  it('第 206 根之前不出訊號', () => {
    const bars = mk(3).slice(60);                       // 反彈落在 index 200～202
    const f = brFeatures(bars);
    expect(f.bars.map(b => brSignalAt('X', f, b.t)).filter(Boolean)).toHaveLength(0);
  });
});

describe('simulateShort', () => {
  const hour = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: T0 + i * H, o, h, l, c });
  const feat = (closes: number[], ema: number): BRFeat => {
    const bars = closes.map((c, i) => ({ t: T0 + i * H12, o: c, h: c, l: c, c }));
    const z = bars.map(() => 0);
    return { bars, ema20: bars.map(() => ema), ema50: z, ema200: z, atr14: z, rsi3: z };
  };
  it('1H 最高碰到止損 → −1R 再扣成本；跳空開在止損之上用開盤價', () => {
    const f = feat([100, 100, 100], 50);
    const a = simulateShort({ entryT: T0, stop: 110, hourly: [hour(0, 100, 101, 99, 100), hour(1, 100, 111, 100, 105)], h12: f, fund: [] })!;
    expect(a.exitReason).toBe('stop');
    expect(a.grossR).toBeCloseTo(-1, 9);
    expect(a.netR).toBeCloseTo(-1 - 2 * COST * 100 / 10, 9);
    const b = simulateShort({ entryT: T0, stop: 110, hourly: [hour(0, 100, 101, 99, 100), hour(1, 115, 116, 114, 115)], h12: f, fund: [] })!;
    expect(b.exitPx).toBe(115);
    expect(b.grossR).toBeCloseTo(-1.5, 9);
  });
  it('12H 收盤 < EMA20 → 下一根 12H 開盤出場；空方收正的資金費', () => {
    const f = feat([100, 90], 95);                      // 第二根 12H 收盤 90 < 95 → 第三根開盤（T0 + 24h）出場
    const hourly = Array.from({ length: 25 }, (_, i) => hour(i, i === 24 ? 88 : 100, 101, 89, 100));
    const fund: FundingPoint[] = [{ t: T0 + 8 * H, rate: 0.001 }];
    const r = simulateShort({ entryT: T0, stop: 110, hourly, h12: f, fund })!;
    expect(r.exitReason).toBe('ema');
    expect(r.exitPx).toBe(88);
    expect(r.exitT).toBe(T0 + 23 * H);
    expect(r.grossR).toBeCloseTo(1.2, 9);
    expect(r.netR).toBeCloseTo(1.2 - (2 * COST * 100 - 0.001 * 100) / 10, 9);
  });
  it('還沒出場回 open；止損距離 ≤ 0.2% 不做', () => {
    const f = feat([100, 100], 50);
    expect(simulateShort({ entryT: T0, stop: 110, hourly: [hour(0, 100, 101, 99, 100)], h12: f, fund: [] })!.exitReason).toBe('open');
    expect(simulateShort({ entryT: T0, stop: 100.1, hourly: [hour(0, 100, 101, 99, 100)], h12: f, fund: [] })).toBeNull();
  });
});

describe('stepAccount：BR 做空', () => {
  const t = T0 + 30 * DAY;
  const cand = (symbol: string, over: Partial<Candidate> = {}): Candidate => ({
    symbol, signalT: t - H12, entryT: t, stop: 110, close: 100, vol: 1, breadth: 0.99, btcOk: true, ind: {}, side: -1, ...over });
  const hourly = async (): Promise<Bar[]> => [{ t, o: 100, h: 100, l: 100, c: 100 }];
  const filters = new Map<string, SymbolFilter>();
  const never = async (): Promise<TradeSim | null> => null;

  it('風險用 止損 − 進場 算；不看市場廣度；記成空單', async () => {
    const open = new Map<string, Position>();
    const { logs } = await stepAccount('br', state(), open, [{ t, cands: [cand('AUSDT')] }], never, filters, async () => [], hourly, t);
    expect(logs[0].decision).toBe('open');
    const p = Array.from(open.values())[0];
    expect(p).toMatchObject({ side: -1, kind: 'BR', entry: 100, stop: 110 });
    expect(p.riskUsdt).toBeCloseTo(1, 9);               // 100 × 1%
    expect(p.dist).toBeCloseTo(0.1, 9);
  });
  it('資金費 ≤ −0.05% 不做（空方擁擠）；BTC 條件不成立不做', async () => {
    const open = new Map<string, Position>();
    const { logs } = await stepAccount('br', state(), open, [{ t, cands: [cand('AUSDT', { vol: 2 }), cand('BUSDT', { btcOk: false })] }], never, filters,
      async s => (s === 'AUSDT' ? [{ t: t - H, rate: -0.0005 }] : []), hourly, t);
    expect(open.size).toBe(0);
    expect(logs.map(l => l.reason)).toEqual(['資金費擁擠（-0.0005）', 'BTC 條件不成立']);
  });
  it('止損在進場價之下（方向錯）不做；沒有停用條件', async () => {
    const open = new Map<string, Position>();
    const { logs } = await stepAccount('br', state(), open, [{ t, cands: [cand('AUSDT', { stop: 99 })] }], never, filters, async () => [], hourly, t);
    expect(logs[0].reason).toBe('止損距離 ≤ 0.2%');
    expect(stopCheck('br', { ...state(), equity: 10, lossStreak: 99 })).toBeNull();
    expect(ACCTS.br).toMatchObject({ f: 0.01, cap: 20, heat: 0.2 });
  });
});

describe('dueS3S1Job：br 排在 s1 之後', () => {
  const X = T0 + 10 * DAY;
  it('s1 記完才輪到 br；br 記完就沒事', () => {
    const m: Record<string, unknown> = { 'prep.lastDay': X, 's3.lastRunDay': X, 's1.lastT': X - H12 };
    expect(dueS3S1Job(m, X + H + 6 * 60_000)).toBe('s1');
    m['s1.lastT'] = X;
    expect(dueS3S1Job(m, X + H + 6 * 60_000)).toBe('br');
    m['br.lastT'] = X;
    expect(dueS3S1Job(m, X + H + 6 * 60_000)).toBe(null);
  });
});

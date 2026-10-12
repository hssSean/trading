import { describe, it, expect } from 'vitest';
import { pickShadows, summarizeShadow, type ShadowTrade } from '../src/lib/s3s1/shadow';
import type { SignalLog } from '../src/lib/s3s1/engine';

// 「被分數擋掉的 S3 訊號後來怎麼了」——研究端說這是驗證分數門檻唯一的方法
// （門檻是看過歷史資料後挑的）。只收「通過所有濾網、算到分數」的候選，
// 不受帳本持倉上限影響，2 分的也收，才有對照組。

const DAY = 86_400_000;
const D = Date.UTC(2026, 9, 11);
const log = (o: Partial<SignalLog>): SignalLog => ({
  acct: 's3a', symbol: 'NEARUSDT', signalT: D, decision: 'skip', reason: '分數 0', close: 6, stop: 4.77,
  entry: 5.894, dist: 0.19, score: 0, scoreParts: [0, 0, 0], btcOk: true, breadth: 0.67, ind: {}, at: D + DAY, ...o,
});

describe('pickShadows', () => {
  it('收被分數擋掉的，也收 2 分的（對照組）', () => {
    const r = pickShadows([log({}), log({ symbol: 'ADAUSDT', score: 2, decision: 'open', reason: undefined })], new Set());
    expect(r.map(s => [s.symbol, s.score])).toEqual([['NEARUSDT', 0], ['ADAUSDT', 2]]);
    expect(r[0]).toMatchObject({ id: `NEARUSDT:${D}`, entryT: D + DAY, stop: 4.77, status: 'open' });
  });

  it('沒算到分數的（在前面的濾網就被擋）不收', () => {
    expect(pickShadows([log({ score: undefined, reason: 'BTC 條件不成立', entry: undefined })], new Set())).toEqual([]);
  });

  it('只收 s3a 的紀錄（s3b 是同一批候選，避免重複）', () => {
    expect(pickShadows([log({ acct: 's3b' }), log({ acct: 's1' })], new Set())).toEqual([]);
  });

  it('已經在追的不重複收；同一批 logs 裡重複的也只收一次', () => {
    expect(pickShadows([log({})], new Set([`NEARUSDT:${D}`]))).toEqual([]);
    expect(pickShadows([log({}), log({})], new Set())).toHaveLength(1);
  });
});

describe('summarizeShadow', () => {
  const t = (score: number, netR: number | undefined, status: 'open' | 'done' = 'done'): ShadowTrade =>
    ({ id: `${score}:${netR}:${Math.random()}`, symbol: 'X', signalT: D, entryT: D + DAY, stop: 1, score, status, netR });

  it('分成 2 分與其他，只算已出場的', () => {
    const s = summarizeShadow([t(2, 1), t(2, -1), t(2, 3), t(0, -1), t(1, 0.5), t(-1, 2, 'open')]);
    expect(s.score2).toEqual({ n: 3, avgR: 1, winRate: 2 / 3 });
    expect(s.blocked).toEqual({ n: 2, avgR: -0.25, winRate: 0.5 });
    expect(s.open).toBe(1);
  });

  it('沒有資料時 avgR 是 null', () => {
    expect(summarizeShadow([]).score2).toEqual({ n: 0, avgR: null, winRate: null });
  });
});

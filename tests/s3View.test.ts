import { describe, it, expect } from 'vitest';
import { nextDecisionAt, haltProgress, unrealizedR, legUnrealizedR, todaySummary } from '../src/lib/s3s1/view';

const DAY = 86_400_000;
const X = Date.UTC(2026, 9, 7);

describe('nextDecisionAt', () => {
  it('00:00:30 之前回當天 00:00:30，之後回隔天', () => {
    expect(nextDecisionAt(X + 10_000)).toBe(X + 30_000);
    expect(nextDecisionAt(X + 30_000)).toBe(X + DAY + 30_000);
    expect(nextDecisionAt(X + 15 * 3_600_000)).toBe(X + DAY + 30_000);
  });
});

describe('haltProgress', () => {
  it('回撤與 summarizeLive 同口徑；缺值當 0', () => {
    expect(haltProgress({})).toEqual({ ddPct: 0, ddLimit: 35, streak: 0, streakLimit: 7, halted: null });
    const h = haltProgress({ baseEquity: '1000', realized: '50', peakRealized: '100', lossStreak: '3', halted: '回撤 36% > 35%' });
    expect(h.ddPct).toBeCloseTo(50 / 1100 * 100, 9);
    expect(h.streak).toBe(3);
    expect(h.halted).toBe('回撤 36% > 35%');
  });
});

describe('unrealizedR', () => {
  const p = { entry: 10, stop0: 9, qty0: 30, partial: false, tpQty: 10 };
  it('未平 1/3：(價 − 進場) ÷ 1R', () => {
    expect(unrealizedR(p, 11.5)).toBeCloseTo(1.5, 9);
    expect(unrealizedR(p, 9.5)).toBeCloseTo(-0.5, 9);
  });
  it('已平 1/3：已實現的 1R × 1/3 ＋ 剩餘部位的浮動', () => {
    expect(unrealizedR({ ...p, partial: true }, 12)).toBeCloseTo(10 / 30 * 1 + 20 / 30 * 2, 9);
  });
  it('沒有價格回 null', () => {
    expect(unrealizedR(p, 0)).toBe(null);
  });
});

describe('todaySummary', () => {
  it('快照不存在：ready=false', () => {
    expect(todaySummary(null, [], X + 1000)).toMatchObject({ X, ready: false, btcOk: null, breadth: null, candidates: 0 });
  });
  it('只算訊號日 = X−1 的紀錄；開倉與擋掉分開', () => {
    const snap = { X, breadth: 0.61, btcOk: { [String(X - DAY)]: true }, s3: [{ symbol: 'AUSDT' }, { symbol: 'BUSDT' }] };
    const s = todaySummary(snap, [
      { symbol: 'AUSDT', signalDay: X - DAY, decision: 'open' },
      { symbol: 'BUSDT', signalDay: X - DAY, decision: 'skip', reason: '分數 1' },
      { symbol: 'CUSDT', signalDay: X - 2 * DAY, decision: 'open' },
    ], X + 3_600_000);
    expect(s).toEqual({ X, ready: true, btcOk: true, breadth: 0.61, candidates: 2, opened: ['AUSDT'], blocked: [{ symbol: 'BUSDT', reason: '分數 1' }] });
  });
});

describe('legUnrealizedR', () => {
  const p = { entry: 10, stop0: 9, qty0: 50, partial: false, tpQty: 16,
    legs: { A: { qty0: 30, tpQty: 10 }, B: { qty0: 20, tpQty: 6 } }, addQty: 30, addFilled: false };
  it('沒有 legs 的舊紀錄：A 就是整個部位、B 沒有', () => {
    expect(legUnrealizedR({ ...p, legs: undefined }, 11, 'A')).toBeCloseTo(1, 9);
    expect(legUnrealizedR({ ...p, legs: undefined }, 11, 'B')).toBe(null);
  });
  it('B 加碼成交後：加上加碼份 30 × (12 − 11) ÷ (20 × 1R)', () => {
    const b = legUnrealizedR({ ...p, partial: true, addFilled: true }, 12, 'B');
    expect(b).toBeCloseTo(6 / 20 * 1 + 14 / 20 * 2 + 30 / 20, 9);
    expect(legUnrealizedR({ ...p, partial: true, addFilled: true }, 12, 'A')).toBeCloseTo(10 / 30 + 20 / 30 * 2, 9);
  });
});

describe('haltProgress（S3-B）', () => {
  it('B 用 b. 前綴、門檻 40%／15 筆', () => {
    const h = haltProgress({ 'b.baseEquity': '1000', 'b.realized': '-100', 'b.lossStreak': '4' }, 'B');
    expect(h).toEqual({ ddPct: 10, ddLimit: 40, streak: 4, streakLimit: 15, halted: null });
  });
});

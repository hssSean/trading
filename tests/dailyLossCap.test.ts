import { describe, it, expect } from 'vitest';
import {
  sumTradingIncome, evaluateDailyLossCap, utcDayStart, readDailyLossCapFromEnv,
  type IncomeLike,
} from '../src/lib/dailyLossCap';

// 這是唯一一道用「錢」而不是 R 衡量的關卡，也是唯一一道刻意 fail-closed 的。
// 兩個性質都跟專案其餘部分相反，所以都要有測試釘住——後續有人「統一風格」
// 把它改成 fail-open 時，測試會擋下來。

const inc = (o: Partial<IncomeLike>): IncomeLike =>
  ({ incomeType: 'REALIZED_PNL', income: '0', time: 1_000_000, ...o });

describe('sumTradingIncome', () => {
  it('加總已實現損益', () => {
    expect(sumTradingIncome([
      inc({ income: '10' }), inc({ income: '-25.5' }),
    ])).toBeCloseTo(-15.5);
  });

  // 手續費與資金費率是真的從餘額扣掉的錢。只看 REALIZED_PNL 會系統性低估
  // 當日虧損——那個方向的錯會讓上限比使用者以為的更寬鬆。
  it('手續費與資金費率要算進去', () => {
    const total = sumTradingIncome([
      inc({ incomeType: 'REALIZED_PNL', income: '10' }),
      inc({ incomeType: 'COMMISSION', income: '-0.8' }),
      inc({ incomeType: 'FUNDING_FEE', income: '-1.2' }),
    ]);
    expect(total).toBeCloseTo(8);
  });

  // 一次提領會長得像巨額虧損。把它算進來會讓上限被無關的資金操作觸發。
  it('TRANSFER 不算——那是入金出金不是交易結果', () => {
    expect(sumTradingIncome([
      inc({ incomeType: 'REALIZED_PNL', income: '-5' }),
      inc({ incomeType: 'TRANSFER', income: '-5000' }),
      inc({ incomeType: 'WELCOME_BONUS', income: '1000' }),
    ])).toBeCloseTo(-5);
  });

  it('依時間區間過濾', () => {
    const rows = [inc({ income: '-10', time: 500 }), inc({ income: '-3', time: 1500 })];
    expect(sumTradingIncome(rows, 1000)).toBeCloseTo(-3);
    expect(sumTradingIncome(rows, undefined, 1000)).toBeCloseTo(-10);
  });

  it('壞掉的數字跳過不爆', () => {
    expect(sumTradingIncome([inc({ income: 'abc' }), inc({ income: '-5' })])).toBeCloseTo(-5);
  });

  it('空輸入回 0', () => {
    expect(sumTradingIncome([])).toBe(0);
  });
});

describe('evaluateDailyLossCap — 未設定就是停用', () => {
  it.each([null, undefined, 0, -1, NaN])('capUsdt=%s 不擋', (cap) => {
    expect(evaluateDailyLossCap({ realizedUsdt: -99999, capUsdt: cap as number }).blocked).toBe(false);
  });
});

describe('evaluateDailyLossCap — 門檻', () => {
  it('虧損未達上限不擋', () => {
    expect(evaluateDailyLossCap({ realizedUsdt: -79, capUsdt: 80 }).blocked).toBe(false);
  });

  it('剛好達到上限就擋（>=，不是 >）', () => {
    expect(evaluateDailyLossCap({ realizedUsdt: -80, capUsdt: 80 }).blocked).toBe(true);
  });

  it('超過上限擋，理由講出實際數字', () => {
    const r = evaluateDailyLossCap({ realizedUsdt: -123.456, capUsdt: 80 });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('123.46');
    expect(r.reason).toContain('80');
  });

  it('獲利中不擋', () => {
    expect(evaluateDailyLossCap({ realizedUsdt: 500, capUsdt: 80 }).blocked).toBe(false);
  });

  it('損益為 0 不擋', () => {
    expect(evaluateDailyLossCap({ realizedUsdt: 0, capUsdt: 80 }).blocked).toBe(false);
  });
});

// 這一組是這個模組存在的理由的一半。專案其餘關卡查詢失敗都放行（「不要因為
// 基礎設施故障就凍結系統」），這道刻意相反：fail-open 的下檔是無上限虧損，
// fail-closed 的下檔是錯過一些單。
describe('evaluateDailyLossCap — fail-closed', () => {
  it('有設上限但查不到損益 → 擋', () => {
    const r = evaluateDailyLossCap({ realizedUsdt: null, capUsdt: 80 });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('無法取得');
  });

  it('NaN 也算查不到', () => {
    expect(evaluateDailyLossCap({ realizedUsdt: NaN, capUsdt: 80 }).blocked).toBe(true);
  });

  // 沒設定上限 = 使用者選擇不啟用，不是故障。這種情況不該被 fail-closed 波及，
  // 否則沒開這個功能的人會因為查不到損益而整個停擺。
  it('沒設上限時查不到損益也不擋', () => {
    expect(evaluateDailyLossCap({ realizedUsdt: null, capUsdt: null }).blocked).toBe(false);
  });
});

describe('utcDayStart', () => {
  // 幣安的日界線是 UTC。用本地時區會讓上限的重置時點跟交易所對帳兜不攏。
  it('切在 UTC 午夜', () => {
    const t = Date.UTC(2026, 7, 30, 15, 42, 13);
    expect(utcDayStart(t)).toBe(Date.UTC(2026, 7, 30));
  });

  it('UTC 午夜當下就是自己', () => {
    const midnight = Date.UTC(2026, 7, 30);
    expect(utcDayStart(midnight)).toBe(midnight);
  });
});

describe('readDailyLossCapFromEnv', () => {
  it('讀得到正數', () => {
    expect(readDailyLossCapFromEnv({ MAX_DAILY_LOSS_USDT: '150' })).toBe(150);
  });
  it.each(['', '0', '-5', 'abc'])('無效值 %s 視為停用', (v) => {
    expect(readDailyLossCapFromEnv({ MAX_DAILY_LOSS_USDT: v })).toBeNull();
  });
  it('沒設回 null', () => {
    expect(readDailyLossCapFromEnv({})).toBeNull();
  });
});

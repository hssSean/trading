import { describe, it, expect } from 'vitest';
import { s3Findings, type S3StatusInput } from '../src/lib/s3s1/statusCheck';

// npm run status 的 S3 判語。這支決定「哪些狀態要喊」——喊錯（狼來了）跟漏喊一樣糟：
// 2026-09-05 XRP 掛單未成交被印成「裸倉」之後，真的警告就被當成雜訊了。

const DAY = 86_400_000;
const X = 1_800_000_000_000 - (1_800_000_000_000 % DAY); // 某天 UTC 00:00
const H = 3_600_000;

const base = (o: Partial<S3StatusInput> = {}): S3StatusInput => ({
  now: X + 3 * H, lastDay: X, mode: 'live', walletAt: X + 2.5 * H,
  legs: [{ name: 'S3-A', halted: null }, { name: 'S3-B', halted: null }],
  positions: [], exchangeQty: {}, algos: [], xcheck: { lastAt: X + 1.5 * H, badDays: [] }, ...o,
});
const levels = (i: S3StatusInput) => s3Findings(i).map(f => f.level);
const msgs = (i: S3StatusInput) => s3Findings(i).map(f => f.msg).join('\n');

describe('s3Findings', () => {
  it('一切正常：沒有警告', () => {
    expect(levels(base()).filter(l => l !== 'ok')).toEqual([]);
  });

  it('過了進場窗口（UTC 02:00）今天還沒決策：bad', () => {
    const f = s3Findings(base({ lastDay: X - DAY }));
    expect(f.some(x => x.level === 'bad' && x.msg.includes('今天'))).toBe(true);
  });

  it('還在進場窗口內、今天還沒決策：不喊（可能只是還沒輪到）', () => {
    expect(levels(base({ now: X + 20_000, lastDay: X - DAY })).filter(l => l === 'bad')).toEqual([]);
  });

  it('dry 模式：warn（不會真的下單）', () => {
    expect(msgs(base({ mode: 'dry' }))).toContain('只印不下單');
  });

  it('錢包超過 2 小時沒更新：warn（runner 每小時寫一次）', () => {
    expect(s3Findings(base({ walletAt: X })).some(f => f.level === 'warn' && f.msg.includes('權益'))).toBe(true);
  });

  it('策略停用：warn 並帶出原因', () => {
    expect(msgs(base({ legs: [{ name: 'S3-A', halted: '回撤 36% > 35%' }, { name: 'S3-B', halted: null }] }))).toContain('回撤 36%');
  });

  it('有持倉、交易所有部位、止損單在：ok', () => {
    const i = base({
      positions: [{ symbol: 'ADAUSDT', stopAlgoId: 11, tpAlgoId: 12, partial: false }],
      exchangeQty: { ADAUSDT: 100 }, algos: [{ symbol: 'ADAUSDT', algoId: 11 }, { symbol: 'ADAUSDT', algoId: 12 }],
    });
    expect(levels(i).filter(l => l !== 'ok')).toEqual([]);
  });

  it('有持倉但止損單不在交易所：bad', () => {
    const i = base({
      positions: [{ symbol: 'ADAUSDT', stopAlgoId: 11, tpAlgoId: 12, partial: false }],
      exchangeQty: { ADAUSDT: 100 }, algos: [{ symbol: 'ADAUSDT', algoId: 12 }],
    });
    expect(s3Findings(i).some(f => f.level === 'bad' && f.msg.includes('止損'))).toBe(true);
  });

  it('止盈已成交（partial）時止盈單不在是正常的', () => {
    const i = base({
      positions: [{ symbol: 'ADAUSDT', stopAlgoId: 11, tpAlgoId: 12, partial: true }],
      exchangeQty: { ADAUSDT: 66 }, algos: [{ symbol: 'ADAUSDT', algoId: 11 }],
    });
    expect(levels(i).filter(l => l !== 'ok')).toEqual([]);
  });

  it('止盈未成交卻不見：warn', () => {
    const i = base({
      positions: [{ symbol: 'ADAUSDT', stopAlgoId: 11, tpAlgoId: 12, partial: false }],
      exchangeQty: { ADAUSDT: 100 }, algos: [{ symbol: 'ADAUSDT', algoId: 11 }],
    });
    expect(s3Findings(i).some(f => f.level === 'warn' && f.msg.includes('止盈'))).toBe(true);
  });

  it('Redis 有持倉、交易所沒部位：bad（可能已出場但沒結算）', () => {
    const i = base({ positions: [{ symbol: 'ADAUSDT', stopAlgoId: 11, tpAlgoId: 12, partial: false }], exchangeQty: {}, algos: [] });
    expect(s3Findings(i).some(f => f.level === 'bad' && f.msg.includes('交易所沒有部位'))).toBe(true);
  });

  it('沒查交易所（exchangeQty=null）：不做交易所相關判斷', () => {
    const i = base({ positions: [{ symbol: 'ADAUSDT', stopAlgoId: 11, tpAlgoId: 12, partial: false }], exchangeQty: null, algos: null });
    expect(levels(i).filter(l => l === 'bad')).toEqual([]);
  });

  it('對帳有不一致：bad', () => {
    expect(msgs(base({ xcheck: { lastAt: X, badDays: ['2026-10-11'] } }))).toContain('2026-10-11');
  });

  it('對帳超過 3 天沒跑：warn；從沒跑過：warn', () => {
    expect(s3Findings(base({ xcheck: { lastAt: X - 4 * DAY, badDays: [] } })).some(f => f.level === 'warn')).toBe(true);
    expect(s3Findings(base({ xcheck: { lastAt: null, badDays: [] } })).some(f => f.level === 'warn')).toBe(true);
  });
});

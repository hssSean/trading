import { describe, it, expect } from 'vitest';
import { decideXcheckAlert, XCHECK_STALE_MS } from '../src/lib/s3s1/xcheckAlert';

// 研究端 s3_xcheck.py 每天把「研究端重算 vs 線上」的對帳結果寫進 Redis s3s1:xcheck。
// 這支決定要推播什麼：新的不一致（每天只推一次），以及對帳本身停了（電腦沒開）。

const DAY = 86_400_000;
const T = 1_800_000_000_000;
const r = (X: number, ok: boolean, checkedAt = T) =>
  JSON.stringify({ X, day: 'd', ok, diffs: ok ? [] : ['廣度 研究 0.5 ≠ 線上 0.6'], checkedAt });

describe('decideXcheckAlert', () => {
  it('從沒跑過對帳：什麼都不推（還沒設定排程時不要每天吵）', () => {
    expect(decideXcheckAlert({}, [], T)).toEqual({ bad: [], stale: false });
  });

  it('全部一致、最近有跑：不推', () => {
    expect(decideXcheckAlert({ [T - DAY]: r(T - DAY, true) }, [], T)).toEqual({ bad: [], stale: false });
  });

  it('有不一致且還沒推過：推，帶出 diffs', () => {
    const d = decideXcheckAlert({ [T - DAY]: r(T - DAY, false) }, [], T);
    expect(d.bad).toHaveLength(1);
    expect(d.bad[0].X).toBe(T - DAY);
    expect(d.bad[0].diffs[0]).toContain('廣度');
  });

  it('不一致已推過：不重複推', () => {
    expect(decideXcheckAlert({ [T - DAY]: r(T - DAY, false) }, [String(T - DAY)], T).bad).toEqual([]);
  });

  it('最後一次對帳超過 3 天：stale', () => {
    const at = T - XCHECK_STALE_MS - 1;
    expect(decideXcheckAlert({ [at]: r(at, true, at) }, [], T).stale).toBe(true);
  });

  it('壞掉的 JSON 不讓整個判斷掛掉', () => {
    expect(decideXcheckAlert({ x: '{壞', [T - DAY]: r(T - DAY, true) }, [], T)).toEqual({ bad: [], stale: false });
  });

  it('多天不一致按日期排序', () => {
    const d = decideXcheckAlert({ [T - DAY]: r(T - DAY, false), [T - 2 * DAY]: r(T - 2 * DAY, false) }, [], T);
    expect(d.bad.map(b => b.X)).toEqual([T - 2 * DAY, T - DAY]);
  });
});

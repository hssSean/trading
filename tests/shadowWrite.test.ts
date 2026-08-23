import { describe, it, expect } from 'vitest';
import { shadowChanged, snapshot } from '../src/lib/shadowWrite';

// 這支守的是「不要因為省寫入而靜默弄丟資料」。判斷寫太鬆只是多寫幾次
// （浪費額度），判斷寫太緊會讓真的有變化的影子單不被寫回——那是資料
// 遺失，而且完全沒有徵兆。所以測試偏重「什麼情況必須算有變」。

interface S { lastCheckedAt: number; status: string; tp1Hit?: boolean; result?: string; pessResult?: string }
const base: S = { lastCheckedAt: 1000, status: 'active' };

describe('shadowChanged', () => {
  it('只有 lastCheckedAt 不同 → 沒變（這就是要省掉的那 8000 次/天）', () => {
    expect(shadowChanged(base, { ...base, lastCheckedAt: 999_999 })).toBe(false);
  });

  it('完全相同 → 沒變', () => {
    expect(shadowChanged(base, { ...base })).toBe(false);
  });

  it('status 變了 → 有變', () => {
    expect(shadowChanged(base, { ...base, status: 'done', lastCheckedAt: 999_999 })).toBe(true);
  });

  it('新增欄位 → 有變', () => {
    expect(shadowChanged(base, { ...base, result: 'WIN_TP1' })).toBe(true);
  });

  it('欄位從有變成 undefined → 有變', () => {
    const withResult = { ...base, result: 'WIN_TP1' };
    expect(shadowChanged(withResult, base)).toBe(true);
  });

  // 2026-08-22 才加的悲觀軌跡欄位。用 JSON 整體比較而不是逐欄位列舉，
  // 就是為了讓將來新增的欄位自動被涵蓋，不用記得回來改這裡。
  it('後來才加的欄位（pessResult）也算', () => {
    expect(shadowChanged(base, { ...base, pessResult: 'LOSS' })).toBe(true);
  });

  it('boolean 從 false 變 true → 有變', () => {
    expect(shadowChanged({ ...base, tp1Hit: false }, { ...base, tp1Hit: true })).toBe(true);
  });

  // 邊界：lastCheckedAt 本來就是 0 的情況不能被正規化搞混。
  it('lastCheckedAt 原本就是 0 也正常運作', () => {
    const z = { ...base, lastCheckedAt: 0 };
    expect(shadowChanged(z, { ...z, lastCheckedAt: 5000 })).toBe(false);
    expect(shadowChanged(z, { ...z, status: 'done' })).toBe(true);
  });
});

describe('snapshot', () => {
  it('回傳的是獨立副本，改動不會影響原物件', () => {
    const orig = { lastCheckedAt: 1, status: 'active', nested: { a: 1 } };
    const copy = snapshot(orig);
    copy.status = 'done';
    copy.nested.a = 2;
    expect(orig.status).toBe('active');
    expect(orig.nested.a).toBe(1);
  });

  // 就地修改型的推進函數（simulateShadow）需要先快照才比得出前後差異。
  it('快照後就地修改，shadowChanged 能抓到差異', () => {
    const st = { lastCheckedAt: 1000, status: 'active' };
    const before = snapshot(st);
    st.status = 'done';
    st.lastCheckedAt = 2000;
    expect(shadowChanged(before, st)).toBe(true);
  });

  it('快照後只動 lastCheckedAt，shadowChanged 回 false', () => {
    const st = { lastCheckedAt: 1000, status: 'active' };
    const before = snapshot(st);
    st.lastCheckedAt = 2000;
    expect(shadowChanged(before, st)).toBe(false);
  });
});

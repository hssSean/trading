import { describe, it, expect } from 'vitest';
import { shouldPromptUpdate } from '../src/lib/buildVersion';

describe('shouldPromptUpdate', () => {
  it('sha 不同就提示', () => {
    expect(shouldPromptUpdate({ local: 'aaa', server: 'bbb', dismissed: null })).toBe(true);
  });

  it('sha 相同不提示', () => {
    expect(shouldPromptUpdate({ local: 'aaa', server: 'aaa', dismissed: null })).toBe(false);
  });

  // 本機開發沒有 VERCEL_GIT_COMMIT_SHA，兩邊都空。這裡如果誤判成「有新版」，
  // 開發時每次切分頁都會跳橫幅。
  it('本機開發（sha 為空）不提示', () => {
    expect(shouldPromptUpdate({ local: '', server: '', dismissed: null })).toBe(false);
    expect(shouldPromptUpdate({ local: undefined, server: 'bbb', dismissed: null })).toBe(false);
    expect(shouldPromptUpdate({ local: 'aaa', server: undefined, dismissed: null })).toBe(false);
  });

  // 伺服器暫時取不到（離線／函數冷啟失敗）不能被當成「有新版」。
  it('伺服器 sha 取不到不提示', () => {
    expect(shouldPromptUpdate({ local: 'aaa', server: '', dismissed: null })).toBe(false);
  });

  it('關閉過的版本不再提示', () => {
    expect(shouldPromptUpdate({ local: 'aaa', server: 'bbb', dismissed: 'bbb' })).toBe(false);
  });

  // 關掉 bbb 之後又部署了 ccc——這是新的一版，要重新提示，不能被舊的
  // dismissed 永久靜音。
  it('關閉後又有更新版本仍會提示', () => {
    expect(shouldPromptUpdate({ local: 'aaa', server: 'ccc', dismissed: 'bbb' })).toBe(true);
  });

  // dismissed 意外等於自己這一版時，local===server 已經先擋掉，不該有例外路徑。
  it('dismissed 等於 local 且無新版時不提示', () => {
    expect(shouldPromptUpdate({ local: 'aaa', server: 'aaa', dismissed: 'aaa' })).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadEnvFile, reportEnvLoad } from '../scripts/loadEnvFile';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// 這支守兩件事：
//   1. shell 設的值不能被檔案蓋掉——在 EC2 上被一個過期的本機檔案靜默覆蓋
//      正式設定，是那種要查很久的故障。
//   2. **任何輸出都不能包含值。** 診斷訊息洩漏金鑰前綴是真實的事故類型，
//      而這個載入器專門用來處理 service role key 和交易所 secret。

let dir: string;
const KEYS = ['TEST_A', 'TEST_B', 'TEST_QUOTED', 'TEST_EXPORT', 'TEST_EQ_IN_VALUE'];

function writeEnv(content: string): string {
  const p = join(dir, '.env.test');
  writeFileSync(p, content, 'utf-8');
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envtest-'));
  KEYS.forEach(k => { delete process.env[k]; });
});
afterEach(() => {
  KEYS.forEach(k => { delete process.env[k]; });
  rmSync(dir, { recursive: true, force: true });
});

describe('loadEnvFile — 解析', () => {
  it('讀出 key=value，跳過空行與註解', () => {
    const r = loadEnvFile(writeEnv('# comment\n\nTEST_A=hello\nTEST_B=world\n'));
    expect(process.env.TEST_A).toBe('hello');
    expect(process.env.TEST_B).toBe('world');
    expect(r.applied.sort()).toEqual(['TEST_A', 'TEST_B']);
  });

  it('脫掉整段包住的引號', () => {
    loadEnvFile(writeEnv('TEST_QUOTED="quoted value"\n'));
    expect(process.env.TEST_QUOTED).toBe('quoted value');
  });

  it('容忍 export 前綴（從 shell 設定複製過來的常見寫法）', () => {
    loadEnvFile(writeEnv('export TEST_EXPORT=abc\n'));
    expect(process.env.TEST_EXPORT).toBe('abc');
  });

  // JWT 和 base64 金鑰裡有 = 是常態，只能切第一個。
  it('值裡面的 = 不會被切掉', () => {
    loadEnvFile(writeEnv('TEST_EQ_IN_VALUE=eyJhbGci=abc==\n'));
    expect(process.env.TEST_EQ_IN_VALUE).toBe('eyJhbGci=abc==');
  });

  it('檔案不存在時回 found:false，不拋例外', () => {
    const r = loadEnvFile(join(dir, 'does-not-exist'));
    expect(r.found).toBe(false);
    expect(r.applied).toEqual([]);
  });
});

describe('loadEnvFile — 不覆蓋 shell 設定', () => {
  it('shell 已設的值優先，檔案的被跳過', () => {
    process.env.TEST_A = 'from-shell';
    const r = loadEnvFile(writeEnv('TEST_A=from-file\nTEST_B=only-in-file\n'));
    expect(process.env.TEST_A).toBe('from-shell');
    expect(process.env.TEST_B).toBe('only-in-file');
    expect(r.skipped).toEqual(['TEST_A']);
    expect(r.applied).toEqual(['TEST_B']);
  });

  // 空字串代表「沒設好」，那種情況該讓檔案補上，否則會拿空字串去打 API
  // 然後收到一個跟根因無關的授權錯誤。
  it('shell 設成空字串時視為未設定，由檔案補上', () => {
    process.env.TEST_A = '';
    loadEnvFile(writeEnv('TEST_A=from-file\n'));
    expect(process.env.TEST_A).toBe('from-file');
  });
});

describe('reportEnvLoad — 絕不輸出值', () => {
  it('輸出只有變數名，沒有任何值', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.TEST_B = 'shell-secret-value';
    const r = loadEnvFile(writeEnv('TEST_A=super-secret-key-value\nTEST_B=file-value\n'));
    reportEnvLoad(r);

    const out = spy.mock.calls.map(c => c.join(' ')).join('\n');
    spy.mockRestore();

    expect(out).toContain('TEST_A');
    expect(out).not.toContain('super-secret-key-value');
    expect(out).not.toContain('shell-secret-value');
    expect(out).not.toContain('file-value');
  });

  it('回傳結構本身也不帶值', () => {
    const r = loadEnvFile(writeEnv('TEST_A=super-secret-key-value\n'));
    expect(JSON.stringify(r)).not.toContain('super-secret-key-value');
  });
});

// §9 數值一致性驗證：TS 版對相同範例資料的輸出必須與 Python 版 golden files 一致。
// - 確定性指標：相對誤差 < 1e-9
// - Bootstrap（p 值 / CI）：不同 PRNG，固定 seed 下 p 差 < 0.02
// - 裁決等級、紅旗集合、per-tag：完全一致

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeLog, toComparableDict } from '../../src/lib/antigambling/analyzer';
import { EXAMPLE_FILES } from '../../src/lib/antigambling/examples';
import { parseTradeLog } from '../../src/lib/antigambling/ingest';

const FIXTURES = join(__dirname, 'fixtures');

// Bootstrap 派生欄位（不同 PRNG → 容差比對）
const BOOTSTRAP_KEYS = new Set(['p_value_bootstrap', 'ci_low', 'ci_high']);
// 由 bootstrap 顯著性推導的布林（p 遠離 0.05 時必然一致；仍精確比對）
const REL_TOL = 1e-9;
const P_BOOT_TOL = 0.02;

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function runTs(exampleKey: string) {
  const ex = EXAMPLE_FILES.find(e => e.key === exampleKey)!;
  const ingest = parseTradeLog({ text: ex.content, format: ex.format, fileName: ex.fileName });
  const result = analyzeLog(ingest.log, { nBootstrap: 5000 });
  return toComparableDict(result) as Record<string, unknown>;
}

/** 遞迴比對 TS 輸出與 golden（以 TS 輸出的鍵為準 —— golden 是超集，含 profile 等）。 */
function compareDeep(ts: unknown, golden: unknown, path: string, errors: string[]): void {
  if (ts === null || golden === null) {
    // Python None ↔ TS null；數值 0 與 null 不互通
    if (ts !== golden) errors.push(`${path}: TS=${JSON.stringify(ts)} golden=${JSON.stringify(golden)}`);
    return;
  }
  if (typeof ts === 'number' && typeof golden === 'number') {
    const key = path.split('.').pop() ?? '';
    const tol = BOOTSTRAP_KEYS.has(key)
      ? (key === 'p_value_bootstrap' ? P_BOOT_TOL : Math.max(Math.abs(golden) * 0.15, P_BOOT_TOL))
      : Math.max(Math.abs(golden) * REL_TOL, 1e-9);
    if (Math.abs(ts - golden) > tol) {
      errors.push(`${path}: TS=${ts} golden=${golden} (diff=${Math.abs(ts - golden)}, tol=${tol})`);
    }
    return;
  }
  if (Array.isArray(ts) && Array.isArray(golden)) {
    if (ts.length !== golden.length) {
      errors.push(`${path}: 陣列長度不同 TS=${ts.length} golden=${golden.length}`);
      return;
    }
    ts.forEach((v, i) => compareDeep(v, golden[i], `${path}[${i}]`, errors));
    return;
  }
  if (typeof ts === 'object' && typeof golden === 'object') {
    for (const [k, v] of Object.entries(ts as Record<string, unknown>)) {
      const gv = (golden as Record<string, unknown>)[k];
      if (gv === undefined) { errors.push(`${path}.${k}: golden 缺此鍵`); continue; }
      compareDeep(v, gv, `${path}.${k}`, errors);
    }
    return;
  }
  if (ts !== golden) errors.push(`${path}: TS=${JSON.stringify(ts)} golden=${JSON.stringify(golden)}`);
}

function redFlagCodes(v: unknown): string[] {
  return ((v as { verdict: { red_flags: { code: string }[] } }).verdict.red_flags).map(f => f.code);
}

describe.each([
  ['us_edge', 'golden_us_edge.json'],
  ['tw_gambling', 'golden_tw_gambling.json'],
  ['crypto_luck', 'golden_crypto_luck.json'],
])('golden 一致性：%s', (exampleKey, goldenFile) => {
  const golden = loadGolden(goldenFile);
  const ts = runTs(exampleKey);

  it('裁決等級與紅旗集合完全一致', () => {
    const gv = (golden as { verdict: { level: string } }).verdict;
    const tv = (ts as { verdict: { level: string } }).verdict;
    expect(tv.level).toBe(gv.level);
    expect(redFlagCodes(ts)).toEqual(redFlagCodes(golden));
  });

  it('全部欄位在容差內一致（確定性 1e-9；bootstrap 0.02）', () => {
    const errors: string[] = [];
    compareDeep(ts, golden, '$', errors);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

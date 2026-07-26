import { describe, expect, it } from 'vitest';
import { clampAutoCloseAfterTp1 } from '../src/lib/monitorMath';

describe('clampAutoCloseAfterTp1', () => {
  // 2026-07-26 實測 bug：ETH LONG, entry 1860.535, TP1 達標後 trailingStop 棘輪到
  // 1870（高於 entry），之後緩跌到 24h 到期，lastClose 跌到 1858.35（低於 entry）。
  // 沒有 clamp 時出場價直接用 lastClose，吐回虧損。
  it('LONG：lastClose 跌破已棘輪的 trailingStop 時，出場價夾在 trailingStop', () => {
    const out = clampAutoCloseAfterTp1(1858.35, 1870, 1860.535, true);
    expect(out).toBe(1870);
  });

  it('LONG：lastClose 仍高於 trailingStop 時，直接用 lastClose（不強制拉高出場價）', () => {
    const out = clampAutoCloseAfterTp1(1880, 1870, 1860.535, true);
    expect(out).toBe(1880);
  });

  it('LONG：trailingStop 尚未棘輪過（0，例如策略B）時，地板退回 entry', () => {
    const out = clampAutoCloseAfterTp1(1855, 0, 1860.535, true);
    expect(out).toBe(1860.535);
  });

  it('SHORT：lastClose 高於已棘輪的 trailingStop 時，出場價夾在 trailingStop', () => {
    const out = clampAutoCloseAfterTp1(485, 480, 483.7867, false);
    expect(out).toBe(480);
  });

  it('SHORT：lastClose 仍低於 trailingStop 時，直接用 lastClose', () => {
    const out = clampAutoCloseAfterTp1(470, 480, 483.7867, false);
    expect(out).toBe(470);
  });

  it('SHORT：trailingStop 尚未棘輪過（0）時，地板退回 entry', () => {
    const out = clampAutoCloseAfterTp1(485, 0, 483.7867, false);
    expect(out).toBe(483.7867);
  });
});

import { describe, it, expect } from 'vitest';
import { mergeS3Rows, rowMatches, type SignalItem } from '../src/lib/s3s1/signalsView';

const it0 = (src: SignalItem['src'], symbol: string, t: number, decision: 'open' | 'skip', reason?: string): SignalItem =>
  ({ src, symbol, t, decision, reason, close: 1, stop: 0.9 });

describe('mergeS3Rows', () => {
  it('同幣同一根 S3 訊號的真倉與兩個帳本合併成一列，真倉當主列', () => {
    const rows = mergeS3Rows([
      it0('s3b', 'NEAR', 10, 'skip', '分數 0'),
      it0('s3a', 'NEAR', 10, 'skip', '分數 0'),
      it0('live', 'NEAR', 10, 'skip', '分數 0 < 2'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].src).toBe('live');
    expect(rows[0].also.map(a => a.src)).toEqual(['s3a', 's3b']);
  });
  it('沒有真倉時由帳本 S3-A 當主列', () => {
    const rows = mergeS3Rows([it0('s3b', 'X', 5, 'open'), it0('s3a', 'X', 5, 'skip', '持倉上限 10 筆')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].src).toBe('s3a');
    expect(rows[0].also).toEqual([{ src: 's3b', decision: 'open', reason: undefined }]);
  });
  it('S1／BR 不合併，不同時間或不同幣也不合併，順序新到舊', () => {
    const rows = mergeS3Rows([
      it0('s1', 'A', 7, 'open'), it0('br', 'A', 7, 'skip', 'x'),
      it0('s3a', 'B', 3, 'open'), it0('s3a', 'C', 3, 'open'), it0('s3a', 'B', 9, 'open'),
    ]);
    expect(rows.map(r => `${r.src}:${r.symbol}:${r.t}`)).toEqual(['s3a:B:9', 's1:A:7', 'br:A:7', 's3a:B:3', 's3a:C:3']);
    expect(rows.every(r => r.also.length === 0)).toBe(true);
  });
  it('決策篩選看合併後任一來源', () => {
    const [r] = mergeS3Rows([it0('live', 'N', 1, 'skip', '持倉中'), it0('s3a', 'N', 1, 'open')]);
    expect(rowMatches(r, 'open')).toBe(true);
    expect(rowMatches(r, 'skip')).toBe(true);
    expect(rowMatches(r, 'all')).toBe(true);
    const [s] = mergeS3Rows([it0('s1', 'Z', 1, 'skip', 'BTC 條件不成立')]);
    expect(rowMatches(s, 'open')).toBe(false);
  });
});

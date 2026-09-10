import { describe, it, expect } from 'vitest';
import { ScanTiming } from '@/lib/scanTiming';

// 假時鐘：讓 mark() 的耗時完全可預測，不受機器速度影響。
function fakeClock(seq: number[]): () => number {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

describe('ScanTiming', () => {
  it('累加同一個標籤的耗時與次數', () => {
    // now() 依序回傳 100、250 → 兩次 mark 分別耗 100ms 與 200ms
    const t = new ScanTiming(fakeClock([100, 250]));
    t.mark('generateSignals:5m', 0);   // 100 - 0
    t.mark('generateSignals:5m', 50);  // 250 - 50

    expect(t.snapshot()).toEqual([
      { label: 'generateSignals:5m', ms: 300, n: 2 },
    ]);
  });

  it('依總耗時由大到小排序', () => {
    const t = new ScanTiming(fakeClock([10, 100, 40]));
    t.mark('fetch:1h', 0);   //  10
    t.mark('fetch:5m', 0);   // 100
    t.mark('fetch:15m', 0);  //  40

    expect(t.snapshot().map(r => r.label)).toEqual(['fetch:5m', 'fetch:15m', 'fetch:1h']);
  });

  it('format 附上佔比——這是整個模組存在的理由', () => {
    const t = new ScanTiming(fakeClock([75, 100]));
    t.mark('a', 0);  // 75
    t.mark('b', 75); // 25

    const line = t.format();
    expect(line).toContain('a 75ms/1次 75.0%');
    expect(line).toContain('b 25ms/1次 25.0%');
    expect(line).toContain('total 100ms');
  });

  it('沒有任何 mark 時不會除以零', () => {
    const t = new ScanTiming(fakeClock([0]));
    expect(t.snapshot()).toEqual([]);
    expect(t.format()).toBe('total 0ms');
  });

  it('負的經過時間夾成 0——時鐘回跳不該產生負佔比', () => {
    const t = new ScanTiming(fakeClock([50]));
    t.mark('weird', 200); // 50 - 200 = -150
    expect(t.snapshot()).toEqual([{ label: 'weird', ms: 0, n: 1 }]);
  });
});

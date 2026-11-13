import { describe, expect, it } from 'vitest';
import { buildSeats, buildSquawk, fmtHm, type SeatId } from '@/lib/office/seats';
import { DEMO_NOW, demoLedgers, demoOverview, demoSignals } from '@/lib/office/demo';

const seat = (id: SeatId, ...a: Parameters<typeof buildSeats>) => buildSeats(...a).find(s => s.id === id)!;
const all = () => [demoOverview(), demoSignals(), demoLedgers(), DEMO_NOW] as const;

describe('buildSeats', () => {
  it('固定 8 個座位、固定順序', () => {
    expect(buildSeats(...all()).map(s => s.id)).toEqual(['chief', 'scan', 's3a', 's3b', 's1', 'br', 'ctrend', 'risk']);
  });

  it('全部 API 失敗 → 全部 unknown', () => {
    expect(buildSeats(null, null, null, DEMO_NOW).every(s => s.state === 'unknown')).toBe(true);
  });

  it('CHIEF：心跳新鮮且有持倉 = working；心跳過期 = alert', () => {
    expect(seat('chief', ...all()).state).toBe('working');
    const ov = { ...demoOverview(), heartbeatAt: DEMO_NOW - 10 * 60_000 };
    expect(seat('chief', ov, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('alert');
    const ov2 = { ...demoOverview(), positions: [] };
    expect(seat('chief', ov2, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('idle');
  });

  it('SCAN：有今天快照 = idle 並顯示廣度；UTC 00:10 前沒快照 = idle；之後沒快照 = alert', () => {
    const s = seat('scan', ...all());
    expect(s.state).toBe('idle');
    expect(s.bubble).toContain('31%');
    const X = Math.floor(DEMO_NOW / 86_400_000) * 86_400_000;
    const ov = { ...demoOverview(), snapshot: null };
    expect(seat('scan', ov, null, null, X + 5 * 60_000).state).toBe('idle');
    expect(seat('scan', ov, null, null, X + 60 * 60_000).state).toBe('alert');
  });

  it('S3-A：今天 A 腿開倉 = celebrate；S3-B：B 腿被擋、沒持倉 = idle', () => {
    expect(seat('s3a', ...all()).state).toBe('celebrate');
    expect(seat('s3b', ...all()).state).toBe('idle');
  });

  it('S3-B：停用 = alert', () => {
    const ov = demoOverview();
    ov.meta = { ...ov.meta, 'b.halted': '連虧 15' };
    expect(seat('s3b', ov, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('alert');
  });

  it('S3-A：今天沒訊號但有 A 腿持倉 = working', () => {
    const ov = { ...demoOverview(), signals: [] };
    expect(seat('s3a', ov, demoSignals(), demoLedgers(), DEMO_NOW).state).toBe('working');
  });

  it('S1：24 小時內有開倉 = celebrate；BR：沒持倉沒開倉 = idle；停用 = alert', () => {
    expect(seat('s1', ...all()).state).toBe('celebrate');
    expect(seat('br', ...all()).state).toBe('idle');
    const led = demoLedgers();
    led.accounts[3].summary.halted = '回撤 > 60%';
    expect(seat('br', demoOverview(), demoSignals(), led, DEMO_NOW).state).toBe('alert');
  });

  it('S1：訊號 API 失敗時不慶祝，有持倉 = working', () => {
    expect(seat('s1', demoOverview(), null, demoLedgers(), DEMO_NOW).state).toBe('working');
  });

  it('CTREND：有持倉週 = working；過期 = alert；還沒跑過 = alert', () => {
    expect(seat('ctrend', ...all()).state).toBe('working');
    const led = demoLedgers();
    led.ctrend = { ...led.ctrend!, stale: true };
    expect(seat('ctrend', demoOverview(), demoSignals(), led, DEMO_NOW).state).toBe('alert');
    expect(seat('ctrend', demoOverview(), demoSignals(), { ...demoLedgers(), ctrend: null }, DEMO_NOW).state).toBe('alert');
  });

  it('RISK：今天有擋單 = working 並寫出筆數；任一停用 = alert', () => {
    const r = seat('risk', ...all());
    expect(r.state).toBe('working');
    expect(r.bubble).toContain('1');
    const led = demoLedgers();
    led.accounts[2].summary.halted = '勝率 < 45%';
    expect(seat('risk', demoOverview(), demoSignals(), led, DEMO_NOW).state).toBe('alert');
  });
});

describe('buildSquawk', () => {
  it('合併真倉與帳本訊號，新到舊', () => {
    const lines = buildSquawk(demoOverview(), demoSignals());
    expect(lines.length).toBe(5);
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1].at).toBeGreaterThanOrEqual(lines[i].at);
  });

  it('擋單寫理由、開倉是 open', () => {
    const lines = buildSquawk(demoOverview(), demoSignals());
    expect(lines.find(l => l.text.startsWith('AVAX'))!.text).toContain('分數 1 < 2');
    expect(lines.find(l => l.text.startsWith('SOL') && l.tag === 'S3')!.tone).toBe('open');
  });

  it('limit 截斷、輸入都是 null 回空陣列', () => {
    expect(buildSquawk(demoOverview(), demoSignals(), 2).length).toBe(2);
    expect(buildSquawk(null, null)).toEqual([]);
  });
});

describe('fmtHm', () => {
  it('台灣時間', () => {
    expect(fmtHm(Date.UTC(2026, 10, 13, 0, 5))).toBe('08:05');
  });
});

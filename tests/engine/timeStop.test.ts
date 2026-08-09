import { describe, expect, it } from 'vitest';
import { decideTimeStop, TimeStopInput } from '../../src/engine/timeStop';

const HOUR = 3_600_000;

function baseInput(overrides: Partial<TimeStopInput> = {}): TimeStopInput {
  return {
    isLong: true,
    entry: 65000,
    stopLoss: 64000, // riskDist = 1000
    timeframe: '1h',
    filledAt: 0,
    now: 9 * HOUR, // 9 小時 = 9 根 1h K 線，超過 8 根門檻
    markPrice: 65200, // (65200-65000)/1000 = 0.2R，落在 -0.3~0.3 之間
    isTp1Hit: false,
    trailingStop: 0,
    ...overrides,
  };
}

describe('decideTimeStop — 盤整停滯（time_stop_stall）', () => {
  it('fires when 8+ bars have passed and progress is stuck between -0.3R and 0.3R', () => {
    const d = decideTimeStop(baseInput());
    expect(d.fired).toBe(true);
    if (!d.fired) return;
    expect(d.closeReason).toBe('time_stop_stall');
    expect(d.closePrice).toBe(65200);
  });

  it('does NOT fire before 8 bars have passed', () => {
    const d = decideTimeStop(baseInput({ now: 7 * HOUR }));
    expect(d.fired).toBe(false);
  });

  it('does NOT fire when progress is already favorable (> 0.3R, giving it room to run)', () => {
    // (65400-65000)/1000 = 0.4R > 0.3
    const d = decideTimeStop(baseInput({ markPrice: 65400 }));
    expect(d.fired).toBe(false);
  });

  it('does NOT fire when progress is already unfavorable (< -0.3R, let the real stop decide)', () => {
    // (64600-65000)/1000 = -0.4R < -0.3
    const d = decideTimeStop(baseInput({ markPrice: 64600 }));
    expect(d.fired).toBe(false);
  });

  it('mirrors the progress calculation for SHORT', () => {
    const d = decideTimeStop(baseInput({
      isLong: false, entry: 65000, stopLoss: 66000, markPrice: 64800, // (65000-64800)/1000 = 0.2R
    }));
    expect(d.fired).toBe(true);
    if (!d.fired) return;
    expect(d.closeReason).toBe('time_stop_stall');
  });

  it('never fires the stall check once TP1 has been hit', () => {
    const d = decideTimeStop(baseInput({ isTp1Hit: true, now: 9 * HOUR }));
    // TP1 已達標，8 根K線盤整停滯不該關單——只有到期自動平倉（24h）才適用，
    // 9小時遠沒到 24h，這個 case 應該完全不觸發任何動作。
    expect(d.fired).toBe(false);
  });

  it('respects the timeframe-specific bar length (4h timeframe needs 32h for 8 bars)', () => {
    const d7h = decideTimeStop(baseInput({ timeframe: '4h', now: 31 * HOUR }));
    expect(d7h.fired).toBe(false); // 31h < 8*4h=32h
    const d8bars = decideTimeStop(baseInput({ timeframe: '4h', now: 32 * HOUR }));
    expect(d8bars.fired).toBe(true);
  });
});

describe('decideTimeStop — 到期自動平倉（time_stop_expiry / _post_tp1）', () => {
  it('fires time_stop_expiry after 24h for intraday timeframes when TP1 not yet hit', () => {
    const d = decideTimeStop(baseInput({
      timeframe: '15m', now: 24 * HOUR, markPrice: 65400, // progress 0.4R，本來不會觸發盤整停滯
    }));
    expect(d.fired).toBe(true);
    if (!d.fired) return;
    expect(d.closeReason).toBe('time_stop_expiry');
    expect(d.closePrice).toBe(65400);
  });

  it('fires time_stop_expiry_post_tp1 after 24h once TP1 was hit, clamped by clampAutoCloseAfterTp1', () => {
    const d = decideTimeStop(baseInput({
      timeframe: '15m', now: 24 * HOUR, isTp1Hit: true, trailingStop: 65500, markPrice: 65300,
    }));
    expect(d.fired).toBe(true);
    if (!d.fired) return;
    expect(d.closeReason).toBe('time_stop_expiry_post_tp1');
    // clampAutoCloseAfterTp1: LONG → max(markPrice, trailingStop) = max(65300, 65500) = 65500
    expect(d.closePrice).toBe(65500);
  });

  it('uses 72h threshold for 4h timeframe (not the default 24h)', () => {
    const before = decideTimeStop(baseInput({ timeframe: '4h', now: 71 * HOUR, markPrice: 65400 }));
    expect(before.fired).toBe(false); // 8-bar stall check also wouldn't fire (0.4R), so pure expiry check
    const after = decideTimeStop(baseInput({ timeframe: '4h', now: 72 * HOUR, markPrice: 65400 }));
    expect(after.fired).toBe(true);
    if (!after.fired) return;
    expect(after.closeReason).toBe('time_stop_expiry');
  });

  it('uses 168h threshold for 1d timeframe', () => {
    const before = decideTimeStop(baseInput({ timeframe: '1d', now: 167 * HOUR, markPrice: 65400 }));
    expect(before.fired).toBe(false);
    const after = decideTimeStop(baseInput({ timeframe: '1d', now: 168 * HOUR, markPrice: 65400 }));
    expect(after.fired).toBe(true);
  });
});

describe('decideTimeStop — edge cases', () => {
  it('returns fired:false when riskDist is zero or invalid (entry === stopLoss)', () => {
    const d = decideTimeStop(baseInput({ stopLoss: 65000 }));
    expect(d.fired).toBe(false);
  });

  it('does nothing at all when neither condition is met', () => {
    const d = decideTimeStop(baseInput({ now: 1 * HOUR })); // too early for both checks
    expect(d.fired).toBe(false);
  });
});

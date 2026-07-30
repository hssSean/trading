import { describe, it, expect } from 'vitest';
import { updateMfeMae } from '../src/lib/monitorMath';

const bar = (high: number, low: number) => ({ high, low });

describe('updateMfeMae', () => {
  it('LONG: tracks the highest high as MFE and the lowest low as MAE', () => {
    const r = updateMfeMae([bar(105, 99), bar(110, 102), bar(108, 95)], true, null, null);
    expect(r.mfePrice).toBe(110); // best high across the batch
    expect(r.maePrice).toBe(95);  // worst low across the batch
    expect(r.changed).toBe(true);
  });

  it('SHORT: tracks the lowest low as MFE and the highest high as MAE (mirrored)', () => {
    const r = updateMfeMae([bar(105, 99), bar(110, 102), bar(108, 95)], false, null, null);
    expect(r.mfePrice).toBe(95);  // best (lowest) low for a short
    expect(r.maePrice).toBe(110); // worst (highest) high for a short
  });

  it('first scan (null priors) seeds both from the first candle, not from 0', () => {
    const r = updateMfeMae([bar(100, 98)], true, null, null);
    expect(r.mfePrice).toBe(100);
    expect(r.maePrice).toBe(98);
  });

  it('LONG: only extends MFE upward, never retreats when a later candle is lower', () => {
    const r = updateMfeMae([bar(100, 100)], true, /* priorMfe */ 120, /* priorMae */ 90);
    expect(r.mfePrice).toBe(120); // unchanged — 100 < 120
    expect(r.maePrice).toBe(90);  // unchanged — 100 > 90
    expect(r.changed).toBe(false);
  });

  it('LONG: extends MFE when the new batch makes a new high', () => {
    const r = updateMfeMae([bar(130, 125)], true, 120, 90);
    expect(r.mfePrice).toBe(130);
    expect(r.maePrice).toBe(90); // low 125 doesn't beat prior MAE 90
    expect(r.changed).toBe(true);
  });

  it('LONG: extends MAE when the new batch makes a new low', () => {
    const r = updateMfeMae([bar(121, 80)], true, 120, 90);
    expect(r.mfePrice).toBe(121);
    expect(r.maePrice).toBe(80);
    expect(r.changed).toBe(true);
  });

  it('SHORT: only extends MFE downward, never retreats when a later candle is higher', () => {
    const r = updateMfeMae([bar(100, 100)], false, /* priorMfe */ 80, /* priorMae */ 110);
    expect(r.mfePrice).toBe(80);  // unchanged — 100 > 80
    expect(r.maePrice).toBe(110); // unchanged — 100 < 110
    expect(r.changed).toBe(false);
  });

  it('empty candle batch leaves priors untouched and reports no change', () => {
    const r = updateMfeMae([], true, 120, 90);
    expect(r).toEqual({ mfePrice: 120, maePrice: 90, changed: false });
  });

  it('empty batch with null priors stays null', () => {
    const r = updateMfeMae([], true, null, null);
    expect(r).toEqual({ mfePrice: null, maePrice: null, changed: false });
  });
});

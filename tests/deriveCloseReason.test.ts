import { describe, it, expect } from 'vitest';
import { deriveCloseReason } from '../src/lib/monitorMath';

describe('deriveCloseReason', () => {
  it('WIN_TP2 → tp2', () => {
    expect(deriveCloseReason({ closeResult: 'WIN_TP2', timeStopFired: false, autoClosedAfterTp1: false })).toBe('tp2');
  });

  it('LOSS → stop_loss', () => {
    expect(deriveCloseReason({ closeResult: 'LOSS', timeStopFired: false, autoClosedAfterTp1: false })).toBe('stop_loss');
  });

  it('MANUAL_CLOSE + timeStopFired → time_stop_stall (8-bar stall, pre-TP1)', () => {
    expect(deriveCloseReason({ closeResult: 'MANUAL_CLOSE', timeStopFired: true, autoClosedAfterTp1: false })).toBe('time_stop_stall');
  });

  it('MANUAL_CLOSE without timeStopFired → time_stop_expiry (age limit, pre-TP1)', () => {
    expect(deriveCloseReason({ closeResult: 'MANUAL_CLOSE', timeStopFired: false, autoClosedAfterTp1: false })).toBe('time_stop_expiry');
  });

  it('WIN_TP1 + autoClosedAfterTp1 → time_stop_expiry_post_tp1 (age limit fired AFTER TP1 secured)', () => {
    expect(deriveCloseReason({ closeResult: 'WIN_TP1', timeStopFired: false, autoClosedAfterTp1: true })).toBe('time_stop_expiry_post_tp1');
  });

  it('plain WIN_TP1 → trailing_stop', () => {
    expect(deriveCloseReason({ closeResult: 'WIN_TP1', timeStopFired: false, autoClosedAfterTp1: false })).toBe('trailing_stop');
  });

  // Ordering guard: autoClosedAfterTp1 must win over the generic WIN_TP1 fallback,
  // and timeStopFired must win over the generic MANUAL_CLOSE fallback — a naive
  // implementation that checks WIN_TP1/MANUAL_CLOSE first would misclassify these.
  it('does not let the generic WIN_TP1 branch shadow autoClosedAfterTp1', () => {
    const withFlag    = deriveCloseReason({ closeResult: 'WIN_TP1', timeStopFired: false, autoClosedAfterTp1: true });
    const withoutFlag = deriveCloseReason({ closeResult: 'WIN_TP1', timeStopFired: false, autoClosedAfterTp1: false });
    expect(withFlag).not.toBe(withoutFlag);
  });

  it('does not let the generic MANUAL_CLOSE branch shadow timeStopFired', () => {
    const withFlag    = deriveCloseReason({ closeResult: 'MANUAL_CLOSE', timeStopFired: true,  autoClosedAfterTp1: false });
    const withoutFlag = deriveCloseReason({ closeResult: 'MANUAL_CLOSE', timeStopFired: false, autoClosedAfterTp1: false });
    expect(withFlag).not.toBe(withoutFlag);
  });
});

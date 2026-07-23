// 客戶端交易狀態同步的純邏輯測試。
// 重現並鎖定 bug：TP1 達標後仍在等 TP2 的單（result=WIN_TP1、無 closedAt = 持倉中），
// 當伺服器把移動止損/TP2 的 closed_at 寫入後，客戶端必須「finalize」讓它進入結束，
// 而不是只在 result 尚未存在時才處理（舊邏輯永遠不會 finalize tp1-watching 的單）。

import { describe, expect, it } from 'vitest';
import {
  resolveServerOutcome,
  deriveTp1Status,
  isFinallyClosed,
  type ServerOutcome,
} from '../src/lib/tradeSync';

const local = (over: Partial<{ result: string; closedAt: number; direction: 'LONG' | 'SHORT'; entry: number }> = {}) => ({
  result: (over.result as 'WIN_TP1' | 'WIN_TP2' | 'LOSS' | 'MANUAL_CLOSE' | undefined) ?? undefined,
  closedAt: over.closedAt,
  direction: over.direction ?? ('LONG' as const),
  entry: over.entry ?? 100,
});

const srv = (over: Partial<ServerOutcome> = {}): ServerOutcome => ({
  result: over.result ?? null,
  closedAt: over.closedAt ?? null,
  exitPrice: over.exitPrice ?? null,
  pnlPercent: over.pnlPercent ?? null,
});

describe('resolveServerOutcome', () => {
  it('THE BUG: tp1-watching 本地單 + 伺服器已寫 closed_at（移動止損命中）→ 必須 finalize', () => {
    // 本地：已達 TP1、正在等 TP2（有 result 但沒有 closedAt）
    const l = local({ result: 'WIN_TP1' });
    // 伺服器：移動止損命中，closed_at 已寫入，result 仍是 WIN_TP1
    const action = resolveServerOutcome(l, srv({ result: 'WIN_TP1', closedAt: 1_700_000_000_000, exitPrice: 108 }));
    expect(action.kind).toBe('finalize');
    if (action.kind === 'finalize') {
      expect(action.closedAt).toBe(1_700_000_000_000);
      expect(action.result).toBe('WIN_TP1');
      expect(action.exitPrice).toBe(108);
      // LONG entry 100 → +8%
      expect(action.pnlPercent).toBeCloseTo(8, 6);
    }
  });

  it('tp1-watching 本地單 + 伺服器升級為 WIN_TP2（closed_at 已寫）→ finalize 並升級 result', () => {
    const l = local({ result: 'WIN_TP1' });
    const action = resolveServerOutcome(l, srv({ result: 'WIN_TP2', closedAt: 123, exitPrice: 115, pnlPercent: 15 }));
    expect(action.kind).toBe('finalize');
    if (action.kind === 'finalize') {
      expect(action.result).toBe('WIN_TP2');
      expect(action.pnlPercent).toBe(15); // 伺服器 pnl 為權威值，優先採用
    }
  });

  it('active 本地單 + 伺服器剛達 TP1（closed_at 仍為 null）→ markTp1（不關單）', () => {
    const l = local({ result: undefined });
    const action = resolveServerOutcome(l, srv({ result: 'WIN_TP1', closedAt: null, exitPrice: 106 }));
    expect(action.kind).toBe('markTp1');
    if (action.kind === 'markTp1') {
      expect(action.exitPrice).toBe(106);
      expect(action.pnlPercent).toBeCloseTo(6, 6);
    }
  });

  it('已在 tp1-watching + 伺服器仍 tp1-watching（無新事）→ none（不重複標記）', () => {
    const l = local({ result: 'WIN_TP1' });
    const action = resolveServerOutcome(l, srv({ result: 'WIN_TP1', closedAt: null }));
    expect(action.kind).toBe('none');
  });

  it('本地已 finalize（有 closedAt）→ 一律 none（冪等，不倒退）', () => {
    const l = local({ result: 'WIN_TP1', closedAt: 999 });
    const action = resolveServerOutcome(l, srv({ result: 'WIN_TP2', closedAt: 1000, exitPrice: 120 }));
    expect(action.kind).toBe('none');
  });

  it('伺服器仍無 result（開倉中）→ none', () => {
    const l = local({ result: undefined });
    const action = resolveServerOutcome(l, srv({ result: null, closedAt: null }));
    expect(action.kind).toBe('none');
  });

  it('SHORT finalize pnl 方向正確', () => {
    const l = local({ result: 'WIN_TP1', direction: 'SHORT', entry: 100 });
    const action = resolveServerOutcome(l, srv({ result: 'WIN_TP1', closedAt: 5, exitPrice: 92 }));
    expect(action.kind).toBe('finalize');
    if (action.kind === 'finalize') expect(action.pnlPercent).toBeCloseTo(8, 6); // (100-92)/100
  });
});

describe('deriveTp1Status', () => {
  it('result=WIN_TP1 且無 closed_at → tp1_hit（不管無法讀取的 status 欄位）', () => {
    expect(deriveTp1Status('WIN_TP1', null, 'active')).toBe('tp1_hit');
    expect(deriveTp1Status('WIN_TP1', undefined, 'active')).toBe('tp1_hit');
  });
  it('result=WIN_TP1 但已有 closed_at → 用 fallback（已結束）', () => {
    expect(deriveTp1Status('WIN_TP1', 123, 'active')).toBe('active');
  });
  it('無 result → 用 fallback', () => {
    expect(deriveTp1Status(undefined, null, 'waiting')).toBe('waiting');
    expect(deriveTp1Status(null, null, 'active')).toBe('active');
  });
});

describe('isFinallyClosed', () => {
  it('有 closedAt → 結束', () => {
    expect(isFinallyClosed({ closedAt: 1, result: 'WIN_TP1', status: 'tp1_hit' })).toBe(true);
  });
  it('tp1-watching（result=WIN_TP1、status=tp1_hit、無 closedAt）→ 未結束（持倉中）', () => {
    expect(isFinallyClosed({ closedAt: undefined, result: 'WIN_TP1', status: 'tp1_hit' })).toBe(false);
  });
  it('舊資料 result 但非 tp1_hit → 視為結束', () => {
    expect(isFinallyClosed({ closedAt: undefined, result: 'LOSS', status: 'active' })).toBe(true);
  });
  it('開倉中（無 result 無 closedAt）→ 未結束', () => {
    expect(isFinallyClosed({ closedAt: undefined, result: undefined, status: 'active' })).toBe(false);
  });
});

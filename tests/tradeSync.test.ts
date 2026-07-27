// 客戶端交易狀態同步的純邏輯測試。
// 重現並鎖定 bug：TP1 達標後仍在等 TP2 的單（result=WIN_TP1、無 closedAt = 持倉中），
// 當伺服器把移動止損/TP2 的 closed_at 寫入後，客戶端必須「finalize」讓它進入結束，
// 而不是只在 result 尚未存在時才處理（舊邏輯永遠不會 finalize tp1-watching 的單）。

import { describe, expect, it } from 'vitest';
import {
  resolveServerOutcome,
  deriveTp1Status,
  isFinallyClosed,
  resolveStatus,
  isUnconfirmedSync,
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

describe('resolveStatus', () => {
  it('THE BUG: 未確認的本地假 active + 伺服器真值 waiting → 必須採用伺服器值，不能讓假值贏', () => {
    const r = resolveStatus({ localStatus: 'active', localConfirmed: false, serverStatus: 'waiting' });
    expect(r.status).toBe('waiting');
    expect(r.confirmed).toBe(true);
  });

  it('伺服器回應中根本沒有這筆單（undefined）→ 保留本地值不變', () => {
    const r = resolveStatus({ localStatus: 'active', localConfirmed: false, serverStatus: undefined });
    expect(r).toEqual({ status: 'active', confirmed: false });
  });

  // 2026-07-27 實錘（AKEUSDT）：insert 最深層 fallback 會把 status 整個剝掉，該列
  // 從創建起 status 就是 NULL。伺服器自 ecc40e6 起把 NULL 併入 waiting 池監控並照掛單
  // 推播；客戶端若把 NULL 當「沒資訊」保留本地 undefined，那筆單就落進「同步中」桶，
  // 使用者在「等待進場」永遠看不到它——收得到掛單通知、畫面卻沒有單。兩邊必須同語意。
  it('THE BUG: 伺服器回應此單但 status 欄位是 NULL → 比照伺服器語意當 waiting（不可留在未確認）', () => {
    const r = resolveStatus({ localStatus: undefined, localConfirmed: false, serverStatus: null });
    expect(r).toEqual({ status: 'waiting', confirmed: true });
  });

  it('status NULL + 未確認的本地假 active → 一樣降為 waiting（假值不受閂鎖保護）', () => {
    const r = resolveStatus({ localStatus: 'active', localConfirmed: false, serverStatus: null });
    expect(r).toEqual({ status: 'waiting', confirmed: true });
  });

  it('status NULL + 已確認本地 active（監控已寫入成交，讀到舊快照）→ 閂鎖保護，不倒退', () => {
    const r = resolveStatus({ localStatus: 'active', localConfirmed: true, serverStatus: null });
    expect(r).toEqual({ status: 'active', confirmed: true });
  });

  it('status NULL + 已確認本地 tp1_hit → 閂鎖保護，不倒退', () => {
    const r = resolveStatus({ localStatus: 'tp1_hit', localConfirmed: true, serverStatus: null });
    expect(r).toEqual({ status: 'tp1_hit', confirmed: true });
  });

  it('已確認本地值 active + 伺服器仍回 waiting（DB 寫入延遲）→ 單向閂鎖，不倒退', () => {
    const r = resolveStatus({ localStatus: 'active', localConfirmed: true, serverStatus: 'waiting' });
    expect(r).toEqual({ status: 'active', confirmed: true });
  });

  it('已確認本地值 tp1_hit + 伺服器回 active（落後）→ 不倒退', () => {
    const r = resolveStatus({ localStatus: 'tp1_hit', localConfirmed: true, serverStatus: 'active' });
    expect(r).toEqual({ status: 'tp1_hit', confirmed: true });
  });

  it('已確認本地值 waiting + 伺服器回 active（真的成交了）→ 前進採用', () => {
    const r = resolveStatus({ localStatus: 'waiting', localConfirmed: true, serverStatus: 'active' });
    expect(r).toEqual({ status: 'active', confirmed: true });
  });

  it('未確認本地值 undefined + 伺服器回 waiting → 採用伺服器值並標記已確認', () => {
    const r = resolveStatus({ localStatus: undefined, localConfirmed: false, serverStatus: 'waiting' });
    expect(r).toEqual({ status: 'waiting', confirmed: true });
  });
});

describe('isUnconfirmedSync', () => {
  it('status undefined 且未確認、無 result → 同步中', () => {
    expect(isUnconfirmedSync({ result: undefined, status: undefined, statusConfirmed: false })).toBe(true);
  });
  it('status undefined 但 statusConfirmed=true（手動單）→ 非同步中', () => {
    expect(isUnconfirmedSync({ result: undefined, status: undefined, statusConfirmed: true })).toBe(false);
  });
  it('已有 status 值 → 非同步中，即使 statusConfirmed 未設', () => {
    expect(isUnconfirmedSync({ result: undefined, status: 'waiting', statusConfirmed: false })).toBe(false);
  });
  it('已收到 result（已結束或 tp1-watching）→ 非同步中', () => {
    expect(isUnconfirmedSync({ result: 'WIN_TP1', status: undefined, statusConfirmed: false })).toBe(false);
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

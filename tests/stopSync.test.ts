import { describe, it, expect } from 'vitest';
import { currentStopToSync, effectiveStop, tp1StopAdvice } from '../src/lib/stopSync';

// 2026-09-23 使用者回報：AVAX 幣安上止損 10.973，App 卻寫「建議將止損移至成本
// 9.5551」。根因是 live-runner 移動止損只更新幣安條件單與 exchange_stop_algo_id，
// 從來沒寫 trades.current_stop——DB 那筆 current_stop=NULL，App 只能退回寫死的
// 「移到成本」。

describe('currentStopToSync', () => {
  it('DB 沒有值、交易所有止損 → 要寫', () => {
    expect(currentStopToSync(null, 10.973)).toBe(10.973);
  });

  it('跟 DB 一樣 → 不寫（省 DB 寫入）', () => {
    expect(currentStopToSync(10.973, 10.973)).toBeNull();
  });

  it('Supabase numeric 欄位回傳字串也要能比對', () => {
    expect(currentStopToSync('10.973', 10.973)).toBeNull();
    expect(currentStopToSync('10.5', 10.973)).toBe(10.973);
  });

  it('浮點誤差內視為相同', () => {
    expect(currentStopToSync(0.1 + 0.2, 0.3)).toBeNull();
  });

  it('交易所沒有止損單 → 不動 DB（不把 NULL 當成新值寫進去）', () => {
    expect(currentStopToSync(10.973, null)).toBeNull();
    expect(currentStopToSync(null, null)).toBeNull();
  });

  it('無效的交易所價格 → 不寫', () => {
    expect(currentStopToSync(null, 0)).toBeNull();
    expect(currentStopToSync(null, NaN)).toBeNull();
  });
});

describe('effectiveStop', () => {
  it('有 currentStop 用它', () => {
    expect(effectiveStop({ stopLoss: 8.9054, currentStop: 10.973 })).toBe(10.973);
  });
  it('沒有或無效 → 原始止損', () => {
    expect(effectiveStop({ stopLoss: 8.9054 })).toBe(8.9054);
    expect(effectiveStop({ stopLoss: 8.9054, currentStop: 0 })).toBe(8.9054);
    expect(effectiveStop({ stopLoss: 8.9054, currentStop: null })).toBe(8.9054);
  });
});

describe('tp1StopAdvice', () => {
  const avax = { direction: 'LONG' as const, entry: 9.5551, stopLoss: 8.9054 };

  it('AVAX 實例：已移到 10.973 → 顯示實際止損與鎖住的 R，不再叫人移到成本', () => {
    const a = tp1StopAdvice({ ...avax, currentStop: 10.973, executedOnExchange: true });
    expect(a.kind).toBe('moved');
    if (a.kind !== 'moved') return;
    expect(a.stop).toBe(10.973);
    expect(a.lockedR).toBeCloseTo((10.973 - 9.5551) / (9.5551 - 8.9054), 6);
    expect(a.byExchange).toBe(true);
  });

  it('做空方向鎖住的 R 符號正確', () => {
    const a = tp1StopAdvice({ direction: 'SHORT', entry: 100, stopLoss: 110, currentStop: 95, executedOnExchange: true });
    expect(a.kind).toBe('moved');
    if (a.kind === 'moved') expect(a.lockedR).toBeCloseTo(0.5, 6);
  });

  it('真倉但 current_stop 還沒同步 → 不給「移到成本」的錯誤指示', () => {
    const a = tp1StopAdvice({ ...avax, currentStop: null, executedOnExchange: true });
    expect(a.kind).toBe('managed_unknown');
  });

  it('DB 模擬、沒有移動止損 → 維持原本的保本建議', () => {
    const a = tp1StopAdvice({ ...avax, currentStop: null, executedOnExchange: false });
    expect(a).toEqual({ kind: 'suggest_breakeven', stop: 9.5551 });
  });

  it('currentStop 等於原始止損（還沒移動過）→ 不算已移動', () => {
    const a = tp1StopAdvice({ ...avax, currentStop: 8.9054, executedOnExchange: false });
    expect(a.kind).toBe('suggest_breakeven');
  });

  it('DB 模擬已有 current_stop → 也顯示實際值，但不宣稱是交易所做的', () => {
    const a = tp1StopAdvice({ ...avax, currentStop: 10, executedOnExchange: false });
    expect(a.kind).toBe('moved');
    if (a.kind === 'moved') expect(a.byExchange).toBe(false);
  });
});

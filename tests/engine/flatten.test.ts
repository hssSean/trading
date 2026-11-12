import { describe, it, expect } from 'vitest';
import { planFlatten } from '../../src/engine/flatten';

describe('planFlatten（緊急全平）', () => {
  it('多單賣出、空單買回、數量用交易所回報的原值；零部位略過', () => {
    const p = planFlatten(
      [{ symbol: 'AUSDT', positionAmt: '16.24' }, { symbol: 'BUSDT', positionAmt: '-0.003' }, { symbol: 'CUSDT', positionAmt: '0' }],
      [], []);
    expect(p.closes).toEqual([
      { symbol: 'AUSDT', side: 'SELL', quantity: 16.24 },
      { symbol: 'BUSDT', side: 'BUY', quantity: 0.003 },
    ]);
  });
  it('所有掛單與條件單都撤（含沒有部位的幣——例如 S3-B 的加碼單）', () => {
    const p = planFlatten([], [{ symbol: 'AUSDT', orderId: 1 }], [{ symbol: 'AUSDT', algoId: 9 }, { symbol: 'ZUSDT', algoId: 8 }]);
    expect(p.cancelOrders).toEqual([{ symbol: 'AUSDT', orderId: 1 }]);
    expect(p.cancelAlgos).toEqual([{ symbol: 'AUSDT', algoId: 9 }, { symbol: 'ZUSDT', algoId: 8 }]);
  });
  it('帳戶是空的 → 空計畫', () => {
    expect(planFlatten([{ symbol: 'AUSDT', positionAmt: '0.0' }], [], [])).toEqual({ closes: [], cancelOrders: [], cancelAlgos: [] });
  });
});

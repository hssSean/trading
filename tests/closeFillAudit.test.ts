import { describe, expect, it } from 'vitest';
import { auditCloseFills, AuditFill, AuditTriggeredAlgo } from '../src/lib/closeFillAudit';

function algo(overrides: Partial<AuditTriggeredAlgo> = {}): AuditTriggeredAlgo {
  return {
    clientAlgoId: 'trade-1-sl-aaaaaa',
    orderType: 'STOP_MARKET',
    side: 'SELL',
    triggerTime: 1000,
    actualQty: 10,
    closePosition: true,
    ...overrides,
  };
}

function fill(time: number, side: 'BUY' | 'SELL', qty: number): AuditFill {
  return { time, side, qty };
}

describe('auditCloseFills', () => {
  it('止損平乾淨 → clean', () => {
    const [row] = auditCloseFills({
      currentPosition: 0,
      fills: [fill(1000, 'SELL', 10)],
      triggered: [algo({ actualQty: 10 })],
    });
    expect(row.positionBefore).toBe(10);
    expect(row.positionAfter).toBe(0);
    expect(row.verdict).toBe('clean');
  });

  it('只平掉一部分 → partial', () => {
    const [row] = auditCloseFills({
      currentPosition: 21,
      fills: [fill(1000, 'SELL', 10)],
      triggered: [algo({ actualQty: 10 })],
    });
    expect(row.positionBefore).toBe(31);
    expect(row.positionAfter).toBe(21);
    expect(row.verdict).toBe('partial');
  });

  // 2026-09-06 UNIUSDT trade-1788511232519-z9tmu 的真實數字，整串重播：
  // 進場 BUY 31 → 三次止損分別平 10 / 20 / 40 → 最後停在 -39。
  // 前兩次是 partial（沒平乾淨，DB 因此一直以為單還開著），第三次是 flipped。
  it('UNI 事故重播：31 → 平10 → 平20 → 平40，最後翻成 -39', () => {
    const rows = auditCloseFills({
      currentPosition: -39,
      fills: [
        fill(100, 'BUY', 31),
        fill(1000, 'SELL', 10),
        fill(2000, 'SELL', 20),
        fill(3000, 'SELL', 40),
      ],
      triggered: [
        algo({ clientAlgoId: 'sl-1', triggerTime: 1000, actualQty: 10 }),
        algo({ clientAlgoId: 'sl-2', triggerTime: 2000, actualQty: 20 }),
        algo({ clientAlgoId: 'sl-3', triggerTime: 3000, actualQty: 40 }),
      ],
    });
    expect(rows.map(r => r.positionBefore)).toEqual([31, 21, 1]);
    expect(rows.map(r => r.positionAfter)).toEqual([21, 1, -39]);
    expect(rows.map(r => r.verdict)).toEqual(['partial', 'partial', 'flipped']);
  });

  // 這是第一版臨時腳本真的踩到的誤報：SOL/BTC 在視窗起點就已經有部位，
  // 從 0 往前加會把每一筆都算成翻倉。從「現在的真實部位」往回推就不會。
  it('視窗起點本來就有部位 → 不會誤報成翻倉', () => {
    const rows = auditCloseFills({
      currentPosition: 5,          // 視窗內的成交全部抵銷後，還剩開窗前就有的 5
      fills: [fill(1000, 'SELL', 16)],
      triggered: [algo({ triggerTime: 1000, actualQty: 16 })],
    });
    expect(rows[0].positionBefore).toBe(21); // 5 + 16，不是 16
    expect(rows[0].positionAfter).toBe(5);
    // 平掉的正好是「這一筆該平的」，剩下的 5 是別的部位——不該叫翻倉。
    expect(rows[0].verdict).toBe('partial');
  });

  it('空單的止損是 BUY，平乾淨一樣算 clean', () => {
    const [row] = auditCloseFills({
      currentPosition: 0,
      fills: [fill(1000, 'BUY', 7)],
      triggered: [algo({ side: 'BUY', actualQty: 7 })],
    });
    expect(row.positionBefore).toBe(-7);
    expect(row.verdict).toBe('clean');
  });

  it('浮點數誤差不算沒平乾淨（ETH 1.078 那種）', () => {
    const [row] = auditCloseFills({
      currentPosition: 0,
      fills: [fill(500, 'BUY', 0.078), fill(600, 'BUY', 1), fill(1000, 'SELL', 1.078)],
      triggered: [algo({ triggerTime: 1000, actualQty: 1.078 })],
    });
    expect(row.verdict).toBe('clean');
  });

  it('TP1 只平一半是正常的，但仍如實標成 partial 讓人自己判讀', () => {
    const [row] = auditCloseFills({
      currentPosition: 0.054,
      fills: [fill(1000, 'SELL', 0.054)],
      triggered: [algo({ orderType: 'TAKE_PROFIT_MARKET', closePosition: false, actualQty: 0.054 })],
    });
    expect(row.positionBefore).toBe(0.108);
    expect(row.verdict).toBe('partial');
  });

  it('多筆觸發依時間排序輸出，跟輸入順序無關', () => {
    const rows = auditCloseFills({
      currentPosition: 0,
      fills: [fill(1000, 'SELL', 5), fill(2000, 'SELL', 5)],
      triggered: [
        algo({ clientAlgoId: 'b', triggerTime: 2000, actualQty: 5 }),
        algo({ clientAlgoId: 'a', triggerTime: 1000, actualQty: 5 }),
      ],
    });
    expect(rows.map(r => r.clientAlgoId)).toEqual(['a', 'b']);
  });
});

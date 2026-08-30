import { describe, it, expect } from 'vitest';
import { auditTradeExit, type AuditFill } from '../src/lib/exitAudit';

// 這支守的是「稽核工具不能誣告」。清查的目的是決定哪些歷史績效資料不能信，
// 一個會把正常平倉標成「捏造出場」的工具，比沒有工具更糟——它會讓人去
// 「修正」本來就對的資料。
//
// 所以誤判的兩個方向不對稱：
//   漏抓（把捏造判成 OK）＝ 髒資料繼續污染統計，壞
//   誤抓（把正常判成捏造）＝ 會導致去改動正確的紀錄，更壞
// 測試偏重後者。

const f = (o: Partial<AuditFill> & { id: number }): AuditFill => ({
  orderId: 999, side: 'BUY', price: '100', qty: '1', realizedPnl: '0', time: 1000, ...o,
});
const NONE = new Set<number>();

// 做多：orderId 111 進場 1 顆 @100
const entryLong = f({ id: 1, orderId: 111, side: 'BUY', price: '100', qty: '1', time: 1000 });

describe('auditTradeExit — 正常平倉不該被誣告', () => {
  it('單筆進場 + 單筆平倉 → OK', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '105', qty: '1', realizedPnl: '5', time: 2000 })];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: NONE });
    expect(r.verdict).toBe('OK');
    expect(r.realPnlPct).toBeCloseTo(5);
    expect(r.realizedPnlUsdt).toBeCloseTo(5);
  });

  it('TP1 分兩次平倉 → 加權均價，仍是 OK', () => {
    const fills = [
      entryLong,
      f({ id: 2, orderId: 222, side: 'SELL', price: '105', qty: '0.5', realizedPnl: '2.5', time: 2000 }),
      f({ id: 3, orderId: 333, side: 'SELL', price: '111', qty: '0.5', realizedPnl: '5.5', time: 3000 }),
    ];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 8, fills, consumed: NONE });
    expect(r.exitAvg).toBeCloseTo(108);
    expect(r.realPnlPct).toBeCloseTo(8);
    expect(r.verdict).toBe('OK');
  });

  // 市價單立刻被止損掃掉是真的會發生的。用 `>` 而不是 `>=` 比對時間會把這種
  // 單誤判成 NO_CLOSE_FILL——那是最嚴重的誤判方向（硬證據等級的誣告）。
  it('同一毫秒進場又平倉 → 不可判成查無平倉', () => {
    const fills = [
      f({ id: 1, orderId: 111, side: 'BUY', price: '100', qty: '1', time: 5000 }),
      f({ id: 2, orderId: 222, side: 'SELL', price: '97', qty: '1', realizedPnl: '-3', time: 5000 }),
    ];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: -3, fills, consumed: NONE });
    expect(r.verdict).toBe('OK');
  });

  it('做空方向對稱：跌了算賺', () => {
    const fills = [
      f({ id: 1, orderId: 111, side: 'SELL', price: '100', qty: '1', time: 1000 }),
      f({ id: 2, orderId: 222, side: 'BUY', price: '95', qty: '1', realizedPnl: '5', time: 2000 }),
    ];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: NONE });
    expect(r.realPnlPct).toBeCloseTo(5);
    expect(r.verdict).toBe('OK');
  });

  // 保本出場的 pnl 就是 0，0 沒有正負號。拿 Math.sign(0)=0 去比會把每一筆
  // 保本單都判成方向相反。
  it('保本出場（0%）不觸發 SIGN_FLIP', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '100', qty: '1', realizedPnl: '0', time: 2000 })];
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: 0, fills, consumed: NONE }).verdict).toBe('OK');
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: -0.04, fills, consumed: NONE }).verdict).not.toBe('SIGN_FLIP');
  });
});

describe('auditTradeExit — 硬證據', () => {
  // 這就是 6e357a3 修掉的那個 bug 的資料特徵：DB 說平了、幣安沒有平倉成交。
  it('DB 說平倉但幣安沒有反向成交 → NO_CLOSE_FILL', () => {
    const fills = [entryLong];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: -0.05, fills, consumed: NONE });
    expect(r.verdict).toBe('NO_CLOSE_FILL');
    expect(r.entryQty).toBe(1);
    expect(r.closedQty).toBe(0);
  });

  it('進場之前的反向成交不算平倉', () => {
    const fills = [
      f({ id: 9, orderId: 888, side: 'SELL', price: '99', qty: '1', time: 500 }), // 進場前
      entryLong,
    ];
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: 1, fills, consumed: NONE }).verdict).toBe('NO_CLOSE_FILL');
  });

  it('同方向的成交不算平倉（加倉不是平倉）', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'BUY', price: '101', qty: '1', time: 2000 })];
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: 1, fills, consumed: NONE }).verdict).toBe('NO_CLOSE_FILL');
  });

  // 使用者實際撞到的形狀：幣安獲利、DB 記小虧。
  it('DB 記虧損但實際獲利 → SIGN_FLIP', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '107', qty: '1', realizedPnl: '6.59', time: 2000 })];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: -0.05, fills, consumed: NONE });
    expect(r.verdict).toBe('SIGN_FLIP');
    expect(r.realizedPnlUsdt).toBeCloseTo(6.59);
  });

  it('查無進場成交 → NO_ENTRY_FILL，不是 NO_CLOSE_FILL', () => {
    const r = auditTradeExit({ entryOrderId: 777, dbPnlPercent: 1, fills: [entryLong], consumed: NONE });
    expect(r.verdict).toBe('NO_ENTRY_FILL');
  });
});

describe('auditTradeExit — 重疊倉位的 FIFO 配對', () => {
  it('已被前一筆單消耗的成交不再重複使用', () => {
    const fills = [
      entryLong,
      f({ id: 2, orderId: 222, side: 'SELL', price: '105', qty: '1', realizedPnl: '5', time: 2000 }),
    ];
    // id=2 已被同 symbol 的前一筆單用掉
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: new Set([2]) });
    expect(r.verdict).toBe('NO_CLOSE_FILL');
  });

  it('回報 consumedIds 讓呼叫端能累積，且包含進場成交', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '105', qty: '1', realizedPnl: '5', time: 2000 })];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: NONE });
    expect(r.consumedIds).toContain(1);
    expect(r.consumedIds).toContain(2);
  });

  it('平倉量不足 → PARTIAL_CLOSE 而不是 OK', () => {
    const fills = [
      f({ id: 1, orderId: 111, side: 'BUY', price: '100', qty: '2', time: 1000 }),
      f({ id: 2, orderId: 222, side: 'SELL', price: '105', qty: '0.5', realizedPnl: '2.5', time: 2000 }),
    ];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: NONE });
    expect(r.verdict).toBe('PARTIAL_CLOSE');
    expect(r.closedQty).toBeCloseTo(0.5);
  });

  it('部分吃掉一筆大額反向成交時，realizedPnl 按比例分攤', () => {
    const fills = [
      entryLong, // 1 顆
      f({ id: 2, orderId: 222, side: 'SELL', price: '105', qty: '4', realizedPnl: '20', time: 2000 }),
    ];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: NONE });
    expect(r.closedQty).toBeCloseTo(1);
    expect(r.realizedPnlUsdt).toBeCloseTo(5); // 20 × (1/4)
  });

  it('進場多筆成交 → 加權均價', () => {
    const fills = [
      f({ id: 1, orderId: 111, side: 'BUY', price: '100', qty: '1', time: 1000 }),
      f({ id: 2, orderId: 111, side: 'BUY', price: '102', qty: '1', time: 1100 }),
      f({ id: 3, orderId: 222, side: 'SELL', price: '106', qty: '2', realizedPnl: '9', time: 2000 }),
    ];
    const r = auditTradeExit({ entryOrderId: 111, dbPnlPercent: 3.92, fills, consumed: NONE });
    expect(r.entryAvg).toBeCloseTo(101);
    expect(r.realPnlPct).toBeCloseTo(4.95, 2);
  });
});

describe('auditTradeExit — 幅度比對', () => {
  it('差距超過容差 → AMOUNT_MISMATCH', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '110', qty: '1', realizedPnl: '10', time: 2000 })];
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: 2, fills, consumed: NONE }).verdict).toBe('AMOUNT_MISMATCH');
  });

  it('小幅差異在容差內 → OK（TP1 加權均價本來就會有落差）', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '105.3', qty: '1', realizedPnl: '5.3', time: 2000 })];
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: 5, fills, consumed: NONE }).verdict).toBe('OK');
  });

  it('dbPnlPercent 為 null 時只做存在性檢查，不判幅度', () => {
    const fills = [entryLong, f({ id: 2, orderId: 222, side: 'SELL', price: '150', qty: '1', realizedPnl: '50', time: 2000 })];
    expect(auditTradeExit({ entryOrderId: 111, dbPnlPercent: null, fills, consumed: NONE }).verdict).toBe('OK');
  });
});

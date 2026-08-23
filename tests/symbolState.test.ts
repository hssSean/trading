import { describe, it, expect } from 'vitest';
import {
  readLock, readBias, readLossCd, readBPause,
  writeLock, writeBias, writeLossCd, writeBPause,
  pruneState, parseStateMap,
  type SymbolStateMap,
} from '../src/lib/symbolState';

// 這些測試守的是風控本身。合併成單一 hash 之後沒有逐欄位 TTL，到期改由程式
// 判斷——寫錯的後果是靜默的：鎖永遠不過期（訊號再也發不出來），或鎖立刻
// 過期（同一個幣重複發單，8/6 ADAUSDT 在 40 筆訊號裡出現 10 次那次的翻版）。

const T = 1_000_000_000_000; // 固定的「現在」

describe('symbolState 讀寫', () => {
  it('寫入後在 TTL 內讀得到', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'BTCUSDT', { locked: true, sentAt: T }, 60, T);
    expect(readLock(m, 'BTCUSDT', T + 59_000)).toEqual({ locked: true, sentAt: T });
  });

  // 邊界：exp 用 <= now 判過期，所以「剛好到期的那一毫秒」算過期。
  // 這個方向比較安全——寧可鎖早一毫秒放開，也不要晚放而卡住訊號。
  it('剛好到期算過期', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'BTCUSDT', { locked: true, sentAt: T }, 60, T);
    expect(readLock(m, 'BTCUSDT', T + 59_999)).not.toBeNull();
    expect(readLock(m, 'BTCUSDT', T + 60_000)).toBeNull();
    expect(readLock(m, 'BTCUSDT', T + 60_001)).toBeNull();
  });

  it('沒寫過的 symbol 讀出 null / false，不會爆', () => {
    const m: SymbolStateMap = {};
    expect(readLock(m, 'NOPE', T)).toBeNull();
    expect(readBias(m, 'NOPE', T)).toBeNull();
    expect(readLossCd(m, 'NOPE', 'LONG', T)).toBe(false);
    expect(readBPause(m, 'NOPE', T)).toBe(false);
  });

  // 做多被停損不該把做空也鎖住——原本 Redis 是 loss_cd:SYM:DIR 兩個獨立鍵，
  // 合併之後必須保持這個獨立性。
  it('多空冷卻互相獨立', () => {
    const m: SymbolStateMap = {};
    writeLossCd(m, 'ETHUSDT', 'LONG', 3600, T);
    expect(readLossCd(m, 'ETHUSDT', 'LONG', T + 1000)).toBe(true);
    expect(readLossCd(m, 'ETHUSDT', 'SHORT', T + 1000)).toBe(false);
    writeLossCd(m, 'ETHUSDT', 'SHORT', 3600, T);
    expect(readLossCd(m, 'ETHUSDT', 'SHORT', T + 1000)).toBe(true);
  });

  it('同一檔幣的四種狀態互不干擾', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'SOLUSDT', { locked: true, sentAt: T }, 60, T);
    writeBias(m, 'SOLUSDT', 'LONG', 120, T);
    writeLossCd(m, 'SOLUSDT', 'SHORT', 180, T);
    writeBPause(m, 'SOLUSDT', 240, T);
    const at = T + 30_000;
    expect(readLock(m, 'SOLUSDT', at)?.locked).toBe(true);
    expect(readBias(m, 'SOLUSDT', at)).toBe('LONG');
    expect(readLossCd(m, 'SOLUSDT', 'SHORT', at)).toBe(true);
    expect(readBPause(m, 'SOLUSDT', at)).toBe(true);
  });

  // 各欄位到期時間不同時，過期的那個要單獨失效，不能拖累還沒到期的。
  it('部分欄位過期不影響其他欄位', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'XRPUSDT', { locked: true, sentAt: T }, 60, T);
    writeBias(m, 'XRPUSDT', 'SHORT', 600, T);
    const at = T + 120_000; // lock 過期、bias 還在
    expect(readLock(m, 'XRPUSDT', at)).toBeNull();
    expect(readBias(m, 'XRPUSDT', at)).toBe('SHORT');
  });

  it('重寫同一欄位會延長到期時間', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'BTCUSDT', { locked: true, sentAt: T }, 60, T);
    writeLock(m, 'BTCUSDT', { locked: false, sentAt: T }, 60, T + 50_000);
    expect(readLock(m, 'BTCUSDT', T + 100_000)).toEqual({ locked: false, sentAt: T });
  });
});

describe('pruneState', () => {
  // 沒有逐欄位 TTL 之後，過期資料不清就會一直長大——幣圈會輪動，下架的幣
  // 永遠留在 hash 裡。
  it('全部過期的 symbol 進 drop 並從 map 移除', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'OLDUSDT', { locked: true, sentAt: T }, 60, T);
    const r = pruneState(m, T + 999_999);
    expect(r.drop).toEqual(['OLDUSDT']);
    expect(r.keep).toEqual([]);
    expect(m.OLDUSDT).toBeUndefined();
  });

  it('部分過期只刪過期欄位，symbol 留在 keep', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'BTCUSDT', { locked: true, sentAt: T }, 60, T);
    writeBias(m, 'BTCUSDT', 'LONG', 6000, T);
    const r = pruneState(m, T + 120_000);
    expect(r.keep).toEqual(['BTCUSDT']);
    expect(r.drop).toEqual([]);
    expect(m.BTCUSDT.lock).toBeUndefined();
    expect(m.BTCUSDT.bias).toBeDefined();
  });

  it('lossCd 只剩過期方向時整個欄位移除', () => {
    const m: SymbolStateMap = {};
    writeLossCd(m, 'ETHUSDT', 'LONG', 60, T);
    writeLossCd(m, 'ETHUSDT', 'SHORT', 6000, T);
    pruneState(m, T + 120_000);
    expect(m.ETHUSDT.lossCd?.LONG).toBeUndefined();
    expect(m.ETHUSDT.lossCd?.SHORT).toBeDefined();
    pruneState(m, T + 9_999_999);
    expect(m.ETHUSDT).toBeUndefined();
  });

  it('沒有過期的東西時不動任何資料', () => {
    const m: SymbolStateMap = {};
    writeLock(m, 'BTCUSDT', { locked: true, sentAt: T }, 600, T);
    const before = JSON.stringify(m);
    const r = pruneState(m, T + 1000);
    expect(JSON.stringify(m)).toBe(before);
    expect(r.keep).toEqual(['BTCUSDT']);
  });
});

describe('parseStateMap', () => {
  it('吃字串與物件兩種形式', () => {
    const m = parseStateMap({
      A: JSON.stringify({ bPause: T + 1000 }),
      B: { bPause: T + 2000 },
    });
    expect(readBPause(m, 'A', T)).toBe(true);
    expect(readBPause(m, 'B', T)).toBe(true);
  });

  // 一個壞掉的欄位不該讓整輪掃描失去所有風控狀態。
  it('壞掉的欄位丟掉，其他照常', () => {
    const m = parseStateMap({ GOOD: { bPause: T + 1000 }, BAD: '{not json' });
    expect(readBPause(m, 'GOOD', T)).toBe(true);
    expect(m.BAD).toBeUndefined();
  });

  it('null / undefined 回空物件', () => {
    expect(parseStateMap(null)).toEqual({});
    expect(parseStateMap(undefined)).toEqual({});
  });
});

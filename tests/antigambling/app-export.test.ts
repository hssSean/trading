// 回歸測試：本站「紀錄」頁匯出的 CSV 必須能直接匯入「績效體檢」。
// 涵蓋兩代格式：
//   舊版（2026-07-18 前）：幣種欄 + 損益% + 缺年份中文時間「7/17 上午08:00」+ 無數量欄
//   新版：ISO 時間 + 策略欄（tier×時框）

import { describe, expect, it } from 'vitest';
import { parseTradeLog } from '../../src/lib/antigambling/ingest';

const LEGACY_EXPORT = [
  'ID,幣種,方向,週期,強度,得分,進場價,止損,TP1,TP2,開倉時間,平倉時間,結果,出場價,損益%,分析依據,個人備註',
  'trade-1,AKEUSDT,LONG,1h,WEAK,55,0.0010212,0.000898656,0.001266288,0.001450104,7/17 上午08:00,7/17 上午08:29,止損出場,0.000898656,-12,"EMA200 上方 | ⚠ 高波動",""',
  'trade-2,BTCUSDT,SHORT,1h,MODERATE,69,64773.95,65415.186,63491.478,62701.07,7/16 下午08:35,7/17 上午11:16,TP1 達標,63491.478,1.98,"看跌 OB（強度 2）",""',
  'trade-3,ETHUSDT,LONG,1h,WEAK,62,1862.29,1842.18,1902.52,1915.47,7/16 下午08:33,7/17 上午11:16,止損出場,1842.18,-1.08,"看漲 OB",""',
].join('\n');

const NEW_EXPORT = [
  'ID,幣種,方向,週期,強度,得分,進場價,止損,TP1,TP2,開倉時間,平倉時間,結果,出場價,損益%,策略,分析依據,個人備註',
  'trade-1,AKEUSDT,LONG,1h,WEAK,55,0.001,0.0009,0.0012,0.0014,2026-07-17 08:00,2026-07-17 08:29,止損出場,0.0009,-12,B級·1h,"x",""',
  'trade-2,BTCUSDT,SHORT,1h,MODERATE,69,64773,65415,63491,62701,2026-07-16 20:35,2026-07-17 11:16,TP1 達標,63491,1.98,A級·1h,"y",""',
].join('\n');

describe('本站匯出檔匯入', () => {
  it('舊版匯出（幣種/損益%/缺年份中文時間）：全部有效，pnl 以 % 為單位', () => {
    const r = parseTradeLog({ text: LEGACY_EXPORT, format: 'csv', fileName: 'trades-legacy.csv' });
    expect(r.validCount).toBe(3);
    expect(r.skipped).toBe(0);
    // 幣種 → symbol、損益% → pnl
    expect(r.fieldMap['symbol']).toBe('幣種');
    expect(r.fieldMap['pnl']).toBe('損益%');
    // pnl 直接取 % 值（不被價格推算覆蓋）
    expect(r.log.trades.map(t => t.pnl)).toEqual([-12, 1.98, -1.08]);
    // 方向解析
    expect(r.log.trades[1].side).toBe('short');
    // 中文上下午時間：下午08:35 → 20:35；缺年份 → 今年
    const t2 = r.log.trades[1];
    expect(t2.entryTime.getHours()).toBe(20);
    expect(t2.entryTime.getFullYear()).toBe(new Date().getFullYear());
    // 警告要誠實揭露：% 單位 + 假設年份
    expect(r.warnings.some(w => w.includes('百分比'))).toBe(true);
    expect(r.warnings.some(w => w.includes('缺年份'))).toBe(true);
  });

  it('新版匯出（ISO 時間 + 策略欄）：tag 對應到策略，時間不需假設年份', () => {
    const r = parseTradeLog({ text: NEW_EXPORT, format: 'csv', fileName: 'trades-new.csv' });
    expect(r.validCount).toBe(2);
    expect(r.fieldMap['tag']).toBe('策略');
    expect(r.log.trades.map(t => t.tag)).toEqual(['B級·1h', 'A級·1h']);
    expect(r.log.trades[0].entryTime.getFullYear()).toBe(2026);
    expect(r.warnings.some(w => w.includes('缺年份'))).toBe(false);
  });

  it('同檔同時有「損益」金額欄與「損益%」時，金額欄優先', () => {
    const both = [
      'symbol,損益,損益%',
      'BTCUSDT,150,1.5',
    ].join('\n');
    const r = parseTradeLog({ text: both, format: 'csv', fileName: 'both.csv' });
    expect(r.fieldMap['pnl']).toBe('損益');
    expect(r.log.trades[0].pnl).toBe(150);
  });

  it('上午12時 → 0 時、下午12時 → 12 時（zh-TW 慣例）', () => {
    const csv = [
      '幣種,開倉時間,平倉時間,損益%',
      'BTCUSDT,2026/7/17 上午12:05,2026/7/17 下午12:10,1',
    ].join('\n');
    const r = parseTradeLog({ text: csv, format: 'csv', fileName: 'ampm.csv' });
    expect(r.log.trades[0].entryTime.getHours()).toBe(0);
    expect(r.log.trades[0].exitTime.getHours()).toBe(12);
  });
});

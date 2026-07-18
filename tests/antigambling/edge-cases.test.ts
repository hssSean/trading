// §9.4 邊界案例：0 筆、1 筆、全贏、全輸、pnl 與價格欄位混用、中文欄名、無效列混雜。

import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/lib/antigambling/metrics';
import { AgTradeLog, buildTrade } from '../../src/lib/antigambling/models';
import { FieldMappingError, parseTradeLog } from '../../src/lib/antigambling/ingest';
import { judge } from '../../src/lib/antigambling/verdict';
import { holdoutValidate } from '../../src/lib/antigambling/oos';
import { inferMarket } from '../../src/lib/antigambling/markets';

function mkLog(pnls: number[]): AgTradeLog {
  const trades = pnls.map((pnl, i) =>
    buildTrade({
      symbol: 'AAPL', market: 'us_stock', side: 'long',
      entryTime: new Date(2024, 0, 1 + i), exitTime: new Date(2024, 0, 2 + i),
      entryPrice: 100, exitPrice: 100, quantity: 10,
      fees: 0, pnl,
    }),
  );
  return { trades, source: 'test', accountLabel: 'test' };
}

describe('邊界案例', () => {
  it('0 筆：空紀錄回傳零指標，不炸', () => {
    const m = computeMetrics({ trades: [], source: '', accountLabel: '' });
    expect(m.totalTrades).toBe(0);
    expect(m.expectancy).toBe(0);
  });

  it('1 筆：無法統計推論 → 不顯著、樣本不足', () => {
    const log = mkLog([100]);
    const v = judge(log, { nBootstrap: 500 });
    expect(v.level).toBe('insufficient');
    expect(v.significance.isSignificant).toBe(false);
  });

  it('全贏：盈虧比/獲利因子為 Infinity（不適用），不是 0', () => {
    const log = mkLog([10, 20, 30, 40, 50]);
    const m = computeMetrics(log);
    expect(m.payoffRatio).toBe(Infinity);
    expect(m.profitFactor).toBe(Infinity);
    expect(m.rMultiples).toEqual([]); // 沒有虧損 → R 沒有定義，誠實留空
  });

  it('全輸：期望值為負、勝率 0', () => {
    const log = mkLog([-10, -20, -30, -40]);
    const m = computeMetrics(log);
    expect(m.winRate).toBe(0);
    expect(m.expectancy).toBeLessThan(0);
    expect(m.maxConsecutiveLosses).toBe(4);
  });

  it('pnl 欄位優先於價格推算', () => {
    const t = buildTrade({
      symbol: '2330', market: 'tw_stock', side: 'long',
      entryTime: new Date(2025, 0, 1), exitTime: new Date(2025, 0, 2),
      entryPrice: 100, exitPrice: 110, quantity: 1000,
      fees: 50, pnl: 777, // 明確給 pnl → 不用價格推算
    });
    expect(t.pnl).toBe(777);
  });

  it('價格推算：做空方向相反且扣除費用', () => {
    const t = buildTrade({
      symbol: 'AAPL', market: 'us_stock', side: 'short',
      entryTime: new Date(2025, 0, 1), exitTime: new Date(2025, 0, 2),
      entryPrice: 100, exitPrice: 90, quantity: 10,
      fees: 5,
    });
    // (90-100)×10 = -100 → short 取反 = +100 → 扣 fees 5 = 95
    expect(t.pnl).toBe(95);
  });

  it('出場早於進場 → 拒絕（髒資料）', () => {
    expect(() =>
      buildTrade({
        symbol: 'AAPL', market: 'us_stock', side: 'long',
        entryTime: new Date(2025, 0, 10), exitTime: new Date(2025, 0, 5),
        entryPrice: 100, exitPrice: 110, quantity: 10,
      }),
    ).toThrow(/早於/);
  });

  it('中文欄名自動辨識（代號/方向/進場價/股數/策略）', () => {
    const csv = [
      '代號,方向,進場時間,出場時間,進場價,出場價,股數,策略',
      '2330,做多,2025-01-03,2025-01-05,1000,1010,1000,測試策略',
      '2454,做空,2025-01-06,2025-01-07,1200,1180,500,測試策略',
    ].join('\n');
    const r = parseTradeLog({ text: csv, format: 'csv', fileName: 't.csv' });
    expect(r.validCount).toBe(2);
    expect(r.log.trades[0].symbol).toBe('2330');
    expect(r.log.trades[0].market).toBe('tw_stock');
    expect(r.log.trades[1].side).toBe('short');
    expect(r.log.trades[0].tag).toBe('測試策略');
  });

  it('「張」欄名 → 數量 ×1000', () => {
    const csv = ['代號,進場價,出場價,張數', '2330,100,101,2'].join('\n');
    const r = parseTradeLog({ text: csv, format: 'csv' });
    expect(r.qtyInLots).toBe(true);
    expect(r.log.trades[0].quantity).toBe(2000);
  });

  it('無效列混雜：缺損益的列被略過並記錄原因，有效列照算', () => {
    const csv = [
      'symbol,entry_price,exit_price,quantity',
      'AAPL,100,110,10',
      'MSFT,,,',           // 算不出損益 → 略過
      'NVDA,500,510,5',
    ].join('\n');
    const r = parseTradeLog({ text: csv, format: 'csv' });
    expect(r.validCount).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.skipReasons[0]).toContain('MSFT');
  });

  it('欄位完全對不上 → FieldMappingError（UI 據此顯示手動對應）', () => {
    const csv = ['aaa,bbb,ccc', '1,2,3'].join('\n');
    expect(() => parseTradeLog({ text: csv, format: 'csv' })).toThrow(FieldMappingError);
  });

  it('市場推斷：EURUSD 是外匯不是 crypto；TMF 是美股不是台期', () => {
    expect(inferMarket('EURUSD')).toBe('forex');
    expect(inferMarket('BTCUSDT')).toBe('crypto');
    expect(inferMarket('TMF')).toBe('us_stock');
    expect(inferMarket('TXFG5')).toBe('tw_futures');
    expect(inferMarket('2330')).toBe('tw_stock');
    expect(inferMarket('00878')).toBe('tw_etf');
    expect(inferMarket('BTC')).toBe('unknown'); // 裸幣名模稜兩可
  });

  it('樣本外驗證：<20 筆回「樣本不足」', () => {
    const log = mkLog([10, -5, 8, -3, 12]);
    const r = holdoutValidate(log, { nBootstrap: 300 });
    expect(r.headline).toContain('太少');
    expect(r.edgePersisted).toBe(false);
  });

  it('JSON 匯入：{"trades": [...]} 包裝與 strategy 欄名', () => {
    const json = JSON.stringify({
      trades: [
        { symbol: 'BTCUSDT', side: 'long', entry_time: '2025-01-02', exit_time: '2025-01-04', entry_price: 94000, exit_price: 96000, quantity: 0.1, strategy: '突破' },
        { symbol: 'ETHUSDT', side: 'long', entry_time: '2025-01-03', exit_time: '2025-01-05', entry_price: 3300, exit_price: 3200, quantity: 2, strategy: '突破' },
      ],
    });
    const r = parseTradeLog({ text: json, format: 'json' });
    expect(r.validCount).toBe(2);
    expect(r.log.trades[0].tag).toBe('突破');
  });
});

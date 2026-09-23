import { describe, expect, it } from 'vitest';
import {
  decideTradeAction, TRAIL_MIN_STEP_R, BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput,
} from '../../src/engine/tradeBridge';

// 2026-09-23 使用者決定：移動止損要設最小移動幅度。
//
// UNIUSDT 三天內撤單重掛約 190 次——每 15 秒只要 markPrice−2×ATR 比現有止損
// 好一點點就換單（10.145 → 10.146 這種）。每次都是 cancel-then-place（幣安
// 規則，見 tradeExecutor update_trailing_stop），中間有無保護窗口，也多一次
// 被拒絕的機會。門檻 0.1R：最多少鎖 0.1R，換單次數降到零頭。

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };
// entry 65000, stopLoss 64000 → 1R = 1000，0.1R = 100
const trade = (o: Partial<BridgeTradeRow> = {}): BridgeTradeRow => ({
  id: 'trade-1', symbol: 'BTCUSDT', isLong: true,
  entry: 65000, stopLoss: 64000, tp1: 67000, strategy: 'A',
  timeframe: '1h', filledAt: 0, openedAt: 0, entryQty: 0.01,
  exchangeEntryOrderId: 1, exchangeStopAlgoId: 222, exchangeTp1AlgoId: 333,
  mfePrice: 67500, // 到過 TP1
  ...o,
});
const snap = (o: Partial<BridgeExchangeSnapshot> = {}): BridgeExchangeSnapshot => ({
  positionQty: 0.005, entryOrderStillOpen: false, tp1OrderStillOpen: false,
  currentStop: { algoId: 222, triggerPrice: 66000 },
  markPrice: 67000, atr1h: 500, filters, now: 0,
  ...o,
});
const risk: RiskCheckInput = {
  positionUSDT: 0, totalOpenRiskPct: 0, thisTradeRiskPct: 0,
  liquidation: { isolatedMarginUSDT: 0, maintMarginRatio: 0, maintAmount: 0 },
};

describe('移動止損最小移動幅度', () => {
  it('門檻是 0.1R', () => {
    expect(TRAIL_MIN_STEP_R).toBe(0.1);
  });

  it('改善不到 0.1R（目標 66050 vs 現有 66000 = 0.05R）→ 不換單', () => {
    const a = decideTradeAction(trade(), snap({ markPrice: 67050 }), risk);
    expect(a.kind).toBe('hold');
  });

  it('改善剛好 0.1R → 換單', () => {
    const a = decideTradeAction(trade(), snap({ markPrice: 67100 }), risk);
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind === 'update_trailing_stop') expect(a.place.stopPrice).toBe(66100);
  });

  it('改善 0.3R → 換單', () => {
    const a = decideTradeAction(trade(), snap({ markPrice: 67300 }), risk);
    expect(a.kind).toBe('update_trailing_stop');
  });

  it('空單方向對稱', () => {
    const t = trade({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, mfePrice: 62500 });
    const small = decideTradeAction(t, snap({ currentStop: { algoId: 222, triggerPrice: 64000 }, markPrice: 62950 }), risk);
    expect(small.kind).toBe('hold');
    const big = decideTradeAction(t, snap({ currentStop: { algoId: 222, triggerPrice: 64000 }, markPrice: 62800 }), risk);
    expect(big.kind).toBe('update_trailing_stop');
  });

  it('TP1 前的保本移動不受門檻影響（那是一次性的大跳）', () => {
    const a = decideTradeAction(
      trade({ mfePrice: 65500 }),
      snap({ positionQty: 0.01, tp1OrderStillOpen: true, currentStop: { algoId: 222, triggerPrice: 64000 }, markPrice: 65500 }),
      risk,
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind === 'update_trailing_stop') expect(a.place.stopPrice).toBe(65000);
  });
});

import { describe, expect, it } from 'vitest';
import {
  decideTradeAction, BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput,
} from '../../src/engine/tradeBridge';

// 2026-09-23：保護單「被交易所拒絕」之後的收尾。
//
// UNIUSDT trade-1789866040715-28chl（testnet）實測：條件單觸發後被幣安以
// `PERCENT_PRICE filter limit` / `Reduce only reject` 打回（algoStatus=REJECTED），
// 13 次。三個後果：
//   1. 止損不見 → 補掛時用的是**原始止損** 8.473，而棘輪早已推到 10.25——
//      鎖住的利潤整個還回去；價格其實已經穿過 10.25，該做的是平倉。
//   2. TP1 單被拒絕後 `exchangeTp1AlgoId` 仍有值，永遠不會補掛。
//   3. TP2 單不見後 `exchangeTp2AlgoId` 仍有值，同樣永遠不會補掛——價格
//      漲過 TP2 一整段，部位還在。

const filters = { stepSize: 1, tickSize: 0.001, minNotional: 5 };

function tradeRow(o: Partial<BridgeTradeRow> = {}): BridgeTradeRow {
  return {
    id: 'trade-uni', symbol: 'UNIUSDT', isLong: true,
    entry: 8.707, stopLoss: 8.473, tp1: 9.176, tp2: 9.527, strategy: 'A',
    timeframe: '1h', filledAt: 0, openedAt: 0,
    entryQty: 51,
    exchangeEntryOrderId: 1, exchangeStopAlgoId: 2, exchangeTp1AlgoId: 3, exchangeTp2AlgoId: null,
    ...o,
  };
}
function snapshot(o: Partial<BridgeExchangeSnapshot> = {}): BridgeExchangeSnapshot {
  return {
    positionQty: 51, entryOrderStillOpen: false, currentStop: { algoId: 2, triggerPrice: 8.473 },
    tp1OrderStillOpen: true, markPrice: 8.8, filters, now: 0,
    ...o,
  };
}
const risk: RiskCheckInput = {
  positionUSDT: 0, totalOpenRiskPct: 0, thisTradeRiskPct: 0,
  liquidation: { isolatedMarginUSDT: 0, maintMarginRatio: 0, maintAmount: 0 },
};

describe('止損不見時的補掛價位', () => {
  it('有已知的較佳止損（棘輪移過）→ 補在那個價位，不退回原始止損', () => {
    const a = decideTradeAction(
      tradeRow({ lastKnownStop: 9.9 }),
      snapshot({ currentStop: null, markPrice: 10.2, positionQty: 41 }),
      risk,
    );
    expect(a.kind).toBe('place_initial_stop');
    if (a.kind === 'place_initial_stop') expect(a.order.stopPrice).toBe(9.9);
  });

  it('價格已經穿過已知止損 → 市價平倉（止損本來就該成交），並撤掉 TP 條件單', () => {
    const a = decideTradeAction(
      tradeRow({ lastKnownStop: 10.25, exchangeTp2AlgoId: 4 }),
      snapshot({ currentStop: null, markPrice: 10.1, positionQty: 41 }),
      risk,
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.order.quantity).toBe(41);
    expect(a.order.side).toBe('SELL');
    expect(a.closeReason).toBeNull();
    expect(a.cancelAlgoIds.sort()).toEqual([3, 4]);
  });

  it('已知止損比原始止損差（異常值）→ 忽略，用原始止損', () => {
    const a = decideTradeAction(
      tradeRow({ lastKnownStop: 8.0 }),
      snapshot({ currentStop: null, markPrice: 8.8 }),
      risk,
    );
    expect(a.kind).toBe('place_initial_stop');
    if (a.kind === 'place_initial_stop') expect(a.order.stopPrice).toBe(8.473);
  });

  it('沒有已知止損、價格也沒穿過原始止損 → 維持原行為', () => {
    const a = decideTradeAction(tradeRow(), snapshot({ currentStop: null, markPrice: 8.8 }), risk);
    expect(a.kind).toBe('place_initial_stop');
    if (a.kind === 'place_initial_stop') expect(a.order.stopPrice).toBe(8.473);
  });

  it('剛成交就已經跌破原始止損 → 平倉（掛止損會被 -2021 立即觸發拒絕，永遠掛不上）', () => {
    const a = decideTradeAction(tradeRow(), snapshot({ currentStop: null, markPrice: 8.4 }), risk);
    expect(a.kind).toBe('close_full_position');
  });

  it('空單方向對稱', () => {
    const t = tradeRow({ isLong: false, entry: 100, stopLoss: 105, tp1: 90, tp2: 85, lastKnownStop: 98 });
    const keep = decideTradeAction(t, snapshot({ currentStop: null, markPrice: 95 }), risk);
    expect(keep.kind).toBe('place_initial_stop');
    if (keep.kind === 'place_initial_stop') expect(keep.order.stopPrice).toBe(98);
    const close = decideTradeAction(t, snapshot({ currentStop: null, markPrice: 98.5 }), risk);
    expect(close.kind).toBe('close_full_position');
    if (close.kind === 'close_full_position') expect(close.order.side).toBe('BUY');
  });
});

describe('TP1 條件單被拒絕／撤銷後補掛', () => {
  it('TP1 單不見、價格從沒到過 TP1（不可能是成交）→ 重新掛 TP1', () => {
    const a = decideTradeAction(
      tradeRow({ mfePrice: 9.0 }),
      snapshot({ tp1OrderStillOpen: false, markPrice: 8.9 }),
      risk,
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind === 'place_tp1_order') expect(a.order.quantity).toBe(25);
  });

  it('TP1 單還掛著 → 不重掛', () => {
    const a = decideTradeAction(tradeRow({ mfePrice: 9.0 }), snapshot({ tp1OrderStillOpen: true, markPrice: 8.9 }), risk);
    expect(a.kind).not.toBe('place_tp1_order');
  });

  it('TP1 單不見但價格到過 TP1（可能剛成交、部位還沒反映）→ 不重掛，避免重複減倉', () => {
    const a = decideTradeAction(
      tradeRow({ mfePrice: 9.2 }),
      snapshot({ tp1OrderStillOpen: false, markPrice: 9.0 }),
      risk,
    );
    expect(a.kind).not.toBe('place_tp1_order');
  });

  it('不知道 TP1 單在不在（undefined）→ 不動作', () => {
    const a = decideTradeAction(tradeRow({ mfePrice: 9.0 }), snapshot({ tp1OrderStillOpen: undefined, markPrice: 8.9 }), risk);
    expect(a.kind).not.toBe('place_tp1_order');
  });
});

describe('策略 B 止盈單不見了（部位還在 = 沒成交，B 的止盈是整單了結）', () => {
  const b = (o: Partial<BridgeTradeRow> = {}) => tradeRow({ strategy: 'B', tp2: 9.176, ...o });

  it('價格還沒到止盈 → 重掛整單止盈', () => {
    const a = decideTradeAction(b(), snapshot({ tp1OrderStillOpen: false, markPrice: 8.9 }), risk);
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind === 'place_tp1_order') expect(a.order.quantity).toBe(51);
  });

  it('價格已超過止盈 → 市價平倉', () => {
    const a = decideTradeAction(b(), snapshot({ tp1OrderStillOpen: false, markPrice: 9.3 }), risk);
    expect(a.kind).toBe('close_full_position');
    if (a.kind === 'close_full_position') expect(a.closeReason).toBeNull();
  });

  it('止盈單還掛著 → 照舊等待', () => {
    const a = decideTradeAction(b(), snapshot({ tp1OrderStillOpen: true, markPrice: 8.9 }), risk);
    expect(a.kind).toBe('hold');
  });

  it('不知道在不在（undefined）→ 照舊等待', () => {
    const a = decideTradeAction(b(), snapshot({ tp1OrderStillOpen: undefined, markPrice: 8.9 }), risk);
    expect(a.kind).toBe('hold');
  });
});

describe('TP2 條件單不見了（部位還在 = 沒成交）', () => {
  // TP1 已發生：51 → 25 剩 26
  const afterTp1 = (o: Partial<BridgeExchangeSnapshot> = {}) => snapshot({
    positionQty: 26, tp1OrderStillOpen: false, currentStop: { algoId: 2, triggerPrice: 8.707 }, ...o,
  });

  it('價格還沒到 TP2 → 重新掛 TP2', () => {
    const a = decideTradeAction(
      tradeRow({ mfePrice: 9.3, exchangeTp2AlgoId: 4 }),
      afterTp1({ tp2OrderStillOpen: false, markPrice: 9.3 }),
      risk,
    );
    expect(a.kind).toBe('place_tp2_order');
    if (a.kind === 'place_tp2_order') expect(a.order.quantity).toBe(26);
  });

  it('價格已經超過 TP2 → 市價平倉（等於 TP2 出場；掛 TP2 會被立即觸發拒絕）', () => {
    const a = decideTradeAction(
      tradeRow({ mfePrice: 10.9, exchangeTp2AlgoId: 4 }),
      afterTp1({ tp2OrderStillOpen: false, markPrice: 10.0 }),
      risk,
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind === 'close_full_position') {
      expect(a.order.quantity).toBe(26);
      expect(a.closeReason).toBeNull();
    }
  });

  it('TP2 還掛著 → 照舊走移動止損', () => {
    const a = decideTradeAction(
      tradeRow({ mfePrice: 9.3, exchangeTp2AlgoId: 4 }),
      afterTp1({ tp2OrderStillOpen: true, markPrice: 9.3 }),
      risk,
    );
    expect(a.kind).not.toBe('place_tp2_order');
    expect(a.kind).not.toBe('close_full_position');
  });

  it('不知道 TP2 在不在（undefined）→ 不重掛（維持舊行為）', () => {
    const a = decideTradeAction(
      tradeRow({ mfePrice: 9.3, exchangeTp2AlgoId: 4 }),
      afterTp1({ tp2OrderStillOpen: undefined, markPrice: 9.3 }),
      risk,
    );
    expect(a.kind).not.toBe('place_tp2_order');
  });
});

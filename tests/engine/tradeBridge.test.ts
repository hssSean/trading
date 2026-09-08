import { describe, expect, it } from 'vitest';
import {
  decideTradeAction, summarizeClosingTrades, deriveLiveCloseReason, didTp1PartialFill,
  BridgeTradeRow, BridgeExchangeSnapshot, RiskCheckInput,
} from '../../src/engine/tradeBridge';
import { UserTrade } from '../../src/engine/binanceClient';

const filters = { stepSize: 0.001, tickSize: 0.1, minNotional: 5 };

function tradeRow(overrides: Partial<BridgeTradeRow> = {}): BridgeTradeRow {
  return {
    id: 'trade-1', symbol: 'BTCUSDT', isLong: true,
    entry: 65000, stopLoss: 64000, tp1: 67000, strategy: 'A',
    timeframe: '1h', filledAt: 0, // filledAt=now=0 → 時間止損兩個門檻都不會觸發，不干擾既有測試
    openedAt: 0, // 同上，跟 snapshot.now=0 同值，掛單過期判斷不會誤觸發
    entryQty: null,
    exchangeEntryOrderId: null, exchangeStopAlgoId: null, exchangeTp1AlgoId: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BridgeExchangeSnapshot> = {}): BridgeExchangeSnapshot {
  return {
    positionQty: 0, entryOrderStillOpen: false, currentStop: null,
    markPrice: 65000, filters, now: 0,
    ...overrides,
  };
}

function risk(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    positionUSDT: 650, totalOpenRiskPct: 0, thisTradeRiskPct: 1,
    liquidation: { isolatedMarginUSDT: 500, maintMarginRatio: 0.004, maintAmount: 0 },
    ...overrides,
  };
}

// 日虧損上限（src/lib/dailyLossCap.ts）——唯一一道用「錢」而不是 R 衡量的
// 關卡，也是唯一一道 fail-closed 的。這裡測的是它有沒有真的接在下單路徑上；
// 門檻邏輯本身的測試在 tests/dailyLossCap.test.ts。
// 2026-09-06：回撤停機原本只存在於 route.ts（產生訊號那側），live-runner
// （實際下單那側）完全沒有。訊號在停機**之前**產生、停機**之後**才輪到
// live-runner 處理的話，那筆單照樣會被送出去——排隊窗口實測可達三天。
// 2026-09-06 實測撞到：UNIUSDT 的 DB 紀錄是 LONG / entry 6.1575 / qty 31，
// 幣安上卻是 -39 @ 7.088（空單）。程式照 DB 判定要掛 SELL 止損，但對空單而言
// SELL 是加碼不是減倉，幣安以 -4509 拒絕——每 15 秒重試一次、永遠不會成功，
// 而那個部位一張止損都沒有。
//
// 之所以偵測不到：live-runner 建快照時就 Math.abs() 把符號丟掉了，決策層
// 根本沒有能力分辨多空。
describe('decideTradeAction — 交易所方向與 DB 不符', () => {
  const base = () => tradeRow({ exchangeEntryOrderId: 111, exchangeStopAlgoId: 222, entryQty: 31 });

  it('DB 記 LONG、交易所是空單，但那個部位有保護單 → 只停手，不碰它', () => {
    const a = decideTradeAction(
      base(),
      snapshot({ positionQty: 39, positionQtySigned: -39, entryOrderStillOpen: false, protectiveOrderCount: 1 }),
      risk(),
    );
    expect(a.kind).toBe('hold');
    if (a.kind !== 'hold') return;
    expect(a.reason).toContain('方向不符');
    expect(a.reason).toContain('-39');
  });

  it('DB 記 SHORT、交易所是多單，有保護單 → 同樣只停手', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 7, stopLoss: 8, tp1: 6, exchangeEntryOrderId: 111, entryQty: 10 }),
      snapshot({ positionQty: 10, positionQtySigned: 10, entryOrderStillOpen: false, protectiveOrderCount: 2 }),
      risk(),
    );
    expect(a.kind).toBe('hold');
    if (a.kind !== 'hold') return;
    expect(a.reason).toContain('方向不符');
  });

  // 2026-09-06 事故的完整形狀：UNI 的止損平過頭把多單翻成 -39 的空單，決策層
  // 認出方向不符後停手——**然後那個部位就沒人管了，裸奔十小時才靠人工發現**。
  // 停手是對的（在認知錯誤的狀態下亂下單更危險），但「停手」不該等於「放著」。
  //
  // 判準刻意收窄成「反向部位 + 交易所端一張保護單都沒有」：這個帳戶的使用者
  // 會用手機 App 手動下單（UNI 那批 ios_* clientOrderId），手動開的倉如果自己
  // 掛了止損就不該被系統平掉。沒有任何保護單的反向部位才是真的沒人管。
  it('反向部位 + 零保護單 → 自動平掉（reduceOnly，方向與交易所部位相反）', () => {
    const a = decideTradeAction(
      base(),
      snapshot({
        positionQty: 39, positionQtySigned: -39, entryOrderStillOpen: false,
        protectiveOrderCount: 0,
        filters: { stepSize: 1, tickSize: 0.001, minNotional: 5 },
      }),
      risk(),
    );
    expect(a.kind).toBe('flatten_unmanaged_position');
    if (a.kind !== 'flatten_unmanaged_position') return;
    // 交易所是空單 → 平它要用 BUY，跟 DB 的 isLong=true 推出來的 SELL 相反。
    // 這裡如果照 DB 方向送單就是加碼，正是 -4509 那個 bug 的形狀。
    expect(a.order.side).toBe('BUY');
    expect(a.order.type).toBe('MARKET');
    expect(a.order.quantity).toBe(39);
    expect(a.order.reduceOnly).toBe(true);
    expect(a.reason).toContain('沒有任何保護單');
  });

  it('反向部位是多單 + 零保護單 → 用 SELL 平掉', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 7, stopLoss: 8, tp1: 6, exchangeEntryOrderId: 111, entryQty: 10 }),
      snapshot({
        positionQty: 10, positionQtySigned: 10, entryOrderStillOpen: false,
        protectiveOrderCount: 0,
        filters: { stepSize: 1, tickSize: 0.001, minNotional: 5 },
      }),
      risk(),
    );
    expect(a.kind).toBe('flatten_unmanaged_position');
    if (a.kind !== 'flatten_unmanaged_position') return;
    expect(a.order.side).toBe('SELL');
    expect(a.order.quantity).toBe(10);
  });

  it('沒帶 protectiveOrderCount 的舊呼叫端 → 維持只停手（不會突然開始自動平倉）', () => {
    const a = decideTradeAction(
      base(),
      snapshot({ positionQty: 39, positionQtySigned: -39, entryOrderStillOpen: false }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('反向部位小到 stepSize 取整為 0 → 停手，不送數量非法的單', () => {
    const a = decideTradeAction(
      base(),
      snapshot({
        positionQty: 0.0005, positionQtySigned: -0.0005, entryOrderStillOpen: false,
        protectiveOrderCount: 0,
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('方向一致時不影響既有行為', () => {
    const a = decideTradeAction(
      base(),
      snapshot({ positionQty: 31, positionQtySigned: 31, entryOrderStillOpen: false, currentStop: null }),
      risk(),
    );
    expect(a.kind).not.toBe('hold');
  });

  // 舊呼叫端不帶 positionQtySigned 就跳過這道檢查，維持原行為。
  it('沒帶 positionQtySigned 時跳過檢查', () => {
    const a = decideTradeAction(
      base(),
      snapshot({ positionQty: 39, entryOrderStillOpen: false, currentStop: null }),
      risk(),
    );
    expect(a.kind).not.toBe('hold');
  });

  it('空倉（0）不觸發——那是還沒成交或已平倉，不是方向不符', () => {
    const a = decideTradeAction(
      base(),
      snapshot({ positionQty: 0, positionQtySigned: 0, entryOrderStillOpen: true }),
      risk(),
    );
    expect(a.kind).toBe('wait_for_fill');
  });
});

// 2026-09-06：**策略 A 的 TP2 在真倉路徑從來沒被執行過。**
//
//   DB 模擬（route.ts / walkTpSl）  觸及 TP2 → 平倉，result='WIN_TP2'
//   live-runner（真倉）             TP2 從不檢查，TP1 之後只有移動止損棘輪
//
// `tp2` 在整個 src/engine/ 只出現過一次（策略 B 的 close-reason 標籤），
// `BridgeTradeRow` 甚至沒有這個欄位。使用者實測回報「打到最終 TP 卻沒有止盈，
// 而且雲端機器完全沒有那筆的 log」——沒有 log 是因為決策回傳 hold。
describe('decideTradeAction — TP2 條件單（TP1 之後）', () => {
  /** TP1 已發生：部位比進場量小。 */
  const afterTp1 = (over: Partial<Parameters<typeof tradeRow>[0]> = {}) => tradeRow({
    exchangeEntryOrderId: 111, exchangeStopAlgoId: 222, exchangeTp1AlgoId: 333,
    entryQty: 0.01, tp2: 70000, ...over,
  });
  const snapAfterTp1 = () => snapshot({
    positionQty: 0.005, entryOrderStillOpen: false, atr1h: 100,
    currentStop: { algoId: 222, triggerPrice: 65000 },
  });

  it('TP1 之後補掛 TP2 條件單', () => {
    const a = decideTradeAction(afterTp1(), snapAfterTp1(), risk());
    expect(a.kind).toBe('place_tp2_order');
    if (a.kind !== 'place_tp2_order') return;
    expect(a.order.type).toBe('TAKE_PROFIT_MARKET');
    expect(a.order.stopPrice).toBe(70000);
    expect(a.order.reduceOnly).toBe(true);
    // 數量是**目前剩餘部位**，不是進場量——TP1 已經吃掉一部分
    expect(a.order.quantity).toBeCloseTo(0.005);
    // 不能用 closePosition：止損單已佔走該 symbol+方向唯一的額度，會撞 -4130
    expect(a.order.closePosition).toBeUndefined();
  });

  it('已經掛過就不重掛，讓移動止損接手', () => {
    const a = decideTradeAction(afterTp1({ exchangeTp2AlgoId: 444 }), snapAfterTp1(), risk());
    expect(a.kind).not.toBe('place_tp2_order');
  });

  // 沒有 tp2（舊資料、或還沒跑 migration）時要維持原行為，不能整筆卡住。
  it('tp2 缺值時跳過，不影響移動止損', () => {
    const a = decideTradeAction(afterTp1({ tp2: null }), snapAfterTp1(), risk());
    expect(a.kind).not.toBe('place_tp2_order');
  });

  it('做空方向掛 BUY 單', () => {
    const a = decideTradeAction(
      afterTp1({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, tp2: 60000 }),
      snapshot({ positionQty: 0.005, entryOrderStillOpen: false, atr1h: 100, currentStop: { algoId: 222, triggerPrice: 66000 } }),
      risk(),
    );
    expect(a.kind).toBe('place_tp2_order');
    if (a.kind !== 'place_tp2_order') return;
    expect(a.order.side).toBe('BUY');
    expect(a.order.stopPrice).toBe(60000);
  });
});

describe('decideTradeAction — 整體停機（回撤／熔斷）', () => {
  it('停機中不下新單', () => {
    const a = decideTradeAction(tradeRow(), snapshot(),
      risk({ haltedReason: '權益回撤 13.00R 已達上限 12R — 暫停開新倉' }));
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('權益回撤');
  });

  it('沒停機時不影響既有行為', () => {
    expect(decideTradeAction(tradeRow(), snapshot(), risk({ haltedReason: null })).kind).toBe('place_entry');
    expect(decideTradeAction(tradeRow(), snapshot(), risk()).kind).toBe('place_entry');
  });

  // 停機的語意是「現在不該開任何新倉」，比單筆層級的檢查優先。
  it('同時停機與超過日虧損時，回報停機原因', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk({
      haltedReason: '權益回撤已達上限', dailyRealizedUsdt: -120, dailyLossCapUsdt: 80,
    }));
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('權益回撤');
  });

  // **只擋新倉。** 既有部位的止損已經掛在交易所上，讓它照原計畫走比在停機
  // 瞬間市價砍掉安全——跟日虧損上限的設計一致。
  it('已經有部位時不受停機影響，照常管理', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01 }),
      snapshot({ positionQty: 0.01, entryOrderStillOpen: false, currentStop: null }),
      risk({ haltedReason: '權益回撤已達上限' }),
    );
    expect(a.kind).not.toBe('skip_entry');
  });
});

describe('decideTradeAction — 日虧損上限', () => {
  it('沒設上限時不影響既有行為', () => {
    expect(decideTradeAction(tradeRow(), snapshot(), risk()).kind).toBe('place_entry');
  });

  it('今日虧損達上限 → skip_entry', () => {
    const a = decideTradeAction(tradeRow(), snapshot(),
      risk({ dailyRealizedUsdt: -120, dailyLossCapUsdt: 80 }));
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('已達上限');
  });

  it('未達上限照常下單', () => {
    expect(decideTradeAction(tradeRow(), snapshot(),
      risk({ dailyRealizedUsdt: -20, dailyLossCapUsdt: 80 })).kind).toBe('place_entry');
  });

  // 設了上限卻查不到今日損益就擋——跟專案其餘關卡（查詢失敗放行）相反，
  // 是刻意的：fail-open 的下檔是無上限虧損。
  it('設了上限但查不到損益 → 擋（fail-closed）', () => {
    const a = decideTradeAction(tradeRow(), snapshot(),
      risk({ dailyRealizedUsdt: null, dailyLossCapUsdt: 80 }));
    expect(a.kind).toBe('skip_entry');
  });

  // 這道關卡排在全局風險上限之前——它一旦觸發，後面的計算都沒有意義。
  it('同時超過日虧損與全局風險時，回報的是日虧損', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk({
      totalOpenRiskPct: 4.5, thisTradeRiskPct: 1,
      dailyRealizedUsdt: -120, dailyLossCapUsdt: 80,
    }));
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('已達上限');
  });
});

describe('decideTradeAction — no entry order placed yet', () => {
  it('places the entry order when risk and liquidation checks pass', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk());
    expect(a.kind).toBe('place_entry');
  });

  it('skips when the global risk cap would be exceeded', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk({ totalOpenRiskPct: 4.5, thisTradeRiskPct: 1 }));
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('全局風險上限');
  });

  it('skips when liquidation would happen before the stop-loss (leverage too high)', () => {
    // isolatedMarginUSDT 很小（高槓桿）讓強平價比止損更早觸發
    const a = decideTradeAction(
      tradeRow({ entry: 100, stopLoss: 90 }),
      snapshot(),
      risk({ positionUSDT: 1000, liquidation: { isolatedMarginUSDT: 15, maintMarginRatio: 0, maintAmount: 0 } }),
    );
    expect(a.kind).toBe('skip_entry');
    if (a.kind !== 'skip_entry') return;
    expect(a.reason).toContain('強平價');
  });

  it('skips when the resulting position would be below minNotional', () => {
    const a = decideTradeAction(tradeRow(), snapshot(), risk({ positionUSDT: 0.001 }));
    expect(a.kind).toBe('skip_entry');
  });
});

describe('decideTradeAction — entry order placed, waiting for fill', () => {
  it('waits when the entry order is still open and no position exists yet', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true }),
      risk(),
    );
    expect(a.kind).toBe('wait_for_fill');
  });

  // 2026-08-11：實測撞到——SOLUSDT 掛單等了 15 小時 28 分還沒成交，
  // decideTradeAction 從沒判斷過「這張單本身是不是已經掛太久了」，只會
  // 無限期回 wait_for_fill。規格 §3-A：掛單有效期最多 4 根該時框 K 線
  // （1h timeframe = 4 小時）。
  it('cancels the stale entry order once it has been open longer than 4 bars of its timeframe (1h → 4h)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '1h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 4 * 60 * 60_000 }), // exactly 4h later
      risk(),
    );
    expect(a.kind).toBe('cancel_stale_entry');
    if (a.kind !== 'cancel_stale_entry') return;
    expect(a.symbol).toBe('BTCUSDT');
    expect(a.orderId).toBe(111);
  });

  it('still waits when the entry order has not yet reached the expiry window', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '1h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 3 * 60 * 60_000 }), // 3h < 4h expiry
      risk(),
    );
    expect(a.kind).toBe('wait_for_fill');
  });

  it('scales the expiry window to the timeframe (4h bars → 16h expiry)', () => {
    const stillWaiting = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '4h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 15 * 60 * 60_000 }),
      risk(),
    );
    expect(stillWaiting.kind).toBe('wait_for_fill');

    const expired = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, openedAt: 0, timeframe: '4h' }),
      snapshot({ positionQty: 0, entryOrderStillOpen: true, now: 16 * 60 * 60_000 }),
      risk(),
    );
    expect(expired.kind).toBe('cancel_stale_entry');
  });
});

describe('decideTradeAction — needs reconcile', () => {
  it('flags for reconcile when the position is flat AND the entry order is gone (ambiguous: cancelled vs closed)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false }),
      risk(),
    );
    expect(a.kind).toBe('needs_reconcile');
  });

  it('resolves to sync_closed_position when the caller has already fetched recentTrades', () => {
    const trades: UserTrade[] = [
      { id: 1, orderId: 999, symbol: 'BTCUSDT', side: 'SELL', price: '67000', qty: '0.01', quoteQty: '670', realizedPnl: '15', commission: '0.5', commissionAsset: 'USDT', time: 1, maker: false, buyer: false },
    ];
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: trades }),
      risk(),
    );
    expect(a.kind).toBe('sync_closed_position');
    if (a.kind !== 'sync_closed_position') return;
    expect(a.avgExitPrice).toBe(67000);
    expect(a.realizedPnl).toBe(15);
    expect(a.result).toBe('WIN_TP1'); // positive realizedPnl → 粗分類為贏
  });

  it('classifies a negative realizedPnl as LOSS (not WIN_TP1)', () => {
    const trades: UserTrade[] = [
      { id: 1, orderId: 999, symbol: 'BTCUSDT', side: 'SELL', price: '64000', qty: '0.01', quoteQty: '640', realizedPnl: '-10', commission: '0.5', commissionAsset: 'USDT', time: 1, maker: false, buyer: false },
    ];
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: trades }),
      risk(),
    );
    expect(a.kind).toBe('sync_closed_position');
    if (a.kind !== 'sync_closed_position') return;
    expect(a.result).toBe('LOSS');
  });

  it('resolves to entry_never_filled when recentTrades was queried and is confirmed empty (entry order vanished, never actually filled)', () => {
    // 2026-08-09：實測撞到 SOLUSDT——LIMIT 進場單在交易所端自己消失（過期/
    // 取消），從未真的成交過，getUserTrades 查回來自然是空陣列，不是查
    // 詢失敗。這種情況不該卡在 needs_reconcile：查過、確認過，答案就是
    // 「這筆單沒開過倉」。
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false, recentTrades: [] }),
      risk(),
    );
    expect(a.kind).toBe('entry_never_filled');
  });

  it('still falls back to needs_reconcile when recentTrades was never queried (undefined, not empty)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0, entryOrderStillOpen: false }), // recentTrades undefined
      risk(),
    );
    expect(a.kind).toBe('needs_reconcile');
  });
});

describe('summarizeClosingTrades', () => {
  it('returns null for an empty list', () => {
    expect(summarizeClosingTrades([], true)).toBeNull();
  });

  it('computes a quantity-weighted average exit price across multiple fills at different prices', () => {
    const trades: UserTrade[] = [
      { id: 1, orderId: 1, symbol: 'BTCUSDT', side: 'SELL', price: '66000', qty: '0.006', quoteQty: '396', realizedPnl: '6', commission: '0.3', commissionAsset: 'USDT', time: 1, maker: true, buyer: false },
      { id: 2, orderId: 1, symbol: 'BTCUSDT', side: 'SELL', price: '68000', qty: '0.004', quoteQty: '272', realizedPnl: '9', commission: '0.2', commissionAsset: 'USDT', time: 2, maker: false, buyer: false },
    ];
    const s = summarizeClosingTrades(trades, true);
    expect(s).not.toBeNull();
    if (!s) return;
    // (396+272)/(0.006+0.004) = 668/0.01 = 66800 — 加權平均，不是 (66000+68000)/2
    expect(s.avgExitPrice).toBeCloseTo(66800, 6);
    expect(s.totalQty).toBeCloseTo(0.01, 8);
    expect(s.totalRealizedPnl).toBeCloseTo(15, 8);
    expect(s.totalCommission).toBeCloseTo(0.5, 8);
  });

  it('ignores entry-side fills mixed into the same query window (LONG entry=BUY, exit=SELL)', () => {
    const trades: UserTrade[] = [
      // 進場成交（BUY）——不該被算進平倉均價
      { id: 1, orderId: 1, symbol: 'HYPEUSDT', side: 'BUY', price: '57.074', qty: '10', quoteQty: '570.74', realizedPnl: '0', commission: '0.3', commissionAsset: 'USDT', time: 1, maker: true, buyer: true },
      // 平倉成交（SELL）——只有這筆該被計入
      { id: 2, orderId: 2, symbol: 'HYPEUSDT', side: 'SELL', price: '55.5', qty: '10', quoteQty: '555', realizedPnl: '-15.74', commission: '0.3', commissionAsset: 'USDT', time: 2, maker: false, buyer: false },
    ];
    const s = summarizeClosingTrades(trades, true);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.avgExitPrice).toBeCloseTo(55.5, 6);
    expect(s.totalRealizedPnl).toBeCloseTo(-15.74, 6);
  });

  it('returns null when only entry-side fills are present (closing fill not yet propagated)', () => {
    // 對帳當下 getUserTrades 只查得到進場成交（幣安平倉成交還沒同步進來）——
    // 這是 2026-08-16 撞到的真實 bug：舊版會把這批 BUY 均價當成出場價，
    // realizedPnl 恆為 0，誤判成 WIN。新版必須回 null，讓呼叫端退回 needs_reconcile。
    const trades: UserTrade[] = [
      { id: 1, orderId: 1, symbol: 'HYPEUSDT', side: 'BUY', price: '57.074', qty: '10', quoteQty: '570.74', realizedPnl: '0', commission: '0.3', commissionAsset: 'USDT', time: 1, maker: true, buyer: true },
    ];
    expect(summarizeClosingTrades(trades, true)).toBeNull();
  });

  it('for a SHORT trade, closing side is BUY (not SELL)', () => {
    const trades: UserTrade[] = [
      // 進場成交（SHORT 的進場是 SELL）——不該被算進平倉均價
      { id: 1, orderId: 1, symbol: 'BTCUSDT', side: 'SELL', price: '65000', qty: '0.01', quoteQty: '650', realizedPnl: '0', commission: '0.3', commissionAsset: 'USDT', time: 1, maker: true, buyer: false },
      // 平倉成交（SHORT 的平倉是 BUY）
      { id: 2, orderId: 2, symbol: 'BTCUSDT', side: 'BUY', price: '64000', qty: '0.01', quoteQty: '640', realizedPnl: '10', commission: '0.3', commissionAsset: 'USDT', time: 2, maker: false, buyer: true },
    ];
    const s = summarizeClosingTrades(trades, false);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.avgExitPrice).toBeCloseTo(64000, 6);
    expect(s.totalRealizedPnl).toBeCloseTo(10, 6);
  });
});

describe('decideTradeAction — filled position, no stop yet (the naked-position window)', () => {
  it('places the initial stop as top priority', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111 }),
      snapshot({ positionQty: 0.01, currentStop: null }),
      risk(),
    );
    expect(a.kind).toBe('place_initial_stop');
    if (a.kind !== 'place_initial_stop') return;
    expect(a.order.type).toBe('STOP_MARKET');
    // 2026-09-06 UNI 翻倉事故後改成自帶數量——closePosition 讓交易所決定平多少，
    // 而它算錯過（部位 1 張平 40 張）。詳見 orderLifecycle.ts 該函數上方註解。
    expect(a.order.quantity).toBe(0.01);
    expect(a.order.reduceOnly).toBe(true);
    expect(a.order.closePosition).toBeUndefined();
  });
});

describe('decideTradeAction — TP1 order placement (strategy A, partial)', () => {
  it('places the TP1 condition order when none is placed yet and TP1 has not happened', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: null }),
      snapshot({
        positionQty: 0.01, // 還是滿倉，等於 entryQty
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind !== 'place_tp1_order') return;
    expect(a.order.type).toBe('TAKE_PROFIT_MARKET');
    expect(a.order.quantity).toBe(0.005); // 一半，不是全部
    expect(a.order.side).toBe('SELL');
  });

  it('mirrors side for SHORT', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, exchangeEntryOrderId: 111, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 66000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind !== 'place_tp1_order') return;
    expect(a.order.side).toBe('BUY');
  });

  it('holds (waiting for the exchange to trigger it) once the TP1 order is already placed and position has not shrunk', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01, // 還是滿倉
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });
});

describe('decideTradeAction — pre-TP1 breakeven arm (策略修改.md 修改1, 真倉鏡像)', () => {
  // tradeRow 預設 entry=65000, stopLoss=64000, tp1=67000 → riskDist=1000,
  // 0.5R 門檻 = entry + 500 = 65500（LONG）。2026-08-17：門檻從 0.8→0.5
  // （見 PRE_TP1_BREAKEVEN_TRIGGER_R 定義處註解），測試數字跟著調整。
  it('moves the stop to breakeven once markPrice reaches +0.5R, before TP1 happens', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01, // TP1 還沒發生（entryQty 沒有變小）
        currentStop: { algoId: 222, triggerPrice: 64000 }, // 原始止損，還沒 arm 過
        markPrice: 65500, // entry(65000) + 0.5×riskDist(1000) = 65500
      }),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(65000); // 進場價（保本）
    expect(a.cancelOrderId).toBe(222);
  });

  it('holds without arming when markPrice has not yet reached the 0.5R threshold', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 65400, // 差 100，還沒到 0.5R
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('is idempotent — does not re-replace once already armed at breakeven', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 65000 }, // 已經 arm 過（= entry）
        markPrice: 65500,
      }),
      risk(),
    );
    expect(a.kind).toBe('hold'); // decideTrailingStopReplace 回 'none'（目標沒有更有利）
  });

  it('mirrors for SHORT — favorable move is price falling', () => {
    const a = decideTradeAction(
      tradeRow({ isLong: false, entry: 65000, stopLoss: 66000, tp1: 63000, exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 64500, // entry(65000) - 0.5×riskDist(1000) = 64500
      }),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(65000);
  });
});

describe('decideTradeAction — strategy B (single take-profit target, tp1==tp2)', () => {
  it('places a full-close TP1 condition order (quantity + reduceOnly, NOT closePosition — would conflict with the stop, -4130) when none is placed yet', () => {
    const a = decideTradeAction(
      tradeRow({ strategy: 'B', exchangeEntryOrderId: 111, exchangeTp1AlgoId: null }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order');
    if (a.kind !== 'place_tp1_order') return;
    expect(a.order.closePosition).toBeUndefined();
    expect(a.order.reduceOnly).toBe(true);
    expect(a.order.quantity).toBe(0.01);
  });

  it('holds once the TP1 condition order is already placed', () => {
    const a = decideTradeAction(
      tradeRow({ strategy: 'B', exchangeEntryOrderId: 111, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });
});

// 2026-09-08 真倉事故（SOLUSDT trade-1788765628400-wb2hq）：保本止損觸發、
// 16.24 張只平掉 16.23（roundToStepSize 的浮點誤差，已在 precision.ts 修掉），
// 剩下 0.01 張灰塵。「部位比進場量小 = TP1 發生了」這條推論把 0.06% 的殘渣
// 判定成 TP1：DB 標成 tp1_hit、推播一則「TP1 已達標」（價格最高只到 +1.07R，
// 離 TP1 的 2R 還很遠），卡片顯示「TP1 已達標，建議把止損移到成本」，然後
// 那 0.01 張帶著止損又跑了 13 小時。
//
// 判準補上下界：TP1 只平掉 TP1_PARTIAL_FRACTION（50%），真的發生過的話部位
// 應該還剩約一半。剩不到期望值的一半（25%）代表把部位吃掉的不是 TP1——灰塵
// 殘留、手動平倉（這個帳戶的使用者會用手機 App 直接下單）、ADL、部分強平都
// 長這樣。
describe('didTp1PartialFill — 部位變小不等於 TP1 發生', () => {
  it('剩下約一半 → 是 TP1', () => {
    expect(didTp1PartialFill(16.24, 8.12)).toBe(true);
  });

  it('部位沒變小 → 不是 TP1', () => {
    expect(didTp1PartialFill(16.24, 16.24)).toBe(false);
  });

  it('只被浮點誤差差掉一點點（> 99%）→ 不是 TP1', () => {
    expect(didTp1PartialFill(16.24, 16.23)).toBe(false);
  });

  it('只剩 0.06% 的灰塵 → 不是 TP1，是部位已經被平掉了', () => {
    expect(didTp1PartialFill(16.24, 0.01)).toBe(false);
  });

  it('剛好在 25% 界線上 → 仍算 TP1（不因為滑價/取整少個幾格就翻判）', () => {
    expect(didTp1PartialFill(16, 4)).toBe(true);
    expect(didTp1PartialFill(16, 3.9)).toBe(false);
  });

  it('entryQty 未知或非正 → 保守判「還沒發生」，不亂猜', () => {
    expect(didTp1PartialFill(null, 8)).toBe(false);
    expect(didTp1PartialFill(0, 8)).toBe(false);
  });
});

describe('decideTradeAction — 灰塵殘留不得被當成 TP1', () => {
  // 同一組輸入，差別只在 entryQty：殘量 50% 走 TP1 後的 ATR 棘輪（止損跟到
  // markPrice − 2×atr = 67000），殘量 0.06% 只能走 TP1 前的保本（止損最多
  // 移到進場價 65000）。用止損落點區分，比 kind 更能指出走的是哪條路。
  const dustSnapshot = () => snapshot({
    positionQty: 0.01,
    currentStop: { algoId: 222, triggerPrice: 64000 },
    markPrice: 68000,
    atr1h: 500,
  });

  it('部位只剩 0.06% 時不走 TP1 後的棘輪，只走 TP1 前的保本', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 16.24, exchangeTp1AlgoId: 333 }),
      dustSnapshot(),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(65000); // 進場價，不是 67000
  });

  it('對照組：殘量剛好一半時仍然走 TP1 後的棘輪', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.02, exchangeTp1AlgoId: 333 }),
      dustSnapshot(),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(67000);
  });
});

describe('decideTradeAction — strategy A trailing stop after TP1', () => {
  it('updates the trailing stop when atr1h is available and the target is more favorable', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.005, // < entryQty * 0.99 → TP1 已發生
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 68000,
        atr1h: 500, // candidate = 68000-1000=67000 > 66000 → 更有利
      }),
      risk(),
    );
    expect(a.kind).toBe('update_trailing_stop');
    if (a.kind !== 'update_trailing_stop') return;
    expect(a.place.stopPrice).toBe(67000);
    expect(a.cancelOrderId).toBe(222);
  });

  it('holds without moving the stop when no ATR data is available yet', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.005,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 68000,
        // atr1h 未提供
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('holds when the target is not more favorable than the current stop (no unnecessary order)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: 0.01, exchangeTp1AlgoId: 333 }),
      snapshot({
        positionQty: 0.005,
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 66200,
        atr1h: 500, // candidate = 66200-1000=65200 < 66000 → 沒有更有利
      }),
      risk(),
    );
    expect(a.kind).toBe('hold');
  });

  it('does not treat a partially-filled entry (entryQty null) as TP1 having happened', () => {
    // entryQty 是 null（理論上不該發生在有止損的情況，但保守起見不能誤判）
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, entryQty: null, exchangeTp1AlgoId: null }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
      }),
      risk(),
    );
    expect(a.kind).toBe('place_tp1_order'); // 沒把 entryQty=null 誤判成「已經 TP1」
  });
});

describe('decideTradeAction — time stop forces a close_full_position with the real reason attached', () => {
  it('fires stall (progress stuck near breakeven for 8+ bars, pre-TP1)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, filledAt: 0, exchangeTp1AlgoId: 333, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.01, // 還沒 TP1
        currentStop: { algoId: 222, triggerPrice: 64000 },
        markPrice: 65100, // progress = 0.1R，卡在 -0.3~0.3 之間
        now: 8.5 * 3600_000, // 8.5 小時 = 8.5 根 1h K 線，超過 8 根門檻
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.closeReason).toBe('time_stop_stall');
  });

  it('fires expiry (24h age limit, pre-TP1, progress not stuck)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, filledAt: 0, exchangeTp1AlgoId: 333, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.01,
        currentStop: { algoId: 222, triggerPrice: 64000 },
        // progress = 0.4R：不在停滯區間(±0.3R)，也還沒到 2026-08-17 調降後
        // 的保本門檻(0.5R)，才會真的落到這條時間止損分支而不是先被保本
        // arm 攔截走（見上面 pre-TP1 breakeven arm 那組測試）。
        markPrice: 65400,
        now: 25 * 3600_000, // 25 小時，超過 intraday 24h 上限
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.closeReason).toBe('time_stop_expiry');
  });

  it('fires expiry_post_tp1 (24h age limit reached after TP1 already happened)', () => {
    const a = decideTradeAction(
      tradeRow({ exchangeEntryOrderId: 111, filledAt: 0, exchangeTp1AlgoId: 333, entryQty: 0.01 }),
      snapshot({
        positionQty: 0.005, // < entryQty * 0.99 → TP1 已發生
        currentStop: { algoId: 222, triggerPrice: 66000 },
        markPrice: 66500,
        now: 25 * 3600_000,
        // atr1h 未提供 → 不會走移動止損分支，直接落到 holdOrTimeStop
      }),
      risk(),
    );
    expect(a.kind).toBe('close_full_position');
    if (a.kind !== 'close_full_position') return;
    expect(a.closeReason).toBe('time_stop_expiry_post_tp1');
  });
});

describe('deriveLiveCloseReason', () => {
  // LONG example: entry 100, stopLoss 95 — used across the LOSS-branch tests
  // below since distinguishing pre_tp1_breakeven vs stop_loss now needs a
  // real entry/stopLoss/avgExitPrice comparison, not just the binary result.
  const longParams = { entry: 100, stopLoss: 95 };

  it('trusts our own pending reason when we forced the close ourselves — no guessing', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: 'time_stop_stall', strategy: 'A', result: 'LOSS',
      ...longParams, avgExitPrice: 95,
    })).toBe('time_stop_stall');
    expect(deriveLiveCloseReason({
      pendingCloseReason: 'time_stop_expiry_post_tp1', strategy: 'A', result: 'WIN_TP1',
      ...longParams, avgExitPrice: 110,
    })).toBe('time_stop_expiry_post_tp1');
  });

  it('falls back to stop_loss for a LOSS with no pending reason — exit price is close to the original stop', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'A', result: 'LOSS',
      ...longParams, avgExitPrice: 94.98, // near stopLoss=95, far from entry=100
    })).toBe('stop_loss');
  });

  // 2026-08-13（策略修改.md 修改1）：pre-TP1 保本止損上線後，LOSS 不再
  // 保證是原始止損——出場價貼近 entry（跟 stopLoss 有明顯距離）代表是
  // 保本止損觸發，不是原始止損。
  it('distinguishes pre_tp1_breakeven from stop_loss by comparing exit price to both known levels', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'A', result: 'LOSS',
      ...longParams, avgExitPrice: 99.95, // near entry=100 (slippage), far from stopLoss=95
    })).toBe('pre_tp1_breakeven');
  });

  it('falls back to tp2 for a strategy B WIN — its take-profit is a single full-close target', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'B', result: 'WIN_TP1',
      ...longParams, avgExitPrice: 110,
    })).toBe('tp2');
  });

  it('falls back to trailing_stop for a strategy A WIN — position could only hit zero after TP1 partial-filled', () => {
    expect(deriveLiveCloseReason({
      pendingCloseReason: null, strategy: 'A', result: 'WIN_TP1',
      ...longParams, avgExitPrice: 108,
    })).toBe('trailing_stop');
  });
});

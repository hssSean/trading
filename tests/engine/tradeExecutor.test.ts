import { describe, expect, it } from 'vitest';
import { executeTradeAction, TradeExecutorClient, TradePersistence } from '../../src/engine/tradeExecutor';
import { PlaceOrderParams } from '../../src/engine/binanceClient';
import { TradeAction } from '../../src/engine/tradeBridge';
import { TimeStopCloseReason } from '../../src/engine/timeStop';

// 跟 runner.test.ts 同一套風格：in-memory fake，記錄呼叫順序/參數，
// 沒有真的網路或 DB。
class FakeClient implements TradeExecutorClient {
  placeOrderCalls: PlaceOrderParams[] = [];
  cancelOrderCalls: Array<{ symbol: string; orderId: number; isAlgoOrder?: boolean }> = [];
  // 2026-08-18：兩個陣列各自記錄，斷言不出「誰先誰後」——移動止損的撤單/下單
  // 順序是有意義的（幣安同方向只允許一張 closePosition 條件單，順序錯就撞
  // -4130），加一條合併時序讓順序本身可以被測到。
  callSequence: string[] = [];
  nextOrderId = 1000;

  async placeOrder(params: PlaceOrderParams) {
    this.placeOrderCalls.push(params);
    this.callSequence.push('place');
    if (this.positionAfterPlace.length > 0) this.positionQty = this.positionAfterPlace.shift() as number;
    return { orderId: this.nextOrderId++, clientOrderId: params.newClientOrderId ?? '', status: 'NEW' };
  }
  /** 撤單回應的 executedQty——部分成交的限價單被撤掉後這裡會 > 0。 */
  cancelExecutedQty = '0';
  /** 撤單要不要丟例外（模擬條件單早就不存在／幣安拒絕）。 */
  cancelThrows = false;
  async cancelOrder(symbol: string, orderId: number, isAlgoOrder?: boolean) {
    this.cancelOrderCalls.push({ symbol, orderId, isAlgoOrder });
    this.callSequence.push('cancel');
    if (this.cancelThrows) throw new Error(`cancel failed for ${orderId}`);
    return { orderId, status: 'CANCELED', executedQty: this.cancelExecutedQty };
  }

  /** 交易所端的部位（帶正負號）。預設 0 = 平倉單一次就平乾淨。 */
  positionQty = 0;
  /** 每次 placeOrder 之後部位變成什麼——用來模擬「平不乾淨」。 */
  positionAfterPlace: number[] = [];
  getPositionQtyCalls: string[] = [];
  async getPositionQty(symbol: string) {
    this.getPositionQtyCalls.push(symbol);
    this.callSequence.push('getPosition');
    return this.positionQty;
  }
}

class FakePersist implements TradePersistence {
  entryOrderIds: Array<{ tradeId: string; orderId: number }> = [];
  stopAlgoIds: Array<{ tradeId: string; algoId: number }> = [];
  tp1AlgoIds: Array<{ tradeId: string; algoId: number }> = [];
  tp2AlgoIds: Array<{ tradeId: string; algoId: number }> = [];
  tp1HitCalls: string[] = [];
  markActiveCalls: string[] = [];
  finalizeCalls: Array<{ tradeId: string; result: unknown }> = [];
  neverFilledCalls: string[] = [];
  filledCalls: Array<{ tradeId: string; filledAt: number }> = [];
  entryQtyCalls: Array<{ tradeId: string; entryQty: number }> = [];
  forceCloseReasonCalls: Array<{ tradeId: string; reason: TimeStopCloseReason }> = [];

  async setEntryOrderId(tradeId: string, orderId: number) { this.entryOrderIds.push({ tradeId, orderId }); }
  async setStopAlgoId(tradeId: string, algoId: number) { this.stopAlgoIds.push({ tradeId, algoId }); }
  async setTp1AlgoId(tradeId: string, algoId: number) { this.tp1AlgoIds.push({ tradeId, algoId }); }
  async setTp2AlgoId(tradeId: string, algoId: number) { this.tp2AlgoIds.push({ tradeId, algoId }); }
  async markTp1Hit(tradeId: string) { this.tp1HitCalls.push(tradeId); }
  async markActive(tradeId: string) { this.markActiveCalls.push(tradeId); }
  async markFilled(tradeId: string, filledAt: number) { this.filledCalls.push({ tradeId, filledAt }); }
  async finalizeClosed(tradeId: string, result: unknown) { this.finalizeCalls.push({ tradeId, result }); }
  async markEntryNeverFilled(tradeId: string) { this.neverFilledCalls.push(tradeId); }
  async setEntryQty(tradeId: string, entryQty: number) { this.entryQtyCalls.push({ tradeId, entryQty }); }
  async markForceCloseReason(tradeId: string, reason: TimeStopCloseReason) { this.forceCloseReasonCalls.push({ tradeId, reason }); }
}

const order: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 65000 };

describe('executeTradeAction — place_entry', () => {
  it('places the order and persists the resulting orderId', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'place_entry', order, quantity: 0.01 };

    const r = await executeTradeAction(client, persist, 'trade-1', action);

    expect(r.executed).toBe(true);
    expect(client.placeOrderCalls).toEqual([order]);
    expect(persist.entryOrderIds).toEqual([{ tradeId: 'trade-1', orderId: 1000 }]);
  });
});

describe('executeTradeAction — place_initial_stop', () => {
  it('places the stop order and persists the algoId', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const stopOrder: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 64000, closePosition: true };
    const action: TradeAction = { kind: 'place_initial_stop', order: stopOrder };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([stopOrder]);
    expect(persist.stopAlgoIds).toEqual([{ tradeId: 'trade-1', algoId: 1000 }]);
  });

  it('also marks the trade as filled — this is the first point decideTradeAction confirms a real fill (2026-08-10 regression: status stayed "waiting" forever, App never showed the position as open)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const stopOrder: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 64000, closePosition: true };
    const action: TradeAction = { kind: 'place_initial_stop', order: stopOrder };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(persist.filledCalls).toHaveLength(1);
    expect(persist.filledCalls[0].tradeId).toBe('trade-1');
    expect(typeof persist.filledCalls[0].filledAt).toBe('number');
  });
});

describe('executeTradeAction — place_tp1_order', () => {
  it('places the TP1 condition order and persists the algoId', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const tp1Order: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: 67000, quantity: 0.005, reduceOnly: true };
    const action: TradeAction = { kind: 'place_tp1_order', order: tp1Order };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([tp1Order]);
    expect(persist.tp1AlgoIds).toEqual([{ tradeId: 'trade-1', algoId: 1000 }]);
  });
});

// 2026-09-06：在此之前策略 A 的 TP2 在真倉路徑從來沒被執行過——只有移動止損，
// 價格穿過 TP2 什麼都不會發生。使用者實測：「打到最終 TP 卻沒有止盈」。
describe('executeTradeAction — place_tp2_order', () => {
  it('places the TP2 condition order and persists the algoId', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const tp2Order: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: 70000, quantity: 0.005, reduceOnly: true };
    const action: TradeAction = { kind: 'place_tp2_order', order: tp2Order };

    const r = await executeTradeAction(client, persist, 'trade-1', action);

    expect(r.executed).toBe(true);
    expect(client.placeOrderCalls).toEqual([tp2Order]);
    expect(persist.tp2AlgoIds).toEqual([{ tradeId: 'trade-1', algoId: 1000 }]);
    // 不可誤寫成 TP1——兩個欄位混用會讓下一輪以為 TP1 沒掛而重掛
    expect(persist.tp1AlgoIds).toEqual([]);
  });
});

// 2026-09-09：這一組全部是 UNIUSDT trade-1788833416973-drr88 的迴歸測試。
// 部位 75，時間止損送出 reduceOnly MARKET 平倉單——**送出的數量是 75，幣安
// 只平了 34**，剩下 41 張沒有人知道。詳見 tradeExecutor.ts close_full_position
// 的長註解。
const fullClose = (over: Partial<Extract<TradeAction, { kind: 'close_full_position' }>> = {}) => ({
  kind: 'close_full_position' as const,
  order: { symbol: 'UNIUSDT', side: 'SELL', type: 'MARKET', quantity: 75, reduceOnly: true,
    newClientOrderId: 'trade-1-fullclose' } as PlaceOrderParams,
  closeReason: 'time_stop_stall' as TimeStopCloseReason,
  cancelAlgoIds: [] as number[],
  stepSize: 1,
  ...over,
});

describe('executeTradeAction — close_full_position', () => {
  it('places the closing order but does NOT write a final result (next cycle reconciles)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = fullClose();

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([action.order]);
    expect(persist.finalizeCalls).toEqual([]); // 刻意不寫，交給下一輪 sync_closed_position
  });

  it('records why we forced the close, so sync_closed_position can use it instead of guessing later', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();

    await executeTradeAction(client, persist, 'trade-1', fullClose({ closeReason: 'time_stop_expiry_post_tp1' }));

    expect(persist.forceCloseReasonCalls).toEqual([{ tradeId: 'trade-1', reason: 'time_stop_expiry_post_tp1' }]);
  });

  it('撤掉保護性條件單之後才送平倉單——reduceOnly 條件單會佔用可平額度', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();

    await executeTradeAction(client, persist, 'trade-1', fullClose({ cancelAlgoIds: [111, 222, 333] }));

    expect(client.cancelOrderCalls).toEqual([
      { symbol: 'UNIUSDT', orderId: 111, isAlgoOrder: true },
      { symbol: 'UNIUSDT', orderId: 222, isAlgoOrder: true },
      { symbol: 'UNIUSDT', orderId: 333, isAlgoOrder: true },
    ]);
    expect(client.callSequence).toEqual(['cancel', 'cancel', 'cancel', 'place', 'getPosition']);
  });

  it('撤條件單失敗不能擋住平倉——平倉比撤單重要', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    client.cancelThrows = true;

    const res = await executeTradeAction(client, persist, 'trade-1', fullClose({ cancelAlgoIds: [111] }));

    expect(res.executed).toBe(true);
    expect(client.placeOrderCalls).toHaveLength(1);
  });

  it('平倉後驗證部位歸零', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();

    const res = await executeTradeAction(client, persist, 'trade-1', fullClose());

    expect(client.getPositionQtyCalls).toEqual(['UNIUSDT']);
    expect(res.closeVerification).toEqual({ flat: true, remaining: 0, extraOrders: 0 });
  });

  it('沒平乾淨就補送——UNI 送 75 只平掉 34，剩下的 41 要自己補平', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    // 第一張單之後剩 41，補送那張才真的歸零
    client.positionAfterPlace = [41, 0];

    const res = await executeTradeAction(client, persist, 'trade-1', fullClose());

    expect(client.placeOrderCalls).toHaveLength(2);
    expect(client.placeOrderCalls[1]).toMatchObject({
      symbol: 'UNIUSDT', side: 'SELL', type: 'MARKET', quantity: 41, reduceOnly: true,
      newClientOrderId: 'trade-1-fullclose-r1', // 冪等 ID 不能重複，否則幣安 -4015
    });
    expect(res.closeVerification).toEqual({ flat: true, remaining: 0, extraOrders: 1 });
  });

  it('空單的殘留部位是負數，補單要用絕對值', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    client.positionAfterPlace = [-41, 0];

    await executeTradeAction(client, persist, 'trade-1', fullClose({
      order: { symbol: 'UNIUSDT', side: 'BUY', type: 'MARKET', quantity: 75, reduceOnly: true },
    }));

    expect(client.placeOrderCalls[1]).toMatchObject({ side: 'BUY', quantity: 41 });
  });

  it('補三次還是平不掉就放棄並大聲回報，不會無限重試', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    client.positionQty = 41; // 怎麼送都平不掉

    const res = await executeTradeAction(client, persist, 'trade-1', fullClose());

    expect(client.placeOrderCalls).toHaveLength(1 + 3);
    expect(res.closeVerification).toEqual({ flat: false, remaining: 41, extraOrders: 3 });
    expect(res.note).toContain('⚠');
  });

  it('殘留量小於一格就補不掉——不送註定被拒的單，直接回報', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    client.positionAfterPlace = [0.4];

    const res = await executeTradeAction(client, persist, 'trade-1', fullClose({ stepSize: 1 }));

    expect(client.placeOrderCalls).toHaveLength(1); // 沒有補單
    expect(res.closeVerification).toEqual({ flat: false, remaining: 0.4, extraOrders: 0 });
    expect(res.note).toContain('⚠');
  });

  it('平倉原因照樣寫回 DB，即使沒平乾淨', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    client.positionQty = 41;

    await executeTradeAction(client, persist, 'trade-1', fullClose());

    expect(persist.forceCloseReasonCalls).toEqual([{ tradeId: 'trade-1', reason: 'time_stop_stall' }]);
  });
});

describe('executeTradeAction — update_trailing_stop', () => {
  // 2026-08-18：原本這裡斷言的是 place-before-cancel（先掛新單再撤舊單）。
  // 實測撞到 COTIUSDT 連續數小時 -4130：幣安同一個 symbol+方向只允許存在
  // 一張 closePosition 條件單，舊止損還在時送新止損一律被拒，移動止損/保本
  // 永遠執行不了。順序必須反過來，這個測試跟著改成鎖 cancel-then-place。
  it('cancels the old stop BEFORE placing the new one (幣安只允許一張 closePosition 單)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const place: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 67000, closePosition: true };
    const action: TradeAction = { kind: 'update_trailing_stop', place, cancelOrderId: 222 };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.callSequence).toEqual(['cancel', 'place']);
    expect(client.placeOrderCalls).toEqual([place]);
    expect(client.cancelOrderCalls).toEqual([{ symbol: 'BTCUSDT', orderId: 222, isAlgoOrder: true }]);
    expect(persist.stopAlgoIds).toEqual([{ tradeId: 'trade-1', algoId: 1000 }]);
  });

  it('skips the cancel step when there was no previous stop (cancelOrderId undefined)', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const place: PlaceOrderParams = { symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: 64000, closePosition: true };
    const action: TradeAction = { kind: 'update_trailing_stop', place };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.cancelOrderCalls).toEqual([]);
  });
});

describe('executeTradeAction — sync_closed_position', () => {
  it('writes the final result via persist.finalizeClosed', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'sync_closed_position', avgExitPrice: 67000, realizedPnl: 15, result: 'WIN_TP1' };

    await executeTradeAction(client, persist, 'trade-1', action);

    expect(client.placeOrderCalls).toEqual([]); // 沒有交易所動作，只有 DB 寫入
    expect(persist.finalizeCalls).toEqual([
      { tradeId: 'trade-1', result: { result: 'WIN_TP1', exitPrice: 67000, realizedPnl: 15 } },
    ]);
  });
});

describe('executeTradeAction — no-op actions', () => {
  it('does not touch the client or persistence for skip_entry/wait_for_fill/needs_reconcile/hold', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const actions: TradeAction[] = [
      { kind: 'skip_entry', reason: 'x' },
      { kind: 'wait_for_fill', reason: 'x' },
      { kind: 'needs_reconcile', reason: 'x' },
      { kind: 'hold', reason: 'x' },
    ];

    for (const action of actions) {
      const r = await executeTradeAction(client, persist, 'trade-1', action);
      expect(r.executed).toBe(false);
      expect(r.note).toBe('x');
    }

    expect(client.placeOrderCalls).toEqual([]);
    expect(client.cancelOrderCalls).toEqual([]);
  });
});

describe('executeTradeAction — entry_never_filled', () => {
  it('marks the trade as never filled without touching the exchange', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'entry_never_filled', reason: '進場單消失但查無任何成交紀錄' };

    const r = await executeTradeAction(client, persist, 'trade-1', action);

    expect(r.executed).toBe(true);
    expect(client.placeOrderCalls).toEqual([]); // 沒有交易所動作，純 DB 標記
    expect(persist.neverFilledCalls).toEqual(['trade-1']);
  });
});

describe('executeTradeAction — cancel_stale_entry', () => {
  it('cancels the LIMIT entry order (not an algo order) then marks never-filled', async () => {
    const client = new FakeClient();
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'cancel_stale_entry', symbol: 'BTCUSDT', orderId: 111, reason: '掛單超過 4 根 1h K 線未成交，主動撤單' };

    const r = await executeTradeAction(client, persist, 'trade-1', action);

    expect(r.executed).toBe(true);
    expect(client.cancelOrderCalls).toEqual([{ symbol: 'BTCUSDT', orderId: 111, isAlgoOrder: false }]);
    expect(persist.neverFilledCalls).toEqual(['trade-1']);
  });

  // 2026-09-01 實測撞到：ARBUSDT 在幣安有 1,123.2 顆部位，App 卻顯示
  // 「真倉進場單過期未成交（真實從未開倉）」。限價單部分成交時狀態仍算 open
  // （PARTIALLY_FILLED），掛滿 4 根 K 線一樣會走到 cancel_stale_entry；撤掉的
  // 只是未成交的剩餘部分，已成交那部分是真實部位。
  //
  // 標成「從未開倉」的後果比記錯損益嚴重得多——系統不知道那個部位存在，就
  // 沒有任何東西在管它：不移動止損、不掛 TP1、不時間止損。
  it('部分成交時不可標記為「從未成交」——那會留下沒人管的裸倉', async () => {
    const client = new FakeClient();
    client.cancelExecutedQty = '1123.2'; // 撤掉剩餘，但已成交 1123.2
    const persist = new FakePersist();
    const action: TradeAction = { kind: 'cancel_stale_entry', symbol: 'ARBUSDT', orderId: 222, reason: '掛單過期' };

    const r = await executeTradeAction(client, persist, 'trade-2', action);

    expect(client.cancelOrderCalls).toHaveLength(1); // 撤單照做（清掉未成交的部分）
    expect(persist.neverFilledCalls).toEqual([]);    // 但不可寫「從未成交」
    expect(r.note).toContain('1123.2');
    // live-runner 對 cancel_stale_entry 會跑 cleanupAfterTradeClosed（撤殘留
    // 條件單 + 解 symbol 鎖）。對還開著的部位跑那個等於把保護單撤掉——比
    // 原本那個「標成從未開倉」的 bug 更糟，所以一定要擋住。
    expect(r.stillOpen).toBe(true);
  });

  it('完全沒成交時照舊標記', async () => {
    const client = new FakeClient();
    client.cancelExecutedQty = '0';
    const persist = new FakePersist();
    const r = await executeTradeAction(client, persist, 'trade-3',
      { kind: 'cancel_stale_entry', symbol: 'BTCUSDT', orderId: 333, reason: '掛單過期' });
    expect(persist.neverFilledCalls).toEqual(['trade-3']);
    expect(r.executed).toBe(true);
    expect(r.stillOpen).toBeFalsy(); // 真的沒成交，善後照跑
  });

  // 舊的測試替身不會回傳 executedQty。缺欄位時當成 0（維持原行為），
  // 不要因為讀不到就保守地不標記——那會讓所有正常過期的掛單卡住不結案。
  it('回應沒有 executedQty 欄位時，維持原本的標記行為', async () => {
    const client = new FakeClient();
    client.cancelExecutedQty = undefined as unknown as string;
    const persist = new FakePersist();
    await executeTradeAction(client, persist, 'trade-4',
      { kind: 'cancel_stale_entry', symbol: 'BTCUSDT', orderId: 444, reason: '掛單過期' });
    expect(persist.neverFilledCalls).toEqual(['trade-4']);
  });
});

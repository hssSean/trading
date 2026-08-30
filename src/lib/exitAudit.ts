// 把幣安 userTrades 配對回我們的 trade 紀錄，判斷出場是真的還是 DB 模擬
// 捏造的。純函數，呼叫端（scripts/audit-fabricated-exits.ts）負責查詢。
//
// ## 為什麼要抽出來
//
// 這段配對邏輯是整個清查唯一會**靜默產生錯誤結論**的地方：配錯就會把正常
// 平倉的單誣告成「捏造出場」，而清查的目的正是要決定哪些歷史資料不能信。
// 一個把好單標成壞單的稽核工具，比沒有稽核工具更糟。
//
// ## 幣安不記我們的 trade_id
//
// userTrades 只有 orderId 和倉位淨額。進場那一側可以用 exchange_entry_order_id
// 精準比對，**平倉那一側沒有任何識別碼**——止損/止盈是條件單觸發的，
// orderId 跟我們記的進場單無關。
//
// 所以平倉只能靠「進場之後、方向相反、還沒被別的單用掉」這三個條件做 FIFO
// 配對。同一個 symbol 上時間重疊的多筆單無法百分之百還原歸屬，這是資料本身
// 的限制不是實作偷懶。因此判語分兩級：
//
//   硬證據（NO_CLOSE_FILL / SIGN_FLIP）—— 配對怎麼錯都不會憑空生出這兩種
//   軟證據（PARTIAL_CLOSE / AMOUNT_MISMATCH）—— 重疊倉位下可能是配對誤差
//
// 報告要照這個分級呈現，不能混在一起講。

/** userTrades 裡我們用得到的欄位（`UserTrade` 的子集，方便測試不必造整包）。 */
export interface AuditFill {
  id: number;
  orderId: number;
  side: 'BUY' | 'SELL';
  price: string;
  qty: string;
  realizedPnl: string;
  time: number;
}

export type AuditVerdict =
  | 'OK'
  | 'NO_CLOSE_FILL'
  | 'SIGN_FLIP'
  | 'AMOUNT_MISMATCH'
  | 'PARTIAL_CLOSE'
  | 'NO_ENTRY_FILL';

export interface AuditOutcome {
  verdict: AuditVerdict;
  entryQty: number | null;
  entryAvg: number | null;
  closedQty: number | null;
  exitAvg: number | null;
  realPnlPct: number | null;
  realizedPnlUsdt: number | null;
  /** 這次配對用掉的成交 id，呼叫端要記起來避免下一筆單重複使用。 */
  consumedIds: number[];
}

/** 數量容差：stepSize 捨去會讓進出場數量有極小差異。 */
export const QTY_EPS = 1e-8;
/**
 * 價格變動% 的容差。TP1 部分停利讓「整筆加權平均出場價」跟 DB 記的單一
 * exit_price 天生就有落差，門檻放寬只抓明顯對不上的。
 */
export const PCT_TOLERANCE = 0.5;

export interface AuditInput {
  /** trades.exchange_entry_order_id */
  entryOrderId: number;
  /** trades.pnl_percent，用來比對方向與幅度；null 就只做存在性檢查。 */
  dbPnlPercent: number | null;
  /** 這個 symbol 的全部成交，時間升序。 */
  fills: AuditFill[];
  /** 已被同 symbol 前面的單消耗掉的成交 id。 */
  consumed: ReadonlySet<number>;
}

const EMPTY: Omit<AuditOutcome, 'verdict'> = {
  entryQty: null, entryAvg: null, closedQty: null, exitAvg: null,
  realPnlPct: null, realizedPnlUsdt: null, consumedIds: [],
};

export function auditTradeExit(input: AuditInput): AuditOutcome {
  const { entryOrderId, dbPnlPercent, fills, consumed } = input;

  const entryFills = fills.filter(f => f.orderId === entryOrderId);
  if (entryFills.length === 0) {
    return { verdict: 'NO_ENTRY_FILL', ...EMPTY };
  }

  const entryQty = entryFills.reduce((s, f) => s + parseFloat(f.qty), 0);
  if (!(entryQty > 0)) {
    // orderId 對得上但數量是 0 —— 資料異常，當成查無成交而不是硬證據。
    return { verdict: 'NO_ENTRY_FILL', ...EMPTY };
  }
  const entryAvg = entryFills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0) / entryQty;
  const lastEntryTime = Math.max(...entryFills.map(f => f.time));
  const entrySide = entryFills[0].side;
  const isLong = entrySide === 'BUY';
  const consumedIds = entryFills.map(f => f.id);

  // 平倉：進場之後、反向、未被消耗，依時間順序湊到進場數量。
  //
  // `f.time >= lastEntryTime` 用 >= 不是 >：同一毫秒內完成進出場（市價單
  // 立刻被止損掃掉）是真的會發生的，用 > 會把那種單誤判成 NO_CLOSE_FILL，
  // 而那正是最嚴重的誤判方向。
  let remaining = entryQty;
  let exitNotional = 0, closedQty = 0, realizedPnl = 0;
  for (const f of fills) {
    if (remaining <= QTY_EPS) break;
    if (f.time < lastEntryTime) continue;
    if (consumed.has(f.id) || consumedIds.includes(f.id)) continue;
    if (f.side === entrySide) continue;

    const fillQty = parseFloat(f.qty);
    if (!(fillQty > 0)) continue;
    const take = Math.min(fillQty, remaining);
    const ratio = take / fillQty;
    exitNotional += take * parseFloat(f.price);
    realizedPnl  += parseFloat(f.realizedPnl) * ratio;
    closedQty    += take;
    remaining    -= take;
    consumedIds.push(f.id);
  }

  if (closedQty <= QTY_EPS) {
    return { verdict: 'NO_CLOSE_FILL', ...EMPTY, entryQty, entryAvg, closedQty: 0, consumedIds };
  }

  const exitAvg = exitNotional / closedQty;
  const realPnlPct = (exitAvg - entryAvg) / entryAvg * 100 * (isLong ? 1 : -1);
  const base = { entryQty, entryAvg, closedQty, exitAvg, realPnlPct, realizedPnlUsdt: realizedPnl, consumedIds };

  if (remaining > QTY_EPS) {
    return { verdict: 'PARTIAL_CLOSE', ...base };
  }
  // 方向比對只在兩邊都非零時才有意義：0% 沒有正負號，保本出場就是 0。
  if (dbPnlPercent != null && dbPnlPercent !== 0 && realPnlPct !== 0
      && Math.sign(dbPnlPercent) !== Math.sign(realPnlPct)) {
    return { verdict: 'SIGN_FLIP', ...base };
  }
  if (dbPnlPercent != null && Math.abs(dbPnlPercent - realPnlPct) > PCT_TOLERANCE) {
    return { verdict: 'AMOUNT_MISMATCH', ...base };
  }
  return { verdict: 'OK', ...base };
}

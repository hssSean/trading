// 「現在實際的止損在哪」——交易所 ↔ DB ↔ App 卡片三方對齊。
//
// ## 為什麼有這個檔案（2026-09-23）
//
// 使用者回報：AVAX 幣安上的止損是 10.973，App 卡片卻寫「TP1 已達標，建議將
// 止損移至成本 9.5551」。兩個數字差了 2.2R。
//
// 根因：live-runner 的移動止損（tradeExecutor `update_trailing_stop`）只做兩件事
// ——換掉幣安上的條件單、把新 algoId 寫進 `exchange_stop_algo_id`。**止損價本身
// 從來沒寫回 `trades.current_stop`**，於是 `/api/trade-status` 永遠回 NULL，
// 卡片只能退回寫死的「移到成本」。DB 模擬（route.ts）一直有寫這個欄位，
// 真倉這條路徑漏了——又是「兩個寫入者對同一個欄位認知不一致」那一類。
//
// 修法是讓 live-runner 每輪拿交易所快照上的止損價跟 DB 比對，不一樣才寫
// （`currentStopToSync`）。用「對帳」而不是「在移動止損那一刻順手寫」：
// 自我修復撿回的止損單、手機 App 手動改的止損、改版前就已經移動過的舊倉位，
// 全都會自動收斂，不需要各自補一條寫入路徑。

const PRICE_EPS = 1e-9;

/**
 * 交易所現在的止損價要不要寫進 DB。回傳要寫的值；不需要寫時回傳 null。
 *
 * - 交易所沒有止損單（null）時**不動 DB**：那是另一種異常（裸倉），由看門狗處理，
 *   這裡把 NULL 寫進去只會讓卡片退回錯的建議。
 * - DB 的 numeric 欄位經 Supabase 回來可能是字串，一律轉數字比對。
 */
export function currentStopToSync(
  dbCurrentStop: number | string | null | undefined,
  exchangeTriggerPrice: number | null | undefined,
): number | null {
  if (exchangeTriggerPrice == null || !Number.isFinite(exchangeTriggerPrice) || exchangeTriggerPrice <= 0) {
    return null;
  }
  const db = dbCurrentStop == null ? NaN : Number(dbCurrentStop);
  if (Number.isFinite(db) && Math.abs(db - exchangeTriggerPrice) <= PRICE_EPS * Math.max(1, Math.abs(db))) {
    return null;
  }
  return exchangeTriggerPrice;
}

/** 卡片上「距止損」該用的價位：有實際止損用實際的，否則原始止損。 */
export function effectiveStop(t: { stopLoss: number; currentStop?: number | null }): number {
  return t.currentStop != null && t.currentStop > 0 ? t.currentStop : t.stopLoss;
}

export type Tp1StopAdvice =
  /** 止損已經離開原始位置——顯示實際價位與鎖住的 R。 */
  | { kind: 'moved'; stop: number; lockedR: number; byExchange: boolean }
  /** 真倉、止損由 live-runner 管，但實際價位還沒同步到 DB——不能叫人去「移到成本」。 */
  | { kind: 'managed_unknown' }
  /** DB 模擬、止損沒動過——維持原本的保本建議（使用者要自己去移）。 */
  | { kind: 'suggest_breakeven'; stop: number };

export function tp1StopAdvice(t: {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  currentStop?: number | null;
  executedOnExchange?: boolean;
}): Tp1StopAdvice {
  const cs = t.currentStop;
  if (cs != null && cs > 0 && Math.abs(cs - t.stopLoss) > PRICE_EPS * Math.max(1, Math.abs(t.stopLoss))) {
    const risk = Math.abs(t.entry - t.stopLoss);
    const lockedR = risk > 0
      ? (t.direction === 'LONG' ? cs - t.entry : t.entry - cs) / risk
      : 0;
    return { kind: 'moved', stop: cs, lockedR, byExchange: t.executedOnExchange === true };
  }
  if (t.executedOnExchange === true) return { kind: 'managed_unknown' };
  return { kind: 'suggest_breakeven', stop: t.entry };
}

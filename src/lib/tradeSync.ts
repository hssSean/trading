// 客戶端交易狀態同步的純決策邏輯（無副作用、可單元測試）。
//
// 背景：一筆單達 TP1 後仍在等 TP2 時，客戶端狀態是
//   result='WIN_TP1'、status='tp1_hit'、closedAt=undefined  → 顯示「持倉中」。
// 伺服器（/api/analyze 監控）才是關單的權威來源；當它把移動止損 / TP2 / 原止損
// 命中後會寫入 closed_at。客戶端只能讀取 result / closed_at / exit_price / pnl_percent
// 這幾個欄位（status / signal_price / current_stop 對 authenticated role 不可讀），
// 所以「這筆單是否已真正結束」必須由 closed_at 判斷，而非只看 result 是否存在。
//
// 舊 bug：loadFromSupabase 只在「本地尚無 result」時才把伺服器結果套用進來，於是
// tp1-watching 的單（本地已有 result=WIN_TP1）永遠不會採用伺服器後來寫入的 closed_at，
// 導致它卡在「持倉中」不進「結束」。這裡把決策抽成純函數並補上 finalize 分支。

import type { TradeResult, TradeRecord } from '@/types';

// 伺服器 trades 資料列中，客戶端可讀的終局欄位。
export interface ServerOutcome {
  result: TradeResult | null;
  closedAt: number | null;
  exitPrice: number | null;
  pnlPercent: number | null;
}

// 本地單需要參與計算的最小欄位。
interface LocalTrade {
  result?: TradeResult;
  closedAt?: number;
  direction: 'LONG' | 'SHORT';
  entry: number;
}

export type OutcomeAction =
  | { kind: 'none' }
  // TP1 達標、仍在等 TP2：記錄 result=WIN_TP1 但「不」關單（closedAt 保持 undefined）。
  | { kind: 'markTp1'; exitPrice: number; pnlPercent: number }
  // 伺服器已寫入 closed_at：真正結束（移動止損 / TP2 / 原止損 / 時間止損 / 到期）。
  | { kind: 'finalize'; result: TradeResult; exitPrice: number; pnlPercent: number; closedAt: number };

function pnlPercentOf(local: LocalTrade, exitPrice: number): number {
  const raw = local.direction === 'LONG'
    ? ((exitPrice - local.entry) / local.entry) * 100
    : ((local.entry - exitPrice) / local.entry) * 100;
  return parseFloat(raw.toFixed(2));
}

// 依伺服器（權威）資料列決定本地單要如何反應。只讀客戶端可讀欄位。
export function resolveServerOutcome(local: LocalTrade, srv: ServerOutcome): OutcomeAction {
  // 本地已真正結束（有 closedAt）→ 冪等，不倒退。
  if (local.closedAt) return { kind: 'none' };

  // 伺服器已寫入 closed_at → 這筆單真正結束了（含 tp1-watching 被移動止損 / TP2 命中）。
  // 即使本地已有 result=WIN_TP1，也要覆蓋成最終 result 並補上 closedAt，讓它進入「結束」。
  if (srv.result && srv.closedAt != null) {
    const exitPrice = srv.exitPrice ?? local.entry;
    return {
      kind: 'finalize',
      result: srv.result,
      exitPrice,
      // 伺服器 pnl_percent 為權威值（依實際出場價計算）；缺值時才本地推算。
      pnlPercent: srv.pnlPercent ?? pnlPercentOf(local, exitPrice),
      closedAt: srv.closedAt,
    };
  }

  // 伺服器剛達 TP1、closed_at 仍為 null → 記為 tp1-watching（不關單）。
  // 只在本地尚未標記過時觸發，避免重複。
  if (srv.result === 'WIN_TP1' && srv.closedAt == null && local.result !== 'WIN_TP1') {
    const exitPrice = srv.exitPrice ?? local.entry;
    return {
      kind: 'markTp1',
      exitPrice,
      pnlPercent: srv.pnlPercent ?? pnlPercentOf(local, exitPrice),
    };
  }

  return { kind: 'none' };
}

// rowToRecord 用：status 欄位對 authenticated role 不可讀（預設會退回 'active'），
// 但 result=WIN_TP1 且尚無 closed_at 唯一對應「tp1-watching」，可據此正確還原 status。
export function deriveTp1Status(
  result: TradeResult | null | undefined,
  closedAt: number | null | undefined,
  fallback: TradeRecord['status'],
): TradeRecord['status'] {
  if (result === 'WIN_TP1' && closedAt == null) return 'tp1_hit';
  return fallback;
}

// 「真正結束」＝已有平倉時間（closedAt），或舊資料有 result 且非 tp1-watching。
// tp1-watching（result=WIN_TP1、status=tp1_hit、無 closedAt）不算結束 → 持倉中。
export function isFinallyClosed(
  t: Pick<TradeRecord, 'closedAt' | 'result' | 'status'>,
): boolean {
  return !!t.closedAt || (!!t.result && t.status !== 'tp1_hit');
}

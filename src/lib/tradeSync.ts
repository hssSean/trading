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
  // 2026-08-05：伺服器關單時寫的 close_reason（time_stop_stall / tp2 /
  // trailing_stop / ...）。以前完全沒同步回客戶端，導致紀錄頁只看得到
  // result='MANUAL_CLOSE' 就一律標成「手動平倉」——但伺服器端的時間止損、
  // 到期平倉都是用 MANUAL_CLOSE 這個 result 值，使用者因此以為是自己（或
  // 某個 bug）把單平掉的。有了這個欄位才分得出「系統關的」與「我自己關的」。
  closeReason?: string | null;
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
  | { kind: 'finalize'; result: TradeResult; exitPrice: number; pnlPercent: number; closedAt: number; closeReason?: string };

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
      ...(srv.closeReason ? { closeReason: srv.closeReason } : {}),
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

// ── status 和解（單向閂鎖 + 不捏造）──────────────────────────────────
//
// 背景（2026-07-27 實錘）：client 端讀不到 Supabase `status` 欄位（authenticated
// role 無 column 權限），rowToRecord 過去對讀不到的欄位塞 'active' 頂替。這個
// 「捏造預設值」會被下面的單向閂鎖（fill 只進不退，9b858ae 加的）誤認成「已
// 確認成交」，於是伺服器後來用 service role 查到的真值 'waiting' 永遠打不贏
// 捏造的 'active' —— 推薦單一出現就顯示「持倉中」，直到 4 根 K 線後伺服器
// 判定逾期取消、刪列，客戶端才看到「掛單取消」，中間完全沒經過「等待進場」。
//
// 修法：本地值附帶 confirmed 旗標。只有「已確認」的本地值才有資格贏過伺服器
// （這才是單向閂鎖原本要保護的東西——真已成交的單不被回退），未確認的猜測
// 一律讓伺服器的權威讀值覆蓋。

export type TradeStatus = 'waiting' | 'active' | 'tp1_hit';

export interface StatusResolveInput {
  localStatus: TradeStatus | undefined;
  localConfirmed: boolean;
  // undefined = 這筆單根本不在伺服器回應裡（查詢漏掉/網路失敗）→ 沒有權威資訊，保留本地
  // null      = 伺服器有這一列，但 status 欄位是 NULL（insert 最深層 fallback 把 status
  //             整個剝掉，該列從創建起就是 NULL）→ 這**是**權威資訊，語意等同 waiting
  // 真值       = 伺服器權威讀值
  serverStatus: TradeStatus | null | undefined;
}

export interface StatusResolveResult {
  status: TradeStatus | undefined;
  confirmed: boolean;
}

const STATUS_RANK: Record<TradeStatus, number> = { waiting: 1, active: 2, tp1_hit: 3 };

export function resolveStatus(input: StatusResolveInput): StatusResolveResult {
  const { localStatus, localConfirmed, serverStatus } = input;

  // 伺服器根本沒回這一列 → 沒有任何權威資訊可用，原封不動保留本地。
  if (serverStatus === undefined) {
    return { status: localStatus, confirmed: localConfirmed };
  }

  // status 欄位是 NULL 時比照 waiting —— 必須和伺服器同語意。
  // 伺服器自 ecc40e6 起把 NULL 併入 waiting 池（`status.eq.waiting,status.is.null`），
  // 照掛單邏輯監控、照掛單推播；客戶端若把 NULL 當「沒資訊」而保留 undefined，
  // 那筆單就卡在「同步中」桶，使用者在「等待進場」永遠看不到它——收得到掛單
  // 通知、畫面卻沒有單（2026-07-27 AKEUSDT 實錘）。
  const effectiveServer: TradeStatus = serverStatus === null ? 'waiting' : serverStatus;

  if (!localConfirmed) {
    // 沒有已確認的本地值需要保護 —— 伺服器權威讀值直接採用。
    return { status: effectiveServer, confirmed: true };
  }
  // 單向閂鎖：已確認的本地值只在伺服器讀值「不落後」時才被覆蓋
  // （絕不因為 DB 寫入延遲就把 active/tp1_hit 退回 waiting）。NULL→waiting 走同一套，
  // 所以監控已寫入成交後又讀到一張舊的 NULL 快照時，也不會把單打回等待進場。
  const localRank = STATUS_RANK[localStatus ?? 'active'] ?? 2;
  if ((STATUS_RANK[effectiveServer] ?? 2) >= localRank) {
    return { status: effectiveServer, confirmed: true };
  }
  return { status: localStatus, confirmed: true };
}

// 「同步中」：伺服器還沒回過這一列（首次載入尚未 reconcile、/api/trade-status
// 失敗或密鑰不符）的開放單。不能顯示成「持倉中」（會捏造不存在的曝險），
// 也不能被靜默丟掉不顯示。
// 註：status 欄位為 NULL 的列**不算**同步中——resolveStatus 已把它歸成 waiting。
export function isUnconfirmedSync(
  t: Pick<TradeRecord, 'result' | 'status' | 'statusConfirmed'>,
): boolean {
  return !t.result && t.status === undefined && !t.statusConfirmed;
}

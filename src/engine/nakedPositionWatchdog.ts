// 「有部位、但交易所上沒有止損單」的告警判斷（純函數，無副作用）。
//
// 為什麼需要這個：2026-09-08~09 的 UNIUSDT 事故——止損單被幣安以
// `rejectReason: "Reduce only reject"` 連續拒絕 20 幾次（部位 41 張，掛著的
// reduceOnly 賣單卻有 TP1 37 + TP2 41 = 78 張，觸發時沒有可減倉的量）。
// live-runner 每 15 秒重掛一次、每次都被拒，**15 小時**內：
//
//   - 部位一張止損都沒有，價格穿過止損價 0.27% 也沒出場
//   - console 上只有正常的「補掛止損」訊息，看不出它們全部沒活下來
//   - 使用者手機沒有收到任何東西
//
// 重掛本身是對的（止損單可能被各種暫時原因拒絕），錯的是**重試永遠不會放棄，
// 也永遠不會抱怨**。裸倉是這個系統最貴的失敗模式，不能只寫在 log 裡等人去看。
//
// 設計取捨：
//   - 寬限期：條件單從送出到出現在查詢結果有延遲，單輪（15秒）看不到止損不代表
//     真的沒有。等 GRACE_MS 才算數，避免每次正常補掛都告警。
//   - 重複告警間隔：裸倉不會自己好，所以要持續提醒，但不能每 15 秒一則推播。
//   - 狀態存在記憶體：live-runner 重啟後重新計時。重啟本來就會讓裸倉重新走一次
//     「補掛止損」流程，重新計時是對的。

/** 連續看不到止損單多久之後才算「真的裸倉」。 */
export const NAKED_GRACE_MS = 3 * 60_000;
/** 已經告警過之後，隔多久再提醒一次。 */
export const NAKED_REALERT_MS = 30 * 60_000;

export interface NakedPositionState {
  /** 第一次看到「有部位但沒止損」的時間；null = 目前有止損或沒部位。 */
  nakedSince: number | null;
  /** 上一次告警時間；null = 還沒告警過。 */
  lastAlertAt: number | null;
}

export interface NakedPositionInput {
  positionQty: number;
  hasStop: boolean;
  now: number;
  state: NakedPositionState;
}

export interface NakedPositionVerdict {
  state: NakedPositionState;
  /** 這一輪要不要發告警。 */
  alert: boolean;
  /** 已經裸奔多久（毫秒）；alert 為 true 時才有意義。 */
  nakedForMs: number;
}

export function evaluateNakedPosition(input: NakedPositionInput): NakedPositionVerdict {
  const { positionQty, hasStop, now, state } = input;

  // 沒部位、或止損單在 → 重置，連告警紀錄一起清掉（下次再裸奔要重新提醒）。
  if (positionQty <= 0 || hasStop) {
    return { state: { nakedSince: null, lastAlertAt: null }, alert: false, nakedForMs: 0 };
  }

  const nakedSince = state.nakedSince ?? now;
  const nakedForMs = now - nakedSince;
  if (nakedForMs < NAKED_GRACE_MS) {
    return { state: { nakedSince, lastAlertAt: state.lastAlertAt }, alert: false, nakedForMs };
  }

  const due = state.lastAlertAt === null || now - state.lastAlertAt >= NAKED_REALERT_MS;
  return {
    state: { nakedSince, lastAlertAt: due ? now : state.lastAlertAt },
    alert: due,
    nakedForMs,
  };
}

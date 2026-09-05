// 跨日權益回撤停機的判定 —— 純函數，三個呼叫端共用一份實作。
//
// ## 為什麼要抽出來
//
// 2026-09-06 用知識圖比對兩條執行路徑的風控關卡，發現一個缺口：
//
//     關卡        route.ts（產生訊號）   live-runner（實際下單）
//     熔斷            ✅                      ❌
//     回撤停機        ✅                      ❌
//     事件窗口        ✅                      ❌
//     kill switch     —                       ✅
//     日虧損上限      —                       ✅
//
// 具體形狀：
//
//     T0  route.ts 產生訊號（所有關卡都過），寫進 trades，entry order 還是 null
//     T1  回撤停機觸發
//     T2  live-runner 看到那筆單的 entry order 是 null，走「還沒下過進場單」
//         分支，檢查日虧損／總風險／強平安全／minNotional
//         ——**完全沒問回撤**——然後 place_entry，真的下單
//
// 系統已經判定「策略可能失效要停」，live-runner 卻照樣把先前排隊的單送出去。
// 而且窗口可能很長：實測 UNIUSDT `opened_at 09-01 07:34`、
// `filled_at 09-04 04:02`，排了三天。
//
// kill switch 就做對了——它在 live-runner 裡 fail-closed，整輪跳過。回撤該比照。
//
// ## 為什麼用推導而不是把 route.ts 的結果存起來
//
// 需要的資訊已經全部在 trades 表裡。存一份狀態要多一個欄位、多一條寫入路徑、
// 還要處理「route.ts 停掉之後那個旗標會過期」——這個專案已經被「靜默過期的
// 狀態」咬過很多次。推導不可能跟事實不一致。
//
// 也刻意不依賴 Redis：回撤停機本來就是從 Supabase 算的，加一條 Redis 路徑
// 只會多一個在 Redis 掛掉時行為不同的分支。

import { calcDrawdown, type EquityPoint } from './monitorMath';

/** 預設門檻。`MAX_DRAWDOWN_R` 環境變數可覆寫，設 0 停用。 */
export const DEFAULT_MAX_DRAWDOWN_R = 12;

export interface DrawdownTradeRow {
  closed_at?: number | null;
  pnl_percent?: number | null;
  entry?: number | null;
  stop_loss?: number | null;
  tier?: string | null;
}

export interface DrawdownHaltResult {
  halted: boolean;
  /** 觸發時的說明；沒觸發是 null。 */
  reason: string | null;
  peakR: number;
  currentR: number;
  drawdownR: number;
  /** 實際納入計算的筆數。0 代表沒有可用資料，一律不擋。 */
  n: number;
}

/**
 * 把已平倉紀錄換算成權益曲線的點。
 *
 * 口徑跟 route.ts 的熔斷一致：**R 倍數 × tier 權重 = 帳戶衝擊**。
 * B tier 是半倉，所以權重 0.5。
 *
 * 缺 `pnl_percent` / `entry` / `stop_loss` 的列跳過——算不出 R 的資料放進去
 * 只會污染曲線。止損距離為 0 同理（會產生 Infinity）。
 */
export function toEquityPoints(rows: DrawdownTradeRow[]): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (const t of rows) {
    if (t.closed_at == null || t.pnl_percent == null || !t.entry || !t.stop_loss) continue;
    const stopPct = Math.abs(t.entry - t.stop_loss) / t.entry * 100;
    if (!(stopPct > 0)) continue;
    out.push({
      closedAt: t.closed_at,
      accountR: (t.pnl_percent / stopPct) * (t.tier === 'B' ? 0.5 : 1.0),
    });
  }
  return out.sort((a, b) => a.closedAt - b.closedAt);
}

/**
 * 判斷是否該因為跨日權益回撤而停止開新倉。
 *
 * @param rows      已平倉紀錄。呼叫端負責只傳「確認時間之後」的那些
 *                  （回撤確認會把量測基準推到確認當下，見 route.ts 的說明）。
 * @param limitR    門檻。<= 0 代表停用。
 *
 * **資料不足時不擋**（`n === 0`）。這跟日虧損上限的 fail-closed 相反，是刻意的：
 * 那道是「最後一道防線、寧可錯過單」，這道是「策略可能失效、停下來讓人檢查」
 * ——沒有資料就沒有「失效」的證據，擋下來只是把系統凍住而沒有任何依據。
 */
export function evaluateDrawdownHalt(
  rows: DrawdownTradeRow[], limitR: number = DEFAULT_MAX_DRAWDOWN_R,
): DrawdownHaltResult {
  const empty = { halted: false, reason: null, peakR: 0, currentR: 0, drawdownR: 0, n: 0 };
  if (!(limitR > 0)) return empty;

  const points = toEquityPoints(rows);
  if (points.length === 0) return empty;

  const s = calcDrawdown(points);
  const base = { peakR: s.peak, currentR: s.current, drawdownR: s.drawdown, n: points.length };
  if (s.drawdown < limitR) return { halted: false, reason: null, ...base };

  return {
    halted: true,
    reason: `權益回撤 ${s.drawdown.toFixed(2)}R（高點 ${s.peak.toFixed(2)}R → 目前 ${s.current.toFixed(2)}R），`
      + `已達上限 ${limitR}R — 暫停開新倉`,
    ...base,
  };
}

/** 從環境變數讀門檻。沒設用預設值；設 0 停用。 */
export function readMaxDrawdownR(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_DRAWDOWN_R;
  if (raw == null || raw === '') return DEFAULT_MAX_DRAWDOWN_R;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : DEFAULT_MAX_DRAWDOWN_R;
}

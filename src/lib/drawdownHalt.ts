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
import { isAuditClean, type AuditMarked } from './cleanPeriod';

/**
 * 預設門檻。`MAX_DRAWDOWN_R` 環境變數可覆寫，設 0 停用。
 *
 * **這是唯一的定義處。** 2026-09-10 之前 `route.ts` 另外有一份同名常數，兩邊
 * 各自維護——那正是這個專案反覆出事的形狀（TP2 在真倉路徑從沒被執行過、出場
 * 邏輯兩條路徑分岔）。route.ts 現在 import 這一個。
 *
 * ── 8R → 12R（2026-08-19，暫時值）────────────────────────────
 * 實際觸發時是 8.01R（高點 26.44R → 18.43R），只超標 0.01R，但近三天 1500 個
 * 候選 100% 被擋、系統完全停擺。關鍵在於**那 8R 回撤是用有 bug 的系統跑出來的**
 * （同日查出並修掉：未收盤 K 棒讓五組計分裡兩組共 20 分變成垃圾；真倉的 TP1 前
 * 保本與 TP1 後移動止損因為 place-before-cancel 撞幣安 closePosition 限制，從
 * 上線到當天為止一次都沒生效過）。拿「保護機制沒運作」的權益曲線去判定「策略
 * 失效」並不公平。12R = 8.01R × 1.5，當時明確記為暫時值，待重新校準。
 *
 * ── 12R → 18R（2026-09-10，校準完成）──────────────────────────
 * `npx tsx scripts/drawdown-threshold.ts` 用真實 R 序列（n=69、sd=1.29）做
 * bootstrap，**假設策略期望值 = 0**，每 50 筆一段取最大回撤的分布：
 *
 *     中位數 8.74R   p90 15.45R   p95 17.59R   p99 21.95R
 *
 *     門檻  8R → 純雜訊觸發率 57.7%
 *     門檻 10R → 39.0%
 *     門檻 12R → 24.9%      ← 舊值
 *     門檻 18R →  5.0%      ← p95，本次採用
 *
 * 去均值是關鍵：觀測到的平均是 −0.107R，直接用會把「策略確實在虧」也算進
 * 「正常波動」，門檻就會被訂得過寬（照觀測分布 p95 是 22.1R）。去掉漂移只留
 * 波動，問的才是「純雜訊能造成多大回撤」。
 *
 * **舊的 12R 不是失效偵測器，是雜訊偵測器**——四次觸發有一次純靠運氣。代價是
 * 實測的：9/1 漏斗顯示回撤停機一週擋掉 191 個候選（佔全部拒絕的 24%，第二大
 * 關卡），而 2026-09-10 實測系統正停在 12.37R / 12R、未平倉 0 筆。
 *
 * 取 p95 而不是更保守值的理由是代價不對稱：誤觸發的代價是「人看一眼、按一顆
 * 解除按鈕」（按鈕已於 82b003f 補上），漏擋的代價是繼續虧。
 *
 * ⚠ n 還小（檢定力邊界 |mean R| > 0.31R）。累積更多乾淨交易後要重跑
 * drawdown-threshold.ts，這個值不是永久的。
 */
export const DEFAULT_MAX_DRAWDOWN_R = 18;

export interface DrawdownTradeRow extends AuditMarked {
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
 *
 * 2026-09-20：對帳判定異常的列也跳過（`isAuditClean`）。那些單的 `pnl_percent`
 * 是 DB 模擬捏造的，拿它算權益曲線等於用假虧損去判定「策略失效」——
 * 2026-08-27 實際發生過，系統被自己捏造的虧損停機。
 */
export function toEquityPoints(rows: DrawdownTradeRow[]): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (const t of rows) {
    if (t.closed_at == null || t.pnl_percent == null || !t.entry || !t.stop_loss) continue;
    if (!isAuditClean(t)) continue;
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

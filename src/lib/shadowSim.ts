// 拒絕漏斗的影子模擬 —— 「這道濾網擋掉的單，如果放行會怎樣」。
//
// 2026-09-20 從 `api/analyze/route.ts` 搬出來。搬的理由不是整理：這段邏輯是
// **整個調參紀律的地基**，而它壞掉的時候完全沒有徵兆。
//
// ## 地基是什麼
//
// `scripts/funnel-verdict.ts` 用「樂觀與悲觀兩端同號才算數，跨零就代表這批
// 資料回答不了」來決定一道濾網能不能動。悲觀軌跡（同一根 K 線同時觸及 TP 與
// SL 時判賠）存在的理由是：K 線的 OHLC 看不出誰先到，原本一律判贏是**單向**
// 樂觀偏誤，而偏誤方向剛好偏向「這關擋錯了、應該放寬」——正好是最危險的方向。
//
// ## 2026-09-20 發現地基在漏
//
// `SHADOW_PESSIMISTIC` 於 2026-08-26 因為 Vercel CPU 超標而改成預設關閉。
// 但關閉之後這段程式**仍然會寫出 `pessResult`**，而那些值不是模擬來的：
//
//   1. 樂觀軌跡結案時直接把結果複製給悲觀（原本的「收斂」分支）
//      → `netRPess` 恆等於 `netR`，「兩端同號」永遠成立，把關等於不存在。
//      實測 2026-09-19 的漏斗報表：`circuit_breaker` −7.08 / −7.08、
//      `btc_direction` −7.00 / −7.00、`confluence` −2.13 / −2.13 全部同值。
//   2. TIMEOUT 分支讀 `pessTp1Hit`，而關閉時它從來沒被更新過 → 一律當成
//      「沒到過 TP1」。那是憑空的悲觀，不是模擬的悲觀，方向跟 (1) 相反。
//   3. `waiting` 逾期（EXPIRED）直接 return，**從來不寫 pess 欄位**
//      → `pessCovered` 少算。score_gate 覆蓋率只有 49% 主要是這個原因，
//      而那些單兩種軌跡的 R 都是 0（`rFor('EXPIRED')` 回 0），本來就該算進去。
//
// 三者都讓判讀失真，方向還不一致——「悲觀覆蓋率」這個把關指標自己就是錯的。
//
// ## 這次的取捨
//
// 悲觀軌跡改成**預設開啟**（`SHADOW_PESSIMISTIC=0` 才關）。當初關掉的理由是
// CPU，但它的成本是對**已經抓回來的** K 線陣列多跑一次純比較迴圈
// （96–168 次 `<=`／`>=`），量級是微秒；真正貴的是 `fetchCandles` 的 I/O 與
// 指標計算，那些兩條軌跡本來就共用。拿一個微秒級的迴圈去換掉整個調參紀律的
// 可信度並不划算。
//
// 關閉時的行為也改了：**一個字都不寫**。寧可 `pessCovered = 0`、讓
// funnel-verdict 直接標「不可用」，也不要寫出看起來很確定的假數字——
// 這跟 reject-funnel 對舊資料的處理原則一致（「分辨『沒有』與『是 0』」）。

import { walkTpSl, type WalkCandle } from './monitorMath';

/** 模擬需要的 K 線欄位。`openTime` 用來判斷掛單有沒有在等待窗口內被觸及。 */
export interface ShadowCandle extends WalkCandle {
  openTime: number;
}

export interface ShadowTrade {
  id: string;
  at: number;               // 被擋下的時間
  symbol: string;
  direction: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  score: number;
  tier: string | null;
  strategy: string;
  rejectedAt: string;       // 漏斗裡的關卡 id
  signalPrice: number;
  status: 'waiting' | 'active' | 'done';
  filledAt?: number;
  tp1Hit?: boolean;
  result?: string;          // WIN_TP1 | WIN_TP2 | LOSS | EXPIRED | TIMEOUT
  exitPrice?: number;
  closedAt?: number;
  lastCheckedAt: number;
  /** 悲觀軌跡（同根 K 線同時觸及 TP/SL 判賠）。關閉時整組都不會出現。 */
  pessTp1Hit?: boolean;
  pessDone?: boolean;
  pessResult?: string;
  pessExitPrice?: number;
}

export interface ShadowSimConfig {
  /** 掛單等多久沒成交就算 EXPIRED。 */
  waitingExpiryHours: number;
  /** 成交後多久沒走到 TP/SL 就算 TIMEOUT。 */
  intradayCloseHours: number;
  /** 要不要跑悲觀軌跡。false 時完全不寫 pess 欄位（見檔頭）。 */
  pessimistic: boolean;
}

/**
 * 推進一筆影子單。**就地修改** `st`（呼叫端用 `shadowWrite.snapshot` 比對前後）。
 */
export function simulateShadow(
  st: ShadowTrade, candles: ShadowCandle[], now: number, cfg: ShadowSimConfig,
): void {
  const isLong = st.direction === 'LONG';
  const waitMs   = cfg.waitingExpiryHours * 3600 * 1000;
  const activeMs = cfg.intradayCloseHours * 3600 * 1000;

  if (st.status === 'waiting') {
    for (const c of candles) {
      if (c.closeTime <= st.at || c.openTime > st.at + waitMs) continue;
      const touched = isLong ? c.low <= st.entry : c.high >= st.entry;
      if (touched) { st.status = 'active'; st.filledAt = Math.max(c.openTime, st.at); break; }
    }
    if (st.status === 'waiting') {
      if (now - st.at > waitMs) {
        st.status = 'done';
        st.result = 'EXPIRED';
        st.closedAt = now;
        // 2026-09-20：EXPIRED 以前直接 return，pess 欄位從來沒寫過，於是這些
        // 單被算進 done 卻不算進 pessCovered，覆蓋率被系統性低估。
        // 掛單從未成交＝沒有部位，兩種軌跡的 R 都是 0（rFor('EXPIRED') → 0），
        // 所以這裡不是「猜一個悲觀值」，是如實記下「這筆兩邊都一樣」。
        if (cfg.pessimistic) {
          st.pessDone = true;
          st.pessResult = 'EXPIRED';
        }
      }
      return;
    }
  }
  if (st.status !== 'active' || !st.filledAt) return;

  const levels = { entry: st.entry, stopLoss: st.stopLoss, tp1: st.tp1, tp2: st.tp2, isLong };

  // 悲觀軌跡要在樂觀之前推進：樂觀結案時會 return，那之後就沒機會算了。
  if (cfg.pessimistic && !st.pessDone) {
    const pess = walkTpSl(candles, st.filledAt, levels, !!st.pessTp1Hit, 'pessimistic');
    st.pessTp1Hit = pess.tp1Hit;
    if (pess.done) {
      st.pessDone = true;
      st.pessResult = pess.result;
      st.pessExitPrice = pess.exitPrice;
    }
  }

  // 主軌跡維持 optimistic：既有的 shadow_trades 都是這個假設累積的，換掉會讓
  // 新舊資料混在同一個統計裡而看不出來。
  const outcome = walkTpSl(candles, st.filledAt, levels, !!st.tp1Hit);
  st.tp1Hit = outcome.tp1Hit;
  if (outcome.done) {
    st.status = 'done';
    st.result = outcome.result;
    st.exitPrice = outcome.exitPrice;
    st.closedAt = outcome.closedAt;
    // 樂觀先結束、悲觀還開著——悲觀只可能比樂觀早或同時結案，所以走到這裡
    // 代表兩條路徑在這批 K 線上沒有分歧（例如一路沒碰過 SL 就直接 TP2）。
    // 收斂過去，不要留一個永遠不結案的空欄位。
    //
    // ⚠ `cfg.pessimistic` 為 false 時**絕不能**走這裡：那會把樂觀結果原封不動
    // 寫成「悲觀值」，讓 netRPess 恆等於 netR、「兩端同號」永遠成立，整個
    // 調參把關失效（2026-09-20 實測就是這個狀態）。
    if (cfg.pessimistic && !st.pessDone) {
      st.pessDone = true;
      st.pessResult = outcome.result;
      st.pessExitPrice = outcome.exitPrice;
    }
    return;
  }
  if (now - st.filledAt > activeMs) {
    const lastC  = candles[candles.length - 1];
    st.status    = 'done';
    st.result    = st.tp1Hit ? 'WIN_TP1' : 'TIMEOUT';
    st.exitPrice = st.tp1Hit ? st.tp1 : lastC?.close;
    st.closedAt  = now;
    // `pessTp1Hit` 只有在悲觀軌跡真的跑過時才有意義。關閉時它恆為 undefined，
    // 寫出來的會是「一律沒到過 TP1」的憑空悲觀值——所以同樣擋在旗標後面。
    if (cfg.pessimistic && !st.pessDone) {
      st.pessDone = true;
      st.pessResult = st.pessTp1Hit ? 'WIN_TP1' : 'TIMEOUT';
      st.pessExitPrice = st.pessTp1Hit ? st.tp1 : lastC?.close;
    }
  }
}

/**
 * 從環境變數讀悲觀軌跡開關。
 *
 * **預設開啟**（2026-09-20 反轉）。它的成本是對已經抓回來的 K 線陣列多跑一次
 * 純比較迴圈，量級微秒；關掉的代價是整個調參紀律失去依據。要關就設
 * `SHADOW_PESSIMISTIC=0`。
 */
export function readPessimisticShadow(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SHADOW_PESSIMISTIC !== '0';
}

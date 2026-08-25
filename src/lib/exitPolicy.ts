// 出場政策模擬器——同一筆進場、不同出場規則，走完真實 K 線比淨 R。
//
// 為什麼需要這支：2026-08-23 的實測資料指出錢是漏在出場而不是進場——
//   移動止損（TP1後）  n=9   MFE +2.66R → 實現 +1.07R   吐回 60%
//   時間止損（盤面停滯）n=22  MFE +0.65R → 實現 +0.01R   吐回 98%
//   原始止損（未達TP1）n=19  MFE +0.05R                  ← 止損是對的，不是漏水點
// 而五組評分因子跟結果的等級相關全部 |t|<2（n=78），進場評分反而量不出效果。
//
// 但「用 MFE 做反事實試算」到此為止就不能再往下推了：那種算法只把虧損單改好，
// 沒有計算新規則對「現在會贏的單」造成的傷害。保本止損會被正常波動掃到，
// 現在賺錢的單有些在到達觸發點後曾回落到進場價下方，新規則下會變成 0R。
// 實際資料已經打臉過那種試算——保本機制已經在跑，三次全部負值（滑價），
// 其中一筆 MFE 曾到 +1.81R 最後 -0.04R，正是「保本砍掉大贏家」的實例。
//
// 所以要逐根走 K 線，讓好處與代價同時被算到。
//
// ── 同根 K 線 TP 與 SL 都碰到時判 SL（悲觀）──
// K 線只有 OHLC，看不出誰先到。monitorMath.ts 的 walkTpSl 預設是判 TP 贏
// （樂觀），那個假設會系統性高估。這裡固定用悲觀：政策比較是成對的，兩邊
// 受同一個假設影響、偏誤大致抵消，而悲觀不會讓人高估任何一個政策的好處。

export interface ExitPolicyConfig {
  name: string;
  /** TP1 觸及時先實現的比例（0 = 不做部分停利，全部留到 TP2/移動止損） */
  tp1Fraction: number;
  /** TP1 之前，浮盈達這個 R 就把止損移到進場價；null = 不做 */
  breakevenAtR: number | null;
  /** TP1 之後的移動止損距離（ATR 倍數）；null = 不移動，停在保本價 */
  trailAtrMult: number | null;
  /**
   * 盤整停滯出場：持有滿這麼多根之後，若進度仍卡在 ±stallBandR 之間就市價出場。
   * null = 不做。
   *
   * 這條規則照抄 engine/timeStop.ts 的線上定義，**只在 TP1 之前生效**：
   * 已經接近止損（< -band）不動，讓原止損決定；已經在推進（> +band）也不動，
   * 給它走到 TP1 的機會。只有「不上不下」才釋放倉位。
   *
   * 早期版本我把它寫成「連續 N 根沒創新高」——那是另一條規則。基準線模型
   * 錯了，整個政策比較就沒有意義，所以這裡刻意貼齊線上定義而不是自己設計。
   */
  stallBars: number | null;
  /** 停滯判定的進度區間（R）。線上是 0.3。 */
  stallBandR: number;
  /** 最多持有幾根 K 線；null = 不限 */
  maxBars: number | null;
}

export interface ExitBar { high: number; low: number; close: number }

export interface ExitInput {
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  isLong: boolean;
  /** 成交當根之後的 K 線 */
  bars: ExitBar[];
  /** 與 bars 對齊的 ATR；長度不足時用最後一個值延伸 */
  atr: number[];
}

export interface ExitOutcome {
  /** 混合 R：TP1 部分停利與剩餘部位加權後的總報酬 */
  r: number;
  reason: 'stop' | 'breakeven' | 'trail' | 'tp2' | 'stall' | 'expiry' | 'open';
  barsHeld: number;
  /** 全程最高浮盈（以 R 計），用來對照「曾經到過多少」 */
  mfeR: number;
  tp1Hit: boolean;
}

export function simulateExit(input: ExitInput, policy: ExitPolicyConfig): ExitOutcome {
  const { entry, stopLoss, tp1, tp2, isLong, bars, atr } = input;
  const risk = Math.abs(entry - stopLoss);
  // 止損距離為 0 的訊號沒有 R 可言，直接判無效而不是回 Infinity/NaN 污染統計。
  if (risk <= 0 || bars.length === 0) {
    return { r: 0, reason: 'open', barsHeld: 0, mfeR: 0, tp1Hit: false };
  }

  const rOf = (price: number) => (isLong ? price - entry : entry - price) / risk;
  const favourable = (bar: ExitBar) => (isLong ? bar.high : bar.low);
  const adverse = (bar: ExitBar) => (isLong ? bar.low : bar.high);
  const hitsBelow = (bar: ExitBar, level: number) => (isLong ? bar.low <= level : bar.high >= level);
  const hitsAbove = (bar: ExitBar, level: number) => (isLong ? bar.high >= level : bar.low <= level);

  let stop = stopLoss;
  let tp1Hit = false;
  let realized = 0;          // 已實現的 R（TP1 部分停利那一段）
  let remaining = 1;         // 剩餘部位比例
  let mfeR = 0;
  let barsSinceNewHigh = 0;
  let bestFavourable = entry;

  const close = (price: number, reason: ExitOutcome['reason'], i: number): ExitOutcome => ({
    r: parseFloat((realized + remaining * rOf(price)).toFixed(4)),
    reason,
    barsHeld: i + 1,
    mfeR: parseFloat(mfeR.toFixed(4)),
    tp1Hit,
  });

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    mfeR = Math.max(mfeR, rOf(favourable(bar)));

    // ① 先判止損（悲觀）。tp1Hit 之後 stop 已在保本價或更好，這裡出場不是虧損。
    if (hitsBelow(bar, stop)) {
      const reason: ExitOutcome['reason'] =
        stop === stopLoss ? 'stop' : (tp1Hit ? 'trail' : 'breakeven');
      return close(stop, reason, i);
    }

    // ② TP2 全部出場
    if (hitsAbove(bar, tp2)) return close(tp2, 'tp2', i);

    // ③ TP1 部分停利（只做一次）
    if (!tp1Hit && hitsAbove(bar, tp1)) {
      tp1Hit = true;
      if (policy.tp1Fraction > 0) {
        realized += policy.tp1Fraction * rOf(tp1);
        remaining -= policy.tp1Fraction;
      }
      // TP1 之後止損地板拉到進場價——這是既有行為（保本地板），不是政策變數。
      stop = isLong ? Math.max(stop, entry) : Math.min(stop, entry);
    }

    // ④ 更新止損
    if (!tp1Hit && policy.breakevenAtR !== null && mfeR >= policy.breakevenAtR) {
      stop = isLong ? Math.max(stop, entry) : Math.min(stop, entry);
    }
    if (tp1Hit && policy.trailAtrMult !== null) {
      const a = atr[Math.min(i, atr.length - 1)] ?? 0;
      if (a > 0) {
        const trail = isLong ? bar.close - a * policy.trailAtrMult : bar.close + a * policy.trailAtrMult;
        // 只進不退，且永遠不低於進場價（保本地板）
        const floor = isLong ? Math.max(entry, trail) : Math.min(entry, trail);
        stop = isLong ? Math.max(stop, floor) : Math.min(stop, floor);
      }
    }

    // ⑤ 盤整停滯（只在 TP1 之前）：持有滿 N 根後進度仍在 ±band 之間就出場。
    if (policy.stallBars !== null && !tp1Hit && i + 1 >= policy.stallBars) {
      const progressR = rOf(bar.close);
      if (progressR > -policy.stallBandR && progressR < policy.stallBandR) {
        return close(bar.close, 'stall', i);
      }
    }

    if (policy.maxBars !== null && i + 1 >= policy.maxBars) {
      return close(bar.close, 'expiry', i);
    }

    void adverse; void bestFavourable; void barsSinceNewHigh; // 保留給未來的 MAE / 推進統計
  }

  // K 線用完還沒出場——這種樣本不能當「賺/賠」計入，呼叫端要排除。
  return close(bars[bars.length - 1].close, 'open', bars.length - 1);
}

// ── 成對比較 ────────────────────────────────────────────────────
// 同一批訊號套兩個政策，比的是**每筆的差異**而不是兩組平均。成對比較把
// 「這筆訊號本身好不好」這個共同變異消掉，同樣樣本數的檢定力高得多——
// 而這個專案的樣本一向不夠，能省的檢定力都要省。
export interface PairedResult {
  n: number;
  meanDiff: number;
  se: number;
  t: number;
  significant: boolean;
}

export function pairedCompare(a: number[], b: number[]): PairedResult {
  const n = Math.min(a.length, b.length);
  if (n < 2) return { n, meanDiff: 0, se: 0, t: 0, significant: false };
  const d = Array.from({ length: n }, (_, i) => b[i] - a[i]);
  const mean = d.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  // sd 為 0 = 每一筆的差異完全相同。這時 t 在數學上是無限大：
  //   差異一致且非零 → 這是可能的最強結果，必須判顯著
  //   差異一致且為零 → 兩個政策根本沒差，不顯著
  // 早期版本這裡一律回 t=0（不顯著），把前者判反了。實務上真實資料 sd 不會
  // 剛好是 0，但樣本少、只有兩三筆有差異且幅度相同時就會踩到——而那正是
  // 這個專案最常見的處境。
  if (se === 0) {
    return {
      n,
      meanDiff: parseFloat(mean.toFixed(4)),
      se: 0,
      t: mean === 0 ? 0 : (mean > 0 ? Infinity : -Infinity),
      significant: mean !== 0,
    };
  }
  const t = mean / se;
  return {
    n,
    meanDiff: parseFloat(mean.toFixed(4)),
    se: parseFloat(se.toFixed(4)),
    t: parseFloat(t.toFixed(2)),
    significant: Math.abs(t) >= 2,
  };
}

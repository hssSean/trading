// 掃描階段計時器——回答「Vercel 的 CPU 到底被誰吃掉」。
//
// 為什麼需要這個：2026-08-31 量到 Fluid Active CPU 4h20m/4h（108%），是唯一
// 超標的項目，代表瓶頸是「每次呼叫的計算量」而不是呼叫次數。但**哪一段**吃掉
// 計算量，到目前為止一直是用推論的：
//
//   「三個時框成本大致相等，5m/15m 只產出 2.2% 的訊號，所以砍掉省 2/3」
//
// 那是估計值，不是量測值。而且推論本身可能低估——`signalCache` 讓
// generateSignals 只在該時框收出新 K 線時才重算，於是每小時的重算次數是
// 5m:15m:1h = 12:4:1，5m 是 1h 的 12 倍。真正的佔比只能量。
//
// 這個專案的規矩是先量再改（CLAUDE.md「任何 bug／非預期行為 →
// systematic-debugging」），而「CPU 超標」正是非預期行為。
//
// 設計約束：
//   - 只用 Date.now()。performance.now() 在 Vercel 的 Node runtime 與本機之間
//     基準點不一致，而我們要的是毫秒級的**相對佔比**，不是微秒級絕對值。
//   - mark() 在熱迴圈裡呼叫，所以不配置閉包、不建臨時物件。呼叫端自己持有
//     起始時間戳（一個 number），這裡只做加總。
//   - 時鐘可注入，測試才能不依賴機器速度。

interface Bucket { ms: number; n: number }

export interface ScanTimingRow {
  label: string;
  ms: number;
  n: number;
}

export class ScanTiming {
  private readonly acc = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 取現在的時間戳，交給呼叫端保管，稍後傳回 mark()。 */
  begin(): number {
    return this.now();
  }

  /**
   * 記一段耗時。`startedAt` 是先前 begin() 的回傳值。
   *
   * 經過時間夾在 0 以上：系統時鐘回跳（NTP 校正、容器遷移）會讓差值變負，
   * 負值會污染總和並產生負佔比，那比少記一筆更糟。
   */
  mark(label: string, startedAt: number): void {
    const elapsed = Math.max(0, this.now() - startedAt);
    const b = this.acc.get(label);
    if (b) { b.ms += elapsed; b.n += 1; }
    else this.acc.set(label, { ms: elapsed, n: 1 });
  }

  /** 依總耗時由大到小。回傳陣列而非 Map——呼叫端要的是排名。 */
  // forEach 而非 for...of entries()：tsconfig 的 target 沒開 downlevelIteration，
  // 迭代 MapIterator 會編譯失敗（TS2802）。2026-09-09 的診斷腳本撞過同一個。
  snapshot(): ScanTimingRow[] {
    const rows: ScanTimingRow[] = [];
    this.acc.forEach((b, label) => rows.push({ label, ms: b.ms, n: b.n }));
    return rows.sort((a, b) => b.ms - a.ms);
  }

  /**
   * 單行摘要，直接丟進 log。
   *
   * 佔比是這個模組存在的理由——絕對毫秒數會隨 Vercel 機器規格浮動，
   * 「5m 佔 62%」才是可以拿來做決定的數字。
   */
  format(): string {
    const rows  = this.snapshot();
    const total = rows.reduce((s, r) => s + r.ms, 0);
    if (total === 0) return 'total 0ms';
    const parts = rows.map(r => `${r.label} ${r.ms}ms/${r.n}次 ${(r.ms / total * 100).toFixed(1)}%`);
    return `total ${total}ms | ${parts.join(' | ')}`;
  }
}

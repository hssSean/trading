// 2026-08-21：交易卡片價格軸的純計算。
//
// 為什麼要有這個檔：舊的 PriceProgressBar 把 止損/進場/TP1/TP2 四個標籤用
// `justify-between` **平均分佈**，跟上面軸線的真實比例完全脫鉤。實測 BNB 那張
// （止損 632.30 / 進場 641.99 / TP1 661.35 / TP2 675.88、現價 652.72）：
// 「進場」標籤印在約 33% 的位置，真實位置其實在 22%；現價圓點在 47%，看起來
// 已經越過進場價了，實際上還差 1.67% 才會成交。使用者回報「無法一目了然」的
// 根因就是這個——不是美感問題，是**視覺位置在說謊**。
//
// 位置比例會直接影響使用者的交易判斷（誤以為快到 TP1 而提早動作），所以算式
// 抽成純函數配測試，不能只靠肉眼看畫面對不對——CLAUDE.md 那條「純數值邏輯
// 務必抽成獨立檔配測試，tsc/build 對這種錯誤是啞的」。

export type PriceZone =
  | 'below_stop'    // 已跌破止損（理論上已出場，顯示上仍要處理得了）
  | 'below_entry'   // 還沒到進場價
  | 'in_profit'     // 已進場、還沒到 TP1
  | 'past_tp1'      // 已越過 TP1 ← 使用者要求：這裡開始要換顏色
  | 'past_tp2';     // 已越過 TP2

export interface AxisInput {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  entry: number;
  tp1: number;
  tp2: number;
  current: number;
}

export interface AxisPositions {
  // 0-100，軸的左端是止損、右端是 TP2。多空共用同一套視覺尺度（左＝壞、右＝好），
  // 所以 SHORT 的原始價格雖然是遞減的，換算後方向跟 LONG 一致。
  stopLoss: number;
  entry: number;
  tp1: number;
  tp2: number;
  current: number;
  zone: PriceZone;
}

// 把單一價格換算成 0-100 的軸位置。夾在 [0,100]：價格可能跑到止損之外或
// TP2 之上，標記不該畫到軸外面去。
function toPct(direction: 'LONG' | 'SHORT', stopLoss: number, tp2: number, price: number): number {
  const span = direction === 'LONG' ? tp2 - stopLoss : stopLoss - tp2;
  if (span === 0 || !Number.isFinite(span)) return 0;
  const progressed = direction === 'LONG' ? price - stopLoss : stopLoss - price;
  const pct = (progressed / span) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

// 判斷現價落在哪一段。用「朝獲利方向前進了多少」比較，不直接比大小，
// 這樣 LONG/SHORT 共用同一組判斷式，不用寫兩份反向邏輯（寫兩份就是
// 之前 -4130 那類「同一個 bug 在兩個地方各犯一次」的溫床）。
export function calcPriceZone(i: AxisInput): PriceZone {
  const { direction, stopLoss, entry, tp1, tp2, current } = i;
  const adv = (p: number) => (direction === 'LONG' ? p : -p);
  const cur = adv(current);

  if (cur <= adv(stopLoss)) return 'below_stop';
  if (cur < adv(entry))     return 'below_entry';
  if (cur < adv(tp1))       return 'in_profit';
  // tp1 === tp2 是策略B（均值回歸只有單一止盈目標，見 signals.ts
  // generateMeanReversionSignals 的 takeProfits: [tp1, tp1]）——這種情況
  // 越過 tp1 就等於越過 tp2，直接歸到 past_tp2，不要報一個永遠到不了的
  // 「past_tp1 但還沒 past_tp2」中間態。
  if (cur < adv(tp2))       return 'past_tp1';
  return 'past_tp2';
}

export function calcAxisPositions(i: AxisInput): AxisPositions {
  const { direction, stopLoss, entry, tp1, tp2, current } = i;
  const pct = (p: number) => toPct(direction, stopLoss, tp2, p);
  return {
    stopLoss: pct(stopLoss),
    entry:    pct(entry),
    tp1:      pct(tp1),
    tp2:      pct(tp2),
    current:  pct(current),
    zone:     calcPriceZone(i),
  };
}

// 現價標記/主要數字的顏色語意。使用者要求「價格到 TP1 後要變不同顏色」——
// 分段給色，一眼看得出「還沒進場 / 有賺但沒到目標 / 已達第一目標」。
// 值對應 globals.css 的設計 token（--down/--up/--accent），不另外發明色票。
export const ZONE_COLOR: Record<PriceZone, string> = {
  below_stop:  'var(--down)',
  below_entry: '#E6AF5A',
  in_profit:   'var(--up)',
  past_tp1:    'var(--accent)',
  past_tp2:    'var(--accent)',
};

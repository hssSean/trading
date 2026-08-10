// 策略歸因分析——把 score_breakdown（v2.1 五組分數：trend/momentum/
// structure/volume/priceAction，2026-08-04 起隨每筆訊號寫進 DB）拿去跟
// 真實結果（result/pnlPercent）交叉，回答「評分公式給的高分，是不是真的
// 對應更好的結果」。
//
// 背景：trades 頁「評分效益」區塊已經顯示過一個違反直覺的現象——65-74分
// (A級，樣本最大 35 筆) 淨值反而是負的，60-64分(B級) 才是賺錢的那段。
// 這裡往下拆一層：不是看「總分」，是看「五組分數各自」跟結果的關聯，
// 才能定位是哪一組在虛高。同時檢驗 2026-08-04 就提出、但當時沒資料能測
// 的假說：extensionAtr（訊號當下離 EMA20 多遠）是不是「進場位置已經追
// 高/追低」的直接證據。
//
// 純函數：不碰資料庫，呼叫端（API route）負責查詢、這裡只負責統計。

export type AttrDirection = 'LONG' | 'SHORT';

export interface AttrScoreBreakdown {
  trend: number;
  momentum: number;
  structure: number;
  volume: number;
  priceAction: number;
  penalties: number;
  extensionAtr?: number;
  entryDistAtr?: number;
}

export interface AttributionTrade {
  direction: AttrDirection;
  result: string | null; // WIN_TP1 / WIN_TP2 / LOSS / MANUAL_CLOSE / CANCELLED / null
  pnlPercent: number | null;
  entry: number;
  stopLoss: number;
  scoreBreakdown: AttrScoreBreakdown | null;
}

const FACTOR_GROUPS = ['trend', 'momentum', 'structure', 'volume', 'priceAction'] as const;
export type FactorGroup = typeof FACTOR_GROUPS[number];

// 跟 trades/page.tsx 的 isWinTrade/isLossTrade 同一套判斷：MANUAL_CLOSE
// 用實際損益正負號判定，CANCELLED（從未成交）兩邊都不算——沒有 R 可算。
function isWin(t: AttributionTrade): boolean {
  if (t.result === 'WIN_TP1' || t.result === 'WIN_TP2') return true;
  if (t.result === 'MANUAL_CLOSE') return (t.pnlPercent ?? 0) > 0;
  return false;
}
function isLoss(t: AttributionTrade): boolean {
  if (t.result === 'LOSS') return true;
  if (t.result === 'MANUAL_CLOSE') return (t.pnlPercent ?? 0) < 0;
  return false;
}
// 只有「真的開過倉」的才算得出 R——CANCELLED 排除。
function hasOutcome(t: AttributionTrade): boolean {
  return t.result !== null && t.result !== 'CANCELLED';
}

// 跟 trades/page.tsx 的 calcRMultiple 同一套公式：R = 損益% ÷ 止損距離%
// （CLAUDE.md：損益一律用 R 倍數衡量，不用原始價格 %）。
export function calcRMultiple(t: { entry: number; stopLoss: number; pnlPercent: number | null }): number | null {
  if (t.pnlPercent === null) return null;
  const riskPct = Math.abs(t.entry - t.stopLoss) / t.entry * 100;
  if (riskPct <= 0) return null;
  return t.pnlPercent / riskPct;
}

export interface BucketStat {
  bucket: '低' | '中' | '高';
  count: number;
  winRate: number; // 0-100
  avgR: number;
  netR: number;
}

// 依數值排序切三等分（低/中/高），不用固定分數門檻——五組因子的實際數值
// 範圍互不相同（v2.1 每組上限不一樣），用相對排序才能公平比較「這組分數
// 高的時候表現有沒有變好」，不受各組不同量表影響。
function bucketize<T>(items: T[], valueOf: (t: T) => number): Array<{ item: T; bucket: '低' | '中' | '高' }> {
  const sorted = [...items].sort((a, b) => valueOf(a) - valueOf(b));
  const n = sorted.length;
  const third = Math.ceil(n / 3);
  return sorted.map((item, i) => ({
    item,
    bucket: i < third ? '低' : i < third * 2 ? '中' : '高',
  }));
}

function summarize(trades: AttributionTrade[]): { count: number; winRate: number; avgR: number; netR: number } {
  const withOutcome = trades.filter(hasOutcome);
  const rs = withOutcome.map(t => calcRMultiple(t)).filter((r): r is number => r !== null);
  const wins = withOutcome.filter(isWin).length;
  const losses = withOutcome.filter(isLoss).length;
  const netR = rs.reduce((s, r) => s + r, 0);
  return {
    count: withOutcome.length,
    winRate: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
    avgR: rs.length > 0 ? parseFloat((netR / rs.length).toFixed(2)) : 0,
    netR: parseFloat(netR.toFixed(2)),
  };
}

function bucketStats(trades: AttributionTrade[], valueOf: (t: AttributionTrade) => number): BucketStat[] {
  const withValue = trades.filter(t => Number.isFinite(valueOf(t)));
  if (withValue.length < 3) return []; // 樣本太少切三桶沒有意義
  const bucketed = bucketize(withValue, valueOf);
  const buckets: Array<'低' | '中' | '高'> = ['低', '中', '高'];
  return buckets.map(bucket => {
    const inBucket = bucketed.filter(b => b.bucket === bucket).map(b => b.item);
    const s = summarize(inBucket);
    return { bucket, ...s };
  });
}

export interface FactorGroupDirectionAvg {
  group: FactorGroup;
  longAvg: number;
  shortAvg: number;
  overallAvg: number;
}

export interface AttributionResult {
  // 每組因子切三桶——驗證「這組分數高，結果是不是真的比較好」。
  // 如果「高」桶的 winRate/avgR 沒有比「低」桶好（甚至更差），代表這組
  // 權重在虛高，不是真正的品質訊號。
  byFactorBucket: Record<FactorGroup, BucketStat[]>;
  // 每組因子的方向平均值對比——驗證「做多評分是不是系統性偏高」。
  // longAvg 明顯高於 shortAvg 的那一組，是做多勝率(62%)明顯低於做空(76%)
  // 的候選解釋之一。
  factorGroupByDirection: FactorGroupDirectionAvg[];
  // extensionAtr（訊號當下離 EMA20 幾個 ATR，正值＝已朝訊號方向延伸）
  // 切三桶——驗證 2026-08-04 提出、當時無法測的假說：「高分靠的是趨勢已
  // 經走很強的證據，而那正是進場位置最差的時候」。如果「高」桶（延伸越
  // 多）avgR 反而更差，這個假說成立。
  extensionAtrBuckets: BucketStat[];
  sampleSize: { total: number; withBreakdown: number };
}

export function analyzeScoreAttribution(trades: AttributionTrade[]): AttributionResult {
  const withBreakdown = trades.filter(t => t.scoreBreakdown !== null);

  const byFactorBucket = {} as Record<FactorGroup, BucketStat[]>;
  for (const group of FACTOR_GROUPS) {
    byFactorBucket[group] = bucketStats(withBreakdown, t => t.scoreBreakdown![group]);
  }

  const factorGroupByDirection: FactorGroupDirectionAvg[] = FACTOR_GROUPS.map(group => {
    const longVals = withBreakdown.filter(t => t.direction === 'LONG').map(t => t.scoreBreakdown![group]);
    const shortVals = withBreakdown.filter(t => t.direction === 'SHORT').map(t => t.scoreBreakdown![group]);
    const avg = (arr: number[]) => arr.length > 0 ? parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2)) : 0;
    return {
      group,
      longAvg: avg(longVals),
      shortAvg: avg(shortVals),
      overallAvg: avg([...longVals, ...shortVals]),
    };
  });

  const withExtension = withBreakdown.filter(t => t.scoreBreakdown!.extensionAtr !== undefined);
  const extensionAtrBuckets = bucketStats(withExtension, t => t.scoreBreakdown!.extensionAtr!);

  return {
    byFactorBucket,
    factorGroupByDirection,
    extensionAtrBuckets,
    sampleSize: { total: trades.length, withBreakdown: withBreakdown.length },
  };
}

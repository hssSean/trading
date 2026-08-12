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
  momentumTags?: string[];
  priceActionTags?: string[];
}

export interface AttributionTrade {
  direction: AttrDirection;
  result: string | null; // WIN_TP1 / WIN_TP2 / LOSS / MANUAL_CLOSE / CANCELLED / null
  pnlPercent: number | null;
  entry: number;
  stopLoss: number;
  scoreBreakdown: AttrScoreBreakdown | null;
  // 2026-08-11：策略#3——使用者觀察到 8月比7月明顯轉差（75%→56%勝率），
  // 假說是 market regime 轉盤整了。這個欄位（trending/ranging/
  // transitional，4H ADX 判定）其實從 v2.1 就一直隨每筆訊號寫進 DB
  // （route.ts insertData 的 regime 欄位），只是從沒被拿來做歸因分析過
  // ——不需要等新資料，用既有歷史資料就能驗證這個假說。
  regime?: string | null;
  // 2026-08-11：使用者回報「今天推幾單成交幾單就止損幾單」，查證發現
  // 3 筆真倉成交裡有 2 筆 confidence 剛好卡在 50（computeConfidence 的
  // 基礎分，代表 ADX 強度/多框架確認/放量都沒有額外加分）。confidence
  // 從 2026-08-04 就存在、也一直寫進 DB，但從沒真的影響過放不放行
  // （route.ts 頂部註解自己也承認：「does NOT affect the
  // STRONG_THRESHOLD gate yet」）。這裡先加進歸因分析，看
  // confidence 分數高低跟結果有沒有關聯——有的話，之後才有數據支撐可以
  // 考慮拿來當第二層濾網，現在還不到能下結論的時候。
  confidence?: number | null;
  // 2026-08-12：得分（score）欄位混了兩套不相容的尺度——策略A（趨勢）算出
  // 來是 60-77，策略B（均值回歸）是 10-19（MIN_SCORE_B=10），同一個數字在
  // 兩套策略裡完全不能比。8/12 CSV 複查踩過這個坑：沒分策略直接把全部
  // 訊號按總分切三桶，策略B的兩筆大贏家（分數14，+3.59R/+1.74R）被丟進
  // 「低分桶」，做出「分數越高結果越差」的假結論——清掉污染重算後，
  // 分數其實跟結果完全無關（見下方 scoreBucketsByStrategy 的用法：一律先
  // 依 strategy 分組，同一組內部才能公平地按分數排序切桶）。
  score?: number | null;
  strategy?: string | null;
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
  // 2026-08-11：momentum/priceAction 這兩組「分數越高、結果越差」——但組
  // 總分看不出是哪個子條件在拖累。momentum 組混了語意矛盾的訊號（RSI 極端
  // 值設計給反轉進場、RSI 健康區回升設計給趨勢跟隨回調，方向相反卻疊加
  // 成同一個分數，見 ScoreBreakdown 型別註解）。這裡按子條件 tag 拆開算
  // 命中率/勝率/平均R，不看總分——才能回答「具體是哪個 if 在反著算」。
  // 每個 tag 各自獨立統計（一筆訊號可能同時命中多個 tag，不互斥）。
  tagStats: Record<string, { count: number; winRate: number; avgR: number }>;
  // 2026-08-11——regime（trending/ranging/transitional，4H ADX 判定）跟
  // 結果的關聯。驗證「8月轉差是不是策略A在盤整格局被誤判成trending硬做」
  // 這個假說：如果 trending 的表現本身沒有隨時間變差，代表 regime 判斷
  // 機制運作正常，問題在別的地方，不該去調 ADX 門檻。
  byRegime: Record<string, { count: number; winRate: number; avgR: number }>;
  // 2026-08-11——confidence（computeConfidence 算出的 0-100 分，目前純
  // 顯示不影響放行）切三桶。使用者實測：今天 3 筆真倉成交裡 2 筆
  // confidence 卡在基礎分 50（沒有 ADX 強度/多框架確認/放量任何加分）
  // 就全部止損。看「低」桶表現是不是真的比較差，決定 confidence 未來
  // 有沒有資格當第二層濾網——現在樣本還太少，先建好分析維度。
  confidenceBuckets: BucketStat[];
  // 2026-08-12——`score` 依 `strategy` 分組後才切三桶，絕不把兩套不同尺度
  // 的分數混在同一次排序裡（見 AttributionTrade.score 註解）。key 是
  // strategy 值（'A'/'B'/...），缺 strategy 的舊資料（8/4 前）歸進
  // 'unknown'，不猜測、不當成 'A'——上一次用 `?? 'A'` 猜測正是 8/6 那次
  // 分析出包的根因，這裡不重蹈覆轍。
  scoreBucketsByStrategy: Record<string, BucketStat[]>;
  sampleSize: { total: number; withBreakdown: number };
}

const KNOWN_TAGS = [
  'rsi_extreme', 'rsi_recovering', 'rsi_healthy_pullback', 'rsi_divergence',
  'macd_cross', 'macd_momentum_shift', 'engulfing', 'reversal_candle',
];

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

  const tagStats: AttributionResult['tagStats'] = {};
  for (const tag of KNOWN_TAGS) {
    const hits = withBreakdown.filter(t =>
      t.scoreBreakdown!.momentumTags?.includes(tag) || t.scoreBreakdown!.priceActionTags?.includes(tag));
    if (hits.length === 0) continue;
    const s = summarize(hits);
    tagStats[tag] = { count: s.count, winRate: s.winRate, avgR: s.avgR };
  }

  const byRegime: AttributionResult['byRegime'] = {};
  const regimeKeys = Array.from(new Set(trades.map(t => t.regime).filter((r): r is string => !!r)));
  for (const regime of regimeKeys) {
    const s = summarize(trades.filter(t => t.regime === regime));
    if (s.count === 0) continue;
    byRegime[regime] = { count: s.count, winRate: s.winRate, avgR: s.avgR };
  }

  const withConfidence = trades.filter(t => t.confidence !== null && t.confidence !== undefined);
  const confidenceBuckets = bucketStats(withConfidence, t => t.confidence!);

  const scoreBucketsByStrategy: AttributionResult['scoreBucketsByStrategy'] = {};
  const withScore = trades.filter(t => t.score !== null && t.score !== undefined);
  const strategyKeys = Array.from(new Set(withScore.map(t => t.strategy ?? 'unknown')));
  for (const key of strategyKeys) {
    const group = withScore.filter(t => (t.strategy ?? 'unknown') === key);
    const buckets = bucketStats(group, t => t.score!);
    if (buckets.length > 0) scoreBucketsByStrategy[key] = buckets;
  }

  return {
    byFactorBucket,
    factorGroupByDirection,
    extensionAtrBuckets,
    tagStats,
    byRegime,
    confidenceBuckets,
    scoreBucketsByStrategy,
    sampleSize: { total: trades.length, withBreakdown: withBreakdown.length },
  };
}

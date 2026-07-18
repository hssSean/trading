// 移植自 core/strategy/per_tag.py + core/antiscam/signals.py 的 _FOLLOW_KEYWORDS。
// per-tag 刻意只做「描述統計」不發優勢徽章 —— 對 K 個標籤各檢定一次卻不做
// 多重比較校正，會把運氣認成優勢（K=5 時誤判率實測 24%）。

import { computeMetrics } from './metrics';
import { AgTradeLog, filterByTag, filterLog } from './models';
import { judge, VerdictLevel } from './verdict';

// 跟單/聽明牌關鍵字（對照 antiscam/signals._FOLLOW_KEYWORDS）
export const FOLLOW_KEYWORDS = [
  '老師', '明牌', '報明牌', '帶單', 'vip', '內線', '消息', '推薦',
  '跟單', '名師', '分析師', '飆股',
  '投資群', '股票群', '老師群', 'line群', '飆股群', '帶單群',
  '二群', 'vip群',
] as const;

export interface TagVerdict {
  tag: string;
  nTrades: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
  lowSample: boolean;
  isLosing: boolean;
}

export function tagDescriptor(tv: TagVerdict): string {
  const base = tv.isLosing ? '🔻 賠錢中' : '🔺 賺錢中';
  return tv.lowSample ? `${base}（樣本少）` : base;
}

export interface CounterfactualResult {
  worstTag: string;
  beforeExpectancy: number;
  afterExpectancy: number;
  beforeTotalPnl: number;
  afterTotalPnl: number;
  message: string;
}

export interface FollowGuruResult {
  nTrades: number;
  expectancy: number;
  totalPnl: number;
  winRate: number;
  level: VerdictLevel;
  followTags: string[];
  message: string;
}

/** 每個 tag 的描述統計，期望值由低到高排序（最該砍的排最前）。 */
export function perTagVerdicts(
  log: AgTradeLog,
  opts: { minTagTrades?: number } = {},
): TagVerdict[] {
  void opts; // 保留參數位以維持與原始碼簽名對應
  const tags = new Set<string>();
  for (const t of log.trades) if (t.tag) tags.add(t.tag);

  const results: TagVerdict[] = [];
  for (const tag of Array.from(tags)) {
    const sub = filterByTag(log, tag);
    if (sub.trades.length < 2) continue;
    const m = computeMetrics(sub);
    results.push({
      tag,
      nTrades: sub.trades.length,
      expectancy: m.expectancy,
      winRate: m.winRate,
      profitFactor: m.profitFactor,
      totalPnl: m.totalPnl,
      lowSample: sub.trades.length < 30,
      isLosing: m.expectancy < 0,
    });
  }
  results.sort((a, b) => a.expectancy - b.expectancy);
  return results;
}

/** 反事實：停掉期望值最差的 tag，整體會變怎樣（純會計式對照，不重新裁決）。 */
export function counterfactualDropWorst(
  log: AgTradeLog,
  opts: { tagVerdicts?: TagVerdict[] } = {},
): CounterfactualResult | null {
  const tv = opts.tagVerdicts ?? perTagVerdicts(log);
  if (tv.length < 2) return null; // 至少兩個 tag 才談「砍掉一個」

  const worst = tv[0];
  if (worst.expectancy >= 0) return null; // 最差的都沒在送錢

  const beforeM = computeMetrics(log);
  const afterLog = filterLog(log, t => t.tag !== worst.tag, `drop_${worst.tag}`);
  if (afterLog.trades.length < 2) return null;
  const afterM = computeMetrics(afterLog);

  const deltaExp = afterM.expectancy - beforeM.expectancy;
  const deltaPnl = afterM.totalPnl - beforeM.totalPnl;
  const fmt = (x: number) => `${x >= 0 ? '+' : ''}${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const message =
    `在這段回測期間，若當初沒做「${worst.tag}」這一招：` +
    `總損益會從 ${fmt(beforeM.totalPnl)} 變成 ${fmt(afterM.totalPnl)}（差 ${fmt(deltaPnl)}）；` +
    `每筆期望值從 ${beforeM.expectancy >= 0 ? '+' : ''}${beforeM.expectancy.toFixed(2)} 變成 ${afterM.expectancy >= 0 ? '+' : ''}${afterM.expectancy.toFixed(2)}（改善 ${deltaExp >= 0 ? '+' : ''}${deltaExp.toFixed(2)}）。` +
    ' 注意：這是「事後從同一份資料挑出最差的一招」再回頭算的假設情境，改善有一部分來自回歸均值，不代表未來停掉它就一定會賺。';

  return {
    worstTag: worst.tag,
    beforeExpectancy: beforeM.expectancy,
    afterExpectancy: afterM.expectancy,
    beforeTotalPnl: beforeM.totalPnl,
    afterTotalPnl: afterM.totalPnl,
    message,
  };
}

/** 跟單/聽明牌交易的專屬抽算 —— 用使用者自己的數字檢驗跟單績效。 */
export function followTheGuru(
  log: AgTradeLog,
  opts: { nBootstrap?: number } = {},
): FollowGuruResult | null {
  const nBootstrap = opts.nBootstrap ?? 2000;

  const isFollow = (t: { tag: string | null }) =>
    !!t.tag && FOLLOW_KEYWORDS.some(k => String(t.tag).toLowerCase().includes(k));

  const sub = filterLog(log, isFollow, 'follow_guru');
  if (sub.trades.length < 2) return null;

  const followTags = Array.from(new Set(sub.trades.map(t => t.tag).filter((t): t is string => !!t))).sort();
  const m = computeMetrics(sub);
  // 與整體裁決相同的樣本量門檻（不放寬）：跟單只有幾筆不該被認證為優勢
  const v = judge(sub, { metrics: m, nBootstrap });

  let message: string;
  if (m.expectancy < 0) {
    message =
      `你「聽老師 / 跟單 / 明牌」的 ${sub.trades.length} 筆交易，每筆平均賠 ${Math.abs(m.expectancy).toFixed(2)}，合計 ${m.totalPnl >= 0 ? '+' : ''}${m.totalPnl.toFixed(2)}。` +
      '這是用你自己的錢算出來的數字 —— 這段紀錄裡，跟單不但沒讓你賺，還在穩定地讓你賠。那些「老師」真正賺的，是你的學費與群費，不是市場。';
  } else {
    message =
      `你「聽老師 / 跟單 / 明牌」的 ${sub.trades.length} 筆交易，期望值為 ${m.expectancy >= 0 ? '+' : ''}${m.expectancy.toFixed(2)}。` +
      '即使帳面為正，也要警覺：這可能只是運氣，而且你看到的「老師神準」往往是倖存者偏差。請持續用統計檢驗，別輕信。';
  }

  return {
    nTrades: sub.trades.length,
    expectancy: m.expectancy,
    totalPnl: m.totalPnl,
    winRate: m.winRate,
    level: v.level,
    followTags,
    message,
  };
}

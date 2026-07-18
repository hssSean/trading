// 移植自 core/verdict/judge.py（決策樹分支順序與條件完全一致）。
// 判斷精神：寧可錯殺（把賭博誤判為賭博），不可放過（把賭博說成優勢）。

import { computeMetrics, PerformanceMetrics } from './metrics';
import { AgTradeLog } from './models';
import { RedFlag, scanRedFlags } from './redflags';
import {
  requiredSampleSize,
  requiredSampleSizeFromPnls,
  SignificanceResult,
  testExpectancyPositive,
} from './significance';

export type VerdictLevel =
  | 'gambling'          // 🟥 這是賭博 — 強烈勸退
  | 'insufficient'      // 🟧 樣本不足
  | 'luck_suspected'    // 🟨 帳面賺錢，但統計上像運氣
  | 'fragile_edge'      // 🟨 有微弱優勢但脆弱
  | 'statistical_edge'; // 🟩 具統計顯著的優勢（仍非保證）

export const LEVEL_DISPLAY: Record<VerdictLevel, string> = {
  gambling: '賭博',
  insufficient: '樣本不足',
  luck_suspected: '疑似運氣',
  fragile_edge: '脆弱優勢',
  statistical_edge: '具統計優勢',
};

export const LEVEL_BADGE: Record<VerdictLevel, string> = {
  gambling: '🟥 賭博',
  insufficient: '🟧 樣本不足',
  luck_suspected: '🟨 疑似運氣',
  fragile_edge: '🟨 脆弱優勢',
  statistical_edge: '🟩 具優勢',
};

export interface Verdict {
  level: VerdictLevel;
  shouldDiscourage: boolean;
  headline: string;
  metrics: PerformanceMetrics;
  significance: SignificanceResult;
  requiredTrades: number;
  redFlags: RedFlag[];
  reasons: string[];
  advice: string[];
}

const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

/** 對一份交易紀錄做出最終裁決 —— 對照 judge()。 */
export function judge(
  log: AgTradeLog,
  opts: { metrics?: PerformanceMetrics; minTrades?: number; nBootstrap?: number } = {},
): Verdict {
  const minTrades = opts.minTrades ?? 30;
  const nBootstrap = opts.nBootstrap ?? 5000;

  const m = opts.metrics ?? computeMetrics(log);
  const pnls = log.trades.map(t => t.pnl);
  const sig = testExpectancyPositive(pnls, { nBootstrap });

  // 所需樣本量：有足夠實際損益時用真實樣本變異，否則退回二項模型
  let req: number | null = null;
  if (pnls.length >= 10) req = requiredSampleSizeFromPnls(pnls);
  if (req === null) req = requiredSampleSize(m.winRate, m.payoffRatio);

  const flags = scanRedFlags(m, sig);
  const reasons: string[] = [];
  const advice: string[] = [];
  const highFlags = flags.filter(f => f.severity === 'high');

  let level: VerdictLevel;
  let discourage: boolean;
  let headline: string;

  // ── 決策樹（由最嚴重往下判斷；順序不可調換）──────────────

  // A. 樣本不足（必須排在負期望之前）
  if (m.totalTrades < minTrades) {
    level = 'insufficient';
    discourage = true;
    if (m.expectancy < 0) {
      headline = `⚠️ 樣本不足（${m.totalTrades} 筆）：目前帳面為負（每筆 ${signed(m.expectancy)}），但樣本太少，還無法斷定是方法錯還是運氣差。`;
      reasons.push(`目前只有 ${m.totalTrades} 筆交易，帳面期望值為負。但在這個樣本量下，負期望同樣可能只是隨機的壞運，尚不足以定論。`);
    } else {
      headline = `⚠️ 樣本不足（${m.totalTrades} 筆，建議至少 ${Math.max(minTrades, req)} 筆）：現在還無法區分你是有本事，還是運氣好。`;
      reasons.push(`目前只有 ${m.totalTrades} 筆交易。在這個樣本量下，再漂亮的勝率與獲利，都可能只是隨機波動。`);
    }
    advice.push(
      `在用小額（可承受全損的金額）累積到約 ${Math.max(minTrades, req)} 筆交易前，不要加大部位。`,
      '把每一筆交易的「進場理由」記錄下來（用 tag 欄位），日後才能驗證是哪套邏輯有效。',
    );

  // B. 樣本足夠 + 負期望值 → 判定賭博，無條件勸退
  } else if (m.expectancy < 0) {
    level = 'gambling';
    discourage = true;
    headline = '⛔ 這是賭博：你的策略樣本期望值為負 —— 方法不變，長期繼續的統計預期就是虧損。';
    reasons.push(`在 ${m.totalTrades} 筆（已達判定門檻）交易下，每筆平均損益為 ${signed(m.expectancy)}（已含成本）。正期望值是任何可持續策略的最低門檻，而你目前是負的。`);
    if (sig.ciHigh > 0) {
      reasons.push(`註：平均損益的 95% 信賴區間為 [${sig.ciLow.toFixed(2)}, ${sig.ciHigh.toFixed(2)}]，上界仍在 0 以上 —— 負期望的估計也有不確定性。勸退依據的是保守原則（期望值為負就先停手），不是「統計上已證明你必輸」。`);
      advice.push(
        '立刻停止用真金白銀執行這套方法 —— 在證據釐清之前，先停手是唯一穩妥的選擇。',
        '目前的證據不足以把過去的獲利歸因於「可重複的優勢」；先別把它當本事。',
        '回到紙上模擬，先找到「期望值為正」的進出場規則，再談下一步。',
      );
    } else {
      advice.push(
        '立刻停止用真金白銀執行這套方法 — 它不是「還沒成功」，而是「方向錯誤」。',
        '帳面曾經賺錢的部分，統計上更像運氣而非本事；運氣會均值回歸。',
        '回到紙上模擬，先找到「期望值為正」的進出場規則，再談下一步。',
      );
    }

  // C. 樣本夠，但統計檢定過不了 → 帳面賺錢疑似運氣
  } else if (!sig.isSignificant) {
    level = 'luck_suspected';
    discourage = true;
    if (m.expectancy > 0) {
      headline = '🎲 高度存疑：你帳面上賺錢，但統計檢定無法排除「這只是運氣」的可能。';
    } else {
      headline = '🎲 沒有優勢跡象：你目前恰好打平（期望值 0），統計上更無法主張存在正優勢 —— 扣掉沒算到的成本，很可能其實是負。';
    }
    reasons.push(`平均每筆損益的 bootstrap p 值為 ${sig.pValueBootstrap.toFixed(3)}（t 檢定 p=${sig.pValueT.toFixed(3)}），未達顯著（需 < 0.05）。`);
    if (sig.ciLow <= 0 && 0 <= sig.ciHigh) {
      reasons.push(`平均損益的 95% 信賴區間為 [${sig.ciLow.toFixed(2)}, ${sig.ciHigh.toFixed(2)}] — 區間涵蓋 0，代表真實期望值有可能根本不為正。`);
    } else {
      reasons.push(`平均損益的 95% 信賴區間為 [${sig.ciLow.toFixed(2)}, ${sig.ciHigh.toFixed(2)}]。區間雖未涵蓋 0，但裁決以 bootstrap 單尾 p 值（未達顯著）從嚴認定 —— 兩種統計口徑不一致時，本工具一律取保守的一邊。`);
    }
    advice.push(
      m.expectancy > 0
        ? '別把這段獲利當成「驗證成功」。在統計上，它和「運氣好」無法區分。'
        : '連帳面獲利都還沒有 —— 別把「沒賠」誤讀成「安全」。',
      '繼續累積樣本，並嚴格執行同一套規則，看顯著性是否隨樣本增加而成立。',
      '倖存者偏差提醒：你只看到自己這次賺了，沒看到無數用同樣方法賠光退場的人。',
    );

  // D. 統計顯著，但有高風險警訊或安全邊際過薄 → 脆弱優勢
  } else if (highFlags.length > 0 || flags.some(f => f.code === 'thin_edge_margin')) {
    level = 'fragile_edge';
    discourage = true;
    headline = '🟡 優勢脆弱：統計上看似有效，但存在嚴重結構性風險，隨時可能崩潰。';
    reasons.push('平均期望值通過了統計顯著性檢定，代表可能存在真實優勢。');
    reasons.push('但偵測到高嚴重度警訊或安全邊際過薄（見下方），這類結構往往「贏到一半才爆」。');
    advice.push(
      '先解決上述結構性警訊（高嚴重度警訊或過薄的安全邊際），再考慮放大部位。',
      '做樣本外回測（本頁下方的樣本外驗證區）驗證優勢是否延續到沒看過的資料。',
    );

  // E. 統計顯著且無高風險警訊 → 具統計優勢（但仍非保證）
  } else {
    level = 'statistical_edge';
    discourage = false;
    headline = '✅ 具統計優勢：在現有樣本下，你的正期望值通過了顯著性檢定。';
    reasons.push(`平均每筆損益 ${signed(sig.mean)}，bootstrap p=${sig.pValueBootstrap.toFixed(3)}、t 檢定 p=${sig.pValueT.toFixed(3)}，雙雙顯著。`);
    if (sig.ciLow > 0) {
      reasons.push(`信賴區間 [${sig.ciLow.toFixed(2)}, ${sig.ciHigh.toFixed(2)}] 完全落在 0 以上。`);
    } else {
      reasons.push(`但 95% 信賴區間 [${sig.ciLow.toFixed(2)}, ${sig.ciHigh.toFixed(2)}] 的下界仍略低於 0（p 值接近顯著門檻）—— 證據屬「邊際等級」，需再累積樣本鞏固。`);
    }
    advice.push(
      '這是「目前為止」的證據，不是未來的保證。市場會變，優勢會衰減。',
      '持續監控：若新交易讓顯著性掉回不顯著，代表優勢可能正在消失。',
      '務必做樣本外回測，把規則固化下來避免情緒干擾。',
    );
  }

  if (level === 'statistical_edge' && flags.length > 0) {
    advice.push('注意：雖判定為具優勢，仍有以下警訊值得改善 — 見賭博警訊清單。');
  }

  return {
    level,
    shouldDiscourage: discourage,
    headline,
    metrics: m,
    significance: sig,
    requiredTrades: Math.max(minTrades, req),
    redFlags: flags,
    reasons,
    advice,
  };
}

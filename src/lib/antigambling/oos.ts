// 移植自 core/backtest/validate.py（逐函式對照）。
// 樣本外驗證：把紀錄依時間切前後兩段，看前段優勢在後段是否維持。
// 這是「單一時序 holdout」，不是滾動式 walk-forward（小樣本下多折會製造假陰性）。

import { computeMetrics } from './metrics';
import { AgTradeLog, sortedByTime } from './models';
import { SignificanceResult, testExpectancyPositive } from './significance';

export interface SegmentResult {
  label: string;
  nTrades: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  totalPnl: number;
  significance: SignificanceResult;
}

export interface OutOfSampleReport {
  inSample: SegmentResult;
  outSample: SegmentResult;
  edgePersisted: boolean;
  degradation: number;   // 期望值衰減比例（正=變差）
  headline: string;
  interpretation: string[];
}

function summarize(log: AgTradeLog, label: string, nBootstrap: number): SegmentResult {
  const m = computeMetrics(log);
  const pnls = log.trades.map(t => t.pnl);
  const sig = testExpectancyPositive(pnls, { nBootstrap });
  return {
    label,
    nTrades: m.totalTrades,
    winRate: m.winRate,
    expectancy: m.expectancy,
    profitFactor: m.profitFactor,
    totalPnl: m.totalPnl,
    significance: sig,
  };
}

function degrWord(degradation: number): string {
  if (degradation < 0) return `不減反增 ${Math.round(Math.abs(degradation) * 100)}%`;
  return `衰減 ${Math.round(degradation * 100)}%`;
}

/** 單一切點的樣本內/外驗證 —— 對照 holdout_validate。 */
export function holdoutValidate(
  log: AgTradeLog,
  opts: { splitRatio?: number; nBootstrap?: number } = {},
): OutOfSampleReport {
  const splitRatio = opts.splitRatio ?? 0.7;
  const nBootstrap = opts.nBootstrap ?? 3000;

  const ordered = sortedByTime(log).trades;
  const n = ordered.length;
  const interp: string[] = [];

  if (n < 20) {
    const emptySig: SignificanceResult = {
      n: 0, mean: 0, std: 0, tStat: 0, pValueT: 1.0, pValueBootstrap: 1.0,
      ciLow: 0, ciHigh: 0, isSignificant: false,
    };
    const seg: SegmentResult = {
      label: '樣本不足', nTrades: n, winRate: 0, expectancy: 0,
      profitFactor: 0, totalPnl: 0, significance: emptySig,
    };
    return {
      inSample: seg,
      outSample: seg,
      edgePersisted: false,
      degradation: 1.0,
      headline: '⚠️ 交易筆數太少（< 20），無法做有意義的樣本外驗證。',
      interpretation: [
        '切成樣本內/外後每段都太小，任何結論都不可靠。',
        '請先累積更多交易紀錄，再回來做這項驗證。',
      ],
    };
  }

  let split = Math.max(10, Math.trunc(n * splitRatio));
  split = Math.min(split, n - 10); // 兩段各至少 10 筆

  const inLog: AgTradeLog = { trades: ordered.slice(0, split), source: log.source, accountLabel: log.accountLabel + '::in' };
  const outLog: AgTradeLog = { trades: ordered.slice(split), source: log.source, accountLabel: log.accountLabel + '::out' };

  const inSeg = summarize(inLog, '樣本內(前段)', nBootstrap);
  const outSeg = summarize(outLog, '樣本外(後段)', nBootstrap);

  let degradation = 1.0;
  if (inSeg.expectancy !== 0) {
    degradation = (inSeg.expectancy - outSeg.expectancy) / Math.abs(inSeg.expectancy);
  }

  // 優勢延續：樣本外期望值仍為正、衰退不過大，且樣本外本身統計顯著
  const edgePersisted =
    outSeg.expectancy > 0 &&
    degradation < 0.5 &&
    outSeg.significance.isSignificant;

  let headline: string;
  if (inSeg.expectancy <= 0) {
    headline = '🎲 連樣本內都沒有正期望值 —— 這份紀錄看不出任何可延續的優勢。';
    interp.push(
      '前段本身就不賺錢，談不上「優勢延續」的問題。',
      '目前的證據比較支持「這是賭博/虧損策略」而非「有方法」。',
    );
  } else if (edgePersisted) {
    headline = '✅ 優勢延續：樣本內展現的正期望值，在樣本外仍然存在且統計顯著。';
    interp.push(
      `樣本內期望值 ${inSeg.expectancy >= 0 ? '+' : ''}${inSeg.expectancy.toFixed(2)} → 樣本外 ${outSeg.expectancy >= 0 ? '+' : ''}${outSeg.expectancy.toFixed(2)}（${degrWord(degradation)}），仍維持正值且通過顯著性檢定。`,
      '這是相對強的證據：優勢不只是貼合舊資料，在沒看過的後段也成立。',
      '但仍非保證 —— 市場結構改變時，優勢可能在未來才衰減。',
    );
  } else if (outSeg.expectancy > 0 && !outSeg.significance.isSignificant) {
    headline = '⚠️ 樣本外不顯著：後段帳面雖為正，但統計上無法排除只是運氣。';
    interp.push(
      `樣本內期望值 ${inSeg.expectancy >= 0 ? '+' : ''}${inSeg.expectancy.toFixed(2)} → 樣本外 ${outSeg.expectancy >= 0 ? '+' : ''}${outSeg.expectancy.toFixed(2)}，但樣本外只有 ${outSeg.nTrades} 筆，p 值未達顯著。`,
      '後段樣本太少，正期望可能純屬巧合，不足以證明優勢延續到未來。',
    );
  } else {
    headline = '⚠️ 優勢消失：樣本內看似有效，但在樣本外大幅衰退或翻負。';
    interp.push(
      `樣本內期望值 ${inSeg.expectancy >= 0 ? '+' : ''}${inSeg.expectancy.toFixed(2)} → 樣本外 ${outSeg.expectancy >= 0 ? '+' : ''}${outSeg.expectancy.toFixed(2)}（${degrWord(degradation)}）。`,
      '這是過度配適 / 倖存者偏差的典型徵兆：策略只是「記住了」舊行情，',
      '面對新資料就失靈。把這種策略自動化，等於把運氣當實力下注。',
    );
  }

  interp.push(
    '前提提醒：此驗證假設你的規則沒有「看著後段資料」調整過。若你是看完整段歷史才定規則，後段對你並不是真正沒看過的資料，這裡的結論會偏樂觀。',
  );

  return { inSample: inSeg, outSample: outSeg, edgePersisted, degradation, headline, interpretation: interp };
}

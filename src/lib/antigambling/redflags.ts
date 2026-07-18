// 移植自 core/verdict/judge.py 的 _scan_red_flags（門檻與訊息逐條相同）。
// 賭博特徵掃描：每個警訊附一句白話說明。

import { fmtRatio, PerformanceMetrics } from './metrics';
import { SignificanceResult } from './significance';

export type RedFlagSeverity = 'high' | 'medium' | 'low';

export interface RedFlag {
  code: string;
  severity: RedFlagSeverity;
  message: string;
}

const pct0 = (x: number) => `${Math.round(x * 100)}%`;

export function scanRedFlags(m: PerformanceMetrics, sig: SignificanceResult): RedFlag[] {
  const flags: RedFlag[] = [];

  // 1. 負期望值：長期統計預期為虧損，卻可能短期帳面為正（典型賭博）
  if (m.expectancy < 0) {
    flags.push({
      code: 'negative_expectancy', severity: 'high',
      message: `每筆交易的樣本期望值為負（${m.expectancy.toFixed(2)}）。方法不變的話，長期繼續的統計預期就是虧損。`,
    });
  }

  // 2. 獲利集中於少數暴賺：像中樂透，不是穩定優勢
  if (m.topTradePnlShare > 0.5 && m.wins >= 1) {
    flags.push({
      code: 'concentrated_profit', severity: 'high',
      message: `光是最賺的一筆，就佔了總獲利的 ${pct0(m.topTradePnlShare)}。你的「獲利」高度依賴單次幸運，而非可重複的方法。`,
    });
  }

  // 3. 高勝率 + 極差盈虧比：典型「賺小賠大」
  if (m.winRate > 0.7 && m.payoffRatio < 0.4 && m.losses > 0) {
    flags.push({
      code: 'win_small_lose_big', severity: 'high',
      message: `勝率高達 ${pct0(m.winRate)}，但盈虧比只有 ${m.payoffRatio.toFixed(2)}。這是「常贏小錢、偶爾賠大錢」的危險結構，一次大虧就會回吐所有獲利。`,
    });
  }

  // 3b. 安全邊際過薄：期望值雖為正，但盈虧比只比打平門檻高一點點
  if (m.expectancy > 0 && m.winRate > 0.5 && m.losses > 0) {
    const breakevenPayoff = (1 - m.winRate) / m.winRate;
    const edgeMargin = m.payoffRatio - breakevenPayoff;
    if (edgeMargin > 0 && edgeMargin < 0.25 * Math.max(breakevenPayoff, 1e-9)) {
      flags.push({
        code: 'thin_edge_margin', severity: 'medium',
        message: `你的盈虧比 ${fmtRatio(m.payoffRatio)} 只比打平門檻 ${breakevenPayoff.toFixed(2)} 高一點點（安全邊際 ${edgeMargin.toFixed(2)}）。以你 ${pct0(m.winRate)} 的勝率，只要勝率稍微下滑，期望值就會由正翻負；而且平均要贏好幾次，才補得回一次大虧。這種優勢很脆弱。`,
      });
    }
  }

  // 4. 極端回撤：只有回撤 % 可靠（有資本基準）時才發
  if (m.drawdownPctReliable && m.maxDrawdownPct > 0.5) {
    flags.push({
      code: 'severe_drawdown', severity: 'high',
      message: `最大回撤達 ${pct0(m.maxDrawdownPct)}。這代表過程中你的帳戶曾腰斬以上 — 多數人撐不過這種壓力。`,
    });
  }

  // 5. 連續虧損過長
  if (m.maxConsecutiveLosses >= 8) {
    flags.push({
      code: 'long_losing_streak', severity: 'medium',
      message: `曾連續虧損 ${m.maxConsecutiveLosses} 次。請誠實問自己：連賠這麼多次，你還守得住原本的紀律嗎？`,
    });
  }

  // 6. 全為當沖/極短線 + 統計不顯著：最接近賭場的交易型態
  if (m.isMostlyIntraday && !sig.isSignificant) {
    flags.push({
      code: 'intraday_noise', severity: 'medium',
      message: '你的交易以當沖/極短線為主，且統計上看不出穩定優勢。高頻短線的成本與雜訊極高，長期勝出者鳳毛麟角。',
    });
  }

  // 7. 獲利因子過低：總獲利幾乎等於總虧損
  if (m.profitFactor > 0 && m.profitFactor < 1.1 && m.totalTrades >= 20) {
    flags.push({
      code: 'thin_profit_factor', severity: 'low',
      message: `獲利因子僅 ${m.profitFactor.toFixed(2)}（總獲利 ÷ 總虧損）。幾乎是在原地打轉，扣掉沒算到的成本後很可能其實在虧。`,
    });
  }

  return flags;
}

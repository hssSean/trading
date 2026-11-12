// 文件 §9 預期績效（回測，含成本）——帳本頁拿來當監控基準。數字照抄 docs/strategy-deploy-2026-10-06.md。
import type { AcctKey } from './engine';

export interface Benchmark {
  perMonth: string;      // 每月筆數（2020–22 / 2023+）
  winRate: string;       // 整筆勝率
  perTradeR: string;     // 每筆 R
  maxDd: string;         // 最大回撤
  maxLossStreak: string; // 最長連虧
  oneYear: string;       // 100 USDT 一年後中位數（最差 10%）
}

export const BENCHMARKS: Record<AcctKey, Benchmark> = {
  s3a: { perMonth: '1.0 / 1.9', winRate: '61% / 60%', perTradeR: '+0.95 / +0.70R', maxDd: '−27%', maxLossStreak: '4 筆', oneYear: '156（90）' },
  s3b: { perMonth: '1.0 / 2.1', winRate: '44% / 41%', perTradeR: '+1.95 / +2.31R', maxDd: '−29%', maxLossStreak: '13 筆', oneYear: '271（92）' },
  // 研究端 bear_rally_check.py：單筆 +0.058 / +0.021R、勝率 72%；上限 20 回撤 −36%。每月筆數是全期 2539 筆 ÷ 78 個月
  br:  { perMonth: '約 33（空頭期才有）', winRate: '72%', perTradeR: '+0.06 / +0.02R', maxDd: '−36%', maxLossStreak: '—', oneYear: '—' },
  s1:  { perMonth: '18 / 29',   winRate: '59% / 59%', perTradeR: '+0.35 / +0.14R', maxDd: '−53%', maxLossStreak: '—',    oneYear: '139（60）' },
};

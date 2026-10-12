// S3 分數影子追蹤（2026-10-12）。
//
// S3 的分數門檻（只做 2 分）是看過 2020–22 資料後挑的，研究端原文：「分數被擋掉的 S3 訊號
// 一定要記錄，這是唯一能用新資料驗證它有沒有用的方法」。帳本只記「被擋了」，不知道它後來
// 會怎樣，所以這裡把每個「通過所有濾網、算到分數」的候選都用同一套 S3 出場規則模擬到出場，
// 2 分的也收（對照組），而且不受帳本持倉上限影響——比的是「分數有沒有資訊」，不是帳本績效。
//
// 存在 Redis hash `s3s1:s3x`（field = symbol:signalT）。每天 S3 帳本工作跑完後更新一次。

import type { SignalLog } from './engine';

const DAY = 86_400_000;

export interface ShadowTrade {
  id: string; symbol: string; signalT: number; entryT: number; stop: number;
  score: number; scoreParts?: number[];
  status: 'open' | 'done';
  entry?: number; exitT?: number; exitReason?: string; netR?: number;
}

/** 從帳本訊號紀錄挑出還沒在追的影子單。只用 s3a 的紀錄（s3b 是同一批候選）。 */
export function pickShadows(logs: SignalLog[], known: Set<string>): ShadowTrade[] {
  const out: ShadowTrade[] = [];
  const seen = new Set(known);
  for (const l of logs) {
    if (l.acct !== 's3a' || l.score == null || l.entry == null || !Number.isFinite(l.stop)) continue;
    const id = `${l.symbol}:${l.signalT}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, symbol: l.symbol, signalT: l.signalT, entryT: l.signalT + DAY, stop: l.stop,
      score: l.score, scoreParts: l.scoreParts, status: 'open' });
  }
  return out;
}

export interface ShadowGroup { n: number; avgR: number | null; winRate: number | null }

export function summarizeShadow(trades: ShadowTrade[]): { score2: ShadowGroup; blocked: ShadowGroup; open: number } {
  const done = trades.filter(t => t.status === 'done' && Number.isFinite(t.netR));
  const g = (xs: ShadowTrade[]): ShadowGroup => xs.length
    ? { n: xs.length, avgR: xs.reduce((a, t) => a + t.netR!, 0) / xs.length, winRate: xs.filter(t => t.netR! > 0).length / xs.length }
    : { n: 0, avgR: null, winRate: null };
  return { score2: g(done.filter(t => t.score === 2)), blocked: g(done.filter(t => t.score !== 2)), open: trades.filter(t => t.status === 'open').length };
}

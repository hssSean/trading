// App 畫面用的 S3 計算（首頁、紀錄頁）。純函數，有單元測試（tests/s3View.test.ts）。
const DAY = 86_400_000;
const DECISION_OFFSET_MS = 30_000; // live-runner 在 UTC 00:00:30 之後做每日決策（s3aLive.ts）

/** live-runner 每 60 秒寫一次心跳；超過兩倍就當作沒在跑 */
export const HEARTBEAT_STALE_MS = 120_000;

/** 下一次 S3 每日決策的時間（UTC 00:00:30） */
export function nextDecisionAt(now: number): number {
  const today = Math.floor(now / DAY) * DAY + DECISION_OFFSET_MS;
  return now < today ? today : today + DAY;
}

/** 文件 §8 停用條件的進度；回撤口徑與 stats.summarizeLive 相同 */
export function haltProgress(meta: Record<string, unknown>) {
  const base = Number(meta.baseEquity ?? 0);
  const realized = Number(meta.realized ?? 0);
  const peak = Number(meta.peakRealized ?? 0);
  return {
    ddPct: base > 0 ? (peak - realized) / (base + peak) * 100 : 0,
    ddLimit: 35 as const,
    streak: Number(meta.lossStreak ?? 0),
    streakLimit: 7 as const,
    halted: meta.halted ? String(meta.halted) : null,
  };
}

/**
 * 持倉的浮動 R（以初始風險 entry − stop0 為 1R）。
 * 已平 1/3 時：平掉那部分按 +1R 計（止盈價就是 entry + 1R），剩餘部分按現價計，依數量加權。
 */
export function unrealizedR(p: { entry: number; stop0: number; qty0: number; partial: boolean; tpQty: number }, price: number): number | null {
  const risk = p.entry - p.stop0;
  if (!(price > 0) || !(risk > 0)) return null;
  const r = (price - p.entry) / risk;
  if (!p.partial || !(p.qty0 > 0)) return r;
  const done = p.tpQty / p.qty0;
  return done * 1 + (1 - done) * r;
}

export interface TodaySummary {
  X: number; ready: boolean; btcOk: boolean | null; breadth: number | null;
  candidates: number; opened: string[]; blocked: { symbol: string; reason: string }[];
}

/** 今天（決策日 X，訊號日 D = X − 1）的市場條件與真倉決策 */
export function todaySummary(
  snap: { X: number; breadth: number; btcOk: Record<string, boolean>; s3: { symbol: string }[] } | null,
  signals: { symbol: string; signalDay: number; decision: 'open' | 'skip'; reason?: string }[],
  now: number,
): TodaySummary {
  const X = Math.floor(now / DAY) * DAY;
  const D = X - DAY;
  const mine = signals.filter(s => s.signalDay === D);
  return {
    X,
    ready: !!snap && snap.X === X,
    btcOk: snap && snap.X === X ? !!snap.btcOk[String(D)] : null,
    breadth: snap && snap.X === X ? snap.breadth : null,
    candidates: snap && snap.X === X ? snap.s3.length : 0,
    opened: mine.filter(s => s.decision === 'open').map(s => s.symbol),
    blocked: mine.filter(s => s.decision === 'skip').map(s => ({ symbol: s.symbol, reason: s.reason ?? '' })),
  };
}

// S3 每日前向對帳的告警判斷。
//
// 研究端 `C:\trading_stratage\s3_xcheck.py` 用研究端自己的函數重算最近 7 天的 S3（廣度、BTC 條件、
// 幣池、突破候選、分數），跟線上 s3s1:prep:<X>／s3s1:signals 比對，結果寫進 Redis hash
// `s3s1:xcheck`（field = 決策日 X 毫秒字串）。它跑在使用者電腦的工作排程器上，所以會停——
// 停了也要知道，否則又是一次「靜默停擺」。
//
// 2026-10-12 建立。route.ts 每天約 UTC 02:00 呼叫一次。

export const XCHECK_STALE_MS = 3 * 86_400_000;

export interface XcheckResult {
  X: number; day: string; ok: boolean; diffs: string[]; checkedAt: number;
}

export function decideXcheckAlert(
  hash: Record<string, unknown>,
  notified: string[],
  now: number,
): { bad: XcheckResult[]; stale: boolean } {
  const rows: XcheckResult[] = [];
  for (const v of Object.values(hash)) {
    try {
      // Upstash 會自動把 JSON 字串解析成物件，兩種都要吃
      const o = (typeof v === 'string' ? JSON.parse(v) : v) as XcheckResult;
      if (o && typeof o.X === 'number' && typeof o.checkedAt === 'number') rows.push(o);
    } catch { /* 壞資料略過 */ }
  }
  if (!rows.length) return { bad: [], stale: false };
  const seen = new Set(notified);
  const bad = rows.filter(r => !r.ok && !seen.has(String(r.X))).sort((a, b) => a.X - b.X);
  const last = Math.max(...rows.map(r => r.checkedAt));
  return { bad, stale: now - last > XCHECK_STALE_MS };
}

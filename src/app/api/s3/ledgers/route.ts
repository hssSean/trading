// 帳本頁用：S3-A／S3-B／S1／BR 模擬帳本（/api/analyze 寫的 s3s1:*）的摘要、持倉、近期交易、訊號與擋單統計，
// 加上 CTREND 前向週帳本（EC2 寫的 ctrend:*）。唯讀。
import { NextRequest, NextResponse } from 'next/server';
import { checkUserSession, getRedisOrNull, parseJson } from '@/lib/apiAuth';
import { ACCTS, type AcctKey, type AcctState, type Position, type SignalLog } from '@/lib/s3s1/engine';
import { summarizeAcct, reasonKey } from '@/lib/s3s1/stats';
import { ctrendSummary, type CtrendMeta, type CtrendOpen, type CtrendWeek } from '@/lib/ctrend/view';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;
const RECENT = 30;
const SIGNALS = 300;

export async function GET(req: NextRequest) {
  if (!(await checkUserSession(req))) return NextResponse.json({ ok: false, reason: '尚未登入' }, { status: 401 });
  const r = getRedisOrNull();
  if (!r) return NextResponse.json({ ok: false, reason: 'Redis 未設定' }, { status: 500 });
  const keys = Object.keys(ACCTS) as AcctKey[];
  try {
    const [meta, sigRaw, ctMeta, ctWeeks, ctOpen, ...acctRaw] = await Promise.all([
      r.hgetall<Record<string, unknown>>('s3s1:meta'),
      r.lrange('s3s1:signals', 0, SIGNALS - 1),
      r.get('ctrend:meta'),
      r.hgetall<Record<string, unknown>>('ctrend:weeks'),
      r.get('ctrend:open'),
      ...keys.flatMap(k => [r.hgetall<Record<string, unknown>>(`s3s1:${k}:open`), r.hgetall<Record<string, unknown>>(`s3s1:${k}:done`)]),
    ]);
    const m = (meta ?? {}) as Record<string, unknown>;
    const signals = ((sigRaw ?? []) as unknown[]).map(x => parseJson<SignalLog>(x));
    const accounts = keys.map((k, i) => {
      const raw = acctRaw as (Record<string, unknown> | null)[];
      const positions = [...Object.values(raw[2 * i] ?? {}), ...Object.values(raw[2 * i + 1] ?? {})].map(x => parseJson<Position>(x));
      const state = m[`acct.${k}`] ? parseJson<AcctState>(m[`acct.${k}`]) : null;
      const blocked: Record<string, number> = {};
      for (const s of signals) if (s.acct === k && s.decision === 'skip') { const key = reasonKey(s.reason); blocked[key] = (blocked[key] ?? 0) + 1; }
      return {
        summary: summarizeAcct(k, state, positions),
        open: positions.filter(p => p.status === 'open').sort((a, b) => b.entryT - a.entryT),
        recent: positions.filter(p => p.status === 'done').sort((a, b) => (b.exitT ?? 0) - (a.exitT ?? 0)).slice(0, RECENT),
        blocked,
      };
    });
    return NextResponse.json({
      ok: true,
      trackStart: { s3: Number(m['trackStart.s3']) || null, s1: Number(m['trackStart.s1']) || null },
      lastRun: { s3: Number(m['s3.lastRunDay']) || null, s1: Number(m['s1.lastRunT']) || null },
      accounts,
      ctrend: ctMeta == null && !ctWeeks ? null : ctrendSummary(
        ctMeta == null ? null : parseJson<CtrendMeta>(ctMeta),
        Object.values(ctWeeks ?? {}).map(x => parseJson<CtrendWeek>(x)),
        ctOpen == null ? null : parseJson<CtrendOpen>(ctOpen),
        Date.now(),
      ),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: `讀取 Redis 失敗：${String(e).slice(0, 120)}` }, { status: 500 });
  }
}

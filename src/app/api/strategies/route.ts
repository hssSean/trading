// 策略帳戶（2026-10-07 部署，docs/strategy-deploy-2026-10-06.md）——給 App 的 /strategies 頁面用，唯讀。
//   - S3-A／S3-B／S1 三個模擬帳本：/api/analyze 寫的 s3s1:*（src/lib/s3s1/engine.ts）
//   - S3-A testnet 真倉：live-runner 寫的 s3a-live:*（src/engine/s3aLive.ts）
// 驗證：已登入的 App 使用者（帶 Supabase JWT），跟 /api/reject-funnel 同一種模式；資料是全站共用的
// 策略紀錄，不含個資。
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { ACCTS, type AcctKey, type AcctState, type Position, type SignalLog } from '@/lib/s3s1/engine';
import { summarizeAcct, summarizeLive, reasonKey, type LiveDone } from '@/lib/s3s1/stats';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

async function checkUserSession(req: NextRequest): Promise<boolean> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !key) return false;
  const c = createClient(url, key, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error } = await c.auth.getUser();
  return !error && !!user;
}

const parse = <T,>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const RECENT = 30;
const SIGNALS = 300;

export async function GET(req: NextRequest) {
  if (!(await checkUserSession(req))) return NextResponse.json({ ok: false, reason: '尚未登入' }, { status: 401 });
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return NextResponse.json({ ok: false, reason: 'Redis 未設定' }, { status: 500 });
  const r = new Redis({ url, token });

  const keys = Object.keys(ACCTS) as AcctKey[];
  const [meta, sigRaw, liveMeta, livePos, liveDone, ...acctRaw] = await Promise.all([
    r.hgetall<Record<string, unknown>>('s3s1:meta'),
    r.lrange('s3s1:signals', 0, SIGNALS - 1),
    r.hgetall<Record<string, unknown>>('s3a-live:meta'),
    r.hgetall<Record<string, unknown>>('s3a-live:pos'),
    r.hgetall<Record<string, unknown>>('s3a-live:done'),
    ...keys.flatMap(k => [r.hgetall<Record<string, unknown>>(`s3s1:${k}:open`), r.hgetall<Record<string, unknown>>(`s3s1:${k}:done`)]),
  ]);
  const m = (meta ?? {}) as Record<string, unknown>;
  const signals = (sigRaw ?? []).map(x => parse<SignalLog>(x));

  const accounts = keys.map((k, i) => {
    const positions = [...Object.values(acctRaw[2 * i] ?? {}), ...Object.values(acctRaw[2 * i + 1] ?? {})].map(x => parse<Position>(x));
    const state = m[`acct.${k}`] ? parse<AcctState>(m[`acct.${k}`]) : null;
    const mine = signals.filter(s => s.acct === k);
    const blocked: Record<string, number> = {};
    for (const s of mine) if (s.decision === 'skip') { const key = reasonKey(s.reason); blocked[key] = (blocked[key] ?? 0) + 1; }
    return {
      summary: summarizeAcct(k, state, positions),
      open: positions.filter(p => p.status === 'open').sort((a, b) => b.entryT - a.entryT),
      recent: positions.filter(p => p.status === 'done').sort((a, b) => (b.exitT ?? 0) - (a.exitT ?? 0)).slice(0, RECENT),
      signals: mine.slice(0, RECENT),
      blocked,
    };
  });

  const lm = (liveMeta ?? {}) as Record<string, unknown>;
  const closed = Object.values(liveDone ?? {}).map(x => parse<LiveDone>(x)).sort((a, b) => b.exitAt - a.exitAt);
  return NextResponse.json({
    ok: true,
    trackStart: { s3: Number(m['trackStart.s3']) || null, s1: Number(m['trackStart.s1']) || null },
    lastRun: { s3: Number(m['s3.lastRunDay']) || null, s1: Number(m['s1.lastRunT']) || null },
    accounts,
    live: {
      summary: summarizeLive(lm, closed),
      lastDay: Number(lm.lastDay) || null,
      open: Object.values(livePos ?? {}).map(x => parse<Record<string, unknown>>(x)),
      recent: closed.slice(0, RECENT),
    },
  });
}

// 紙上策略（策略 A／影片 A/B/C）的手動觸發。平常由 /api/analyze 在每天 UTC 00:20 之後自動跑，
// 這裡給「想立刻補跑」或排查用：GET /api/paper?job=strategyA|video
// 驗證規則與 /api/analyze 相同（Vercel cron 的 CRON_SECRET，或 x-webhook-secret／?secret=）。
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { runStrategyA, runVideo, dueJob } from '@/lib/paper/runner';
import { binancePaperDeps } from '@/lib/paper/deps';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get('authorization') === `Bearer ${cronSecret}`) return true;
  if (!envSecret) return process.env.VERCEL_ENV !== 'production';
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  return provided === envSecret;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return NextResponse.json({ error: 'Redis 未設定' }, { status: 500 });
  const r = new Redis({ url, token });
  const now = Date.now();
  const asked = req.nextUrl.searchParams.get('job');
  const job = asked === 'strategyA' || asked === 'video' ? asked : dueJob((await r.hgetall<Record<string, unknown>>('paper:meta')) ?? {}, now);
  if (!job) return NextResponse.json({ ok: true, skipped: '今天兩個工作都跑過了（或還沒到 UTC 00:20）' });
  try {
    const s = job === 'strategyA' ? await runStrategyA(r, binancePaperDeps, now) : await runVideo(r, binancePaperDeps, now);
    return NextResponse.json({ ok: true, ...s });
  } catch (e) {
    return NextResponse.json({ ok: false, job, error: String(e).slice(0, 300) }, { status: 500 });
  }
}

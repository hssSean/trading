import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const dynamic = 'force-dynamic';

// Same auth contract as /api/analyze: webhook secret via header or query param.
function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  const provided  = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  if (envSecret && provided !== envSecret) return false;
  return true;
}

interface FunnelEntry {
  at: number;
  symbol: string;
  strategy: string;
  direction: string | null;
  rawScore: number;
  tier: string | null;
  rejectedAt: string | null;
  rejectDetail: string | null;
  filters: Record<string, unknown>;
}

// v2.1 §0: aggregate the reject funnel — which gate kills the most candidates.
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return NextResponse.json({ ok: false, reason: 'redis-not-configured' });
  }

  const days   = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('days') ?? '3', 10) || 3, 1), 14);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;

  try {
    const redis = Redis.fromEnv();
    const raw   = await redis.lrange('reject_funnel', 0, -1);
    const entries: FunnelEntry[] = raw
      .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
      .filter((e): e is FunnelEntry => !!e && typeof e.at === 'number' && e.at >= cutoff);

    const total = entries.length;
    const sent  = entries.filter(e => e.rejectedAt === null).length;

    const reasonCount = new Map<string, number>();
    for (const e of entries) {
      if (e.rejectedAt === null) continue;
      reasonCount.set(e.rejectedAt, (reasonCount.get(e.rejectedAt) ?? 0) + 1);
    }
    const rejected = total - sent;
    const reasons = Array.from(reasonCount.entries())
      .map(([key, count]) => ({
        key, count,
        pctOfRejected: rejected > 0 ? Math.round((count / rejected) * 100) : 0,
        pctOfTotal:    total    > 0 ? Math.round((count / total)    * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const symbolCount = new Map<string, number>();
    for (const e of entries) symbolCount.set(e.symbol, (symbolCount.get(e.symbol) ?? 0) + 1);
    const topSymbols = Array.from(symbolCount.entries())
      .map(([symbol, count]) => ({ symbol, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return NextResponse.json({
      ok: true, days, total, sent, rejected, reasons, topSymbols,
      recent: entries.slice(0, 20),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e).slice(0, 120) });
  }
}

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

interface ShadowEntry {
  symbol: string;
  direction: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  rejectedAt: string;
  status: string;
  result?: string;
  exitPrice?: number;
}

// Per-gate simulated outcome of rejected signals. netR < 0 = the gate saved
// money (killed mostly losers); netR > 0 = it blocked winners → loosen candidate.
interface ShadowStat {
  win: number;
  loss: number;
  other: number;   // EXPIRED / TIMEOUT
  pending: number;
  netR: number;
}

function aggregateShadows(shadows: ShadowEntry[]): Record<string, ShadowStat> {
  const stats: Record<string, ShadowStat> = {};
  for (const st of shadows) {
    const g = (stats[st.rejectedAt] ??= { win: 0, loss: 0, other: 0, pending: 0, netR: 0 });
    if (st.status !== 'done') { g.pending++; continue; }
    const risk = Math.abs(st.entry - st.stopLoss);
    const rOf = (exit: number) =>
      risk > 0 ? (st.direction === 'LONG' ? exit - st.entry : st.entry - exit) / risk : 0;
    if (st.result === 'WIN_TP1' || st.result === 'WIN_TP2') {
      g.win++;
      g.netR += rOf(st.exitPrice ?? st.tp1);
    } else if (st.result === 'LOSS') {
      g.loss++;
      g.netR -= 1;
    } else {
      g.other++;
      if (st.result === 'TIMEOUT' && st.exitPrice) g.netR += rOf(st.exitPrice);
    }
  }
  for (const g of Object.values(stats)) g.netR = parseFloat(g.netR.toFixed(2));
  return stats;
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
    const [raw, rawShadows] = await Promise.all([
      redis.lrange('reject_funnel', 0, -1),
      redis.hgetall<Record<string, unknown>>('shadow_trades'),
    ]);
    const entries: FunnelEntry[] = raw
      .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
      .filter((e): e is FunnelEntry => !!e && typeof e.at === 'number' && e.at >= cutoff);

    const shadows: ShadowEntry[] = Object.values(rawShadows ?? {})
      .map(v => { try { return (typeof v === 'string' ? JSON.parse(v) : v) as ShadowEntry; } catch { return null; } })
      .filter((s): s is ShadowEntry => !!s && !!s.rejectedAt);
    const shadowStats = aggregateShadows(shadows);

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
        ...(shadowStats[key] ? { shadow: shadowStats[key] } : {}),
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
      shadowStats,
      recent: entries.slice(0, 20),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e).slice(0, 120) });
  }
}

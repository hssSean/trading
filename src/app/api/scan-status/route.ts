import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

export const dynamic = 'force-dynamic';

// Same auth contract as /api/analyze: webhook secret via header or query param.
function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  // No secret configured: fail-open only outside production, fail-closed on production
  // (待修改事項.md P2-1).
  if (!envSecret) return process.env.VERCEL_ENV !== 'production';
  const provided = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret');
  return provided === envSecret;
}

export interface ScanStatusCoin {
  symbol: string;
  topScore: number;
  adx4h: number | null;
  regime: string | null;
  agreeTFs: number;
  note: string | null;
}

export interface ScanStatus {
  at: number;
  btcRegime: string;
  circuitBreaker: string | boolean | null;
  // 跨日權益回撤停機（2026-08-04）——舊的 last_scan 快照沒有這個 key，
  // 讀到 undefined 時視同「沒停機」，不會把舊快照誤判成停機中。
  drawdownHalt?: string | boolean | null;
  eventFilter: string | boolean | null;
  totalOpenRisk: number;
  notified: string[];
  coins: ScanStatusCoin[];
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return NextResponse.json({ ok: false, reason: 'redis-not-configured', scan: null });
  }

  try {
    const redis = Redis.fromEnv();
    const scan  = await redis.get<ScanStatus>('last_scan');
    return NextResponse.json({ ok: true, scan: scan ?? null });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e).slice(0, 120), scan: null });
  }
}

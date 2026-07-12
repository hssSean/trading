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

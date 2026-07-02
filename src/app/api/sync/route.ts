import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { TradeRecord, AppSettings } from '@/types';

export const maxDuration = 10;

interface CloudData {
  watchlist:  { symbol: string; timeframes: string[] }[];
  trades:     TradeRecord[];
  settings?:  Partial<AppSettings>;
  lineToken?: string;
  lineUserId?: string;
  savedAt:    number;
}

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = Redis.fromEnv();
    return _redis;
  }
  return null;
}

// GET /api/sync?secret=xxx  — load cloud state
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!secret) return NextResponse.json({ error: 'secret required' }, { status: 400 });

  const r = getRedis();
  if (!r) return NextResponse.json({ ok: false, error: 'Redis not configured' }, { status: 503 });

  try {
    const data = await r.get<CloudData>(`udata:${secret}`);
    return NextResponse.json({ ok: true, data: data ?? null });
  } catch {
    return NextResponse.json({ ok: false, error: 'load failed' }, { status: 500 });
  }
}

// POST /api/sync?secret=xxx  — save cloud state (30-day TTL, refreshed each save)
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!secret) return NextResponse.json({ error: 'secret required' }, { status: 400 });

  const r = getRedis();
  if (!r) return NextResponse.json({ ok: false, error: 'Redis not configured' }, { status: 503 });

  try {
    const body: CloudData = await req.json();
    body.savedAt = Date.now();
    await r.set(`udata:${secret}`, body, { ex: 30 * 24 * 3600 });
    return NextResponse.json({ ok: true, savedAt: body.savedAt });
  } catch {
    return NextResponse.json({ ok: false, error: 'save failed' }, { status: 500 });
  }
}

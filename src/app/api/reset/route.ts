import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  if (!envSecret) return true; // no secret configured
  const h = req.headers.get('x-webhook-secret') ?? '';
  const q = req.nextUrl.searchParams.get('secret') ?? '';
  return h === envSecret || q === envSecret;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Identify user via Supabase JWT
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!sbUrl || !sbKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  const admin = createClient(sbUrl, sbKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify JWT — getUser validates the token against Supabase Auth
  const { data: { user }, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !user) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }
  const userId = user.id;

  // 1. Delete all trades for this user
  const { count: deletedTrades, error: deleteErr } = await admin
    .from('trades')
    .delete({ count: 'exact' })
    .eq('user_id', userId);

  if (deleteErr) {
    console.error(`[reset] trades delete failed for ${userId}:`, deleteErr.message);
    return NextResponse.json({ error: 'Failed to delete trades', detail: deleteErr.message }, { status: 500 });
  }

  // 2. Write reset_at so other devices know to wipe their local cache.
  //    Best-effort — column may not exist until user runs ALTER TABLE.
  const resetAt = Date.now();
  const { error: resetAtErr } = await admin
    .from('profiles')
    .update({ reset_at: resetAt })
    .eq('id', userId);
  if (resetAtErr) {
    console.warn('[reset] reset_at update skipped (column may not exist yet):', resetAtErr.message);
  }

  // 3. Clear all Redis signal/lock keys
  let clearedKeys = 0;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const redis = Redis.fromEnv();
      const tlockKeys = await redis.keys('tlock:*');
      const allKeys   = [...tlockKeys, 'pending_signals', 'monitor-run-lock'];
      if (allKeys.length > 0) {
        await Promise.all(allKeys.map(k => redis.del(k)));
        clearedKeys = allKeys.length;
      }
    } catch (e) {
      console.error('[reset] Redis cleanup failed:', String(e));
    }
  }

  console.log(`[reset] user=${userId} deletedTrades=${deletedTrades ?? 0} clearedRedis=${clearedKeys}`);
  return NextResponse.json({ ok: true, deletedTrades: deletedTrades ?? 0, clearedKeys, resetAt });
}

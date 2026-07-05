import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Temporary diagnostic endpoint — returns trades stats + reset_at to diagnose
// why resets are not sticking. Auth: x-webhook-secret header.
export async function GET(req: NextRequest) {
  const envSecret = process.env.WEBHOOK_SECRET;
  const provided  = req.headers.get('x-webhook-secret') ?? req.nextUrl.searchParams.get('secret') ?? '';
  if (envSecret && provided !== envSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!sbUrl || !sbKey) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const admin = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // All trades: id, user_id, opened_at, result, status
  const { data: trades, error: tErr } = await admin
    .from('trades')
    .select('id, user_id, symbol, opened_at, result, status')
    .order('opened_at', { ascending: false })
    .limit(100);

  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  // Profile reset_at for all affected users
  const userIds = Array.from(new Set((trades ?? []).map((t: Record<string, unknown>) => t.user_id as string)));
  const profileRows: Record<string, unknown>[] = [];
  if (userIds.length > 0) {
    const { data: profs } = await admin
      .from('profiles')
      .select('id, reset_at')
      .in('id', userIds);
    if (profs) profileRows.push(...(profs as Record<string, unknown>[]));
  }

  const now = Date.now();
  const summary = (trades ?? []).map((t: Record<string, unknown>) => ({
    id:        (t.id as string).slice(0, 12),
    symbol:    t.symbol,
    openedAt:  t.opened_at,
    openedAgo: `${Math.round((now - (t.opened_at as number)) / 60000)}m ago`,
    result:    t.result,
    status:    t.status,
    user_id:   (t.user_id as string).slice(0, 8),
  }));

  return NextResponse.json({
    totalTrades: (trades ?? []).length,
    profiles: profileRows.map((p: Record<string, unknown>) => ({
      id:        (p.id as string).slice(0, 8),
      reset_at:  p.reset_at,
      resetAgo:  p.reset_at ? `${Math.round((now - (p.reset_at as number)) / 60000)}m ago` : 'never',
    })),
    trades: summary,
  });
}

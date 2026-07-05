import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendWebPushToUser } from '@/lib/webpush';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!anonUrl || !anonKey) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // ── Diagnostic: direct service-role SELECT — independent of sendWebPushToUser ──
  // Tells us whether the DB rows exist and whether service-role key is working,
  // before we even try to send. diagCount=-1 means service role key is not set.
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const vapidConfigured = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

  let diagCount = -1;
  let diagError: string | null = null;
  if (sbUrl && sbKey) {
    try {
      const admin = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });
      const { count, error: cntErr } = await admin
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);
      diagCount = count ?? 0;
      diagError = cntErr?.message ?? null;
      console.log(`[push-test] diag: userId=${user.id.slice(0, 8)} diagCount=${diagCount} vapid=${vapidConfigured} diagError=${diagError}`);
    } catch (e) {
      diagError = String(e);
      console.error('[push-test] diag SELECT threw:', String(e));
    }
  } else {
    console.error('[push-test] SUPABASE_SERVICE_ROLE_KEY not set — cannot verify subscriptions');
  }

  const results = await sendWebPushToUser(user.id, {
    title: '🔔 測試推播',
    body: '推播通知已成功啟用！信號、成交通知將透過此管道送達。',
    tag: 'push-test',
  });

  const anyOk = results.some(r => r.ok);
  return NextResponse.json({
    ok: anyOk,
    subsCount: results.length,
    vapidConfigured,
    diagCount,
    diagError,
    results: results.map(r => ({
      endpoint: r.endpoint,
      ok: r.ok,
      statusCode: r.statusCode,
      errorBody: r.errorBody,
      errorMessage: r.errorMessage,
    })),
  });
}

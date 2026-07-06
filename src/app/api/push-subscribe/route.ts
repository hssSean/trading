import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Server-side admin client — must use persistSession: false so the client does
// not try to access browser storage (which doesn't exist in Next.js API routes).
// Without this, supabase-js v2 may silently fail to attach the service role JWT,
// causing requests to run as 'anon' and be blocked by RLS.
function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// POST /api/push-subscribe — save a push subscription for the authenticated user
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!anonUrl || !anonKey) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  // Verify JWT and get user identity
  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: 'Missing subscription fields' }, { status: 400 });
  }

  const admin = getAdmin();
  if (!admin) {
    console.error('[push-subscribe] SUPABASE_SERVICE_ROLE_KEY not configured');
    return NextResponse.json({ error: 'Server config error: service role key missing' }, { status: 500 });
  }

  // Enforce one subscription per user: delete ALL existing subs before saving the new one.
  // Without this, repeated enable/disable cycles accumulate rows and sendWebPushToUser
  // sends to every row — multiplying each notification by the accumulated count.
  const { error: cleanupErr } = await admin.from('push_subscriptions').delete().eq('user_id', user.id);
  if (cleanupErr) {
    console.warn(`[push-subscribe] pre-cleanup failed for user=${user.id.slice(0, 8)}: ${cleanupErr.message}`);
    // Non-fatal: proceed; worst case the new subscription is saved alongside old ones.
  }

  // Upsert using service role — bypasses RLS so no policy is needed for server writes.
  const { error: upsertErr } = await admin.from('push_subscriptions').upsert(
    {
      user_id: user.id,
      endpoint,
      p256dh:  keys.p256dh,
      auth:    keys.auth,
    },
    { onConflict: 'endpoint' },
  );

  if (upsertErr) {
    const msg = upsertErr.message;
    const code = upsertErr.code ?? '';
    console.error(`[push-subscribe] upsert error code=${code}: ${msg}`);

    if (code === '42P01') {
      return NextResponse.json(
        { error: 'push_subscriptions table not yet created — run the SQL migration' },
        { status: 503 },
      );
    }
    if (code === '42P10') {
      return NextResponse.json(
        { error: 'push_subscriptions.endpoint is missing a UNIQUE constraint — run the SQL migration' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: `DB error (${code}): ${msg}` }, { status: 500 });
  }

  // Verify the row was actually written — a silent RLS block would return
  // { error: null } from supabase-js but leave count = 0.
  const { count, error: checkErr } = await admin
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('endpoint', endpoint);

  if (checkErr) {
    console.error('[push-subscribe] verify SELECT error:', checkErr.message);
    // Don't fail here — upsert reported success; log and continue.
  } else if ((count ?? 0) === 0) {
    console.error('[push-subscribe] upsert returned no error but row count is 0 — likely RLS block');
    return NextResponse.json(
      { error: 'Subscription was not saved (possible RLS block). Add an authenticated policy to push_subscriptions.' },
      { status: 500 },
    );
  }

  console.log(`[push-subscribe] saved subscription for user=${user.id.slice(0, 8)} endpoint=${endpoint.slice(0, 60)}`);
  return NextResponse.json({ ok: true });
}

// DELETE /api/push-subscribe — remove a push subscription
export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { endpoint } = body;
  if (!endpoint) return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });

  const admin = getAdmin();
  if (!admin) return NextResponse.json({ error: 'Server config error' }, { status: 500 });

  const { error } = await admin
    .from('push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', endpoint);

  if (error && error.code !== '42P01') {
    console.error('[push-subscribe] delete error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

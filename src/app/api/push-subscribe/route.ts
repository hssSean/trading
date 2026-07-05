import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key);
}

// POST /api/push-subscribe — save a push subscription for the authenticated user
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!anonUrl || !anonKey) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  // Verify JWT and get user
  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
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
  if (!admin) return NextResponse.json({ error: 'Server config error' }, { status: 500 });

  // Upsert by endpoint (unique constraint)
  const { error } = await admin.from('push_subscriptions').upsert(
    {
      user_id:  user.id,
      endpoint,
      p256dh:   keys.p256dh,
      auth:     keys.auth,
    },
    { onConflict: 'endpoint' },
  );

  if (error) {
    // Table does not exist yet — return a clear message but don't crash
    if (error.code === '42P01') {
      return NextResponse.json({ error: 'push_subscriptions table not yet created — run the SQL migration' }, { status: 503 });
    }
    console.error('[push-subscribe] upsert error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/push-subscribe — remove a push subscription
export async function DELETE(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const userClient = createClient(anonUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

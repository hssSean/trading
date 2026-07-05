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
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await sendWebPushToUser(user.id, {
    title: '🔔 測試推播',
    body: '推播通知已成功啟用！信號、成交通知將透過此管道送達。',
    tag: 'push-test',
  });

  return NextResponse.json({ ok: true });
}

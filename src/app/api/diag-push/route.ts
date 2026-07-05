import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

// Temporary diagnostic endpoint — sends a real Web Push to every subscription
// for a hardcoded user_id and returns the full Apple APNs response per sub.
// Auth: x-webhook-secret header OR ?secret= query param.
// DELETE this file once the push pipeline is confirmed working end-to-end.

const TARGET_USER_ID = 'ab52926d-f1d4-4573-b6c3-523a92ea12bd';

function checkAuth(req: NextRequest): boolean {
  const envSecret = process.env.WEBHOOK_SECRET;
  if (!envSecret) return true;
  const h = req.headers.get('x-webhook-secret') ?? '';
  const q = req.nextUrl.searchParams.get('secret') ?? '';
  return h === envSecret || q === envSecret;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized — add ?secret=YOUR_WEBHOOK_SECRET to the URL' }, { status: 401 });
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const vapidPublic  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY            ?? '';
  const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:a0966211623@gmail.com';

  const envCheck = {
    SUPABASE_URL:        !!sbUrl,
    SERVICE_ROLE_KEY:    !!sbKey,
    VAPID_PUBLIC_KEY:    !!vapidPublic  ? `${vapidPublic.slice(0, 12)}…`  : '❌ NOT SET',
    VAPID_PRIVATE_KEY:   !!vapidPrivate ? `${vapidPrivate.slice(0, 6)}…`  : '❌ NOT SET',
    VAPID_SUBJECT:       vapidSubject,
  };

  if (!sbUrl || !sbKey) {
    return NextResponse.json({ error: 'Supabase not configured', envCheck }, { status: 500 });
  }
  if (!vapidPublic || !vapidPrivate) {
    return NextResponse.json({ error: 'VAPID keys not set — cannot send push', envCheck }, { status: 500 });
  }

  // ── Read all subscriptions for target user ──────────────────────
  const admin = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: subs, error: subErr } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, created_at')
    .eq('user_id', TARGET_USER_ID);

  if (subErr) {
    return NextResponse.json({ error: `DB error: ${subErr.message}`, code: subErr.code, envCheck }, { status: 500 });
  }

  const subsFound = (subs ?? []) as Array<{
    id: string; endpoint: string; p256dh: string; auth: string; created_at: string;
  }>;

  if (subsFound.length === 0) {
    return NextResponse.json({ error: 'No subscriptions found for this user_id', envCheck }, { status: 404 });
  }

  // ── Configure VAPID ────────────────────────────────────────────
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  } catch (e) {
    return NextResponse.json({ error: `VAPID init failed: ${String(e)}`, envCheck }, { status: 500 });
  }

  const payload = JSON.stringify({
    title: '🔔 測試',
    body:  '端到端測試',
    tag:   'diag-push-test',
  });

  // ── Send to each subscription and collect results ────────────────
  const toDelete: string[] = [];
  const results = await Promise.all(
    subsFound.map(async (sub) => {
      const shortEndpoint = sub.endpoint.slice(0, 80);
      const isApple = sub.endpoint.includes('web.push.apple.com');
      try {
        const resp = await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        return {
          subId:        sub.id,
          endpoint:     shortEndpoint,
          isApple,
          ok:           true,
          statusCode:   (resp as { statusCode?: number }).statusCode ?? 201,
          verdict:      '✅ 送出成功，手機此刻應收到通知',
        };
      } catch (err: unknown) {
        const e = err as { statusCode?: number; body?: string; message?: string };
        const statusCode   = e.statusCode;
        const errorBody    = e.body    ?? '';
        const errorMessage = e.message ?? String(err);
        let verdict = '❌ 送出失敗';
        if (statusCode === 410 || statusCode === 404) {
          verdict = '🗑️ 訂閱已過期 → 自動刪除';
          toDelete.push(sub.id);
        } else if (statusCode === 403) {
          verdict = '🔒 403 VAPID/JWT 拒絕 — VAPID subject 或 key 不對';
        } else if (statusCode === 400) {
          verdict = '⚠️ 400 Bad Request — payload 或 encryption 問題';
        } else if (statusCode === 401) {
          verdict = '🔒 401 Unauthorized — VAPID JWT 簽發失敗';
        }
        return {
          subId:        sub.id,
          endpoint:     shortEndpoint,
          isApple,
          ok:           false,
          statusCode,
          errorBody,
          errorMessage,
          verdict,
        };
      }
    }),
  );

  // ── Auto-delete expired subscriptions ──────────────────────────
  let deletedCount = 0;
  if (toDelete.length > 0) {
    const { error: delErr } = await admin
      .from('push_subscriptions')
      .delete()
      .in('id', toDelete);
    if (!delErr) deletedCount = toDelete.length;
  }

  const successCount = results.filter(r => r.ok).length;

  return NextResponse.json({
    summary: {
      subsFound:    subsFound.length,
      sent:         successCount,
      failed:       results.length - successCount,
      expiredDeleted: deletedCount,
    },
    envCheck,
    results,
  }, { status: 200 });
}

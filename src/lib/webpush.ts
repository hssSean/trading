import webpush from 'web-push';

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_CONTACT = process.env.VAPID_CONTACT ?? 'mailto:admin@example.com';

let vapidReady = false;
function initVapid() {
  if (vapidReady || !VAPID_PUBLIC || !VAPID_PRIVATE) return;
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
  vapidReady = true;
}

export interface WebPushPayload {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  url?: string;
}

/**
 * Send a Web Push notification to all subscriptions belonging to `userId`.
 * Silently removes expired/invalid subscriptions (410/404) and logs other errors.
 * Never throws — callers need not wrap in try/catch.
 */
export async function sendWebPushToUser(
  userId: string,
  payload: WebPushPayload,
): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!sbUrl || !sbKey || !userId) return;

  initVapid();

  let subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }> = [];
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(sbUrl, sbKey);
    const { data, error } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', userId);
    if (error) {
      // Table may not exist yet — fail silently
      if (error.code !== '42P01') console.error('[webpush] fetch subs error:', error.message);
      return;
    }
    subs = (data ?? []) as typeof subs;
  } catch (e) {
    console.error('[webpush] fetch subs threw:', String(e));
    return;
  }

  if (subs.length === 0) return;

  const payloadStr = JSON.stringify(payload);
  const toDelete: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr,
        );
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string };
        if (e.statusCode === 410 || e.statusCode === 404) {
          toDelete.push(sub.id);
          console.log(`[webpush] expired sub removed: ${sub.endpoint.slice(0, 60)}`);
        } else {
          console.error(`[webpush] send failed (${e.statusCode ?? 'unknown'}): ${e.message ?? err}`);
        }
      }
    }),
  );

  if (toDelete.length > 0) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const admin = createClient(sbUrl, sbKey);
      await admin.from('push_subscriptions').delete().in('id', toDelete);
    } catch (e) {
      console.error('[webpush] cleanup threw:', String(e));
    }
  }
}

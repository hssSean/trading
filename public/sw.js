// Service Worker for Crypto Trader Web Push
const APP_URL = self.location.origin;

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Crypto Trader', body: event.data.text() };
  }

  const title = payload.title ?? 'Crypto Trader';
  const options = {
    body: payload.body ?? '',
    icon: payload.icon ?? '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag ?? 'crypto-trader',
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url ?? APP_URL },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? APP_URL;

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(targetUrl);
      }),
  );
});

// Minimal fetch handler — no caching, just passthrough
self.addEventListener('fetch', () => {});

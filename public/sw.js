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
  // 2026-08-07：icon/badge 原本指向 /icon-192.png，但這個檔案從專案建立
  // 以來就沒被加入過（public/ 資料夾裡完全沒有任何點陣圖）——manifest.json
  // 引用的兩個 PNG 一直是 404。Web Push 的 icon/badge 規格要求點陣圖，SVG
  // 頂替不了（manifest.json 的安裝圖示已經改用 SVG，但這裡不行），拿掉
  // 死連結，讓瀏覽器用系統預設值，不要每次推播都多打一次註定失敗的請求。
  // 待補：真正的 PNG icon（192x192、512x512）。
  const options = {
    body: payload.body ?? '',
    icon: payload.icon,
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

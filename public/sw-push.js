/**
 * Push notification service worker — separate from sw.js (asset cache).
 *
 * Handles incoming Web Push events and notification clicks. Does NOT cache
 * any assets, so the layout.tsx cleanup loop can leave it alone.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/639
 *
 * Marker: this file MUST contain the literal string "o8-push-sw" so the
 * cleanup script in app/layout.tsx can identify and preserve it.
 */
/* o8-push-sw v1 — do not delete this comment marker */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Tauri webview never uses Web Push — keep the SW idle there.
const isTauri = self.location.protocol === 'tauri:' || self.location.hostname === 'tauri.localhost';

self.addEventListener('push', (event) => {
  if (isTauri) return;

  let payload = { title: 'o8', body: '' };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'o8', body: event.data.text() };
    }
  }

  const title = typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : 'o8';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const tag = typeof payload.tag === 'string' && payload.tag.length > 0 ? payload.tag : 'o8-push';
  const url = typeof payload.url === 'string' ? payload.url : '/mobile';
  const data = typeof payload.data === 'object' && payload.data ? payload.data : {};

  const options = {
    body,
    tag,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    data: { url, payload: data },
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data && typeof event.notification.data.url === 'string'
    ? event.notification.data.url
    : '/mobile';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // If a mobile tab is already open, focus it and route there.
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.pathname.startsWith('/mobile')) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(url);
            } catch {
              // Some clients reject cross-origin navigate; fall back to postMessage.
              client.postMessage({ kind: 'o8-push-deeplink', url });
            }
          } else {
            client.postMessage({ kind: 'o8-push-deeplink', url });
          }
          return;
        }
      } catch {
        // Skip non-parseable URLs.
      }
    }

    // Otherwise, open a new window.
    if (self.clients.openWindow) {
      await self.clients.openWindow(url);
    }
  })());
});

// Push subscription change — browsers occasionally rotate endpoints. We can't
// reach the server's bearer token from here, so we just log and drop the
// stale subscription. The mobile client will re-register on next mount.
self.addEventListener('pushsubscriptionchange', () => {
  console.info('[o8-push-sw] subscription changed; client will re-register on next mount');
});

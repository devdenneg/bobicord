// Минимальный service worker: даёт установку PWA (нужен fetch-обработчик),
// но НИЧЕГО не кэширует (кэш ранее ронял Chrome на проде) и чистит старые кэши при активации.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) { /* ignore */ }
    try { await self.clients.claim(); } catch (e) { /* ignore */ }
  })());
});
// fetch-обработчик обязателен для installability; чистый passthrough — всегда сеть, без кэша
self.addEventListener('fetch', () => { /* passthrough */ });

// фоновый web-push (VAPID): сервер будит SW даже когда PWA свёрнута/закрыта (единственный путь
// на iOS — там JS страницы в фоне заморожен). payload = { kind, title, body, serverId }.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { /* не-JSON payload */ }
  const title = d.title || 'Рилэй';
  const opts = {
    body: d.body || '',
    tag: d.kind || 'msg',
    renotify: true,
    icon: '/icon-256.png',
    badge: '/icon-128.png',
    data: { serverId: d.serverId || '' },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// клик по системному уведомлению → фокус существующего окна (или открыть новое)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    try {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    } catch (e) { /* ignore */ }
  })());
});

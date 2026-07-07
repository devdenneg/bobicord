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

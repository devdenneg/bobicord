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

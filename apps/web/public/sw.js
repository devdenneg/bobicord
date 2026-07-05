// Kill-switch service worker.
// Старый SW/кэш ронял Chrome на проде. Этот НЕ кэширует, при активации чистит все кэши,
// захватывает клиентов и разрегистрирует сам себя — приложение всегда грузится свежим из сети.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) { /* ignore */ }
    try { await self.clients.claim(); } catch (e) { /* ignore */ }
    try { await self.registration.unregister(); } catch (e) { /* ignore */ }
  })());
});
// нет fetch-обработчика → никакого перехвата, браузер всегда идёт в сеть напрямую

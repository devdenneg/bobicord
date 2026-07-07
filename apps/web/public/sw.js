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
// на iOS — там JS страницы в фоне заморожен). payload = { kind, title, body, serverId, tag, url }.
// ВАЖНО (iOS): на КАЖДЫЙ push обязателен видимый showNotification внутри waitUntil — иначе Safari
// считает push «тихим» и после нескольких таких СНИМАЕТ подписку. Поэтому показываем ВСЕГДА.
// Дедуп с живым локальным уведомлением — общим тегом <kind>:<serverId> (ОС схлопывает в один
// баннер: и local через reg.showNotification, и push идут через одну регистрацию).
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) { /* не-JSON payload */ }
    const tag = d.tag || ((d.kind || 'msg') + ':' + (d.serverId || ''));
    await self.registration.showNotification(d.title || 'Рилэй', {
      body: d.body || '',
      tag,
      renotify: true,
      icon: '/icon-256.png',
      badge: '/icon-128.png',
      data: { serverId: d.serverId || '', url: d.url || '/' },
    });
    // живым вкладкам — сообщение (обновить UI/бейдж). Показ НЕ подавляем (iOS требует show).
    try { const cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); for (const c of cls) c.postMessage({ type: 'push', kind: d.kind, serverId: d.serverId }); } catch (e) { /* ignore */ }
  })());
});

// клик по уведомлению → сфокусировать окно и открыть нужный сервер (или открыть новое окно на url)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  event.waitUntil((async () => {
    try {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) { try { c.postMessage({ type: 'open-server', serverId: data.serverId || '' }); } catch (e) { /* ignore */ } return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    } catch (e) { /* ignore */ }
  })());
});

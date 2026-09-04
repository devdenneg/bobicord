// Минимальный service worker: даёт установку PWA (нужен fetch-обработчик),
// но НИЧЕГО не кэширует (кэш ранее ронял Chrome на проде) и чистит старые кэши при активации.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.filter((k) => k !== 'relay-notification-state-v1').map((k) => caches.delete(k))); } catch (e) { /* ignore */ }
    try { await self.clients.claim(); } catch (e) { /* ignore */ }
  })());
});
// fetch-обработчик обязателен для installability; чистый passthrough — всегда сеть, без кэша
self.addEventListener('fetch', () => { /* passthrough */ });

const NOTIFICATION_STATE_CACHE = 'relay-notification-state-v1';
const PRIVACY_KEY = new URL('/__relay-notification-state/privacy', self.location.origin).toString();
const DESTINATION_PREFIX = new URL('/__relay-notification-state/destination/', self.location.origin).toString();

function validPrivacy(value) {
  return value === 'sender' || value === 'hidden' ? value : 'full';
}

function normalizeDestination(value) {
  if (!value || typeof value !== 'object') return null;
  const serverId = typeof value.serverId === 'string' ? value.serverId.trim() : '';
  if (!serverId || serverId.length > 128) return null;
  const parsed = Number(value.messageId != null ? value.messageId : value.msgId);
  const messageId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  return { serverId, ...(messageId ? { messageId } : {}) };
}

function destinationUrl(destination) {
  if (!destination) return '/';
  const query = new URLSearchParams({ server: destination.serverId });
  if (destination.messageId) query.set('message', String(destination.messageId));
  return '/?' + query.toString();
}

async function writeState(key, value) {
  try {
    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    await cache.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* optional state */ }
}

async function readState(key, fallback) {
  try {
    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    const response = await cache.match(key);
    return response ? await response.json() : fallback;
  } catch (e) { return fallback; }
}

function destinationKey(tag) {
  return DESTINATION_PREFIX + encodeURIComponent(String(tag || ''));
}

function hasCorrelation(tag) {
  const value = String(tag || '');
  const first = value.indexOf(':');
  return first > 0 && value.indexOf(':', first + 1) > first + 1;
}

async function rememberDestination(tag, value) {
  let destination = normalizeDestination(value);
  if (tag && destination) {
    const previous = await storedDestination(tag);
    if (hasCorrelation(tag) && previous?.serverId === destination.serverId && previous.messageId && !destination.messageId) destination = previous;
    await writeState(destinationKey(tag), destination);
  }
  return destination;
}

async function storedDestination(tag) {
  if (!tag) return null;
  return normalizeDestination(await readState(destinationKey(tag), null));
}

function privatePresentation(kind, title, body, privacy) {
  if (privacy === 'full') return { title, body };
  if (privacy === 'sender') return { title, body: '' };
  const hiddenBody = kind === 'stream' ? 'Началась трансляция'
    : kind === 'update' ? 'Доступно обновление'
      : 'Новое упоминание';
  return { title: 'RelayApp', body: hiddenBody };
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'set-notification-privacy') {
    event.waitUntil(writeState(PRIVACY_KEY, validPrivacy(data.privacy)));
  } else if (data.type === 'remember-notification-destination') {
    event.waitUntil(rememberDestination(data.tag, data.destination));
  }
});

// фоновый web-push (VAPID): сервер будит SW даже когда PWA свёрнута/закрыта (единственный путь
// на iOS — там JS страницы в фоне заморожен). payload = { kind, title, body, serverId, msgId, tag, url }.
// ВАЖНО (iOS): на КАЖДЫЙ push обязателен видимый showNotification внутри waitUntil — иначе Safari
// считает push «тихим» и после нескольких таких СНИМАЕТ подписку. Поэтому показываем ВСЕГДА.
// Дедуп с живым локальным уведомлением — общим тегом <kind>:<serverId> (ОС схлопывает в один
// баннер: и local через reg.showNotification, и push идут через одну регистрацию).
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) { /* не-JSON payload */ }
    const tag = d.tag || ((d.kind || 'msg') + ':' + (d.serverId || ''));
    const destination = await rememberDestination(tag, { serverId: d.serverId, messageId: d.messageId ?? d.msgId });
    const privacy = validPrivacy(await readState(PRIVACY_KEY, 'full'));
    const content = privatePresentation(d.kind, d.title || 'Рилэй', d.body || '', privacy);
    const url = d.url || destinationUrl(destination);
    await self.registration.showNotification(content.title, {
      body: content.body,
      tag,
      renotify: true,
      icon: '/icon-256.png',
      badge: '/icon-128.png',
      data: {
        serverId: destination?.serverId || '',
        messageId: destination?.messageId,
        url,
      },
    });
    // живым вкладкам — сообщение (обновить UI/бейдж). Показ НЕ подавляем (iOS требует show).
    try { const cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); for (const c of cls) c.postMessage({ type: 'push', kind: d.kind, serverId: destination?.serverId, messageId: destination?.messageId }); } catch (e) { /* ignore */ }
  })());
});

// клик по уведомлению → сфокусировать окно и открыть нужный сервер (или открыть новое окно на url)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    try {
      const explicit = normalizeDestination(data);
      const remembered = await storedDestination(event.notification.tag);
      const destination = explicit?.messageId
        ? explicit
        : (remembered && (!explicit || remembered.serverId === explicit.serverId) ? remembered : explicit);
      const url = destination ? destinationUrl(destination) : (data.url || '/');
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          try {
            c.postMessage({
              type: 'open-destination',
              tag: event.notification.tag || '',
              serverId: destination?.serverId || '',
              messageId: destination?.messageId,
            });
          } catch (e) { /* ignore */ }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    } catch (e) { /* ignore */ }
  })());
});

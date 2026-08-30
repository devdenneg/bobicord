// Vite заменяет BUILD_PRECACHE внутри dist/sw.js: top-level worker становится
// байтово новым на каждом релизе даже в Safari, который в старых версиях мог
// пропустить изменение одного importScripts. В dev конфигурация подаётся отдельно.
const BUILD_PRECACHE = null;
if (BUILD_PRECACHE) self.__RELAY_PRECACHE = BUILD_PRECACHE;
else {
  try { importScripts('/sw-precache.js'); } catch (e) { /* install ниже fail-closed */ }
}

const SHELL_CACHE_PREFIX = 'relay-shell-v1-';
const rawPrecache = self.__RELAY_PRECACHE;
const shellVersion = rawPrecache && typeof rawPrecache.version === 'string'
  && /^[A-Za-z0-9._-]{1,64}$/.test(rawPrecache.version) ? rawPrecache.version : '';

function sensitiveRuntimePath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/twirp' || pathname.startsWith('/twirp/');
}

function safeShellUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 512) return '';
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || sensitiveRuntimePath(url.pathname)) return '';
    if (url.pathname === '/sw.js' || url.pathname === '/sw-precache.js') return '';
    return url.pathname;
  } catch (e) { return ''; }
}

const shellUrls = rawPrecache && Array.isArray(rawPrecache.urls)
  ? [...new Set(rawPrecache.urls.slice(0, 512).map(safeShellUrl).filter(Boolean))]
  : [];
const shellManifestReady = Boolean(shellVersion) && (shellVersion === 'dev' || shellUrls.length > 0);
const SHELL_CACHE = shellVersion ? SHELL_CACHE_PREFIX + shellVersion : '';
const SHELL_URLS = new Set(shellUrls);
const NAVIGATION_DEADLINE_MS = 3500;
const SHELL_CACHE_DEADLINE_MS = 1_000;
const SHELL_INSTALL_OPERATION_DEADLINE_MS = 10_000;
const SHELL_FETCH_DEADLINE_MS = 10_000;

function settleShellCache(promise, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, SHELL_CACHE_DEADLINE_MS);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function rejectStuckShellOperation(promise, label, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch (e) { /* the rejecting deadline is still authoritative */ }
      reject(new Error(label + ' timed out'));
    }, timeoutMs);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function validatedShellAsset(pathname, response) {
  if (!response || !response.ok) throw new Error('shell asset unavailable: ' + pathname);
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  const expected = pathname.endsWith('.js') ? ['javascript', 'ecmascript']
    : pathname.endsWith('.css') ? ['text/css']
      : pathname.endsWith('.html') ? ['text/html']
        : pathname.endsWith('.json') ? ['application/json', 'text/json']
          : pathname.endsWith('.wasm') ? ['application/wasm']
            : pathname.endsWith('.png') ? ['image/png']
              : pathname.endsWith('.webp') ? ['image/webp']
                : pathname.endsWith('.woff2') ? ['font/woff2', 'application/font-woff2']
                  : [];
  // Caddy SPA fallback intentionally returns index.html with 200 for an unknown path.
  // Accepting that body under a JS/CSS cache key creates a persistent nosniff white screen.
  if (expected.length && !expected.some((mime) => contentType.includes(mime))) {
    throw new Error('shell asset type mismatch: ' + pathname);
  }
  return response;
}

function shellAssetFetch(pathname) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const actual = Promise.resolve().then(() => fetch(new Request(pathname, {
    cache: 'reload', credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {}),
  })));
  const bounded = rejectStuckShellOperation(
    actual,
    'shell asset fetch ' + pathname,
    SHELL_FETCH_DEADLINE_MS,
    () => controller?.abort(),
  ).then((response) => validatedShellAsset(pathname, response));
  return { actual, bounded };
}

async function fetchShellAsset(pathname) {
  return shellAssetFetch(pathname).bounded;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Не активируем пустой worker при частично выкаченном релизе: прежний рабочий
    // shell безопаснее, чем очистка его кэша из-за временного 404 конфигурации.
    if (!shellManifestReady) throw new Error('precache manifest unavailable');
    if (shellUrls.length) {
      try {
        const cache = await rejectStuckShellOperation(
          Promise.resolve().then(() => caches.open(SHELL_CACHE)),
          'shell cache open',
          SHELL_INSTALL_OPERATION_DEADLINE_MS,
        );
        await Promise.all(shellUrls.map(async (pathname) => {
          const response = await fetchShellAsset(pathname);
          await rejectStuckShellOperation(
            Promise.resolve().then(() => cache.put(pathname, response)),
            'shell cache put ' + pathname,
            SHELL_INSTALL_OPERATION_DEADLINE_MS,
          );
        }));
      } catch (error) {
        await settleShellCache(Promise.resolve().then(() => caches.delete(SHELL_CACHE)), false);
        throw error;
      }
    }
    // Do not force an update to take over pages that are still running the previous build.
    // Those pages can still lazy-load their old hashed chunks from the previous worker/cache.
    // The staged worker activates naturally once every old client closes.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await settleShellCache(Promise.resolve().then(() => caches.keys()), []);
    await Promise.all(keys
      .filter((key) => key !== 'relay-notification-state-v1' && key !== SHELL_CACHE)
      .map((key) => settleShellCache(Promise.resolve().then(() => caches.delete(key)), false)));
    await settleShellCache(Promise.resolve().then(() => self.clients.claim()), undefined);
  })());
});

function offlineDocument() {
  return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0d0f12"><title>Рилэй — нет сети</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f12;color:#eef1f5;font:16px system-ui,sans-serif;text-align:center}.card{padding:28px;max-width:330px}h1{font-size:22px}p{color:#aeb6c2;line-height:1.45}</style><div class="card"><h1>Нет подключения</h1><p>Рилэй откроется автоматически после возврата сети. Аккаунт и настройки не удалены.</p></div><script>addEventListener("online",()=>location.reload())</script>', {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

let runtimeShellCacheOpenEntry = null;
const runtimeShellCacheMatches = new Map();
const runtimeShellCachePuts = new Map();
const runtimeShellFetches = new Map();
const runtimeNavigationFetches = new Map();

function sharedRuntimeShellCache() {
  if (!SHELL_CACHE) return Promise.resolve(null);
  if (runtimeShellCacheOpenEntry) return runtimeShellCacheOpenEntry.visible;
  const actual = Promise.resolve().then(() => caches.open(SHELL_CACHE));
  const current = { actual, visible: settleShellCache(actual, null) };
  runtimeShellCacheOpenEntry = current;
  const release = () => { if (runtimeShellCacheOpenEntry === current) runtimeShellCacheOpenEntry = null; };
  actual.then(release, release);
  return current.visible;
}

function sharedRuntimeShellMatch(cache, pathname) {
  const existing = runtimeShellCacheMatches.get(pathname);
  if (existing) return existing.visible;
  const actual = Promise.resolve().then(() => cache.match(pathname));
  const current = {
    actual,
    visible: settleShellCache(actual, null).then((response) => response?.clone?.() || response),
  };
  runtimeShellCacheMatches.set(pathname, current);
  const release = () => {
    if (runtimeShellCacheMatches.get(pathname) === current) runtimeShellCacheMatches.delete(pathname);
  };
  actual.then(release, release);
  return current.visible;
}

function sharedRuntimeShellPut(cache, pathname, response) {
  const existing = runtimeShellCachePuts.get(pathname);
  if (existing) return existing.visible;
  const actual = Promise.resolve().then(() => cache.put(pathname, response));
  const current = { actual, visible: settleShellCache(actual, undefined) };
  runtimeShellCachePuts.set(pathname, current);
  const release = () => {
    if (runtimeShellCachePuts.get(pathname) === current) runtimeShellCachePuts.delete(pathname);
  };
  actual.then(release, release);
  return current.visible;
}

function sharedRuntimeShellFetch(pathname) {
  const existing = runtimeShellFetches.get(pathname);
  if (existing) return existing.visible.then((response) => response.clone());
  const attempt = shellAssetFetch(pathname);
  const current = { actual: attempt.actual, visible: attempt.bounded };
  runtimeShellFetches.set(pathname, current);
  // Keep a timed-out view cached while the unabortable native fetch is genuinely pending. This
  // prevents repeated asset requests from accumulating zombie radio/network operations.
  const release = () => {
    if (runtimeShellFetches.get(pathname) === current) runtimeShellFetches.delete(pathname);
  };
  attempt.actual.then(release, release);
  return current.visible.then((response) => response.clone());
}

function sharedRuntimeNavigationFetch(request) {
  // Every same-origin navigation serves the same installed SPA document. Keep one physical
  // request while an abort-ignoring browser/network implementation is genuinely stuck; using
  // each deep-link pathname as a key would let notification URLs retain an unbounded number of
  // zombie fetches.
  const key = '__relay-spa-navigation__';
  const existing = runtimeNavigationFetches.get(key);
  if (existing) return existing.visible.then((response) => response?.clone?.() || response);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const actual = Promise.resolve().then(() => (
    fetch(request, controller ? { signal: controller.signal } : undefined)
  ));
  const network = actual
    .then((response) => ({ source: 'network', response }))
    .catch(() => ({ source: 'network', response: null }));
  let deadlineId;
  const deadline = new Promise((resolve) => {
    deadlineId = setTimeout(() => resolve({ source: 'deadline', response: null }), NAVIGATION_DEADLINE_MS);
  });
  const visible = Promise.race([network, deadline]).then((winner) => {
    if (deadlineId) clearTimeout(deadlineId);
    if (winner.source === 'deadline') controller?.abort();
    return winner.response;
  });
  const current = { actual, visible };
  runtimeNavigationFetches.set(key, current);
  const release = () => {
    if (runtimeNavigationFetches.get(key) === current) runtimeNavigationFetches.delete(key);
  };
  actual.then(release, release);
  return current.visible.then((response) => response?.clone?.() || response);
}

async function cachedShellDocument() {
  if (!SHELL_CACHE) return null;
  const cache = await sharedRuntimeShellCache();
  return cache ? sharedRuntimeShellMatch(cache, '/index.html') : null;
}

async function networkFirstNavigation(request) {
  // Не пишем свежий HTML в кэш старого worker: его новые hash-ассеты могут ещё
  // не установиться при rolling deploy. Новый релиз становится offline-доступным
  // только атомарно, через успешный install собственного versioned cache.
  const response = await sharedRuntimeNavigationFetch(request);
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  // A proxy may be reachable while the application upstream is restarting. Returning its 5xx
  // document replaces a known-good installed shell with an error page. Only a successful HTML
  // navigation is authoritative; otherwise prefer the atomically installed build and preserve
  // the original HTTP error only when no shell has ever been cached.
  if (response?.ok && (contentType.includes('text/html') || contentType.includes('application/xhtml+xml'))) {
    return response;
  }
  return await cachedShellDocument() || response || offlineDocument();
}

async function cacheFirstShellAsset(request, pathname) {
  const cache = await sharedRuntimeShellCache();
  if (cache) {
    const cached = await sharedRuntimeShellMatch(cache, pathname);
    if (cached) return cached;
  }
  try {
    // An evicted or unreadable entry follows the exact same status/MIME validation as install.
    // Otherwise Caddy's 200 HTML SPA fallback could poison every later cold launch.
    const response = await sharedRuntimeShellFetch(pathname);
    if (cache) await sharedRuntimeShellPut(cache, pathname, response.clone());
    return response;
  } catch (e) { return Response.error(); }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!shellManifestReady || !request || request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin || sensitiveRuntimePath(url.pathname)) return;
  if (request.headers && request.headers.has && request.headers.has('range')) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (SHELL_URLS.has(url.pathname)) event.respondWith(cacheFirstShellAsset(request, url.pathname));
});

const NOTIFICATION_STATE_CACHE = 'relay-notification-state-v1';
const PRIVACY_KEY = new URL('/__relay-notification-state/privacy', self.location.origin).toString();
const SESSION_ACTIVE_KEY = new URL('/__relay-notification-state/session-active', self.location.origin).toString();
const PRIVACY_VERSION_PREFIX = new URL('/__relay-notification-state/privacy/version/', self.location.origin).toString();
const SESSION_ACTIVE_VERSION_PREFIX = new URL('/__relay-notification-state/session-active/version/', self.location.origin).toString();
const DESTINATION_PREFIX = new URL('/__relay-notification-state/destination/', self.location.origin).toString();
const DESTINATION_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_DESTINATIONS = 64;
const MAX_NOTIFICATION_STATE_VERSIONS = 8;
const NOTIFICATION_STATE_DEADLINE_MS = 1_000;
let lastDestinationTimestamp = 0;
let lastNotificationStateRevision = 0;

function settleNotificationState(promise, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, NOTIFICATION_STATE_DEADLINE_MS);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

let sharedWindowClientsEntry = null;
function sharedWindowClients() {
  if (sharedWindowClientsEntry) return sharedWindowClientsEntry.visible;
  const actual = Promise.resolve().then(() => (
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  ));
  const current = { actual, visible: settleNotificationState(actual, []) };
  sharedWindowClientsEntry = current;
  // A timed-out native matchAll cannot be cancelled. Reuse that exact operation until it truly
  // settles so a stream of background pushes cannot retain one native promise per notification.
  const release = () => {
    if (sharedWindowClientsEntry === current) sharedWindowClientsEntry = null;
  };
  actual.then(release, release);
  return current.visible;
}

function validPrivacy(value) {
  return value === 'full' || value === 'sender' ? value : 'hidden';
}

function mostRestrictivePrivacy(a, b) {
  const rank = { full: 0, sender: 1, hidden: 2 };
  const first = validPrivacy(a);
  const second = validPrivacy(b);
  return rank[first] >= rank[second] ? first : second;
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

async function writeStateStrict(key, value) {
  const cache = await caches.open(NOTIFICATION_STATE_CACHE);
  await cache.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
}

async function writeState(key, value) {
  try {
    await writeStateStrict(key, value);
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

function validTag(tag) {
  const value = typeof tag === 'string' ? tag.trim() : '';
  return value && value.length <= 256 ? value : '';
}

function hasCorrelation(tag) {
  const value = String(tag || '');
  const first = value.indexOf(':');
  return first > 0 && value.indexOf(':', first + 1) > first + 1;
}

function nextDestinationTimestamp() {
  const now = Date.now();
  if (lastDestinationTimestamp > now + DESTINATION_TTL_MS) lastDestinationTimestamp = now;
  lastDestinationTimestamp = Math.max(now, lastDestinationTimestamp + 1);
  return lastDestinationTimestamp;
}

function validDestinationTimestamp(value, now = Date.now()) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > now + DESTINATION_TTL_MS) return 0;
  lastDestinationTimestamp = Math.max(lastDestinationTimestamp, parsed);
  return parsed;
}

const MAX_DESTINATION_MUTATION_QUEUE = 64;
const MAX_DESTINATION_MUTATIONS_IN_FLIGHT = 2;
let destinationMutationGeneration = 0;
let destinationMutationsInFlight = 0;
const destinationMutationQueue = new Map();
const latestDestinationMutations = new Map();
const activeDestinationMutations = new Set();

function pumpDestinationMutations() {
  while (destinationMutationsInFlight < MAX_DESTINATION_MUTATIONS_IN_FLIGHT
    && destinationMutationQueue.size
    && ![...activeDestinationMutations].some((descriptor) => !descriptor.timedOut)) {
    const [key, descriptor] = destinationMutationQueue.entries().next().value;
    destinationMutationQueue.delete(key);
    destinationMutationsInFlight += 1;
    descriptor.timedOut = false;
    activeDestinationMutations.add(descriptor);
    let callerReleased = false;
    const deadline = setTimeout(() => {
      callerReleased = true;
      descriptor.timedOut = true;
      descriptor.resolve(descriptor.fallback);
      // Keep the unabortable old operation counted, but use the second bounded slot for recovery.
      pumpDestinationMutations();
    }, NOTIFICATION_STATE_DEADLINE_MS);
    Promise.resolve().then(descriptor.operation).then((value) => {
      clearTimeout(deadline);
      destinationMutationsInFlight -= 1;
      activeDestinationMutations.delete(descriptor);
      if (!callerReleased) descriptor.resolve(value);
      const latest = latestDestinationMutations.get(key);
      const latestAlreadyPending = destinationMutationQueue.get(key)?.generation === latest?.generation;
      if (latest && latest.generation !== descriptor.generation && !latestAlreadyPending) {
        destinationMutationQueue.set(key, latest);
      }
      pumpDestinationMutations();
    }, () => {
      clearTimeout(deadline);
      destinationMutationsInFlight -= 1;
      activeDestinationMutations.delete(descriptor);
      if (!callerReleased) descriptor.resolve(descriptor.fallback);
      pumpDestinationMutations();
    });
  }
}

function serializeDestinationMutation(keyValue, operation, fallback) {
  const key = validTag(keyValue) || '__invalid__';
  const generation = ++destinationMutationGeneration;
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const descriptor = { generation, operation, fallback, resolve };
  const superseded = destinationMutationQueue.get(key);
  if (superseded) superseded.resolve(superseded.fallback);
  destinationMutationQueue.delete(key);
  destinationMutationQueue.set(key, descriptor);
  latestDestinationMutations.delete(key);
  latestDestinationMutations.set(key, descriptor);
  while (destinationMutationQueue.size > MAX_DESTINATION_MUTATION_QUEUE) {
    const [oldestKey, oldest] = destinationMutationQueue.entries().next().value;
    destinationMutationQueue.delete(oldestKey);
    oldest.resolve(oldest.fallback);
  }
  while (latestDestinationMutations.size > MAX_DESTINATIONS) {
    latestDestinationMutations.delete(latestDestinationMutations.keys().next().value);
  }
  pumpDestinationMutations();
  return promise;
}

async function deleteDestinationState(tag) {
  const safeTag = validTag(tag);
  if (!safeTag) return false;
  try {
    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    return await cache.delete(destinationKey(safeTag));
  } catch (e) { return false; }
}

async function rememberDestinationNow(tag, value) {
  let destination = normalizeDestination(value);
  const safeTag = validTag(tag);
  if (safeTag && destination) {
    const previous = await storedDestination(safeTag);
    if (hasCorrelation(safeTag) && previous?.serverId === destination.serverId && previous.messageId && !destination.messageId) destination = previous;
    await writeState(destinationKey(safeTag), { destination, updatedAt: nextDestinationTimestamp() });
    await pruneDestinations();
  }
  return destination;
}

function rememberDestination(tag, value) {
  return serializeDestinationMutation(tag, () => rememberDestinationNow(tag, value), normalizeDestination(value));
}

async function storedDestination(tag) {
  const safeTag = validTag(tag);
  if (!safeTag) return null;
  const value = await readState(destinationKey(safeTag), null);
  const destination = normalizeDestination(value?.destination) || normalizeDestination(value);
  let updatedAt = validDestinationTimestamp(value?.updatedAt);
  if (destination && !updatedAt) {
    updatedAt = nextDestinationTimestamp();
    await writeState(destinationKey(safeTag), { destination, updatedAt });
  }
  if (!destination || (updatedAt > 0 && Date.now() - updatedAt > DESTINATION_TTL_MS)) {
    await deleteDestinationState(safeTag);
    return null;
  }
  return destination;
}

async function forgetDestinationNow(tag, expected) {
  const safeTag = validTag(tag);
  if (!safeTag) return false;
  try {
    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    if (expected) {
      const current = await storedDestination(safeTag);
      const wanted = normalizeDestination(expected);
      if (current && wanted && (current.serverId !== wanted.serverId || current.messageId !== wanted.messageId)) return false;
    }
    return await cache.delete(destinationKey(safeTag));
  } catch (e) { return false; }
}

function forgetDestination(tag, expected) {
  return serializeDestinationMutation(tag, () => forgetDestinationNow(tag, expected), false);
}

async function takeDestination(tag, explicitValue) {
  return serializeDestinationMutation(tag, async () => {
    const explicit = normalizeDestination(explicitValue);
    const remembered = await storedDestination(tag);
    const destination = explicit?.messageId
      ? explicit
      : (remembered && (!explicit || remembered.serverId === explicit.serverId) ? remembered : explicit);
    await forgetDestinationNow(tag);
    return destination;
  }, normalizeDestination(explicitValue));
}

async function pruneDestinations(now = Date.now()) {
  try {
    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    const keys = await cache.keys();
    const live = [];
    for (const request of keys) {
      if (!request.url.startsWith(DESTINATION_PREFIX)) continue;
      let value = null;
      try {
        const response = await cache.match(request);
        value = response ? await response.json() : null;
      } catch (e) { /* malformed entry is removed below */ }
      const destination = normalizeDestination(value?.destination) || normalizeDestination(value);
      const updatedAt = validDestinationTimestamp(value?.updatedAt, now);
      if (!destination || !updatedAt || now - updatedAt > DESTINATION_TTL_MS) await cache.delete(request);
      else live.push({ request, updatedAt });
    }
    live.sort((a, b) => b.updatedAt - a.updatedAt);
    await Promise.all(live.slice(MAX_DESTINATIONS).map(({ request }) => cache.delete(request)));
  } catch (e) { /* optional bounded state */ }
}

async function tellClientsToForgetDestination(tag) {
  const safeTag = validTag(tag);
  if (!safeTag) return;
  try {
    const clients = await sharedWindowClients();
    for (const client of clients) client.postMessage({ type: 'forget-notification-destination', tag: safeTag });
  } catch (e) { /* ignore */ }
}

async function postDestinationWithAck(client, message) {
  if (typeof MessageChannel === 'undefined') return false;
  const channel = new MessageChannel();
  const acknowledgement = new Promise((resolve) => {
    channel.port1.onmessage = (event) => resolve(event.data?.ok === true);
    try {
      channel.port1.start?.();
      client.postMessage(message, [channel.port2]);
    } catch (e) { resolve(false); }
  });
  const acknowledged = await settleNotificationState(acknowledgement, false);
  try { channel.port1.close(); channel.port2.close(); } catch (e) { /**/ }
  return acknowledged === true;
}

function privatePresentation(kind, title, body, privacy) {
  if (privacy === 'full') return { title, body };
  if (privacy === 'sender') return { title, body: '' };
  const hiddenBody = kind === 'stream' ? 'Началась трансляция'
    : kind === 'update' ? 'Доступно обновление'
      : 'Новое упоминание';
  return { title: 'RelayApp', body: hiddenBody };
}

function stateRevisionFromUrl(url, prefix) {
  if (typeof url !== 'string' || !url.startsWith(prefix)) return 0;
  const revision = Number(url.slice(prefix.length));
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

async function writeVersionedNotificationStateStrict(prefix, descriptor) {
  if (!Number.isSafeInteger(descriptor.revision) || descriptor.revision <= 0) {
    throw new Error('notification state revision is not initialized');
  }
  const cache = await caches.open(NOTIFICATION_STATE_CACHE);
  const revision = descriptor.revision;
  await cache.put(prefix + revision, new Response(JSON.stringify({ revision, value: descriptor.value }), {
    headers: { 'content-type': 'application/json' },
  }));
  const existingVersions = (await cache.keys())
    .map((request) => ({ request, revision: stateRevisionFromUrl(request.url, prefix) }))
    .filter(({ revision: storedRevision }) => storedRevision > 0)
    .sort((a, b) => b.revision - a.revision);
  // Cleanup is part of the same capped physical operation; no independent stuck tail is created.
  await Promise.all(existingVersions.slice(MAX_NOTIFICATION_STATE_VERSIONS)
    .map(({ request }) => cache.delete(request)));
}

async function readVersionedNotificationState(prefix, legacyKey, fallback) {
  const cache = await caches.open(NOTIFICATION_STATE_CACHE);
  const versionKeys = (await cache.keys())
    .map((request) => ({ request, revision: stateRevisionFromUrl(request.url, prefix) }))
    .filter(({ revision }) => revision > 0)
    .sort((a, b) => b.revision - a.revision);
  if (versionKeys.length) {
    const { request, revision } = versionKeys[0];
    try {
      const response = await cache.match(request);
      const stored = response ? await response.json() : null;
      if (stored && stored.revision === revision && Object.prototype.hasOwnProperty.call(stored, 'value')) {
        lastNotificationStateRevision = Math.max(lastNotificationStateRevision, revision);
        return stored.value;
      }
    } catch (e) { /* the fail-closed fallback below is authoritative */ }
    // A newer restrictive tombstone must never be skipped in favour of an older active/full value
    // merely because its response is corrupt or was partially evicted.
    return fallback;
  }
  // Migration-safe read of the primitive value written by already-installed workers.
  const legacy = await cache.match(legacyKey);
  return legacy ? await legacy.json() : fallback;
}

function createSharedVersionedStateReader(prefix, legacyKey, fallback, normalize) {
  let entry = null;
  return () => {
    if (entry) return entry.visible;
    const actual = Promise.resolve().then(() => (
      readVersionedNotificationState(prefix, legacyKey, fallback)
    ));
    const current = {
      actual,
      // Keep one bounded view attached to a stuck native operation. Every later push reuses it
      // instead of adding another caches.open/keys request and a permanently retained reaction.
      visible: settleNotificationState(actual, fallback).then(normalize),
    };
    entry = current;
    const release = () => { if (entry === current) entry = null; };
    actual.then(release, release);
    return current.visible;
  };
}

const MAX_UNRESOLVED_NOTIFICATION_STATE_WRITES = 3;

function createRecoverableLatestStateWriter(prefix, retryRestrictive) {
  let generation = 0;
  let running = false;
  let pending = null;
  let latest = null;
  let revisionBase = 0;
  let revisionSeed = null;
  let resolveRevisionSeed = null;
  let rejectRevisionSeed = null;
  let revisionSeedAttempts = 0;
  const revisionSeedOperations = new Set();
  // Privacy and session state have independent budgets: broken privacy persistence must never
  // consume the slots reserved for an explicit session=false logout tombstone (and vice versa).
  const unresolvedWrites = new Set();
  const startRevisionSeedAttempt = () => {
    if (revisionBase || revisionSeedAttempts >= MAX_UNRESOLVED_NOTIFICATION_STATE_WRITES) return;
    revisionSeedAttempts += 1;
    const operation = Promise.resolve().then(async () => {
      const cache = await caches.open(NOTIFICATION_STATE_CACHE);
      return (await cache.keys()).reduce((maximum, request) => (
        Math.max(maximum, stateRevisionFromUrl(request.url, prefix))
      ), 0);
    });
    const token = {};
    revisionSeedOperations.add(token);
    let physicallySettled = false;
    const timer = setTimeout(() => {
      if (physicallySettled || revisionBase) return;
      // Keep one common barrier, but let a second bounded native scan recover when the first iOS
      // CacheStorage call never settles. Generation-derived revisions remain ordered behind it.
      startRevisionSeedAttempt();
    }, NOTIFICATION_STATE_DEADLINE_MS);
    operation.then((persistedFloor) => {
      physicallySettled = true;
      clearTimeout(timer);
      revisionSeedOperations.delete(token);
      if (revisionBase) return;
      revisionBase = Math.max(Date.now() * 1_000, persistedFloor, lastNotificationStateRevision);
      lastNotificationStateRevision = revisionBase;
      resolveRevisionSeed?.(revisionBase);
    }, (error) => {
      physicallySettled = true;
      clearTimeout(timer);
      revisionSeedOperations.delete(token);
      if (revisionBase) return;
      if (revisionSeedAttempts < MAX_UNRESOLVED_NOTIFICATION_STATE_WRITES) {
        startRevisionSeedAttempt();
      } else if (revisionSeedOperations.size === 0) {
        // Every native scan in this batch genuinely rejected, so none can later publish a stale
        // floor. Reject current callers and reset only this completed barrier; a later privacy or
        // logout event may then recover after transient CacheStorage failure.
        const rejectSeed = rejectRevisionSeed;
        revisionSeed = null;
        resolveRevisionSeed = null;
        rejectRevisionSeed = null;
        revisionSeedAttempts = 0;
        rejectSeed?.(error);
      }
    });
  };
  const ensureRevisionBase = () => {
    if (revisionBase) return Promise.resolve(revisionBase);
    if (!revisionSeed) {
      revisionSeed = new Promise((resolve, reject) => {
        resolveRevisionSeed = resolve;
        rejectRevisionSeed = reject;
      });
      startRevisionSeedAttempt();
    }
    return revisionSeed;
  };
  const makeDescriptor = (value, descriptorGeneration) => {
    let resolve;
    let reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return {
      value,
      generation: descriptorGeneration,
      revision: 0,
      attempts: 0,
      capacityDeadline: null,
      promise,
      resolve,
      reject,
    };
  };
  const pump = () => {
    if (running || !pending) return;
    const restrictive = retryRestrictive(pending.value);
    const unresolvedNonrestrictive = [...unresolvedWrites]
      .filter((token) => token.restrictive !== true).length;
    const hasCapacity = unresolvedWrites.size < MAX_UNRESOLVED_NOTIFICATION_STATE_WRITES
      && (restrictive || unresolvedNonrestrictive < 1);
    if (!hasCapacity) {
      const blocked = pending;
      if (!blocked.capacityDeadline) {
        blocked.capacityDeadline = setTimeout(() => {
          blocked.capacityDeadline = null;
          if (pending !== blocked || running) return;
          pending = null;
          blocked.reject(new Error('notification state write capacity exhausted'));
        }, NOTIFICATION_STATE_DEADLINE_MS);
      }
      return;
    }
    const descriptor = pending;
    pending = null;
    clearTimeout(descriptor.capacityDeadline);
    running = true;
    descriptor.attempts += 1;
    const token = { restrictive };
    unresolvedWrites.add(token);
    const operation = Promise.resolve().then(async () => {
      const base = await ensureRevisionBase();
      if (!descriptor.revision) {
        descriptor.revision = base + descriptor.generation;
        if (!Number.isSafeInteger(descriptor.revision)) throw new Error('notification state revision overflow');
        lastNotificationStateRevision = Math.max(lastNotificationStateRevision, descriptor.revision);
      }
      return writeVersionedNotificationStateStrict(prefix, descriptor);
    });
    const release = () => {
      if (unresolvedWrites.delete(token)) pump();
    };
    operation.then(release, release);
    rejectStuckShellOperation(
      operation,
      'notification state write',
      NOTIFICATION_STATE_DEADLINE_MS,
    ).then(() => {
      running = false;
      descriptor.resolve();
      pump();
    }, (error) => {
      running = false;
      // Restrictive privacy/logout intents get bounded retries. Less-restrictive writes may fail
      // safely and are retried by normal page maintenance without delaying worker termination.
      if (latest === descriptor && retryRestrictive(descriptor.value) && descriptor.attempts < 3) {
        pending = descriptor;
      } else {
        descriptor.reject(error);
      }
      pump();
    });
  };
  return (value) => {
    generation += 1;
    if (pending) {
      pending.value = value;
      pending.generation = generation;
      pending.revision = 0;
      pending.attempts = 0;
      clearTimeout(pending.capacityDeadline);
      pending.capacityDeadline = null;
      latest = pending;
      pump();
      return pending.promise;
    }
    const descriptor = makeDescriptor(value, generation);
    latest = descriptor;
    pending = descriptor;
    pump();
    return descriptor.promise;
  };
}

let latestPrivacy = null;
const writeLatestPrivacy = createRecoverableLatestStateWriter(
  PRIVACY_VERSION_PREFIX,
  (privacy) => validPrivacy(privacy) !== 'full',
);
const readPersistedPrivacy = createSharedVersionedStateReader(
  PRIVACY_VERSION_PREFIX,
  PRIVACY_KEY,
  'hidden',
  (value) => latestPrivacy || validPrivacy(value),
);
function persistPrivacy(value) {
  const privacy = validPrivacy(value);
  latestPrivacy = privacy;
  return writeLatestPrivacy(privacy);
}
function readPrivacy() {
  return latestPrivacy || readPersistedPrivacy();
}

let latestNotificationSessionActive = null;
const writeLatestNotificationSessionActive = createRecoverableLatestStateWriter(
  SESSION_ACTIVE_VERSION_PREFIX,
  (active) => active !== true,
);
const readPersistedNotificationSessionActive = createSharedVersionedStateReader(
  SESSION_ACTIVE_VERSION_PREFIX,
  SESSION_ACTIVE_KEY,
  false,
  (value) => latestNotificationSessionActive !== null
    ? latestNotificationSessionActive
    : value === true,
);
function persistNotificationSessionActive(value) {
  const active = value === true;
  latestNotificationSessionActive = active;
  return writeLatestNotificationSessionActive(active);
}
function readNotificationSessionActive() {
  if (latestNotificationSessionActive !== null) return latestNotificationSessionActive;
  return readPersistedNotificationSessionActive();
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'set-notification-privacy') {
    const privacy = validPrivacy(data.privacy);
    const persistence = persistPrivacy(privacy);
    // Restrictive changes must keep the worker alive until CacheStorage confirms durability. A
    // `full` write may remain bounded: timeout/failure leaves the previous, safer durable value.
    event.waitUntil(privacy === 'full' ? settleNotificationState(persistence) : persistence);
  } else if (data.type === 'set-notification-session-active') {
    const persistence = persistNotificationSessionActive(data.active === true);
    event.waitUntil(persistence.then(() => {
      try { event.ports?.[0]?.postMessage({ ok: true }); } catch (e) { /**/ }
    }, () => {
      try { event.ports?.[0]?.postMessage({ ok: false }); } catch (e) { /**/ }
      throw new Error('notification session state was not persisted');
    }));
  } else if (data.type === 'remember-notification-destination') {
    event.waitUntil(settleNotificationState(rememberDestination(data.tag, data.destination), normalizeDestination(data.destination)));
  } else if (data.type === 'forget-notification-destination') {
    event.waitUntil(settleNotificationState(forgetDestination(data.tag), false));
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
    const sessionActive = await settleNotificationState(readNotificationSessionActive(), false);
    const tag = sessionActive === true
      ? (d.tag || ((d.kind || 'msg') + ':' + (d.serverId || '')))
      : ('inactive:' + (d.kind || 'msg'));
    const directDestination = normalizeDestination({ serverId: d.serverId, messageId: d.messageId ?? d.msgId });
    const [destination, storedPrivacy] = await Promise.all([
      sessionActive === true
        ? settleNotificationState(rememberDestination(tag, directDestination), directDestination)
        : Promise.resolve(null),
      // Privacy fails closed: a broken state cache may hide content, but can never expose it.
      settleNotificationState(readPrivacy(), 'hidden'),
    ]);
    // Both the exact server subscription and this browser may impose a privacy floor. A payload
    // from an old server has no `privacy` field and therefore fails closed to `hidden`.
    const privacy = sessionActive === true ? mostRestrictivePrivacy(d.privacy, storedPrivacy) : 'hidden';
    const content = privatePresentation(d.kind, d.title || 'Рилэй', d.body || '', privacy);
    const url = sessionActive === true ? (d.url || destinationUrl(destination)) : '/';
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
    try {
      const cls = await sharedWindowClients();
      for (const c of cls) c.postMessage(sessionActive === true
        ? { type: 'push', kind: d.kind, serverId: destination?.serverId, messageId: destination?.messageId }
        : { type: 'push', kind: d.kind });
    } catch (e) { /* ignore */ }
  })());
});

// клик по уведомлению → сфокусировать окно и открыть нужный сервер (или открыть новое окно на url)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    try {
      // Resolve and consume the exact tag atomically with concurrent push/page updates. A later
      // replacement queued after the click keeps its own correlation instead of being erased.
      const destination = await settleNotificationState(
        takeDestination(event.notification.tag, data),
        normalizeDestination(data),
      );
      const url = destination ? destinationUrl(destination) : (data.url || '/');
      const all = await sharedWindowClients();
      for (const c of all) {
        if ('focus' in c) {
          try {
            const focusedClient = await settleNotificationState(Promise.resolve().then(() => c.focus()), null);
            if (!focusedClient) continue;
            // A generic logged-out banner has no account destination; focusing is sufficient and
            // must not navigate a live voice tab away from its current screen.
            if (!destination) return;
            const opened = await postDestinationWithAck(c, {
              type: 'open-destination',
              tag: event.notification.tag || '',
              serverId: destination?.serverId || '',
              messageId: destination?.messageId,
            });
            if (opened) return;
            // includeUncontrolled can return a just-created/cold iOS page before main.tsx has
            // installed its listener. Only after bounded ACK failure do we navigate that focused
            // client; an acknowledged live voice page is never reloaded.
            const navigationClient = focusedClient && 'navigate' in focusedClient ? focusedClient : c;
            if ('navigate' in navigationClient) {
              const navigated = await settleNotificationState(
                Promise.resolve().then(() => navigationClient.navigate(url)),
                null,
              );
              if (navigated) return;
            }
          } catch (e) { /* a closing/discarded client must not block the next window */ }
        }
      }
      if (self.clients.openWindow) {
        await settleNotificationState(Promise.resolve().then(() => self.clients.openWindow(url)), null);
      }
    } catch (e) { /* ignore */ }
    finally {
      await tellClientsToForgetDestination(event.notification.tag);
    }
  })());
});

self.addEventListener('notificationclose', (event) => {
  event.waitUntil((async () => {
    const removed = await settleNotificationState(
      forgetDestination(event.notification.tag, event.notification.data || null),
      false,
    );
    if (removed) await tellClientsToForgetDestination(event.notification.tag);
  })());
});

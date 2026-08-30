export interface NotificationDestination {
  serverId: string;
  messageId?: number;
}

export const NOTIFICATION_DESTINATION_EVENT = 'relay:notification-destination';
export const TAURI_NOTIFICATION_DESTINATION_EVENT = 'relay-notification-destination';

const PENDING_KEY = 'relay.notification.destination.pending.v1';
const TAG_PREFIX = 'relay.notification.destination.tag.v1:';
const TAG_DESTINATION_TTL_MS = 48 * 60 * 60 * 1000;
const PENDING_DESTINATION_TTL_MS = 30 * 60 * 1000;
const MAX_TAG_DESTINATIONS = 64;
const MAX_PENDING_WORKER_MESSAGES = 64;
let lastTagDestinationTimestamp = 0;
let observedWorkerReady: PromiseLike<ServiceWorkerRegistration> | null = null;
let readyWorker: Pick<ServiceWorker, 'postMessage'> | null = null;
let workerControllerListenerInstalled = false;
const pendingWorkerMessages = new Map<string, unknown>();

interface StoredDestination {
  destination: NotificationDestination;
  updatedAt: number;
}

function nextTagDestinationTimestamp(): number {
  const now = Date.now();
  if (lastTagDestinationTimestamp > now + TAG_DESTINATION_TTL_MS) lastTagDestinationTimestamp = now;
  lastTagDestinationTimestamp = Math.max(now, lastTagDestinationTimestamp + 1);
  return lastTagDestinationTimestamp;
}

function normalizedDestinationTimestamp(value: unknown, fallback: number): number {
  const now = Date.now();
  const parsed = Number(value);
  const timestamp = Number.isFinite(parsed) && parsed > 0 && parsed <= now + TAG_DESTINATION_TTL_MS
    ? parsed : fallback;
  lastTagDestinationTimestamp = Math.max(lastTagDestinationTimestamp, timestamp);
  return timestamp;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Treat every notification transport as untrusted input before it can influence navigation. */
export function normalizeNotificationDestination(value: unknown): NotificationDestination | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { serverId?: unknown; messageId?: unknown; msgId?: unknown };
  const serverId = typeof raw.serverId === 'string' ? raw.serverId.trim() : '';
  if (!serverId || serverId.length > 128) return null;
  const messageId = positiveInteger(raw.messageId ?? raw.msgId);
  return { serverId, ...(messageId ? { messageId } : {}) };
}

/** Tags used by chat/stream notifications already contain the server id. */
export function notificationDestinationFromTag(tag?: string | null): NotificationDestination | null {
  const value = String(tag || '');
  const separator = value.indexOf(':');
  if (separator < 1) return null;
  const kind = value.slice(0, separator);
  if (kind !== 'mention' && kind !== 'stream' && kind !== 'msg') return null;
  const correlation = value.indexOf(':', separator + 1);
  const serverId = value.slice(separator + 1, correlation > separator ? correlation : undefined);
  return normalizeNotificationDestination({ serverId });
}

function tagKey(tag: string): string {
  return TAG_PREFIX + encodeURIComponent(tag);
}

function safeTagValue(tag: unknown): string {
  const value = typeof tag === 'string' ? tag.trim() : '';
  return value && value.length <= 256 ? value : '';
}

function hasCorrelation(tag: string): boolean {
  const first = tag.indexOf(':');
  return first > 0 && tag.indexOf(':', first + 1) > first + 1;
}

function parseStoredDestination(value: unknown, legacyAt = Date.now()): StoredDestination | null {
  const wrapped = value && typeof value === 'object' ? value as { destination?: unknown; updatedAt?: unknown } : {};
  const destination = normalizeNotificationDestination(wrapped.destination) || normalizeNotificationDestination(value);
  if (!destination) return null;
  return { destination, updatedAt: normalizedDestinationTimestamp(wrapped.updatedAt, legacyAt) };
}

function readTagDestination(tag: string): StoredDestination | null {
  try {
    const stored = sessionStorage.getItem(tagKey(tag));
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    const record = parseStoredDestination(parsed);
    if (!record || Date.now() - record.updatedAt > TAG_DESTINATION_TTL_MS) {
      sessionStorage.removeItem(tagKey(tag));
      return null;
    }
    if (Number(parsed?.updatedAt) !== record.updatedAt) {
      sessionStorage.setItem(tagKey(tag), JSON.stringify(record));
    }
    return record;
  } catch { return null; }
}

function pruneTagDestinations(now = Date.now()): void {
  try {
    const records: { key: string; updatedAt: number }[] = [];
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(TAG_PREFIX)) continue;
      let record: StoredDestination | null = null;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(sessionStorage.getItem(key) || 'null');
        record = parseStoredDestination(parsed, now);
      } catch { /**/ }
      if (!record || now - record.updatedAt > TAG_DESTINATION_TTL_MS) sessionStorage.removeItem(key);
      else {
        if (Number((parsed as { updatedAt?: unknown })?.updatedAt) !== record.updatedAt) {
          sessionStorage.setItem(key, JSON.stringify(record));
        }
        records.push({ key, updatedAt: record.updatedAt });
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of records.slice(MAX_TAG_DESTINATIONS)) sessionStorage.removeItem(record.key);
  } catch { /** sessionStorage can be unavailable */ }
}

function workerMessageKey(message: unknown): string {
  const value = message && typeof message === 'object'
    ? message as { type?: unknown; tag?: unknown }
    : {};
  return `${String(value.type || 'destination')}:${safeTagValue(value.tag)}`;
}

function enqueueWorkerMessage(message: unknown): void {
  const key = workerMessageKey(message);
  // Move replacements to the end so remember/forget operations retain their latest causal order.
  if (pendingWorkerMessages.has(key)) pendingWorkerMessages.delete(key);
  pendingWorkerMessages.set(key, message);
  while (pendingWorkerMessages.size > MAX_PENDING_WORKER_MESSAGES) {
    const oldest = pendingWorkerMessages.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingWorkerMessages.delete(oldest);
  }
}

function flushWorkerMessages(worker: Pick<ServiceWorker, 'postMessage'> | null | undefined): void {
  if (!worker) return;
  for (const [key, message] of [...pendingWorkerMessages]) {
    try { worker.postMessage(message); pendingWorkerMessages.delete(key); }
    catch { break; }
  }
}

function observeWorkerReadiness(serviceWorker: ServiceWorkerContainer): void {
  if (!workerControllerListenerInstalled && typeof serviceWorker.addEventListener === 'function') {
    workerControllerListenerInstalled = true;
    serviceWorker.addEventListener('controllerchange', () => {
      try {
        readyWorker = serviceWorker.controller || readyWorker;
        flushWorkerMessages(serviceWorker.controller);
      } catch { /** best-effort */ }
    });
  }
  if (observedWorkerReady) return;
  let ready: PromiseLike<ServiceWorkerRegistration>;
  try { ready = serviceWorker.ready; } catch { return; }
  // serviceWorker.ready can remain pending for the whole lifetime of a broken/unsupported install.
  // Observe that exact promise once; all later notification updates share the bounded queue below.
  observedWorkerReady = ready;
  void Promise.resolve(ready).then((registration) => {
    try {
      readyWorker = serviceWorker.controller || registration.active;
      flushWorkerMessages(readyWorker);
    } catch { /** best-effort */ }
  }, () => {
    if (observedWorkerReady === ready) observedWorkerReady = null;
  });
}

function postDestinationMessageToServiceWorker(message: unknown): void {
  try {
    if (!('serviceWorker' in navigator)) return;
    const serviceWorker = navigator.serviceWorker;
    const worker = serviceWorker.controller || readyWorker;
    if (worker) {
      if (pendingWorkerMessages.size) {
        enqueueWorkerMessage(message);
        flushWorkerMessages(worker);
        return;
      }
      try { worker.postMessage(message); return; } catch { /** queue for the replacement worker */ }
    }
    enqueueWorkerMessage(message);
    observeWorkerReadiness(serviceWorker);
  } catch { /** notifications are best-effort */ }
}

/**
 * Associates a replaceable OS-notification tag with its latest exact chat destination. Realtime
 * chat can display the notification before the HTTP insert returns a message id; notify-WS fills
 * that id in later without having to flash a second notification.
 */
export function rememberNotificationDestination(tag: string | undefined, value: unknown): NotificationDestination | null {
  let destination = normalizeNotificationDestination(value);
  const safeTag = safeTagValue(tag);
  if (!destination || !safeTag) return destination;
  try {
    pruneTagDestinations();
    const previous = readTagDestination(safeTag)?.destination || null;
    // A late realtime banner only knows its server. It must not erase the exact DB id already
    // delivered by notify-WS for the same replaceable notification.
    if (hasCorrelation(safeTag) && previous?.serverId === destination.serverId && previous.messageId && !destination.messageId) destination = previous;
    sessionStorage.setItem(tagKey(safeTag), JSON.stringify({
      destination, updatedAt: nextTagDestinationTimestamp(),
    } satisfies StoredDestination));
    pruneTagDestinations();
  } catch { /**/ }
  postDestinationMessageToServiceWorker({ type: 'remember-notification-destination', tag: safeTag, destination });
  return destination;
}

export function resolveNotificationDestination(tag?: string | null, fallback?: unknown): NotificationDestination | null {
  const safeTag = safeTagValue(tag);
  const explicit = normalizeNotificationDestination(fallback);
  if (explicit?.messageId) return explicit;
  if (safeTag) {
    try {
      const destination = readTagDestination(safeTag)?.destination || null;
      if (destination && (!explicit || destination.serverId === explicit.serverId)) return destination;
    } catch { /**/ }
  }
  return explicit || notificationDestinationFromTag(safeTag);
}

/** Remove only the tag that was clicked/closed; other replaceable notification correlations stay. */
export function forgetNotificationDestination(tag: unknown, notifyWorker = true): boolean {
  const safeTag = safeTagValue(tag);
  if (!safeTag) return false;
  try { sessionStorage.removeItem(tagKey(safeTag)); } catch { return false; }
  if (notifyWorker) postDestinationMessageToServiceWorker({ type: 'forget-notification-destination', tag: safeTag });
  return true;
}

/** Store until ServerView has mounted, and also wake any already-mounted listener. */
export function queueNotificationDestination(value: unknown): NotificationDestination | null {
  const destination = normalizeNotificationDestination(value);
  if (!destination) return null;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ destination, updatedAt: Date.now() } satisfies StoredDestination)); } catch { /**/ }
  try { window.dispatchEvent(new CustomEvent<NotificationDestination>(NOTIFICATION_DESTINATION_EVENT, { detail: destination })); } catch { /**/ }
  return destination;
}

export function peekNotificationDestination(serverId?: string): NotificationDestination | null {
  try {
    const stored = sessionStorage.getItem(PENDING_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    const record = parsed ? parseStoredDestination(parsed) : null;
    if (record && Date.now() - record.updatedAt > PENDING_DESTINATION_TTL_MS) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    if (record && Number(parsed?.updatedAt) !== record.updatedAt) {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(record));
    }
    const destination = record?.destination || null;
    return destination && (!serverId || destination.serverId === serverId) ? destination : null;
  } catch { return null; }
}

export function clearNotificationDestination(expected?: NotificationDestination): boolean {
  const current = peekNotificationDestination();
  if (!current) return true;
  if (expected && (current.serverId !== expected.serverId || current.messageId !== expected.messageId)) return false;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { return false; }
  return true;
}

export function notificationDestinationUrl(destination: NotificationDestination): string {
  const query = new URLSearchParams({ server: destination.serverId });
  if (destination.messageId) query.set('message', String(destination.messageId));
  return '/?' + query.toString();
}

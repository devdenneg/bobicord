export interface NotificationDestination {
  serverId: string;
  messageId?: number;
}

export const NOTIFICATION_DESTINATION_EVENT = 'relay:notification-destination';
export const TAURI_NOTIFICATION_DESTINATION_EVENT = 'relay-notification-destination';

const PENDING_KEY = 'relay.notification.destination.pending.v1';
const TAG_PREFIX = 'relay.notification.destination.tag.v1:';

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

function hasCorrelation(tag: string): boolean {
  const first = tag.indexOf(':');
  return first > 0 && tag.indexOf(':', first + 1) > first + 1;
}

function postDestinationToServiceWorker(tag: string, destination: NotificationDestination): void {
  try {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.ready.then((registration) => {
      registration.active?.postMessage({ type: 'remember-notification-destination', tag, destination });
    }).catch(() => {});
  } catch { /** notifications are best-effort */ }
}

/**
 * Associates a replaceable OS-notification tag with its latest exact chat destination. Realtime
 * chat can display the notification before the HTTP insert returns a message id; notify-WS fills
 * that id in later without having to flash a second notification.
 */
export function rememberNotificationDestination(tag: string | undefined, value: unknown): NotificationDestination | null {
  let destination = normalizeNotificationDestination(value);
  const safeTag = String(tag || '').trim();
  if (!destination || !safeTag) return destination;
  try {
    const stored = sessionStorage.getItem(tagKey(safeTag));
    const previous = stored ? normalizeNotificationDestination(JSON.parse(stored)) : null;
    // A late realtime banner only knows its server. It must not erase the exact DB id already
    // delivered by notify-WS for the same replaceable notification.
    if (hasCorrelation(safeTag) && previous?.serverId === destination.serverId && previous.messageId && !destination.messageId) destination = previous;
    sessionStorage.setItem(tagKey(safeTag), JSON.stringify(destination));
  } catch { /**/ }
  postDestinationToServiceWorker(safeTag, destination);
  return destination;
}

export function resolveNotificationDestination(tag?: string | null, fallback?: unknown): NotificationDestination | null {
  const safeTag = String(tag || '').trim();
  const explicit = normalizeNotificationDestination(fallback);
  if (explicit?.messageId) return explicit;
  if (safeTag) {
    try {
      const stored = sessionStorage.getItem(tagKey(safeTag));
      if (stored) {
        const destination = normalizeNotificationDestination(JSON.parse(stored));
        if (destination && (!explicit || destination.serverId === explicit.serverId)) return destination;
      }
    } catch { /**/ }
  }
  return explicit || notificationDestinationFromTag(safeTag);
}

/** Store until ServerView has mounted, and also wake any already-mounted listener. */
export function queueNotificationDestination(value: unknown): NotificationDestination | null {
  const destination = normalizeNotificationDestination(value);
  if (!destination) return null;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(destination)); } catch { /**/ }
  try { window.dispatchEvent(new CustomEvent<NotificationDestination>(NOTIFICATION_DESTINATION_EVENT, { detail: destination })); } catch { /**/ }
  return destination;
}

export function peekNotificationDestination(serverId?: string): NotificationDestination | null {
  try {
    const stored = sessionStorage.getItem(PENDING_KEY);
    const destination = stored ? normalizeNotificationDestination(JSON.parse(stored)) : null;
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

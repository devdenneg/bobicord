export interface PendingPushCleanup {
  userId: string;
  endpoint: string;
  queuedAt: number;
}

export interface PushBinding {
  userId: string;
  endpoint: string;
  vapidKey: string;
  boundAt: number;
}

const PENDING_PUSH_CLEANUP_KEY = 'relay.push.pending-cleanup.v1';
const PUSH_BINDING_KEY = 'relay.push.binding.v1';
const MAX_PENDING_PUSH_CLEANUPS = 32;
let inMemoryPendingPushCleanups: PendingPushCleanup[] = [];
let inMemoryPushBinding: PushBinding | null = null;
let pendingPushMemoryDirty = false;
let pushBindingMemoryDirty = false;

function safeUserId(value: unknown): string {
  const userId = typeof value === 'string' ? value.trim() : '';
  return userId && userId.length <= 128 ? userId : '';
}

function safeEndpoint(value: unknown): string {
  const endpoint = typeof value === 'string' ? value.trim() : '';
  if (!endpoint || endpoint.length > 2048) return '';
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' ? endpoint : '';
  } catch { return ''; }
}

function readPending(): PendingPushCleanup[] {
  let input: unknown[];
  if (pendingPushMemoryDirty) {
    // A prior write failed (quota/private mode). Its exact add/remove intent must not be overwritten
    // by an older readable value which the browser refused to update.
    input = inMemoryPendingPushCleanups;
  } else {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(PENDING_PUSH_CLEANUP_KEY) || '[]');
      // When storage is readable it is authoritative. This prevents another tab's successful cleanup
      // from being resurrected by this tab's stale memory mirror.
      input = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Locked-down/private storage still gets an exact in-process logout fallback.
      input = inMemoryPendingPushCleanups;
    }
  }
  const byIdentity = new Map<string, PendingPushCleanup>();
  for (const value of input) {
    const candidate = value && typeof value === 'object' ? value as Partial<PendingPushCleanup> : {};
    const userId = safeUserId(candidate.userId);
    const endpoint = safeEndpoint(candidate.endpoint);
    const queuedAt = Number.isFinite(Number(candidate.queuedAt)) ? Number(candidate.queuedAt) : 0;
    const identity = userId + '\n' + endpoint;
    if (!userId || !endpoint) continue;
    const previous = byIdentity.get(identity);
    if (!previous || queuedAt >= previous.queuedAt) byIdentity.set(identity, { userId, endpoint, queuedAt });
  }
  const records = [...byIdentity.values()].sort((a, b) => a.queuedAt - b.queuedAt).slice(-MAX_PENDING_PUSH_CLEANUPS);
  inMemoryPendingPushCleanups = records;
  return records;
}

function writePending(records: PendingPushCleanup[]): void {
  inMemoryPendingPushCleanups = records.slice(-MAX_PENDING_PUSH_CLEANUPS);
  try {
    if (inMemoryPendingPushCleanups.length) localStorage.setItem(PENDING_PUSH_CLEANUP_KEY, JSON.stringify(inMemoryPendingPushCleanups));
    else localStorage.removeItem(PENDING_PUSH_CLEANUP_KEY);
    pendingPushMemoryDirty = false;
  } catch {
    pendingPushMemoryDirty = true;
    // Cleanup is also retained by the server logout transaction when storage is unavailable.
  }
}

export function pendingPushCleanups(): PendingPushCleanup[] {
  return readPending();
}

export function queuePushCleanup(userIdValue: unknown, endpointValue: unknown): boolean {
  const userId = safeUserId(userIdValue);
  const endpoint = safeEndpoint(endpointValue);
  if (!userId || !endpoint) return false;
  const records = readPending().filter((record) => record.userId !== userId || record.endpoint !== endpoint);
  records.push({ userId, endpoint, queuedAt: Date.now() });
  writePending(records);
  return true;
}

export function clearPushCleanups(userIdValue: unknown, endpointsValue: unknown): void {
  const userId = safeUserId(userIdValue);
  const endpoints = new Set(Array.isArray(endpointsValue) ? endpointsValue.map(safeEndpoint).filter(Boolean) : []);
  if (!userId || endpoints.size === 0) return;
  writePending(readPending().filter((record) => record.userId !== userId || !endpoints.has(record.endpoint)));
}

export function readPushBinding(): PushBinding | null {
  if (pushBindingMemoryDirty) return inMemoryPushBinding;
  try {
    const value = JSON.parse(localStorage.getItem(PUSH_BINDING_KEY) || 'null');
    const userId = safeUserId(value?.userId);
    const endpoint = safeEndpoint(value?.endpoint);
    const vapidKey = typeof value?.vapidKey === 'string' && value.vapidKey.length <= 512 ? value.vapidKey : '';
    const boundAt = Number.isFinite(Number(value?.boundAt)) ? Number(value.boundAt) : 0;
    if (userId && endpoint && vapidKey) {
      inMemoryPushBinding = { userId, endpoint, vapidKey, boundAt };
      pushBindingMemoryDirty = false;
      return inMemoryPushBinding;
    }
    // A readable missing/invalid value may be another tab's opt-out/logout and must win over memory.
    inMemoryPushBinding = null;
    return null;
  } catch { return inMemoryPushBinding; }
}

export function rememberPushBinding(userIdValue: unknown, endpointValue: unknown, vapidKeyValue: unknown): boolean {
  const userId = safeUserId(userIdValue);
  const endpoint = safeEndpoint(endpointValue);
  const vapidKey = typeof vapidKeyValue === 'string' && vapidKeyValue.length <= 512 ? vapidKeyValue : '';
  if (!userId || !endpoint || !vapidKey) return false;
  inMemoryPushBinding = { userId, endpoint, vapidKey, boundAt: Date.now() };
  try {
    localStorage.setItem(PUSH_BINDING_KEY, JSON.stringify(inMemoryPushBinding));
    pushBindingMemoryDirty = false;
    return true;
  } catch {
    pushBindingMemoryDirty = true;
    return true;
  }
}

/**
 * Records an endpoint before its backend request starts and confirms that another tab can read the
 * exact ownership. An in-memory-only fallback is useful for same-tab cleanup, but is insufficient
 * for a concurrent logout transaction in a different tab.
 */
export function rememberProvisionalPushBinding(
  userIdValue: unknown,
  endpointValue: unknown,
  vapidKeyValue: unknown,
): boolean {
  if (!rememberPushBinding(userIdValue, endpointValue, vapidKeyValue) || pushBindingMemoryDirty) return false;
  try {
    const stored = JSON.parse(localStorage.getItem(PUSH_BINDING_KEY) || 'null');
    return safeUserId(stored?.userId) === safeUserId(userIdValue)
      && safeEndpoint(stored?.endpoint) === safeEndpoint(endpointValue)
      && stored?.vapidKey === vapidKeyValue;
  } catch { return false; }
}

export function clearPushBinding(expectedEndpoint = ''): void {
  const current = readPushBinding();
  if (expectedEndpoint && current?.endpoint !== expectedEndpoint) return;
  inMemoryPushBinding = null;
  try {
    localStorage.removeItem(PUSH_BINDING_KEY);
    pushBindingMemoryDirty = false;
  } catch { pushBindingMemoryDirty = true; }
}

/** Must run synchronously before the auth logout fence hides the resumable account. */
export function preparePushLogout(userIdValue: unknown): void {
  const userId = safeUserId(userIdValue);
  const binding = readPushBinding();
  if (userId && binding?.userId === userId) queuePushCleanup(userId, binding.endpoint);
}

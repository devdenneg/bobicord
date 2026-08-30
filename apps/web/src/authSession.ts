export const LEGACY_SESSION_STORAGE_KEY = 'sess';
export const PERSISTENT_LOGOUT_STORAGE_KEY = 'relay.auth.logged-out.v1';
export const PENDING_LEGACY_LOGOUT_STORAGE_KEY = 'relay.auth.pending-legacy-logouts.v1';
export const PERSISTENT_CSRF_COOKIE = '__Host-relay_csrf';
export const PERSISTENT_AUTH_PROTOCOL = 'persistent-v1' as const;

export type AuthSessionMode = 'anonymous' | 'legacy' | 'persistent';
export type AccessTokenChangeReason = 'legacy' | 'persistent' | 'refresh' | 'cleared'
  | 'remote-logout' | 'terminal-revocation';

export interface PersistentAuthBundle {
  protocol: typeof PERSISTENT_AUTH_PROTOCOL;
  token: string;
  accessToken: string;
  accessExpiresAt: number;
  sessionId: string;
  user: Record<string, unknown>;
  account: Record<string, unknown>;
}

export interface AccessTokenChange {
  previousToken: string | null;
  token: string | null;
  mode: AuthSessionMode;
  reason: AccessTokenChangeReason;
}

type AccessTokenListener = (change: AccessTokenChange) => void;

function browserStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

function storedValue(key: string): string {
  try { return String(browserStorage()?.getItem(key) || ''); }
  catch { return ''; }
}

function setStoredValue(key: string, value: string | null): void {
  try {
    const storage = browserStorage();
    if (!storage) return;
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch { /** Storage can be unavailable in private/locked-down webviews. */ }
}

// The durable marker is authoritative across reloads/tabs. Keep the same marker in this module as
// a best-effort fallback when a privacy mode or locked-down webview makes localStorage throw: the
// current process can still revoke its HttpOnly refresh cookie instead of immediately resurrecting.
let inMemoryLogoutFence = '';
let inMemoryPendingLegacyLogoutTokens: string[] = [];

function initialLegacyToken(): string | null {
  if (storedValue(PERSISTENT_LOGOUT_STORAGE_KEY)) return null;
  const value = storedValue(LEGACY_SESSION_STORAGE_KEY).trim();
  return value || null;
}

let accessToken: string | null = initialLegacyToken();
let mode: AuthSessionMode = accessToken ? 'legacy' : 'anonymous';
let accessExpiresAt = 0;
let persistentSessionId: string | null = null;
let sessionRevision = 0;
const listeners = new Set<AccessTokenListener>();

function emit(previousToken: string | null, reason: AccessTokenChangeReason): void {
  if (previousToken === accessToken && reason !== 'cleared') return;
  const event: AccessTokenChange = { previousToken, token: accessToken, mode, reason };
  for (const listener of listeners) {
    try { listener(event); } catch { /** One transport listener must not break auth state. */ }
  }
}

export function getAccessToken(): string | null { return accessToken; }
export function authSessionMode(): AuthSessionMode { return mode; }
export function persistentSessionActive(): boolean { return mode === 'persistent' && !!accessToken; }
export function persistentSessionIdentifier(): string | null { return persistentSessionId; }
export function authSessionRevision(): number { return sessionRevision; }

export function legacyMigrationToken(): string | null {
  if (persistentResumeSuppressed()) return null;
  if (mode === 'legacy' && accessToken) return accessToken;
  const stored = initialLegacyToken();
  return stored || null;
}

export function persistentResumeSuppressed(): boolean {
  return !!persistentLogoutFence();
}

export function persistentLogoutFence(): string {
  const durable = storedValue(PERSISTENT_LOGOUT_STORAGE_KEY);
  if (durable) inMemoryLogoutFence = durable;
  return durable || inMemoryLogoutFence;
}

export function markPersistentLogoutPending(): string {
  const marker = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.${Math.random().toString(36).slice(2)}`;
  inMemoryLogoutFence = marker;
  setStoredValue(PERSISTENT_LOGOUT_STORAGE_KEY, marker);
  // Storage events do not fire in the tab which performed the write. Bump the local revision too,
  // so a same-tab login/refresh already in flight cannot commit after logout wins.
  sessionRevision += 1;
  return marker;
}

export function beginAuthLogoutFence(): string {
  const marker = persistentLogoutFence() || markPersistentLogoutPending();
  // Keep the captured bearer in memory just long enough for best-effort push cleanup, but make a
  // crash/reload unable to treat it as a resumable account. The pending legacy queue owns revocation.
  setStoredValue(LEGACY_SESSION_STORAGE_KEY, null);
  return marker;
}

export function clearPersistentLogoutPending(expectedFence = ''): boolean {
  const current = persistentLogoutFence();
  if (expectedFence && current !== expectedFence) return false;
  setStoredValue(PERSISTENT_LOGOUT_STORAGE_KEY, null);
  if (!expectedFence || inMemoryLogoutFence === expectedFence) inMemoryLogoutFence = '';
  return true;
}

export function pendingLegacyLogoutTokens(): string[] {
  const raw = storedValue(PENDING_LEGACY_LOGOUT_STORAGE_KEY);
  let stored: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      stored = parsed.filter((value): value is string => (
        typeof value === 'string' && value.length > 0 && value.length <= 16_384
      ));
    }
  } catch { /** A malformed durable queue must not hide the valid in-memory fallback. */ }
  return [...new Set([...stored, ...inMemoryPendingLegacyLogoutTokens])];
}

export function queueLegacyLogoutToken(token: string): void {
  const normalized = String(token || '').trim();
  if (!normalized || normalized.length > 16_384) return;
  const pending = pendingLegacyLogoutTokens();
  if (!pending.includes(normalized)) pending.push(normalized);
  inMemoryPendingLegacyLogoutTokens = pending;
  setStoredValue(PENDING_LEGACY_LOGOUT_STORAGE_KEY, JSON.stringify(pending));
}

export function removePendingLegacyLogoutToken(token: string): void {
  const pending = pendingLegacyLogoutTokens().filter((value) => value !== token);
  inMemoryPendingLegacyLogoutTokens = pending;
  setStoredValue(PENDING_LEGACY_LOGOUT_STORAGE_KEY, pending.length ? JSON.stringify(pending) : null);
}

export function readPersistentCsrfCookie(cookieSource?: string): string | null {
  let source = cookieSource;
  if (source === undefined) {
    try { source = typeof document === 'undefined' ? '' : document.cookie; }
    catch { source = ''; }
  }
  for (const entry of String(source || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== PERSISTENT_CSRF_COOKIE) continue;
    const value = entry.slice(separator + 1).trim();
    return value && value.length <= 512 ? value : null;
  }
  return null;
}

export function hasPersistentResumeCandidate(): boolean {
  return !persistentResumeSuppressed() && !!readPersistentCsrfCookie();
}

export function hasSessionCandidate(): boolean {
  return !!legacyMigrationToken() || hasPersistentResumeCandidate() || persistentSessionActive();
}

export function accessTokenExpiresAt(): number { return accessExpiresAt; }

export function accessTokenNeedsRefresh(now = Date.now(), skewMs = 30_000): boolean {
  return persistentSessionActive() && (!Number.isFinite(accessExpiresAt) || accessExpiresAt <= now + skewMs);
}

export function accessTokenStillUsable(now = Date.now()): boolean {
  return persistentSessionActive() && Number.isFinite(accessExpiresAt) && accessExpiresAt > now;
}

function exactPersistentBundle(value: unknown): PersistentAuthBundle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.protocol !== PERSISTENT_AUTH_PROTOCOL) return null;
  const token = typeof raw.token === 'string' ? raw.token : '';
  const access = typeof raw.accessToken === 'string' ? raw.accessToken : '';
  const expires = Number(raw.accessExpiresAt);
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  const user = raw.user && typeof raw.user === 'object' && !Array.isArray(raw.user)
    ? raw.user as Record<string, unknown> : null;
  const account = raw.account && typeof raw.account === 'object' && !Array.isArray(raw.account)
    ? raw.account as Record<string, unknown> : null;
  if (!token || token !== access || token.length > 16_384) return null;
  if (!Number.isSafeInteger(expires) || expires <= Date.now() - 5_000) return null;
  if (!sessionId || sessionId.length > 256) return null;
  if (!user || typeof user.id !== 'string' || !user.id || typeof user.username !== 'string') return null;
  if (!account || !['ready', 'email_required', 'email_verification'].includes(String(account.state || ''))) return null;
  return { protocol: PERSISTENT_AUTH_PROTOCOL, token, accessToken: access, accessExpiresAt: expires, sessionId, user, account };
}

function commitPersistentBundle(
  bundle: PersistentAuthBundle,
  reason: 'persistent' | 'refresh',
): PersistentAuthBundle {
  const previousToken = accessToken;
  // The legacy credential is removed only after a complete, exact persistent-v1
  // response has supplied its in-memory replacement.
  accessToken = bundle.accessToken;
  accessExpiresAt = bundle.accessExpiresAt;
  persistentSessionId = bundle.sessionId;
  mode = 'persistent';
  sessionRevision += 1;
  setStoredValue(LEGACY_SESSION_STORAGE_KEY, null);
  emit(previousToken, reason);
  return bundle;
}

export function installPersistentAuthBundle(
  value: unknown,
  reason: 'persistent' | 'refresh' = 'persistent',
  expectedRevision: number = sessionRevision,
): PersistentAuthBundle | null {
  const bundle = exactPersistentBundle(value);
  // localStorage is shared by tabs while auth revisions are not. A logout in any other tab must
  // fence an already in-flight refresh/security/login response in this tab; otherwise that late
  // response can erase the anti-resurrection marker and reinstall an ambient HttpOnly cookie.
  if (!bundle
    || expectedRevision !== sessionRevision
    || persistentResumeSuppressed()
    || (reason === 'refresh' && persistentSessionId && bundle.sessionId !== persistentSessionId)) return null;
  return commitPersistentBundle(bundle, reason);
}

export function installPersistentAuthMutationBundle(
  value: unknown,
  expectedSessionId: string | null,
): PersistentAuthBundle | null {
  const bundle = exactPersistentBundle(value);
  // A password/email mutation rotates the account security version. Its new access token must win
  // over a same-session refresh that happened to finish first, otherwise the UI reports a failure
  // after the mutation was already committed and keeps an immediately stale access token. Never
  // cross a logout fence or an account/session switch while relaxing only the tab-local revision.
  if (!bundle
    || !expectedSessionId
    || bundle.sessionId !== expectedSessionId
    || mode !== 'persistent'
    || persistentSessionId !== expectedSessionId
    || persistentResumeSuppressed()) return null;
  return commitPersistentBundle(bundle, 'persistent');
}

// Compatibility entry point used by existing auth screens. A token returned by
// persistent-v1 has already been installed by api.ts, so the following setToken
// call remains memory-only. A response from an old server stays in localStorage.
export function setAccessToken(token: string | null): void {
  const normalized = typeof token === 'string' ? token.trim() : '';
  const previousToken = accessToken;
  if (normalized) {
    if (mode === 'persistent' && normalized === accessToken) return;
    accessToken = normalized;
    accessExpiresAt = 0;
    persistentSessionId = null;
    mode = 'legacy';
    sessionRevision += 1;
    setStoredValue(LEGACY_SESSION_STORAGE_KEY, normalized);
    emit(previousToken, 'legacy');
    return;
  }
  // setToken(null) is the compatibility entry point for an explicit account switch. Capture a
  // rolling legacy bearer before removing it, otherwise the browser can no longer ask a new server
  // to persist the exact hash-only revocation tombstone. Terminal/remote clears use separate paths.
  if (mode === 'legacy' && previousToken) queueLegacyLogoutToken(previousToken);
  accessToken = null;
  accessExpiresAt = 0;
  persistentSessionId = null;
  mode = 'anonymous';
  sessionRevision += 1;
  setStoredValue(LEGACY_SESSION_STORAGE_KEY, null);
  // A server cookie may survive an offline logout. This non-secret tombstone
  // prevents a reload from silently restoring it before the next explicit login.
  if (!persistentResumeSuppressed()) markPersistentLogoutPending();
  emit(previousToken, 'cleared');
}

export function clearTerminalAuthSession(): void {
  const previousToken = accessToken;
  accessToken = null;
  accessExpiresAt = 0;
  persistentSessionId = null;
  mode = 'anonymous';
  sessionRevision += 1;
  setStoredValue(LEGACY_SESSION_STORAGE_KEY, null);
  if (!persistentResumeSuppressed()) markPersistentLogoutPending();
  emit(previousToken, 'terminal-revocation');
}

function clearAccessFromAnotherTab(): void {
  if (!accessToken && mode === 'anonymous') return;
  const previousToken = accessToken;
  accessToken = null;
  accessExpiresAt = 0;
  persistentSessionId = null;
  mode = 'anonymous';
  sessionRevision += 1;
  setStoredValue(LEGACY_SESSION_STORAGE_KEY, null);
  emit(previousToken, 'remote-logout');
}

/**
 * iOS/BFCache can skip a storage event while the page is frozen. The durable logout marker is
 * authoritative, so every foreground entry reconciles memory synchronously before reconnects or
 * other lifecycle handlers can issue authenticated network traffic.
 */
export function reconcileDurableLogoutFence(): boolean {
  const durable = storedValue(PERSISTENT_LOGOUT_STORAGE_KEY);
  if (!durable) return false;
  inMemoryLogoutFence = durable;
  clearAccessFromAnotherTab();
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== PERSISTENT_LOGOUT_STORAGE_KEY) return;
    if (event.newValue) {
      inMemoryLogoutFence = event.newValue;
      clearAccessFromAnotherTab();
    } else if (!event.oldValue || inMemoryLogoutFence === event.oldValue) {
      inMemoryLogoutFence = '';
    }
  });
  const reconcileOnForeground = () => { reconcileDurableLogoutFence(); };
  window.addEventListener('pageshow', reconcileOnForeground);
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reconcileOnForeground();
    });
  } catch { /** document can be absent in auth unit/worker-like environments */ }
}

export function subscribeAccessTokenChanges(listener: AccessTokenListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Test-only reset kept explicit and harmless in production bundles.
export function resetAuthSessionForTests(): void {
  const restored = initialLegacyToken();
  accessToken = restored;
  mode = accessToken ? 'legacy' : 'anonymous';
  accessExpiresAt = 0;
  persistentSessionId = null;
  sessionRevision = 0;
  inMemoryLogoutFence = storedValue(PERSISTENT_LOGOUT_STORAGE_KEY);
  inMemoryPendingLegacyLogoutTokens = [];
  listeners.clear();
}

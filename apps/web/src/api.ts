import type {
  User, ServerSummary, Member, ServerDetail, InvitePreview, HistoryMessage, Role, VoiceChannel,
  Attachment, AdminOverview, Emote, AuthResponse, ChallengeResponse,
  RegistrationInvite, ReleaseHistoryResponse, SessionResponse, PersistentSessionResponse, NotificationPrivacy,
} from './types';
import {
  PERSISTENT_AUTH_PROTOCOL,
  accessTokenNeedsRefresh,
  accessTokenStillUsable,
  authSessionRevision,
  beginAuthLogoutFence,
  clearTerminalAuthSession,
  clearPersistentLogoutPending,
  getAccessToken,
  hasPersistentResumeCandidate,
  hasSessionCandidate as hasStoredSessionCandidate,
  installPersistentAuthBundle,
  installPersistentAuthMutationBundle,
  legacyMigrationToken,
  pendingLegacyLogoutTokens,
  persistentLogoutFence,
  persistentResumeSuppressed,
  persistentSessionActive,
  persistentSessionIdentifier,
  queueLegacyLogoutToken,
  readPersistentCsrfCookie,
  removePendingLegacyLogoutToken,
  setAccessToken,
  subscribeAccessTokenChanges,
} from './authSession';
import { clearPushCleanups, pendingPushCleanups } from './pushCleanup';
import { AppLatestLoader } from './appLatest';
import {
  NativeAuthBrokerError,
  beginNativeLogout,
  changeNativePassword,
  drainNativeLogout,
  loginNativeAuth,
  refreshNativeAuth,
  resumeNativeAuth,
  verifyNativeEmail,
  verifyNativeRegistration,
} from './nativeAuthBroker';

export const getToken = getAccessToken;
export const setToken = setAccessToken;
export function hasSessionCandidate(): boolean {
  if (persistentResumeSuppressed()) return false;
  // HttpOnly refresh state is deliberately invisible to JavaScript. On browser boot we therefore
  // perform one exact-origin recover probe even when the readable CSRF partner is missing; a 401
  // means anonymous, while a valid cookie restores the account instead of being overwritten.
  return hasStoredSessionCandidate() || PERSISTENT_COOKIE_TRANSPORT || IS_TAURI;
}

// Прод-бэкенд по умолчанию для НАТИВНОЙ сборки: вебвью Tauri грузит локальный bundle
// с origin tauri://localhost, поэтому относительный `/api` резолвится в сам bundle
// (Tauri отдаёт index.html на любой не-ассетный путь → 200 HTML → JSON.parse падает →
// пустой ответ → me/servers undefined → краш на home). В вебе origin тот же, что и бэк
// (Caddy), поэтому база пустая. Явный VITE_API_BASE_URL переопределяет оба случая.
// Тот же приём, что и treeWsUrl() в native.ts для ws-дерева.
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const PERSISTENT_COOKIE_TRANSPORT = !IS_TAURI;
const PROD_API = 'https://reelay.online'; // прод-бэкенд для НАТИВНОЙ сборки (веб — относит. пути); легаси sslip.io Caddy тоже отдаёт
const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || (IS_TAURI ? PROD_API : '');
const appLatestLoader = new AppLatestLoader(API_BASE + '/api/app/latest');

// Сервер отдаёт относительные пути (`/api/uploads/<name>`, см. index.js) — в вебе это
// корректно (Caddy проксирует тот же origin), но в Tauri вебвью грузит локальный bundle
// со своим origin (tauri://localhost), относительный путь резолвится ТУДА, не на бэкенд.
// Оставляем хранимое значение (avatarUrl/img) относительным (сервер валидирует именно
// такой формат при записи, UPLOAD_RE) — префиксуем только для <img src> на рендере.
export function resolveUploadUrl(u: string): string;
export function resolveUploadUrl(u: string | undefined): string | undefined;
export function resolveUploadUrl(u?: string): string | undefined {
  if (!u || !API_BASE || /^https?:\/\//i.test(u)) return u;
  return API_BASE + u;
}

// Origin веб-приложения для внешних ссылок (инвайты). В нативе location.origin =
// tauri.localhost, поэтому берём прод-хост (Caddy отдаёт и веб, и API на одном origin).
// В вебе API_BASE пуст → location.origin. Инвайт всегда должен открываться в браузере.
export function webOrigin(): string {
  return API_BASE || location.origin;
}

export interface VoiceLease {
  sessionId: string;
  serverId: string;
  channelId: string;
  epoch: number;
  claimedAt: number;
}
export interface VoiceLeaseEvent {
  ok?: boolean;
  t: 'voice-lease';
  reason: 'snapshot' | 'minted' | 'claimed' | 'idempotent' | 'released' | 'stale' | 'stale-ticket' | 'consumed' | 'ticket-required' | 'revoked' | 'request-aborted' | 'session-gone' | 'membership-revoked' | 'channel-deleted' | 'server-revoked' | 'server-deleted' | 'account-deleted';
  lease: VoiceLease | null;
  currentEpoch: number;
  accepted?: boolean;
  released?: boolean;
}
export interface VoiceIntentTicket extends VoiceLeaseEvent {
  ticket: number;
  clientIntent: number;
  idempotent?: boolean;
}
export interface VoiceMediaTokenResponse {
  ok: true;
  token: string;
  url: string;
  room: string;
  identity: string;
  epoch: number;
}
export interface VoiceMediaActivationResponse {
  ok: true;
  room: string;
  epoch: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryAfter?: number;
  readonly details?: Record<string, unknown>;
  readonly attemptsRemaining?: number;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    field?: string;
    retryAfter?: number;
    details?: Record<string, unknown>;
    attemptsRemaining?: number;
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status || 0;
    this.code = options.code || 'UNKNOWN_ERROR';
    this.field = options.field;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
    this.attemptsRemaining = options.attemptsRemaining;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

function nativeBrokerApiError(error: unknown): ApiError {
  if (!(error instanceof NativeAuthBrokerError)) {
    return new ApiError('Не удалось обработать защищённую сессию', { code: 'NATIVE_AUTH_ERROR' });
  }
  return new ApiError(error.message, {
    status: error.status,
    code: error.code,
    retryAfter: error.retryAfter,
    details: error.details,
    attemptsRemaining: error.attemptsRemaining,
  });
}

async function nativeBrokerCall<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) { throw nativeBrokerApiError(error); }
}

interface RequestOptions {
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  persistentBootstrap?: boolean;
  authSessionMutation?: boolean;
  skipAuthRefresh?: boolean;
  authRetried?: boolean;
  authCookieLockHeld?: boolean;
  requireStableAuth?: boolean;
}

const PERSISTENT_COOKIE_AUTH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Relay-Auth-Protocol': PERSISTENT_AUTH_PROTOCOL,
  'X-Relay-Auth-Transport': 'cookie-v1',
});
const PERSISTENT_NATIVE_AUTH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Relay-Auth-Protocol': PERSISTENT_AUTH_PROTOCOL,
  'X-Relay-Auth-Transport': 'bearer-v1',
});
const PERSISTENT_AUTH_HEADERS = IS_TAURI
  ? PERSISTENT_NATIVE_AUTH_HEADERS
  : PERSISTENT_COOKIE_AUTH_HEADERS;

function apiCredentials(persistent: boolean): RequestCredentials {
  // Native refresh state is brokered by Rust and must never be mirrored into a WebView cookie jar.
  if (IS_TAURI) return 'omit';
  return persistent ? 'include' : 'same-origin';
}

const CANONICAL_CHAT_PROTOCOL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Relay-Chat-Protocol': 'canonical-v1',
});

function chatMutationOptions(canonicalTransport: boolean): RequestOptions {
  return canonicalTransport ? { headers: CANONICAL_CHAT_PROTOCOL_HEADERS as Record<string, string> } : {};
}

function retryAfterSeconds(response: Response, data: any): number | undefined {
  const raw = data?.error?.retryAfter ?? data?.error?.details?.retryAfter ?? data?.retryAfter;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

function responseError(response: Response, data: any): ApiError {
  const raw = data?.error;
  const detail = raw && typeof raw === 'object' ? raw : data;
  const message = typeof raw === 'string' ? raw : detail?.message || 'Ошибка ' + response.status;
  const details = detail?.details && typeof detail.details === 'object' ? detail.details as Record<string, unknown> : undefined;
  const attemptsRemaining = Number(detail?.attemptsRemaining ?? details?.attemptsRemaining);
  return new ApiError(message, {
    status: response.status,
    code: detail?.code || (response.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR'),
    field: detail?.field || details?.field as string | undefined,
    retryAfter: retryAfterSeconds(response, data),
    details,
    attemptsRemaining: Number.isFinite(attemptsRemaining) && attemptsRemaining >= 0 ? Math.floor(attemptsRemaining) : undefined,
  });
}

export function isTerminalSessionError(error: unknown): error is ApiError {
  return isApiError(error) && (
    error.code === 'SESSION_REVOKED'
    || error.code === 'REFRESH_INVALID'
  );
}

function networkError(signal: AbortSignal | null, externalSignal?: AbortSignal): ApiError {
  const externallyAborted = Boolean(externalSignal?.aborted);
  return new ApiError(
    externallyAborted ? 'Запрос отменён' : signal?.aborted ? 'Сервер не ответил вовремя' : 'Не удалось связаться с сервером',
    { code: externallyAborted ? 'REQUEST_ABORTED' : signal?.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR' },
  );
}

interface PersistentFetchOptions {
  authorization?: string;
  bootstrap?: boolean;
  timeoutMs?: number;
  body?: unknown;
}

async function persistentFetch<T>(path: string, options: PersistentFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...PERSISTENT_COOKIE_AUTH_HEADERS };
  const csrf = options.bootstrap ? '1' : readPersistentCsrfCookie();
  if (!csrf) throw new ApiError('Не удалось подтвердить защищённую сессию', { status: 0, code: 'AUTH_CSRF_MISSING' });
  headers['X-Relay-CSRF'] = csrf;
  if (options.authorization) headers.Authorization = 'Bearer ' + options.authorization;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), options.timeoutMs ?? 15_000) : null;
  let response: Response;
  let data: any = {};
  let parsed = false;
  try {
    response = await fetch(API_BASE + '/api' + path, {
      method: 'POST', headers, credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    try { data = await response.json(); parsed = true; }
    catch (error) { if (ctrl?.signal.aborted) throw error; }
  } catch {
    throw networkError(ctrl?.signal || null);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  if (!response.ok) throw responseError(response, data);
  if (!parsed) throw new ApiError('Некорректный ответ сервера (' + path + ')', { status: response.status, code: 'INVALID_RESPONSE' });
  return data as T;
}

const AUTH_COOKIE_LOCK_NAME = 'relay.auth.cookie.v1';
const AUTH_COOKIE_LOCK_WAIT_MS = 15_000;

async function withAuthCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  const manager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!manager || typeof manager.request !== 'function' || typeof AbortController === 'undefined') return operation();
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), AUTH_COOKIE_LOCK_WAIT_MS);
  let acquired = false;
  try {
    return await manager.request(AUTH_COOKIE_LOCK_NAME, {
      mode: 'exclusive', signal: controller.signal,
    }, () => {
      if (controller.signal.aborted) {
        throw new ApiError('Другая вкладка не завершила работу с аккаунтом. Повторите попытку.', {
          code: 'AUTH_LOCK_TIMEOUT',
        });
      }
      acquired = true;
      globalThis.clearTimeout(timer);
      return operation();
    });
  } catch (error) {
    if (!acquired && controller.signal.aborted) {
      throw new ApiError('Другая вкладка не завершила работу с аккаунтом. Повторите попытку.', {
        code: 'AUTH_LOCK_TIMEOUT',
      });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

let refreshInFlight: Promise<PersistentSessionResponse> | null = null;

async function performRefresh(): Promise<PersistentSessionResponse> {
  const expectedRevision = authSessionRevision();
  if (IS_TAURI) {
    const response = await nativeBrokerCall(refreshNativeAuth());
    if (!installPersistentAuthBundle(response, 'refresh', expectedRevision)) {
      throw new ApiError('Некорректный ответ обновления сессии', { status: 200, code: 'INVALID_AUTH_RESPONSE' });
    }
    return response;
  }
  let response: PersistentSessionResponse;
  try {
    response = await persistentFetch<PersistentSessionResponse>('/auth/session/refresh');
  } catch (error) {
    if (isApiError(error) && (error.code === 'AUTH_CSRF_INVALID' || error.code === 'AUTH_CSRF_MISSING')) {
      // A missing/stale readable CSRF partner is recoverable while the host-only HttpOnly refresh
      // remains authentic. Repair the pair instead of logging out an account the person kept live.
      // performRefresh already owns the cross-tab cookie lock.
      const recovered = await performAmbientPersistentRecovery('refresh');
      if (recovered) return recovered;
      throw new ApiError('Сессия больше не активна', { status: 401, code: 'SESSION_REVOKED' });
    }
    if (!isApiError(error) || error.code !== 'REFRESH_STALE') throw error;
    // A legacy/unlocked tab can still update the shared cookie while this request is in flight.
    // One bounded retry consumes that newest jar value without turning concurrency into logout.
    await new Promise((resolve) => setTimeout(resolve, 75));
    response = await persistentFetch<PersistentSessionResponse>('/auth/session/refresh');
  }
  if (!installPersistentAuthBundle(response, 'refresh', expectedRevision)) {
    throw new ApiError('Некорректный ответ обновления сессии', { status: 200, code: 'INVALID_AUTH_RESPONSE' });
  }
  return response;
}

export function refreshAccessSession(): Promise<PersistentSessionResponse> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (IS_TAURI
    ? performRefreshWithTerminalHandling()
    : withAuthCookieLock(performRefreshWithTerminalHandling))
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function performRefreshWithTerminalHandling(): Promise<PersistentSessionResponse> {
  try {
    return await performRefresh();
  } catch (error) {
    // Transport/timeout/5xx and REFRESH_STALE never erase the live account.
    // Only an authoritative terminal refresh result may end this device session.
    if (isTerminalSessionError(error)) clearTerminalAuthSession();
    throw error;
  }
}

async function performAmbientPersistentRecovery(
  reason: 'persistent' | 'refresh' = 'persistent',
): Promise<PersistentSessionResponse | null> {
  const expectedRevision = authSessionRevision();
  const readableCandidate = hasPersistentResumeCandidate();
  try {
    const response = await persistentFetch<PersistentSessionResponse>('/auth/session/recover', {
      bootstrap: true,
    });
    if (!installPersistentAuthBundle(response, reason, expectedRevision)) {
      throw new ApiError('Некорректный ответ восстановления сессии', {
        status: 200,
        code: 'INVALID_AUTH_RESPONSE',
      });
    }
    return response;
  } catch (error) {
    // No/previously revoked cookie is the normal anonymous boot result. Transport failures remain
    // visible and, crucially, block a bootstrap login from silently orphaning a live durable row.
    if (isApiError(error) && (error.status === 404 || error.status === 410) && readableCandidate) {
      throw new ApiError('Безопасное восстановление входа временно недоступно. Повторите после обновления сервера.', {
        status: 503,
        code: 'PERSISTENT_AUTH_UNAVAILABLE',
      });
    }
    if (isApiError(error) && (error.code === 'REFRESH_INVALID' || error.code === 'SESSION_REVOKED'
      || error.status === 404 || error.status === 410)) return null;
    throw error;
  }
}

let resumeInFlight: Promise<PersistentSessionResponse | null> | null = null;

async function performResumePersistentSession(): Promise<PersistentSessionResponse | null> {
  if (persistentResumeSuppressed()) return null;
  if (IS_TAURI) {
    const expectedRevision = authSessionRevision();
    const reason = persistentSessionActive() ? 'refresh' : 'persistent';
    try {
      // Rust reads/rotates the OS-protected refresh credential and removes it from the payload
      // before IPC. The only renderer-provided secret here is an already-installed rolling legacy
      // token, used once for server-side migration and erased only after secure persistence wins.
      const result = await nativeBrokerCall(resumeNativeAuth(legacyMigrationToken()));
      if (result.state === 'logout_pending') {
        if (!persistentResumeSuppressed()) beginAuthLogoutFence();
        return null;
      }
      if (result.state !== 'active' || !result.bundle) return null;
      if (!installPersistentAuthBundle(result.bundle, reason, expectedRevision)) {
        throw new ApiError('Некорректный ответ восстановления сессии', {
          status: 200, code: 'INVALID_AUTH_RESPONSE',
        });
      }
      return result.bundle;
    } catch (error) {
      if (isTerminalSessionError(error)) clearTerminalAuthSession();
      throw error;
    }
  }
  if (persistentSessionActive()) return performRefreshWithTerminalHandling();
  // The ambient host-only cookie is authoritative and invisible to JS. Probe it before touching a
  // shared legacy localStorage token: a rolling old tab may have written account B while a new tab
  // already owns durable cookie account A. Upgrading B first would orphan A and switch accounts.
  const ambient = await performAmbientPersistentRecovery();
  if (ambient) return ambient;
  const legacy = legacyMigrationToken();
  if (legacy) {
    const expectedRevision = authSessionRevision();
    try {
      const response = await persistentFetch<PersistentSessionResponse>('/auth/session/upgrade', {
        authorization: legacy,
        bootstrap: true,
      });
      if (!installPersistentAuthBundle(response, 'persistent', expectedRevision)) {
        throw new ApiError('Некорректный ответ переноса сессии', { status: 200, code: 'INVALID_AUTH_RESPONSE' });
      }
      return response;
    } catch (error) {
      // Old servers do not know the endpoint. Keep the exact legacy bearer and
      // let the existing /auth/session -> /me fallback validate it.
      if (isApiError(error) && (error.status === 404 || error.status === 410)) return null;
      // A rolled-back cross-origin API can reject the new preflight headers.
      // Validation below still uses the untouched legacy bearer; a real outage
      // simply fails there as well without erasing it.
      if (isApiError(error) && error.code === 'NETWORK_ERROR') return null;
      throw error;
    }
  }
  return null;
}

export function resumePersistentSession(): Promise<PersistentSessionResponse | null> {
  // Offline explicit logout must render auth immediately. Waiting for the cookie lock here would
  // put boot behind the background 15s revoke attempt that intentionally owns that same lock.
  if (persistentResumeSuppressed()) return Promise.resolve(null);
  if (resumeInFlight) return resumeInFlight;
  resumeInFlight = (IS_TAURI
    ? performResumePersistentSession()
    : withAuthCookieLock(performResumePersistentSession))
    .finally(() => { resumeInFlight = null; });
  return resumeInFlight;
}

let logoutDrainInFlight: Promise<boolean> | null = null;
let logoutDrainRequestedGeneration = 0;

interface PushCleanupAcknowledgement {
  userId?: string;
  endpoints?: string[];
}

function pendingPushLogoutBody(): { pushCleanups: { userId: string; endpoint: string }[] } {
  return {
    pushCleanups: pendingPushCleanups().map(({ userId, endpoint }) => ({ userId, endpoint })),
  };
}

function applyPushCleanupAcknowledgement(response: { pushCleanup?: PushCleanupAcknowledgement } | null | undefined): void {
  const acknowledgement = response?.pushCleanup;
  if (!acknowledgement?.userId || !Array.isArray(acknowledgement.endpoints)) return;
  clearPushCleanups(acknowledgement.userId, acknowledgement.endpoints);
}

async function performPersistentLogoutDrain(): Promise<boolean> {
  let complete = true;
  const logoutFence = persistentLogoutFence();
  if (IS_TAURI) {
    try {
      const result = await nativeBrokerCall(drainNativeLogout(pendingPushLogoutBody().pushCleanups));
      applyPushCleanupAcknowledgement(result);
      return result.complete && !result.pending;
    } catch {
      // Credential Manager keeps logout_pending authoritative across process restarts. A network
      // failure must never turn the broker record back into an active resumable session.
      return false;
    }
  }
  if (logoutFence && PERSISTENT_COOKIE_TRANSPORT) {
    const csrf = readPersistentCsrfCookie();
    if (!csrf) {
      try {
        // Never infer that the HttpOnly refresh cookie disappeared merely because its readable
        // CSRF partner did. WebKit restore/interrupted cookie updates can desynchronise the pair;
        // the revoke-only recovery endpoint safely proves and destroys any surviving credential.
        const response = await persistentFetch<{ ok: true; pushCleanup?: PushCleanupAcknowledgement }>(
          '/auth/session/logout-recover', { bootstrap: true, body: pendingPushLogoutBody() },
        );
        applyPushCleanupAcknowledgement(response);
        clearPersistentLogoutPending(logoutFence);
      } catch (error) {
        if (isApiError(error) && (error.code === 'SESSION_REVOKED' || error.code === 'REFRESH_INVALID')) {
          clearPersistentLogoutPending(logoutFence);
        } else complete = false;
      }
    } else {
      try {
        const response = await persistentFetch<{ ok: true; pushCleanup?: PushCleanupAcknowledgement }>(
          '/auth/session/logout', { body: pendingPushLogoutBody() },
        );
        applyPushCleanupAcknowledgement(response);
        clearPersistentLogoutPending(logoutFence);
      } catch (error) {
        if (isApiError(error) && error.code === 'AUTH_CSRF_INVALID') {
          try {
            // A valid HttpOnly refresh cookie can outlive a stale readable CSRF cookie after a
            // WebKit restore or interrupted concurrent rotation. The exact-origin recovery route
            // can only revoke that authentic cookie; it never refreshes or returns credentials.
            const response = await persistentFetch<{ ok: true; pushCleanup?: PushCleanupAcknowledgement }>(
              '/auth/session/logout-recover', { bootstrap: true, body: pendingPushLogoutBody() },
            );
            applyPushCleanupAcknowledgement(response);
            clearPersistentLogoutPending(logoutFence);
          } catch (recoveryError) {
            if (isApiError(recoveryError)
              && (recoveryError.code === 'SESSION_REVOKED' || recoveryError.code === 'REFRESH_INVALID')) {
              clearPersistentLogoutPending(logoutFence);
            } else complete = false;
          }
        } else if (isApiError(error) && (error.code === 'SESSION_REVOKED' || error.code === 'REFRESH_INVALID')) {
          clearPersistentLogoutPending(logoutFence);
        } else {
          // Offline/timeout/5xx/rollback retain the local fence. The UI remains
          // logged out and another online/boot attempt will finish server revocation.
          complete = false;
        }
      }
    }
  }

  return complete;
}

async function performLegacyLogoutDrain(): Promise<boolean> {
  let complete = true;
  for (const token of pendingLegacyLogoutTokens()) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 15_000) : null;
      let response: Response;
      try {
        const logoutBody = pendingPushLogoutBody();
        response = await fetch(API_BASE + '/api/auth/session/logout-legacy', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(logoutBody),
          credentials: 'same-origin',
          ...(ctrl ? { signal: ctrl.signal } : {}),
        });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      // 401 means the exact bearer is already revoked/expired. A rolling 404/410 is deliberately
      // retained so a later new-server retry can persist its tombstone.
      if (response.ok) {
        try { applyPushCleanupAcknowledgement(await response.json()); } catch { /** revocation still succeeded */ }
        removePendingLegacyLogoutToken(token);
      } else if (response.status === 401) removePendingLegacyLogoutToken(token);
      else complete = false;
    } catch { complete = false; }
  }
  return complete && pendingLegacyLogoutTokens().length === 0;
}

async function performPendingLogoutDrain(): Promise<boolean> {
  // A logout can begin while an older drain is between cookie revocation and legacy cleanup. Loop
  // only when work/generation actually changed during the pass; an unchanged offline failure stops
  // immediately (no busy retry) and remains durable for online/next boot.
  for (let pass = 0; pass < 8; pass++) {
    const generation = logoutDrainRequestedGeneration;
    const before = JSON.stringify({
      fence: persistentLogoutFence(),
      legacy: pendingLegacyLogoutTokens(),
      push: pendingPushCleanups(),
    });
    // Only the HttpOnly-cookie mutation is serialized with refresh/login/security writers. Legacy
    // bearer tombstones cannot write auth cookies and stay outside the cross-tab lock.
    let persistentComplete = false;
    try {
      persistentComplete = IS_TAURI
        ? await performPersistentLogoutDrain()
        : await withAuthCookieLock(performPersistentLogoutDrain);
    }
    catch { return false; } // A frozen tab may retain WebLock; keep the durable fence for next retry.
    const legacyComplete = await performLegacyLogoutDrain();
    if (IS_TAURI && persistentComplete && legacyComplete) {
      const completedFence = persistentLogoutFence();
      if (completedFence) clearPersistentLogoutPending(completedFence);
    }
    const complete = persistentComplete && legacyComplete && !persistentResumeSuppressed();
    const after = JSON.stringify({
      fence: persistentLogoutFence(),
      legacy: pendingLegacyLogoutTokens(),
      push: pendingPushCleanups(),
    });
    const requestedDuringPass = logoutDrainRequestedGeneration !== generation;
    if (!requestedDuringPass) return complete;
    // The snapshot is retained in the condition for auditability: a duplicate signal with no new
    // durable work still gets at most one joined follow-up pass, while unchanged network failure
    // without a new generation returned above and never spins.
    if (before === after && !persistentLogoutFence() && pendingLegacyLogoutTokens().length === 0) return complete;
  }
  return false;
}

export function drainPendingLogout(): Promise<boolean> {
  if (logoutDrainInFlight) return logoutDrainInFlight;
  // Wait for every pre-fence refresh/security response (including its browser Set-Cookie commit)
  // before revoking and clearing. A delayed old response can then never overwrite a later login.
  logoutDrainInFlight = performPendingLogoutDrain()
    .finally(() => { logoutDrainInFlight = null; });
  return logoutDrainInFlight;
}

export async function beginLogoutAccessSession(): Promise<void> {
  if (IS_TAURI) {
    const protectedSession = await nativeBrokerCall(beginNativeLogout());
    if (!protectedSession && persistentSessionActive()) {
      throw new ApiError('Защищённая сессия устройства не найдена', {
        status: 401, code: 'SESSION_REVOKED',
      });
    }
    // Only an installation without a Credential Manager record is a legacy-native logout. If the
    // protected record exists, even a damaged renderer metadata cache must not enqueue its current
    // short access JWT for /logout-legacy (the server correctly rejects session JWTs there).
    const legacyToken = !protectedSession && !persistentSessionActive() ? getAccessToken() : null;
    if (legacyToken) queueLegacyLogoutToken(legacyToken);
  } else {
    const legacyToken = !persistentSessionActive() ? getAccessToken() : null;
    if (legacyToken) queueLegacyLogoutToken(legacyToken);
  }
  logoutDrainRequestedGeneration += 1;
  // The shared marker is synchronous and therefore wins before push cleanup, network awaits or
  // another tab can resume the account. The actual credential remains briefly usable in memory
  // only so best-effort push unsubscribe can complete; a crash/reload cannot resurrect it.
  beginAuthLogoutFence();
}

export async function logoutAccessSession(): Promise<void> {
  if (!persistentResumeSuppressed()) await beginLogoutAccessSession();
  // Native legacy capture happens atomically with the secure-record probe above. Re-enqueuing here
  // would misclassify a protected session whenever renderer metadata was lost or repaired late.
  const legacyToken = !IS_TAURI && !persistentSessionActive() ? getAccessToken() : null;
  if (legacyToken) queueLegacyLogoutToken(legacyToken);
  setAccessToken(null);
  await drainPendingLogout();
}

// Compatibility callers can still clear a legacy/terminal session directly. User-requested native
// account switches go through logoutAccessSession first so Credential Manager is durably fenced.
subscribeAccessTokenChanges((change) => {
  if (change.reason === 'cleared') {
    logoutDrainRequestedGeneration += 1;
    void drainPendingLogout();
  }
});

async function fenceBootstrapAgainstPriorLogout(): Promise<void> {
  if ((PERSISTENT_COOKIE_TRANSPORT || IS_TAURI) && persistentResumeSuppressed()) {
    // A late Set-Cookie clear from the previous account must not race and erase
    // the new login cookie. More importantly, replacing the only HttpOnly refresh
    // credential before its server row is revoked would strand an active, non-expiring
    // old session forever. Bootstrap is therefore blocked only while the cookie fence
    // itself remains; unrelated queued legacy tombstones do not block another account.
    await drainPendingLogout();
    if (persistentResumeSuppressed()) {
      throw new ApiError('Предыдущий выход ещё не подтверждён сервером. Проверьте сеть и повторите вход.', {
        code: 'LOGOUT_PENDING',
      });
    }
  }
}

async function runBootstrapAuthMutation<T extends AuthResponse>(
  expectedUsername: string,
  request: () => Promise<T>,
): Promise<T> {
  await fenceBootstrapAgainstPriorLogout();
  // Rust owns native serialization. A WebView-held navigator lock would add a second owner that
  // can be frozen or abandoned without protecting anything the broker mutex does not already own.
  if (IS_TAURI) return request();
  return withAuthCookieLock(async () => {
    if (!getAccessToken()) {
      // Re-probe while holding the same lock as the mutation. This closes the gap where another
      // tab logs in after the initial boot/guard but before this POST commits its Set-Cookie.
      const existing = await performAmbientPersistentRecovery();
      if (existing) {
        const recoveredUsername = String(existing.user?.username || '').trim().toLowerCase();
        const requestedUsername = String(expectedUsername || '').trim().toLowerCase();
        // Exact identity match is an idempotent lost-response retry of this same login/registration.
        if (requestedUsername && recoveredUsername === requestedUsername) return existing as T;
        throw new ApiError('Сохранённый вход уже восстановлен. Обновите страницу или явно выйдите, чтобы сменить аккаунт.', {
          status: 409,
          code: 'SESSION_ALREADY_ACTIVE',
        });
      }
    }
    return request();
  });
}

async function installNativeBootstrap(operation: Promise<AuthResponse>): Promise<AuthResponse> {
  const expectedRevision = authSessionRevision();
  const response = await nativeBrokerCall(operation);
  if (!installPersistentAuthBundle(response, 'persistent', expectedRevision)) {
    throw new ApiError('Некорректный ответ защищённой авторизации', {
      status: 200, code: 'INVALID_AUTH_RESPONSE',
    });
  }
  return response;
}

async function installNativeSecurityMutation(operation: Promise<AuthResponse>): Promise<AuthResponse> {
  const expectedSessionId = persistentSessionIdentifier();
  const response = await nativeBrokerCall(operation);
  if (!installPersistentAuthMutationBundle(response, expectedSessionId)) {
    throw new ApiError('Сессия изменилась во время защитного действия', {
      status: 409, code: 'AUTH_CONTEXT_CHANGED',
    });
  }
  return response;
}

// Загрузки идут сырым fetch мимо req (тело — байты файла, не JSON), и таймаута у них не было вовсе:
// мёртвый TCP оставлял промис висеть навсегда, а пользователь — бесконечное «загружается» без ошибки
// и без возможности повторить. Лимит щедрый (файл до 10 МБ на медленном канале), но конечный.
const UPLOAD_TIMEOUT_MS = 120_000;

async function uploadFetch<T>(path: string, file: Blob, extraHeaders: Record<string, string>, signal?: AbortSignal, authRetried = false): Promise<T> {
  if (persistentSessionActive() && accessTokenNeedsRefresh()) {
    try { await refreshAccessSession(); }
    catch (error) { if (!accessTokenStillUsable()) throw error; }
  }
  const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream', ...extraHeaders };
  const currentToken = getAccessToken();
  if (currentToken) headers.Authorization = 'Bearer ' + currentToken;
  if (persistentSessionActive()) Object.assign(headers, PERSISTENT_AUTH_HEADERS);
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const relayAbort = () => ctrl?.abort();
  if (signal?.aborted) ctrl?.abort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  let timedOut = false;
  const timer = ctrl ? setTimeout(() => { timedOut = true; ctrl.abort(); }, UPLOAD_TIMEOUT_MS) : null;
  let r: Response;
  let d: any = {};
  try {
    r = await fetch(API_BASE + path, { method: 'POST', headers, body: file, credentials: apiCredentials(persistentSessionActive()), ...(ctrl ? { signal: ctrl.signal } : {}) });
    // fetch() resolves when headers arrive. Keep the same timeout/abort owner through the complete
    // response body: a mobile radio can otherwise freeze json() forever after a successful upload.
    try { d = await r.json(); }
    catch (error) { if (signal?.aborted || ctrl?.signal.aborted) throw error; }
  }
  catch {
    throw new Error(signal?.aborted ? 'Загрузка отменена' : timedOut || ctrl?.signal.aborted ? 'Сервер не ответил вовремя' : 'Не удалось связаться с сервером');
  }
  finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
  const uploadError = !r.ok ? responseError(r, d) : null;
  if (r.status === 401 && uploadError
    && ['ACCESS_EXPIRED', 'SESSION_REVOKED', 'UNAUTHORIZED'].includes(uploadError.code)
    && persistentSessionActive() && !authRetried && !signal?.aborted) {
    await refreshAccessSession();
    return uploadFetch<T>(path, file, extraHeaders, signal, true);
  }
  if (uploadError) throw uploadError;
  return d as T;
}

async function req<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const authenticated = options.auth !== false;
  if (authenticated && !options.skipAuthRefresh) {
    const refresh = options.authCookieLockHeld ? performRefreshWithTerminalHandling : refreshAccessSession;
    if (!getAccessToken() && hasPersistentResumeCandidate()) await refresh();
    else if (persistentSessionActive() && accessTokenNeedsRefresh()) {
      try { await refresh(); }
      catch (error) { if (!accessTokenStillUsable()) throw error; }
    }
  }
  const headers: Record<string, string> = {};
  const expectedAuthRevision = authSessionRevision();
  const expectedPersistentSessionId = persistentSessionIdentifier();
  const currentToken = getAccessToken();
  if (authenticated && currentToken) headers.Authorization = 'Bearer ' + currentToken;
  const persistentTransport = options.persistentBootstrap || persistentSessionActive();
  if (persistentTransport) Object.assign(headers, PERSISTENT_AUTH_HEADERS);
  if (options.persistentBootstrap) headers['X-Relay-CSRF'] = '1';
  else if (options.authSessionMutation && persistentSessionActive()) {
    const csrf = readPersistentCsrfCookie();
    if (!csrf) throw new ApiError('Не удалось подтвердить защищённую сессию', { status: 0, code: 'AUTH_CSRF_MISSING' });
    headers['X-Relay-CSRF'] = csrf;
  }
  Object.assign(headers, options.headers || {});
  const opt: RequestInit = { method, headers, credentials: apiCredentials(persistentTransport) };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  // таймаут: мёртвый TCP иначе оставляет промис висеть вечно → «отправляется» без failed/повтора
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const relayAbort = () => ctrl?.abort();
  if (options.signal?.aborted) ctrl?.abort();
  else options.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = ctrl ? setTimeout(() => ctrl.abort(), options.timeoutMs ?? 15000) : null;
  if (ctrl) opt.signal = ctrl.signal;
  let r: Response;
  let d: any = {};
  let parsed = false;
  try {
    r = await fetch(API_BASE + '/api' + path, opt);
    try { d = await r.json(); parsed = true; }
    catch (e) { if (ctrl?.signal.aborted) throw e; }
  }
  catch { throw networkError(ctrl?.signal || null, options.signal); }
  finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
  }
  if (!r.ok) {
    const error = responseError(r, d);
    if (r.status === 401 && ['ACCESS_EXPIRED', 'SESSION_REVOKED', 'UNAUTHORIZED'].includes(error.code)
      && authenticated && !options.skipAuthRefresh && !options.authRetried
      && (persistentSessionActive() || hasPersistentResumeCandidate()) && !options.signal?.aborted) {
      if (options.authCookieLockHeld) await performRefreshWithTerminalHandling();
      else await refreshAccessSession();
      return req<T>(method, path, body, { ...options, authRetried: true });
    }
    throw error;
  }
  if (r.status === 204) return undefined as T;
  // 200, но тело не JSON (напр. index.html при неверном API_BASE в нативе) — падаем
  // громко, а не отдаём {} наверх (иначе me/servers undefined → белый экран на home).
  if (!parsed) throw new ApiError('Некорректный ответ сервера (' + path + ')', { status: r.status, code: 'INVALID_RESPONSE' });
  if (d?.protocol === PERSISTENT_AUTH_PROTOCOL) {
    const installed = installPersistentAuthBundle(d, 'persistent', expectedAuthRevision)
      || (options.authSessionMutation
        ? installPersistentAuthMutationBundle(d, expectedPersistentSessionId)
        : null);
    if (!installed) {
      throw new ApiError('Некорректный ответ авторизации', { status: r.status, code: 'INVALID_AUTH_RESPONSE' });
    }
  }
  if (options.requireStableAuth && (
    authSessionRevision() !== expectedAuthRevision
    || getAccessToken() !== currentToken
    || persistentResumeSuppressed()
  )) {
    throw new ApiError('Сессия изменилась во время запроса', {
      status: 409,
      code: 'AUTH_CONTEXT_CHANGED',
    });
  }
  return d as T;
}

export const api = {
  authSession: () => req<SessionResponse>('GET', '/auth/session'),
  resumePersistentSession,
  drainPendingLogout,
  beginLogout: beginLogoutAccessSession,
  logoutSession: logoutAccessSession,
  login: async (username: string, password: string) => {
    return runBootstrapAuthMutation(username, () => {
      if (IS_TAURI) return installNativeBootstrap(loginNativeAuth(username, password));
      // A same-origin old server simply ignores the rollout headers and returns its legacy bundle.
      // Never replay a credential mutation after an ambiguous timeout: the first request may have
      // succeeded and a duplicate registration verification can consume an already-used proof.
      return req<AuthResponse>('POST', '/login', { username, password }, {
        auth: false, persistentBootstrap: PERSISTENT_COOKIE_TRANSPORT, authCookieLockHeld: true,
      });
    });
  },
  registerStart: (payload: { username: string; email: string; password: string; inviteCode: string; requestId: string }) =>
    req<ChallengeResponse>('POST', '/auth/register/start', payload, { auth: false }),
  registerVerify: async (flowId: string, code: string, expectedUsername = '') => {
    return runBootstrapAuthMutation(expectedUsername, () => (
      IS_TAURI
        ? installNativeBootstrap(verifyNativeRegistration(flowId, code))
        : req<AuthResponse>('POST', '/auth/register/verify', { flowId, code }, {
            auth: false, persistentBootstrap: true, authCookieLockHeld: true,
          })
    ));
  },
  registerResend: (flowId: string) =>
    req<ChallengeResponse>('POST', '/auth/register/resend', { flowId }, { auth: false }),
  emailStart: (email: string, currentPassword: string, requestId: string, supportCode?: string) =>
    req<ChallengeResponse>('POST', '/auth/email/start', { email, currentPassword, requestId, supportCode }),
  emailVerify: (flowId: string, code: string) => {
    if (IS_TAURI) {
      const access = getAccessToken();
      if (!access) return Promise.reject(new ApiError('Не авторизован', { status: 401, code: 'UNAUTHORIZED' }));
      return installNativeSecurityMutation(verifyNativeEmail(access, flowId, code));
    }
    return withAuthCookieLock(() => req<SessionResponse & { token?: string; protocol?: 'persistent-v1'; accessToken?: string; accessExpiresAt?: number; sessionId?: string }>(
      'POST', '/auth/email/verify', { flowId, code }, { authSessionMutation: true, authCookieLockHeld: true },
    ));
  },
  emailResend: (flowId: string) =>
    req<ChallengeResponse>('POST', '/auth/email/resend', { flowId }),
  forgotPassword: (email: string) =>
    req<{ ok?: boolean; resendAt?: number }>('POST', '/auth/password/forgot', { email }, { auth: false }),
  inspectPasswordReset: (token: string) =>
    req<{ valid?: boolean; username?: string; expiresAt?: number }>('POST', '/auth/password/reset/inspect', { token }, { auth: false }),
  resetPassword: (token: string, password: string) =>
    req<{ ok?: boolean; username?: string }>('POST', '/auth/password/reset', { token, password }, { auth: false }),
  changePassword: (currentPassword: string, newPassword: string) => {
    if (IS_TAURI) {
      const access = getAccessToken();
      if (!access) return Promise.reject(new ApiError('Не авторизован', { status: 401, code: 'UNAUTHORIZED' }));
      return installNativeSecurityMutation(changeNativePassword(access, currentPassword, newPassword));
    }
    return withAuthCookieLock(() => req<AuthResponse>('POST', '/auth/password/change', { currentPassword, newPassword }, {
      authSessionMutation: true, authCookieLockHeld: true,
    }));
  },
  me: (signal?: AbortSignal) => req<{ user: User; servers: ServerSummary[] }>('GET', '/me', undefined, { signal }),
  releaseHistory: (signal?: AbortSignal) => req<ReleaseHistoryResponse>('GET', '/releases/history', undefined, { signal }),
  updateMe: (patch: { displayName?: string; bio?: string; avatarColor?: number; avatarUrl?: string; profileBannerUrl?: string }) =>
    req<{ user: User }>('PATCH', '/me', patch),
  uploadImage: (file: Blob) => uploadFetch<{ url: string; width: number; height: number }>('/api/upload', file, {}),
  uploadProfileBanner: (file: Blob, signal?: AbortSignal) => uploadFetch<{ url: string }>('/api/upload/profile-banner', file, {}, signal),
  deleteProfileBannerUpload: (url: string) => req<{ ok: boolean; removed: boolean }>('DELETE', '/upload/profile-banner', { url }),
  // произвольный файл-вложение (любое расширение, <=10MB) — раздаётся форс-скачиванием, не инлайн.
  // Имя передаём отдельным заголовком (raw body = сами байты файла, без multipart).
  uploadFile: (file: File) => uploadFetch<{ url: string; name: string; size: number }>('/api/upload-file', file, { 'X-Attachment-Name': encodeURIComponent(file.name) }),
  createServer: (name: string) =>
    req<{ server: ServerSummary; invite: string; inviteExpires: number }>('POST', '/servers', { name }),
  getServer: (id: string) =>
    req<{ server: ServerDetail; members: Member[]; myRole: string; myPerms: number }>('GET', '/servers/' + id),
  patchServer: (id: string, patch: { name?: string; description?: string; iconColor?: number; iconUrl?: string; statsEnabled?: boolean }) =>
    req<{ server: ServerDetail }>('PATCH', '/servers/' + id, patch),
  getLeaderboard: (id: string) => req<import('./types').Leaderboard>('GET', `/servers/${id}/leaderboard`),
  leaveServer: (id: string) => req<{ ok: boolean }>('POST', `/servers/${id}/leave`),
  kickMember: (id: string, userId: string) => req<{ ok: boolean }>('POST', `/servers/${id}/kick`, { userId }),
  deleteServer: (id: string) => req<{ ok: boolean }>('DELETE', '/servers/' + id),
  createInvite: (id: string) =>
    req<{ code: string; expires: number }>('POST', `/servers/${id}/invites`),
  invitePreview: (code: string, signal?: AbortSignal) => req<InvitePreview>('GET', '/invites/' + encodeURIComponent(code), undefined, { signal }),
  joinInvite: (code: string) =>
    req<{ server: ServerSummary }>('POST', `/invites/${encodeURIComponent(code)}/join`),
  getRoles: (id: string) => req<{ roles: Role[] }>('GET', `/servers/${id}/roles`),
  createRole: (id: string, r: { name: string; color: string; permissions: number }) => req<{ role: Role }>('POST', `/servers/${id}/roles`, r),
  updateRole: (id: string, rid: string, patch: Partial<{ name: string; color: string; permissions: number; position: number }>) => req<{ role: Role }>('PATCH', `/servers/${id}/roles/${rid}`, patch),
  deleteRole: (id: string, rid: string) => req<{ ok: boolean }>('DELETE', `/servers/${id}/roles/${rid}`),
  setMemberRoles: (id: string, userId: string, roleIds: string[]) => req<{ roles: Role[] }>('PUT', `/servers/${id}/members/${userId}/roles`, { roleIds }),
  getChannels: (id: string) => req<{ channels: VoiceChannel[] }>('GET', `/servers/${id}/channels`),
  createChannel: (id: string, name: string) => req<{ channel: VoiceChannel; channels: VoiceChannel[] }>('POST', `/servers/${id}/channels`, { name }),
  renameChannel: (id: string, cid: string, name: string) => req<{ channels: VoiceChannel[] }>('PATCH', `/servers/${id}/channels/${cid}`, { name }),
  deleteChannel: (id: string, cid: string) => req<{ channels: VoiceChannel[] }>('DELETE', `/servers/${id}/channels/${cid}`),
  clearChat: (id: string, canonicalTransport = false) => req<{ ok: boolean }>(
    'POST', `/servers/${id}/clear`, undefined, chatMutationOptions(canonicalTransport),
  ),
  serverToken: (id: string) => req<{ token: string; url: string; room: string; sessionId: string }>('GET', `/servers/${id}/token`),
  getVoiceLease: () => req<VoiceLeaseEvent>('GET', '/voice/lease'),
  mintVoiceIntent: (sessionId: string, serverId: string, channelId: string, clientIntent: number) =>
    req<VoiceIntentTicket>('POST', '/voice/lease/intent', { sessionId, serverId, channelId, clientIntent }),
  claimVoiceLease: (sessionId: string, serverId: string, channelId: string, clientIntent: number, ticket: number) =>
    req<VoiceLeaseEvent>('POST', '/voice/lease/claim', { sessionId, serverId, channelId, clientIntent, ticket }),
  releaseVoiceLease: (sessionId: string, epoch: number) =>
    req<VoiceLeaseEvent>('POST', '/voice/lease/release', { sessionId, epoch }),
  getVoiceMediaToken: (sessionId: string, serverId: string, channelId: string, epoch: number) =>
    req<VoiceMediaTokenResponse>('POST', '/voice/media-token', { sessionId, serverId, channelId, epoch }),
  activateVoiceMedia: (sessionId: string, serverId: string, channelId: string, epoch: number) =>
    req<VoiceMediaActivationResponse>('POST', '/voice/media/activate', { sessionId, serverId, channelId, epoch }),
  getSettings: (id: string) => req<{ data: any }>('GET', `/servers/${id}/settings`),
  putSettings: (id: string, data: any) => req<{ ok: boolean }>('PUT', `/servers/${id}/settings`, { data }),
  patchSettings: (id: string, mutation: { section: 'users' | 'streams'; key: string; value: number }) =>
    req<{ ok: boolean; data: any }>('PATCH', `/servers/${id}/settings`, mutation),
  // аккаунтные настройки (хоткеи и т.п.) — следуют за юзером на любом устройстве, не за localStorage
  getMySettings: () => req<{ data: any }>('GET', '/me/settings'),
  putMySettings: (data: any) => req<{ ok: boolean }>('PUT', '/me/settings', { data }),
  presence: (id: string) => req<{ online: string[]; voice?: Record<string, string>; away?: string[] }>('GET', `/servers/${id}/presence`),
  // all:true — «прочитать всё» (сервер выставит last_read=MAX id, покрывая живые сообщения без sid). Возвращает актуальный lastRead.
  markRead: (id: string, lastId: number, all?: boolean) => req<{ ok: boolean; lastRead: number }>('POST', `/servers/${id}/read`, { lastId, all }),
  getUnread: () => req<Record<string, number>>('GET', '/unread'),
  // курсорная пагинация: before = id строки, старше которой грузить (undefined = последняя страница)
  getMessages: (id: string, before?: number, limit?: number) => {
    const qs = new URLSearchParams();
    if (before) qs.set('before', String(before));
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    return req<{ messages: HistoryMessage[]; hasMore: boolean; revision: number; lastClearRevision: number }>('GET', `/servers/${id}/messages${q ? '?' + q : ''}`);
  },
  getMessage: (id: string, messageId: number) =>
    req<{ message: HistoryMessage }>('GET', `/servers/${id}/messages/${messageId}`),
  postMessage: (id: string, text: string, em: Record<string, string>, image?: string, reply?: import('./types').ReplyRef, key?: string, files?: Attachment[], kind?: string, level?: number, canonicalTransport = false) => req<{ ok: boolean; id?: number; revision?: number }>(
    'POST', `/servers/${id}/messages`, { text, em, image, reply, key, files, kind, level }, chatMutationOptions(canonicalTransport),
  ),
  reactMessage: (id: string, mid: number, emoteId: string, emoteName: string, add: boolean, canonicalTransport = false) => req<{ ok: boolean; changed?: boolean }>(
    'POST', `/servers/${id}/messages/${mid}/react`, { emoteId, emoteName, add }, chatMutationOptions(canonicalTransport),
  ),
  editMessage: (id: string, mid: number, text: string, canonicalTransport = false) => req<{ ok: boolean }>(
    'PATCH', `/servers/${id}/messages/${mid}`, { text }, chatMutationOptions(canonicalTransport),
  ),
  deleteMessage: (id: string, mid: number, canonicalTransport = false) => req<{ ok: boolean }>(
    'DELETE', `/servers/${id}/messages/${mid}`, undefined, chatMutationOptions(canonicalTransport),
  ),
  // Web Push (фоновые уведомления PWA/браузера)
  pushVapid: () => req<{ enabled: boolean; key: string }>('GET', '/push/vapid', undefined, { timeoutMs: 10_000 }),
  pushSubscribe: (sub: unknown, prefs: { mention: boolean; stream: boolean; privacy: NotificationPrivacy }) => req<{ ok: boolean; userId?: string; endpoint?: string }>(
    'POST', '/push/subscribe', { sub, prefs }, { timeoutMs: 10_000, requireStableAuth: true },
  ),
  pushUnsubscribe: (endpoint: string) => req<{ ok: boolean; removed?: boolean; safeToUnsubscribe?: boolean }>(
    'POST', '/push/unsubscribe', { endpoint }, { timeoutMs: 10_000 },
  ),
  // вещатель сообщает серверу о старте трансляции → фоновый push участникам не в комнате
  streamStart: (id: string) => req<{ ok: boolean }>('POST', `/servers/${id}/stream-start`),
  // публичный (без auth) — свежий билд натива для кнопки скачивания в вебе; 404 если билда нет
  appLatest: (signal?: AbortSignal): Promise<{ version: string; url: string } | null> => appLatestLoader.load(signal),
  // аллоулист игр Discord (дистиллят с сервера) — натив матчит запущенные процессы для детекта игры
  detectableGames: () => req<{ games: { name: string; exes: string[] }[] }>('GET', '/detectable-games'),
  // --- Админка (denis + кому выдали) ---
  adminOverview: () => req<AdminOverview>('GET', '/admin/overview'),
  adminDeleteServer: (id: string) => req<{ ok: boolean }>('DELETE', `/admin/servers/${id}`),
  adminRemoveMember: (serverId: string, userId: string) => req<{ ok: boolean }>('DELETE', `/admin/servers/${serverId}/members/${userId}`),
  adminDeleteUser: (id: string) => req<{ ok: boolean }>('DELETE', `/admin/users/${id}`),
  adminSetAdmin: (id: string, admin: boolean) => req<{ ok: boolean; isAdmin: boolean }>('POST', `/admin/users/${id}/admin`, { admin }),
  adminEmailBindingSupportCode: (id: string) => req<{ ok: boolean; userId: string; code: string; expiresAt: number }>(
    'POST', `/admin/users/${id}/email-binding-support-code`, {},
  ),
  adminRegistrationInvite: async () => {
    const response = await req<RegistrationInvite & { validUntil?: number }>('GET', '/admin/registration-invite');
    const rawExpiry = response.expiresAt || response.validUntil || 0;
    return { ...response, expiresAt: rawExpiry && rawExpiry < 1_000_000_000_000 ? rawExpiry * 1000 : rawExpiry };
  },
  adminRotateRegistrationInvite: async () => {
    const response = await req<RegistrationInvite & { validUntil?: number }>('POST', '/admin/registration-invite/rotate', {});
    const rawExpiry = response.expiresAt || response.validUntil || 0;
    return { ...response, expiresAt: rawExpiry && rawExpiry < 1_000_000_000_000 ? rawExpiry * 1000 : rawExpiry };
  },
  // Диагностика стрима: клиент сдаёт сессию по её окончании (см. diag.ts). Тело крупнее
  // обычного (лог + семплы) — сервер парсит этот путь отдельным express.json({limit:'2mb'}).
  diagSession: (payload: unknown) => req<{ ok: boolean; name: string }>('POST', '/diag/session', payload),
  // 7TV-прокси (обход блокировки 7tv.io у части провайдеров) — фолбэк, когда direct недоступен.
  // req() даёт префикс API_BASE (натив → прод-хост, иначе относит.) + таймаут; search шлёт Authorization.
  sevenGlobal: () => req<{ emotes?: { name: string; id: string }[] }>('GET', '/7tv/global'),
  sevenSearch: async (q: string, p: number): Promise<Emote[]> => {
    const qs = new URLSearchParams({ q, p: String(p) }).toString();
    const d = await req<{ items: Emote[] }>('GET', `/7tv/search?${qs}`);
    return d.items || [];
  },
  // Резолв аудио-URL совместного прослушивания через медиа-релей (обход блокировки YouTube).
  // Возвращает готовый URL для <audio> (аудио идёт браузер↔релей, мимо основного VPS). 503 = релей выкл.
};

/** Отправка на выгрузке страницы (`pagehide`): обычный fetch браузер убьёт вместе с
 *  документом, `keepalive` — доживёт. Цена: суммарный лимит тела keepalive-запросов
 *  64 КБ, поэтому вызывающий обязан прислать усечённый payload (см. diag.ts).
 *  sendBeacon не подходит — он не умеет ставить заголовок Authorization. */
export function diagSessionKeepalive(payload: unknown): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const currentToken = getAccessToken();
  if (currentToken) headers.Authorization = 'Bearer ' + currentToken;
  if (persistentSessionActive()) Object.assign(headers, PERSISTENT_AUTH_HEADERS);
  try {
    void fetch(API_BASE + '/api/diag/session', {
      method: 'POST', headers, body: JSON.stringify(payload), keepalive: true,
      credentials: apiCredentials(persistentSessionActive()),
    });
  } catch { /* страница уже уходит — жаловаться некому */ }
}

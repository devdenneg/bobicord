// Web Push (VAPID) — background notifications for installed PWA/browser sessions.
// Every operation is bounded and errors are observable by UI: permission alone is not enough to
// claim that notifications are enabled until the subscription is persisted by the backend.
import { isTauri } from './native';
import { api } from './api';
import { authSessionRevision, persistentResumeSuppressed } from './authSession';
import {
  authorizeNotificationPrivacySync, getNotificationPushPrefs, revokeNotificationPrivacySync,
} from './settings';
import {
  clearPushBinding,
  clearPushCleanups,
  pendingPushCleanups,
  queuePushCleanup,
  readPushBinding,
  rememberProvisionalPushBinding,
} from './pushCleanup';

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
const PUSH_OPERATION_TIMEOUT_MS = 10_000;
const PUSH_BACKEND_TIMEOUT_MS = 12_000;
const VAPID_CACHE_MS = 60_000;
const PUSH_MUTATION_LOCK_NAME = 'relay.push.mutation.v1';
const PUSH_SESSION_STATE_TIMEOUT_MS = 1_500;

type PushSessionStateResult = 'confirmed' | 'legacy' | 'rejected';

export type PushSetupErrorCode =
  | 'PUSH_UNSUPPORTED'
  | 'PUSH_PERMISSION_REQUIRED'
  | 'PUSH_ACCOUNT_REQUIRED'
  | 'PUSH_DISABLED'
  | 'PUSH_VAPID_INVALID'
  | 'PUSH_TIMEOUT'
  | 'PUSH_SUBSCRIBE_FAILED';

export class PushSetupError extends Error {
  readonly code: PushSetupErrorCode;
  constructor(code: PushSetupErrorCode, message: string) {
    super(message);
    this.name = 'PushSetupError';
    this.code = code;
  }
}

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bytes(value: BufferSource | null | undefined): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function applicationServerKeyMatches(subscription: PushSubscription, expectedKey: string): boolean {
  let expected: Uint8Array;
  try { expected = urlB64ToUint8Array(expectedKey); } catch { return false; }
  const actual = bytes(subscription.options?.applicationServerKey);
  if (!actual || actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < actual.byteLength; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

export function pushSupported(): boolean {
  return !isTauri && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window;
}

function accountId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 ? id : '';
}

function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new PushSetupError('PUSH_TIMEOUT', `${label}: превышено время ожидания`)), timeoutMs);
    operation.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * A durable worker-side account floor. `false` is sent before logout/opt-out; `true` is sent only
 * after the backend confirmed this browser's exact endpoint and current preferences.
 */
export async function setPushNotificationSessionActive(active: boolean): Promise<PushSessionStateResult> {
  if (!active) revokeNotificationPrivacySync();
  const acknowledged = await (async (): Promise<PushSessionStateResult> => {
    if (isTauri || typeof navigator === 'undefined' || !navigator.serviceWorker) return 'rejected';
    let worker: ServiceWorker | null = null;
    try {
      worker = navigator.serviceWorker.controller;
      if (!worker) {
        const registration = await bounded(
          navigator.serviceWorker.ready,
          SERVICE_WORKER_READY_TIMEOUT_MS,
          'Запуск службы уведомлений',
        );
        worker = registration.active;
      }
    } catch { return 'rejected'; }
    if (!worker || typeof MessageChannel === 'undefined') return 'rejected';
    return new Promise<PushSessionStateResult>((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (result: PushSessionStateResult) => {
        if (settled) return;
        settled = true;
        try { window.clearTimeout(timer); } catch { /**/ }
        try { channel.port1.close(); channel.port2.close(); } catch { /**/ }
        resolve(result);
      };
      // A timeout means the message was successfully posted to a rolling worker which may predate
      // this protocol. An explicit false is different: the current worker understood the request
      // but could not persist it and must fail setup.
      const timer = window.setTimeout(() => finish('legacy'), PUSH_SESSION_STATE_TIMEOUT_MS);
      channel.port1.onmessage = (event) => finish(event.data?.ok === true ? 'confirmed' : 'rejected');
      try {
        channel.port1.start?.();
        worker.postMessage({ type: 'set-notification-session-active', active: active === true }, [channel.port2]);
      } catch { finish('rejected'); }
    });
  })();
  return acknowledged;
}

let vapidCache: { key: string; expiresAt: number } | null = null;
async function getVapid(): Promise<string> {
  if (vapidCache && vapidCache.expiresAt > Date.now()) return vapidCache.key;
  // A network/5xx failure is deliberately not cached. The next click/pageshow can recover without
  // waiting for a reload. A successful value is short-lived so VAPID rotation is detected quickly.
  const response = await bounded(api.pushVapid(), PUSH_BACKEND_TIMEOUT_MS, 'Получение ключа push');
  if (!response.enabled || !response.key) throw new PushSetupError('PUSH_DISABLED', 'Фоновые уведомления временно отключены на сервере');
  try {
    if (urlB64ToUint8Array(response.key).byteLength < 32) throw new Error('short key');
  } catch {
    throw new PushSetupError('PUSH_VAPID_INVALID', 'Сервер вернул некорректный ключ уведомлений');
  }
  vapidCache = { key: response.key, expiresAt: Date.now() + VAPID_CACHE_MS };
  return response.key;
}

let pushMutationTail: Promise<unknown> = Promise.resolve();
async function withCrossTabPushLock<T>(operation: () => Promise<T>): Promise<T> {
  let manager: LockManager | undefined;
  try { manager = typeof navigator !== 'undefined' ? navigator.locks : undefined; } catch { manager = undefined; }
  if (!manager || typeof manager.request !== 'function' || typeof AbortController === 'undefined') return operation();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PUSH_OPERATION_TIMEOUT_MS);
  let acquired = false;
  try {
    return await manager.request(PUSH_MUTATION_LOCK_NAME, {
      mode: 'exclusive', signal: controller.signal,
    }, () => {
      acquired = true;
      window.clearTimeout(timer);
      return operation();
    });
  } catch (error) {
    if (!acquired && controller.signal.aborted) {
      throw new PushSetupError('PUSH_TIMEOUT', 'Другая вкладка не завершила настройку уведомлений. Повторите попытку.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function serializePushMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = pushMutationTail.catch(() => {}).then(() => withCrossTabPushLock(operation));
  pushMutationTail = run.catch(() => {});
  return run;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  if (!pushSupported()) throw new PushSetupError('PUSH_UNSUPPORTED', 'Фоновые уведомления не поддерживаются этим браузером');
  return bounded(navigator.serviceWorker.ready, SERVICE_WORKER_READY_TIMEOUT_MS, 'Запуск службы уведомлений');
}

interface PushCleanupResult {
  complete: boolean;
  safeLocalEndpoints: Set<string>;
  foreignLocalEndpoints: Set<string>;
}

async function drainPushCleanupsNow(userId: string): Promise<PushCleanupResult> {
  const endpoints = pendingPushCleanups()
    .filter((record) => record.userId === userId)
    .map((record) => record.endpoint);
  if (!endpoints.length) return { complete: true, safeLocalEndpoints: new Set(), foreignLocalEndpoints: new Set() };
  let complete = true;
  const safeLocalEndpoints = new Set<string>();
  const foreignLocalEndpoints = new Set<string>();
  for (const endpoint of endpoints) {
    try {
      const response = await bounded(api.pushUnsubscribe(endpoint), PUSH_BACKEND_TIMEOUT_MS, 'Удаление старой push-подписки');
      if (!response?.ok) throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Сервер не подтвердил удаление push-подписки');
      if (response.removed || response.safeToUnsubscribe === true) safeLocalEndpoints.add(endpoint);
      else if (response.safeToUnsubscribe === false) foreignLocalEndpoints.add(endpoint);
      clearPushCleanups(userId, [endpoint]);
    } catch { complete = false; }
  }
  return { complete, safeLocalEndpoints, foreignLocalEndpoints };
}

async function rollbackUnconfirmedSubscription(userId: string, subscription: PushSubscription): Promise<void> {
  queuePushCleanup(userId, subscription.endpoint);
  try {
    const cleanup = await drainPushCleanupsNow(userId);
    if (!cleanup.safeLocalEndpoints.has(subscription.endpoint)) return;
    const removed = await bounded(subscription.unsubscribe(), PUSH_OPERATION_TIMEOUT_MS, 'Откат неподтверждённой push-подписки');
    if (removed) clearPushBinding(subscription.endpoint);
  } catch { /** The exact account-scoped cleanup stays queued for online/logout retry. */ }
}

/** Retry only the current account's durable backend cleanup. */
export function retryPendingPushCleanup(userIdValue: unknown): Promise<boolean> {
  const userId = accountId(userIdValue);
  if (!userId) return Promise.resolve(false);
  return serializePushMutation(async () => (await drainPushCleanupsNow(userId)).complete);
}

export interface PushSubscriptionState {
  endpoint: string;
  rotated: boolean;
}

/** Creates/rotates and confirms the exact subscription on the backend. Rejects on every failure. */
export function ensurePushSubscribed(userIdValue: unknown): Promise<PushSubscriptionState> {
  const userId = accountId(userIdValue);
  if (!userId) return Promise.reject(new PushSetupError('PUSH_ACCOUNT_REQUIRED', 'Не удалось определить текущий аккаунт'));
  return serializePushMutation(async () => {
    if (!pushSupported()) throw new PushSetupError('PUSH_UNSUPPORTED', 'Фоновые уведомления не поддерживаются этим браузером');
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      throw new PushSetupError('PUSH_PERMISSION_REQUIRED', 'Браузер не выдал разрешение на уведомления');
    }
    // Never re-bind while an opt-out cleanup for this account is still ambiguous.
    if (!(await drainPushCleanupsNow(userId)).complete) {
      throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Не удалось удалить предыдущую подписку. Проверьте сеть и повторите.');
    }
    const key = await getVapid();
    const registration = await readyRegistration();
    let subscription = await bounded(registration.pushManager.getSubscription(), PUSH_OPERATION_TIMEOUT_MS, 'Проверка push-подписки');
    let rotated = false;
    let created = false;
    const storedBinding = subscription ? readPushBinding() : null;
    const browserKeyVisible = !!bytes(subscription?.options?.applicationServerKey);
    // VAPID equality alone cannot prove account ownership: a queued old-account payload remains
    // decryptable while the same local endpoint/keys are reused. Unknown legacy ownership and an
    // explicit owner mismatch both rotate once before a new account can activate push.
    const keyMatches = !!subscription && storedBinding?.endpoint === subscription.endpoint
      && storedBinding.userId === userId && (browserKeyVisible
      ? applicationServerKeyMatches(subscription, key)
      : storedBinding?.endpoint === subscription.endpoint && storedBinding.vapidKey === key);
    if (subscription && !keyMatches) {
      const oldEndpoint = subscription.endpoint;
      const binding = storedBinding;
      if (binding?.endpoint === oldEndpoint) queuePushCleanup(binding.userId, oldEndpoint);
      else if (!binding) queuePushCleanup(userId, oldEndpoint);
      const removed = await bounded(subscription.unsubscribe(), PUSH_OPERATION_TIMEOUT_MS, 'Обновление ключа push');
      if (!removed) throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Браузер не смог обновить ключ уведомлений');
      clearPushBinding(oldEndpoint);
      if (!binding || binding.userId === userId) await drainPushCleanupsNow(userId);
      subscription = null;
      rotated = true;
    }
    if (!subscription) {
      try {
        subscription = await bounded(registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(key) as unknown as BufferSource,
        }), PUSH_OPERATION_TIMEOUT_MS, 'Создание push-подписки');
        created = true;
      } catch (error) {
        if (error instanceof PushSetupError) throw error;
        throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Браузер не смог создать push-подписку');
      }
    }
    // Publish exact provisional ownership before the authenticated POST starts. A second tab can
    // now include this endpoint in its atomic logout transaction even while this request is in
    // flight. If shared storage cannot confirm it, fail before the server can create an orphan row.
    if (!rememberProvisionalPushBinding(userId, subscription.endpoint, key)) {
      if (created) {
        try {
          await bounded(subscription.unsubscribe(), PUSH_OPERATION_TIMEOUT_MS, 'Откат локальной push-подписки');
          clearPushBinding(subscription.endpoint);
        } catch { /** No backend row was sent; a later VAPID rotation can retry local cleanup. */ }
      }
      throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Не удалось безопасно сохранить push-подписку в браузере');
    }
    const settings = getNotificationPushPrefs();
    let persisted: { ok: boolean; userId?: string; endpoint?: string };
    try {
      persisted = await bounded(api.pushSubscribe(subscription.toJSON(), {
        mention: !!settings.notifMention,
        stream: !!settings.notifStream,
        privacy: settings.notifPrivacy,
      }), PUSH_BACKEND_TIMEOUT_MS, 'Сохранение push-подписки');
      if (!persisted?.ok || persisted.userId !== userId || persisted.endpoint !== subscription.endpoint) {
        throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Сервер не подтвердил владельца push-подписки');
      }
      if (persistentResumeSuppressed()) {
        throw new PushSetupError('PUSH_ACCOUNT_REQUIRED', 'Сессия завершилась во время настройки уведомлений');
      }
      const activationRevision = authSessionRevision();
      const activation = await setPushNotificationSessionActive(true);
      if (activation === 'rejected') {
        throw new PushSetupError('PUSH_SUBSCRIBE_FAILED', 'Служба уведомлений не подтвердила безопасное состояние подписки');
      }
      // A cross-tab logout can land while the worker is acknowledging activation. Restore the
      // restrictive floor and roll back the endpoint instead of reviving the old account.
      if (persistentResumeSuppressed() || authSessionRevision() !== activationRevision) {
        await setPushNotificationSessionActive(false);
        throw new PushSetupError('PUSH_ACCOUNT_REQUIRED', 'Сессия изменилась во время настройки уведомлений');
      }
      // Keep legacy/current workers hidden until the exact durable session ACK and the post-ACK
      // account fence both pass. Check once more synchronously after posting privacy: if another
      // tab fenced logout in that tiny interval, our own following hidden message restores order.
      authorizeNotificationPrivacySync();
      if (persistentResumeSuppressed() || authSessionRevision() !== activationRevision) {
        await setPushNotificationSessionActive(false);
        throw new PushSetupError('PUSH_ACCOUNT_REQUIRED', 'Сессия изменилась во время настройки уведомлений');
      }
    } catch (error) {
      // The backend may have committed before its response was lost. Fail closed: remove that exact
      // account endpoint (or retain a durable tombstone offline) before reporting notifications off.
      await setPushNotificationSessionActive(false);
      await rollbackUnconfirmedSubscription(userId, subscription);
      throw error;
    }
    return { endpoint: subscription.endpoint, rotated };
  });
}

/** Update server preferences only after reconfirming the exact current subscription/key. */
export async function syncPushPrefs(userIdValue: unknown): Promise<void> {
  await ensurePushSubscribed(userIdValue);
}

/**
 * Opt-out/logout cleanup. Backend cleanup is queued before awaits. A local subscription is removed
 * only when its durable binding proves that it belongs to this account.
 */
export function unsubscribePush(userIdValue: unknown): Promise<boolean> {
  const userId = accountId(userIdValue);
  if (!userId) return Promise.resolve(false);
  const known = readPushBinding();
  if (known?.userId === userId) queuePushCleanup(userId, known.endpoint);
  return setPushNotificationSessionActive(false).then(() => serializePushMutation(async () => {
    try {
      let subscription: PushSubscription | null = null;
      if (pushSupported()) {
        try {
          const registration = await readyRegistration();
          subscription = await bounded(registration.pushManager.getSubscription(), PUSH_OPERATION_TIMEOUT_MS, 'Проверка push-подписки');
        } catch { /** Backend cleanup still proceeds from the durable known binding. */ }
      }
      const binding = readPushBinding();
      const endpoint = subscription?.endpoint || (binding?.userId === userId ? binding.endpoint : '');
      const bindingOwnsLocal = !!subscription && binding?.userId === userId && binding.endpoint === subscription.endpoint;
      if (endpoint && (!binding || binding.userId === userId)) queuePushCleanup(userId, endpoint);

      const cleanup = await drainPushCleanupsNow(userId);
      // A pre-metadata subscription is safe to remove only when the authenticated backend confirms
      // that this exact endpoint belonged to the current account.
      const ownsLocalSubscription = !!subscription
        && (!binding || bindingOwnsLocal)
        && cleanup.safeLocalEndpoints.has(subscription.endpoint);
      let localComplete = !subscription;
      if (ownsLocalSubscription && subscription) {
        try {
          localComplete = await bounded(subscription.unsubscribe(), PUSH_OPERATION_TIMEOUT_MS, 'Удаление push-подписки');
          if (localComplete) clearPushBinding(subscription.endpoint);
        } catch { localComplete = false; }
      } else if (subscription && cleanup.foreignLocalEndpoints.has(subscription.endpoint)) {
        // The authenticated server explicitly reports another owner. Keep that account's browser
        // subscription alive and discard only this stale local ownership claim.
        if (bindingOwnsLocal) clearPushBinding(subscription.endpoint);
        localComplete = true;
      } else if (subscription && binding && !bindingOwnsLocal) {
        localComplete = true;
      } else if (binding?.userId === userId && !subscription) {
        clearPushBinding(binding.endpoint);
        localComplete = true;
      }
      return cleanup.complete && localComplete;
    } finally {
      // An older serialized ensure may have posted `active:true` after logout began. The final
      // operation in the same mutation queue always restores the logged-out floor.
      await setPushNotificationSessionActive(false);
    }
  }));
}

export function pushSetupErrorMessage(error: unknown): string {
  if (error instanceof PushSetupError) return error.message;
  return 'Не удалось подключить фоновые уведомления. Проверьте сеть и повторите.';
}

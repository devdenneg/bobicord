import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

const here = dirname(fileURLToPath(import.meta.url));
const storage = new MemoryStorage();
storage.setItem('sess', 'legacy.jwt.must-survive-migration-failure');
globalThis.localStorage = storage;
const documentListeners = new Map();
globalThis.document = {
  cookie: '__Host-relay_csrf=csrf-current; harmless=1',
  visibilityState: 'visible',
  addEventListener(type, listener) {
    const listeners = documentListeners.get(type) || new Set();
    listeners.add(listener);
    documentListeners.set(type, listeners);
  },
};
let authCookieLockCalls = 0;
let authCookieLockTail = Promise.resolve();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    locks: {
      request(_name, _options, callback) {
        authCookieLockCalls += 1;
        const run = authCookieLockTail.then(() => callback());
        authCookieLockTail = run.catch(() => {});
        return run;
      },
    },
  },
});
const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, listener) {
    const listeners = windowListeners.get(type) || new Set();
    listeners.add(listener);
    windowListeners.set(type, listeners);
  },
};
function dispatchWindowEvent(type, event) {
  for (const listener of windowListeners.get(type) || []) listener(event);
}

const source = readFileSync(join(here, 'authSession.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const authUrl = 'data:text/javascript,' + encodeURIComponent(js);
const auth = await import(authUrl);

assert.equal(auth.authSessionMode(), 'legacy');
assert.equal(auth.getAccessToken(), 'legacy.jwt.must-survive-migration-failure');
assert.equal(auth.installPersistentAuthBundle({ protocol: 'persistent-v1', accessToken: 'partial' }), null);
assert.equal(storage.getItem('sess'), 'legacy.jwt.must-survive-migration-failure',
  'a malformed/partial upgrade must never erase the live legacy bearer');

const firstBundle = {
  protocol: 'persistent-v1',
  token: 'memory.access.one',
  accessToken: 'memory.access.one',
  accessExpiresAt: Date.now() + 10 * 60_000,
  sessionId: 'device-session-1',
  user: { id: 'u1', username: 'user1' },
  account: { state: 'ready' },
};
assert.deepEqual(auth.installPersistentAuthBundle(firstBundle), firstBundle);

const missedFenceChanges = [];
const unsubscribeMissedFence = auth.subscribeAccessTokenChanges((change) => missedFenceChanges.push(change));
storage.setItem('relay.auth.logged-out.v1', 'missed-while-frozen.logout-fence');
dispatchWindowEvent('pageshow', {});
assert.equal(auth.getAccessToken(), null,
  'pageshow must reconcile a durable logout fence when iOS/BFCache skipped the storage event');
assert.equal(missedFenceChanges.at(-1)?.reason, 'remote-logout');
unsubscribeMissedFence();
assert.equal(auth.clearPersistentLogoutPending('missed-while-frozen.logout-fence'), true);
assert.deepEqual(auth.installPersistentAuthBundle(firstBundle), firstBundle);
assert.equal(auth.authSessionMode(), 'persistent');
assert.equal(auth.getAccessToken(), firstBundle.accessToken);
assert.equal(storage.getItem('sess'), null, 'persistent access JWT must not remain in localStorage');
assert.equal([...storage.values.values()].includes(firstBundle.accessToken), false,
  'persistent access JWT must remain memory-only');
assert.equal(auth.accessTokenNeedsRefresh(Date.now()), false);

const crossAccountRefresh = {
  ...firstBundle,
  token: 'memory.access.wrong-account',
  accessToken: 'memory.access.wrong-account',
  sessionId: 'device-session-other-account',
  user: { id: 'u2', username: 'user2' },
};
assert.equal(auth.installPersistentAuthBundle(crossAccountRefresh, 'refresh'), null,
  'a refresh-cookie conflict must never switch an already-open tab to another account');
assert.equal(auth.getAccessToken(), firstBundle.accessToken);

const changes = [];
const unsubscribe = auth.subscribeAccessTokenChanges((change) => changes.push(change));
const refreshed = {
  ...firstBundle,
  token: 'memory.access.two',
  accessToken: 'memory.access.two',
  accessExpiresAt: Date.now() + 20 * 60_000,
};
assert.deepEqual(auth.installPersistentAuthBundle(refreshed, 'refresh'), refreshed);
assert.equal(changes.length, 1);
assert.equal(changes[0].reason, 'refresh');
assert.equal(changes[0].previousToken, firstBundle.accessToken);
assert.equal(changes[0].token, refreshed.accessToken);
assert.equal(storage.getItem('sess'), null);
unsubscribe();

const revisionBeforeLogout = auth.authSessionRevision();
auth.setAccessToken(null);
assert.equal(auth.getAccessToken(), null);
const localLogoutFence = storage.getItem('relay.auth.logged-out.v1');
assert.ok(localLogoutFence,
  'offline logout must leave a non-secret anti-resurrection fence');
assert.equal(auth.hasPersistentResumeCandidate(), false,
  'a surviving HttpOnly refresh cookie must not undo explicit offline logout');
assert.equal(auth.installPersistentAuthBundle(refreshed, 'refresh', revisionBeforeLogout), null,
  'a refresh response that arrives after explicit logout must be discarded');
assert.equal(auth.getAccessToken(), null);
assert.equal(storage.getItem('relay.auth.logged-out.v1'), localLogoutFence);

assert.equal(auth.installPersistentAuthBundle(firstBundle), null,
  'no response may replace an unresolved explicit-logout fence');
assert.equal(auth.clearPersistentLogoutPending(localLogoutFence), true);
assert.deepEqual(auth.installPersistentAuthBundle(firstBundle), firstBundle);
assert.equal(auth.hasPersistentResumeCandidate(), true);

const revisionBeforeOtherTabLogout = auth.authSessionRevision();
const remoteLogoutChanges = [];
const unsubscribeRemoteLogout = auth.subscribeAccessTokenChanges((change) => remoteLogoutChanges.push(change));
storage.setItem('relay.auth.logged-out.v1', 'other-tab.logout-fence');
dispatchWindowEvent('storage', {
  key: 'relay.auth.logged-out.v1',
  oldValue: null,
  newValue: 'other-tab.logout-fence',
});
assert.equal(auth.getAccessToken(), null,
  'a logout in another tab must synchronously clear this tab memory state');
assert.equal(remoteLogoutChanges.at(-1)?.reason, 'remote-logout',
  'the application shell must be able to leave a stale authenticated view after another-tab logout');
unsubscribeRemoteLogout();
assert.equal(auth.installPersistentAuthBundle(refreshed, 'refresh', revisionBeforeOtherTabLogout), null,
  'a late refresh from this tab must not resurrect a logout from another tab');
assert.equal(storage.getItem('relay.auth.logged-out.v1'), 'other-tab.logout-fence');
assert.equal(auth.clearPersistentLogoutPending('other-tab.logout-fence'), true);
assert.deepEqual(auth.installPersistentAuthBundle(firstBundle), firstBundle);

const terminalChanges = [];
const unsubscribeTerminal = auth.subscribeAccessTokenChanges((change) => terminalChanges.push(change));
auth.clearTerminalAuthSession();
assert.equal(auth.getAccessToken(), null);
assert.equal(terminalChanges.at(-1)?.reason, 'terminal-revocation',
  'authoritative same-tab revocation must make the application leave its stale authenticated UI');
unsubscribeTerminal();
const terminalFence = storage.getItem('relay.auth.logged-out.v1');
assert.ok(terminalFence);
assert.equal(auth.clearPersistentLogoutPending(terminalFence), true);
assert.deepEqual(auth.installPersistentAuthBundle(firstBundle), firstBundle);

assert.equal(auth.readPersistentCsrfCookie('x=1; __Host-relay_csrf=exact-value; y=2'), 'exact-value');
assert.equal(auth.readPersistentCsrfCookie('__Host-relay_csrf_extra=wrong'), null);
assert.equal(auth.readPersistentCsrfCookie('__Host-relay_csrf='), null);

const apiSource = readFileSync(join(here, 'api.ts'), 'utf8');
assert.match(apiSource, /let refreshInFlight: Promise<PersistentSessionResponse> \| null = null/,
  'refresh must be single-flight within a tab');
assert.match(apiSource, /if \(refreshInFlight\) return refreshInFlight/);
assert.match(apiSource, /error\.code !== 'REFRESH_STALE'/);
assert.match(apiSource, /setTimeout\(resolve, 75\)[\s\S]*persistentFetch<PersistentSessionResponse>\('\/auth\/session\/refresh'\)/,
  'multi-tab stale generations receive one bounded cookie-jar retry');
assert.match(apiSource, /if \(isTerminalSessionError\(error\)\) clearTerminalAuthSession\(\)/);
assert.doesNotMatch(apiSource, /REFRESH_STALE'[\s\S]{0,120}setAccessToken\(null\)/,
  'REFRESH_STALE is concurrency, never a local logout signal');
assert.match(apiSource, /authRetried: true/,
  'an authenticated 401 may replay the original request only once');
assert.match(apiSource, /credentials: 'include'/);
assert.match(apiSource, /'X-Relay-Auth-Protocol': PERSISTENT_AUTH_PROTOCOL/);
assert.match(apiSource, /'X-Relay-Auth-Transport': 'cookie-v1'/);
assert.match(apiSource, /beginAuthLogoutFence\(\);[\s\S]*setAccessToken\(null\);[\s\S]*drainPendingLogout\(\)/,
  'logout fence must be installed before the revocation request');
assert.match(apiSource, /fenceBootstrapAgainstPriorLogout\([^)]*\)[\s\S]*await drainPendingLogout\(\)/,
  'new login must not race a late cookie-clearing response from prior logout');
assert.match(apiSource, /const PERSISTENT_COOKIE_TRANSPORT = !IS_TAURI/,
  'browser cookies and the Tauri OS-protected bearer broker remain separate transports');
assert.match(apiSource, /export function hasSessionCandidate\(\): boolean \{\s*if \(persistentResumeSuppressed\(\)\) return false/,
  'offline logout boot must render auth without joining a cookie-lock drain');
assert.match(apiSource, /export function resumePersistentSession[^\{]+\{[\s\S]{0,300}if \(persistentResumeSuppressed\(\)\) return Promise\.resolve\(null\)/,
  'resume must guard the durable fence before requesting the cross-tab cookie lock');
assert.match(apiSource, /withAuthCookieLock\(performPersistentLogoutDrain\)[\s\S]*performLegacyLogoutDrain\(\)/,
  'only persistent cookie revocation may hold the auth cookie lock');
assert.doesNotMatch(apiSource, /logoutDrainInFlight = withAuthCookieLock/,
  'sequential legacy tombstones must stay outside the auth cookie lock');
assert.match(apiSource, /AUTH_COOKIE_LOCK_WAIT_MS[\s\S]*AbortController[\s\S]*signal: controller\.signal/,
  'a frozen mobile tab cannot hold every other account operation behind WebLock forever');
assert.match(apiSource, /persistentComplete = IS_TAURI[\s\S]*await withAuthCookieLock\(performPersistentLogoutDrain\)[\s\S]*catch \{ return false; \}/,
  'browser lock timeout and native broker failure both keep the durable logout fence retryable');

const pushCleanupSource = readFileSync(join(here, 'pushCleanup.ts'), 'utf8');
const pushCleanupJs = ts.transpileModule(pushCleanupSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pushCleanupUrl = 'data:text/javascript,' + encodeURIComponent(pushCleanupJs);
const appLatestUrl = 'data:text/javascript,' + encodeURIComponent(`
  export class AppLatestLoader {
    load() { return Promise.resolve(null); }
  }
`);
const nativeAuthBrokerUrl = 'data:text/javascript,' + encodeURIComponent(`
  export class NativeAuthBrokerError extends Error {}
  export const beginNativeLogout = async () => false;
  export const changeNativePassword = async () => { throw new Error('native-only'); };
  export const drainNativeLogout = async () => ({ complete: true, pending: false });
  export const loginNativeAuth = async () => { throw new Error('native-only'); };
  export const refreshNativeAuth = async () => { throw new Error('native-only'); };
  export const resumeNativeAuth = async () => ({ state: 'anonymous' });
  export const verifyNativeEmail = async () => { throw new Error('native-only'); };
  export const verifyNativeRegistration = async () => { throw new Error('native-only'); };
`);
const apiJs = ts.transpileModule(apiSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace("from './authSession';", `from ${JSON.stringify(authUrl)};`)
  .replace("from './pushCleanup';", `from ${JSON.stringify(pushCleanupUrl)};`)
  .replace("from './appLatest';", `from ${JSON.stringify(appLatestUrl)};`)
  .replace("from './nativeAuthBroker';", `from ${JSON.stringify(nativeAuthBrokerUrl)};`);
let fetchHandler = null;
globalThis.fetch = (...args) => fetchHandler(...args);
const apiModule = await import('data:text/javascript,' + encodeURIComponent(apiJs));

storage.setItem('relay.auth.logged-out.v1', 'boot-must-not-wait.logout-fence');
const guardedLockCalls = authCookieLockCalls;
assert.equal(apiModule.hasSessionCandidate(), false);
assert.equal(await apiModule.api.resumePersistentSession(), null);
assert.equal(authCookieLockCalls, guardedLockCalls,
  'a durable logout fence must be checked before the cookie WebLock request');
assert.equal(auth.clearPersistentLogoutPending('boot-must-not-wait.logout-fence'), true);

// A background-frozen tab can retain the cookie lock after its JS timers stop. The foreground tab
// must fail finitely without deleting the live account; a later Retry can acquire the lock normally.
{
  const originalRequest = globalThis.navigator.locks.request;
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.navigator.locks.request = (_name, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  globalThis.setTimeout = (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args);
  try {
    const liveBeforeLockTimeout = auth.getAccessToken();
    await assert.rejects(apiModule.api.resumePersistentSession(), (error) => error.code === 'AUTH_LOCK_TIMEOUT');
    assert.equal(auth.getAccessToken(), liveBeforeLockTimeout,
      'timing out while waiting for another tab never logs out the current account');
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.navigator.locks.request = originalRequest;
  }
}

const jsonResponse = (status, value) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const stalledUploadResponse = (signal, onBodyStarted = () => {}) => ({
  ok: true,
  status: 200,
  json() {
    onBodyStarted();
    return new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' }));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  },
});

// Receiving HTTP headers is not upload completion. A mobile radio can freeze the response body;
// both the absolute upload timeout and caller cancellation must still own that pending json().
{
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args);
  fetchHandler = (_url, init = {}) => Promise.resolve(stalledUploadResponse(init.signal));
  try {
    await assert.rejects(
      apiModule.api.uploadImage(new Blob(['image'], { type: 'image/png' })),
      (error) => error.message === 'Сервер не ответил вовремя',
      'the upload deadline remains active until the full response body settles',
    );
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }

  const external = new AbortController();
  let bodyStarted = false;
  fetchHandler = (_url, init = {}) => Promise.resolve(stalledUploadResponse(init.signal, () => { bodyStarted = true; }));
  const cancelled = apiModule.api.uploadProfileBanner(new Blob(['banner']), external.signal);
  for (let spin = 0; spin < 8 && !bodyStarted; spin++) await Promise.resolve();
  assert.equal(bodyStarted, true, 'the cancellation regression reaches a headers-complete stalled body');
  external.abort();
  await assert.rejects(cancelled, (error) => error.message === 'Загрузка отменена');
}

// An ordinary authenticated response has no auth bundle to install, so push subscribe explicitly
// fences its success against a logout/account switch that lands while the request is in flight.
{
  let releasePushSubscribe;
  fetchHandler = (url) => {
    assert.match(String(url), /\/api\/push\/subscribe$/);
    return new Promise((resolve) => { releasePushSubscribe = resolve; });
  };
  const pendingPushSubscribe = apiModule.api.pushSubscribe({
    endpoint: 'https://push.example/inflight', keys: { p256dh: 'p', auth: 'a' },
  }, { mention: true, stream: true, privacy: 'hidden' });
  for (let spin = 0; spin < 8 && !releasePushSubscribe; spin++) await Promise.resolve();
  assert.equal(typeof releasePushSubscribe, 'function');
  storage.setItem('relay.auth.logged-out.v1', 'push-inflight.logout-fence');
  dispatchWindowEvent('storage', {
    key: 'relay.auth.logged-out.v1', oldValue: null, newValue: 'push-inflight.logout-fence',
  });
  releasePushSubscribe(jsonResponse(200, {
    ok: true, userId: 'u1', endpoint: 'https://push.example/inflight',
  }));
  await assert.rejects(pendingPushSubscribe, (error) => error.code === 'AUTH_CONTEXT_CHANGED');
  assert.equal(auth.clearPersistentLogoutPending('push-inflight.logout-fence'), true);
  assert.deepEqual(auth.installPersistentAuthBundle(firstBundle), firstBundle);
}
let releaseRefresh;
let refreshCalls = 0;
fetchHandler = () => {
  refreshCalls += 1;
  return new Promise((resolve) => { releaseRefresh = resolve; });
};
const singleFlightBundle = {
  ...firstBundle,
  token: 'memory.access.single-flight',
  accessToken: 'memory.access.single-flight',
  accessExpiresAt: Date.now() + 10 * 60_000,
};
const refreshOne = apiModule.refreshAccessSession();
const refreshTwo = apiModule.refreshAccessSession();
assert.equal(refreshOne, refreshTwo, 'simultaneous callers must share one refresh promise');
await Promise.resolve();
assert.equal(refreshCalls, 1);
assert.equal(authCookieLockCalls, 1,
  'refresh rotation must hold one cross-tab cookie lock until its response is committed');
releaseRefresh(jsonResponse(200, singleFlightBundle));
await Promise.all([refreshOne, refreshTwo]);
assert.equal(auth.getAccessToken(), singleFlightBundle.accessToken);

const requestTrace = [];
let requestStep = 0;
const retryBundle = {
  ...singleFlightBundle,
  token: 'memory.access.after-401',
  accessToken: 'memory.access.after-401',
  accessExpiresAt: Date.now() + 10 * 60_000,
};
fetchHandler = (url, init = {}) => {
  requestStep += 1;
  requestTrace.push({ url: String(url), authorization: init.headers?.Authorization, credentials: init.credentials });
  if (requestStep === 1) return Promise.resolve(jsonResponse(401, { error: { code: 'ACCESS_EXPIRED', message: 'expired' } }));
  if (requestStep === 2) return Promise.resolve(jsonResponse(200, retryBundle));
  return Promise.resolve(jsonResponse(200, { user: { id: 'u1' }, servers: [] }));
};
assert.deepEqual(await apiModule.api.me(), { user: { id: 'u1' }, servers: [] });
assert.equal(requestStep, 3, '401 must cause exactly one refresh and one replay');
assert.equal(requestTrace[0].authorization, 'Bearer ' + singleFlightBundle.accessToken);
assert.match(requestTrace[1].url, /\/api\/auth\/session\/refresh$/);
assert.equal(requestTrace[2].authorization, 'Bearer ' + retryBundle.accessToken);
assert.equal(requestTrace[2].credentials, 'include');

const beforeTransportFailure = auth.getAccessToken();
fetchHandler = () => Promise.reject(new TypeError('offline'));
await assert.rejects(apiModule.refreshAccessSession(), (error) => error.code === 'NETWORK_ERROR');
assert.equal(auth.getAccessToken(), beforeTransportFailure,
  'offline refresh failure must not clear the live in-memory account');
assert.equal(storage.getItem('relay.auth.logged-out.v1'), null);

fetchHandler = () => Promise.resolve(jsonResponse(503, { error: { code: 'AUTH_UNAVAILABLE', message: 'restart' } }));
await assert.rejects(apiModule.refreshAccessSession(), (error) => error.status === 503);
assert.equal(auth.getAccessToken(), beforeTransportFailure,
  '5xx refresh failure must not clear the live in-memory account');
assert.equal(storage.getItem('relay.auth.logged-out.v1'), null);

let staleCalls = 0;
const recoveredBundle = {
  ...retryBundle,
  token: 'memory.access.stale-recovered',
  accessToken: 'memory.access.stale-recovered',
  accessExpiresAt: Date.now() + 10 * 60_000,
};
fetchHandler = () => {
  staleCalls += 1;
  return Promise.resolve(staleCalls === 1
    ? jsonResponse(401, { error: { code: 'REFRESH_STALE', message: 'rotated by another tab' } })
    : jsonResponse(200, recoveredBundle));
};
await apiModule.refreshAccessSession();
assert.equal(staleCalls, 2, 'multi-tab stale refresh gets one bounded retry');
assert.equal(auth.getAccessToken(), recoveredBundle.accessToken);
assert.equal(storage.getItem('relay.auth.logged-out.v1'), null,
  'REFRESH_STALE recovery must never install a logout fence');

let crossAccountRepairStep = 0;
fetchHandler = () => {
  crossAccountRepairStep += 1;
  return Promise.resolve(crossAccountRepairStep === 1
    ? jsonResponse(403, { error: { code: 'AUTH_CSRF_INVALID', message: 'desynchronised' } })
    : jsonResponse(200, crossAccountRefresh));
};
await assert.rejects(apiModule.refreshAccessSession(), (error) => error.code === 'INVALID_AUTH_RESPONSE');
assert.equal(crossAccountRepairStep, 2);
assert.equal(auth.getAccessToken(), recoveredBundle.accessToken,
  'CSRF repair must not switch a live tab to the account found in a conflicting shared cookie');
assert.equal(storage.getItem('relay.auth.logged-out.v1'), null,
  'a recoverable cookie conflict is not an explicit or authoritative logout');

const sameSessionRefresh = {
  ...recoveredBundle,
  token: 'memory.access.concurrent-refresh',
  accessToken: 'memory.access.concurrent-refresh',
};
const securityMutationBundle = {
  ...recoveredBundle,
  token: 'memory.access.security-mutation',
  accessToken: 'memory.access.security-mutation',
  accessExpiresAt: Date.now() + 10 * 60_000,
};
fetchHandler = (url) => {
  assert.match(String(url), /\/api\/auth\/password\/change$/);
  assert.deepEqual(auth.installPersistentAuthBundle(sameSessionRefresh, 'refresh'), sameSessionRefresh,
    'the test must advance the tab revision before the mutation response arrives');
  return Promise.resolve(jsonResponse(200, securityMutationBundle));
};
assert.deepEqual(await apiModule.api.changePassword('old-password', 'new-password'), securityMutationBundle);
assert.equal(auth.getAccessToken(), securityMutationBundle.accessToken,
  'a committed security mutation for the same durable session must win its concurrent refresh');

let releaseDelayedMutation;
let delayedMutationStarted = false;
let logoutPassedDelayedWriter = false;
fetchHandler = (url) => {
  if (String(url).endsWith('/api/auth/password/change')) {
    delayedMutationStarted = true;
    return new Promise((resolve) => { releaseDelayedMutation = resolve; });
  }
  assert.match(String(url), /\/api\/auth\/session\/logout$/);
  logoutPassedDelayedWriter = true;
  return Promise.resolve(jsonResponse(200, { ok: true }));
};
const delayedMutation = apiModule.api.changePassword('new-password', 'newer-password');
await Promise.resolve();
await Promise.resolve();
assert.equal(delayedMutationStarted, true);
apiModule.api.beginLogout();
const logoutBehindMutation = apiModule.api.logoutSession();
await Promise.resolve();
await Promise.resolve();
assert.equal(logoutPassedDelayedWriter, false,
  'logout must wait until a pre-fence cookie-writing mutation has committed its response');
releaseDelayedMutation(jsonResponse(200, {
  ...securityMutationBundle,
  token: 'memory.access.delayed-security-mutation',
  accessToken: 'memory.access.delayed-security-mutation',
}));
await assert.rejects(delayedMutation, (error) => error.code === 'INVALID_AUTH_RESPONSE');
await logoutBehindMutation;
assert.equal(logoutPassedDelayedWriter, true);
assert.equal(storage.getItem('relay.auth.logged-out.v1'), null,
  'the exact logout clears its fence only after every older Set-Cookie writer is finished');
assert.deepEqual(auth.installPersistentAuthBundle(securityMutationBundle), securityMutationBundle);

globalThis.document.cookie = '';
apiModule.api.beginLogout();
let missingCsrfRecoveryCalls = 0;
fetchHandler = (url) => {
  missingCsrfRecoveryCalls += 1;
  assert.match(String(url), /\/api\/auth\/session\/logout-recover$/);
  return Promise.resolve(jsonResponse(503, { error: { code: 'AUTH_UNAVAILABLE', message: 'restart' } }));
};
await apiModule.api.logoutSession();
assert.ok(storage.getItem('relay.auth.logged-out.v1'),
  'missing readable CSRF must never be mistaken for proof that the HttpOnly refresh disappeared');
fetchHandler = () => {
  missingCsrfRecoveryCalls += 1;
  return Promise.resolve(jsonResponse(200, { ok: true }));
};
assert.equal(await apiModule.api.drainPendingLogout(), true);
assert.equal(missingCsrfRecoveryCalls, 2);
globalThis.document.cookie = '__Host-relay_csrf=csrf-current';
assert.deepEqual(auth.installPersistentAuthBundle(securityMutationBundle), securityMutationBundle);

let csrfLogoutCalls = 0;
apiModule.api.beginLogout();
assert.equal(auth.getAccessToken(), securityMutationBundle.accessToken,
  'beginLogout keeps memory access only for best-effort push cleanup');
fetchHandler = (url, init = {}) => {
  csrfLogoutCalls += 1;
  if (String(url).endsWith('/api/auth/session/logout')) {
    assert.equal(init.headers?.['X-Relay-CSRF'], 'csrf-current');
    return Promise.resolve(jsonResponse(403, { error: { code: 'AUTH_CSRF_INVALID', message: 'desynchronised' } }));
  }
  assert.match(String(url), /\/api\/auth\/session\/logout-recover$/);
  assert.equal(init.headers?.['X-Relay-CSRF'], '1');
  return Promise.resolve(jsonResponse(200, { ok: true }));
};
await apiModule.api.logoutSession();
assert.equal(csrfLogoutCalls, 2, 'CSRF desynchronisation gets one bounded revoke-only recovery');
assert.equal(storage.getItem('relay.auth.logged-out.v1'), null,
  'successful recovery must leave the browser able to log into another account');
assert.deepEqual(auth.installPersistentAuthBundle(securityMutationBundle), securityMutationBundle);

let blockedLoginCalls = 0;
let failedLogoutCalls = 0;
apiModule.api.beginLogout();
fetchHandler = (url) => {
  if (String(url).endsWith('/api/auth/session/logout')) {
    failedLogoutCalls += 1;
    return Promise.resolve(jsonResponse(503, { error: { code: 'AUTH_UNAVAILABLE', message: 'restart' } }));
  }
  blockedLoginCalls += 1;
  return Promise.resolve(jsonResponse(200, securityMutationBundle));
};
await apiModule.api.logoutSession();
assert.ok(storage.getItem('relay.auth.logged-out.v1'),
  'a failed server revocation must retain the anti-resurrection fence');
await assert.rejects(apiModule.api.login('another-user', 'password'), (error) => error.code === 'LOGOUT_PENDING');
assert.equal(blockedLoginCalls, 0,
  'new login must not replace the only cookie for an unrevoked durable session');
assert.ok(failedLogoutCalls >= 2, 'login retries the pending revocation before reporting LOGOUT_PENDING');
fetchHandler = () => Promise.resolve(jsonResponse(200, { ok: true }));
assert.equal(await apiModule.api.drainPendingLogout(), true);
assert.deepEqual(auth.installPersistentAuthBundle(securityMutationBundle), securityMutationBundle);

auth.setAccessToken('legacy.logout.must-be-revoked');
globalThis.document.cookie = '';
apiModule.api.beginLogout();
assert.equal(auth.getAccessToken(), 'legacy.logout.must-be-revoked');
assert.equal(storage.getItem('sess'), null,
  'a crash after beginLogout must not reload the legacy credential before tombstoning it');
let legacyLogoutCalls = 0;
let legacyCookieRecoveryCalls = 0;
fetchHandler = (url, init = {}) => {
  if (String(url).endsWith('/api/auth/session/logout-recover')) {
    legacyCookieRecoveryCalls += 1;
    return Promise.resolve(jsonResponse(200, { ok: true }));
  }
  legacyLogoutCalls += 1;
  assert.match(String(url), /\/api\/auth\/session\/logout-legacy$/);
  assert.equal(init.headers?.Authorization, 'Bearer legacy.logout.must-be-revoked');
  return Promise.resolve(jsonResponse(503, { error: { code: 'AUTH_UNAVAILABLE', message: 'restart' } }));
};
await apiModule.api.logoutSession();
assert.equal(auth.getAccessToken(), null);
assert.deepEqual(auth.pendingLegacyLogoutTokens(), ['legacy.logout.must-be-revoked'],
  'offline/5xx legacy logout keeps an unusable local revocation credential for retry');
fetchHandler = () => {
  legacyLogoutCalls += 1;
  return Promise.resolve(jsonResponse(200, { ok: true }));
};
assert.equal(await apiModule.api.drainPendingLogout(), true);
assert.equal(legacyLogoutCalls, 2);
assert.equal(legacyCookieRecoveryCalls, 1,
  'browser legacy logout probes and clears any hidden rolling-upgrade cookie before dropping its fence');
assert.deepEqual(auth.pendingLegacyLogoutTokens(), [],
  'the legacy bearer is erased only after the server confirms its tombstone');

auth.setAccessToken('legacy.account-switch.must-be-revoked');
let accountSwitchLegacyCalls = 0;
let accountSwitchCookieCalls = 0;
fetchHandler = (url, init = {}) => {
  if (String(url).endsWith('/api/auth/session/logout-recover')) {
    accountSwitchCookieCalls += 1;
    return Promise.resolve(jsonResponse(200, { ok: true }));
  }
  accountSwitchLegacyCalls += 1;
  assert.match(String(url), /\/api\/auth\/session\/logout-legacy$/);
  assert.equal(init.headers?.Authorization, 'Bearer legacy.account-switch.must-be-revoked');
  return Promise.resolve(jsonResponse(200, { ok: true }));
};
auth.setAccessToken(null);
assert.equal(storage.getItem('sess'), null);
assert.deepEqual(auth.pendingLegacyLogoutTokens(), ['legacy.account-switch.must-be-revoked'],
  'an explicit setToken(null) account switch must durably capture the legacy bearer before removal');
assert.equal(await apiModule.api.drainPendingLogout(), true);
assert.equal(accountSwitchLegacyCalls, 1);
assert.equal(accountSwitchCookieCalls, 1,
  'a rolling hidden cookie is also revoked before the account-switch fence is cleared');
assert.deepEqual(auth.pendingLegacyLogoutTokens(), []);

globalThis.document.cookie = '__Host-relay_csrf=csrf-current';
assert.deepEqual(auth.installPersistentAuthBundle(securityMutationBundle), securityMutationBundle);
const workingStorage = globalThis.localStorage;
const unavailableStorage = {
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('storage unavailable'); },
  removeItem() { throw new Error('storage unavailable'); },
};
globalThis.localStorage = unavailableStorage;
let memoryFenceLogoutCalls = 0;
try {
  fetchHandler = (url) => {
    memoryFenceLogoutCalls += 1;
    assert.match(String(url), /\/api\/auth\/session\/logout$/);
    return Promise.resolve(jsonResponse(200, { ok: true }));
  };
  apiModule.api.beginLogout();
  assert.ok(auth.persistentLogoutFence(),
    'the current process must retain a logout fence when localStorage throws');
  assert.equal(await apiModule.api.logoutSession(), undefined);
  assert.equal(memoryFenceLogoutCalls, 1,
    'an in-memory fence must still drive exact persistent-cookie revocation while online');
  assert.equal(auth.persistentLogoutFence(), '');
} finally {
  globalThis.localStorage = workingStorage;
}

// A new logout can begin after the old pass cleared its fence but while that pass is still draining
// a legacy tombstone. The single-flight promise must observe the new generation and run another
// persistent-cookie pass instead of silently leaving the new session alive.
globalThis.document.cookie = '__Host-relay_csrf=csrf-current';
assert.deepEqual(auth.installPersistentAuthBundle(securityMutationBundle), securityMutationBundle);
auth.queueLegacyLogoutToken('legacy.overlap.blocker');
let overlappingPersistentCalls = 0;
let overlappingLegacyStarted = false;
let releaseOverlappingLegacy;
fetchHandler = (url) => {
  if (String(url).endsWith('/api/auth/session/logout')) {
    overlappingPersistentCalls += 1;
    return Promise.resolve(jsonResponse(200, { ok: true }));
  }
  assert.match(String(url), /\/api\/auth\/session\/logout-legacy$/);
  overlappingLegacyStarted = true;
  return new Promise((resolve) => { releaseOverlappingLegacy = resolve; });
};
apiModule.api.beginLogout();
const olderDrain = apiModule.api.logoutSession();
for (let spin = 0; spin < 20 && !overlappingLegacyStarted; spin++) await Promise.resolve();
assert.equal(overlappingLegacyStarted, true);
assert.equal(auth.persistentLogoutFence(), '', 'the first cookie revoke completes before legacy cleanup');
const secondSession = {
  ...securityMutationBundle,
  token: 'memory.access.overlapping-session',
  accessToken: 'memory.access.overlapping-session',
  sessionId: 'device-session-overlapping',
};
assert.deepEqual(auth.installPersistentAuthBundle(secondSession), secondSession);
apiModule.api.beginLogout();
const newerDrain = apiModule.api.logoutSession();
releaseOverlappingLegacy(jsonResponse(200, { ok: true }));
await Promise.all([olderDrain, newerDrain]);
assert.equal(overlappingPersistentCalls, 2,
  'a new fence requested during the old drain must trigger a second persistent revoke pass');
assert.equal(auth.persistentLogoutFence(), '');

storage.clear();
auth.resetAuthSessionForTests();
globalThis.document.cookie = '';
assert.equal(apiModule.hasSessionCandidate(), true,
  'browser boot must probe for an HttpOnly refresh even when JavaScript cannot see a CSRF cookie');
let ambientRecoverCalls = 0;
const ambientBundle = {
  ...firstBundle,
  token: 'memory.access.ambient-recovered',
  accessToken: 'memory.access.ambient-recovered',
  accessExpiresAt: Date.now() + 10 * 60_000,
};
fetchHandler = (url, init = {}) => {
  ambientRecoverCalls += 1;
  assert.match(String(url), /\/api\/auth\/session\/recover$/);
  assert.equal(init.headers?.['X-Relay-CSRF'], '1');
  return Promise.resolve(jsonResponse(200, ambientBundle));
};
assert.deepEqual(await apiModule.api.resumePersistentSession(), ambientBundle);
assert.equal(auth.getAccessToken(), ambientBundle.accessToken);

storage.clear();
auth.resetAuthSessionForTests();
let overwrittenLoginCalls = 0;
fetchHandler = (url) => {
  if (String(url).endsWith('/api/auth/session/recover')) {
    ambientRecoverCalls += 1;
    return Promise.resolve(jsonResponse(200, ambientBundle));
  }
  overwrittenLoginCalls += 1;
  return Promise.resolve(jsonResponse(200, ambientBundle));
};
await assert.rejects(apiModule.api.login('different-user', 'password'),
  (error) => error.code === 'SESSION_ALREADY_ACTIVE' && error.status === 409);
assert.equal(overwrittenLoginCalls, 0,
  'bootstrap login must neither overwrite nor masquerade over an invisible live HttpOnly session');

storage.clear();
auth.resetAuthSessionForTests();
globalThis.document.cookie = '';
let sameIdentityLoginCalls = 0;
fetchHandler = (url) => {
  if (String(url).endsWith('/api/auth/session/recover')) {
    return Promise.resolve(jsonResponse(200, ambientBundle));
  }
  sameIdentityLoginCalls += 1;
  return Promise.resolve(jsonResponse(200, ambientBundle));
};
assert.deepEqual(await apiModule.api.login('USER1', 'password'), ambientBundle,
  'an exact same-identity cookie is a safe idempotent recovery for a lost login response');
assert.equal(sameIdentityLoginCalls, 0);

storage.clear();
storage.setItem('sess', 'legacy.account-b');
auth.resetAuthSessionForTests();
globalThis.document.cookie = '__Host-relay_csrf=csrf-account-a';
const resumeOrder = [];
fetchHandler = (url) => {
  resumeOrder.push(String(url));
  return Promise.resolve(jsonResponse(200, ambientBundle));
};
assert.deepEqual(await apiModule.api.resumePersistentSession(), ambientBundle);
assert.equal(resumeOrder.length, 1);
assert.match(resumeOrder[0], /\/api\/auth\/session\/recover$/);
assert.equal(storage.getItem('sess'), null,
  'authoritative ambient account A must win before a rolling legacy account B can overwrite it');

storage.clear();
storage.setItem('sess', 'legacy.account-b');
auth.resetAuthSessionForTests();
globalThis.document.cookie = '__Host-relay_csrf=csrf-account-a';
let rollbackUpgradeCalls = 0;
fetchHandler = (url) => {
  if (String(url).endsWith('/api/auth/session/recover')) {
    return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'rolling old server' } }));
  }
  rollbackUpgradeCalls += 1;
  return Promise.resolve(jsonResponse(200, ambientBundle));
};
await assert.rejects(apiModule.api.resumePersistentSession(),
  (error) => error.code === 'PERSISTENT_AUTH_UNAVAILABLE' && error.status === 503);
assert.equal(rollbackUpgradeCalls, 0,
  'a rolling old server must not let legacy account B overwrite a readable persistent account A');
assert.equal(storage.getItem('sess'), 'legacy.account-b');

const notifySource = readFileSync(join(here, 'notifyws.ts'), 'utf8');
assert.match(notifySource, /ev\.code === 4001[\s\S]*persistentSessionActive\(\)[\s\S]*refreshAccessSession\(\)/,
  'notify 4001 must refresh persistent auth before treating it as revocation');
assert.match(notifySource, /Realtime временно недоступен — аккаунт остаётся подключён/,
  'transport refresh failure must preserve the live account');

console.log('persistent auth session lifecycle: ok');

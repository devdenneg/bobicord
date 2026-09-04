import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function moduleFromSource(path, imports, globals = {}) {
  const filename = fileURLToPath(new URL(path, import.meta.url));
  const source = readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(js, {
    exports, Error, console, ...globals,
    require(id) {
      if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
      return imports[id];
    },
  }, { filename });
  return exports;
}

const bootstrapPolicy = moduleFromSource('./authBootstrap.ts', {});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
const failure = (code = 'REQUEST_TIMEOUT', status = 0) => Object.assign(new Error(code), { code, status });
const user = (id = 'alice') => ({ id, username: id, displayName: id });
const snapshot = (id = 'alice') => ({ user: user(id), servers: [{ id: `${id}-server`, unread: 2 }] });

// Execute the entire production store, including acceptSession/afterAuth/loadMe/logout and its
// timers. Only external I/O is mocked; tests never duplicate the bootstrap orchestration.
function harness() {
  let token = 'token-alice', now = 0, nextTimer = 1, reloads = 0;
  const timers = new Map(), requests = [], engines = [], calls = [];
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  };
  const addTimer = (fn, delay, interval = false) => {
    const id = nextTimer++;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  const globals = {
    setTimeout: (fn, ms) => addTimer(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => addTimer(fn, ms, true), clearInterval: (id) => timers.delete(id),
    localStorage: storage(), sessionStorage: storage(), navigator: {},
    document: { visibilityState: 'visible', addEventListener() {} },
    location: { pathname: '/', reload() { reloads++; } },
  };
  globals.window = { ...globals, addEventListener() {} };
  let state;
  const subscribers = new Set();
  function create(initializer) {
    const set = (patch) => {
      const previous = state;
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const cb of subscribers) cb(state, previous);
    };
    const store = () => state;
    store.getState = () => state;
    store.setState = set;
    store.subscribe = (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); };
    state = initializer(set, store.getState);
    return store;
  }
  class Engine {
    disconnected = false;
    constructor(me) { this.me = me; engines.push(this); }
    disconnect() { this.disconnected = true; calls.push('engine.disconnect'); }
    setMe(me) { this.me = me; }
  }
  let unsubscribe = async () => {};
  const api = {
    me() { const pending = deferred(); requests.push({ ...pending, token, at: now }); return pending.promise; },
    login() { throw new Error('Bootstrap must never repeat login'); },
    getUnread: async () => ({}), releaseHistory: async () => ({ releases: [] }),
  };
  const exports = moduleFromSource('./store.ts', {
    zustand: { create }, './api': { api, getToken: () => token, setToken: (value) => { token = value; } },
    './authBootstrap': bootstrapPolicy,
    './authDiagnostics': { authDiagnostics: { accept() {} } },
    './windowIdle': { isWindowIdle: () => false }, './engine': { Engine }, './emotes': { emoteMap: new Map() },
    './settings': { setSettings() {} }, './notify': { notifPermission: () => 'default' },
    './push': { ensurePushSubscribed() { calls.push('push'); }, unsubscribePush: () => unsubscribe() },
    './notifyws': {
      acknowledgeReleaseMerge() {}, connectNotifyWs() { calls.push('notify.connect'); },
      disconnectNotifyWs() { calls.push('notify.disconnect'); }, pauseNotifyWsReconnect() {}, resumeNotifyWsReconnect() {},
    },
    './idle': { startIdleWatch() { calls.push('idle'); } }, './sounds': { preloadSounds() { calls.push('sounds'); } },
    './native': { isTauri: false, stopNativeBroadcast: async () => {} },
    './diag': { flushPendingDiag: async () => {}, endAnyBroadcasterSession() {} },
  }, globals);
  return {
    ...exports, api, requests, engines, calls, timers,
    token: () => token, setToken: (value) => { token = value; }, reloads: () => reloads,
    setUnsubscribe: (fn) => { unsubscribe = fn; },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.delay; else timers.delete(id);
        timer.fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

test('bootstrap retry policy rejects explicit 401/403 even if a transport code is attached', () => {
  for (const error of [failure(), failure('NETWORK_ERROR'), failure('', 408), failure('', 429), failure('', 503)]) {
    assert.equal(bootstrapPolicy.isRecoverableAcceptedSessionBootstrapError(error), true);
  }
  for (const error of [failure('NETWORK_ERROR', 401), failure('REQUEST_TIMEOUT', 403), failure('', 400), failure('', 404), failure('SESSION_REVOKED', 500), new Error('unknown')]) {
    assert.equal(bootstrapPolicy.isRecoverableAcceptedSessionBootstrapError(error), false);
  }
});

test('accepted login survives /me timeout and the safe GET retry hydrates the same engine', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].reject(failure());
  await accepted;
  assert.equal(h.useStore.getState().view, 'home');
  assert.equal(h.useStore.getState().me.id, 'alice');
  assert.equal(h.token(), 'token-alice');
  assert.equal(h.getEngine(), h.engines[0]);
  assert.equal(h.engines[0].disconnected, false);
  await h.advance(999);
  assert.equal(h.requests.length, 1);
  await h.advance(1);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(snapshot());
  await settle();
  assert.equal(h.useStore.getState().servers[0].id, 'alice-server');
  assert.equal(h.getEngine(), h.engines[0]);
  await h.advance(100_000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.calls.filter((call) => call === 'notify.connect').length, 1);
});

test('bootstrap exhausts exactly three 1/3/10 second retries without logging the account out', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].reject(failure('NETWORK_ERROR'));
  await accepted;
  for (const delay of [1000, 3000, 10000]) {
    await h.advance(delay);
    h.requests.at(-1).reject(failure('', 503));
    await settle();
  }
  assert.deepEqual(h.requests.map((request) => request.at), [0, 1000, 4000, 14000]);
  await h.advance(100_000);
  assert.equal(h.requests.length, 4);
  assert.equal(h.timers.size, 0);
  assert.equal(h.useStore.getState().view, 'home');
  assert.equal(h.useStore.getState().me.id, 'alice');
  assert.equal(h.token(), 'token-alice');
  assert.equal(h.engines[0].disconnected, false);
});

for (const status of [401, 403]) {
  test(`initial /me HTTP ${status} fails closed and never schedules retries`, async () => {
    const h = harness();
    const accepted = h.useStore.getState().acceptSession(user());
    h.requests[0].reject(failure('INVALID_CREDENTIAL', status));
    await assert.rejects(accepted, (error) => error.status === status);
    assert.equal(h.useStore.getState().view, 'auth');
    assert.equal(h.useStore.getState().me, null);
    assert.equal(h.token(), null);
    assert.equal(h.getEngine(), null);
    assert.equal(h.engines[0].disconnected, true);
    await h.advance(100_000);
    assert.equal(h.requests.length, 1);
  });
}

test('terminal response during background retry clears the accepted account and stops retries', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].reject(failure());
  await accepted;
  await h.advance(1000);
  h.requests[1].reject(failure('INVALID_CREDENTIAL', 403));
  await settle();
  assert.equal(h.useStore.getState().me, null);
  assert.equal(h.useStore.getState().view, 'auth');
  assert.equal(h.token(), null);
  await h.advance(100_000);
  assert.equal(h.requests.length, 2);
});

for (const outcome of ['resolve', 'reject']) {
  test(`late initial /me ${outcome} after logout cannot resurrect or fail the old account`, async () => {
    const h = harness();
    const accepted = h.useStore.getState().acceptSession(user());
    await h.useStore.getState().logout();
    h.requests[0][outcome](outcome === 'resolve' ? snapshot() : failure('', 401));
    await accepted;
    assert.equal(h.useStore.getState().me, null);
    assert.equal(h.useStore.getState().view, 'auth');
    assert.equal(h.useStore.getState().sessionError, '');
    assert.equal(h.getEngine(), null);
    assert.equal(h.token(), null);
    assert.equal(h.calls.includes('notify.connect'), false);
    await h.advance(100_000);
    assert.equal(h.requests.length, 1);
  });
}

for (const sameAccount of [false, true]) {
  test(`late prior-session failure cannot disconnect ${sameAccount ? 'same-account relogin' : 'new account'}`, async () => {
    const h = harness();
    const old = h.useStore.getState().acceptSession(user());
    const nextId = sameAccount ? 'alice' : 'bob';
    h.setToken(`token-${nextId}`);
    const current = h.useStore.getState().acceptSession(user(nextId));
    h.requests[1].resolve(snapshot(nextId));
    await current;
    h.requests[0].reject(failure('', 401));
    await old;
    assert.equal(h.useStore.getState().view, 'home');
    assert.equal(h.useStore.getState().me.id, nextId);
    assert.equal(h.useStore.getState().sessionError, '');
    assert.equal(h.getEngine(), h.engines[1]);
    assert.equal(h.engines[1].disconnected, false);
    assert.equal(h.token(), `token-${nextId}`);
  });
}

test('logout cancels a scheduled retry before it can send another GET', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].reject(failure());
  await accepted;
  await h.useStore.getState().logout();
  await h.advance(100_000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.useStore.getState().me, null);
});

test('late in-flight background retry cannot overwrite a new account', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].reject(failure());
  await accepted;
  await h.advance(1000);
  h.setToken('token-bob');
  const current = h.useStore.getState().acceptSession(user('bob'));
  h.requests[2].resolve(snapshot('bob'));
  await current;
  h.requests[1].resolve(snapshot());
  await settle();
  assert.equal(h.useStore.getState().me.id, 'bob');
  assert.equal(h.useStore.getState().servers[0].id, 'bob-server');
  assert.equal(h.getEngine(), h.engines[1]);
  await h.advance(100_000);
  assert.equal(h.requests.length, 3);
});

test('token replacement alone fences a delayed accepted-session failure', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.setToken('replacement-token');
  h.requests[0].reject(failure('', 401));
  await accepted;
  assert.equal(h.token(), 'replacement-token');
  assert.equal(h.useStore.getState().sessionError, '');
  assert.equal(h.engines[0].disconnected, false);
});

test('the old asynchronous logout tail cannot clear a newly accepted account', async () => {
  const h = harness(), unsubscribe = deferred();
  h.setUnsubscribe(() => unsubscribe.promise);
  const initial = h.useStore.getState().acceptSession(user());
  h.requests[0].resolve(snapshot());
  await initial;
  const logout = h.useStore.getState().logout();
  h.setToken('token-bob');
  const accepted = h.useStore.getState().acceptSession(user('bob'));
  h.requests[1].resolve(snapshot('bob'));
  await accepted;
  unsubscribe.resolve();
  await logout;
  assert.equal(h.token(), 'token-bob');
  assert.equal(h.useStore.getState().me.id, 'bob');
  assert.equal(h.reloads(), 0);
});

test('a foreign-account /me payload cannot replace the authenticated identity', async () => {
  const h = harness();
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].resolve(snapshot('bob'));
  await assert.rejects(accepted, (error) => error.code === 'AUTH_CONTEXT_CHANGED');
  assert.equal(h.useStore.getState().me, null);
  assert.equal(h.token(), null);
});

test('late Home /me response cannot replace the new account server list', async () => {
  const h = harness();
  const initial = h.useStore.getState().acceptSession(user());
  h.requests[0].resolve(snapshot());
  await initial;
  const refresh = h.useStore.getState().refreshServers();
  h.setToken('token-bob');
  const next = h.useStore.getState().acceptSession(user('bob'));
  h.requests[2].resolve(snapshot('bob'));
  await next;
  h.requests[1].resolve(snapshot());
  await refresh;
  assert.equal(h.useStore.getState().servers[0].id, 'bob-server');
});

test('unread polling uses the rotated token and ignores a reply from the old token', async () => {
  const h = harness(), unread = [];
  h.api.getUnread = () => { const request = deferred(); unread.push({ ...request, token: h.token() }); return request.promise; };
  const accepted = h.useStore.getState().acceptSession(user());
  h.requests[0].resolve(snapshot());
  await accepted;
  await h.advance(30_000);
  assert.equal(unread[0].token, 'token-alice');
  h.setToken('rotated-alice-token');
  unread[0].resolve({ 'alice-server': 99 });
  await settle();
  assert.equal(h.useStore.getState().unread['alice-server'], 2);
  await h.advance(30_000);
  assert.equal(unread[1].token, 'rotated-alice-token');
  unread[1].resolve({ 'alice-server': 3 });
  await settle();
  assert.equal(h.useStore.getState().unread['alice-server'], 3);
});

test('new-account gate cancels the prior accepted-session retry without creating an engine', async () => {
  const h = harness();
  const initial = h.useStore.getState().acceptSession(user());
  h.requests[0].reject(failure());
  await initial;
  h.setToken('token-bob');
  await h.useStore.getState().acceptSession(user('bob'), { state: 'email_required' });
  await h.advance(100_000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.useStore.getState().me, null);
  assert.equal(h.useStore.getState().pendingUser.id, 'bob');
  assert.equal(h.getEngine(), null);
  assert.equal(h.token(), 'token-bob');
});

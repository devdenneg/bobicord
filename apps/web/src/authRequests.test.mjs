import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function compile(source) {
  return ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}

// Load the actual API -> diagnostics -> outbox -> API cycle, not mocked trace callbacks.
function harness() {
  const modules = new Map(), values = new Map(), timers = new Map(), requests = [];
  let timerId = 0;
  const storage = {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key), get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
  };
  const globals = {
    console, Error, Date, Promise, TextEncoder, TextDecoder, Uint8Array,
    AbortController, DOMException, Response, URLSearchParams, performance, crypto: webcrypto,
    localStorage: storage, navigator: { onLine: true, userAgent: 'test', platform: 'test' },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (url, options) => {
      const pending = deferred();
      options.signal?.addEventListener('abort', () => pending.reject(new DOMException('Aborted', 'AbortError')), { once: true });
      requests.push({ ...pending, url, options });
      return pending.promise;
    },
  };
  globals.window = { ...globals, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const exports = {};
    modules.set(filename, exports);
    const source = readFileSync(filename, 'utf8').replace('(import.meta as any).env?.VITE_API_BASE_URL', "''");
    runInNewContext(compile(source), { ...globals, exports,
      require: (id) => { assert.ok(id.startsWith('.'), id); return load(resolve(dirname(filename), id + '.ts')); },
    }, { filename });
    return exports;
  }
  const apiModule = load(fileURLToPath(new URL('./api.ts', import.meta.url)));
  const { authDiagnostics } = load(fileURLToPath(new URL('./authDiagnostics.ts', import.meta.url)));
  return { ...apiModule, authDiagnostics, requests, timers,
    reply(index, body, status = 200) { requests[index].resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })); },
  };
}

const user = { id: 'alice-id', username: 'alice' };
const bundle = { user, token: 'test-access-token', account: { state: 'ready' } };

test('failed login then manual success uploads only sanitized stages under the accepted account', async () => {
  const h = harness();
  const first = h.api.login('alice', 'test-password-never-in-diagnostics');
  h.reply(0, { error: { code: 'HTTP_ERROR', message: 'temporary outage' } }, 503);
  await assert.rejects(first, (error) => error.status === 503);
  assert.equal(h.requests.length, 1); // no automatic password replay or anonymous telemetry
  const second = h.api.login('alice', 'test-password-never-in-diagnostics');
  h.reply(1, bundle);
  const response = await second;
  h.setToken(response.token);
  h.authDiagnostics.accept(response.user, (report) => h.api.submitVoiceDiagnostic(report));
  await settle();
  assert.equal(h.requests.length, 3);
  const upload = h.requests[2];
  assert.equal(upload.url, '/api/diag/voice');
  assert.equal(upload.options.headers.Authorization, 'Bearer test-access-token');
  const report = JSON.parse(upload.options.body);
  assert.equal(report.incident, 'auth_recovered');
  assert.deepEqual(report.events.filter((event) => event.kind === 'auth_request_finished').map((event) => event.httpStatus), [503, 200]);
  assert.ok(report.events.every((event) => event.stage === 'auth_login'));
  for (const secret of ['alice', 'test-access-token', 'test-password-never-in-diagnostics', 'temporary outage', 'Authorization']) {
    assert.equal(upload.options.body.includes(secret), false);
  }
  h.reply(2, { ok: true }); await settle(); h.authDiagnostics.dispose();
});

test('a late login response cannot restore credentials after logout or supersede a later login', async () => {
  const h = harness();
  const old = h.api.login('alice', 'password-one');
  h.setToken(null); // logout invalidates a pending login even before any token was installed
  h.reply(0, bundle);
  await assert.rejects(old, (error) => error.code === 'REQUEST_ABORTED');
  assert.equal(h.getToken(), null);
  const earlier = h.api.login('alice', 'password-one');
  const later = h.api.login('bob', 'password-two');
  h.reply(1, bundle);
  await assert.rejects(earlier, (error) => error.code === 'REQUEST_ABORTED');
  h.reply(2, { ...bundle, user: { id: 'bob-id', username: 'bob' } });
  assert.equal((await later).user.id, 'bob-id');
  h.authDiagnostics.dispose();
});

test('login transport timeout is reported once and never retries the password automatically', async () => {
  const h = harness();
  const pending = h.api.login('alice', 'password');
  [...h.timers.values()].find((timer) => timer.delay === 15000).callback();
  await assert.rejects(pending, (error) => error.code === 'REQUEST_TIMEOUT');
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.getToken(), null);
  h.authDiagnostics.dispose();
});

test('a diagnostics exception cannot fail login, session checks or logout', async () => {
  const h = harness();
  h.authDiagnostics.startAttempt = () => { throw new Error('trace unavailable'); };
  h.authDiagnostics.request = () => { throw new Error('trace unavailable'); };
  const login = h.api.login('alice', 'password');
  h.reply(0, bundle);
  assert.equal((await login).user.id, user.id);
  const session = h.api.authSession();
  h.reply(1, bundle);
  assert.equal((await session).user.id, user.id);
  h.setToken(bundle.token);
  h.authDiagnostics.dispose = () => { throw new Error('trace unavailable'); };
  assert.doesNotThrow(() => h.setToken(null));
  assert.equal(h.getToken(), null);
});

test('bootstrap ignores old session success and failure after a newer login has started', async () => {
  for (const reject of [false, true]) {
    const response = deferred(); let generation = 0, accepted = 0, cleared = 0, writes = 0;
    const state = { me: null, acceptSession: async () => { accepted++; } };
    const imports = {
      react: { StrictMode() {} }, 'react/jsx-runtime': { jsx: () => null },
      'react-dom/client': { createRoot: () => ({ render() {} }) }, './styles.css': {}, './App': { App() {} },
      './store': { PASSWORD_RESET_STORAGE_KEY: 'reset', useStore: { getState: () => state, setState() { writes++; } } },
      './api': { getToken: () => 'saved-token', getAuthRequestGeneration: () => generation,
        setToken() { cleared++; }, api: { authSession: () => response.promise }, isApiError: () => true },
      './emotes': { loadGlobalEmotes() {} }, './native': { isTauri: false },
      './version': { watchForUpdates() {} }, './nativeUpdate': { waitForNativeStartup: async () => {}, startNativeUpdatePolling() {} },
      './theme': { applyStoredTheme() {} }, './windowIdle': { startWindowIdleWatch() {} }, './notificationDestination': {},
    };
    runInNewContext(compile(readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')), {
      exports: {}, require: (id) => { assert.ok(id in imports, id); return imports[id]; },
      window: { addEventListener() {} }, document: { getElementById() {} }, navigator: {},
      location: { hash: '', search: '' }, URLSearchParams,
      sessionStorage: { getItem: () => null, setItem() {} },
    });
    await settle();
    generation++;
    if (reject) response.reject({ status: 401 }); else response.resolve({ user, account: { state: 'ready' } });
    await settle();
    assert.equal(accepted, 0); assert.equal(cleared, 0); assert.equal(writes, 0);
  }
});

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function compile(relativePath) {
  return ts.transpileModule(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const controllerJs = compile('./nativeUpdateController.ts');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function harness(overrides = {}) {
  let nextId = 1, now = 0;
  const timers = new Map(), observed = [], announcements = [];
  const exports = {};
  runInNewContext(controllerJs, { exports,
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const dependencies = { enabled: true, check: async () => null, relaunch: async () => {},
    onUpdate: (update) => observed.push(update), announce: (version) => announcements.push(version), ...overrides };
  const controller = new exports.NativeUpdateController(dependencies);
  return { controller, dependencies, observed, announcements, timers,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await settle();
    },
  };
}
function update(version = '2.0.0', download = async () => {}) {
  return { version, closed: 0, downloads: 0,
    async close() { this.closed++; },
    async downloadAndInstall(callback, options) { this.downloads++; this.progress = callback; return download(callback, options); },
  };
}

test('web bypasses updater without checking or delaying authentication', async () => {
  let calls = 0;
  const h = harness({ enabled: false, check: async () => { calls++; return null; } });
  await h.controller.waitForStartup();
  await h.controller.check();
  await h.controller.apply();
  assert.equal(h.controller.getSnapshot().authAllowed, true);
  assert.equal(calls, 0);
  assert.equal(h.timers.size, 0);
});

test('desktop authenticates only after a successful no-update result', async () => {
  const result = deferred();
  let checks = 0, authenticated = false;
  const h = harness({ check: async (timeout) => { checks++; assert.equal(timeout, 10000); return result.promise; } });
  h.controller.waitForStartup().then(() => { authenticated = true; });
  h.controller.waitForStartup();
  await settle();
  assert.equal(checks, 1);
  assert.equal(authenticated, false);
  result.resolve(null);
  await settle();
  assert.equal(authenticated, true);
  assert.equal(h.controller.getSnapshot().phase, 'ready');
});

test('a known update blocks startup through download, install and relaunch', async () => {
  const download = deferred(), relaunch = deferred(), fresh = update('2.0.0', () => download.promise);
  const h = harness({ check: async () => fresh, relaunch: () => relaunch.promise });
  let authenticated = false;
  h.controller.waitForStartup().then(() => { authenticated = true; });
  await settle();
  assert.equal(h.controller.getSnapshot().phase, 'available');
  assert.equal(h.controller.continueWithoutCheck(), false);
  const install = h.controller.apply();
  assert.equal(h.controller.apply(), install);
  await settle();
  assert.equal(fresh.downloads, 1);
  assert.equal(fresh.closed, 0);
  fresh.progress({ event: 'Started', data: { contentLength: 1000 } });
  fresh.progress({ event: 'Progress', data: { chunkLength: 400 } });
  assert.equal(h.controller.getSnapshot().downloaded, 400);
  fresh.progress({ event: 'Finished' });
  assert.equal(h.controller.getSnapshot().phase, 'installing');
  download.resolve();
  await settle();
  assert.equal(h.controller.getSnapshot().phase, 'restarting');
  assert.equal(authenticated, false);
  relaunch.resolve();
  await install;
  assert.equal(h.controller.getSnapshot().authAllowed, false);
});

test('unknown offline availability allows explicit continue but never silently opens auth', async () => {
  const h = harness({ check: async () => { throw new Error('offline'); } });
  let authenticated = false;
  h.controller.waitForStartup().then(() => { authenticated = true; });
  await settle();
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.equal(authenticated, false);
  assert.equal(h.controller.continueWithoutCheck(), true);
  await settle();
  assert.equal(authenticated, true);
});

test('a stuck check has an 11s UI deadline; retries share the same underlying request', async () => {
  const result = deferred();
  let checks = 0;
  const h = harness({ check: async () => { checks++; return result.promise; } });
  h.controller.waitForStartup();
  await settle();
  await h.advance(11000);
  assert.equal(h.controller.getSnapshot().phase, 'error');
  const retry = h.controller.retryCheck();
  await settle();
  assert.equal(checks, 1);
  result.resolve(update());
  await retry;
  assert.equal(h.controller.getSnapshot().phase, 'available');
  assert.equal(h.controller.continueWithoutCheck(), false);
  assert.equal(h.timers.size, 0);
});

test('a rejected check can be retried after the network recovers', async () => {
  let checks = 0;
  const h = harness({ check: async () => { if (++checks === 1) throw new Error('offline'); return update(); } });
  h.controller.waitForStartup();
  await settle();
  await h.controller.retryCheck();
  assert.equal(checks, 2);
  assert.equal(h.controller.getSnapshot().phase, 'available');
  assert.equal(h.controller.getSnapshot().authAllowed, false);
});

test('download failure keeps a known release blocking and retries safely', async () => {
  let attempts = 0;
  const target = update('2.0.0', async () => { if (++attempts === 1) throw new Error('bad signature'); });
  const h = harness({ check: async () => target });
  h.controller.waitForStartup();
  await settle();
  await assert.rejects(h.controller.apply(), /bad signature/);
  assert.equal(h.controller.getSnapshot().phase, 'error');
  assert.equal(h.controller.continueWithoutCheck(), false);
  await h.controller.apply();
  assert.equal(attempts, 2);
  assert.equal(h.controller.getSnapshot().installed, true);
  assert.equal(h.controller.getSnapshot().authAllowed, false);
});

test('relaunch failure retries the restart without downloading or checking again', async () => {
  let relaunches = 0, checks = 0;
  const target = update();
  const h = harness({ check: async () => { checks++; return target; }, relaunch: async () => { if (++relaunches === 1) throw new Error('restart'); } });
  h.controller.waitForStartup();
  await settle();
  await assert.rejects(h.controller.apply(), /restart/);
  assert.equal(h.controller.getSnapshot().installed, true);
  assert.equal(h.controller.continueWithoutCheck(), false);
  await h.controller.apply();
  assert.equal(relaunches, 2);
  assert.equal(checks, 2);
  assert.equal(target.downloads, 1);
});

test('install refresh replaces the signed handle even when version is unchanged', async () => {
  const old = update(), fresh = update();
  let checks = 0;
  const h = harness({ check: async () => ++checks === 1 ? old : fresh });
  h.controller.waitForStartup();
  await settle();
  await h.controller.apply();
  assert.equal(old.closed, 1);
  assert.equal(old.downloads, 0);
  assert.equal(fresh.downloads, 1);
  assert.equal(fresh.closed, 0);
});

test('background checks do not run during a download or close its active resource', async () => {
  const downloaded = deferred(), target = update('2.0.0', () => downloaded.promise);
  let checks = 0;
  const h = harness({ check: async () => { checks++; return target; } });
  h.controller.waitForStartup();
  await settle();
  const install = h.controller.apply();
  await settle();
  await h.controller.check();
  await h.controller.retryCheck();
  assert.equal(checks, 2);
  assert.equal(target.closed, 0);
  downloaded.resolve();
  await install;
});

test('a late timed-out refresh cannot replace or close an update being installed', async () => {
  const refresh = deferred(), downloaded = deferred();
  const old = update('2.0.0', () => downloaded.promise), late = update('3.0.0');
  let checks = 0;
  const h = harness({ check: async () => ++checks === 1 ? old : refresh.promise });
  h.controller.waitForStartup();
  await settle();
  const install = h.controller.apply();
  await settle();
  await h.advance(11000);
  assert.equal(h.controller.getSnapshot().phase, 'downloading');
  refresh.resolve(late);
  await settle();
  assert.equal(late.closed, 1);
  assert.equal(old.closed, 0);
  assert.equal(h.controller.getSnapshot().version, '2.0.0');
  downloaded.resolve();
  await install;
});

test('main boot does not request or accept a saved session before the update gate opens', async () => {
  const result = deferred(), h = harness({ check: async () => result.promise });
  let authRequests = 0, accepted = 0, polls = 0;
  const state = { me: null, async acceptSession() { accepted++; } };
  const imports = {
    react: { StrictMode() {} }, 'react/jsx-runtime': { jsx: () => null },
    'react-dom/client': { createRoot: () => ({ render() {} }) }, './styles.css': {}, './App': { App() {} },
    './store': { PASSWORD_RESET_STORAGE_KEY: 'reset', useStore: { getState: () => state, setState() {} } },
    './api': { getToken: () => 'saved-token', api: { authSession: async () => { authRequests++; return { user: {}, account: {} }; } }, isApiError: () => false },
    './emotes': { loadGlobalEmotes() {} }, './native': { isTauri: false },
    './version': { watchForUpdates() {} }, './nativeUpdate': { waitForNativeStartup: () => h.controller.waitForStartup(), startNativeUpdatePolling: () => { polls++; } },
    './theme': { applyStoredTheme() {} }, './windowIdle': { startWindowIdleWatch() {} },
    './notificationDestination': {},
  };
  runInNewContext(compile('./main.tsx'), {
    exports: {}, require: (id) => { assert.ok(id in imports, id); return imports[id]; },
    window: { addEventListener() {} }, document: { getElementById() {} }, navigator: {},
    location: { hash: '', search: '' }, URLSearchParams,
    sessionStorage: { getItem: () => null, setItem() {} },
  });
  await settle();
  assert.equal(authRequests, 0);
  assert.equal(accepted, 0);
  assert.equal(polls, 0);
  result.resolve(null);
  await settle();
  assert.equal(authRequests, 1);
  assert.equal(accepted, 1);
  assert.equal(polls, 1);
});

test('the pre-auth gate exposes bypass only for unknown availability and renders download progress', () => {
  const exports = {};
  const imports = { 'react/jsx-runtime': jsxRuntime, '../nativeUpdate': { nativeUpdateController: {} }, './LogoLoader': { LogoLoader: () => null }, './NativeUpdateGate.css': {} };
  runInNewContext(compile('./components/NativeUpdateGate.tsx'), { exports, require: (id) => imports[id] });
  const render = (patch) => renderToStaticMarkup(createElement(exports.NativeUpdateGate, { state: {
    phase: 'available', authAllowed: false, version: '2.0.0', downloaded: 0, total: null, error: '', installed: false, ...patch,
  } }));
  const available = render({});
  assert.match(available, /Скачать и обновить/);
  assert.doesNotMatch(available, /Продолжить ко входу/);
  assert.match(render({ phase: 'error', version: null, error: 'offline' }), /Продолжить ко входу/);
  assert.doesNotMatch(render({ phase: 'error', error: 'download' }), /Продолжить ко входу/);
  assert.match(render({ phase: 'downloading', downloaded: 500, total: 1000 }), /value="50"/);
  assert.match(render({ phase: 'error', installed: true }), /Перезапустить/);
});

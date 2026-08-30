import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const origin = 'https://relay.example';
const workerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

class WorkerRequest extends Request {
  constructor(input, init) {
    super(typeof input === 'string' ? new URL(input, origin) : input, init);
  }
}

function keyOf(value) {
  const raw = typeof value === 'string' ? value : value.url;
  const url = new URL(raw, origin);
  return url.pathname + url.search;
}

function createCacheStorage() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      let entries = stores.get(name);
      if (!entries) stores.set(name, entries = new Map());
      return {
        async match(request) {
          const response = entries.get(keyOf(request));
          return response ? response.clone() : undefined;
        },
        async put(request, response) {
          entries.set(keyOf(request), response.clone());
        },
        async delete(request) { return entries.delete(keyOf(request)); },
        async keys() { return [...entries.keys()].map((url) => new WorkerRequest(url)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}

function createWorker(precache = {
  version: 'test-build',
  // /api must be rejected even if a broken build manifest accidentally lists it.
  urls: ['/index.html', '/assets/main-test.js', '/api/me'],
}, options = {}) {
  const listeners = new Map();
  const caches = options.caches || createCacheStorage();
  let fetchImpl = async (request) => {
    const pathname = new URL(request.url || request, origin).pathname;
    return new Response(pathname === '/index.html' ? '<main-shell>' : `asset:${pathname}`, {
      status: 200,
      headers: { 'content-type': pathname.endsWith('.html') ? 'text/html' : 'text/javascript' },
    });
  };
  let skipped = 0;
  let claimed = 0;
  const self = {
    location: { origin },
    clients: {
      async claim() { claimed += 1; },
      async matchAll() { return []; },
    },
    registration: { async showNotification() {} },
    async skipWaiting() { skipped += 1; },
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  const context = vm.createContext({
    self,
    caches,
    URL,
    URLSearchParams,
    Request: WorkerRequest,
    Response,
    Headers,
    Set,
    Promise,
    Error,
    AbortController,
    console,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    importScripts() { self.__RELAY_PRECACHE = precache; },
    fetch(request, init) { return fetchImpl(request, init); },
  });
  vm.runInContext(workerSource, context, { filename: 'sw.js' });

  async function dispatchExtendable(type, extra = {}) {
    let pending;
    listeners.get(type)({ ...extra, waitUntil(value) { pending = Promise.resolve(value); } });
    if (pending) await pending;
  }

  async function dispatchFetch(request) {
    let responsePromise;
    listeners.get('fetch')({ request, respondWith(value) { responsePromise = Promise.resolve(value); } });
    return responsePromise ? await responsePromise : undefined;
  }

  return {
    caches,
    dispatchExtendable,
    dispatchFetch,
    setFetch(value) { fetchImpl = value; },
    counts() { return { skipped, claimed }; },
  };
}

const worker = createWorker();
await worker.dispatchExtendable('install');
assert.equal(worker.counts().skipped, 0,
  'an update must not take over a live old-build page that can still request old hashed chunks');
assert.doesNotMatch(workerSource, /self\.skipWaiting\s*\(/,
  'the previous worker/cache must stay attached until its clients close naturally');
const shellCacheName = (await worker.caches.keys()).find((name) => name.startsWith('relay-shell-v1-'));
assert.ok(shellCacheName, 'the build gets its own versioned shell cache');
const shellCache = await worker.caches.open(shellCacheName);
assert.equal(await (await shellCache.match('/index.html')).text(), '<main-shell>');
assert.equal(await shellCache.match('/api/me'), undefined, 'API/auth responses are never precached');

worker.setFetch(async () => new Response('<next-shell>', {
  status: 200, headers: { 'content-type': 'text/html' },
}));
const onlineNavigation = await worker.dispatchFetch({
  url: origin + '/channels/demo', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(await onlineNavigation.text(), '<next-shell>');
assert.equal(await (await shellCache.match('/index.html')).text(), '<main-shell>',
  'new HTML cannot be mixed into the previous build cache before its assets install');

worker.setFetch(async () => new Response('<proxy-unavailable>', {
  status: 503, headers: { 'content-type': 'text/html; charset=utf-8' },
}));
const failedDeployNavigation = await worker.dispatchFetch({
  url: origin + '/channels/demo', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(await failedDeployNavigation.text(), '<main-shell>',
  'a reachable proxy 5xx falls back to the atomically installed shell');
assert.equal(failedDeployNavigation.status, 200);

let runtimeFetches = 0;
worker.setFetch(async () => { runtimeFetches += 1; throw new TypeError('offline'); });
const cachedAsset = await worker.dispatchFetch({
  url: origin + '/assets/main-test.js', method: 'GET', mode: 'no-cors', headers: new Headers(),
});
assert.equal(await cachedAsset.text(), 'asset:/assets/main-test.js');
assert.equal(runtimeFetches, 0, 'an immutable current-build asset is cache-first');

await shellCache.delete('/assets/main-test.js');
worker.setFetch(async () => new Response('<html>SPA fallback</html>', {
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
}));
const corruptCacheMiss = await worker.dispatchFetch({
  url: origin + '/assets/main-test.js', method: 'GET', mode: 'no-cors', headers: new Headers(),
});
assert.equal(corruptCacheMiss.type, 'error');
assert.equal(await shellCache.match('/assets/main-test.js'), undefined,
  'runtime cache miss must never persist a 200 HTML SPA fallback under a JavaScript key');
worker.setFetch(async () => new Response('asset:/assets/main-test.js', {
  status: 200, headers: { 'content-type': 'text/javascript' },
}));
const repairedCacheMiss = await worker.dispatchFetch({
  url: origin + '/assets/main-test.js', method: 'GET', mode: 'no-cors', headers: new Headers(),
});
assert.equal(await repairedCacheMiss.text(), 'asset:/assets/main-test.js');
assert.equal(await (await shellCache.match('/assets/main-test.js')).text(), 'asset:/assets/main-test.js');

worker.setFetch(async () => { throw new TypeError('offline'); });
const offlineNavigation = await worker.dispatchFetch({
  url: origin + '/channels/demo', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(await offlineNavigation.text(), '<main-shell>', 'a cold offline deep-link opens the installed app shell');

const apiResponse = await worker.dispatchFetch({
  url: origin + '/api/me', method: 'GET', mode: 'cors', headers: new Headers(),
});
assert.equal(apiResponse, undefined, 'API stays on the browser network path and cannot be served stale');

await worker.caches.open('old-relay-shell');
await worker.caches.open('relay-notification-state-v1');
await worker.dispatchExtendable('activate');
assert.equal(worker.counts().claimed, 1);
assert.deepEqual((await worker.caches.keys()).sort(), [shellCacheName, 'relay-notification-state-v1'].sort(),
  'activation removes stale releases but preserves notification state');

const brokenWorker = createWorker(null);
await assert.rejects(() => brokenWorker.dispatchExtendable('install'), /precache manifest unavailable/,
  'a partially deployed release cannot replace the last working service worker');
assert.equal(brokenWorker.counts().skipped, 0);

const stuckInstallCacheWorker = createWorker(undefined, {
  caches: { open: () => new Promise(() => {}), keys: async () => [], delete: async () => false },
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
});
await assert.rejects(() => stuckInstallCacheWorker.dispatchExtendable('install'), /shell cache open timed out/,
  'a wedged iOS CacheStorage open rejects the staged install and leaves the active worker intact');

const stuckInstallFetchWorker = createWorker(undefined, {
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
});
stuckInstallFetchWorker.setFetch(() => new Promise(() => {}));
await assert.rejects(() => stuckInstallFetchWorker.dispatchExtendable('install'), /shell asset fetch .* timed out/,
  'a wedged shell fetch cannot leave an update forever in installing state');

const wrongMimeWorker = createWorker({ version: 'wrong-mime', urls: ['/index.html', '/assets/missing.js'] });
wrongMimeWorker.setFetch(async (request) => {
  const pathname = new URL(request.url || request, origin).pathname;
  return new Response(pathname === '/index.html' ? '<main-shell>' : '<spa-fallback>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});
await assert.rejects(() => wrongMimeWorker.dispatchExtendable('install'), /shell asset type mismatch/,
  'a 200 SPA fallback cannot be cached under a missing JavaScript hash');
assert.equal((await wrongMimeWorker.caches.keys()).some((name) => name.includes('wrong-mime')), false,
  'a corrupt staged cache is removed without touching the active release');
assert.match(workerSource, /addEventListener\(\"online\",\(\)=>location\.reload\(\)\)/,
  'the emergency offline document reloads itself when connectivity returns');

let neverSettlingCacheOpens = 0;
const neverSettlingCaches = {
  open: () => { neverSettlingCacheOpens += 1; return new Promise(() => {}); },
  keys: async () => [],
  delete: async () => false,
};
const cacheBlockedWorker = createWorker(undefined, {
  caches: neverSettlingCaches,
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
});
cacheBlockedWorker.setFetch(async (request) => {
  const pathname = new URL(request.url || request, origin).pathname;
  return new Response(pathname.endsWith('.js') ? 'fresh-module' : '<upstream-unavailable>', {
    status: pathname.endsWith('.js') ? 200 : 503,
    headers: { 'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html' },
  });
});
const cacheBlockedAsset = await cacheBlockedWorker.dispatchFetch({
  url: origin + '/assets/main-test.js', method: 'GET', mode: 'no-cors', headers: new Headers(),
});
assert.equal(await cacheBlockedAsset.text(), 'fresh-module',
  'a stuck shell cache read falls through to a validated healthy module response');
const cacheBlockedNavigation = await cacheBlockedWorker.dispatchFetch({
  url: origin + '/channels/demo', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(cacheBlockedNavigation.status, 503,
  'a stuck cache cannot hold navigation forever when only the upstream error response is available');
assert.equal(neverSettlingCacheOpens, 1,
  'asset and navigation fallbacks share one genuinely stuck runtime shell-cache open');

const stuckMatchBase = createCacheStorage();
let stuckAssetMatches = 0;
const stuckMatchCaches = {
  stores: stuckMatchBase.stores,
  async open(name) {
    const cache = await stuckMatchBase.open(name);
    return {
      async match(request) {
        if (keyOf(request) === '/assets/main-test.js') {
          stuckAssetMatches += 1;
          return new Promise(() => {});
        }
        return cache.match(request);
      },
      put: (request, response) => cache.put(request, response),
      delete: (request) => cache.delete(request),
      keys: () => cache.keys(),
    };
  },
  keys: () => stuckMatchBase.keys(),
  delete: (name) => stuckMatchBase.delete(name),
};
const stuckMatchWorker = createWorker({ version: 'dev', urls: ['/assets/main-test.js'] }, {
  caches: stuckMatchCaches,
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
});
stuckMatchWorker.setFetch(async () => new Response('fresh-module', {
  status: 200, headers: { 'content-type': 'text/javascript' },
}));
for (let index = 0; index < 5; index++) {
  const response = await stuckMatchWorker.dispatchFetch({
    url: origin + '/assets/main-test.js', method: 'GET', mode: 'no-cors', headers: new Headers(),
  });
  assert.equal(await response.text(), 'fresh-module');
}
assert.equal(stuckAssetMatches, 1,
  'repeated asset requests share a single permanently stuck per-path cache match');

let stuckRuntimeAssetFetches = 0;
const stuckRuntimeAssetWorker = createWorker({ version: 'dev', urls: ['/assets/main-test.js'] }, {
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
});
stuckRuntimeAssetWorker.setFetch(() => {
  stuckRuntimeAssetFetches += 1;
  return new Promise(() => {});
});
for (let index = 0; index < 5; index++) {
  const response = await stuckRuntimeAssetWorker.dispatchFetch({
    url: origin + '/assets/main-test.js', method: 'GET', mode: 'no-cors', headers: new Headers(),
  });
  assert.equal(response.type, 'error');
}
assert.equal(stuckRuntimeAssetFetches, 1,
  'a fetch implementation that ignores abort stays one shared actual attempt per asset path');

let stalledNavigationSignal;
let stalledNavigationFetches = 0;
const stalledNavigationWorker = createWorker({ version: 'dev', urls: [] }, {
  setTimeout(callback) { Promise.resolve().then(callback); return 1; },
  clearTimeout() {},
});
stalledNavigationWorker.setFetch((_request, init) => {
  stalledNavigationFetches += 1;
  stalledNavigationSignal = init?.signal;
  return new Promise(() => {});
});
const stalledNavigation = await stalledNavigationWorker.dispatchFetch({
  url: origin + '/captive-portal', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(stalledNavigation.status, 503);
assert.equal(stalledNavigationSignal?.aborted, true,
  'a navigation deadline aborts its losing captive-portal fetch instead of accumulating radio work');
const repeatedStalledNavigation = await stalledNavigationWorker.dispatchFetch({
  url: origin + '/captive-portal', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(repeatedStalledNavigation.status, 503);
const distinctStalledNavigation = await stalledNavigationWorker.dispatchFetch({
  url: origin + '/?server=another&message=42', method: 'GET', mode: 'navigate', headers: new Headers(),
});
assert.equal(distinctStalledNavigation.status, 503);
assert.equal(stalledNavigationFetches, 1,
  'all SPA deep links reuse the timed-out actual fetch until the browser really settles it');

const stuckActivationCaches = createCacheStorage();
stuckActivationCaches.keys = () => new Promise(() => {});
const stuckActivationWorker = createWorker(undefined, {
  caches: stuckActivationCaches,
  setTimeout(callback) { return setTimeout(callback, 0); },
  clearTimeout,
});
await stuckActivationWorker.dispatchExtendable('activate');
assert.equal(stuckActivationWorker.counts().claimed, 1,
  'a wedged stale-cache listing is best-effort and cannot trap the new worker in activating state');

const viteConfigSource = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const denoiseSource = readFileSync(new URL('./denoise.ts', import.meta.url), 'utf8');
const vadSource = readFileSync(new URL('./vad.ts', import.meta.url), 'utf8');
assert.match(viteConfigSource, /createHash\('sha256'\)[\s\S]*asset\.source[\s\S]*fileName/,
  'lazy audio modules receive a deterministic content-addressed filename');
for (const legacyFileName of ['rnnoise-worklet.js', 'rnnoise.wasm', 'rnnoise_simd.wasm']) {
  assert.match(viteConfigSource, new RegExp(`legacyFileName: ['"]${legacyFileName.replace('.', '\\\.')}['"]`),
    `the first hashed rollout keeps ${legacyFileName} for already-open pre-migration tabs`);
}
assert.match(viteConfigSource, /emitFile\(\{ type: 'asset', fileName: asset\.legacyFileName, source: asset\.source \}\)/,
  'legacy RNNoise aliases are emitted from the exact bytes owned by the hashed build');
assert.match(denoiseSource, /__RNNOISE_WORKLET_URL__/);
assert.match(vadSource, /__VAD_WORKLET_URL__/);
assert.doesNotMatch(denoiseSource, /['"]\/rnnoise-worklet\.js['"]/,
  'a new host bundle cannot request the old worker\'s stable RNNoise cache key');
assert.doesNotMatch(vadSource, /['"]\/vad-worklet\.js['"]/,
  'a new host bundle cannot request the old worker\'s stable VAD cache key');

console.log('pwa offline tests: OK');

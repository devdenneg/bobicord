import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'volumePreferences.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ServerVolumePreferences, sanitizeServerVolumes } = await import('data:text/javascript,' + encodeURIComponent(js));

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const volumes = (users = {}, streams = {}) => ({ users, streams });

assert.deepEqual(sanitizeServerVolumes({
  users: { quiet: -1, loud: 5, ok: 0.2, bad: 'nope' },
  streams: { quiet: -1, loud: 5, ok: 0.4 },
}), volumes({ quiet: 0, loud: 2, ok: 0.2 }, { quiet: 0, loud: 1, ok: 0.4 }));

// A late network response must not overwrite the slider movement that happened while GET waited.
{
  const storage = new MemoryStorage();
  const writes = [];
  const prefs = new ServerVolumePreferences('account-a', async (serverId, mutations) => writes.push({ serverId, mutations }), {
    storage, debounceMs: 0,
  });
  const hydration = prefs.beginHydration('server-1');
  prefs.update('server-1', volumes({ alice: 0.15 }), { section: 'users', key: 'alice' });
  const effective = prefs.acceptRemote('server-1', volumes({ alice: 1, bob: 0.5 }), hydration.revision, hydration.token);
  assert.equal(effective.users.alice, 0.15, 'the current local slider remains authoritative');
  assert.equal(effective.users.bob, 0.5, 'unrelated remote fields are still merged');
  await prefs.flush('server-1');
  assert.deepEqual(writes.at(-1).mutations, [{ section: 'users', key: 'alice', value: 0.15 }],
    'only the repaired field is persisted back to the server');
  prefs.dispose();
}

// Dirty state survives an offline reload and wins over a stale/default server response.
{
  const storage = new MemoryStorage();
  const offline = new ServerVolumePreferences('account-a', async () => { throw new Error('offline'); }, {
    storage, debounceMs: 0,
  });
  offline.update('server-2', volumes({ alice: 0.2 }), { section: 'users', key: 'alice' });
  await offline.flush('server-2');
  offline.dispose();

  const recoveredWrites = [];
  const recovered = new ServerVolumePreferences('account-a', async (_serverId, mutations) => recoveredWrites.push(mutations), {
    storage, debounceMs: 0,
  });
  const hydration = recovered.beginHydration('server-2');
  assert.equal(hydration.data.users.alice, 0.2);
  const effective = recovered.acceptRemote('server-2', volumes({ alice: 1 }), hydration.revision, hydration.token);
  assert.equal(effective.users.alice, 0.2, 'offline intent is not mistaken for a confirmed cache');
  await recovered.flush('server-2');
  assert.deepEqual(recoveredWrites.at(-1), [{ section: 'users', key: 'alice', value: 0.2 }]);
  recovered.dispose();
}

// Different servers own different debounce timers; moving B cannot cancel unsaved A.
{
  const tasks = new Map();
  let nextTimer = 0;
  const writes = [];
  const prefs = new ServerVolumePreferences('account-a', async (serverId, mutations) => writes.push({ serverId, mutations }), {
    storage: new MemoryStorage(),
    schedule(callback) { const id = ++nextTimer; tasks.set(id, callback); return id; },
    cancel(id) { tasks.delete(id); },
  });
  prefs.update('server-a', volumes({ alice: 0.2 }), { section: 'users', key: 'alice' });
  prefs.update('server-b', volumes({ bob: 0.3 }), { section: 'users', key: 'bob' });
  assert.equal(tasks.size, 2, 'each server retains its own pending save');
  [...tasks.values()].forEach((task) => task());
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(new Set(writes.map(({ serverId }) => serverId)), new Set(['server-a', 'server-b']));
  prefs.dispose();
}

// A newer value waits for the first PUT and is then written last; responses cannot reorder it.
{
  let releaseFirst;
  const calls = [];
  const prefs = new ServerVolumePreferences('account-a', (_serverId, mutations) => {
    calls.push(mutations.find(({ section, key }) => section === 'users' && key === 'alice')?.value);
    if (calls.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    return Promise.resolve();
  }, { storage: new MemoryStorage(), debounceMs: 60_000 });
  prefs.update('server-1', volumes({ alice: 0.2 }), { section: 'users', key: 'alice' });
  const firstFlush = prefs.flush('server-1');
  await Promise.resolve(); await Promise.resolve();
  prefs.update('server-1', volumes({ alice: 0.5 }), { section: 'users', key: 'alice' });
  const latestFlush = prefs.flush('server-1');
  releaseFirst();
  await Promise.all([firstFlush, latestFlush]);
  assert.deepEqual(calls, [0.2, 0.5], 'the newest snapshot is the final server write');
  prefs.dispose();
}

// Hydration must finish before a persisted dirty field is retried. Otherwise a stale GET that read
// before PATCH could arrive after it and incorrectly mark 100% as the new clean value.
{
  const storage = new MemoryStorage();
  const seed = new ServerVolumePreferences('account-a', async () => { throw new Error('offline'); }, { storage });
  seed.update('server-race', volumes({ alice: 0.2, bob: 0.5 }), { section: 'users', key: 'alice' });
  await seed.flush('server-race');
  seed.dispose();

  const writes = [];
  const recovered = new ServerVolumePreferences('account-a', async (_serverId, mutations) => writes.push(mutations), {
    storage, debounceMs: 0,
  });
  const hydration = recovered.beginHydration('server-race');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(writes.length, 0, 'dirty PATCH waits until the stale GET has been merged');
  const effective = recovered.acceptRemote(
    'server-race',
    volumes({ alice: 1, bob: 0.8 }),
    hydration.revision,
    hydration.token,
  );
  assert.deepEqual(effective, volumes({ alice: 0.2, bob: 0.8 }));
  await recovered.flush('server-race');
  assert.deepEqual(writes.at(-1), [{ section: 'users', key: 'alice', value: 0.2 }],
    'the unrelated clean Bob value is never included in Alice PATCH');
  recovered.dispose();
}

// Cache ownership includes the account. Ambiguous legacy keys are deliberately never inherited.
{
  const storage = new MemoryStorage();
  storage.setItem('srvset:shared-server', JSON.stringify(volumes({ alice: 0.1 })));
  const a = new ServerVolumePreferences('account-a', async () => {}, { storage });
  a.update('shared-server', volumes({ alice: 0.25 }), { section: 'users', key: 'alice' });
  const b = new ServerVolumePreferences('account-b', async () => {}, { storage });
  assert.equal(b.beginHydration('shared-server').data, null, 'another account cannot hear inherited preferences');
  assert.notEqual(a.cacheKey('shared-server'), b.cacheKey('shared-server'));
  a.dispose(); b.dispose();
}

// Safari/WebView may throw while the localStorage global itself is resolved.
{
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('blocked', 'SecurityError'); },
  });
  const prefs = new ServerVolumePreferences('blocked-storage', async () => {});
  assert.equal(prefs.beginHydration('server').data, null);
  prefs.finishHydration('server', 1);
  prefs.dispose();
  delete globalThis.localStorage;
}

console.log('server volume preferences: ok');

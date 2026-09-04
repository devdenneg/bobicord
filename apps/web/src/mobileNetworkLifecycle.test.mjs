import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(join(here, relative), 'utf8');

function parsed(relative) {
  const source = read(relative);
  return { source, file: ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}

function functionText(relative, name) {
  const { file } = parsed(relative);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${relative}: ${name} must exist`);
  return declaration.getText(file);
}

function classMethodText(relative, className, methodName) {
  const { file } = parsed(relative);
  const declaration = file.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(declaration && ts.isClassDeclaration(declaration), `${relative}: ${className} must exist`);
  const method = declaration.members.find((node) => node.name?.getText(file) === methodName);
  assert.ok(method, `${relative}: ${className}.${methodName} must exist`);
  return method.getText(file);
}

const notify = read('notifyws.ts');
const prepareNotify = functionText('notifyws.ts', 'prepareNotifyConnection');
const notifyConnect = functionText('notifyws.ts', 'connectNotifyWsNow');
const dropConnecting = functionText('notifyws.ts', 'dropStuckConnectingSocket');

assert.match(notify, /const CONNECT_TIMEOUT_MS = 15000/,
  'notify CONNECTING deadline must stay bounded at 15 seconds');
assert.match(dropConnecting, /ws !== current \|\| current\.readyState !== WebSocket\.CONNECTING/,
  'notify deadline must retire only its exact still-CONNECTING socket');
assert.match(notifyConnect, /window\.setTimeout\([\s\S]*dropStuckConnectingSocket\(current\)[\s\S]*CONNECT_TIMEOUT_MS/,
  'notify handshake must arm the exact-socket deadline');
assert.match(notify, /addEventListener\('pageshow', \(\) => kickReconnect\(\)\)/,
  'notify websocket must get an immediate PWA pageshow recovery kick');

const needsRefreshAt = prepareNotify.indexOf('accessTokenNeedsRefresh()');
const refreshAt = prepareNotify.indexOf('await refreshAccessSession()');
const handshakeAt = prepareNotify.lastIndexOf('connectNotifyWsNow()');
assert.ok(needsRefreshAt >= 0 && refreshAt > needsRefreshAt && handshakeAt > refreshAt,
  'persistent access refresh must complete before websocket handshake construction');
assert.match(prepareNotify, /isTerminalSessionError\(error\)[\s\S]*return/,
  'terminal refresh failure must stop reconnecting with the rejected token');
assert.match(prepareNotify, /authRefreshRetryAt = Date\.now\(\) \+ 30_000[\s\S]*scheduleDisconnectedChatSnapshots\(true\)[\s\S]*scheduleReconnect\(\)/,
  'network/5xx refresh failure must preserve the account behind bounded HTTP/backoff recovery');
assert.match(notify, /connectGateInFlight: Promise<void> \| null/,
  'refresh plus notify handshake must be single-flight');

const tree = read('transport/treeVideo.ts');
const openDiscovery = classMethodText('transport/treeVideo.ts', 'TreeVideoTransport', 'openDiscovery');
const treeKick = classMethodText('transport/treeVideo.ts', 'TreeVideoTransport', 'kickDiscovery');
const treeHeartbeat = classMethodText('transport/treeVideo.ts', 'TreeVideoTransport', 'discoveryHeartbeatTick');
const watchJoin = classMethodText('transport/treeVideo.ts', 'TreeVideoTransport', 'sendWatchJoin');

assert.match(tree, /const DISCOVERY_CONNECT_TIMEOUT_MS = 15_000/,
  'tree discovery CONNECTING deadline must stay bounded at 15 seconds');
assert.match(openDiscovery, /this\.discoveryWs !== ws \|\| ws\.readyState !== WebSocket\.CONNECTING/,
  'tree discovery deadline must be fenced to its exact socket');
assert.match(openDiscovery, /this\.discoveryLastRxAt = Date\.now\(\)/,
  'every exact discovery message must refresh application-level liveness');
assert.match(tree, /msg\.t === 'hello-ack'/,
  'tree discovery must understand the quiet-socket hello acknowledgement');
assert.match(treeHeartbeat, /DISCOVERY_DEAD_AFTER_MS[\s\S]*retireDiscoverySocket\(current, 0\)/,
  'tree discovery heartbeat must replace a half-open socket');
assert.match(treeKick, /WebSocket\.CONNECTING[\s\S]*DISCOVERY_CONNECT_TIMEOUT_MS/,
  'foreground/network kick must enforce elapsed handshake time even after timer throttling');
for (const event of ['online', 'pageshow']) {
  assert.match(tree, new RegExp(`addEventListener\\('${event}', this\\.onDiscoveryReturn\\)`),
    `tree discovery must recover immediately on ${event}`);
}
assert.match(tree, /addEventListener\('visibilitychange', this\.onDiscoveryVisibility\)/,
  'tree discovery must recover when the PWA becomes visible');
assert.doesNotMatch(watchJoin, /\basync\b|\bawait\b|natProbe/,
  'web leaf join must never wait for NAT diagnostics');
assert.match(watchJoin, /symmetricNat: false/,
  'web leaf must join immediately with its topology-neutral NAT value');

const store = read('store.ts');
const startMemberPoll = functionText('store.ts', 'startMemberPoll');
assert.doesNotMatch(startMemberPoll, /setInterval|memberPollRequestSeq/,
  'member polling must not overlap requests or discard all slow mobile responses');
assert.match(startMemberPoll, /finally[\s\S]*schedule\(delay\)/,
  'member polling must recursively schedule only after the active request settles');
assert.match(startMemberPoll, /await Promise\.all[\s\S]*if \(!isCurrent\(\)\) return[\s\S]*useStore\.setState/,
  'a slow response must apply while its server/view generation remains current');
assert.match(store, /onWindowIdle\(\(idle\) => \{ if \(!idle\) kickMemberPoll\(\); \}\)/,
  'member polling must kick immediately when the window becomes active');
assert.match(store, /addEventListener\('pageshow', kickMemberPoll\)/,
  'member polling must kick immediately on PWA pageshow');
assert.match(store, /addEventListener\('online', kickMemberPoll\)/,
  'member polling must kick immediately when the network returns');

const home = read('components/Home.tsx');
assert.match(home, /refreshServers\(controller\.signal\)/,
  'Home refreshes must pass their lifecycle cancellation signal');
assert.match(home, /return \(\) => \{ controller\.abort\(\)/,
  'unmounting Home must abort its owned refresh request');
assert.match(store, /serverListRefresh\.invalidate\(\)[\s\S]*serverListRefresh\.run/,
  'an authoritative loadMe snapshot must invalidate an older Home response before loading');

async function importTypeScript(relative) {
  const output = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import('data:text/javascript,' + encodeURIComponent(output));
}

// Duplicate same-server navigation must share the exact view owner. A terminal LiveKit loss clears
// that owner before the store callback, so the same persisted server id must still reconnect.
{
  const { shouldCoalesceServerConnect } = await importTypeScript('serverConnectionLifecycle.ts');
  const state = (overrides = {}) => ({
    requestedServerId: 'server-a',
    currentViewServerId: 'server-a',
    loadingServerId: null,
    engineAvailable: true,
    engineOwnsRequestedView: true,
    ...overrides,
  });

  assert.equal(shouldCoalesceServerConnect(state()), true,
    'a healthy or still-connecting same-server Engine room keeps its media/watch ownership');
  assert.equal(shouldCoalesceServerConnect(state({
    currentViewServerId: null,
    loadingServerId: 'server-a',
    engineOwnsRequestedView: false,
  })), true, 'the metadata-loading phase remains single-flight before Engine creates its room');
  assert.equal(shouldCoalesceServerConnect(state({ engineOwnsRequestedView: false })), false,
    'a terminal room loss reconnects even while the store still names the same server');
  assert.equal(shouldCoalesceServerConnect(state({
    requestedServerId: 'server-b',
    engineOwnsRequestedView: false,
  })), false, 'a real server switch is never coalesced');
  assert.equal(shouldCoalesceServerConnect(state({
    currentViewServerId: null,
    loadingServerId: 'server-a',
    engineAvailable: false,
    engineOwnsRequestedView: false,
  })), false,
    'a stale loading marker cannot suppress Engine creation/recovery');
}

const connectGuardAt = store.indexOf('shouldCoalesceServerConnect({');
const connectDetachAt = store.indexOf('engine?.detachView(id)', connectGuardAt);
assert.ok(connectGuardAt >= 0 && connectDetachAt > connectGuardAt,
  'same-server ownership is checked before detachView can stop native watches');
assert.match(read('engine.ts'), /ownsViewConnection\(serverId: string\)[\s\S]*this\.viewServerId === serverId[\s\S]*this\.viewRoom !== null/,
  'the coalescing gate reads the synchronous exact Engine room owner');

const terminalViewRecovery = store.match(
  /connectionLost: \(serverId,[\s\S]*?if \(get\(\)\.view === 'server'\) \{[\s\S]*?void get\(\)\.connectServer\(serverId\);[\s\S]*?return;/,
)?.[0] || '';
const releaseDeadLoadingOwnerAt = terminalViewRecovery.indexOf("set({ loadingServer: false, loadingServerId: null })");
const reconnectAfterTerminalAt = terminalViewRecovery.indexOf('get().connectServer(serverId)');
assert.ok(releaseDeadLoadingOwnerAt >= 0 && reconnectAfterTerminalAt > releaseDeadLoadingOwnerAt,
  'terminal room loss releases an in-flight same-server metadata owner before reconnecting');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

// Focus + visibility + interval must share one physical request. A mutation starts a new revision;
// even an old fetch implementation that ignores abort cannot overwrite its authoritative snapshot.
{
  const { OwnedLatestRefresh } = await importTypeScript('serverListRefresh.ts');
  const refresh = new OwnedLatestRefresh();
  const pending = [];
  const commits = [];
  let owner = 'user-a';
  let loads = 0;
  const run = (signal) => refresh.run({
    owner: 'user-a', signal,
    load: (requestSignal) => {
      loads += 1;
      const request = deferred();
      pending.push({ ...request, signal: requestSignal });
      return request.promise;
    },
    isOwnerCurrent: (expected) => owner === expected,
    commit: (value) => commits.push(value),
  });

  const old = run();
  assert.strictEqual(run(), old, 'concurrent Home triggers share one physical refresh');
  assert.equal(loads, 1);
  refresh.invalidate();
  assert.equal(pending[0].signal.aborted, true, 'the superseded fetch is actively aborted');
  const current = run();
  assert.equal(loads, 2);
  pending[1].resolve('after-join');
  assert.equal(await current, true);
  pending[0].resolve('before-join');
  assert.equal(await old, false);
  assert.deepEqual(commits, ['after-join'], 'a late pre-mutation snapshot cannot remove the joined server');

  const lifecycle = new AbortController();
  const unmounted = run(lifecycle.signal);
  lifecycle.abort();
  pending[2].resolve('after-unmount');
  assert.equal(await unmounted, false);
  assert.deepEqual(commits, ['after-join']);

  const wrongAccount = run();
  owner = 'user-b';
  pending[3].resolve('user-a-private-list');
  assert.equal(await wrongAccount, false);
  assert.deepEqual(commits, ['after-join'], 'an old account response cannot enter the new account store');
}

// Tauri updater checks/resources are serialized. Concurrent polls share one retained native request,
// apply is locked, and a hung periodic check cannot block installing the already verified resource.
{
  const { NativeUpdateOperations } = await importTypeScript('nativeUpdateOperations.ts');
  const pending = [];
  const announced = [];
  const timers = new Map();
  let timerId = 0;
  let current = null;
  let activeChecks = 0;
  let maxActiveChecks = 0;
  let relaunches = 0;
  const resource = (version, label) => ({
    version, label, closes: 0, installs: 0,
    close() { this.closes += 1; },
    async downloadAndInstall() { this.installs += 1; },
  });
  const updates = new NativeUpdateOperations({
    getCurrent: () => current,
    setCurrent: (value) => { current = value; },
    checkForUpdate: () => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      const request = deferred();
      pending.push({
        resolve(value) { activeChecks -= 1; request.resolve(value); },
        reject(error) { activeChecks -= 1; request.reject(error); },
      });
      return request.promise;
    },
    onNewVersion: (update) => announced.push(update.version),
    relaunch: async () => { relaunches += 1; },
  }, {
    checkTimeoutMs: 10,
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
  });

  const fireCheckDeadline = () => {
    assert.equal(timers.size, 1, 'one physical updater check owns one logical deadline');
    const [id, callback] = [...timers.entries()][0];
    timers.delete(id);
    callback();
  };

  const firstResource = resource('1.0.0', 'first');
  const first = updates.check();
  const duplicatePoll = updates.check();
  assert.strictEqual(duplicatePoll, first, 'simultaneous poll triggers share one promise');
  await Promise.resolve();
  assert.equal(pending.length, 1);
  pending[0].resolve(firstResource);
  assert.equal(await first, true);
  assert.equal(current.obj, firstResource);

  const duplicateResource = resource('1.0.0', 'duplicate');
  const duplicateVersion = updates.check();
  await Promise.resolve();
  pending[1].resolve(duplicateResource);
  await duplicateVersion;
  assert.equal(current.obj, firstResource);
  assert.equal(duplicateResource.closes, 1, 'a redundant Rust Update descriptor is closed');

  const secondResource = resource('2.0.0', 'second');
  const secondPoll = updates.check();
  await Promise.resolve();
  pending[2].resolve(secondResource);
  assert.equal(await secondPoll, true);
  assert.equal(firstResource.closes, 1, 'a newer stored descriptor closes the displaced resource');

  const thirdResource = resource('3.0.0', 'fresh-apply');
  const apply = updates.apply();
  assert.strictEqual(updates.apply(), apply, 'double click/navigation shares one install operation');
  await Promise.resolve();
  pending[3].resolve(thirdResource);
  await apply;
  assert.equal(maxActiveChecks, 1, 'updater plugin checks never overlap');
  assert.equal(secondResource.closes, 1, 'the resource displaced by fresh apply is closed');
  assert.equal(current.obj, thirdResource);
  assert.equal(thirdResource.installs, 1);
  assert.equal(relaunches, 1);
  assert.deepEqual(announced, ['1.0.0', '2.0.0'], 'fresh apply does not emit a redundant update banner');

  const hungPoll = updates.check();
  assert.strictEqual(updates.check(), hungPoll, 'periodic retries reuse the exact hung native invoke');
  await Promise.resolve();
  assert.equal(pending.length, 5);
  fireCheckDeadline();
  assert.equal(await hungPoll, true, 'the logical poll settles from the verified stored descriptor');

  const storedApply = updates.apply();
  assert.strictEqual(updates.apply(), storedApply, 'stored-resource apply remains single-flight');
  await storedApply;
  assert.equal(pending.length, 5, 'manual apply starts no second native check behind the blackhole');
  assert.equal(thirdResource.installs, 2);
  assert.equal(relaunches, 2);
  assert.equal(maxActiveChecks, 1);

  const emptyTimers = new Map();
  let emptyTimerId = 0;
  let emptyChecks = 0;
  const emptyUpdates = new NativeUpdateOperations({
    getCurrent: () => null,
    setCurrent: () => { throw new Error('must not commit'); },
    checkForUpdate: () => { emptyChecks += 1; return new Promise(() => {}); },
    onNewVersion: () => {},
    relaunch: async () => { throw new Error('must not relaunch'); },
  }, {
    checkTimeoutMs: 10,
    schedule(callback) { const id = ++emptyTimerId; emptyTimers.set(id, callback); return id; },
    cancel(id) { emptyTimers.delete(id); },
  });
  const unavailable = emptyUpdates.apply();
  const unavailableAssertion = assert.rejects(unavailable, /Обновление пока недоступно/);
  await Promise.resolve();
  assert.equal(emptyChecks, 1);
  const [emptyId, emptyDeadline] = [...emptyTimers.entries()][0];
  emptyTimers.delete(emptyId);
  emptyDeadline();
  await unavailableAssertion;
  assert.equal(emptyChecks, 1, 'missing target fails instead of spawning retries or leaving UI busy');
}

// Repeated Home mounts share one manifest fetch. Even an abort-ignoring blackhole owns one native
// fetch only: logical callers settle at the deadline and reuse it until the physical promise ends.
{
  const { AppLatestLoader } = await importTypeScript('appLatest.ts');
  const timers = new Map();
  let timerId = 0;
  let fetches = 0;
  let fetchSignal;
  const physical = deferred();
  let now = 1_000;
  const loader = new AppLatestLoader('/api/app/latest', {
    timeoutMs: 10,
    now: () => now,
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
    fetchImpl(_url, init) { fetches += 1; fetchSignal = init?.signal; return physical.promise; },
  });
  const first = loader.load();
  assert.strictEqual(loader.load(), first);
  assert.equal(fetches, 1);
  [...timers.values()][0]();
  assert.equal(await first, null);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(await loader.load(), null);
  assert.equal(fetches, 1, 'a timed-out physical fetch remains the single retained owner');

  physical.resolve({
    ok: true,
    async json() { return { version: '4.0.0', platforms: { 'windows-x86_64': { url: '/relay.exe' } } }; },
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  now += 1;
  assert.deepEqual(await loader.load(), { version: '4.0.0', url: '/relay.exe' });
  assert.equal(fetches, 1, 'the late healthy result becomes the bounded cache');
}

// Closing a screen-share form or changing its exact voice/account owner cannot publish a deferred
// native capture. Stale cleanup is single-flight and its logical deadline never blocks teardown.
{
  const { NativeBroadcastStartOwner } = await importTypeScript('nativeBroadcastStart.ts');
  const timers = new Map();
  let timerId = 0;
  let stops = 0;
  let published = 0;
  let current = true;
  const nativeStart = deferred();
  const nativeStop = deferred();
  const owner = new NativeBroadcastStartOwner({
    stopTimeoutMs: 10,
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
  });
  const start = owner.start({
    start: () => nativeStart.promise,
    stop: () => { stops += 1; return nativeStop.promise; },
    isCurrent: () => current,
    publish: () => { published += 1; },
  });
  owner.dispose();
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(stops, 1, 'unmount immediately owns one best-effort native stop');
  assert.equal(timers.size, 1);
  const [stopTimerId, stopDeadline] = [...timers.entries()][0];
  timers.delete(stopTimerId);
  stopDeadline();
  nativeStart.resolve();
  assert.equal(await start, false);
  assert.equal(stops, 1, 'late start joins the retained stop instead of stacking native IPC');
  assert.equal(published, 0, 'a capture resolved after modal disposal is never advertised as live');

  nativeStop.resolve();
  for (let i = 0; i < 3; i++) await Promise.resolve();
  const fencedStart = deferred();
  current = true;
  const voiceChanged = owner.start({
    start: () => fencedStart.promise,
    stop: async () => { stops += 1; },
    isCurrent: () => current,
    publish: () => { published += 1; },
  });
  current = false;
  fencedStart.resolve();
  assert.equal(await voiceChanged, false);
  assert.equal(published, 0, 'an account/voice-server switch fences the late completion');
  assert.equal(stops, 2);
}

// Native game detection is uncancellable. Repeated timer ticks retain one physical invoke and one
// latest rerun; a response from room A cannot publish after room B owns the engine or after opt-out.
{
  const { LatestGamePresence } = await importTypeScript('latestGamePresence.ts');
  const detections = [];
  const applied = [];
  let localClears = 0;
  let room = 'room-A';
  let enabled = true;
  const presence = new LatestGamePresence({
    currentRoom: () => room,
    enabled: () => enabled,
    detect: () => { const next = deferred(); detections.push(next); return next.promise; },
    apply: (target, game) => applied.push([target, game?.name || '']),
    clearLocal: () => { localClears += 1; },
  });

  presence.request();
  presence.request();
  presence.request();
  await Promise.resolve();
  assert.equal(detections.length, 1, 'periodic ticks cannot overlap the native invoke');

  room = 'room-B';
  presence.invalidate();
  presence.request();
  detections[0].resolve({ name: 'stale-A' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(detections.length, 2, 'a room switch keeps exactly one latest rerun');
  assert.deepEqual(applied, [], 'late room-A detection cannot publish into either room');
  detections[1].resolve({ name: 'current-B' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(applied, [['room-B', 'current-B']]);

  presence.request();
  await Promise.resolve();
  assert.equal(detections.length, 3);
  enabled = false;
  presence.invalidate();
  assert.deepEqual(applied.at(-1), ['room-B', ''], 'opt-out immediately publishes a tombstone');
  detections[2].resolve({ name: 'late-after-opt-out' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(applied.some(([, name]) => name === 'late-after-opt-out'), false);
  assert.equal(localClears, 1, 'the pre-result room switch clears local presence without inventing a room write');
}

// Uncancellable Tauri IPC is keyed and hard-capped. Timeout settles the modal, while reopening with
// the same paths reuses the exact settled owner instead of accumulating retained invoke promises.
{
  const { BoundedKeyedOperations, AsyncOperationTimeoutError } = await importTypeScript('boundedAsync.ts');
  const timers = new Map();
  let timerId = 0;
  let operations = 0;
  const physical = deferred();
  const bounded = new BoundedKeyedOperations({
    timeoutMs: 10, maxInFlight: 2,
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
  });
  const first = bounded.run('["a"]', () => { operations += 1; return physical.promise; });
  assert.strictEqual(bounded.run('["a"]', () => { operations += 1; return Promise.resolve([]); }), first);
  const timedOut = assert.rejects(first, (error) => error instanceof AsyncOperationTimeoutError);
  [...timers.values()][0]();
  await timedOut;
  assert.equal(operations, 1);
  assert.strictEqual(bounded.run('["a"]', () => { operations += 1; return Promise.resolve([]); }), first);
  const secondPhysical = deferred();
  void bounded.run('["b"]', () => { operations += 1; return secondPhysical.promise; }).catch(() => {});
  await assert.rejects(bounded.run('["c"]', () => { operations += 1; return Promise.resolve([]); }), AsyncOperationTimeoutError);
  assert.equal(operations, 2, 'capacity rejection never starts another native invoke');
  physical.resolve([true]);
  secondPhysical.resolve([true]);
}

// Attachment downloads always release UI busy state through an AbortController deadline.
{
  const { fetchDownloadBlob } = await importTypeScript('downloadFetch.ts');
  const timers = new Map();
  let timerId = 0;
  let networkSignal;
  const blackhole = fetchDownloadBlob('/file', undefined, {
    timeoutMs: 10,
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
    fetchImpl(_url, init) {
      networkSignal = init?.signal;
      return new Promise((_resolve, reject) => networkSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    },
  });
  const rejected = assert.rejects(blackhole, /Сервер не ответил вовремя/);
  [...timers.values()][0]();
  await rejected;
  assert.equal(networkSignal.aborted, true);
}

// A successful header response is not completion: the same deadline remains armed while a
// blackholed response body is parsed, so emote search cannot stay busy forever.
{
  const { fetchJsonWithDeadline } = await importTypeScript('boundedJsonFetch.ts');
  const timers = new Map();
  let timerId = 0;
  let networkSignal;
  let bodyReads = 0;
  const stalledBody = fetchJsonWithDeadline('https://7tv.invalid/body', 10, {}, {
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
    async fetchImpl(_url, init) {
      networkSignal = init?.signal;
      return {
        async json() { bodyReads += 1; return new Promise(() => {}); },
      };
    },
  });
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(bodyReads, 1);
  const rejected = assert.rejects(stalledBody, /Request timed out/);
  [...timers.values()][0]();
  await rejected;
  assert.equal(networkSignal.aborted, true, 'the body deadline aborts the owned physical fetch');
}

// Invite preview always represents the exact current code. An abort-ignoring A response cannot
// overwrite B, and closing the modal cancels both a scheduled debounce and the owned request.
{
  const { InvitePreviewRequest } = await importTypeScript('invitePreviewRequest.ts');
  const timers = new Map();
  let timerId = 0;
  const requests = new Map();
  const shown = [];
  let pendingClears = 0;
  const previews = new InvitePreviewRequest({
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancel(id) { timers.delete(id); },
  });
  const callbacks = {
    onPending() { pendingClears += 1; },
    onSuccess(value) { shown.push(value); },
    onError(error) { throw error; },
  };
  const load = (code, signal) => {
    const request = deferred();
    requests.set(code, { ...request, signal });
    return request.promise;
  };

  previews.start('A', (signal) => load('A', signal), callbacks, 0);
  assert.equal(requests.get('A').signal.aborted, false);
  previews.start('B', (signal) => load('B', signal), callbacks, 0);
  assert.equal(requests.get('A').signal.aborted, true);
  requests.get('B').resolve('server-B');
  await Promise.resolve();
  requests.get('A').resolve('server-A');
  await Promise.resolve();
  assert.deepEqual(shown, ['server-B'], 'late preview A cannot mislabel a join for code B');
  assert.equal(pendingClears, 2, 'the previous card is cleared as soon as a newer code is owned');

  previews.start('C', (signal) => load('C', signal), callbacks, 400);
  assert.equal(timers.size, 1);
  previews.dispose();
  assert.equal(timers.size, 0);
  assert.equal(requests.has('C'), false, 'unmount cancels the debounce before any network request');
}

const downloadCard = read('components/DownloadFab.tsx');
const downloadsModal = read('components/DownloadsModal.tsx');
const serverView = read('components/ServerView.tsx');
const modals = read('components/Modals.tsx');
const broadcastModal = read('components/BroadcastModal.tsx');
const emotes = read('emotes.ts');
const engine = read('engine.ts');
const engineGamePresence = classMethodText('engine.ts', 'Engine', 'startGamePolling');
assert.match(downloadCard, /appLatest\(controller\.signal\)[\s\S]*controller\.abort\(\)/,
  'DownloadCard must fence the exact mount and abort its logical caller');
assert.match(downloadsModal, /fetchDownloadBlob\([\s\S]*controller\.signal/,
  'DownloadsModal must use the bounded shared download helper');
assert.match(serverView, /fetchDownloadBlob\(resolveUploadUrl\(f\.url\), signal\)/,
  'chat attachment downloads must use the same bounded helper');
assert.match(modals, /InvitePreviewRequest<InvitePreview>[\s\S]*api\.invitePreview\(inviteCode, signal\)[\s\S]*dispose\(\)/,
  'JoinModal must bind preview results and cleanup to its exact mounted request owner');
assert.match(broadcastModal, /NativeBroadcastStartOwner[\s\S]*getEngine\(\) === targetEngine[\s\S]*snapshot\.voiceServerId === bcSrv/,
  'native broadcast publication must retain its exact account/engine/voice-server owner');
assert.match(broadcastModal, /dismissible=\{!starting\}[\s\S]*disabled=\{starting\}[\s\S]*onClick=\{close\}/,
  'the native capture form cannot be dismissed while its start command is unresolved');
assert.match(store, /stopNativeBroadcastBounded\(\)[\s\S]*set\(\{ broadcastLive: false \}\)[\s\S]*Promise\.all\(\[closePushBanners, stopNativeCapture\]\)/,
  'logout must own bounded native-capture cleanup independently from Engine state');
assert.match(emotes, /fetchJsonWithDeadline[\s\S]*loadGlobalEmotes[\s\S]*fetchJsonWithDeadline[\s\S]*searchEmotes[\s\S]*fetchJsonWithDeadline/,
  'direct emote probes must keep their deadline through JSON body parsing');
assert.match(engine, /LatestGamePresence<Room, GameStatus>[\s\S]*subscribeSettings[\s\S]*stopGamePolling\(\)[\s\S]*stopGameSettingsWatch/,
  'Engine logout/detach must invalidate game detection and remove its settings owner');
assert.match(engineGamePresence, /gamePresence\.invalidate\(\)[\s\S]*gamePresence\.request\(\)[\s\S]*setInterval/,
  'each exact room starts one fenced latest game poll sequence');

const windowIdle = read('windowIdle.ts');
assert.match(windowIdle, /addEventListener\('pageshow', sync\)/,
  'window idle state must be recomputed on iOS PWA pageshow');

const treeServer = read('../../server/tree.js');
assert.match(treeServer, /send\(id, \{ t: 'hello-ack', serverId: node\.serverId \}\)/,
  'tree server must acknowledge every authorized discovery hello');

console.log('mobile network lifecycle: ok');

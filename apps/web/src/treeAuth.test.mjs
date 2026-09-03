import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./treeAuth.ts', import.meta.url), 'utf8');
const nativeSource = readFileSync(new URL('./native.ts', import.meta.url), 'utf8');
const treeSource = readFileSync(new URL('./transport/treeVideo.ts', import.meta.url), 'utf8');
const videoTransportSource = readFileSync(new URL('./transport/videoTransport.ts', import.meta.url), 'utf8');
const livekitSource = readFileSync(new URL('./transport/livekitVideo.ts', import.meta.url), 'utf8');
const probeSource = readFileSync(new URL('./transport/probe.ts', import.meta.url), 'utf8');
const nativeLibSource = readFileSync(new URL('../../native/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const relaySource = readFileSync(new URL('../../relay-core/src/relay.rs', import.meta.url), 'utf8');

const treeFile = ts.createSourceFile('treeVideo.ts', treeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const treeClass = treeFile.statements.find((node) => ts.isClassDeclaration(node)
  && node.name?.text === 'TreeVideoTransport');
assert.ok(treeClass && ts.isClassDeclaration(treeClass));
const treeMethod = (name) => {
  const method = treeClass.members.find((node) => node.name?.getText(treeFile) === name);
  assert.ok(method, `TreeVideoTransport.${name} must exist`);
  return method.getText(treeFile);
};

const videoTransportFile = ts.createSourceFile(
  'videoTransport.ts', videoTransportSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
);
const watchDiagnosticInterface = videoTransportFile.statements.find((node) => ts.isInterfaceDeclaration(node)
  && node.name.text === 'StreamWatchTransportDiagnostic');
assert.ok(watchDiagnosticInterface && ts.isInterfaceDeclaration(watchDiagnosticInterface));
assert.deepEqual(watchDiagnosticInterface.members.map((member) => member.name?.getText(videoTransportFile)), [
  'streamId', 'stage', 'outcome', 'code', 'connectionState', 'iceState', 'trackState',
  'reconnectCount', 'streamTransport',
], 'transport diagnostics expose only the bounded structured contract');
const stringUnion = (file, name) => {
  const alias = file.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  assert.ok(alias && ts.isTypeAliasDeclaration(alias) && ts.isUnionTypeNode(alias.type));
  return alias.type.types.map((node) => {
    assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
    return node.literal.text;
  });
};
assert.deepEqual(stringUnion(videoTransportFile, 'StreamWatchTransportDiagnosticStage'), [
  'watch_auth', 'watch_listeners', 'watch_native_start', 'watch_signaling', 'watch_join',
  'watch_parent', 'watch_negotiation', 'watch_track', 'watch_recovery',
]);
assert.deepEqual(stringUnion(videoTransportFile, 'StreamWatchTransportDiagnosticCode'), [
  'none', 'timeout', 'network', 'offline', 'auth', 'permission', 'device_lost',
  'media_blocked', 'disconnected', 'sdk', 'unsupported', 'aborted', 'unknown',
  'signaling_unauthorized', 'signaling_forbidden', 'listener_failed', 'native_start_failed',
  'signaling_closed', 'no_parent', 'negotiation_failed', 'ice_failed', 'track_missing',
  'decode_timeout', 'playback_waiting',
]);
assert.deepEqual(stringUnion(videoTransportFile, 'StreamWatchTransportKind'), [
  'tree_web', 'tree_native', 'livekit',
]);

const livekitFile = ts.createSourceFile(
  'livekitVideo.ts', livekitSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
);
const livekitClass = livekitFile.statements.find((node) => ts.isClassDeclaration(node)
  && node.name?.text === 'LiveKitVideoTransport');
assert.ok(livekitClass && ts.isClassDeclaration(livekitClass));
const livekitMethod = (name) => {
  const method = livekitClass.members.find((node) => node.name?.getText(livekitFile) === name);
  assert.ok(method, `LiveKitVideoTransport.${name} must exist`);
  return method.getText(livekitFile);
};

globalThis.window = {};
globalThis.location = { protocol: 'https:', host: 'web.example' };
globalThis.__treeAuthState = {
  token: 'old-access', persistent: true, needsRefresh: true, usable: true,
  refresh: async () => { globalThis.__treeAuthState.token = 'fresh-access'; },
};

const apiModule = 'data:text/javascript,' + encodeURIComponent(`
  export const getToken = () => globalThis.__treeAuthState.token;
  export const refreshAccessSession = () => globalThis.__treeAuthState.refresh();
  export const isTerminalSessionError = (error) => !!error?.terminal;
`);
const sessionModule = 'data:text/javascript,' + encodeURIComponent(`
  export const persistentSessionActive = () => globalThis.__treeAuthState.persistent;
  export const accessTokenNeedsRefresh = () => globalThis.__treeAuthState.needsRefresh;
  export const accessTokenStillUsable = () => globalThis.__treeAuthState.usable;
`);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace("from './api'", `from ${JSON.stringify(apiModule)}`)
  .replace("from './authSession'", `from ${JSON.stringify(sessionModule)}`);
const auth = await import('data:text/javascript,' + encodeURIComponent(js));

assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=fresh-access',
  'an expiring persistent JWT is refreshed before a browser tree handshake');

globalThis.__treeAuthState = {
  token: 'still-valid', persistent: true, needsRefresh: true, usable: true,
  refresh: async () => { throw new Error('offline'); },
};
assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=still-valid',
  'a transient refresh failure may use an access JWT that has not expired yet');

globalThis.__treeAuthState.usable = false;
await assert.rejects(auth.freshTreeWsUrl(), /offline/,
  'an expired JWT fails before opening an authentication retry loop');

let clock = 1_000;
const realNow = Date.now;
Date.now = () => clock;
let refreshCalls = 0;
const sharedOutage = Object.assign(new Error('auth upstream unavailable'), { retryAfter: 1 });
globalThis.__treeAuthState = {
  token: 'cooldown-access', persistent: true, needsRefresh: true, usable: false,
  refresh: async () => { refreshCalls += 1; throw sharedOutage; },
};
const concurrent = await Promise.allSettled(Array.from({ length: 8 }, () => auth.freshTreeWsUrl()));
assert.equal(refreshCalls, 1,
  'concurrent tree callers share the exact refresh promise during an auth outage');
assert.ok(concurrent.every((result) => result.status === 'rejected' && result.reason === sharedOutage));
for (let index = 0; index < 8; index++) {
  await assert.rejects(auth.freshTreeWsUrl(), (error) => error === sharedOutage);
}
assert.equal(refreshCalls, 1,
  'settled transient refresh failures are reused during the shared negative cooldown');
clock += 10_000;
await assert.rejects(auth.freshTreeWsUrl(), (error) => error === sharedOutage);
assert.equal(refreshCalls, 2, 'one new refresh is allowed when the bounded cooldown expires');

let rejectedRefreshes = 0;
globalThis.__treeAuthState = {
  token: 'rejected-access', persistent: true, needsRefresh: false, usable: true,
  refresh: async () => {
    rejectedRefreshes += 1;
    globalThis.__treeAuthState.token = 'replacement-access';
  },
};
auth.markTreeAccessRejected('wss://web.example/tree?token=rejected-access');
assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=replacement-access');
assert.equal(rejectedRefreshes, 1,
  'close 4001 forces a protected refresh even while the rejected JWT is not near expiry');
auth.markTreeAccessRejected('wss://web.example/tree?token=rejected-access');
assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=replacement-access');
assert.equal(rejectedRefreshes, 1,
  'a delayed close from the old generation cannot invalidate the replacement access token');
Date.now = realNow;

globalThis.window.__TAURI_INTERNALS__ = {};
globalThis.__treeAuthState = {
  token: 'native-fresh', persistent: false, needsRefresh: false, usable: true,
  refresh: async () => { throw new Error('must not refresh legacy'); },
};
assert.equal(await auth.freshTreeWsUrl(), 'wss://reelay.online/tree?token=native-fresh');
assert.equal(await auth.freshTreeWsUrl('wss://media.example/tree'), 'wss://media.example/tree?token=native-fresh');

assert.doesNotMatch(nativeSource, /function treeWsUrl\(/,
  'native broadcast/watch must share the authenticated tree URL builder');
assert.match(nativeSource, /startNativeBroadcast[\s\S]*await freshTreeWsUrl\(\)/);
assert.match(nativeSource, /startNativeWatch[\s\S]*await freshTreeWsUrl\(\)/);
assert.match(treeSource, /openDiscovery[\s\S]*await freshTreeWsUrl\(\)/,
  'discovery refreshes access before reconnecting');
assert.match(treeSource, /openBrowserWatch[\s\S]*await freshTreeWsUrl\(\)/,
  'a browser viewer refreshes access before its dedicated watch socket');
assert.match(treeSource, /ev\.code === 4001[\s\S]*markTreeAccessRejected\(wsUrl\)/,
  'an established browser tree socket invalidates only its exact rejected access generation');
assert.match(treeSource, /scheduleBrowserWatchStartRetry\([\s\S]*webReconnectAttempts/,
  'transient auth or constructor failures retry through the existing bounded watch backoff');
const scheduleWatchRetry = treeMethod('scheduleWatchRetry');
assert.match(treeSource, /private watchRetryTimers = new Map<string, number>\(\)/,
  'browser and native reconnects share one delayed owner per logical stream');
assert.match(scheduleWatchRetry,
  /this\.clearWatchRetry\(streamId\)[\s\S]*this\.watchRetryTimers\.get\(streamId\) !== timer[\s\S]*this\.watchRetryTimers\.set\(streamId, timer\)/,
  'a newer reconnect generation cancels and fences the previous delayed callback');
assert.match(treeMethod('scheduleBrowserWatchStartRetry'), /this\.scheduleWatchRetry\(streamId, delay/,
  'browser authentication retries use the per-stream reconnect owner');
assert.doesNotMatch(treeMethod('scheduleBrowserWatchStartRetry'), /\bsetTimeout\(/,
  'browser authentication retries cannot leave unowned timers');
assert.match(treeMethod('openBrowserWatch'), /this\.scheduleWatchRetry\(streamId, delay/,
  'an established browser watch reconnect also uses the per-stream owner');
assert.match(treeMethod('scheduleNativeWatchRetry'), /this\.scheduleWatchRetry\(streamId, delay/,
  'native reconnects use the same per-stream reconnect owner');
assert.doesNotMatch(treeMethod('scheduleNativeWatchRetry'), /\bsetTimeout\(/,
  'native reconnects cannot leave unowned timers');
assert.match(treeMethod('detach'),
  /watchRetryTimers\.forEach\(\(timer\) => clearTimeout\(timer\)\)[\s\S]*watchRetryTimers\.clear\(\)/,
  'transport teardown cancels every reconnect callback before releasing stream state');
const parentOffer = treeMethod('onParentOffer');
assert.match(parentOffer,
  /const ownsOffer = \(\) =>[\s\S]*st\.pc === pc[\s\S]*if \(st\.reparentTimer !== null\) return;[\s\S]*st\.reparentTimer !== timer[\s\S]*ownsOffer\(\)/,
  'one exact peer owns at most one delayed reparent request');
assert.match(parentOffer, /else this\.clearWatchReparentTimer\(st\)/,
  'a recovered peer cancels its pending reparent deadline');
assert.match(parentOffer,
  /const parentId = st\.parentId[\s\S]*const parentGeneration = st\.parentGeneration[\s\S]*const offerGeneration = \+\+st\.offerGeneration[\s\S]*await pc\.setRemoteDescription[\s\S]*if \(!ownsOffer\(\)\) return;[\s\S]*st\.pendingIce\.splice\(0\)/,
  'a stale offer is rejected before it can consume pending ICE owned by its replacement');
assert.match(treeMethod('onWatchMessage'),
  /st\.parentGeneration \+= 1[\s\S]*st\.pendingIce\.length = 0[\s\S]*parentGeneration, candidate: msg\.candidate/,
  'pending ICE is keyed by the exact assign-parent generation, including ICE-before-offer');
assert.match(parentOffer,
  /pc\.onicecandidate[\s\S]*!ownsOffer\(\)[\s\S]*to: parentId/,
  'local ICE is sent only to the parent captured by the exact offer generation');
assert.match(treeMethod('teardownWatch'), /st\.closed = true[\s\S]*clearWatchStateTimers\(st\)/,
  'a retired watch cancels join and reparent deadlines before reconnecting');
assert.match(treeMethod('unwatch'),
  /browserWatchStarts\.delete\(streamId\)[\s\S]*if \(!keep\) \{[\s\S]*dropVideo\(streamId\)[\s\S]*if \(!st\) \{[\s\S]*if \(!keep\) \{[\s\S]*dropVideo\(streamId\)/,
  'explicit cancellation removes a preserved tile even during auth or reconnect gaps');
assert.match(treeMethod('armWatchJoinFallback'),
  /st\.joinFallbackTimer !== timer[\s\S]*this\.watches\.get\(streamId\) === st/,
  'the welcome fallback is fenced to the exact current watch generation');
assert.match(treeMethod('openDiscovery'),
  /discoveryBacklogTimer !== backlogTimer[\s\S]*this\.discoveryWs !== ws/,
  'discovery backlog cleanup is single-owned and exact-socket fenced');
assert.match(treeMethod('retireDiscoverySocket'), /clearDiscoveryBacklogDeadline\(\)/,
  'replacing a discovery socket cancels its pending backlog cleanup');
assert.match(treeMethod('openDiscovery'),
  /ws\.onclose[\s\S]*clearDiscoveryBacklogDeadline\(\)[\s\S]*scheduleDiscoveryReconnect\(\)/,
  'a closed discovery socket cancels backlog work before scheduling reconnect');
assert.match(treeSource,
  /private discoveryLifecycleGeneration = 0;[\s\S]*private discoveryOpening: \{ generation: number; token: symbol \} \| null = null/,
  'discovery authentication has an exact lifecycle owner instead of a shared boolean gate');
assert.match(treeMethod('attach'),
  /discoveryLifecycleGeneration \+= 1;[\s\S]*discoveryOpening = null[\s\S]*openDiscovery\(\)/,
  'a new attach invalidates any authentication promise owned by the previous lifecycle');
assert.match(treeMethod('detach'),
  /discoveryLifecycleGeneration \+= 1;[\s\S]*discoveryOpening = null[\s\S]*this\.closed = true/,
  'detach invalidates its pending discovery authentication before teardown');
assert.match(treeMethod('openDiscovery'),
  /const opening = \{ generation: this\.discoveryLifecycleGeneration[\s\S]*const ownsOpening = \(\)[\s\S]*await freshTreeWsUrl\(\)[\s\S]*if \(!ownsOpening\(\)\) return;[\s\S]*new WebSocket\(wsUrl\)/,
  'a stale discovery authentication result is fenced before WebSocket construction');
const nativeWatchMethod = treeMethod('nativeWatch');
assert.match(nativeWatchMethod,
  /const retainListener = async[\s\S]*if \(!ownsStream\(\)\)[\s\S]*unlisten\(\)[\s\S]*nativeUnwatch\(streamId, st, true\)/,
  'listener registration is retained only by the exact native watch attempt');
assert.match(nativeWatchMethod,
  /retainListener\(onNativeWatchOffer[\s\S]*retainListener\(onNativeWatchIce[\s\S]*retainListener\(onNativeWatchEnded[\s\S]*retainListener\(onNativeWatchStatus[\s\S]*catch \{[\s\S]*nativeUnwatch\(streamId, st, live\)[\s\S]*armVideoFailsafe[\s\S]*scheduleNativeWatchRetry/,
  'a missing mandatory Tauri listener fails closed and retries only through the bounded watch owner');
assert.match(treeMethod('onParentOffer'),
  /onconnectionstatechange[\s\S]*oniceconnectionstatechange[\s\S]*watch_track[\s\S]*track_missing/,
  'browser watch diagnostics cover peer state, ICE state, first video and ended video');
assert.match(treeMethod('onNativeOffer'),
  /onconnectionstatechange[\s\S]*oniceconnectionstatechange[\s\S]*watch_track[\s\S]*nativeWatchAnswer/,
  'native loopback diagnostics cover local peer state, first video and answer delivery');
assert.match(treeMethod('armVideoFailsafe'), /watch_recovery[\s\S]*decode_timeout/,
  'a seamless recovery which never delivers a replacement frame is reported before its tile closes');
assert.match(livekitMethod('watch'), /watch_signaling[\s\S]*subscribeWatchSession/,
  'LiveKit selection reports its room and subscription path');
assert.match(livekitMethod('onSub'), /watch_track[\s\S]*watch_recovery/,
  'LiveKit reports the subscribed video track and successful recovery');
assert.match(livekitMethod('onRemoteUnpub'), /watch_track[\s\S]*beginWatchRecovery[\s\S]*subscribeWatchSession/,
  'LiveKit reports a lost selected publication before selecting its replacement');

// Exercise the actual private timer owners after stripping imports. TypeScript `private` methods
// remain callable in the emitted JavaScript, while unrelated browser/native dependencies are only
// resolved inside methods which this focused harness does not execute.
let executableTreeSource = treeSource;
for (const statement of [...treeFile.statements].reverse()) {
  if (!ts.isImportDeclaration(statement)) continue;
  executableTreeSource = executableTreeSource.slice(0, statement.getFullStart())
    + executableTreeSource.slice(statement.getEnd());
}
const executableTreeJs = ts.transpileModule(executableTreeSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { TreeVideoTransport } = await import(`data:text/javascript;base64,${Buffer.from(executableTreeJs).toString('base64')}`);

const previousWindowSetTimeout = globalThis.window.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
const previousPeerConnection = globalThis.RTCPeerConnection;
const previousNativeWatchAnswer = globalThis.nativeWatchAnswer;
const previousFreshTreeWsUrl = globalThis.freshTreeWsUrl;
const previousWebSocket = globalThis.WebSocket;
const previousDocument = globalThis.document;
const previousWindowAddEventListener = globalThis.window.addEventListener;
const previousWindowRemoveEventListener = globalThis.window.removeEventListener;
const previousWindowSetInterval = globalThis.window.setInterval;
const previousClearInterval = globalThis.clearInterval;
const previousNextNativeWatchGeneration = globalThis.nextNativeWatchGeneration;
const previousOnNativeWatchOffer = globalThis.onNativeWatchOffer;
const previousOnNativeWatchIce = globalThis.onNativeWatchIce;
const previousOnNativeTopology = globalThis.onNativeTopology;
const previousOnNativeWatchEnded = globalThis.onNativeWatchEnded;
const previousOnNativeWatchStatus = globalThis.onNativeWatchStatus;
const previousStartNativeWatch = globalThis.startNativeWatch;
const previousStopNativeWatch = globalThis.stopNativeWatch;
const previousIsTauri = globalThis.isTauri;
let nextTimer = 0;
const timers = new Map();
globalThis.window.setTimeout = (callback, delay) => {
  const id = ++nextTimer;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(Number(id)); };
const fire = (id) => {
  const task = timers.get(id);
  assert.ok(task, `timer ${id} must still be owned`);
  timers.delete(id);
  task.callback();
};

try {
  globalThis.isTauri = false;
  const diagnosticTransport = new TreeVideoTransport();
  const safeDiagnostics = [];
  const removeMutatingDiagnostic = diagnosticTransport.onWatchDiagnostic((event) => {
    event.code = 'unknown';
    event.unexpected = 'must-not-leak';
    throw new Error('diagnostic consumer failure');
  });
  const removeSafeDiagnostic = diagnosticTransport.onWatchDiagnostic((event) => safeDiagnostics.push(event));
  diagnosticTransport.emitWatchDiagnostic('local-stream-route', {
    stage: 'watch_negotiation', outcome: 'failed', code: 'ice_failed',
    connectionState: 'disconnected', iceState: 'failed', trackState: 'missing',
    reconnectCount: 50_000,
    rawError: 'secret', identity: 'remote-session', sdp: 'private-description', candidate: 'private-candidate',
  });
  assert.deepEqual(safeDiagnostics, [{
    streamId: 'local-stream-route',
    stage: 'watch_negotiation',
    outcome: 'failed',
    code: 'ice_failed',
    connectionState: 'disconnected',
    iceState: 'failed',
    trackState: 'missing',
    reconnectCount: 1000,
    streamTransport: 'tree_web',
  }], 'diagnostic consumers receive isolated copies with no raw transport payload');
  removeMutatingDiagnostic();
  removeSafeDiagnostic();

  const retries = new TreeVideoTransport();
  const firedRetries = [];
  retries.scheduleWatchRetry('same-stream', 1000, () => firedRetries.push('old'));
  retries.scheduleWatchRetry('same-stream', 1000, () => firedRetries.push('new'));
  assert.equal(timers.size, 1,
    'a newer reconnect for the same stream physically cancels the old timeout');
  fire([...timers.keys()][0]);
  assert.deepEqual(firedRetries, ['new'],
    'only the latest reconnect generation may execute');

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };

  // A cancelled async auth generation must not append its late failure to a newer Engine attempt
  // which happens to use the same local stream routing key.
  const staleWatchAuth = deferred();
  globalThis.freshTreeWsUrl = () => staleWatchAuth.promise;
  const cancelledAuthWatch = new TreeVideoTransport();
  const cancelledAuthDiagnostics = [];
  cancelledAuthWatch.onWatchDiagnostic((event) => cancelledAuthDiagnostics.push(event));
  cancelledAuthWatch.watch('cancelled-auth');
  cancelledAuthWatch.unwatch('cancelled-auth');
  staleWatchAuth.reject(new Error('late refresh rejection'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelledAuthDiagnostics.some((event) => event.outcome === 'failed'), false,
    'a late auth rejection from a cancelled watch generation is ignored');

  // A refresh from lifecycle A is intentionally left pending. detach -> attach must start B
  // immediately, and A must remain unable to construct a socket after it eventually resolves.
  const discoveryA = deferred();
  const discoveryB = deferred();
  const discoveryUrls = [];
  let discoveryAuthCalls = 0;
  globalThis.freshTreeWsUrl = () => (++discoveryAuthCalls === 1 ? discoveryA.promise : discoveryB.promise);
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    constructor(url) { this.url = url; discoveryUrls.push(url); }
    close() { this.readyState = 3; }
    send() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.window.setInterval = () => ++nextTimer;
  globalThis.clearInterval = () => {};
  const discovery = new TreeVideoTransport();
  discovery.attach(null, { me: 'first-user', serverId: 'first-server' });
  assert.equal(discoveryAuthCalls, 1);
  discovery.detach();
  discovery.attach(null, { me: 'second-user', serverId: 'second-server' });
  assert.equal(discoveryAuthCalls, 2,
    'a replacement attach does not wait for the abandoned discovery refresh');
  discoveryB.resolve('wss://new-lifecycle.example/tree');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(discoveryUrls, ['wss://new-lifecycle.example/tree']);
  discoveryA.resolve('wss://stale-lifecycle.example/tree');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(discoveryUrls, ['wss://new-lifecycle.example/tree'],
    'the stale lifecycle cannot construct a WebSocket after its refresh settles');
  discovery.detach();
  assert.equal(timers.size, 0);

  const remoteDescriptionGates = new Map();
  const peerConnections = [];
  class FakePeerConnection {
    connectionState = 'new';
    iceConnectionState = 'new';
    remoteDescription = null;
    localDescription = null;
    addedIce = [];
    onconnectionstatechange = null;
    oniceconnectionstatechange = null;
    onicecandidate = null;
    ontrack = null;
    constructor() { peerConnections.push(this); }
    close() { this.connectionState = 'closed'; }
    getTransceivers() { return []; }
    async setRemoteDescription(description) {
      const gate = remoteDescriptionGates.get(description.sdp);
      if (gate) await gate.promise;
      this.remoteDescription = description;
    }
    async addIceCandidate(candidate) { this.addedIce.push(candidate); }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(answer) { this.localDescription = answer; }
  }
  globalThis.RTCPeerConnection = FakePeerConnection;
  const reparents = new TreeVideoTransport();
  const sent = [];
  const watch = {
    ws: { send: (payload) => sent.push(JSON.parse(payload)) },
    pc: null,
    parentId: 'parent',
    closed: false,
    iceServers: [],
    maxChildren: 0,
    joined: true,
    quality: 'source',
    pinned: false,
    pendingIce: [],
    parentGeneration: 1,
    offerGeneration: 0,
    joinFallbackTimer: null,
    reparentTimer: null,
  };
  reparents.watches.set('stream', watch);
  await reparents.onParentOffer('stream', watch, 'offer');
  const peer = watch.pc;
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  peer.onconnectionstatechange();
  assert.equal(timers.size, 1,
    'repeated disconnected notifications share one exact-peer reparent timeout');
  peer.connectionState = 'connected';
  peer.onconnectionstatechange();
  assert.equal(timers.size, 0,
    'connection recovery physically cancels its delayed reparent');
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  fire([...timers.keys()][0]);
  assert.equal(sent.filter((message) => message.t === 'request-reparent').length, 1,
    'a sustained disconnect emits one reparent request');
  peer.onconnectionstatechange();
  assert.equal(timers.size, 1);
  reparents.teardownWatch('stream', watch, true);
  assert.equal(timers.size, 0,
    'retiring the watch physically cancels its pending reparent timeout');

  const offerA = deferred();
  const offerB = deferred();
  remoteDescriptionGates.set('offer-a', offerA);
  remoteDescriptionGates.set('offer-b', offerB);
  const overlap = new TreeVideoTransport();
  const overlapSent = [];
  const overlappingWatch = {
    ...watch,
    ws: { send: (payload) => overlapSent.push(JSON.parse(payload)) },
    pc: null,
    parentId: 'parent-a',
    closed: false,
    pendingIce: [],
    parentGeneration: 1,
    offerGeneration: 0,
    reparentTimer: null,
  };
  overlap.watches.set('overlap', overlappingWatch);
  const firstOffer = overlap.onParentOffer('overlap', overlappingWatch, 'offer-a');
  const peerA = overlappingWatch.pc;
  overlap.onWatchMessage('overlap', overlappingWatch, {
    data: JSON.stringify({ t: 'ice', from: 'parent-a', candidate: { candidate: 'remote-a' } }),
  });
  overlap.onWatchMessage('overlap', overlappingWatch, {
    data: JSON.stringify({ t: 'assign-parent', parentId: 'parent-b' }),
  });
  overlap.clearVideoFailsafe('overlap');
  overlap.onWatchMessage('overlap', overlappingWatch, {
    data: JSON.stringify({ t: 'ice', from: 'parent-b', candidate: { candidate: 'remote-b' } }),
  });
  const secondOffer = overlap.onParentOffer('overlap', overlappingWatch, 'offer-b');
  const peerB = overlappingWatch.pc;
  peerA.onicecandidate({ candidate: { candidate: 'local-a' } });
  assert.equal(overlapSent.length, 0,
    'late local ICE from offer A is never addressed to the current parent B');

  offerA.resolve();
  await firstOffer;
  assert.deepEqual(peerA.addedIce, [],
    'offer A cannot consume the queued remote ICE owned by offer B');
  assert.equal(overlappingWatch.pendingIce.length, 1,
    'offer B retains its pending ICE while offer A settles late');

  offerB.resolve();
  await secondOffer;
  assert.deepEqual(peerB.addedIce, [{ candidate: 'remote-b' }],
    'offer B consumes ICE which arrived before SDP only for its exact parent generation');
  assert.deepEqual(overlapSent.filter((message) => message.t === 'sdp').map((message) => message.to), ['parent-b'],
    'only offer B can publish an SDP answer, addressed to its captured parent');
  assert.equal(peerConnections.includes(peerA) && peerConnections.includes(peerB), true);

  const nativeOfferA = deferred();
  const nativeOfferB = deferred();
  remoteDescriptionGates.set('native-offer-a', nativeOfferA);
  remoteDescriptionGates.set('native-offer-b', nativeOfferB);
  const nativeAnswers = [];
  globalThis.nativeWatchAnswer = async (...args) => { nativeAnswers.push(args); };
  const nativeOverlap = new TreeVideoTransport();
  const nativeState = {
    generation: 71, pc: null, unlisten: [], closed: false, stopped: false, pendingIce: [],
    quality: 'source', pinned: false,
  };
  nativeOverlap.nativeWatches.set('native-overlap', nativeState);
  const firstNativeOffer = nativeOverlap.onNativeOffer('native-overlap', nativeState, 'native-offer-a');
  const nativePeerA = nativeState.pc;
  const secondNativeOffer = nativeOverlap.onNativeOffer('native-overlap', nativeState, 'native-offer-b');
  const nativePeerB = nativeState.pc;
  nativeState.pendingIce.push({ candidate: 'native-remote-b' });

  nativePeerA.connectionState = 'failed';
  nativePeerA.onconnectionstatechange();
  assert.equal(nativeOverlap.nativeWatches.get('native-overlap'), nativeState,
    'a terminal state callback from the retired peer cannot tear down the replacement owner');
  assert.equal(nativeOverlap.watchRetryTimers.has('native-overlap'), false,
    'a retired peer cannot schedule a retry over its replacement');
  nativeOfferA.reject(new Error('retired native offer failed late'));
  await firstNativeOffer;
  assert.deepEqual(nativePeerA.addedIce, [],
    'a retired native offer cannot consume ICE queued for its replacement peer');
  assert.equal(nativeState.pendingIce.length, 1,
    'replacement native ICE remains queued while the retired remote description settles');
  assert.equal(nativeOverlap.nativeWatches.get('native-overlap'), nativeState,
    'a late negotiation failure from the retired peer cannot tear down the replacement owner');
  assert.equal(nativeOverlap.watchRetryTimers.has('native-overlap'), false,
    'a stale peer failure cannot schedule a retry over its replacement');

  nativeOfferB.resolve();
  await secondNativeOffer;
  assert.deepEqual(nativePeerB.addedIce, [{ candidate: 'native-remote-b' }]);
  assert.equal(nativeAnswers.length, 1,
    'only the current native peer publishes an SDP answer');

  const negotiationStops = [];
  globalThis.isTauri = true;
  globalThis.nativeWatchAnswer = async () => {};
  globalThis.stopNativeWatch = async (...args) => { negotiationStops.push(args); };
  const seedNativeAttempt = (transport, streamId, generation) => {
    const state = {
      generation, pc: null, unlisten: [], closed: false, stopped: false, pendingIce: [],
      quality: 'source', pinned: false,
    };
    transport.nativeWatches.set(streamId, state);
    transport.intended.add(streamId);
    transport.liveStreams.set(streamId, {});
    return state;
  };
  const assertOwnedRetry = (transport, streamId, state, expectedStop) => {
    assert.equal(state.closed, true, 'the failed exact native owner is retired');
    assert.equal(transport.nativeWatches.has(streamId), false,
      'the failed native owner leaves the active-watch slot before retry');
    assert.equal(transport.watchRetryTimers.has(streamId), true,
      'the still-live stream owns one bounded retry timer');
    assert.equal(transport.reWatchAttempts.get(streamId), 1,
      'one terminal negotiation failure counts as exactly one reconnect');
    assert.deepEqual(negotiationStops.splice(0), [expectedStop],
      'recovery fences only the exact failed Rust generation');
    transport.unwatch(streamId);
    assert.equal(transport.watchRetryTimers.has(streamId), false,
      'explicit unwatch physically cancels the pending native retry');
    assert.equal(transport.videoFailsafe.has(streamId), false,
      'explicit unwatch also cancels the retained-frame failsafe');
    assert.equal(timers.size, 0, 'explicit unwatch leaves no negotiation recovery timers');
  };

  const constructorFailure = new TreeVideoTransport();
  const constructorDiagnostics = [];
  constructorFailure.onWatchDiagnostic((event) => constructorDiagnostics.push(event));
  const constructorState = seedNativeAttempt(constructorFailure, 'constructor-failure', 801);
  globalThis.RTCPeerConnection = class {
    constructor() { throw new Error('peer construction failed'); }
  };
  await constructorFailure.onNativeOffer('constructor-failure', constructorState, 'offer');
  assert.ok(constructorDiagnostics.some((event) => event.stage === 'watch_negotiation'
    && event.outcome === 'failed' && event.code === 'negotiation_failed'),
  'RTCPeerConnection construction failure is reported before recovery');
  assertOwnedRetry(constructorFailure, 'constructor-failure', constructorState, ['constructor-failure', 801]);

  class RejectRemoteDescriptionPeerConnection extends FakePeerConnection {
    async setRemoteDescription() { throw new Error('remote description rejected'); }
  }
  globalThis.RTCPeerConnection = RejectRemoteDescriptionPeerConnection;
  const descriptionFailure = new TreeVideoTransport();
  const descriptionState = seedNativeAttempt(descriptionFailure, 'description-failure', 802);
  await descriptionFailure.onNativeOffer('description-failure', descriptionState, 'offer');
  assertOwnedRetry(descriptionFailure, 'description-failure', descriptionState, ['description-failure', 802]);

  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.nativeWatchAnswer = async () => { throw new Error('native answer delivery rejected'); };
  const answerFailure = new TreeVideoTransport();
  const answerState = seedNativeAttempt(answerFailure, 'answer-failure', 803);
  await answerFailure.onNativeOffer('answer-failure', answerState, 'offer');
  assertOwnedRetry(answerFailure, 'answer-failure', answerState, ['answer-failure', 803]);

  globalThis.nativeWatchAnswer = async () => {};
  const connectionFailure = new TreeVideoTransport();
  const connectionDiagnostics = [];
  connectionFailure.onWatchDiagnostic((event) => connectionDiagnostics.push(event));
  const connectionState = seedNativeAttempt(connectionFailure, 'connection-failure', 804);
  await connectionFailure.onNativeOffer('connection-failure', connectionState, 'offer');
  const failedConnectionPeer = connectionState.pc;
  failedConnectionPeer.connectionState = 'failed';
  failedConnectionPeer.onconnectionstatechange();
  assert.ok(connectionDiagnostics.some((event) => event.stage === 'watch_negotiation'
    && event.outcome === 'failed' && event.code === 'negotiation_failed'
    && event.connectionState === 'disconnected' && event.iceState === 'new'),
  'a terminal aggregate connection failure is not mislabeled as ICE when ICE itself did not fail');
  failedConnectionPeer.iceConnectionState = 'failed';
  failedConnectionPeer.oniceconnectionstatechange();
  assertOwnedRetry(connectionFailure, 'connection-failure', connectionState, ['connection-failure', 804]);

  const iceFailure = new TreeVideoTransport();
  const iceState = seedNativeAttempt(iceFailure, 'ice-failure', 805);
  await iceFailure.onNativeOffer('ice-failure', iceState, 'offer');
  const failedIcePeer = iceState.pc;
  failedIcePeer.iceConnectionState = 'failed';
  failedIcePeer.oniceconnectionstatechange();
  assertOwnedRetry(iceFailure, 'ice-failure', iceState, ['ice-failure', 805]);

  const disconnected = new TreeVideoTransport();
  const disconnectedState = seedNativeAttempt(disconnected, 'transient-disconnect', 806);
  await disconnected.onNativeOffer('transient-disconnect', disconnectedState, 'offer');
  const disconnectedPeer = disconnectedState.pc;
  disconnectedPeer.connectionState = 'disconnected';
  disconnectedPeer.onconnectionstatechange();
  disconnectedPeer.iceConnectionState = 'disconnected';
  disconnectedPeer.oniceconnectionstatechange();
  assert.equal(disconnected.nativeWatches.get('transient-disconnect'), disconnectedState,
    'a transient disconnected state retains the exact peer so WebRTC can recover it');
  assert.equal(disconnected.watchRetryTimers.has('transient-disconnect'), false,
    'disconnected is not treated as a terminal retry signal');
  assert.equal(disconnected.reWatchAttempts.has('transient-disconnect'), false);
  disconnected.unwatch('transient-disconnect');
  assert.deepEqual(negotiationStops.splice(0), [['transient-disconnect', 806]]);
  assert.equal(timers.size, 0);

  let nextNativeGeneration = 9000;
  let releasedOfferListener = 0;
  let startedNativeWatch = 0;
  let topologyListenerCalls = 0;
  let endedListenerCalls = 0;
  const stoppedNativeWatches = [];
  globalThis.nextNativeWatchGeneration = () => ++nextNativeGeneration;
  globalThis.onNativeWatchOffer = async () => () => { releasedOfferListener += 1; };
  globalThis.onNativeWatchIce = async () => { throw new Error('Tauri listen rejected'); };
  globalThis.onNativeTopology = async () => { topologyListenerCalls += 1; return () => {}; };
  globalThis.onNativeWatchEnded = async () => { endedListenerCalls += 1; return () => {}; };
  globalThis.startNativeWatch = async () => { startedNativeWatch += 1; };
  globalThis.stopNativeWatch = async (...args) => { stoppedNativeWatches.push(args); };
  const rejectedListener = new TreeVideoTransport();
  const listenerDiagnostics = [];
  rejectedListener.onWatchDiagnostic((event) => listenerDiagnostics.push(event));
  globalThis.isTauri = true;
  rejectedListener.intended.add('listener-reject');
  rejectedListener.liveStreams.set('listener-reject', {});
  await rejectedListener.nativeWatch('listener-reject', 'source', false);
  assert.equal(startedNativeWatch, 0,
    'Rust watch never starts without the mandatory offer/ICE/end listener set');
  assert.equal(releasedOfferListener, 1,
    'listeners retained before a later registration failure are released exactly once');
  assert.equal(topologyListenerCalls, 0);
  assert.equal(endedListenerCalls, 0);
  assert.deepEqual(stoppedNativeWatches, [['listener-reject', 9001]],
    'the failed listener attempt fences its exact Rust generation');
  assert.equal(rejectedListener.nativeWatches.has('listener-reject'), false);
  assert.equal(rejectedListener.videoFailsafe.has('listener-reject'), true,
    'a still-live intended stream gets a bounded missing-video failsafe');
  assert.equal(rejectedListener.watchRetryTimers.has('listener-reject'), true,
    'a still-live intended stream gets one owned retry after listener registration fails');
  assert.ok(listenerDiagnostics.some((event) => event.stage === 'watch_listeners'
    && event.outcome === 'failed' && event.code === 'listener_failed'
    && event.streamTransport === 'tree_native'),
  'a native listener failure reaches the bounded transport diagnostic callback');
  rejectedListener.unwatch('listener-reject');
  assert.equal(timers.size, 0,
    'explicit cancellation removes both the listener-failure retry and its video failsafe');

  const lateIceListener = deferred();
  let releasedLateOfferListener = 0;
  const lateStops = [];
  globalThis.onNativeWatchOffer = async () => () => { releasedLateOfferListener += 1; };
  globalThis.onNativeWatchIce = () => lateIceListener.promise;
  globalThis.stopNativeWatch = async (...args) => { lateStops.push(args); };
  const cancelledRegistration = new TreeVideoTransport();
  const cancelledDiagnostics = [];
  cancelledRegistration.onWatchDiagnostic((event) => cancelledDiagnostics.push(event));
  cancelledRegistration.intended.add('cancelled-registration');
  cancelledRegistration.liveStreams.set('cancelled-registration', {});
  const lateRegistration = cancelledRegistration.nativeWatch('cancelled-registration', 'source', false);
  await Promise.resolve();
  await Promise.resolve();
  cancelledRegistration.unwatch('cancelled-registration');
  lateIceListener.reject(new Error('late Tauri listen rejection'));
  await lateRegistration;
  assert.equal(releasedLateOfferListener, 1,
    'a listener retained before explicit cancellation is not released twice by late settlement');
  assert.deepEqual(lateStops, [['cancelled-registration', 9002]],
    'late registration settlement cannot issue duplicate or replacement-generation stops');
  assert.equal(cancelledRegistration.watchRetryTimers.has('cancelled-registration'), false,
    'a cancelled listener attempt never schedules a reconnect');
  assert.equal(cancelledDiagnostics.some((event) => event.outcome === 'failed'
    && event.code === 'listener_failed'), false,
  'a listener rejection settling after explicit cancellation does not create a false incident');
  assert.equal(timers.size, 0);

  const statusCallbacks = [];
  globalThis.onNativeWatchOffer = async () => () => {};
  globalThis.onNativeWatchIce = async () => () => {};
  globalThis.onNativeTopology = async () => () => {};
  globalThis.onNativeWatchEnded = async () => () => {};
  globalThis.onNativeWatchStatus = async (callback) => {
    statusCallbacks.push(callback);
    return () => {};
  };
  globalThis.startNativeWatch = async () => {};
  const statusTransport = new TreeVideoTransport();
  const statusDiagnostics = [];
  statusTransport.onWatchDiagnostic((event) => statusDiagnostics.push(event));
  await statusTransport.nativeWatch('status-current', 'source', false);
  const currentStatusOwner = statusTransport.nativeWatches.get('status-current');
  assert.ok(currentStatusOwner);
  assert.equal(statusCallbacks.length, 1);
  const currentStatus = {
    streamId: 'status-current', generation: currentStatusOwner.generation,
    stage: 'watch_signaling', outcome: 'failed', code: 'signaling_forbidden', reconnectCount: 7,
  };
  statusCallbacks[0]({ ...currentStatus, streamId: 'other-stream' });
  statusCallbacks[0]({ ...currentStatus, generation: currentStatusOwner.generation - 1 });
  statusCallbacks[0](currentStatus);
  assert.deepEqual(statusDiagnostics.filter((event) => event.code === 'signaling_forbidden'), [{
    streamId: 'status-current', stage: 'watch_signaling', outcome: 'failed',
    code: 'signaling_forbidden', reconnectCount: 7, streamTransport: 'tree_native',
  }], 'only the exact current native watch owner accepts a normalized Rust status');
  statusTransport.unwatch('status-current');
  statusCallbacks[0](currentStatus);
  assert.equal(statusDiagnostics.filter((event) => event.code === 'signaling_forbidden').length, 1,
    'a retired native generation cannot append a late Rust status');
  assert.equal(timers.size, 0);
} finally {
  if (previousWindowSetTimeout === undefined) delete globalThis.window.setTimeout;
  else globalThis.window.setTimeout = previousWindowSetTimeout;
  globalThis.clearTimeout = previousClearTimeout;
  if (previousPeerConnection === undefined) delete globalThis.RTCPeerConnection;
  else globalThis.RTCPeerConnection = previousPeerConnection;
  if (previousNativeWatchAnswer === undefined) delete globalThis.nativeWatchAnswer;
  else globalThis.nativeWatchAnswer = previousNativeWatchAnswer;
  if (previousFreshTreeWsUrl === undefined) delete globalThis.freshTreeWsUrl;
  else globalThis.freshTreeWsUrl = previousFreshTreeWsUrl;
  if (previousWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = previousWebSocket;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousWindowAddEventListener === undefined) delete globalThis.window.addEventListener;
  else globalThis.window.addEventListener = previousWindowAddEventListener;
  if (previousWindowRemoveEventListener === undefined) delete globalThis.window.removeEventListener;
  else globalThis.window.removeEventListener = previousWindowRemoveEventListener;
  if (previousWindowSetInterval === undefined) delete globalThis.window.setInterval;
  else globalThis.window.setInterval = previousWindowSetInterval;
  globalThis.clearInterval = previousClearInterval;
  const restoreGlobal = (name, previous) => {
    if (previous === undefined) delete globalThis[name];
    else globalThis[name] = previous;
  };
  restoreGlobal('nextNativeWatchGeneration', previousNextNativeWatchGeneration);
  restoreGlobal('onNativeWatchOffer', previousOnNativeWatchOffer);
  restoreGlobal('onNativeWatchIce', previousOnNativeWatchIce);
  restoreGlobal('onNativeTopology', previousOnNativeTopology);
  restoreGlobal('onNativeWatchEnded', previousOnNativeWatchEnded);
  restoreGlobal('onNativeWatchStatus', previousOnNativeWatchStatus);
  restoreGlobal('startNativeWatch', previousStartNativeWatch);
  restoreGlobal('stopNativeWatch', previousStopNativeWatch);
  restoreGlobal('isTauri', previousIsTauri);
}

// Exercise the LiveKit selection/subscription/track sequence without importing the SDK. As with
// the Tree harness above, TypeScript private members are ordinary JavaScript properties here.
let executableLivekitSource = livekitSource;
for (const statement of [...livekitFile.statements].reverse()) {
  if (!ts.isImportDeclaration(statement)) continue;
  executableLivekitSource = executableLivekitSource.slice(0, statement.getFullStart())
    + executableLivekitSource.slice(statement.getEnd());
}
const executableLivekitJs = ts.transpileModule(executableLivekitSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const previousExactPeerStatsSampler = globalThis.ExactPeerStatsSampler;
const previousTrack = globalThis.Track;
const previousBaseUid = globalThis.baseUid;
try {
  globalThis.ExactPeerStatsSampler = class {};
  globalThis.Track = {
    Source: { ScreenShare: 'screen', ScreenShareAudio: 'screen-audio' },
    Kind: { Video: 'video' },
  };
  globalThis.baseUid = (identity) => identity.split(':')[0];
  const { LiveKitVideoTransport } = await import(
    `data:text/javascript;base64,${Buffer.from(executableLivekitJs).toString('base64')}`
  );
  const subscriptionCalls = [];
  const videoPublication = {
    source: 'screen', trackSid: 'video-one',
    setSubscribed: (value) => subscriptionCalls.push(['video-one', value]),
  };
  const audioPublication = {
    source: 'screen-audio', trackSid: 'audio-one',
    setSubscribed: (value) => subscriptionCalls.push(['audio-one', value]),
  };
  const participant = {
    identity: 'local-watch-key:session-one',
    getTrackPublication: (source) => source === 'screen' ? videoPublication
      : source === 'screen-audio' ? audioPublication : undefined,
  };
  const remoteParticipants = new Map([[participant.identity, participant]]);
  const livekit = new LiveKitVideoTransport();
  livekit.room = { remoteParticipants };
  const livekitDiagnostics = [];
  const livekitVideoTracks = [];
  livekit.onWatchDiagnostic((event) => livekitDiagnostics.push(event));
  livekit.onVideoTrack((key, track, identity) => livekitVideoTracks.push({ key, track, identity }));
  livekit.watch('local-watch-key');
  assert.deepEqual(livekitDiagnostics.slice(0, 4).map(({ stage, outcome, code }) => (
    [stage, outcome, code]
  )), [
    ['watch_signaling', 'started', 'none'],
    ['watch_signaling', 'ok', 'none'],
    ['watch_join', 'started', 'none'],
    ['watch_join', 'ok', 'none'],
  ], 'LiveKit reports room selection and screen publication subscription');
  assert.deepEqual(subscriptionCalls, [['video-one', true], ['audio-one', true]]);

  const firstTrack = {
    kind: 'video', mediaStreamTrack: { readyState: 'live' }, detach: () => [],
  };
  livekit.onSub(firstTrack, videoPublication, participant);
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_track'
    && event.outcome === 'ok' && event.trackState === 'live'));

  remoteParticipants.delete(participant.identity);
  livekit.onRemoteUnpub(videoPublication, participant);
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'started' && event.reconnectCount === 1));

  const replacementPublication = {
    source: 'screen', trackSid: 'video-two',
    setSubscribed: (value) => subscriptionCalls.push(['video-two', value]),
  };
  const replacement = {
    identity: 'local-watch-key:session-two',
    getTrackPublication: (source) => source === 'screen' ? replacementPublication : undefined,
  };
  remoteParticipants.set(replacement.identity, replacement);
  livekit.onRemotePub(replacementPublication, replacement);
  livekit.onSub({
    kind: 'video', mediaStreamTrack: { readyState: 'live' }, detach: () => [],
  }, replacementPublication, replacement);
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'recovered' && event.reconnectCount === 1),
  'a replacement LiveKit session closes the structured recovery sequence');
  const acceptedTrackCount = livekitVideoTracks.length;
  livekit.onSub({
    kind: 'video', mediaStreamTrack: { readyState: 'live' }, detach: () => [],
  }, videoPublication, participant);
  assert.equal(livekitVideoTracks.length, acceptedTrackCount,
    'a late subscribed track from the retired LiveKit session never reaches Engine');
  assert.equal(subscriptionCalls.at(-1)?.[1], false,
    'a late subscribed track from the retired LiveKit session is unsubscribed again');

  const discoveryPublication = { source: 'screen', trackSid: 'discovery-video' };
  const discoveryParticipant = {
    identity: 'unwatched-user:session-one',
    getTrackPublication: () => discoveryPublication,
  };
  livekit.onSub({
    kind: 'video', mediaStreamTrack: { readyState: 'live' }, detach: () => [],
  }, discoveryPublication, discoveryParticipant);
  assert.equal(livekitVideoTracks.at(-1)?.identity, 'unwatched-user',
    'an unwatched LiveKit publication keeps the existing discovery behavior');
  const allowedDiagnosticKeys = new Set([
    'streamId', 'stage', 'outcome', 'code', 'connectionState', 'iceState', 'trackState',
    'reconnectCount', 'streamTransport',
  ]);
  for (const event of livekitDiagnostics) {
    assert.ok(Object.keys(event).every((key) => allowedDiagnosticKeys.has(key)));
    assert.equal(event.streamId, 'local-watch-key');
    assert.equal(event.streamTransport, 'livekit');
  }
} finally {
  if (previousExactPeerStatsSampler === undefined) delete globalThis.ExactPeerStatsSampler;
  else globalThis.ExactPeerStatsSampler = previousExactPeerStatsSampler;
  if (previousTrack === undefined) delete globalThis.Track;
  else globalThis.Track = previousTrack;
  if (previousBaseUid === undefined) delete globalThis.baseUid;
  else globalThis.baseUid = previousBaseUid;
}

assert.match(treeSource, /\[\.\.\.this\.browserWatchStarts\.keys\(\)\][\s\S]*this\.unwatch\(streamId\)/,
  'detach cancels viewer attempts which are still waiting behind the auth gate');
assert.doesNotMatch(treeSource, /(?:start|end)ViewerSession|from ['"]\.\.\/diag['"]/,
  'a viewer uses only fixed-schema watch diagnostics and never starts the legacy raw session collector');
assert.match(treeSource,
  /catch \(error\) \{[\s\S]*const ownsStream = this\.nativeWatches\.get\(streamId\) === st;[\s\S]*if \(!ownsStream\) \{[\s\S]*this\.nativeUnwatch\(streamId, st, true\);[\s\S]*return;/,
  'an out-of-order failure from native owner A cleans only A and cannot retry over owner B');
assert.match(treeSource,
  /private nativeUnwatch[\s\S]*const ownsStream = this\.nativeWatches\.get\(streamId\) === st;[\s\S]*stopNativeWatch\(streamId, st\.generation\)[\s\S]*if \(!ownsStream\) return;[\s\S]*this\.nativeWatches\.delete\(streamId\)/,
  'a stale native owner cannot delete topology or video owned by its replacement');
assert.match(treeSource,
  /private async onNativeOffer[\s\S]*const ownsOffer = \(\) =>[\s\S]*st\.pc === pc[\s\S]*await pc\.setRemoteDescription[\s\S]*if \(!ownsOffer\(\)\) return;[\s\S]*st\.pendingIce\.splice\(0\)[\s\S]*nativeWatchAnswer\(streamId, st\.generation/,
  'late native offers stop before consuming replacement ICE or publishing a stale answer');
assert.match(nativeLibSource,
  /latest_generation:[\s\S]*claim_native_watch_generation[\s\S]*stop\/newer start won while protected refresh was in flight/,
  'Rust retains a per-stream generation tombstone across an async native auth start');
assert.match(relaySource,
  /Some\(TreeEvent::Closed\) \| None => \{ watch_ended = true; break; \}/,
  'an unexpected terminal signalling close notifies the webview instead of leaving a stale tile');
assert.match(probeSource, /new WebSocket\(await freshTreeWsUrl\(\)\)/,
  'the upload probe uses the same canonical authenticated tree origin');

console.log('tree auth lifecycle: ok');

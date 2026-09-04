import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./treeAuth.ts', import.meta.url), 'utf8');
const nativeSource = readFileSync(new URL('./native.ts', import.meta.url), 'utf8');
const treeSource = readFileSync(new URL('./transport/treeVideo.ts', import.meta.url), 'utf8');
const videoTransportSource = readFileSync(new URL('./transport/videoTransport.ts', import.meta.url), 'utf8');
const livekitSource = readFileSync(new URL('./transport/livekitVideo.ts', import.meta.url), 'utf8');
const serverViewSource = readFileSync(new URL('./components/ServerView.tsx', import.meta.url), 'utf8');
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
  'watch_parent', 'watch_negotiation', 'watch_track', 'watch_playback', 'watch_recovery',
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
assert.match(treeMethod('scheduleNativeWatchRetry'),
  /attempt >= NATIVE_WATCH_RECOVERY_MAX_ATTEMPTS[\s\S]*outcome: 'timed_out'[\s\S]*intended\.delete\(streamId\)[\s\S]*switchFailedCbs/,
  'native recovery has a terminal consecutive-failure budget even after initial playback');
assert.match(treeMethod('confirmPlayback'),
  /candidate !== currentVideo[\s\S]*currentVideo\.muted[\s\S]*return false[\s\S]*reWatchAttempts\.delete\(streamId\)[\s\S]*webReconnectAttempts\.delete\(streamId\)[\s\S]*clearVideoFailsafe\(streamId\)[\s\S]*return true/,
  'a retained DOM frame can reset recovery only for the exact current transport track');
assert.match(treeMethod('detach'),
  /watchRetryTimers\.forEach\(\(timer\) => clearTimeout\(timer\)\)[\s\S]*watchRetryTimers\.clear\(\)/,
  'transport teardown cancels every reconnect callback before releasing stream state');
const parentOffer = treeMethod('onParentOffer');
assert.match(parentOffer,
  /const ownsOffer = \(\) =>[\s\S]*st\.pc === pc[\s\S]*const scheduleDisconnectedRecovery[\s\S]*recoveryRequested \|\| st\.reparentTimer !== null \|\| !ownsOffer\(\)[\s\S]*st\.reparentTimer !== timer[\s\S]*!ownsOffer\(\)/,
  'one exact peer owns at most one delayed reparent request');
assert.match(parentOffer,
  /pc\.iceConnectionState !== 'disconnected' && pc\.iceConnectionState !== 'failed'[\s\S]*clearWatchReparentTimer\(st\)[\s\S]*pc\.connectionState !== 'disconnected' && pc\.connectionState !== 'failed'[\s\S]*clearWatchReparentTimer\(st\)/,
  'a recovered peer cancels its pending reparent deadline only after both state views are healthy');
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
assert.match(treeMethod('armParentOfferTimer'),
  /delayMs = BROWSER_PARENT_OFFER_TIMEOUT_MS[\s\S]*st\.parentId !== parentId[\s\S]*st\.parentGeneration !== parentGeneration[\s\S]*code: 'track_missing'[\s\S]*requestReparent\(streamId, null, 'track-missing', parentId\)[\s\S]*}, delayMs/,
  'a browser parent which never offers SDP gets one exact-generation track-missing recovery');
assert.match(treeMethod('armParentMediaTimer'),
  /st\.pc !== pc[\s\S]*st\.parentId !== parentId[\s\S]*st\.offerGeneration !== offerGeneration[\s\S]*code: 'decode_timeout'[\s\S]*watch_recovery[\s\S]*code: 'decode_timeout'[\s\S]*requestReparent\(streamId, null, 'track-missing', parentId\)[\s\S]*BROWSER_PARENT_MEDIA_TIMEOUT_MS/,
  'an offered browser stream which never decodes video reports its exact failed parent');
assert.match(treeMethod('onWatchMessage'),
  /case 'assign-parent':[\s\S]*armParentOfferTimer\(streamId, st\)[\s\S]*case 'sdp':[\s\S]*clearParentOfferTimer\(st\)/,
  'each browser parent assignment owns an offer watchdog which its exact SDP offer cancels');
assert.match(treeMethod('clearWatchStateTimers'), /parentOfferTimer[\s\S]*parentMediaTimer[\s\S]*reparentTimer/,
  'watch teardown cancels both parent watchdogs together with the other exact-state timers');
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
  /requestParentRecovery[\s\S]*watch_recovery[\s\S]*code[\s\S]*scheduleDisconnectedRecovery[\s\S]*onconnectionstatechange[\s\S]*requestParentRecovery\('ice_failed'\)[\s\S]*scheduleDisconnectedRecovery\(\)[\s\S]*oniceconnectionstatechange[\s\S]*requestParentRecovery\('ice_failed'\)[\s\S]*scheduleDisconnectedRecovery\(\)[\s\S]*watch_track[\s\S]*track_missing/,
  'browser watch diagnostics recover from aggregate or ICE-only failure without duplicate owners');
assert.match(treeMethod('onNativeOffer'),
  /onconnectionstatechange[\s\S]*oniceconnectionstatechange[\s\S]*watch_track[\s\S]*nativeWatchAnswer/,
  'native loopback diagnostics cover local peer state, first video and answer delivery');
assert.match(treeMethod('onNativeOffer'),
  /addEventListener\('ended', recoverEndedTrack[\s\S]*readyState === 'ended'[\s\S]*recoverEndedTrack\(\)[\s\S]*upsertTrack/,
  'an already-ended native video track is recovered before it can clear retry protection');
assert.match(treeMethod('armVideoFailsafe'), /watch_recovery[\s\S]*decode_timeout/,
  'a seamless recovery which never delivers a replacement frame is reported before its tile closes');
assert.match(livekitMethod('watch'), /watch_signaling[\s\S]*subscribeWatchSession/,
  'LiveKit selection reports its room and subscription path');
assert.match(livekitMethod('onSub'),
  /pub\.source !== Track\.Source\.ScreenShare[\s\S]*isExactWatchOwner[\s\S]*pub\.track !== track[\s\S]*candidateTrack = track[\s\S]*watch_track/,
  'LiveKit accepts only the exact current screen publication and waits for decoded playback');
assert.match(livekitMethod('confirmPlayback'),
  /candidate !== mediaTrack[\s\S]*isExactWatchOwner[\s\S]*remotePublicationByKey[\s\S]*cancelWatchRetry[\s\S]*watch_recovery[\s\S]*recovered/,
  'LiveKit replenishes its recovery budget only after the exact media track decodes');
assert.match(livekitMethod('acceptsScreenAudio'),
  /baseUid\(participant\.identity\) === streamId[\s\S]*publication\.source === Track\.Source\.ScreenShareAudio[\s\S]*owner\.participant === participant[\s\S]*isExactWatchOwner[\s\S]*getTrackPublication\(Track\.Source\.ScreenShareAudio\) === publication[\s\S]*publication\.track === candidate/,
  'LiveKit accepts screen audio only from the exact current watch owner, publication and track');
assert.match(livekitMethod('onRemoteUnpub'), /watch_track[\s\S]*beginWatchRecovery[\s\S]*subscribeWatchSession/,
  'LiveKit reports a lost selected publication before selecting its replacement');
assert.match(livekitMethod('onUnsub'), /watch_track[\s\S]*beginWatchRecovery\(username, 'track_missing'\)[\s\S]*subscribeWatchSession/,
  'an unexpected active LiveKit unsubscribe is diagnosed and re-subscribed');
assert.doesNotMatch(livekitMethod('scheduleWatchRetry'), /cancelWatchRetry/,
  'a repeated LiveKit unsubscribe cannot reset the bounded recovery budget');
assert.match(livekitMethod('scheduleWatchRetry'),
  /delay === undefined[\s\S]*setTimeout[\s\S]*isExactWatchOwner[\s\S]*exhaustWatchRecovery/,
  'the final LiveKit subscription attempt owns one bounded asynchronous delivery window');
assert.match(livekitMethod('exhaustWatchRecovery'),
  /outcome: 'timed_out'[\s\S]*switchFailedCbs\.forEach/,
  'an exhausted LiveKit recovery reports terminal failure so Engine can release its watch owner');
assert.match(livekitMethod('onSeamlessSwitchFailed'), /switchFailedCbs\.add\(cb\)[\s\S]*switchFailedCbs\.delete\(cb\)/,
  'LiveKit terminal recovery listeners have explicit subscription ownership');
assert.match(livekitMethod('armWatchDecodeTimer'),
  /state\.candidateTrack !== track[\s\S]*state\.publication\.track !== track[\s\S]*isExactWatchOwner[\s\S]*decode_timeout[\s\S]*scheduleWatchRetry/,
  'a subscribed-but-undecoded LiveKit track advances the same exact bounded recovery episode');
assert.match(serverViewSource,
  /exactLiveKitVideo[\s\S]*mediaStreamTrack[\s\S]*new MediaStream\(\[exactLiveKitVideo\]\)[\s\S]*ExactVideoTrackFrameObserver/,
  'the LiveKit tile observes frames against its exact media track');
assert.match(serverViewSource,
  /const finishDecoded = \(candidate\?: MediaStreamTrack\)[\s\S]*if \(candidate\) E\.confirmWatchPlayback/,
  'only the observer-provided decoded candidate can confirm LiveKit playback');
assert.doesNotMatch(serverViewSource, /attemptPlayback\(false, exactLiveKitVideo\)/,
  'retained element dimensions cannot reset LiveKit recovery from an ordinary play attempt');
assert.match(treeMethod('scheduleBrowserWatchStartRetry'),
  /code: StreamWatchTransportDiagnosticCode[\s\S]*watch_recovery[\s\S]*code, reconnectCount/,
  'browser auth and signaling retries preserve their causal code');
assert.match(treeMethod('scheduleNativeWatchRetry'),
  /code: StreamWatchTransportDiagnosticCode[\s\S]*watch_recovery[\s\S]*code, reconnectCount/,
  'native retries preserve their causal code');

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
const previousMediaStream = globalThis.MediaStream;
const previousMediaStreamVideoHandle = globalThis.MediaStreamVideoHandle;
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
    getReceivers() { return []; }
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

  const browserConstructorFailure = new TreeVideoTransport();
  const browserConstructorFailureDiagnostics = [];
  const browserConstructorFailureWatch = {
    ws: { send: () => {} },
    pc: null,
    parentId: 'constructor-parent',
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
    parentOfferTimer: null,
    parentMediaTimer: null,
    reparentTimer: null,
  };
  browserConstructorFailure.watches.set('constructor-failure', browserConstructorFailureWatch);
  browserConstructorFailure.onWatchDiagnostic((event) => browserConstructorFailureDiagnostics.push(event));
  globalThis.RTCPeerConnection = class {
    constructor() { throw new Error('transient resource exhaustion'); }
  };
  await browserConstructorFailure.onParentOffer('constructor-failure', browserConstructorFailureWatch, 'offer');
  assert.equal(browserConstructorFailureWatch.pc, null,
    'a failed WebKit peer construction cannot retain its already-closed predecessor');
  assert.equal(timers.get(browserConstructorFailureWatch.parentOfferTimer)?.delay, 12000,
    'a transient peer construction failure waits for the server no-media gate before retrying');
  assert.ok(browserConstructorFailureDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'started' && event.code === 'negotiation_failed'));
  browserConstructorFailure.teardownWatch('constructor-failure', browserConstructorFailureWatch);
  globalThis.RTCPeerConnection = FakePeerConnection;

  const noOfferRecovery = new TreeVideoTransport();
  const noOfferSent = [];
  const noOfferDiagnostics = [];
  const noOfferWatch = {
    ws: { send: (payload) => noOfferSent.push(JSON.parse(payload)) },
    pc: null,
    parentId: null,
    closed: false,
    iceServers: [],
    maxChildren: 0,
    joined: true,
    quality: 'source',
    pinned: false,
    pendingIce: [],
    parentGeneration: 0,
    offerGeneration: 0,
    joinFallbackTimer: null,
    parentOfferTimer: null,
    parentMediaTimer: null,
    reparentTimer: null,
  };
  noOfferRecovery.watches.set('no-offer', noOfferWatch);
  noOfferRecovery.onWatchDiagnostic((event) => noOfferDiagnostics.push(event));
  noOfferRecovery.onWatchMessage('no-offer', noOfferWatch, {
    data: JSON.stringify({ t: 'assign-parent', parentId: 'silent-parent-a' }),
  });
  const staleNoOfferTimer = noOfferWatch.parentOfferTimer;
  assert.equal(timers.get(staleNoOfferTimer)?.delay, 8000,
    'a browser parent gets the server-agreed bounded SDP offer deadline');
  noOfferRecovery.onWatchMessage('no-offer', noOfferWatch, {
    data: JSON.stringify({ t: 'assign-parent', parentId: 'silent-parent-b' }),
  });
  assert.equal(timers.has(staleNoOfferTimer), false,
    'a replacement parent physically cancels the previous no-offer owner');
  assert.equal(timers.size, 1);
  fire(noOfferWatch.parentOfferTimer);
  assert.deepEqual(noOfferSent, [{
    t: 'request-reparent', streamId: 'no-offer', targetParentId: null,
    reason: 'track-missing', failedParentId: 'silent-parent-b',
  }], 'the no-offer recovery names the exact failed parent and cannot report its replacement');
  assert.ok(noOfferDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'started' && event.code === 'track_missing'
    && event.reconnectCount === 1 && event.streamTransport === 'tree_web'),
  'the browser no-offer recovery reaches the bounded Engine diagnostic path');
  noOfferRecovery.onWatchMessage('no-offer', noOfferWatch, {
    data: JSON.stringify({ t: 'assign-parent', parentId: 'offering-parent' }),
  });
  assert.equal(timers.size, 1);
  noOfferRecovery.onWatchMessage('no-offer', noOfferWatch, {
    data: JSON.stringify({ t: 'sdp', from: 'offering-parent', type: 'offer', sdp: 'offering-sdp' }),
  });
  assert.equal(noOfferWatch.parentOfferTimer, null,
    'the exact parent offer cancels its signaling deadline before asynchronous negotiation');
  assert.equal(timers.get(noOfferWatch.parentMediaTimer)?.delay, 12000,
    'the exact parent offer replaces its signaling deadline with a decoded-frame deadline');
  await Promise.resolve();
  await Promise.resolve();
  const zeroRtpVideo = { kind: 'video', readyState: 'live', muted: true };
  noOfferRecovery.playbackCandidates.set('no-offer', zeroRtpVideo);
  noOfferRecovery.containers.set('no-offer', { getVideoTracks: () => [zeroRtpVideo] });
  assert.equal(noOfferRecovery.confirmPlayback('no-offer', zeroRtpVideo), false,
    'a static zero-RTP receiver cannot borrow the retained frame to confirm playback');
  fire(noOfferWatch.parentMediaTimer);
  assert.deepEqual(noOfferSent.at(-1), {
    t: 'request-reparent', streamId: 'no-offer', targetParentId: null,
    reason: 'track-missing', failedParentId: 'offering-parent',
  }, 'an audio-only/offered relay is reported only after its exact video decode deadline');
  assert.ok(noOfferDiagnostics.some((event) => event.stage === 'watch_playback'
    && event.outcome === 'stalled' && event.code === 'decode_timeout'
    && event.reconnectCount === 2),
  'the administrator can distinguish an SDP no-offer from an offered stream with no decoded frame');
  noOfferRecovery.playbackCandidates.set('no-offer', { kind: 'video', readyState: 'live', muted: false });
  noOfferRecovery.onWatchMessage('no-offer', noOfferWatch, {
    data: JSON.stringify({ t: 'assign-parent', parentId: 'replacement-parent' }),
  });
  assert.equal(noOfferRecovery.playbackCandidates.has('no-offer'), false,
    'a live track from the retired parent cannot confirm the replacement generation');
  assert.deepEqual([...timers.values()].map((task) => task.delay).sort((a, b) => a - b), [8000, 15000],
    'the exact-parent watchdog reports failure before the seamless frozen-tile failsafe');
  noOfferRecovery.teardownWatch('no-offer', noOfferWatch);

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
    parentOfferTimer: null,
    reparentTimer: null,
  };
  reparents.watches.set('stream', watch);
  await reparents.onParentOffer('stream', watch, 'offer');
  const peer = watch.pc;
  let endBrowserTrack = null;
  const browserTrack = {
    kind: 'video', readyState: 'live', muted: false,
    addEventListener(type, listener) { if (type === 'ended') endBrowserTrack = listener; },
  };
  const browserTracks = [];
  reparents.containers.set('stream', {
    getTracks: () => browserTracks,
    getVideoTracks: () => browserTracks.filter((track) => track.kind === 'video'),
    addTrack: (track) => browserTracks.push(track),
    removeTrack: (track) => { const index = browserTracks.indexOf(track); if (index >= 0) browserTracks.splice(index, 1); },
  });
  reparents.videoTracks.set('stream', {});
  peer.ontrack({ track: browserTrack });
  assert.equal(reparents.confirmPlayback('stream', { kind: 'video', readyState: 'live', muted: false }), false,
    'a late frame callback owned by the retired track cannot confirm its replacement');
  assert.notEqual(watch.parentMediaTimer, null,
    'rejecting a stale track keeps the replacement decoded-frame deadline armed');
  assert.equal(reparents.confirmPlayback('stream', browserTrack), true);
  assert.equal(watch.parentMediaTimer, null,
    'the first current-parent frame clears its initial media deadline');
  browserTrack.readyState = 'ended';
  endBrowserTrack();
  assert.equal(reparents.playbackCandidates.has('stream'), false,
    'an ended browser track immediately loses playback-confirmation authority');
  assert.equal(timers.get(watch.parentMediaTimer)?.delay, 12000,
    'an ended browser track re-arms exact-parent media recovery');
  assert.equal([...timers.values()].some((task) => task.delay === 15000), true,
    'an ended browser track has a bounded retained-frame failsafe');
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  peer.onconnectionstatechange();
  assert.equal([...timers.values()].filter((task) => task.delay === 5000).length, 1,
    'repeated disconnected notifications share one exact-peer reparent timeout');
  peer.connectionState = 'connected';
  peer.onconnectionstatechange();
  assert.equal([...timers.values()].filter((task) => task.delay === 5000).length, 0,
    'connection recovery physically cancels its delayed reparent');
  peer.connectionState = 'disconnected';
  peer.onconnectionstatechange();
  const disconnectedTimer = [...timers.entries()].find(([, task]) => task.delay === 5000)?.[0];
  fire(disconnectedTimer);
  assert.equal(sent.filter((message) => message.t === 'request-reparent').length, 1,
    'a sustained disconnect emits one reparent request');
  peer.onconnectionstatechange();
  assert.equal([...timers.values()].filter((task) => task.delay === 5000).length, 0,
    'a committed recovery cannot arm another disconnected deadline for the same peer');
  reparents.teardownWatch('stream', watch);
  assert.equal(timers.size, 0,
    'retiring the watch physically cancels its pending reparent timeout');

  const iceOnly = new TreeVideoTransport();
  const iceOnlySent = [];
  const iceOnlyWatch = {
    ...watch,
    ws: { send: (payload) => iceOnlySent.push(JSON.parse(payload)) },
    pc: null,
    parentId: 'ice-parent',
    closed: false,
    pendingIce: [],
    parentGeneration: 1,
    offerGeneration: 0,
    joinFallbackTimer: null,
    parentOfferTimer: null,
    parentMediaTimer: null,
    reparentTimer: null,
  };
  iceOnly.watches.set('ice-only', iceOnlyWatch);
  await iceOnly.onParentOffer('ice-only', iceOnlyWatch, 'offer');
  const icePeer = iceOnlyWatch.pc;
  icePeer.connectionState = 'connected';
  icePeer.iceConnectionState = 'disconnected';
  icePeer.oniceconnectionstatechange();
  const iceDisconnectedTimer = [...timers.entries()].find(([, task]) => task.delay === 5000)?.[0];
  assert.notEqual(iceDisconnectedTimer, undefined,
    'an ICE-only disconnected edge gets the same bounded recovery deadline');
  fire(iceDisconnectedTimer);
  assert.equal(iceOnlySent.filter((message) => message.t === 'request-reparent').length, 1,
    'sustained ICE-only failure requests exactly one replacement parent');
  icePeer.oniceconnectionstatechange();
  assert.equal([...timers.values()].filter((task) => task.delay === 5000).length, 0,
    'the committed ICE recovery cannot create a second timer for the same peer');
  iceOnly.teardownWatch('ice-only', iceOnlyWatch);
  assert.equal(timers.size, 0);

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
  overlap.teardownWatch('overlap', overlappingWatch, true);
  assert.equal(timers.size, 0,
    'retiring overlapping offers also cancels the current decoded-frame deadline');

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

  class FakeMediaStream {
    tracks = [];
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter((candidate) => candidate !== track); }
  }
  globalThis.MediaStream = FakeMediaStream;
  globalThis.MediaStreamVideoHandle = class {
    constructor(stream) { this.stream = stream; }
  };
  const audioFirstStarts = [];
  const audioFirstStartWaiters = [];
  const audioFirstStops = [];
  globalThis.onNativeWatchOffer = async () => () => {};
  globalThis.onNativeWatchIce = async () => () => {};
  globalThis.onNativeTopology = async () => () => {};
  globalThis.onNativeWatchEnded = async () => () => {};
  globalThis.onNativeWatchStatus = async () => () => {};
  globalThis.startNativeWatch = async (...args) => {
    audioFirstStarts.push(args);
    audioFirstStartWaiters.shift()?.();
  };
  globalThis.stopNativeWatch = async (...args) => { audioFirstStops.push(args); };
  const waitForAudioFirstStart = () => new Promise((resolve) => audioFirstStartWaiters.push(resolve));
  const audioFirstRecovery = new TreeVideoTransport();
  const audioFirstDiagnostics = [];
  audioFirstRecovery.onWatchDiagnostic((event) => audioFirstDiagnostics.push(event));
  audioFirstRecovery.liveStreams.set('audio-first-recovery', {});
  const firstNativeStart = waitForAudioFirstStart();
  audioFirstRecovery.watch('audio-first-recovery');
  await firstNativeStart;
  const firstAudioFirstState = audioFirstRecovery.nativeWatches.get('audio-first-recovery');
  assert.ok(firstAudioFirstState);
  await audioFirstRecovery.onNativeOffer('audio-first-recovery', firstAudioFirstState, 'first-offer');
  firstAudioFirstState.pc.connectionState = 'failed';
  firstAudioFirstState.pc.onconnectionstatechange();
  assert.equal(audioFirstRecovery.reWatchAttempts.get('audio-first-recovery'), 1);
  const firstAudioFirstRetry = audioFirstRecovery.watchRetryTimers.get('audio-first-recovery');
  assert.equal(timers.get(firstAudioFirstRetry)?.delay, 1500,
    'the first native negotiation failure uses the initial recovery delay');

  const secondNativeStart = waitForAudioFirstStart();
  fire(firstAudioFirstRetry);
  await secondNativeStart;
  const secondAudioFirstState = audioFirstRecovery.nativeWatches.get('audio-first-recovery');
  assert.ok(secondAudioFirstState);
  await audioFirstRecovery.onNativeOffer('audio-first-recovery', secondAudioFirstState, 'second-offer');
  secondAudioFirstState.pc.ontrack({ track: { kind: 'audio' } });
  assert.equal(audioFirstRecovery.reWatchAttempts.get('audio-first-recovery'), 1,
    'audio arriving before video does not erase the failed native recovery attempt');
  secondAudioFirstState.pc.connectionState = 'failed';
  secondAudioFirstState.pc.onconnectionstatechange();
  assert.equal(audioFirstRecovery.reWatchAttempts.get('audio-first-recovery'), 2,
    'a repeated failure after audio-first negotiation advances the reconnect count');
  const secondAudioFirstRetry = audioFirstRecovery.watchRetryTimers.get('audio-first-recovery');
  assert.equal(timers.get(secondAudioFirstRetry)?.delay, 3000,
    'audio-first negotiation preserves exponential backoff for the next native retry');
  assert.deepEqual(audioFirstDiagnostics.filter((event) => event.stage === 'watch_recovery'
    && event.outcome === 'started').map((event) => event.reconnectCount), [1, 2]);
  assert.equal(audioFirstStarts.length, 2);
  assert.equal(audioFirstStops.length, 2);
  audioFirstRecovery.unwatch('audio-first-recovery');
  assert.equal(timers.size, 0);

  const endedStops = [];
  globalThis.stopNativeWatch = async (...args) => { endedStops.push(args); };
  const endedRecovery = new TreeVideoTransport();
  const endedRecoveryDiagnostics = [];
  endedRecovery.onWatchDiagnostic((event) => endedRecoveryDiagnostics.push(event));
  const endedState = seedNativeAttempt(endedRecovery, 'ended-recovery', 807);
  const makeVideoTrack = (readyState = 'live') => {
    let endedListener = null;
    return {
      kind: 'video',
      readyState,
      addEventListener(type, listener) {
        if (type === 'ended') endedListener = listener;
      },
      end() {
        this.readyState = 'ended';
        endedListener?.();
      },
    };
  };
  await endedRecovery.onNativeOffer('ended-recovery', endedState, 'ended-offer-a');
  const replacedPeer = endedState.pc;
  const replacedTrack = makeVideoTrack();
  replacedPeer.ontrack({ track: replacedTrack });
  await endedRecovery.onNativeOffer('ended-recovery', endedState, 'ended-offer-b');
  const currentPeer = endedState.pc;
  replacedTrack.end();
  assert.equal(endedRecovery.nativeWatches.get('ended-recovery'), endedState,
    'a video track ending naturally on a replaced peer cannot retire its exact-owner successor');
  assert.equal(endedRecovery.watchRetryTimers.has('ended-recovery'), false);
  assert.deepEqual(endedStops, []);

  const currentTrack = makeVideoTrack();
  endedRecovery.reWatchAttempts.set('ended-recovery', 2);
  const retainedFailsafe = globalThis.window.setTimeout(() => {}, 15_000);
  endedRecovery.videoFailsafe.set('ended-recovery', retainedFailsafe);
  currentPeer.ontrack({ track: currentTrack });
  assert.equal(endedRecovery.reWatchAttempts.get('ended-recovery'), 2,
    'ontrack alone cannot erase consecutive recovery history before a decoded frame');
  assert.equal(endedRecovery.videoFailsafe.has('ended-recovery'), true,
    'a merely attached track cannot disarm the retained-frame deadline');
  endedRecovery.confirmPlayback('ended-recovery', currentTrack);
  assert.equal(endedRecovery.reWatchAttempts.has('ended-recovery'), false,
    'a decoded frame replenishes the native recovery budget');
  assert.equal(endedRecovery.videoFailsafe.has('ended-recovery'), false,
    'a decoded frame disarms the exact retained-frame deadline');
  currentTrack.end();
  assert.equal(endedState.closed, true,
    'an ended video track retires the current native watch owner');
  assert.equal(endedRecovery.nativeWatches.has('ended-recovery'), false);
  assert.equal(endedRecovery.reWatchAttempts.get('ended-recovery'), 1);
  const endedRetry = endedRecovery.watchRetryTimers.get('ended-recovery');
  assert.equal(timers.get(endedRetry)?.delay, 1500,
    'an ended current native video track starts bounded recovery without waiting for decode timeout');
  assert.deepEqual(endedStops, [['ended-recovery', 807]]);
  assert.equal(endedRecovery.playbackCandidates.has('ended-recovery'), false,
    'retiring the native owner invalidates its retained live-looking playback candidate');
  endedRecovery.confirmPlayback('ended-recovery', currentTrack);
  assert.equal(endedRecovery.reWatchAttempts.get('ended-recovery'), 1,
    'a stale media-element callback cannot reset recovery after its exact video track ended');
  currentTrack.end();
  assert.equal(endedRecovery.reWatchAttempts.get('ended-recovery'), 1,
    'a repeated ended callback from the retired owner cannot schedule a duplicate recovery');
  assert.deepEqual(endedStops, [['ended-recovery', 807]]);

  endedRecovery.clearWatchRetry('ended-recovery');
  const secondEndedState = seedNativeAttempt(endedRecovery, 'ended-recovery', 808);
  await endedRecovery.onNativeOffer('ended-recovery', secondEndedState, 'ended-offer-c');
  const secondEndedTrack = makeVideoTrack();
  secondEndedState.pc.ontrack({ track: secondEndedTrack });
  secondEndedTrack.end();
  assert.equal(endedRecovery.reWatchAttempts.get('ended-recovery'), 2);
  const secondEndedRetry = endedRecovery.watchRetryTimers.get('ended-recovery');
  assert.equal(timers.get(secondEndedRetry)?.delay, 3000,
    'a second pre-decode ended track advances native recovery backoff');

  endedRecovery.clearWatchRetry('ended-recovery');
  const thirdEndedState = seedNativeAttempt(endedRecovery, 'ended-recovery', 809);
  await endedRecovery.onNativeOffer('ended-recovery', thirdEndedState, 'ended-offer-d');
  const thirdEndedTrack = makeVideoTrack();
  thirdEndedState.pc.ontrack({ track: thirdEndedTrack });
  thirdEndedTrack.end();
  assert.equal(endedRecovery.reWatchAttempts.get('ended-recovery'), 3);
  const thirdEndedRetry = endedRecovery.watchRetryTimers.get('ended-recovery');
  assert.equal(timers.get(thirdEndedRetry)?.delay, 6000,
    'a third pre-decode ended track receives the final bounded retry');

  endedRecovery.clearWatchRetry('ended-recovery');
  const exhaustedEndedState = seedNativeAttempt(endedRecovery, 'ended-recovery', 810);
  await endedRecovery.onNativeOffer('ended-recovery', exhaustedEndedState, 'ended-offer-e');
  const exhaustedEndedTrack = makeVideoTrack();
  exhaustedEndedState.pc.ontrack({ track: exhaustedEndedTrack });
  exhaustedEndedTrack.end();
  assert.equal(endedRecovery.watchRetryTimers.has('ended-recovery'), false,
    'the exhausted recovery budget cannot create a fourth native retry');
  assert.equal(endedRecovery.intended.has('ended-recovery'), false,
    'terminal recovery removes the transport watch intent');
  assert.ok(endedRecoveryDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'timed_out' && event.code === 'track_missing'
    && event.reconnectCount === 3),
  'terminal ended-track recovery is diagnosable with its exact bounded count');
  endedRecovery.unwatch('ended-recovery');
  assert.equal(timers.size, 0);

  const immediateEnded = new TreeVideoTransport();
  const immediateEndedState = seedNativeAttempt(immediateEnded, 'already-ended', 811);
  await immediateEnded.onNativeOffer('already-ended', immediateEndedState, 'already-ended-offer');
  immediateEndedState.pc.ontrack({ track: makeVideoTrack('ended') });
  assert.equal(immediateEnded.nativeWatches.has('already-ended'), false,
    'a video track already ended at ontrack retires its exact native owner immediately');
  assert.equal(immediateEnded.videoTracks.has('already-ended'), false,
    'an already-ended video track never becomes the visible stream handle');
  assert.equal(timers.get(immediateEnded.watchRetryTimers.get('already-ended'))?.delay, 1500);
  immediateEnded.unwatch('already-ended');
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
  if (previousMediaStream === undefined) delete globalThis.MediaStream;
  else globalThis.MediaStream = previousMediaStream;
  if (previousMediaStreamVideoHandle === undefined) delete globalThis.MediaStreamVideoHandle;
  else globalThis.MediaStreamVideoHandle = previousMediaStreamVideoHandle;
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
const previousLivekitWindowSetTimeout = globalThis.window.setTimeout;
const previousLivekitWindowClearTimeout = globalThis.window.clearTimeout;
try {
  let nextLivekitTimer = 0;
  const livekitTimers = new Map();
  globalThis.window.setTimeout = (callback, delay) => {
    const id = ++nextLivekitTimer;
    livekitTimers.set(id, { callback, delay });
    return id;
  };
  globalThis.window.clearTimeout = (id) => { livekitTimers.delete(Number(id)); };
  const fireLivekitTimer = (id) => {
    const task = livekitTimers.get(id);
    assert.ok(task, `LiveKit timer ${id} must still be owned`);
    livekitTimers.delete(id);
    task.callback();
  };
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
  const publication = (trackSid, source = 'screen') => ({
    source, trackSid, track: null,
    setSubscribed: (value) => subscriptionCalls.push([trackSid, value]),
  });
  const videoPublication = publication('video-one');
  const audioPublication = publication('audio-one', 'screen-audio');
  const participant = {
    identity: 'local-watch-key:session-one',
    screenPublication: videoPublication,
    audioPublication,
    getTrackPublication(source) {
      return source === 'screen' ? this.screenPublication
        : source === 'screen-audio' ? this.audioPublication : undefined;
    },
  };
  const remoteParticipants = new Map([[participant.identity, participant]]);
  const livekit = new LiveKitVideoTransport();
  livekit.room = { remoteParticipants };
  const livekitDiagnostics = [];
  const livekitVideoTracks = [];
  const livekitTerminalFailures = [];
  livekit.onWatchDiagnostic((event) => livekitDiagnostics.push(event));
  livekit.onVideoTrack((key, track, identity) => livekitVideoTracks.push({ key, track, identity }));
  livekit.onSeamlessSwitchFailed((identity) => {
    livekitTerminalFailures.push(identity);
    // Mirrors Engine's terminal callback: the broadcaster remains discoverable, while the failed
    // logical watch is fully released so a later explicit click can start a new generation.
    livekit.unwatch(identity);
  });
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

  const firstMediaTrack = { readyState: 'live', muted: false };
  const firstTrack = {
    kind: 'video', mediaStreamTrack: firstMediaTrack, detach: () => [],
  };
  videoPublication.track = firstTrack;
  livekit.onSub(firstTrack, videoPublication, participant);
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_track'
    && event.outcome === 'ok' && event.trackState === 'live'));
  assert.equal(livekit.confirmPlayback('local-watch-key', firstMediaTrack), true,
    'the exact first decoded LiveKit track confirms the initial watch');

  remoteParticipants.delete(participant.identity);
  livekit.onRemoteUnpub(videoPublication, participant);
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'started' && event.reconnectCount === 1));

  const replacementPublication = publication('video-two');
  const replacement = {
    identity: 'local-watch-key:session-two',
    screenPublication: replacementPublication,
    audioPublication: undefined,
    getTrackPublication(source) {
      return source === 'screen' ? this.screenPublication
        : source === 'screen-audio' ? this.audioPublication : undefined;
    },
  };
  remoteParticipants.set(replacement.identity, replacement);
  livekit.onRemotePub(replacementPublication, replacement);
  const replacementMediaTrack = { readyState: 'live', muted: false };
  const replacementTrack = {
    kind: 'video', mediaStreamTrack: replacementMediaTrack, detach: () => [],
  };
  replacementPublication.track = replacementTrack;
  livekit.onSub(replacementTrack, replacementPublication, replacement);
  assert.equal(livekitDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'recovered'), false,
  'TrackSubscribed alone cannot report a recovered stream before a decoded frame');
  assert.equal(livekit.confirmPlayback('local-watch-key', firstMediaTrack), false,
    'a decoded callback from the retired LiveKit session cannot confirm its replacement');
  assert.equal(livekit.confirmPlayback('local-watch-key', replacementMediaTrack), true,
    'the exact replacement decoded frame closes the structured recovery sequence');
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_recovery'
    && event.outcome === 'recovered' && event.reconnectCount === 1));
  const acceptedTrackCount = livekitVideoTracks.length;
  livekit.onSub(firstTrack, videoPublication, participant);
  assert.equal(livekitVideoTracks.length, acceptedTrackCount,
    'a late subscribed track from the retired LiveKit session never reaches Engine');
  assert.equal(subscriptionCalls.at(-1)?.[1], false,
    'a late subscribed track from the retired LiveKit session is unsubscribed again');

  const callsBeforeUnexpectedUnsub = subscriptionCalls.length;
  livekit.onUnsub(replacementTrack, replacementPublication, replacement);
  assert.equal(subscriptionCalls.length, callsBeforeUnexpectedUnsub,
    'an unexpected LiveKit unsubscribe does not synchronously recurse into setSubscribed');
  const retryState = livekit.watchRetryStates.get('local-watch-key');
  assert.equal(livekitTimers.get(retryState?.timer)?.delay, 250,
    'the exact publication receives one queued bounded resubscribe owner');
  fireLivekitTimer(retryState.timer);
  assert.deepEqual(subscriptionCalls.slice(-1), [['video-two', true]],
    'the first bounded retry re-subscribes the current exact publication');
  assert.equal([...livekitTimers.values()].some(({ delay }) => delay === 1000), true,
    'a missing TrackSubscribed edge schedules only the next bounded retry');
  replacementPublication.track = replacementTrack;
  livekit.onSub(replacementTrack, replacementPublication, replacement);
  assert.equal(livekit.watchRetryStates.get('local-watch-key')?.attempts, 1,
    'TrackSubscribed retains the consumed recovery budget until a decoded frame');
  assert.equal(livekitTimers.get(livekit.watchRetryStates.get('local-watch-key')?.timer)?.delay, 4000,
    'a subscribed recovery track owns one bounded decoded-frame deadline');
  assert.equal(livekitDiagnostics.filter((event) => event.stage === 'watch_recovery'
    && event.outcome === 'recovered').length, 1,
  'a subscribed-but-not-decoded track does not emit another recovered event');

  livekit.onUnsub(replacementTrack, replacementPublication, replacement);
  const secondRetry = livekit.watchRetryStates.get('local-watch-key');
  assert.equal(livekitTimers.get(secondRetry?.timer)?.delay, 1000,
    'Sub→Unsub resumes at the second delay instead of resetting to 250 ms');
  fireLivekitTimer(secondRetry.timer);
  assert.equal(secondRetry.attempts, 2);
  const secondMediaTrack = { readyState: 'live', muted: false };
  const secondTrack = { kind: 'video', mediaStreamTrack: secondMediaTrack, detach: () => [] };
  replacementPublication.track = secondTrack;
  livekit.onSub(secondTrack, replacementPublication, replacement);
  const noDecodeTimer = livekit.watchRetryStates.get('local-watch-key')?.timer;
  assert.equal(livekitTimers.get(noDecodeTimer)?.delay, 4000);
  fireLivekitTimer(noDecodeTimer);
  const thirdRetry = livekit.watchRetryStates.get('local-watch-key');
  assert.equal(livekitTimers.get(thirdRetry?.timer)?.delay, 2500);
  assert.ok(livekitDiagnostics.some((event) => event.stage === 'watch_playback'
    && event.outcome === 'stalled' && event.code === 'decode_timeout'),
  'a TrackSubscribed event without a decoded confirmation continues bounded recovery');
  fireLivekitTimer(thirdRetry.timer);
  assert.equal(thirdRetry.attempts, 3);
  assert.equal(thirdRetry.exhausted, false);
  assert.equal(livekitTimers.get(thirdRetry.timer)?.delay, 4000,
    'the last physical resubscribe gets a bounded window for asynchronous TrackSubscribed delivery');
  assert.deepEqual(livekitTerminalFailures, []);

  const oldAudioTrack = { kind: 'audio', detach: () => [] };
  audioPublication.track = oldAudioTrack;
  const replacementAudioPublication = publication('audio-two', 'screen-audio');
  const replacementAudioTrack = { kind: 'audio', detach: () => [] };
  replacementAudioPublication.track = replacementAudioTrack;
  replacement.audioPublication = replacementAudioPublication;
  assert.equal(livekit.acceptsScreenAudio(
    'local-watch-key', participant, audioPublication, oldAudioTrack,
  ), false, 'a late screen-audio track from the retired same-username session is rejected');
  assert.equal(livekit.acceptsScreenAudio(
    'local-watch-key', replacement, replacementAudioPublication,
  ), true, 'the exact replacement watch owner may attach its current screen-audio publication');
  assert.equal(livekit.acceptsScreenAudio(
    'local-watch-key', replacement, replacementAudioPublication, replacementAudioTrack,
  ), true, 'the exact replacement screen-audio track passes the full ownership fence');
  assert.equal(livekit.acceptsScreenAudio(
    'local-watch-key', replacement, replacementAudioPublication, oldAudioTrack,
  ), false, 'an old track callback cannot impersonate the current screen-audio publication');

  fireLivekitTimer(thirdRetry.timer);
  assert.equal(thirdRetry.exhausted, true);
  assert.equal(thirdRetry.timer, null);
  assert.deepEqual(livekitTerminalFailures, ['local-watch-key']);
  assert.equal(livekit.watchRetryStates.has('local-watch-key'), false,
    'terminal recovery callback releases the exact retry owner');
  assert.equal(livekit.watchedUsers.has('local-watch-key'), false,
    'terminal recovery callback releases the logical watch guard');
  assert.equal(livekit.acceptsScreenAudio(
    'local-watch-key', replacement, replacementAudioPublication, replacementAudioTrack,
  ), false, 'terminal unwatch invalidates even the formerly exact screen-audio owner');
  assert.ok(subscriptionCalls.some(([trackSid, subscribed]) => (
    trackSid === 'audio-two' && subscribed === false
  )), 'terminal unwatch unsubscribes the exact current screen-audio publication');
  const timedOutCount = livekitDiagnostics.filter((event) => event.stage === 'watch_recovery'
    && event.outcome === 'timed_out').length;
  livekit.onUnsub(secondTrack, replacementPublication, replacement);
  assert.equal(livekitTimers.size, 0,
    'a duplicate unsubscribe cannot restart an exhausted recovery episode');
  assert.equal(livekitDiagnostics.filter((event) => event.stage === 'watch_recovery'
    && event.outcome === 'timed_out').length, timedOutCount,
  'an exhausted recovery episode reports its timeout exactly once');

  const lateMediaTrack = { readyState: 'live', muted: false };
  const lateTrack = { kind: 'video', mediaStreamTrack: lateMediaTrack, detach: () => [] };
  const subscribeCountBeforeRewatch = subscriptionCalls.length;
  livekit.watch('local-watch-key');
  assert.equal(livekit.watchedUsers.has('local-watch-key'), true);
  assert.ok(subscriptionCalls.length > subscribeCountBeforeRewatch,
    'an explicit click after terminal exhaustion starts a fresh physical subscription');
  replacementPublication.track = lateTrack;
  livekit.onSub(lateTrack, replacementPublication, replacement);
  assert.equal(livekit.confirmPlayback('local-watch-key', lateMediaTrack), true,
    'the exact decoded frame confirms the new explicit watch generation');
  assert.equal(livekit.watchRetryStates.has('local-watch-key'), false);
  livekit.onUnsub(lateTrack, replacementPublication, replacement);
  assert.equal(livekitTimers.get(livekit.watchRetryStates.get('local-watch-key')?.timer)?.delay, 250,
    'after an exact decoded recovery, a later genuine outage receives a fresh bounded budget');

  const acceptedBeforeEnded = livekitVideoTracks.length;
  const endedTrack = {
    kind: 'video', mediaStreamTrack: { readyState: 'ended', muted: true }, detach: () => [],
  };
  replacementPublication.track = endedTrack;
  livekit.onSub(endedTrack, replacementPublication, replacement);
  assert.equal(livekitVideoTracks.length, acceptedBeforeEnded,
    'an already-ended LiveKit track cannot reach Engine or confirm recovery');
  assert.equal([...livekitTimers.values()].some(({ delay }) => delay === 250), true,
    'an already-ended current publication joins the existing bounded recovery path');
  const retiredRetryCallback = livekitTimers.get(
    livekit.watchRetryStates.get('local-watch-key')?.timer,
  )?.callback;
  livekit.unwatch('local-watch-key');
  assert.equal(livekitTimers.size, 0,
    'explicit unwatch cancels every queued LiveKit resubscribe before SDK unsubscribe callbacks');
  const callsAfterUnwatch = subscriptionCalls.length;
  retiredRetryCallback?.();
  assert.equal(subscriptionCalls.length, callsAfterUnwatch,
    'a physically late timer callback cannot resubscribe after unwatch');

  let lateDetachCount = 0;
  const discoveryPublication = publication('discovery-video');
  const discoveryParticipant = {
    identity: 'unwatched-user:session-one',
    getTrackPublication: () => discoveryPublication,
  };
  remoteParticipants.set(discoveryParticipant.identity, discoveryParticipant);
  const discoveryTrack = {
    kind: 'video', mediaStreamTrack: { readyState: 'live', muted: false },
    detach: () => { lateDetachCount += 1; return []; },
  };
  discoveryPublication.track = discoveryTrack;
  const beforeUnwatched = livekitVideoTracks.length;
  livekit.onSub(discoveryTrack, discoveryPublication, discoveryParticipant);
  assert.equal(livekitVideoTracks.length, beforeUnwatched,
    'a late ScreenShare subscription after unwatch never resurrects a tile');
  assert.equal(lateDetachCount, 1);
  assert.deepEqual(subscriptionCalls.at(-1), ['discovery-video', false]);

  const cameraPublication = publication('camera-video', 'camera');
  const cameraTrack = {
    kind: 'video', mediaStreamTrack: { readyState: 'live', muted: false }, detach: () => [],
  };
  cameraPublication.track = cameraTrack;
  const callsBeforeCamera = subscriptionCalls.length;
  livekit.onSub(cameraTrack, cameraPublication, discoveryParticipant);
  assert.equal(livekitVideoTracks.length, beforeUnwatched,
    'a camera track cannot enter the screen-share registry');
  assert.equal(subscriptionCalls.length, callsBeforeCamera,
    'screen transport does not mutate an unrelated camera subscription');

  const republishCalls = [];
  const republishA = {
    source: 'screen', trackSid: 'same-track-sid', track: null,
    setSubscribed: (value) => republishCalls.push(['a', value]),
  };
  const republishB = {
    source: 'screen', trackSid: 'same-track-sid', track: null,
    setSubscribed: (value) => republishCalls.push(['b', value]),
  };
  const republisher = {
    identity: 'republisher:one', screenPublication: republishA,
    getTrackPublication(source) { return source === 'screen' ? this.screenPublication : undefined; },
  };
  const republishRoom = { remoteParticipants: new Map([[republisher.identity, republisher]]) };
  const republish = new LiveKitVideoTransport();
  republish.room = republishRoom;
  const republishDiagnostics = [];
  const republishStops = [];
  republish.onWatchDiagnostic((event) => republishDiagnostics.push(event));
  republish.onStreamStop((identity) => republishStops.push(identity));
  republish.watch('republisher');
  const mediaA = { readyState: 'live', muted: false };
  const trackA = { kind: 'video', mediaStreamTrack: mediaA, detach: () => [] };
  republishA.track = trackA;
  republish.onSub(trackA, republishA, republisher);
  assert.equal(republish.confirmPlayback('republisher', mediaA), true);
  republisher.screenPublication = republishB;
  republish.onRemotePub(republishB, republisher);
  const mediaB = { readyState: 'live', muted: false };
  const trackB = { kind: 'video', mediaStreamTrack: mediaB, detach: () => [] };
  republishB.track = trackB;
  republish.onSub(trackB, republishB, republisher);
  const recoveryCountBeforeStale = republishDiagnostics.filter((event) => event.stage === 'watch_recovery').length;
  republish.onUnsub(trackA, republishA, republisher);
  republish.onRemoteUnpub(republishA, republisher);
  assert.equal(republish.getVideoTrack('same-track-sid'), trackB,
    'late events from an old same-SID publication cannot delete the replacement tile');
  assert.equal(republishDiagnostics.filter((event) => event.stage === 'watch_recovery').length,
    recoveryCountBeforeStale, 'same-participant republish does not manufacture recovery');
  assert.deepEqual(republishStops, [],
    'old Unpublished cannot announce stream stop while the same participant still shares');
  assert.equal(republishCalls.some(([owner, value]) => owner === 'b' && value === false), false,
    'old publication cleanup never unsubscribes the exact current replacement');
  const mediaB2 = { readyState: 'live', muted: false };
  const trackB2 = { kind: 'video', mediaStreamTrack: mediaB2, detach: () => [] };
  republishB.track = trackB2;
  republish.onSub(trackB2, republishB, republisher);
  const callsBeforeOldTrack = republishCalls.length;
  republish.onSub(trackB, republishB, republisher);
  assert.equal(republishCalls.length, callsBeforeOldTrack,
    'a late old-track callback on the current publication cannot unsubscribe its replacement');
  assert.equal(republish.getVideoTrack('same-track-sid'), trackB2,
    'a late old-track callback cannot delete the current same-publication track');
  assert.equal(republish.confirmPlayback('republisher', mediaA), false);
  assert.equal(republish.confirmPlayback('republisher', mediaB), false);
  assert.equal(republish.confirmPlayback('republisher', mediaB2), true);
  republish.unwatch('republisher');
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
  if (previousLivekitWindowSetTimeout === undefined) delete globalThis.window.setTimeout;
  else globalThis.window.setTimeout = previousLivekitWindowSetTimeout;
  if (previousLivekitWindowClearTimeout === undefined) delete globalThis.window.clearTimeout;
  else globalThis.window.clearTimeout = previousLivekitWindowClearTimeout;
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

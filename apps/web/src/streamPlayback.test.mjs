import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const normalizeSource = (value) => value.replace(/\r\n?/gu, '\n');
const readSource = (...segments) => normalizeSource(readFileSync(join(here, ...segments), 'utf8'));
assert.equal(normalizeSource('windows\r\nlegacy-mac\r'), 'windows\nlegacy-mac\n',
  'source-contract checks normalize platform line endings');
const source = readSource('streamPlayback.ts');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  ExactAsyncActionCoordinator,
  ExactMediaOutputRouteGate,
  ExactMediaPlayCoordinator,
  StreamWatchPlaybackGate,
  TreeStreamAudioController,
  applyExactScreenAudioGain,
  audioSinkRoutesConfirmed,
  effectiveStreamGain,
  isAutoplayBlocked,
  mediaElementVolumeLocked,
  playMediaElement,
  playMediaElementCoordinated,
  exactWebAudioMixContext,
  rebindExactWebAudioMixContexts,
  routeAudioSinkTarget,
  seedAudioSinkTargetRoute,
  setTreeStreamOutputSink,
  toggleStreamFullscreen,
  toggleStreamPictureInPicture,
} = await import('data:text/javascript,' + encodeURIComponent(js));

assert.equal(effectiveStreamGain(50, 0.4), 0.2);
assert.equal(effectiveStreamGain(100, 1, true), 0);
assert.equal(effectiveStreamGain(150, 2), 1);
assert.equal(effectiveStreamGain(Number.NaN, Number.NaN), 1);
assert.equal(audioSinkRoutesConfirmed('default', ['applied', 'unsupported']), true,
  'a setSinkId-less path already confirms the logical system default');
assert.equal(audioSinkRoutesConfirmed('default', ['applied', 'failed']), false,
  'a failed default write cannot be cached as the physical route');
assert.equal(audioSinkRoutesConfirmed('default', ['timed-out', 'applied']), false,
  'an uncertain timed-out default write remains retryable');
assert.equal(audioSinkRoutesConfirmed('speaker-a', ['applied', 'unsupported']), false,
  'unsupported cannot confirm a custom hardware route');
assert.equal(audioSinkRoutesConfirmed('default', ['applied', 'superseded']), false,
  'a superseded nested operation never confirms the aggregate route');

{
  const routes = new ExactMediaOutputRouteGate();
  const element = {};
  assert.equal(routes.claim(element, 'speaker'), true);
  for (let tick = 0; tick < 100; tick++) assert.equal(routes.claim(element, 'speaker'), false);
  assert.equal(routes.claim(element, 'speaker', true), true,
    'an explicit device/foreground recovery can retry the same route once');
  assert.equal(routes.claim(element, 'headphones'), true,
    'a real output selection supersedes the coalesced route');
  routes.forget(element);
  assert.equal(routes.claim(element, 'headphones'), true,
    'a replacement media element owns a fresh route generation');
}

{
  const closedA = { state: 'closed' };
  const closedB = { state: 'closed' };
  const replacement = { state: 'suspended' };
  const first = { options: { webAudioMix: { audioContext: closedA } } };
  const second = { options: { webAudioMix: { audioContext: closedB } } };
  assert.equal(rebindExactWebAudioMixContexts([first, second], replacement), true);
  assert.equal(exactWebAudioMixContext(first), replacement);
  assert.equal(exactWebAudioMixContext(second), replacement,
    'all exact rooms switch to the same fresh mixer context');

  const foreign = { state: 'running' };
  const incompatible = { options: { webAudioMix: { audioContext: foreign } } };
  assert.equal(rebindExactWebAudioMixContexts([first, incompatible], replacement), false);
  assert.equal(exactWebAudioMixContext(incompatible), foreign,
    'a different live mixer is never silently overwritten');

  const rollbackA = { state: 'closed' };
  const rollbackB = { state: 'closed' };
  const mutable = { options: { webAudioMix: { audioContext: rollbackA } } };
  let lockedValue = rollbackB;
  const lockedMix = {};
  Object.defineProperty(lockedMix, 'audioContext', {
    enumerable: true,
    get: () => lockedValue,
    set: () => { throw new Error('locked options'); },
  });
  const locked = { options: { webAudioMix: lockedMix } };
  assert.equal(rebindExactWebAudioMixContexts([mutable, locked], replacement), false);
  assert.equal(exactWebAudioMixContext(mutable), rollbackA,
    'a later runtime-shape failure rolls earlier exact-room writes back');
  assert.equal(lockedValue, rollbackB);
}

const exactGainCalls = [];
const exactGainTrack = { setVolume: (value) => exactGainCalls.push(value) };
let staleParticipantGainCalls = 0;
applyExactScreenAudioGain(exactGainTrack, { id: 'old-session' }, () => { staleParticipantGainCalls++; }, 0.35);
assert.deepEqual(exactGainCalls, [0.35], 'the audible replacement track receives the new gain');
assert.equal(staleParticipantGainCalls, 0, 'a stale same-username participant cannot short-circuit the audible track');
let matchingParticipantGainCalls = 0;
applyExactScreenAudioGain(exactGainTrack, exactGainTrack, () => { matchingParticipantGainCalls++; }, 0.6);
assert.equal(matchingParticipantGainCalls, 1, 'the exact participant remains a valid SDK fallback');

const watchGate = new StreamWatchPlaybackGate();
const firstWatch = watchGate.begin('alice');
watchGate.acceptTrack('alice', 'old-track');
assert.equal(watchGate.confirms('alice', 'old-track', firstWatch), true);
watchGate.end('alice');
const secondWatch = watchGate.begin('alice');
assert.equal(watchGate.confirms('alice', 'old-track', firstWatch), false,
  'a late tile from the previous watch cannot confirm its successor');
assert.equal(watchGate.generationFor('alice', 'old-track'), 0,
  'an old track key is not inherited by a new watch generation');
watchGate.acceptTrack('alice', 'new-track');
assert.equal(watchGate.confirms('alice', 'new-track', secondWatch), true);
assert.equal(watchGate.confirms('alice', 'new-track', firstWatch), false,
  'even the same identity and accepted track require the current generation');
assert.equal(isAutoplayBlocked({ name: 'NotAllowedError' }), true);
assert.equal(isAutoplayBlocked({ name: 'AbortError' }), false);

assert.equal(await playMediaElement({ play: async () => {} }), 'playing');
assert.equal(await playMediaElement({ play: async () => { throw { name: 'NotAllowedError' }; } }), 'blocked');
assert.equal(await playMediaElement({ play: async () => { throw { name: 'AbortError' }; } }), 'waiting');
assert.equal(await playMediaElement({ play: () => new Promise(() => {}) }, 5), 'waiting',
  'a WebKit play promise cannot hold recovery forever');

{
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const coordinator = new ExactMediaPlayCoordinator();
  const element = {};
  const ordinary = deferred();
  const gesture = deferred();
  const gestureRetry = deferred();
  let physicalCalls = 0;
  let gestureRecoveries = 0;
  for (let tick = 0; tick < 100; tick++) {
    coordinator.request(element, () => { physicalCalls++; return ordinary.promise; });
  }
  assert.equal(physicalCalls, 1,
    '100 watchdog ticks share one actual play request while WebKit keeps it pending');
  coordinator.request(element, () => { physicalCalls++; return gesture.promise; }, true, () => { gestureRecoveries++; });
  coordinator.request(element, () => { physicalCalls++; return gestureRetry.promise; }, true);
  for (let tap = 0; tap < 100; tap++) {
    coordinator.request(element, () => { physicalCalls++; return Promise.resolve(); }, true);
  }
  assert.equal(physicalCalls, 3,
    'a second explicit gesture gets one retry, while 100 more taps stay at the absolute three-call cap');
  gestureRetry.resolve();
  await gestureRetry.promise;
  gesture.resolve();
  await gesture.promise;
  await Promise.resolve();
  assert.equal(gestureRecoveries, 1, 'the exact gesture lane can recover playback');
  ordinary.resolve();
  await ordinary.promise;
  await Promise.resolve();
  assert.equal(coordinator.request(element, () => { physicalCalls++; return Promise.resolve(); }), true,
    'real settlement releases the exact ordinary owner for a future suspension');
  await Promise.resolve();

  const detached = {};
  const late = deferred();
  let staleSuccess = 0;
  coordinator.request(detached, () => late.promise, false, () => { staleSuccess++; });
  coordinator.forget(detached);
  late.resolve();
  await late.promise;
  await Promise.resolve();
  assert.equal(staleSuccess, 0, 'detaching an exact element fences its late play settlement');

  const survivor = {};
  const stranded = deferred();
  let survivorCalls = 0;
  coordinator.request(survivor, () => { survivorCalls++; return stranded.promise; });
  coordinator.forget(survivor);
  coordinator.request(survivor, () => { survivorCalls++; return Promise.resolve(); });
  assert.equal(survivorCalls, 2,
    'a physical playback-owner handoff can start once even when the previous browser promise never settles');
}

{
  const coordinator = new ExactMediaPlayCoordinator();
  const video = {
    calls: 0,
    play() {
      this.calls++;
      return this.calls < 3 ? new Promise(() => {}) : Promise.resolve();
    },
  };
  const eventStorm = Array.from({ length: 100 }, () => playMediaElementCoordinated(coordinator, video, false, 5));
  assert.equal(video.calls, 1, '100 readiness/visibility events own one exact raw video.play call');
  const firstTap = playMediaElementCoordinated(coordinator, video, true, 5);
  const secondTap = playMediaElementCoordinated(coordinator, video, true, 20);
  const extraTaps = Array.from({ length: 100 }, () => playMediaElementCoordinated(coordinator, video, true, 5));
  assert.equal(video.calls, 3,
    'two real gesture lanes may bypass the stuck video owner while further retries stay bounded');
  assert.equal(await secondTap, 'playing', 'the second real tap can recover exact video playback');
  assert.ok((await Promise.all([...eventStorm, firstTap])).every((outcome) => outcome === 'waiting'));
  assert.ok((await Promise.all(extraTaps)).every((outcome) => outcome === 'playing'),
    'coalesced extra retries observe the exact successful gestureRetry owner');
}

{
  const coordinator = new ExactAsyncActionCoordinator();
  const ordinary = new Promise(() => {});
  const room = {
    starts: 0,
    startAudio() {
      this.starts++;
      return this.starts === 1 ? ordinary : Promise.resolve();
    },
  };
  for (let tick = 0; tick < 100; tick++) {
    coordinator.request(room, (current) => current.startAudio());
  }
  assert.equal(room.starts, 1, '100 watchdog ticks share one exact hung room.startAudio call');
  coordinator.request(room, (current) => current.startAudio(), true, undefined, 7);
  coordinator.request(room, (current) => current.startAudio(), true, undefined, 7);
  assert.equal(room.starts, 2,
    'two unlock consumers share one room.startAudio lane for the same physical gesture token');
  coordinator.request(room, (current) => current.startAudio(), true, undefined, 8);
  assert.equal(room.starts, 3,
    'a second physical gesture token retains the one bounded startAudio retry lane');
  await Promise.resolve();
  await Promise.resolve();
}

assert.equal(await routeAudioSinkTarget({}, 'speaker', { timeoutMs: 5 }), 'unsupported');
assert.equal(await routeAudioSinkTarget({ setSinkId: async () => { throw new Error('gone'); } }, 'speaker', {
  timeoutMs: 20,
}), 'failed', 'a rejected hardware route remains distinguishable from success');

{
  const calls = [];
  const target = { setSinkId: async (sinkId) => { calls.push(sinkId); } };
  assert.equal(seedAudioSinkTargetRoute(target), true);
  assert.equal(seedAudioSinkTargetRoute(target), false,
    'a shared exact target cannot have its known route overwritten by a later owner');
  assert.equal(await routeAudioSinkTarget(target, 'default'), 'applied');
  assert.deepEqual(calls, [],
    'a freshly created exact target is already on logical default and needs no physical switch');
  assert.equal(await routeAudioSinkTarget(target, 'headphones'), 'applied');
  assert.equal(await routeAudioSinkTarget(target, 'default'), 'applied');
  assert.deepEqual(calls, ['headphones', 'default'],
    'returning from a confirmed custom route physically restores system default');
  assert.equal(await routeAudioSinkTarget(target, 'default'), 'applied');
  assert.deepEqual(calls, ['headphones', 'default'],
    'a repeated confirmed default route is a logical no-op');
  assert.equal(await routeAudioSinkTarget(target, 'default', { force: true }), 'applied');
  assert.deepEqual(calls, ['headphones', 'default', 'default'],
    'an actual visible device-change edge can explicitly re-resolve the same default route');
}

{
  const failures = [];
  const target = {};
  seedAudioSinkTargetRoute(target);
  assert.equal(await routeAudioSinkTarget(target, 'default', {
    onFailure: (failure) => failures.push(failure),
  }), 'applied');
  assert.deepEqual(failures, [],
    'Safari system-default playback is already correct and does not emit an unsupported incident');
  assert.equal(await routeAudioSinkTarget(target, 'headphones', {
    onFailure: (failure) => failures.push(failure),
  }), 'unsupported');
  assert.deepEqual(failures, [{ operation: 'set_sink', outcome: 'unsupported', code: 'unsupported' }],
    'an actual custom route request still reports unsupported on a target without setSinkId');
}

{
  let attempts = 0;
  const failures = [];
  const missing = Object.assign(new Error('private browser detail'), { name: 'NotFoundError' });
  const target = {
    async setSinkId() {
      attempts++;
      if (attempts === 1) throw missing;
    },
  };
  seedAudioSinkTargetRoute(target);
  assert.equal(await routeAudioSinkTarget(target, 'default', {
    force: true,
    onFailure: (failure) => failures.push(failure),
  }), 'failed');
  assert.deepEqual(failures, [{ operation: 'set_sink', outcome: 'failed', code: 'device_lost' }],
    'diagnostics receive only a fixed operation and category, never the raw browser error');
  assert.doesNotMatch(JSON.stringify(failures), /private browser detail/);
  assert.equal(await routeAudioSinkTarget(target, 'default'), 'applied');
  assert.equal(attempts, 2,
    'a failed forced default remains eligible for the next ordinary bounded retry');
  assert.equal(await routeAudioSinkTarget(target, 'default'), 'applied');
  assert.equal(attempts, 2, 'the successful retry confirms default and restores coalescing');
}

{
  let rejectOld;
  const failures = [];
  const calls = [];
  const target = {
    setSinkId(sinkId) {
      calls.push(sinkId);
      if (sinkId === 'stale-headphones') {
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      return Promise.resolve();
    },
  };
  seedAudioSinkTargetRoute(target);
  const stale = routeAudioSinkTarget(target, 'stale-headphones', {
    timeoutMs: 50,
    onFailure: (failure) => failures.push(failure),
  });
  for (let spin = 0; spin < 5 && !rejectOld; spin++) await Promise.resolve();
  const current = routeAudioSinkTarget(target, 'default', { timeoutMs: 50 });
  rejectOld(Object.assign(new Error('private stale error'), { name: 'NotFoundError' }));
  assert.equal(await stale, 'superseded');
  assert.equal(await current, 'applied');
  assert.deepEqual(calls, ['stale-headphones']);
  assert.deepEqual(failures, [],
    'a late rejection from a superseded custom selection cannot create a false device-lost incident');
}

{
  let attempts = 0;
  const failures = [];
  const target = {
    setSinkId() {
      attempts++;
      return attempts === 1 ? new Promise(() => {}) : Promise.resolve();
    },
  };
  seedAudioSinkTargetRoute(target);
  assert.equal(await routeAudioSinkTarget(target, 'default', {
    force: true, timeoutMs: 5, onFailure: (failure) => failures.push(failure),
  }), 'timed-out');
  assert.equal(await routeAudioSinkTarget(target, 'default', { timeoutMs: 20 }), 'applied');
  assert.equal(attempts, 2, 'a timed-out default route is retried instead of treated as confirmed');
  assert.deepEqual(failures, [{ operation: 'set_sink', outcome: 'timed-out', code: 'timeout' }]);
}

{
  let releaseCustom;
  const calls = [];
  const target = {
    setSinkId(sinkId) {
      calls.push(sinkId);
      if (sinkId === 'uncertain-custom') return new Promise((resolve) => { releaseCustom = resolve; });
      return Promise.resolve();
    },
  };
  seedAudioSinkTargetRoute(target);
  assert.equal(await routeAudioSinkTarget(target, 'uncertain-custom', { timeoutMs: 5 }), 'timed-out');
  assert.equal(await routeAudioSinkTarget(target, 'default', { timeoutMs: 20 }), 'applied');
  assert.deepEqual(calls, ['uncertain-custom', 'default'],
    'custom to default is physical even when the old browser promise left hardware uncertain');
  releaseCustom();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['uncertain-custom', 'default', 'default'],
    'a late stale custom success repairs back to the current default route');
}

{
  const failures = [];
  let physicalCalls = 0;
  const denied = Object.assign(new Error('private enumeration detail'), { name: 'NotAllowedError' });
  const target = { setSinkId: async () => { physicalCalls++; } };
  seedAudioSinkTargetRoute(target);
  assert.equal(await routeAudioSinkTarget(target, 'headphones', {
    normalize: async () => { throw denied; },
    onFailure: (failure) => failures.push(failure),
  }), 'failed');
  assert.equal(physicalCalls, 0);
  assert.deepEqual(failures, [{ operation: 'enumerate', outcome: 'failed', code: 'permission' }]);
  assert.doesNotMatch(JSON.stringify(failures), /private enumeration detail/);
}

{
  const calls = [];
  const target = { setSinkId: async (sinkId) => { calls.push(sinkId); } };
  assert.equal(await routeAudioSinkTarget(target, 'default', {
    normalize: () => new Promise(() => {}),
    timeoutMs: 5,
  }), 'timed-out', 'hung device enumeration cannot hold the output queue forever');
  assert.equal(await routeAudioSinkTarget(target, 'speaker-after-enumeration-timeout', { timeoutMs: 20 }), 'applied');
  assert.deepEqual(calls, ['speaker-after-enumeration-timeout'],
    'a newer output selection bypasses an abandoned normalization promise');
}

{
  let releaseOld;
  let audibleRoute = 'initial';
  const calls = [];
  const target = {
    setSinkId(sinkId) {
      calls.push(sinkId);
      if (sinkId !== 'late-old') { audibleRoute = sinkId; return Promise.resolve(); }
      return new Promise((resolve) => { releaseOld = () => { audibleRoute = sinkId; resolve(); }; });
    },
  };
  assert.equal(await routeAudioSinkTarget(target, 'late-old', { timeoutMs: 5 }), 'timed-out');
  assert.equal(await routeAudioSinkTarget(target, 'current-speaker', { timeoutMs: 20 }), 'applied');
  assert.equal(audibleRoute, 'current-speaker');
  releaseOld();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(audibleRoute, 'current-speaker',
    'a late stale browser success is repaired back to the latest requested output');
  assert.deepEqual(calls, ['late-old', 'current-speaker', 'current-speaker']);
}

{
  let releaseOld;
  let releaseLatestNormalization;
  const target = {
    setSinkId(sinkId) {
      if (sinkId === 'old-before-current') return new Promise((resolve) => { releaseOld = resolve; });
      return Promise.resolve();
    },
  };
  assert.equal(await routeAudioSinkTarget(target, 'old-before-current', { timeoutMs: 5 }), 'timed-out');
  const latest = routeAudioSinkTarget(target, 'truthful-current', {
    timeoutMs: 50,
    normalize: () => new Promise((resolve) => { releaseLatestNormalization = resolve; }),
  });
  for (let spin = 0; spin < 5 && !releaseLatestNormalization; spin++) await Promise.resolve();
  releaseOld();
  await Promise.resolve();
  releaseLatestNormalization('truthful-current');
  assert.equal(await latest, 'applied',
    'an internal late-result repair cannot mark the real latest Settings request as superseded');
}

const unlockedElement = { matches: () => false };
assert.equal(mediaElementVolumeLocked(unlockedElement, null), false,
  'non-browser runtimes fail open to ordinary element volume instead of reading a missing navigator');
assert.equal(mediaElementVolumeLocked(unlockedElement, {
  userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5,
}), true);
assert.equal(mediaElementVolumeLocked(unlockedElement, {
  userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0,
}), false);
assert.equal(mediaElementVolumeLocked({ matches: (selector) => selector === ':volume-locked' }, {
  userAgent: '', platform: '', maxTouchPoints: 0,
}), true);

class FakeTrack extends EventTarget {
  constructor(id) { super(); this.id = id; this.readyState = 'live'; }
}
class FakeStream extends EventTarget {
  constructor(tracks = []) { super(); this.tracks = tracks; }
  getAudioTracks() { return this.tracks; }
  replace(track) { this.tracks = track ? [track] : []; this.dispatchEvent(new Event('addtrack')); }
}
class IsolatedStream {
  constructor(tracks) { this.tracks = tracks; }
}

const originalMediaStream = globalThis.MediaStream;
globalThis.MediaStream = IsolatedStream;

const gainParam = { value: 1, calls: [], setValueAtTime(value, at) { this.value = value; this.calls.push([value, at]); } };
const gainNode = { gain: gainParam, connects: 0, disconnects: 0, connect() { this.connects++; }, disconnect() { this.disconnects++; } };
const sources = [];
const context = {
  state: 'suspended', currentTime: 42, destination: {}, onstatechange: null,
  createGain: () => gainNode,
  createMediaStreamSource: (stream) => {
    const node = { stream, connects: 0, disconnects: 0, connect() { this.connects++; }, disconnect() { this.disconnects++; } };
    sources.push(node); return node;
  },
  async resume() { this.state = 'running'; this.onstatechange?.(); },
  async close() { this.state = 'closed'; },
};
const firstTrack = new FakeTrack('first');
const stream = new FakeStream([firstTrack]);
const video = { muted: false, volume: 1, matches: () => false };
let unlocks = 0;
const controller = new TreeStreamAudioController(video, stream, {
  preferWebAudio: true,
  audioContextFactory: () => context,
  onNeedsUnlock: () => { unlocks++; },
});
assert.equal(controller.usesWebAudio, true);
assert.equal(video.muted, true, 'WebAudio must mute the direct video path before it can sound');
controller.setGain(0.35);
assert.equal(gainParam.value, 0.35);
assert.equal(await controller.resume(), true);
assert.equal(context.state, 'running');

const secondTrack = new FakeTrack('second');
stream.replace(secondTrack);
assert.equal(sources.length, 2, 'a replaced P2P audio track rebuilds the exact source node');
assert.equal(sources[0].disconnects, 1, 'the superseded source is disconnected');
controller.dispose();
await Promise.resolve();
assert.equal(context.state, 'closed');
assert.equal(video.muted, true, 'cleanup cannot briefly restore a double audio path');

const fallbackVideo = { muted: true, volume: 1, matches: () => false };
const fallback = new TreeStreamAudioController(fallbackVideo, new FakeStream([new FakeTrack('fallback')]), {
  preferWebAudio: false,
});
fallback.setGain(0.25);
assert.equal(fallbackVideo.volume, 0.25);
assert.equal(fallbackVideo.muted, false);
fallback.setGain(0);
assert.equal(fallbackVideo.muted, true);
fallback.dispose();

const lateAudioVideo = { muted: true, volume: 1, matches: () => false };
const lateAudioStream = new FakeStream();
const lateAudio = new TreeStreamAudioController(lateAudioVideo, lateAudioStream, {
  preferWebAudio: false,
});
lateAudio.setGain(0.45);
assert.equal(lateAudioVideo.muted, false,
  'a video-first desktop tree stream enters attach already audible for a later bundled audio track');
lateAudioStream.replace(new FakeTrack('late-audio'));
assert.equal(lateAudioVideo.muted, false,
  'a late tree audio track immediately restores the direct desktop playback path');
assert.equal(lateAudioVideo.volume, 0.45, 'the late direct path receives the saved stream gain');
lateAudio.dispose();

const lateLockedVideo = { muted: false, volume: 1, matches: () => true };
const lateLocked = new TreeStreamAudioController(lateLockedVideo, new FakeStream(), {
  audioContextFactory: () => { throw new Error('must wait for audio'); },
});
lateLocked.setGain(0.45);
assert.equal(lateLockedVideo.muted, true,
  'volume-locked media stays muted while its late audio waits for the scaled WebAudio path');
lateLocked.dispose();

const sinkCalls = [];
let releaseOldSink;
const routedVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId(sinkId) {
    sinkCalls.push(sinkId);
    if (sinkId === 'route-a') return new Promise((resolve) => { releaseOldSink = resolve; });
    return Promise.resolve();
  },
};
const routedFallback = new TreeStreamAudioController(
  routedVideo,
  new FakeStream([new FakeTrack('routed-fallback')]),
  { preferWebAudio: false },
);
assert.equal(await setTreeStreamOutputSink('route-base'), 'applied');
sinkCalls.length = 0;
const routeA = setTreeStreamOutputSink('route-a');
for (let i = 0; i < 4 && !releaseOldSink; i++) await Promise.resolve();
assert.equal(typeof releaseOldSink, 'function', 'the exact fallback video owns the route request');
const routeB = setTreeStreamOutputSink('route-b');
assert.deepEqual(sinkCalls, ['route-a'], 'a newer sink waits behind the in-flight hardware switch');
releaseOldSink();
await Promise.all([routeA, routeB]);
assert.deepEqual(sinkCalls, ['route-a', 'route-b'], 'the latest output route deterministically wins');
routedFallback.dispose();
await setTreeStreamOutputSink('default');

let rejectAggregateOld;
let aggregateFastApplied = false;
const aggregateSlowVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId(sinkId) {
    if (sinkId === 'aggregate-old')
      return new Promise((_resolve, reject) => { rejectAggregateOld = reject; });
    return Promise.resolve();
  },
};
const aggregateFastVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId(sinkId) {
    if (sinkId === 'aggregate-old') aggregateFastApplied = true;
    return Promise.resolve();
  },
};
const aggregateSlow = new TreeStreamAudioController(
  aggregateSlowVideo, new FakeStream([new FakeTrack('aggregate-slow')]), { preferWebAudio: false },
);
const aggregateFast = new TreeStreamAudioController(
  aggregateFastVideo, new FakeStream([new FakeTrack('aggregate-fast')]), { preferWebAudio: false },
);
const aggregateOld = setTreeStreamOutputSink('aggregate-old');
for (let i = 0; i < 20 && (!rejectAggregateOld || !aggregateFastApplied); i++) await Promise.resolve();
assert.equal(typeof rejectAggregateOld, 'function');
assert.equal(aggregateFastApplied, true);
const aggregateNew = setTreeStreamOutputSink('aggregate-new');
rejectAggregateOld(new Error('old aggregate target disappeared'));
const [aggregateOldOutcome, aggregateNewOutcome] = await Promise.all([aggregateOld, aggregateNew]);
assert.equal(aggregateOldOutcome, 'superseded',
  'one superseded target prevents a partially applied tree aggregate from claiming success');
assert.equal(aggregateNewOutcome, 'applied', 'the exact newer aggregate remains authoritative');
aggregateSlow.dispose();
aggregateFast.dispose();
await setTreeStreamOutputSink('default');

const boundedSinkCalls = [];
const boundedVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId(sinkId) {
    boundedSinkCalls.push(sinkId);
    return sinkId === 'route-stuck' ? new Promise(() => {}) : Promise.resolve();
  },
};
const boundedFallback = new TreeStreamAudioController(
  boundedVideo,
  new FakeStream([new FakeTrack('bounded-fallback')]),
  { preferWebAudio: false },
);
await setTreeStreamOutputSink('route-before-stuck');
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
try {
  // Exercise the production deadline without making this behavioral test wait 1.5 seconds.
  globalThis.setTimeout = (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args);
  globalThis.clearTimeout = (timer) => nativeClearTimeout(timer);
  const stuckRoute = setTreeStreamOutputSink('route-stuck');
  for (let i = 0; i < 4 && boundedSinkCalls.at(-1) !== 'route-stuck'; i++) await Promise.resolve();
  assert.equal(boundedSinkCalls.at(-1), 'route-stuck');
  const latestRoute = setTreeStreamOutputSink('route-after-stuck');
  const [stuckOutcome, latestOutcome] = await Promise.all([stuckRoute, latestRoute]);
  assert.ok(stuckOutcome === 'timed-out' || stuckOutcome === 'superseded',
    'the aggregate reports that the stuck tree route did not complete');
  assert.equal(latestOutcome, 'applied', 'the aggregate confirms the replacement tree route');
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}
assert.equal(boundedSinkCalls.at(-1), 'route-after-stuck',
  'a hung setSinkId is bounded and cannot hold a newer Settings output forever');
boundedFallback.dispose();
await setTreeStreamOutputSink('default');

const rejectedVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId: async () => { throw new Error('device disconnected'); },
};
const rejectedFallback = new TreeStreamAudioController(
  rejectedVideo,
  new FakeStream([new FakeTrack('rejected-fallback')]),
  { preferWebAudio: false },
);
assert.equal(await setTreeStreamOutputSink('disconnected-speaker'), 'failed',
  'a failed live tree target cannot be reported as a successful Settings switch');
rejectedFallback.dispose();
await setTreeStreamOutputSink('default');

await setTreeStreamOutputSink('future-disconnected-speaker');
let inheritedRouteFailures = 0;
let inheritedRouteOutcome = '';
const futureRejectedVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId: async () => { throw new Error('device disappeared before the first tile'); },
};
const futureRejected = new TreeStreamAudioController(
  futureRejectedVideo,
  new FakeStream([new FakeTrack('future-rejected-fallback')]),
  {
    preferWebAudio: false,
    onOutputRouteFailure: (outcome) => { inheritedRouteFailures++; inheritedRouteOutcome = outcome; },
  },
);
for (let i = 0; i < 20 && inheritedRouteFailures === 0; i++) await Promise.resolve();
assert.equal(inheritedRouteFailures, 1,
  'the first future tree target reports that its previously selected hardware route is gone');
assert.equal(inheritedRouteOutcome, 'failed');
futureRejected.dispose();
await setTreeStreamOutputSink('default');

await setTreeStreamOutputSink('shared-future-speaker');
let rejectSharedInheritedRoute;
let liveSharedFailure = 0;
let disposedSharedFailure = 0;
const futureSharedVideo = {
  muted: true, volume: 1, matches: () => false,
  setSinkId(sinkId) {
    if (sinkId !== 'shared-future-speaker') return Promise.resolve();
    return new Promise((_resolve, reject) => { rejectSharedInheritedRoute = reject; });
  },
};
const liveSharedController = new TreeStreamAudioController(
  futureSharedVideo,
  new FakeStream([new FakeTrack('live-shared-route')]),
  { preferWebAudio: false, onOutputRouteFailure: () => { liveSharedFailure++; } },
);
const disposedSharedController = new TreeStreamAudioController(
  futureSharedVideo,
  new FakeStream([new FakeTrack('disposed-shared-route')]),
  { preferWebAudio: false, onOutputRouteFailure: () => { disposedSharedFailure++; } },
);
disposedSharedController.dispose();
for (let i = 0; i < 20 && !rejectSharedInheritedRoute; i++) await Promise.resolve();
assert.equal(typeof rejectSharedInheritedRoute, 'function');
rejectSharedInheritedRoute(new Error('shared device disconnected'));
for (let i = 0; i < 20 && liveSharedFailure === 0; i++) await Promise.resolve();
assert.equal(liveSharedFailure, 1,
  'a live owner handles a shared target failure even when the controller that queued it was disposed');
assert.equal(disposedSharedFailure, 0, 'a disposed newest controller cannot swallow the shared route failure');
liveSharedController.dispose();
await setTreeStreamOutputSink('default');

const failedMixerVideo = { muted: true, volume: 1, matches: () => false };
const failedMixer = new TreeStreamAudioController(
  failedMixerVideo,
  new FakeStream([new FakeTrack('failed-mixer')]),
  { preferWebAudio: true, audioContextFactory: () => { throw new Error('unsupported remote source'); } },
);
failedMixer.setGain(0.4);
assert.equal(failedMixer.usesWebAudio, false);
assert.equal(failedMixerVideo.volume, 0.4);
assert.equal(failedMixerVideo.muted, false, 'WebAudio construction failure keeps the direct audio fallback alive');
failedMixer.dispose();

let lockedFactoryCalls = 0;
let lockedUnlocks = 0;
let lockedVolume = 1;
const volumeLockedVideo = {
  muted: false,
  get volume() { return lockedVolume; },
  set volume(_value) { /* iPhone ignores programmatic volume changes */ },
  matches: (selector) => selector === ':volume-locked',
};
const volumeLockedMixer = new TreeStreamAudioController(
  volumeLockedVideo,
  new FakeStream([new FakeTrack('volume-locked-failed-mixer')]),
  {
    audioContextFactory: () => { lockedFactoryCalls++; throw new Error('mobile mixer unavailable'); },
    onNeedsUnlock: () => { lockedUnlocks++; },
  },
);
volumeLockedMixer.setGain(0.4);
assert.equal(volumeLockedMixer.usesWebAudio, true,
  'a volume-locked target retains WebAudio intent instead of accepting an unscaled element fallback');
assert.equal(volumeLockedVideo.muted, true,
  'a failed iPhone mixer never opens the full-volume direct media path');
assert.equal(lockedVolume, 1, 'the test target models an ignored HTMLMediaElement.volume assignment');
assert.ok(lockedUnlocks > 0, 'the exact locked tile exposes a recoverable playback retry');
assert.equal(await volumeLockedMixer.resume(5), false,
  'a failed retry stays bounded while preserving the muted WebAudio path');
assert.ok(lockedFactoryCalls >= 2, 'resume retries mixer construction instead of permanently downgrading');
volumeLockedMixer.dispose();

const hangingContext = {
  state: 'suspended', currentTime: 0, destination: {}, onstatechange: null,
  resumeCalls: 0,
  createGain: () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }),
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  resume() {
    this.resumeCalls++;
    if (this.resumeCalls === 1) return new Promise(() => {});
    this.state = 'running';
    return Promise.resolve();
  },
  close: async () => {},
};
const hanging = new TreeStreamAudioController(
  { muted: false, volume: 1, matches: () => false },
  new FakeStream([new FakeTrack('hanging')]),
  { preferWebAudio: true, audioContextFactory: () => hangingContext },
);
assert.equal(await hanging.resume(5), false, 'a suspended iOS AudioContext has a bounded caller wait');
const hungWatchdogs = Array.from({ length: 100 }, () => hanging.resume(5));
assert.equal(hangingContext.resumeCalls, 1,
  '100 bounded watchdog calls retain one physical AudioContext.resume owner after timeout');
assert.equal(await hanging.resume(20, true), true,
  'one separate synchronous gesture lane recovers a context whose ordinary resume is stuck');
assert.equal(hangingContext.resumeCalls, 2, 'gesture recovery is bounded to one additional native call');
assert.ok((await Promise.all(hungWatchdogs)).every((ready) => !ready),
  'ordinary callers stay bounded even while their shared native promise remains pending');
hanging.dispose();

function recoveryContext(initialState) {
  const listeners = new Set();
  const gains = [];
  const sources = [];
  return {
    state: initialState, currentTime: 7, destination: {}, gains, sources, resumeCalls: 0, closeCalls: 0,
    addEventListener(type, listener) { if (type === 'statechange') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'statechange') listeners.delete(listener); },
    dispatchState() { listeners.forEach((listener) => listener()); },
    createGain() {
      const node = {
        gain: { value: 1, calls: [], setValueAtTime(value, at) { this.value = value; this.calls.push([value, at]); } },
        connect() {}, disconnect() {},
      };
      gains.push(node);
      return node;
    },
    createMediaStreamSource(mediaStream) {
      const node = { mediaStream, connect() {}, disconnect() {} };
      sources.push(node);
      return node;
    },
    async resume() { this.resumeCalls++; this.state = 'running'; this.dispatchState(); },
    async close() { this.closeCalls++; this.state = 'closed'; },
  };
}

const unexpectedlyClosedContext = recoveryContext('suspended');
const replacementContext = recoveryContext('suspended');
let recoveryFactoryCalls = 0;
const recoveryFactory = () => (++recoveryFactoryCalls === 1 ? unexpectedlyClosedContext : replacementContext);
const recoveryVideoA = { muted: false, volume: 1, matches: () => false };
const recoveryVideoB = { muted: false, volume: 1, matches: () => false };
const recoveryA = new TreeStreamAudioController(
  recoveryVideoA, new FakeStream([new FakeTrack('recovery-a')]),
  { preferWebAudio: true, audioContextFactory: recoveryFactory, shareContext: true },
);
const recoveryB = new TreeStreamAudioController(
  recoveryVideoB, new FakeStream([new FakeTrack('recovery-b')]),
  { preferWebAudio: true, audioContextFactory: recoveryFactory, shareContext: true },
);
assert.equal(recoveryFactoryCalls, 1, 'both tiles initially use the exact same shared context');
recoveryA.setGain(0.4);
unexpectedlyClosedContext.state = 'closed';
unexpectedlyClosedContext.dispatchState();
assert.equal(await recoveryA.resume(), true, 'the first visible tile recreates a context closed in the background');
assert.equal(await recoveryB.resume(), true, 'the other tile migrates onto that same replacement context');
assert.equal(recoveryFactoryCalls, 2, 'a closed shared context is replaced only once');
assert.equal(replacementContext.sources.length, 2, 'both exact live tracks are reconnected to the replacement mixer');
assert.equal(replacementContext.gains[0].gain.value, 0.4, 'the personal/master gain survives graph recreation');
assert.equal(recoveryVideoA.muted, true);
assert.equal(recoveryVideoB.muted, true, 'recreation never opens a duplicate direct audio path');
recoveryA.dispose();
recoveryB.dispose();
await Promise.resolve();
assert.equal(replacementContext.closeCalls, 1, 'the replacement mixer keeps normal shared lifetime semantics');

const sharedStateListeners = new Set();
const retryContext = {
  state: 'suspended', currentTime: 0, destination: {},
  addEventListener(type, listener) { if (type === 'statechange') sharedStateListeners.add(listener); },
  removeEventListener(type, listener) { if (type === 'statechange') sharedStateListeners.delete(listener); },
  createGain: () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }),
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  resume: async () => {}, close: async () => {},
};
let exactRetryA = 0;
let exactRetryB = 0;
const retryA = new TreeStreamAudioController(
  { muted: false, volume: 1, matches: () => false }, new FakeStream([new FakeTrack('retry-a')]),
  { preferWebAudio: true, audioContextFactory: () => retryContext, shareContext: true, onPlaybackReady: () => { exactRetryA++; } },
);
const retryB = new TreeStreamAudioController(
  { muted: false, volume: 1, matches: () => false }, new FakeStream([new FakeTrack('retry-b')]),
  { preferWebAudio: true, audioContextFactory: () => retryContext, shareContext: true, onPlaybackReady: () => { exactRetryB++; } },
);
retryContext.state = 'running';
sharedStateListeners.forEach((listener) => listener());
assert.equal(exactRetryA, 1, 'shared context recovery addresses the first exact tile callback');
assert.equal(exactRetryB, 1, 'shared context recovery addresses the second exact tile callback');
retryA.dispose();
retryB.dispose();

let sharedFactoryCalls = 0;
let sharedCloseCalls = 0;
const sharedSinkCalls = [];
const sharedContext = {
  state: 'running', currentTime: 0, destination: {}, onstatechange: null,
  createGain: () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }),
  createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  setSinkId: async (sinkId) => { sharedSinkCalls.push(sinkId); },
  resume: async () => {},
  close: async () => { sharedCloseCalls++; sharedContext.state = 'closed'; },
};
const sharedFactory = () => { sharedFactoryCalls++; return sharedContext; };
const sharedA = new TreeStreamAudioController(
  { muted: false, volume: 1, matches: () => false }, new FakeStream([new FakeTrack('shared-a')]),
  { preferWebAudio: true, audioContextFactory: sharedFactory, shareContext: true },
);
const sharedB = new TreeStreamAudioController(
  { muted: false, volume: 1, matches: () => false }, new FakeStream([new FakeTrack('shared-b')]),
  { preferWebAudio: true, audioContextFactory: sharedFactory, shareContext: true },
);
assert.equal(sharedFactoryCalls, 1, 'all tree tiles share one mobile AudioContext');
const sharedSinkBaseline = sharedSinkCalls.length;
await setTreeStreamOutputSink('shared-speaker');
assert.equal(sharedSinkCalls.length, sharedSinkBaseline + 1, 'one shared mixer receives one output switch for all tiles');
assert.equal(sharedSinkCalls.at(-1), 'shared-speaker');
sharedA.dispose();
await Promise.resolve();
assert.equal(sharedCloseCalls, 0, 'one tile cannot close the mixer used by another tile');
sharedB.dispose();
await Promise.resolve();
assert.equal(sharedCloseCalls, 1, 'the shared mixer closes after its final tile');
await setTreeStreamOutputSink('default');

if (originalMediaStream === undefined) delete globalThis.MediaStream;
else globalThis.MediaStream = originalMediaStream;

const originalDocument = globalThis.document;
let fullscreenCalls = 0;
let pipCalls = 0;
globalThis.document = {
  fullscreenElement: null,
  pictureInPictureElement: null,
  async exitFullscreen() {},
  async exitPictureInPicture() {},
};
assert.equal(await toggleStreamFullscreen({
  async requestFullscreen() { fullscreenCalls++; },
}, {}), true);
assert.equal(fullscreenCalls, 1);
assert.equal(await toggleStreamPictureInPicture({
  async requestPictureInPicture() { pipCalls++; },
}), true);
assert.equal(pipCalls, 1);
let webkitFullscreenCalls = 0;
assert.equal(await toggleStreamFullscreen({
  async requestFullscreen() { throw new Error('container unsupported'); },
}, { webkitEnterFullscreen() { webkitFullscreenCalls++; } }), true);
assert.equal(webkitFullscreenCalls, 1, 'iPhone video fullscreen remains available after a rejected standard request');
let webkitPipCalls = 0;
assert.equal(await toggleStreamPictureInPicture({
  async requestPictureInPicture() { throw new Error('standard PiP unsupported'); },
  webkitPresentationMode: 'inline',
  webkitSetPresentationMode(mode) { if (mode === 'picture-in-picture') webkitPipCalls++; },
}), true);
assert.equal(webkitPipCalls, 1);
assert.equal(await toggleStreamFullscreen({}, {}), false, 'missing mobile APIs are a safe no-op');
assert.equal(await toggleStreamPictureInPicture({}), false, 'missing PiP APIs are a safe no-op');
if (originalDocument === undefined) delete globalThis.document;
else globalThis.document = originalDocument;

const engine = readSource('engine.ts');
const tree = readSource('transport', 'treeVideo.ts');
const sounds = readSource('sounds.ts');
{
  const asDataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const micSource = readSource('micLifecycle.ts');
  const micModule = asDataModule(ts.transpileModule(micSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const settingsModule = asDataModule(`
    export const getSettings = () => ({ notifyVolume: 60, output: '' });
    export const subscribeSettings = () => () => {};
  `);
  const routingModule = asDataModule(`
    export const routeAudioSinkTarget = async () => 'applied';
    export const seedAudioSinkTargetRoute = () => true;
  `);
  let soundJs = ts.transpileModule(`${sounds}\nexport { observeSoundContextResume };`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  soundJs = soundJs
    .replace("'./settings'", `'${settingsModule}'`)
    .replace("'./micLifecycle'", `'${micModule}'`)
    .replace("'./streamPlayback'", `'${routingModule}'`);
  const { observeSoundContextResume } = await import(asDataModule(soundJs));
  const deferredResume = () => {
    let resolve;
    const promise = new Promise((ok) => { resolve = ok; });
    return { promise, resolve };
  };
  const ordinary = deferredResume();
  const gesture = deferredResume();
  const gestureRetry = deferredResume();
  const context = {
    state: 'suspended', calls: 0,
    resume() {
      this.calls++;
      return this.calls === 1 ? ordinary.promise : (this.calls === 2 ? gesture.promise : gestureRetry.promise);
    },
  };
  for (let notification = 0; notification < 100; notification++) observeSoundContextResume(context);
  assert.equal(context.calls, 1,
    '100 suspended notification sounds observe one exact physical native resume owner');
  observeSoundContextResume(context, true);
  observeSoundContextResume(context, true);
  for (let retry = 0; retry < 100; retry++) observeSoundContextResume(context, true);
  assert.equal(context.calls, 3,
    'sound recovery retains two bounded gesture lanes without per-notification raw resume calls');
  gestureRetry.resolve(); gesture.resolve(); ordinary.resolve();
  await Promise.all([gestureRetry.promise, gesture.promise, ordinary.promise]);
}
assert.match(engine, /const WATCH_VIDEO_DEADLINE_MS = 20_000/,
  'a first mobile watch has a bounded 20 second video deadline');
const serverView = readSource('components', 'ServerView.tsx');
const streamTileSetup = serverView.match(/useEffect\(\(\) => \{\n    const track = E\.getVideoTrack\(streamKey\)[\s\S]*?\n    const visible =/)?.[0] || '';
assert.ok(streamTileSetup.indexOf('const mediaStream =') < streamTileSetup.indexOf('(track as any).attach(v)'),
  'StreamTile identifies the combined tree MediaStream before the autoplay attach boundary');
assert.ok(streamTileSetup.indexOf('new TreeStreamAudioController') < streamTileSetup.indexOf('(track as any).attach(v)'),
  'a tree stream establishes direct/WebAudio ownership before WebKit can autoplay it');
assert.doesNotMatch(streamTileSetup.slice(0, streamTileSetup.indexOf('const mediaStream =')), /v\.muted = true/,
  'remote tree streams are not unconditionally muted before their transport is known');
assert.match(serverView, /mediaStream\?\.addEventListener\('addtrack', retry\)/,
  'a tree audio track arriving after video immediately retries the exact media playback path');
assert.match(serverView, /setPlaybackBlocked\(!audioReady \|\| outcome !== 'playing'\)/,
  'a hanging WebKit play promise exposes the gesture retry instead of silently timing out');
assert.match(serverView, /const diagnosticAudioReady = controller \? audioReady : undefined;[\s\S]*recordWatchPlaybackOutcome\([\s\S]*outcome, diagnosticAudioReady,[\s\S]*confirmWatchPlayback/,
  'the playback result is captured before success while LiveKit audio remains explicitly unknown');
assert.match(serverView, /catch \{[\s\S]*recordWatchPlaybackOutcome\([\s\S]*'failed', mediaStream \? false : undefined,[\s\S]*setPlaybackBlocked\(true\)/,
  'an element attach failure is visible to diagnostics and leaves a recoverable UI state');
assert.match(engine, /audioReady\?: boolean[\s\S]*audioReady === undefined \? \{\} : \{ canPlaybackAudio: audioReady \}/,
  'unknown separate LiveKit audio is omitted instead of being reported as playable');
// Просмотр подтверждается ДЕКОДИРОВАННЫМ КАДРОМ, а не началом воспроизведения. Раньше
// подтверждение приходило только с события 'playing', то есть требовало разрешённого
// автозапуска: пока зритель не нажал кнопку запуска, дедлайн watch (20 с) обрывал
// исправное соединение с ошибкой «Не удалось подключиться к трансляции».
// videoWidth > 0 доказывает наличие кадра, поэтому аудио-only и мёртвый поток
// по-прежнему упираются в дедлайн — там подтверждать нечего.
assert.match(serverView, /const confirmDecoded = \(\) => \{[\s\S]*?!v\.videoWidth[\s\S]*?confirmWatchPlayback/,
  'a decoded video frame confirms the watch without waiting for autoplay permission');
assert.match(serverView, /v\.addEventListener\('resize', confirmDecoded\)/,
  'the first frame of a MediaStream (videoWidth 0 -> N) confirms the watch');
assert.ok(/const playable = \(\) => \{[\s\S]*?confirmDecoded\(\)/.test(serverView),
  'loadeddata/canplay confirm the watch as soon as the frame is decodable');
assert.match(engine, /remoteAudioPlays\.request\(el,[\s\S]*explicitGesture/,
  'voice and screen audio share exact-element ordinary and gesture play owners');
assert.match(engine, /remoteAudioPlays\.forget\(entry\.el\)/,
  'detaching an audible element invalidates its late play continuation');
assert.match(engine, /confirmWatchPlayback\(identity: string, streamKey: string, generation: number\)[\s\S]*watchPlaybackGate\.confirms/,
  'the pending spinner accepts only its exact watch generation and track');
assert.match(engine, /beginStreamWatchDiagnostic\(identity, t, playbackGeneration\)/,
  'every accepted watch click starts one account-scoped structured report');
assert.match(engine, /finishStreamWatchDiagnostic\([\s\S]*stream_watch_succeeded/,
  'the first playable frame emits a success control report');
assert.match(engine, /stage: 'watch_playback', outcome: 'timed_out', code: 'decode_timeout'/,
  'a watch that never decodes a frame emits the exact terminal reason before teardown');
assert.match(engine, /streamGainOf\(id: string\)[\s\S]*effectiveStreamGain\(getSettings\(\)\.master/,
  'LiveKit screen audio uses master multiplied by its per-stream volume');
assert.match(engine, /applyMaster\(\)[^{]*\{[^}]*applyAllStreamVolumes\(\)/,
  'master changes immediately reach screen-share audio as well as voice audio');
const outputSwitchBody = engine.match(/private async switchContextOutput\([\s\S]*?\n  }\n  private async switchElementOutput/)?.[0] || '';
assert.ok(outputSwitchBody.indexOf('setTreeStreamOutputSink(requested,') < outputSwitchBody.indexOf('this.queueContextOutput(requested,'),
  'tree output starts before waiting for the independently bounded voice AudioContext route');
assert.match(engine, /private queueContextOutput\([\s\S]*routeAudioSinkTarget\(ctx, requested,[\s\S]*normalizedContextSink/,
  'voice output enumeration and AudioContext routing share the bounded late-result-safe router');
assert.match(outputSwitchBody, /audioSinkRoutesConfirmed\(requested,[\s\S]*if \(requested === 'default'\) return null/,
  'a failed system-default route stays uncached and eligible for ordinary reconciliation');
assert.match(outputSwitchBody, /audioSinkRoutesConfirmed\('default',[\s\S]*recordVoiceOutputFailure\([\s\S]*return null;[\s\S]*setSettings\(\{ output: '' \}\)/,
  'a failed custom route is rewritten to system default only after every audible path confirms fallback');
assert.match(outputSwitchBody, /recordVoiceOutputFailure\([\s\S]*requested === 'default',[\s\S]*queueContextOutput\('default'[\s\S]*submitVoiceDiagnostic\('output_route_failed'\)[\s\S]*setSettings/,
  'custom failure and its fallback result are submitted together in one diagnostic snapshot');
const elementOutputBody = engine.match(/private async switchElementOutput\([\s\S]*?\n  }\n  private forgetElementOutput/)?.[0] || '';
assert.match(elementOutputBody, /elementOutputRoutes\.claim\(el, requested, retry \|\| force\)/,
  'identical steady-state sink requests are coalesced before entering the native promise queue');
assert.match(elementOutputBody, /elementOutputGenerations\.get\(el\) !== generation/,
  'a detached or superseded queued route is fenced before calling the browser');
const elementRouteAwait = elementOutputBody.indexOf('await routeAudioSinkTarget');
const postRouteGenerationFence = elementOutputBody.indexOf(
  'if (this.elementOutputGenerations.get(el) !== generation) return;', elementRouteAwait,
);
const firstElementOutputIncident = elementOutputBody.indexOf('this.recordVoiceOutputFailure');
assert.ok(
  elementRouteAwait >= 0 && postRouteGenerationFence > elementRouteAwait
    && firstElementOutputIncident > postRouteGenerationFence,
  'a route superseded while its browser promise was pending cannot emit a stale output incident',
);
assert.match(elementOutputBody, /routeAudioSinkTarget\(el, requested, \{/,
  'attached voice and stream elements use the same bounded hardware output router');
assert.match(elementOutputBody, /audioSinkRoutesConfirmed\(requested, \[outcome\]\)[\s\S]*outcome === 'unsupported'[\s\S]*routeAudioSinkTarget\(el, 'default'/,
  'unsupported confirms only system default; a custom element route records failure and falls back');
assert.match(elementOutputBody, /recordVoiceOutputFailure\([\s\S]*requested === 'default',[\s\S]*routeAudioSinkTarget\(el, 'default'[\s\S]*submitVoiceDiagnostic\('output_route_failed'\)/,
  'element diagnostics include both the custom failure and the system fallback result');
assert.match(engine, /private retryAttachedOutputRoutesAfterForeground[\s\S]*switchElementOutput\(el, requested, true, forceRefresh\)/,
  'a real foreground edge grants one forced retry to a previously failed attached output route');
const foregroundOutputRetry = engine.match(/private retryAttachedOutputRoutesAfterForeground\(\)[\s\S]*?\n  }\n\n  private ensureInputLifecycleListener/)?.[0] || '';
assert.match(foregroundOutputRetry, /now - this\.lastForegroundOutputRetryAt < 1_000[\s\S]*forceRefresh = this\.outputDeviceRefreshPending[\s\S]*switchContextOutput\(requested, false, forceRefresh\)/,
  'the paired foreground events grant one bounded retry to the audible context and tree routes');
assert.equal((foregroundOutputRetry.match(/switchContextOutput\(requested, false, forceRefresh\)/g) || []).length, 1,
  'one physical foreground edge starts exactly one context/tree route retry');
assert.match(engine, /remoteAudioResumeHandler = \(\) => \{[\s\S]*retryAttachedOutputRoutesAfterForeground\(\)[\s\S]*ensureRemoteAudioPlayback\(\)/,
  'foreground retries hardware routing before resuming exact media playback');
const remotePlaybackBody = engine.match(/private resumeRemoteAudioPlayback\([\s\S]*?\n  }\n  private startRoomAudio/)?.[0] || '';
assert.match(remotePlaybackBody, /room\.canPlaybackAudio === false/,
  'a healthy watchdog does not call Room.startAudio again');
assert.match(remotePlaybackBody, /!explicitGesture && !el\.paused/,
  'a healthy watchdog does not call play on an already playing element');
const ensureVoicePlaybackBody = engine.match(/private ensureRemoteVoicePlayback\([\s\S]*?\n  }\n  private onRemotePub/)?.[0] || '';
assert.equal((ensureVoicePlaybackBody.match(/configureVoiceAudio\(entry, p!\)/g) || []).length, 1,
  'steady reconciliation configures output only when an exact audio element is attached');
assert.doesNotMatch(engine, /await ctx\.setSinkId|await setSinkId\.call/,
  'no raw browser sink promise can hold the Engine output queues forever');
assert.match(engine, /onSeamlessSwitchFailed\?\.\(\(sid\) => \{[\s\S]*finishStreamWatchDiagnostic\(sid, 'stream_watch_failed',[\s\S]*watch_recovery[\s\S]*decode_timeout[\s\S]*this\.closeWatch\(sid\)/,
  'a failed seamless switch persists its exact timeout before clearing ownership for a retry');
const watchBody = engine.match(/watch\(identity: string, quality: string = 'source'\)[\s\S]*?\n  }\n  closeWatch/)?.[0] || '';
assert.doesNotMatch(watchBody, /localStorage\./,
  'blocked mobile storage cannot strand a pending stream watch');
assert.ok(watchBody.indexOf('this.watchTimers.set(identity, timer)') < watchBody.indexOf('safeLocalStorageGet'),
  'the exact stream watchdog is armed before optional first-use tip persistence');
const screenGainBody = engine.match(/private applyScreenAudioGain\([\s\S]*?\n  }\n  private applyAllStreamVolumes/)?.[0] || '';
assert.match(screenGainBody, /setVolume\(gain, Track\.Source\.ScreenShareAudio\)/,
  'LiveKit owns screen-audio gain through its exact source');
assert.doesNotMatch(screenGainBody, /entry\.el\.(?:muted|volume)\s*=/,
  'the SDK-muted element cannot become a second audio path around webAudioMix');
assert.doesNotMatch(engine, /screenAudioEls\.forEach\(\(\{ el \}\) => \(el\.muted = false\)\)/,
  'leaving voice cannot reopen a direct screen-audio path around LiveKit gain');
assert.match(sounds, /routeAudioSinkTarget\(a, want \|\| 'default', \{ normalize: resolveSink, force \}\)/,
  'notification sounds share the bounded, late-result-safe hardware output router');
assert.match(sounds, /function wakeAndRefreshOutput[\s\S]*if \(sinkRefreshPending\) \{[\s\S]*applySink\(true\)/,
  'a matching foreground edge consumes the deferred notification-output refresh');
assert.match(sounds, /addEventListener\?\.\('devicechange',[\s\S]*if \(document\.hidden\) \{[\s\S]*sinkRefreshPending = true;[\s\S]*return;[\s\S]*applySink\(true\)/,
  'a hidden device change never calls the native output switch until foreground');
assert.match(sounds, /actx = new AudioContext\(\);[\s\S]*seedAudioSinkTargetRoute\(actx\)/,
  'a fresh notification mixer records its natural system-default route before Settings reconciliation');
assert.doesNotMatch(sounds, /await a\.setSinkId!?\(/,
  'a browser setSinkId promise cannot permanently poison the notification-sound queue');
assert.match(sounds, /if \(\(getSettings\(\)\.output \|\| ''\) !== lastSink\) void applySink\(\)/,
  'the next sound retries a transient output-route fallback without waiting for another settings event');
assert.match(sounds, /SOUND_FETCH_TIMEOUT_MS = 8_000[\s\S]*AbortController[\s\S]*controller\.abort\(\)/,
  'a stalled sound fetch/body is aborted and cannot pin the preload slot forever');
assert.match(sounds, /boundedSoundOperation\(ctx\(\)\.decodeAudioData\(arr\), SOUND_DECODE_TIMEOUT_MS\)/,
  'a never-settling WebKit decode is bounded so a later sound can retry');
assert.match(sounds, /AudioUnlockGestureDeduper[\s\S]*wakeFromGesture[\s\S]*observeSoundContextResume\(actx, true\)/,
  'notification-sound unlocks dedupe compatibility events and share exact resume ownership');
assert.match(sounds, /acquireExactAudioContextResume\(context, explicitGesture, flushPendingResumeSound\)/,
  'notification sounds observe the exact coordinated resume outcome');
assert.doesNotMatch(sounds, /\bc\.resume\?\.\(/,
  'notification playback cannot bypass the coordinator with a raw resume call');
assert.match(tree, /if \(track\.kind === 'video'\)[\s\S]*addVideo/,
  'audio-only progress must not complete a pending video watch');
assert.match(serverView, /onPlaybackReady: retry/,
  'a shared AudioContext recovery retries the exact tile instead of blindly hiding its overlay');
assert.match(serverView, /onOutputRouteFailure:[\s\S]*currentEngine !== E[\s\S]*return false[\s\S]*currentEngine\.applyOutput\(\)/,
  'a future tree tile that cannot inherit Settings re-runs the authoritative aggregate fallback');
assert.match(serverView, /const resumeStreamAudioFromGesture = \(\) => \{[\s\S]*?void attemptPlayback\(true\);[\s\S]*?\n  \};/,
  'fullscreen and PiP gestures confirm exact video and audio instead of hiding the overlay on audio alone');
assert.match(serverView, /controller\.resume\(1_500, explicitGesture\)/,
  'the exact tree mixer distinguishes watchdog attempts from synchronous user-gesture recovery');
assert.match(serverView, /playMediaElementCoordinated\(videoPlayCoordinatorRef\.current, v, explicitGesture\)/,
  'all readiness, foreground and Retry paths share one exact raw video.play owner');
assert.match(serverView, /videoPlayCoordinatorRef\.current\.forget\(v\)[\s\S]*detach\(v\)/,
  'detaching an exact stream tile fences its late video.play settlement');
assert.match(serverView, /armStreamVolumeGesture[\s\S]*streamVolumeGesturePendingRef\.current = true[\s\S]*changeStreamVolume[\s\S]*streamVolumeGesturePendingRef\.current = false[\s\S]*setVol\(value, explicitGesture\)/,
  'one physical slider activation spends at most one gesture lane while drag updates stay ordinary');
assert.match(serverView, /window\.addEventListener\('pageshow', retry\)/,
  'a restored standalone PWA retries the same exact playback path as a foreground tab');
assert.match(serverView, /document\.addEventListener\('visibilitychange', visible\)/,
  'a foreground browser tab retries playback after background suspension');
const streamTileBody = serverView.match(/function StreamTile\([\s\S]*?\/\* ---------- Activity card/)?.[0] || '';
assert.doesNotMatch(streamTileBody, /display-mode|navigator\.standalone/,
  'browser tabs and standalone PWAs do not diverge into separate playback recovery branches');
const readinessHandler = serverView.match(/const playable = \(\) => \{[\s\S]*?\n    };/)?.[0] || '';
assert.doesNotMatch(readinessHandler, /confirmWatchPlayback/,
  'loadeddata/canplay readiness cannot falsely confirm actual playback');

console.log('stream playback: ok');

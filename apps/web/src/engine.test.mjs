import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('engine.ts', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type) { for (const fn of this.listeners.get(type) || []) fn({ type }); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class MediaTrack extends Events {
  readyState = 'live'; muted = false; enabled = true;
  stop() { this.readyState = 'ended'; }
  getSettings() { return { sampleRate: 48000, channelCount: 1 }; }
}
class Stream {
  constructor(tracks = [new MediaTrack()]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
class Param {
  value = 0; timeline = []; writes = 0; maxPending = 0;
  cancelScheduledValues() { this.timeline = []; }
  setValueAtTime(value, at) { this.write(value, at); }
  setTargetAtTime(value, at) { this.write(value, at); }
  write(value, at) {
    this.value = value; this.writes++; this.timeline.push({ value, at });
    this.maxPending = Math.max(this.maxPending, this.timeline.length);
  }
}
class AudioNode {
  gain = new Param();
  connect() {} disconnect() {}
}

function fixture(engineSource = source, costs = {}) {
  let time = 1000, timerId = 1, captureCalls = 0;
  const timers = new Map();
  const schedule = (fn, delay = 0, repeat = false) => {
    const id = timerId++; timers.set(id, { fn, at: time + delay, repeat }); return id;
  };
  const delay = async (stage) => {
    const ms = costs[stage] || 0;
    if (ms) await new Promise((resolve) => schedule(resolve, ms));
  };
  const settings = { input: '', output: '', nsMode: 'off', mode: 'voice', sensitivityAuto: false, sensitivity: 10, master: 100 };
  const document = new Events(); document.hidden = false;
  document.querySelectorAll = () => []; document.getElementById = () => null;
  const devices = new Events();
  let capture = async () => { await delay('capture'); return new Stream(); };
  devices.getUserMedia = (...args) => { captureCalls++; return capture(...args); };
  const storage = new Map();
  class Context extends Events {
    state = 'running'; currentTime = 0; sampleRate = 48000; destination = new AudioNode();
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createGain() { return new AudioNode(); }
    createMediaStreamSource() { return new AudioNode(); }
    createMediaStreamDestination() { return Object.assign(new AudioNode(), { stream: new Stream() }); }
    createChannelSplitter() { return new AudioNode(); }
  }
  class LocalAudioTrack {
    isMuted = false;
    constructor(mediaStreamTrack) { this.mediaStreamTrack = mediaStreamTrack; }
    async mute() { this.isMuted = true; }
    async unmute() { this.isMuted = false; }
    stop() { this.mediaStreamTrack.stop(); }
  }
  class Transport {
    onVideoTrack() {} onVideoTrackRemoved() {} onStreamStart() {} onStreamStop() {}
    setBroadcastRoom() {} getStreams() { return []; } detach() {}
  }
  const api = {
    async mintVoiceIntent() { await delay('ticket'); return { accepted: true, ticket: 1 }; },
    async claimVoiceLease(sessionId, serverId, channelId) {
      await delay('claim');
      return { t: 'voice-lease', accepted: true, reason: 'claimed', currentEpoch: 1, lease: { sessionId, serverId, channelId, epoch: 1 } };
    },
    async releaseVoiceLease() {},
  };
  const dependencies = {
    'livekit-client': { Room: class {}, RoomEvent: {}, Track: { Source: { Microphone: 'microphone', ScreenShareAudio: 'screen_audio' }, Kind: { Audio: 'audio' } }, LocalAudioTrack, AudioPresets: { musicHighQuality: {} }, ConnectionQuality: {} },
    './windowIdle': { isWindowIdle: () => false, onWindowIdle: () => () => {} },
    './util': { baseUid: (identity) => identity.split('#')[0] },
    './notify': { notify() {} }, './api': { api },
    './native': { isTauri: false },
    './settings': { getSettings: () => settings, setSettings: (next) => Object.assign(settings, next) },
    './emotes': {}, './sounds': { playSound() {} },
    './transport/livekitVideo': { LiveKitVideoTransport: Transport },
    './transport/treeVideo': { TreeVideoTransport: Transport },
    './denoise': { createDenoiseNode: async () => { await delay('denoise'); return new AudioNode(); }, destroyDenoiseNode() {} },
    './vad': { createVadNode: async () => null, destroyVadNode() {} },
    './volumeCurve': { userVolumeToGain: (value) => value },
    './chatScroll': { CHAT_SESSION_MESSAGE_LIMIT: 500 },
    './microphoneAudioContext': { createMicrophoneAudioContext: () => new Context() },
    './voiceDiagnostics': {
      VoiceDiagnosticsRecorder: class { active = false; start() { this.active = true; } record() {} reset() { this.active = false; } buildReport() { return {}; } },
      VoiceEventLoopStallMonitor: class { start() {} stop() {} },
    },
    './diagnosticOutbox': { DiagnosticReportOutbox: class { start() {} dispose() {} enqueue() {} } },
    './voiceDiagnosticStats': { summarizeVoiceDiagnosticStats: () => ({ state: {}, event: { kind: 'rtc_sample' } }) },
  };
  const exported = {};
  const js = ts.transpileModule(engineSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const window = {
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: (id) => timers.delete(id),
    addEventListener() {}, removeEventListener() {},
  };
  vm.runInNewContext(js, {
    exports: exported,
    require: (id) => { assert.ok(id in dependencies, `unmocked engine dependency ${id}`); return dependencies[id]; },
    console, TextEncoder, TextDecoder, Uint8Array, Map, Set, WeakMap, WeakSet, Promise,
    performance: { now: () => time }, Date, document, window,
    navigator: { mediaDevices: devices },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    AudioContext: Context, MediaStream: Stream,
    requestAnimationFrame: (fn) => schedule(fn, 16), cancelAnimationFrame: (id) => timers.delete(id),
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    setInterval: window.setInterval, clearInterval: window.clearInterval,
  }, { filename: 'engine.ts' });
  const e = new exported.Engine({ id: 'me', username: 'me', displayName: 'Me' }, { toast() {}, saveSettings() {}, peerJoined() {}, persistMessage() {} });
  // UI rendering and audio hardware are outside these state/race tests.
  e.emit = () => {};
  e.attachAnalyser = () => {};
  e.ensureVoiceAudioRunning = () => {};
  e.setupVadWorklet = async () => {};
  const publication = { track: null };
  const localParticipant = {
    identity: 'me#session', attributes: {},
    getTrackPublication: () => publication.track ? publication : undefined,
    async setAttributes(next) { await delay('attributes'); Object.assign(this.attributes, next); },
    async publishTrack(track) { await delay('publish'); publication.track = track; return publication; },
    async unpublishTrack(track) { if (publication.track === track) publication.track = null; track.stop(); },
    async publishData() {},
  };
  const room = { localParticipant, remoteParticipants: new Map(), canPlaybackAudio: true, async startAudio() {}, async disconnect() {} };
  function activeVoice(track = new LocalAudioTrack(new MediaTrack())) {
    e.inVoice = true; e.voiceRoom = room; e.viewRoom = room; e.viewServerId = 'server'; e.voiceServerId = 'server';
    e.currentVc = 'channel'; e.voiceEpoch = 1; e.voiceLeaseEpoch = 1; e.voiceLeaseSession = 'session'; e.voiceLeaseChannel = 'channel';
    e.readyRooms.add(room); e.micLevelAt = time; e.vadOpen = true;
    publication.track = track;
    return e;
  }
  async function finish(promise) {
    let done = false, value, error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    for (let i = 0; i < 100 && !done; i++) {
      await flush();
      if (done) break;
      const next = [...timers.entries()].filter(([, task]) => !task.repeat).sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'pending operation has no runnable timer');
      timers.delete(next[0]); time = next[1].at; next[1].fn();
    }
    assert.ok(done, 'operation exceeded simulated timer budget');
    if (error) throw error;
    return value;
  }
  return { e, room, publication, settings, document, devices, Context, LocalAudioTrack, activeVoice, finish, timers,
    setCapture(fn) { capture = fn; }, get captureCalls() { return captureCalls; },
    get time() { return time; }, advance(ms) { time += ms; },
  };
}

function installGate(f) {
  const param = new Param(); f.e.micActx = new f.Context(); f.e.micGain = { gain: param }; f.e.micGateTarget = null;
  return param;
}

// A manual mute closes local audio synchronously while SDK signaling is still pending.
{
  const f = fixture(); f.activeVoice(); const param = installGate(f); f.e.applyGate();
  const pending = deferred(); let writes = 0;
  f.publication.track.mute = async function () { writes++; await pending.promise; this.isMuted = true; };
  await f.e.toggleMic();
  assert.equal(param.value, 0); assert.equal(f.e.manualMute, true);
  await flush(); assert.equal(writes, 1);
  await f.e.toggleMic(); await f.e.toggleMic();
  pending.resolve(); await flush();
  assert.equal(f.e.manualMute, true); assert.equal(f.publication.track.isMuted, true);
  assert.equal(writes, 1, 'rapid clicks share one pending SDK mute');
}

// Rapid mute/deafen changes converge to the latest intent, never overlapping SDK writes.
{
  const f = fixture(); f.activeVoice(); installGate(f);
  const pending = deferred(); let active = 0, maxActive = 0;
  const track = f.publication.track;
  track.mute = async function () { maxActive = Math.max(maxActive, ++active); await pending.promise; this.isMuted = true; active--; };
  track.unmute = async function () { maxActive = Math.max(maxActive, ++active); this.isMuted = false; active--; };
  await f.e.toggleMic(); await flush();
  f.e.toggleDeaf(); await f.e.toggleMic(); f.e.toggleDeaf();
  pending.resolve(); await flush();
  assert.equal(f.e.manualMute, false); assert.equal(f.e.deafened, false); assert.equal(track.isMuted, false);
  assert.equal(maxActive, 1);
}

// A mute click during getUserMedia survives device recovery and is applied before publishing.
{
  const f = fixture(); f.activeVoice(null); f.e.noMic = true;
  const capture = deferred(); f.setCapture(() => capture.promise);
  const retry = f.e.toggleMic(); await flush();
  assert.equal(f.captureCalls, 1);
  await f.e.toggleMic();
  capture.resolve(new Stream()); await retry; await flush();
  assert.equal(f.e.manualMute, true);
  assert.equal(f.publication.track.isMuted, true);
  assert.equal(f.e.micGain.gain.value, 0);
  assert.equal(f.captureCalls, 1);
  await f.e.stopMic();
}

// Duplicate starts cannot acquire and publish two microphones for one voice intent.
{
  const f = fixture(); f.activeVoice(null);
  const capture = deferred(); f.setCapture(() => capture.promise);
  const one = f.e.startMic(); const two = f.e.startMic(); await flush();
  assert.equal(f.captureCalls, 1);
  capture.resolve(new Stream());
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  await f.e.stopMic();
}

// A hidden voice-activated mic opens immediately; mute/PTT/ownership still take precedence.
{
  const f = fixture(); f.e.viewRoom = f.room; f.e.viewServerId = 'server'; f.e.readyRooms.add(f.room);
  const oldCapture = deferred(); let captures = 0;
  f.setCapture(() => ++captures === 1 ? oldCapture.promise : Promise.resolve(new Stream()));
  const join = f.e.joinVoice('channel'); await flush();
  assert.equal(captures, 1);
  await f.e.reapplyMic(); await join;
  assert.equal(f.e.voiceConnecting, false, 'device replacement must complete the pending channel join');
  assert.ok(f.publication.track); assert.equal(captures, 2);
  const lateStream = new Stream(); oldCapture.resolve(lateStream); await flush();
  assert.equal(lateStream.getTracks()[0].readyState, 'ended');
  assert.equal(f.publication.track.mediaStreamTrack.readyState, 'live');
  await f.e.stopMic();
}

// A hidden voice-activated mic opens immediately; mute/PTT/ownership still take precedence.
{
  const f = fixture(); f.activeVoice(); const param = installGate(f); f.e.vadOpen = false;
  f.e.applyGate(); assert.equal(param.value, 0);
  f.document.hidden = true; f.e.onVisible(); assert.equal(param.value, 1);
  assert.equal(f.timers.size, 0, 'background gate cannot depend on a future timer');
  f.e.manualMute = true; f.e.applyGate(); assert.equal(param.value, 0);
  f.e.manualMute = false; f.settings.mode = 'ptt'; f.e.pttDown = true;
  f.e.onVisible(); assert.equal(f.e.pttDown, false); assert.equal(param.value, 0);
  f.settings.mode = 'voice'; f.e.voiceLeaseEpoch = 0; f.e.applyGate(); assert.equal(param.value, 0);
  f.e.voiceLeaseEpoch = 1; f.e.voiceReconnecting = true; f.e.applyGate(); assert.equal(param.value, 0);
}

// OS background interruption does not churn capture; foreground recovery can restart an ended track.
{
  const f = fixture(); f.activeVoice(); installGate(f);
  const raw = new MediaTrack(); raw.readyState = 'ended'; f.e.micRaw = new Stream([raw]);
  let starts = 0, stops = 0;
  f.e.startMic = async () => { starts++; return true; }; f.e.stopMic = async () => { stops++; };
  f.document.hidden = true;
  for (let i = 0; i < 120; i++) await f.e.checkMicAlive(true);
  assert.equal(starts, 0); assert.equal(stops, 0);
  f.document.hidden = false; await f.e.checkMicAlive(false);
  assert.equal(starts, 1); assert.equal(stops, 1);
}

// Audio listeners are removed on pipeline teardown, and device listeners on engine disposal.
{
  const f = fixture(); f.activeVoice(); const ctx = new f.Context();
  const raw = new MediaTrack(); const published = f.publication.track;
  f.e.micActx = ctx; f.e.micRaw = new Stream([raw]);
  f.e.watchMicHealth(raw, published, ctx, f.e.micEpoch);
  assert.equal(raw.listenerCount(), 3); assert.equal(published.mediaStreamTrack.listenerCount(), 3);
  await f.e.stopMic();
  assert.equal(raw.listenerCount(), 0); assert.equal(published.mediaStreamTrack.listenerCount(), 0); assert.equal(ctx.listenerCount(), 0);
  assert.equal(f.devices.listenerCount(), 1);
  f.e.disconnect(); await flush(); assert.equal(f.devices.listenerCount(), 0);
  f.e.startEngineObservers(); f.e.startEngineObservers();
  assert.equal(f.devices.listenerCount(), 1, 'reused Engine restores exactly one device listener');
}

// An old server echo cannot commit a voice intent replaced during the attribute write.
{
  const f = fixture(); f.activeVoice();
  const pending = deferred();
  f.room.localParticipant.setAttributes = async (attrs) => { await pending.promise; Object.assign(f.room.localParticipant.attributes, attrs); };
  const committed = f.e.commitVoiceAttributes(f.room, f.e.voiceEpoch, 'channel'); await flush();
  f.e.voiceEpoch++; f.e.currentVc = 'new-channel'; pending.resolve();
  assert.equal(await committed, false);
}

// Choosing another output while the old selection fails must converge without overlapping writes.
{
  const f = fixture(); f.settings.output = 'headphones';
  const pending = deferred(); const calls = []; let active = 0, maxActive = 0;
  const el = { isConnected: true, sinkId: '', async setSinkId(id) {
    calls.push(id); maxActive = Math.max(maxActive, ++active);
    try { if (id === 'headphones') await pending.promise; this.sinkId = id; } finally { active--; }
  } };
  const routed = f.e.routeAudioElement(el); await flush();
  f.settings.output = 'speakers'; f.e.routeAudioElement(el);
  pending.reject(new Error('device gone')); await routed;
  assert.equal(el.sinkId, 'speakers'); assert.equal(maxActive, 1);
  assert.deepEqual(calls, ['headphones', 'speakers']);
  await f.e.routeAudioElement(el); assert.equal(calls.length, 2, 'unchanged watchdog does not reselect hardware');
}

// Capture permission may outlive the stop button: a late stream must be stopped, never published.
{
  const f = fixture(); f.activeVoice();
  const pending = deferred(); f.devices.getDisplayMedia = () => pending.promise;
  let published = 0;
  f.e.liveKitT.isBroadcasting = () => false;
  f.e.liveKitT.startBroadcast = async () => { published++; };
  f.e.liveKitT.stopBroadcast = async () => {};
  const starting = f.e.share(); await f.e.stopShare();
  const stream = new Stream(); pending.resolve(stream); await starting;
  assert.equal(published, 0); assert.equal(stream.getTracks()[0].readyState, 'ended');
  assert.equal(f.e.screenStream, null); assert.equal(f.e.sharePending, false);
}

// Suspended Safari resume() may never resolve in background: it must not block capture setup.
{
  const f = fixture(); f.activeVoice(null);
  const ctx = new f.Context(); ctx.resume = () => new Promise(() => {}); f.e.micActx = ctx;
  await f.e.startMic(); assert.equal(f.captureCalls, 1); assert.ok(f.publication.track);
  await f.e.stopMic();
}

// Five simulated minutes of unchanged meter/watchdog updates must keep automation bounded.
function gateStress(engineSource) {
  const f = fixture(engineSource); f.activeVoice(); const param = installGate(f);
  for (let i = 0; i < 9_000; i++) { f.e.micLevelAt = f.time; f.e.applyGate(); f.advance(1000 / 30); }
  return { writes: param.writes, maxPending: param.maxPending };
}
const gate = gateStress(source);
assert.equal(gate.writes, 1); assert.equal(gate.maxPending, 1);

// BFCache/freezing keeps the call; a real exit saves the last report synchronously.
{
  const f = fixture(); let saved = 0, closed = 0, frozen = 0;
  f.e.diagnostics.start();
  f.e.diagnosticOutbox.enqueue = () => { saved++; };
  f.e.disconnect = () => { assert.equal(saved, 1); closed++; };
  f.e.onVoiceFreeze = () => { frozen++; };
  f.e.onVoicePageHide({ persisted: true });
  assert.equal(frozen, 1); assert.equal(saved, 0); assert.equal(closed, 0);
  f.e.onVoicePageHide({ persisted: false });
  assert.equal(saved, 1); assert.equal(closed, 1);
}

// Optional reproducible before/after simulation: not a real network/device latency measurement.
if (process.argv.includes('--benchmark')) {
  const baseline = execFileSync('git', ['show', '9c679c2:apps/web/src/engine.ts'], { encoding: 'utf8' });
  async function simulatedJoin(engineSource) {
    const f = fixture(engineSource, { ticket: 100, claim: 100, attributes: 50, capture: 100, denoise: 40, publish: 100 });
    f.settings.nsMode = 'rnnoise'; f.e.viewRoom = f.room; f.e.viewServerId = 'server'; f.e.readyRooms.add(f.room);
    const start = f.time; await f.finish(f.e.joinVoice('channel'));
    assert.equal(f.e.inVoice, true); assert.equal(f.e.voiceConnecting, false); assert.ok(f.publication.track);
    return { joinMs: f.time - start, captureCalls: f.captureCalls };
  }
  const before = await simulatedJoin(baseline), after = await simulatedJoin(source);
  assert.ok(after.joinMs <= before.joinMs, 'controlled join gained an extra sequential wait');
  console.log('controlled join simulation (mocked I/O):', JSON.stringify({ before, after }));
  console.log('5-minute gate simulation (9000 updates):', JSON.stringify({ before: gateStress(baseline), after: gate }));
}

console.log('voice engine control races and background lifecycle: ok');

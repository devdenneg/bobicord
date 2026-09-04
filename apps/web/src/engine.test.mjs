import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('engine.ts', import.meta.url), 'utf8');
const audioSessionJs = ts.transpileModule(readFileSync(new URL('appleMobileAudioSession.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const captureError = (name, constraint) => Object.assign(new Error(name), { name, ...(constraint ? { constraint } : {}) });

class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type) { for (const fn of this.listeners.get(type) || []) fn({ type }); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class AudioSession extends Events {
  state = 'active'; category = 'auto'; writes = [];
  get type() { return this.category; }
  set type(value) { this.category = value; this.writes.push(value); }
}
class MediaTrack extends Events {
  readyState = 'live'; muted = false; enabled = true;
  stop() { this.readyState = 'ended'; }
  getSettings() { return { sampleRate: 48000, channelCount: 1 }; }
  getConstraints() { return {}; }
  clone() { const track = new MediaTrack(); track.clonedFrom = this; return track; }
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
  connections = [];
  connect(node) { this.connections.push(node); } disconnect() { this.connections = []; }
}

function fixture(engineSource = source, costs = {}, options = {}) {
  let time = 1000, timerId = 1, captureCalls = 0, denoiseCalls = 0, inventoryRefreshes = 0;
  const sources = [], contexts = [], vadNodes = [], diagnosticEvents = [], reports = [];
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
  const navigator = { mediaDevices: devices, audioSession: options.audioSession };
  let capture = async () => { await delay('capture'); return new Stream(); };
  devices.getUserMedia = (...args) => { captureCalls++; return capture(...args); };
  const storage = new Map();
  class Context extends Events {
    state = 'running'; currentTime = 0; sampleRate = 48000; destination = new AudioNode();
    constructor() { super(); if (options.contextThrows) throw new Error('AudioContext unavailable'); this.state = options.suspended ? 'suspended' : 'running'; contexts.push(this); }
    async resume() { if (options.suspended) return new Promise(() => {}); this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createGain() { return new AudioNode(); }
    createMediaStreamSource(stream) {
      if (options.sourceThrows) throw new Error('Meter source unavailable');
      const src = new AudioNode(); src.stream = stream; src.context = this; sources.push(src); return src;
    }
    createAnalyser() { return Object.assign(new AudioNode(), { fftSize: 512, getByteTimeDomainData(buffer) { buffer.fill(options.levelByte ?? 128); } }); }
    createMediaStreamDestination() { return Object.assign(new AudioNode(), { stream: new Stream() }); }
    createChannelSplitter() { return new AudioNode(); }
  }
  class MockLocalAudioTrack extends Events {
    isMuted = false;
    constructor(mediaStreamTrack) {
      super(); this.mediaStreamTrack = mediaStreamTrack;
      // The actual SDK constructor takes a lock asynchronously, then restores enabled.
      Promise.resolve().then(() => { this.mediaStreamTrack.enabled = !this.isMuted; });
    }
    on(type, fn) { this.addEventListener(type, fn); }
    off(type, fn) { this.removeEventListener(type, fn); }
    emit(type) { this.fire(type); }
    async mute() { this.isMuted = true; this.mediaStreamTrack.enabled = false; this.emit('muted'); }
    async unmute() { this.isMuted = false; this.mediaStreamTrack.enabled = true; this.emit('unmuted'); }
    stop() { this.mediaStreamTrack.stop(); }
  }
  const LocalAudioTrack = options.sdkTrack || MockLocalAudioTrack;
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
    'livekit-client': { Room: class {}, RoomEvent: {}, Track: { Source: { Microphone: 'microphone', ScreenShareAudio: 'screen_audio' }, Kind: { Audio: 'audio' } }, TrackEvent: { Unmuted: 'unmuted' }, LocalAudioTrack, AudioPresets: { musicHighQuality: {} }, ConnectionQuality: {} },
    './windowIdle': { isWindowIdle: () => false, onWindowIdle: () => () => {} },
    './util': { baseUid: (identity) => identity.split('#')[0] },
    './notify': { notify() {} }, './api': { api },
    './native': { isTauri: false },
    './settings': { getSettings: () => settings, setSettings: (next) => Object.assign(settings, next) },
    './emotes': {}, './sounds': { playSound() {} },
    './transport/livekitVideo': { LiveKitVideoTransport: Transport },
    './transport/treeVideo': { TreeVideoTransport: Transport },
    './denoise': { createDenoiseNode: async () => { denoiseCalls++; await delay('denoise'); return new AudioNode(); }, destroyDenoiseNode() {} },
    './vad': { createVadNode: async () => {
      if (!options.vad) return null;
      const node = Object.assign(new AudioNode(), { port: {} }); const vad = { node, sink: new AudioNode() };
      vadNodes.push(vad); return vad;
    }, destroyVadNode(vad) { if (vad) vad.node.port.onmessage = null; } },
    './volumeCurve': { userVolumeToGain: (value) => value },
    './chatScroll': { CHAT_SESSION_MESSAGE_LIMIT: 500 },
    './microphoneAudioContext': { createMicrophoneAudioContext: () => new Context() },
    './audioDevices': { currentAppleMobilePlatform: () => !!options.appleMobile },
    './audioDeviceInventory': { notifyAudioCaptureChanged: () => { inventoryRefreshes++; } },
    './voiceDiagnostics': {
      VoiceDiagnosticsRecorder: class { active = false; start() { this.active = true; } record(event) { diagnosticEvents.push(event); } reset() { this.active = false; } buildReport(incident) { return { incident, events: diagnosticEvents.map((event) => ({ ...event })) }; } },
      VoiceEventLoopStallMonitor: class { start() {} stop() {} },
    },
    './diagnosticOutbox': { DiagnosticReportOutbox: class { start() {} dispose() {} enqueue(report) { reports.push(report); } } },
    './voiceDiagnosticStats': { summarizeVoiceDiagnosticStats: () => ({ state: {}, event: { kind: 'rtc_sample' } }) },
  };
  const audioSessionExports = {};
  vm.runInNewContext(audioSessionJs, { exports: audioSessionExports, navigator, require: (id) => dependencies[id] });
  dependencies['./appleMobileAudioSession'] = audioSessionExports;
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
    navigator,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    AudioContext: Context, MediaStream: Stream,
    requestAnimationFrame: (fn) => schedule(fn, 16), cancelAnimationFrame: (id) => timers.delete(id),
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    setInterval: window.setInterval, clearInterval: window.clearInterval,
  }, { filename: 'engine.ts' });
  const e = new exported.Engine({ id: 'me', username: 'me', displayName: 'Me' }, { toast() {}, saveSettings() {}, peerJoined() {}, persistMessage() {} });
  // UI rendering and audio hardware are outside these state/race tests.
  e.emit = () => {};
  if (!options.audioGraph) {
    e.attachAnalyser = () => {};
    e.ensureVoiceAudioRunning = () => {};
    e.setupVadWorklet = async () => {};
  }
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
  return { e, room, publication, settings, document, devices, navigator, api, Context, LocalAudioTrack, activeVoice, finish, timers, sources, contexts, vadNodes, diagnosticEvents, reports,
    setCapture(fn) { capture = fn; }, get captureCalls() { return captureCalls; },
    get denoiseCalls() { return denoiseCalls; },
    get inventoryRefreshes() { return inventoryRefreshes; },
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
// iOS sends a raw clone; the actual Engine analyser/worklet wiring only observes raw.
{
  const f = fixture(source, {}, { appleMobile: true, audioGraph: true, vad: true }); f.activeVoice(null);
  const raw = new MediaTrack(); const stream = new Stream([raw]);
  f.settings.nsMode = 'rnnoise';
  f.setCapture(async ({ audio }) => { assert.equal(audio.noiseSuppression, true); return stream; });
  const publish = f.room.localParticipant.publishTrack;
  f.room.localParticipant.publishTrack = async (track) => {
    assert.equal(track.mediaStreamTrack.enabled, false, 'clone stays silent until publication commits');
    assert.equal(track.isMuted, true, 'SDK state, not just raw enabled, must be muted before publish');
    return publish(track);
  };
  await f.e.startMic(); await flush();
  const clone = f.publication.track.mediaStreamTrack;
  assert.notEqual(clone, raw); assert.equal(clone.clonedFrom, raw); assert.equal(f.e.micDirectTrack, clone);
  assert.equal(f.e.micGain, null); assert.equal(f.e.micVadDest, null); assert.equal(f.denoiseCalls, 0);
  assert.ok(f.diagnosticEvents.filter((event) => event.kind === 'mic_capture_finished' || event.kind === 'mic_published').every((event) => event.micCapturePath === 'direct'));
  assert.equal(clone.enabled, true, 'missing first VAD sample cannot block direct capture');
  assert.equal(f.sources.length, 2);
  assert.ok(f.sources.every((src) => src.stream.getAudioTracks()[0] === raw), 'both meter taps listen to raw, never to the gated clone');
  assert.ok(f.sources[0].connections.includes(f.vadNodes[0].node));
  f.e.vadOpen = false;
  f.vadNodes[0].node.port.onmessage({ data: 0 });
  assert.equal(clone.enabled, false); assert.equal(raw.enabled, true, 'closed VAD cannot silence its own input');
  f.vadNodes[0].node.port.onmessage({ data: 0.2 });
  assert.equal(clone.enabled, true); assert.equal(f.e.speakingSet.has('me'), true);
  f.advance(500); f.vadNodes[0].node.port.onmessage({ data: 0 });
  assert.equal(clone.enabled, false); assert.equal(f.e.speakingSet.has('me'), false);
  f.document.hidden = true; f.e.onVisible(); assert.equal(clone.enabled, true);
  f.e.manualMute = true; f.e.applyGate(); assert.equal(clone.enabled, false);
  f.e.manualMute = false; f.e.deafened = true; f.e.applyGate(); assert.equal(clone.enabled, false);
  f.e.deafened = false; f.settings.mode = 'ptt'; f.e.applyGate(); assert.equal(clone.enabled, false);
  f.e.pttDown = true; f.e.applyGate(); assert.equal(clone.enabled, true);
  f.e.onVisible(); assert.equal(clone.enabled, false, 'background releases PTT');
  f.settings.mode = 'voice'; f.e.voiceLeaseEpoch = 0; f.e.applyGate(); assert.equal(clone.enabled, false);
  f.e.voiceLeaseEpoch = 1; f.e.voiceReconnecting = true; f.e.applyGate(); assert.equal(clone.enabled, false);
  assert.equal(raw.enabled, true);
  const unpublish = deferred(); f.room.localParticipant.unpublishTrack = () => unpublish.promise;
  const stopping = f.e.stopMic();
  assert.equal(raw.readyState, 'ended'); assert.equal(clone.readyState, 'ended');
  assert.equal(clone.enabled, false, 'stop silences both tracks without waiting for network');
  unpublish.resolve(); await stopping;
  assert.equal(f.contexts[0].state, 'closed'); assert.equal(raw.listenerCount(), 0);
}

// Safari meter context is optional: suspended/pending resume, constructor or source failure
// cannot prevent direct publish or trigger repeated recapture of a live microphone.
for (const failure of [{ suspended: true }, { contextThrows: true }, { sourceThrows: true }]) {
  const f = fixture(source, {}, { appleMobile: true, audioGraph: true, vad: true, ...failure }); f.activeVoice(null);
  f.e.prepareVoiceAudio();
  assert.equal(await f.e.startMic(), true); await flush();
  const raw = f.e.micRaw.getAudioTracks()[0], clone = f.e.micDirectTrack;
  assert.equal(clone.clonedFrom, raw); assert.equal(clone.enabled, true); assert.equal(f.e.noMic, false);
  f.e.vadOpen = false; f.e.micLevelAt = f.time; f.e.applyLocalLevel(0); f.e.applyGate();
  assert.equal(clone.enabled, true, 'suspended/missing meter is not evidence of silence');
  for (let i = 0; i < 12; i++) await f.e.checkMicAlive(true);
  assert.equal(f.captureCalls, 1, 'meter state is not a capture failure');
  f.e.manualMute = true; f.e.applyGate(); assert.equal(clone.enabled, false);
  assert.equal(raw.enabled, true);
  await f.e.stopMic();
}

// A delayed SDK unmute writes enabled=true itself; restore the latest local gate afterwards.
{
  const f = fixture(source, {}, { appleMobile: true }); f.activeVoice(null); f.e.manualMute = true;
  await f.e.startMic(); await flush();
  const clone = f.e.micDirectTrack, raw = f.e.micRaw.getAudioTracks()[0];
  const pending = deferred();
  f.publication.track.unmute = async function () { await pending.promise; this.isMuted = false; this.mediaStreamTrack.enabled = true; };
  await f.e.toggleMic(); await flush();
  f.e.voiceLeaseVerifying = true; f.e.applyGate(); assert.equal(clone.enabled, false);
  pending.resolve(); await flush();
  assert.equal(f.publication.track.isMuted, false); assert.equal(clone.enabled, false, 'late SDK unmute cannot bypass ownership gate');
  f.e.voiceLeaseVerifying = false; f.settings.mode = 'ptt'; f.e.applyGate(); assert.equal(clone.enabled, false);
  await f.e.toggleMic(); await flush();
  await f.e.toggleMic(); await flush();
  assert.equal(clone.enabled, false, 'SDK unmute cannot bypass unpressed PTT');
  assert.equal(raw.enabled, true);
  await f.e.stopMic();
}

// A direct pipeline cannot continue if the SDK refuses its initial safety mute.
{
  const f = fixture(source, {}, { appleMobile: true }); f.activeVoice(null);
  const raw = new MediaTrack(); f.setCapture(async () => new Stream([raw]));
  f.LocalAudioTrack.prototype.mute = async () => { throw new Error('SDK mute failed'); };
  await assert.rejects(f.e.startMic(), /SDK mute failed/);
  assert.equal(f.publication.track, null); assert.equal(raw.readyState, 'ended');
  assert.equal(f.e.micDirectTrack, null); assert.ok(f.contexts.every((ctx) => ctx.state === 'closed'));
}

// A delayed SDK unmute after stop cannot re-enable the old clone once its listener is removed.
{
  const f = fixture(source, {}, { appleMobile: true }); f.activeVoice(null); f.e.manualMute = true;
  await f.e.startMic(); await flush();
  const clone = f.e.micDirectTrack, track = f.publication.track;
  const pending = deferred();
  track.unmute = async function () {
    await pending.promise; this.isMuted = false; this.mediaStreamTrack.enabled = true; this.emit('unmuted');
  };
  await f.e.toggleMic(); await flush();
  // Leave the old publication accessible while unpublish is pending: exact clone ownership,
  // not publication lookup alone, must still prevent its late write from sticking.
  const unpublish = deferred(); f.room.localParticipant.unpublishTrack = () => unpublish.promise;
  const stopping = f.e.stopMic();
  pending.resolve(); await flush();
  assert.equal(clone.enabled, false); assert.equal(clone.readyState, 'ended');
  assert.equal(track.listenerCount(), 0);
  unpublish.resolve(); await stopping;
}

// Preview ownership is released before call capture, even when its permission result is late.
{
  const f = fixture(source, {}, { appleMobile: true });
  const preview = new Stream(); f.e.levelStream = preview; f.e.levelCtx = new f.Context();
  f.setCapture(async () => { assert.equal(preview.getAudioTracks()[0].readyState, 'ended'); return new Stream(); });
  f.activeVoice(null); await f.e.startMic(); await f.e.stopMic();
}
{
  const f = fixture(source, {}, { appleMobile: true });
  const pending = deferred(); let calls = 0;
  f.setCapture(() => ++calls === 1 ? pending.promise : Promise.resolve(new Stream()));
  f.e.levelListeners.add(() => {});
  const previewStart = f.e.startLevelMeter();
  f.activeVoice(null); await f.e.startMic();
  const clone = f.e.micDirectTrack, late = new Stream(); pending.resolve(late); await previewStart;
  assert.equal(late.getAudioTracks()[0].readyState, 'ended'); assert.equal(clone.readyState, 'live');
  assert.equal(f.e.levelStream, null); await f.e.stopMic();
}

// Direct capture still recovers real ended hardware in foreground, never while hidden.
{
  const f = fixture(source, {}, { appleMobile: true, suspended: true }); f.activeVoice(null);
  await f.e.startMic(); await flush();
  f.e.micRaw.getAudioTracks()[0].stop(); f.document.hidden = true;
  await f.e.checkMicAlive(true); assert.equal(f.captureCalls, 1);
  f.document.hidden = false; await f.e.checkMicAlive(false); assert.equal(f.captureCalls, 2);
  await f.e.stopMic();
}

// Pending direct publication cannot leak audio, revive after leave, or discard a later mute.
{
  const f = fixture(source, {}, { appleMobile: true }); f.activeVoice(null);
  const pending = deferred(); let publishing;
  f.room.localParticipant.publishTrack = async (track) => { publishing = track; await pending.promise; f.publication.track = track; };
  const start = f.e.startMic(); await flush();
  const clone = publishing.mediaStreamTrack, raw = clone.clonedFrom;
  assert.equal(clone.enabled, false); assert.equal(raw.enabled, true);
  await f.e.toggleMic(); pending.resolve(); assert.equal(await start, true); await flush();
  assert.equal(clone.enabled, false); assert.equal(publishing.isMuted, true);
  await f.e.stopMic();
}
{
  const f = fixture(source, {}, { appleMobile: true }); f.activeVoice(null);
  const pending = deferred(); let publishing;
  f.room.localParticipant.publishTrack = async (track) => { publishing = track; await pending.promise; f.publication.track = track; };
  const start = f.e.startMic(); await flush();
  const clone = publishing.mediaStreamTrack, raw = clone.clonedFrom;
  await f.e.stopMic(); assert.equal(await start, false);
  pending.resolve(); await flush();
  assert.equal(raw.readyState, 'ended'); assert.equal(clone.readyState, 'ended');
  assert.equal(f.publication.track, null); assert.equal(f.e.micDirectTrack, null);
}

// A missing optional WebAudio implementation does not abort the full channel join on iOS.
{
  const f = fixture(source, {}, { appleMobile: true, contextThrows: true, audioGraph: true });
  f.e.viewRoom = f.room; f.e.viewServerId = 'server'; f.e.readyRooms.add(f.room);
  await f.e.joinVoice('channel');
  assert.equal(f.e.voiceConnecting, false); assert.equal(f.e.noMic, false);
  assert.equal(f.e.micDirectTrack.enabled, true); assert.equal(f.captureCalls, 1);
  await f.e.stopMic();
}

// A replacement owns its prepared iOS meter; late capture cannot close that newer context.
{
  const f = fixture(source, {}, { appleMobile: true, suspended: true }); f.activeVoice(null);
  f.e.prepareVoiceAudio(); const oldContext = f.e.micActx;
  const pending = deferred(); let calls = 0;
  f.setCapture(() => ++calls === 1 ? pending.promise : Promise.resolve(new Stream()));
  const first = f.e.startMic(); await flush();
  assert.equal(f.e.micActx, null, 'in-flight pipeline owns its prepared context locally');
  await f.e.reapplyMic(); assert.equal(await first, false);
  const currentContext = f.e.micActx, clone = f.e.micDirectTrack;
  assert.notEqual(currentContext, oldContext); assert.equal(clone.enabled, true);
  const late = new Stream(); pending.resolve(late); await flush();
  assert.equal(oldContext.state, 'closed'); assert.equal(currentContext.state, 'suspended');
  assert.equal(late.getAudioTracks()[0].readyState, 'ended'); assert.equal(clone.readyState, 'live');
  assert.equal(f.e.micActx, currentContext); assert.equal(f.e.micDirectTrack, clone);
  await f.e.stopMic(); assert.equal(currentContext.state, 'closed');
}

// Other platforms retain the processed graph and RNNoise, not an accidentally raw publication.
{
  const f = fixture(); f.activeVoice(null); f.settings.nsMode = 'rnnoise';
  await f.e.startMic();
  assert.equal(f.denoiseCalls, 1); assert.equal(f.e.micDirectTrack, null);
  assert.ok(f.diagnosticEvents.filter((event) => event.kind === 'mic_capture_finished' || event.kind === 'mic_published').every((event) => event.micCapturePath === 'webaudio'));
  assert.ok(f.e.micGain); assert.notEqual(f.publication.track.mediaStreamTrack, f.e.micRaw.getAudioTracks()[0]);
  assert.equal(f.publication.track.mediaStreamTrack.clonedFrom, undefined);
  await f.e.stopMic();
}

// Run the Engine against the installed SDK, not a rewritten model of its locking/event order.
// Browser device classes are minimal doubles; LocalAudioTrack and its async constructor,
// mute lock, enabled writes, and synchronous Unmuted emission are the real library.
{
  const sdk = await import('livekit-client');
  const previousStream = globalThis.MediaStream;
  globalThis.MediaStream = Stream;
  try {
    // Prove the contract that originally escaped the mock: constructor overwrites enabled.
    const probe = new MediaTrack(); probe.enabled = false;
    const sdkProbe = new sdk.LocalAudioTrack(probe);
    await flush(); assert.equal(probe.enabled, true, 'installed SDK restores enabled after construction');
    await sdkProbe.mute(); assert.equal(probe.enabled, false); sdkProbe.stop();

    const f = fixture(source, {}, { appleMobile: true, sdkTrack: sdk.LocalAudioTrack }); f.activeVoice(null);
    const publishing = deferred(); let track;
    f.room.localParticipant.publishTrack = async (value) => {
      track = value;
      assert.equal(track.isMuted, true); assert.equal(track.mediaStreamTrack.enabled, false);
      await publishing.promise;
      assert.equal(track.isMuted, true); assert.equal(track.mediaStreamTrack.enabled, false, 'stays closed while publish is pending');
      f.publication.track = track;
    };
    const starting = f.e.startMic(); await flush();
    const clone = track.mediaStreamTrack, raw = clone.clonedFrom;
    assert.equal(clone.enabled, false); assert.equal(raw.enabled, true);
    publishing.resolve(); await starting; await flush();
    assert.equal(track.isMuted, false); assert.equal(clone.enabled, true);

    for (const guard of ['ptt', 'ownership', 'manual', 'deaf']) {
      f.document.hidden = true; f.settings.mode = guard === 'ptt' ? 'ptt' : 'voice';
      f.e.manualMute = guard === 'manual'; f.e.deafened = guard === 'deaf';
      f.e.voiceLeaseVerifying = guard === 'ownership'; f.e.pttDown = false;
      await track.mute();
      let observed = false;
      const observe = () => {
        observed = true;
        assert.equal(clone.enabled, false, `synchronous SDK Unmuted must honor hidden ${guard} gate`);
        assert.equal(raw.enabled, true);
      };
      // Registered after the Engine listener: inspect immediately during the SDK
      // event, before its unmute promise can settle or syncMicState can run finally.
      track.on(sdk.TrackEvent.Unmuted, observe);
      await track.unmute();
      track.off(sdk.TrackEvent.Unmuted, observe);
      assert.equal(observed, true); assert.equal(clone.enabled, false);
    }
    assert.equal(track.listenerCount(sdk.TrackEvent.Unmuted), 1);
    const queuedGate = track.listeners(sdk.TrackEvent.Unmuted)[0];
    await f.e.stopMic();
    assert.equal(track.listenerCount(sdk.TrackEvent.Unmuted), 0, 'teardown removes the SDK listener');
    assert.equal(clone.readyState, 'ended'); assert.equal(raw.readyState, 'ended');
    clone.enabled = true; queuedGate();
    assert.equal(clone.enabled, false, 'a queued stale callback keeps only its own clone closed');
  } finally {
    if (previousStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = previousStream;
  }
}

// Initial join retries a vanished explicit input exactly once; only successful default
// capture commits the preference reset, and a mute made while waiting stays authoritative.
for (const error of [captureError('NotFoundError'), captureError('OverconstrainedError', 'deviceId')]) {
  const f = fixture(source, {}, { appleMobile: true }); f.activeVoice(null); f.settings.input = 'removed-headset';
  const fallback = deferred(); const requests = [];
  f.setCapture(({ audio }) => {
    requests.push(audio);
    return requests.length === 1 ? Promise.reject(error) : fallback.promise;
  });
  const starting = f.e.startMic(); await flush();
  assert.equal(requests.length, 2); assert.equal(requests[0].deviceId.exact, 'removed-headset');
  assert.equal(requests[1].deviceId, undefined); assert.equal(f.settings.input, 'removed-headset');
  assert.equal(f.inventoryRefreshes, 0);
  await f.e.toggleMic();
  const stream = new Stream(); fallback.resolve(stream);
  assert.equal(await starting, true); await flush();
  assert.equal(f.settings.input, ''); assert.equal(f.inventoryRefreshes, 1);
  assert.equal(f.e.manualMute, true); assert.equal(f.publication.track.isMuted, true);
  assert.equal(f.e.micDirectTrack.enabled, false); assert.equal(stream.getAudioTracks()[0].enabled, true);
  await f.e.stopMic();
}

// Permission, device-busy, network and unrelated constraints failures preserve explicit input.
for (const error of [captureError('NotAllowedError'), captureError('NotReadableError'), captureError('AbortError'),
  captureError('TypeError'), captureError('OverconstrainedError', 'sampleRate'), captureError('OverconstrainedError', 'channelCount'),
  captureError('OverconstrainedError')]) {
  const f = fixture(); f.activeVoice(null); f.settings.input = 'chosen-mic';
  f.setCapture(async () => { throw error; });
  await assert.rejects(f.e.startMic(), (caught) => caught === error);
  assert.equal(f.captureCalls, 1); assert.equal(f.settings.input, 'chosen-mic'); assert.equal(f.inventoryRefreshes, 0);
}
{
  const f = fixture(); f.activeVoice(null);
  f.setCapture(async () => { throw captureError('NotFoundError'); });
  await assert.rejects(f.e.startMic(), { name: 'NotFoundError' });
  assert.equal(f.captureCalls, 1, 'system default has no second fallback');
}

// A failed default fallback is terminal for this attempt; reapply/watchdog cannot clear
// the saved input and secretly try a third capture outside the common guard.
for (const action of ['start', 'reapply', 'watchdog']) {
  const f = fixture(); f.activeVoice(null); f.settings.input = 'chosen-mic';
  f.setCapture(async () => { throw captureError('NotFoundError'); });
  if (action === 'start') await assert.rejects(f.e.startMic(), { name: 'NotFoundError' });
  else if (action === 'reapply') await f.e.reapplyMic();
  else await f.e.checkMicAlive(true);
  assert.equal(f.captureCalls, 2, `${action} has only one fallback`);
  assert.equal(f.settings.input, 'chosen-mic'); assert.equal(f.inventoryRefreshes, 0);
}
{
  const f = fixture(); f.activeVoice(null); f.settings.input = 'chosen-mic';
  f.setCapture(async () => { throw captureError('NotAllowedError'); });
  await f.e.reapplyMic(); assert.equal(f.captureCalls, 1); assert.equal(f.settings.input, 'chosen-mic');
}

// A newer device choice invalidates either result of the old request, not just its fallback.
for (const succeeds of [true, false]) {
  const f = fixture(); f.activeVoice(null); f.settings.input = 'old-mic';
  const pending = deferred(); f.setCapture(() => pending.promise);
  const starting = f.e.startMic(); await flush();
  f.settings.input = 'new-mic';
  const late = new Stream();
  if (succeeds) pending.resolve(late); else pending.reject(captureError('NotFoundError'));
  assert.equal(await starting, false);
  assert.equal(f.captureCalls, 1); assert.equal(f.settings.input, 'new-mic'); assert.equal(f.inventoryRefreshes, 0);
  if (succeeds) assert.equal(late.getAudioTracks()[0].readyState, 'ended');
}
for (const cancellation of ['choice', 'stop']) {
  const f = fixture(); f.activeVoice(null); f.settings.input = 'old-mic';
  const pending = deferred(); let calls = 0;
  f.setCapture(() => ++calls === 1 ? Promise.reject(captureError('NotFoundError')) : pending.promise);
  const starting = f.e.startMic(); await flush(); assert.equal(calls, 2);
  if (cancellation === 'choice') f.settings.input = 'new-mic'; else await f.e.stopMic();
  const late = new Stream(); pending.resolve(late);
  assert.equal(await starting, false); await flush();
  assert.equal(late.getAudioTracks()[0].readyState, 'ended'); assert.equal(f.inventoryRefreshes, 0);
  assert.equal(f.settings.input, cancellation === 'choice' ? 'new-mic' : 'old-mic');
}

// Preview shares the same fallback and ownership behavior, including late default capture.
{
  const f = fixture(source, { denoise: 100 }); f.activeVoice(null); f.settings.input = 'old-mic'; f.settings.nsMode = 'rnnoise';
  const raw = new Stream(); f.setCapture(async () => raw);
  const starting = f.e.startMic(); await flush();
  f.settings.input = 'new-mic';
  assert.equal(await f.finish(starting), false, 'a newer input also invalidates post-capture async graph setup');
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended'); assert.equal(f.publication.track, null);
}

// Preview shares the same fallback and ownership behavior, including late default capture.
{
  const f = fixture(); f.settings.input = 'removed-mic'; f.e.levelListeners.add(() => {});
  let calls = 0;
  f.setCapture(() => ++calls === 1 ? Promise.reject(captureError('NotFoundError')) : Promise.resolve(new Stream()));
  await f.e.startLevelMeter();
  assert.equal(calls, 2); assert.equal(f.settings.input, ''); assert.ok(f.e.levelStream);
  assert.equal(f.inventoryRefreshes, 1); f.e.stopLevelMeter();
}
{
  const f = fixture(); f.settings.input = 'removed-mic'; f.e.levelListeners.add(() => {});
  const pending = deferred(); let calls = 0;
  f.setCapture(() => ++calls === 1 ? Promise.reject(captureError('OverconstrainedError', 'deviceId')) : pending.promise);
  const preview = f.e.startLevelMeter(); await flush(); assert.equal(calls, 2);
  f.e.stopLevelMeter(); const late = new Stream(); pending.resolve(late); await preview;
  assert.equal(late.getAudioTracks()[0].readyState, 'ended'); assert.equal(f.settings.input, 'removed-mic');
  assert.equal(f.inventoryRefreshes, 0); assert.equal(f.e.levelStream, null);
}

// The actual session helper is pinned before capture and retained across microphone
// replacement, same-server channel switch and cross-server handoff, until terminal leave.
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session }); f.activeVoice(null);
  f.setCapture(async () => { assert.equal(session.type, 'play-and-record'); return new Stream(); });
  await f.e.startMic(); const owner = f.e.voiceAudioSessionOwner;
  await f.e.reapplyMic(); assert.equal(f.e.voiceAudioSessionOwner, owner);
  await f.e.switchVoice('second'); assert.equal(f.e.voiceAudioSessionOwner, owner);
  f.e.viewServerId = 'other-server'; await f.e.joinVoice('third');
  assert.notEqual(f.e.voiceAudioSessionOwner, owner);
  assert.deepEqual(session.writes, ['play-and-record'], 'handoff never temporarily restores auto');
  await f.e.leaveVoice(); assert.equal(session.type, 'auto'); assert.equal(f.e.voiceAudioSessionOwners.size, 0);
}

// Capture rejection and pre-capture join rejection both release their category lease.
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session }); f.activeVoice(null);
  f.setCapture(async () => { throw captureError('NotAllowedError'); });
  await assert.rejects(f.e.startMic()); assert.equal(session.type, 'auto'); assert.equal(f.e.voiceAudioSessionOwners.size, 0);
}
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session });
  f.e.viewRoom = f.room; f.e.viewServerId = 'server'; f.e.readyRooms.add(f.room);
  f.api.mintVoiceIntent = async () => ({ accepted: false });
  await f.e.joinVoice('channel'); assert.equal(session.type, 'auto'); assert.equal(f.captureCalls, 0);
}

// A stale old join cannot release the current join's category; disconnect also releases
// a local handoff lease still awaiting the old room's asynchronous teardown.
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session });
  f.e.viewRoom = f.room; f.e.viewServerId = 'server'; f.e.readyRooms.add(f.room);
  const pending = deferred(); let calls = 0;
  f.setCapture(() => ++calls === 1 ? pending.promise : Promise.resolve(new Stream()));
  const old = f.e.joinVoice('old'); await flush(); await f.e.joinVoice('new');
  const late = new Stream(); pending.resolve(late); await old; await flush();
  assert.equal(late.getAudioTracks()[0].readyState, 'ended'); assert.equal(session.type, 'play-and-record');
  assert.equal(f.e.voiceAudioSessionOwners.size, 1); await f.e.leaveVoice(); assert.equal(session.type, 'auto');
}
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session }); f.activeVoice(null);
  await f.e.startMic(); f.e.viewServerId = 'other';
  const pending = deferred(); f.room.localParticipant.unpublishTrack = () => pending.promise;
  const switching = f.e.joinVoice('new'); await flush(); assert.equal(f.e.voiceAudioSessionOwners.size, 1);
  assert.equal(session.type, 'play-and-record', 'the pending new intent retains its lease after synchronous old leave');
  f.e.disconnect(); assert.equal(session.type, 'auto'); assert.equal(f.e.voiceAudioSessionOwners.size, 0);
  pending.resolve(); await switching; assert.equal(session.type, 'auto');
}

// Preview restarts and preview-to-voice transfer have no category gap. A cancelled
// preview's late capture cleanup cannot release the replacement voice lease.
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session });
  f.e.levelListeners.add(() => {}); await f.e.startLevelMeter();
  f.e.restartLevelMeter(); await flush(); assert.deepEqual(session.writes, ['play-and-record']);
  f.e.stopLevelMeter(); assert.equal(session.type, 'auto');
  const pending = deferred(); let calls = 0;
  f.setCapture(() => ++calls === 1 ? pending.promise : Promise.resolve(new Stream()));
  const preview = f.e.startLevelMeter(); f.activeVoice(null); await f.e.startMic();
  const late = new Stream(); pending.resolve(late); await preview;
  assert.equal(late.getAudioTracks()[0].readyState, 'ended'); assert.equal(session.type, 'play-and-record');
  await f.e.leaveVoice(); assert.equal(session.type, 'auto');
}
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session });
  f.e.levelListeners.add(() => {}); f.setCapture(async () => { throw captureError('NotAllowedError'); });
  await f.e.startLevelMeter(); assert.equal(session.type, 'auto'); assert.equal(f.e.levelAudioSessionRelease, null);
}

// Hidden source/session interruption produces evidence before the recovery guard,
// with bounded deferred reports and no extra capture, resume or network operation.
{
  const session = new AudioSession(); const f = fixture(source, {}, { appleMobile: true, audioSession: session }); f.activeVoice(null);
  await f.e.startMic(); await flush(); f.e.diagnostics.start(); f.document.hidden = true;
  let recovered = 0; f.e.checkMicAlive = async () => { recovered++; }; f.e.ensureVoiceAudioRunning = () => { recovered++; };
  const raw = f.e.micRaw.getAudioTracks()[0]; raw.muted = true;
  raw.fire('mute'); session.state = 'interrupted'; session.fire('statechange');
  raw.muted = false; raw.fire('unmute'); raw.stop(); raw.fire('ended');
  assert.equal(recovered, 0); assert.equal(f.captureCalls, 1); assert.equal(f.reports.length, 0);
  const events = f.diagnosticEvents.filter((event) => event.kind === 'mic_source_changed');
  assert.deepEqual(events.map((event) => event.captureEvent), ['mute', 'session_state', 'unmute', 'ended']);
  assert.equal(events[0].rawTrackMuted, true); assert.equal(events[0].rawTrackEnabled, true);
  assert.equal(events[0].publishedTrackEnabled, true); assert.equal(events[0].documentHidden, true);
  assert.equal(events[1].audioSessionState, 'interrupted'); assert.equal(events[1].audioSessionType, 'play-and-record');
  const reports = [...f.timers.entries()].filter(([, timer]) => !timer.repeat && timer.at === f.time);
  assert.equal(reports.length, 1, 'multiple interruption events share the bounded report cooldown');
  for (const [id, timer] of reports) { f.timers.delete(id); timer.fn(); }
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].events.at(-1).captureEvent, 'mute');
  const stale = [...session.listeners.get('statechange')][0];
  await f.e.stopMic(); assert.equal(session.listenerCount(), 0);
  const count = f.diagnosticEvents.length; stale(); raw.fire('mute');
  assert.equal(f.diagnosticEvents.length, count, 'stale source/session events cannot describe a newer pipeline');
  f.e.disconnect(); assert.equal(session.type, 'auto');
}
{
  const session = { get state() { throw new Error('Optional getter'); }, get type() { throw new Error('Optional getter'); } };
  const f = fixture(source, {}, { appleMobile: true, audioSession: session }); f.activeVoice(null);
  await f.e.startMic(); assert.doesNotThrow(() => f.e.recordVoiceDiagnostic({ kind: 'background' }));
  await f.e.leaveVoice();
}

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
  async function simulatedJoin(engineSource, options) {
    const f = fixture(engineSource, { ticket: 100, claim: 100, attributes: 50, capture: 100, denoise: 40, publish: 100 }, options);
    f.settings.nsMode = 'rnnoise'; f.e.viewRoom = f.room; f.e.viewServerId = 'server'; f.e.readyRooms.add(f.room);
    const start = f.time; await f.finish(f.e.joinVoice('channel'));
    assert.equal(f.e.inVoice, true); assert.equal(f.e.voiceConnecting, false); assert.ok(f.publication.track);
    return { joinMs: f.time - start, captureCalls: f.captureCalls };
  }
  const before = await simulatedJoin(baseline), after = await simulatedJoin(source);
  assert.ok(after.joinMs <= before.joinMs, 'controlled join gained an extra sequential wait');
  console.log('controlled join simulation (mocked I/O):', JSON.stringify({ before, after }));
  const beforeDirect = execFileSync('git', ['show', 'ece5372:apps/web/src/engine.ts'], { encoding: 'utf8' });
  const iosBefore = await simulatedJoin(beforeDirect, { appleMobile: true }), iosAfter = await simulatedJoin(source, { appleMobile: true });
  assert.ok(iosAfter.joinMs <= iosBefore.joinMs, 'direct capture gained a sequential setup wait');
  console.log('iOS direct-capture join simulation (mocked I/O, not device QA):', JSON.stringify({ before: iosBefore, after: iosAfter }));
  console.log('5-minute gate simulation (9000 updates):', JSON.stringify({ before: gateStress(baseline), after: gate }));
}

console.log('voice engine control races and background lifecycle: ok');

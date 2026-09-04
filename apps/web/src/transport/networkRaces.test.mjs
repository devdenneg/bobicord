import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the production modules with deterministic network/timer boundaries. No copied
// transport implementation: delayed SDP, socket close and IPC completions exercise the code.
function loadModule(relativePath, imports, globals = {}) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = readFileSync(filename, 'utf8').replace('(import.meta as any).env?.VITE_TREE_WS_URL', 'undefined');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(js, {
    exports, console, ...globals,
    require(id) {
      if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
      return imports[id];
    },
  }, { filename });
  return exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }

function environment() {
  let now = 100000, nextId = 1;
  const timers = new Map();
  const target = () => {
    const listeners = new Map();
    return {
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
      emit(name) { for (const fn of listeners.get(name) || []) fn(); },
    };
  };
  const setTimer = (fn, delay, interval = false) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  const globals = {
    setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, true), clearInterval: (id) => timers.delete(id),
    location: { protocol: 'https:', host: 'test.invalid' },
    Date: class extends Date { static now() { return now; } },
    document: { ...target(), visibilityState: 'visible' },
  };
  globals.window = { ...target(), ...globals };
  const sockets = [], peers = [];
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = Socket.CONNECTING;
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    send(data) { if (this.readyState !== Socket.OPEN) throw new Error('closed'); this.sent.push(JSON.parse(data)); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    close() { this.readyState = Socket.CLOSED; }
    serverClose(code = 1006) { this.close(); this.onclose?.({ code }); }
  }
  class Peer {
    remoteDescription = null;
    localDescription = null;
    connectionState = 'new';
    candidates = [];
    answers = 0;
    statsCalls = 0;
    constructor() { peers.push(this); }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription(description) { if (this.remoteGate) await this.remoteGate.promise; this.remoteDescription = description; }
    async createAnswer() { this.answers++; return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async addIceCandidate(candidate) { if (!this.remoteDescription) throw new Error('SDP missing'); this.candidates.push(candidate); }
    getReceivers() { return []; }
    getTransceivers() { return []; }
    async getStats() { this.statsCalls++; return this.statsGate ? this.statsGate.promise : new Map(); }
    track(id) { this.ontrack?.({ track: { id, kind: 'video' } }); }
  }
  class Stream {
    tracks = [];
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter((old) => old !== track); }
  }
  Object.assign(globals, { WebSocket: Socket, RTCPeerConnection: Peer, MediaStream: Stream });
  return {
    globals, sockets, peers, timers,
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.delay; else timers.delete(id);
        timer.fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

function treeHarness(nativeOverrides = {}) {
  const env = environment();
  const nativeListeners = new Map(), nativeCalls = [];
  const listen = (event) => async (cb) => {
    if (!nativeListeners.has(event)) nativeListeners.set(event, new Set());
    nativeListeners.get(event).add(cb);
    return () => nativeListeners.get(event).delete(cb);
  };
  const { TreeVideoTransport } = loadModule('./treeVideo.ts', {
    './videoTransport': { MediaStreamVideoHandle: class { constructor(stream) { this.stream = stream; } } },
    '../api': { getToken: () => 'test' },
    './natDetect': { detectSymmetricNat: async () => false, stunUrlsByHost: () => [] },
    '../native': {
      isTauri: false, onNativeWatchOffer: listen('offer'), onNativeWatchIce: listen('ice'),
      onNativeTopology: listen('topology'), onNativeWatchEnded: listen('ended'),
      startNativeWatch: async (...args) => { nativeCalls.push(['start', ...args]); },
      stopNativeWatch: async (...args) => { nativeCalls.push(['stop', ...args]); },
      nativeWatchAnswer: async () => {}, nativeWatchIce: async () => {}, nativeWatchReparent: async () => {},
      ...nativeOverrides,
    },
    './probe': { getCachedProbe: () => ({ bweKbps: 1000 }), measureUpload: async () => {} },
    './dropDetector': { DropWindow: class { reset() {} push() {} deltas() { return {}; } }, shouldReparentOnDrops: () => false },
    './stallDetector': { newStallState: () => ({}), shouldSelfHeal: () => false },
    '../diag': { startViewerSession() {}, endViewerSession() {} },
  }, env.globals);
  const transport = new TreeVideoTransport();
  const attach = (serverId = 'server-a') => transport.attach({}, { me: 'me', serverId });
  attach();
  env.sockets[0].open();
  env.sockets[0].message({ t: 'stream-live', identity: 'alice' });
  const watch = () => {
    transport.watch('alice');
    const ws = env.sockets.at(-1);
    ws.open();
    ws.message({ t: 'welcome' });
    ws.message({ t: 'assign-parent', parentId: 'parent-a' });
    return ws;
  };
  return { ...env, transport, attach, watch, nativeCalls, nativeListeners };
}

test('tree buffers ICE until its offer is applied, including candidates before SDP', async () => {
  const h = treeHarness(), ws = h.watch();
  ws.message({ t: 'ice', from: 'parent-a', candidate: { candidate: 'first' } });
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'offer' });
  ws.message({ t: 'ice', from: 'parent-a', candidate: { candidate: 'second' } });
  await settle();
  assert.equal(h.peers[0].candidates.map((c) => c.candidate).join(','), 'first,second');
  assert.equal(ws.sent.filter((frame) => frame.t === 'sdp').length, 1);
  h.transport.detach();
  assert.equal(h.timers.size, 0);
});

test('tree ignores late SDP/ICE/tracks after reparent and closes the replaced peer', async () => {
  const h = treeHarness(), ws = h.watch();
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'offer-a' });
  const old = h.peers[0];
  // Reparent before the first offer continuation resumes.
  ws.message({ t: 'assign-parent', parentId: 'parent-b' });
  ws.message({ t: 'ice', from: 'parent-a', candidate: { candidate: 'obsolete' } });
  ws.message({ t: 'sdp', from: 'parent-b', type: 'offer', sdp: 'offer-b' });
  old.track('old');
  await settle();
  assert.equal(old.connectionState, 'closed');
  assert.equal(old.answers, 0);
  assert.equal(h.transport.getStreams().length, 0);
  assert.equal(ws.sent.filter((frame) => frame.t === 'sdp').map((frame) => frame.to).join(','), 'parent-b');
  h.peers[1].track('new');
  assert.equal(h.transport.getVideoTrack('alice').stream.getTracks()[0].id, 'new');
  h.transport.detach();
});

test('a duplicate parent offer closes its previous peer instead of leaking decoder resources', async () => {
  const h = treeHarness(), ws = h.watch();
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'first' });
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'second' });
  await settle();
  assert.equal(h.peers[0].connectionState, 'closed');
  assert.equal(ws.sent.filter((frame) => frame.t === 'sdp').length, 1);
  h.transport.detach();
});

test('closing while reconnect is pending removes the frozen video and cancels retry', async () => {
  const h = treeHarness(), ws = h.watch();
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'offer' });
  await settle();
  h.peers[0].track('first');
  ws.serverClose();
  h.transport.unwatch('alice');
  h.peers[0].track('late');
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'late' });
  await h.advance(16000);
  assert.equal(h.transport.getStreams().length, 0);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.peers.length, 1);
  h.transport.detach();
  assert.equal(h.timers.size, 0);
});

test('old discovery retry and messages cannot mutate a newly attached server', async () => {
  const h = treeHarness(), old = h.sockets[0];
  old.serverClose();
  h.transport.detach();
  h.attach('server-b');
  const current = h.sockets[1];
  current.open();
  old.message({ t: 'stream-live', identity: 'obsolete' });
  await h.advance(4000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.transport.isRemoteBroadcasting('obsolete'), false);
  assert.equal(current.readyState, 1);
  h.transport.detach();
});

test('tree retries stuck discovery and watch handshakes and cancels their timers on detach', async () => {
  const h = treeHarness();
  h.transport.watch('alice'); // Keep the viewer socket in CONNECTING.
  await h.advance(13000);
  assert.equal(h.sockets.length, 3);
  assert.equal(h.sockets[1].readyState, 3);
  h.transport.detach();
  h.attach('server-b'); // Keep discovery in CONNECTING too.
  await h.advance(13000);
  assert.equal(h.sockets.length, 5);
  assert.equal(h.sockets[3].readyState, 3);
  h.transport.detach();
  assert.equal(h.timers.size, 0);
});

test('online replaces half-open discovery and watch sockets without stale callbacks', async () => {
  const h = treeHarness(), oldWatch = h.watch();
  h.globals.window.emit('online');
  const replacement = h.sockets.at(-1);
  oldWatch.serverClose();
  replacement.open();
  replacement.message({ t: 'welcome' });
  await settle();
  assert.equal(oldWatch.readyState, 3);
  assert.equal(h.sockets.length, 4);
  assert.equal(replacement.sent.filter((frame) => frame.t === 'join').length, 1);
  h.transport.detach();
});

test('slow getStats calls do not accumulate or reintroduce state after teardown', async () => {
  const h = treeHarness(), ws = h.watch();
  ws.message({ t: 'sdp', from: 'parent-a', type: 'offer', sdp: 'offer' });
  await settle();
  const peer = h.peers[0], gate = deferred();
  peer.statsGate = gate;
  await h.advance(5000);
  assert.equal(peer.statsCalls, 1);
  h.transport.detach();
  gate.resolve(new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 }]]));
  await settle();
  assert.equal(h.transport.getStreams().length, 0);
  assert.equal(h.timers.size, 0);
});

test('native delayed start/stop completes before a replacement start for the same stream', async () => {
  const firstStart = deferred(), calls = [];
  let starts = 0;
  const h = treeHarness({
    isTauri: true,
    startNativeWatch: async () => { calls.push('start'); if (++starts === 1) await firstStart.promise; },
    stopNativeWatch: async () => { calls.push('stop'); },
  });
  h.transport.watch('alice');
  await settle();
  assert.deepEqual(calls, ['start']);
  h.transport.unwatch('alice');
  h.transport.watch('alice');
  await settle();
  assert.deepEqual(calls, ['start']);
  firstStart.resolve();
  await settle();
  assert.deepEqual(calls, ['start', 'stop', 'start']);
  assert.equal(h.nativeListeners.get('offer').size, 1);
  h.transport.detach();
  await settle();
  assert.equal(h.nativeListeners.get('offer').size, 0);
});

test('native listener registration completing after cancel is immediately removed', async () => {
  const registration = deferred();
  let removed = 0, extraRegistrations = 0, starts = 0;
  const h = treeHarness({
    isTauri: true,
    onNativeWatchOffer: () => registration.promise,
    onNativeWatchIce: async () => { extraRegistrations++; return () => {}; },
    startNativeWatch: async () => { starts++; },
  });
  h.transport.watch('alice');
  h.transport.unwatch('alice');
  registration.resolve(() => { removed++; });
  await settle();
  assert.equal(removed, 1);
  assert.equal(extraRegistrations, 0);
  assert.equal(starts, 0);
  h.transport.detach();
});

function notifyHarness() {
  const env = environment();
  let token = 'first';
  const notifications = [], toasts = [];
  const api = loadModule('../notifyws.ts', {
    './api': { getToken: () => token, webOrigin: () => 'https://test.invalid' },
    './notify': { notify: (...args) => notifications.push(args) },
    './notificationDestination': { rememberNotificationDestination() {} },
    './chatVisibility': { setVisibleChatServer() {} },
    './store': {
      getEngine: () => null,
      useStore: { getState: () => ({ toast: (...args) => toasts.push(args), bumpUnread() {} }) },
    },
  }, env.globals);
  return { ...env, api, toasts, notifications, setToken: (value) => { token = value; } };
}

test('notify retries a stuck CONNECTING socket within a bounded time', async () => {
  const h = notifyHarness();
  h.api.connectNotifyWs();
  await h.advance(11500);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].readyState, 3);
  h.api.disconnectNotifyWs();
  assert.equal(h.timers.size, 0);
});

test('notify probes an OPEN socket on focus and reconnects if no response arrives', async () => {
  const h = notifyHarness();
  h.api.connectNotifyWs();
  const old = h.sockets[0];
  old.open();
  h.globals.window.emit('focus');
  h.globals.window.emit('focus');
  assert.equal(old.sent.filter((frame) => frame.t === 'ping').length, 1);
  await h.advance(9500);
  assert.equal(h.sockets.length, 2);
  old.message({ t: 'notify', title: 'obsolete' });
  assert.equal(h.notifications.length, 0);
  h.api.disconnectNotifyWs();
});

test('a live notify pong cancels the reconnect deadline; online replaces the old route', async () => {
  const h = notifyHarness();
  h.api.connectNotifyWs();
  h.sockets[0].open();
  h.globals.window.emit('focus');
  h.sockets[0].message({ t: 'pong' });
  await h.advance(9500);
  assert.equal(h.sockets.length, 1);
  h.globals.window.emit('online');
  assert.equal(h.sockets.length, 2);
  h.api.disconnectNotifyWs();
});

test('revocation from the old token cannot revoke the fresh login', async () => {
  const h = notifyHarness();
  h.api.connectNotifyWs();
  h.sockets[0].open();
  h.setToken('second');
  h.sockets[0].serverClose(4001);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.sockets.length, 2);
  assert.equal(new URL(h.sockets[1].url).searchParams.get('token'), 'second');
  h.sockets[1].open();
  h.sockets[1].serverClose(4001);
  h.api.connectNotifyWs();
  await h.advance(30000);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.sockets.length, 2);
  h.api.disconnectNotifyWs();
});

function livekitHarness() {
  const Track = { Source: { ScreenShare: 'screen', ScreenShareAudio: 'screen-audio' }, Kind: { Video: 'video' } };
  const RoomEvent = Object.fromEntries(['TrackSubscribed', 'TrackUnsubscribed', 'LocalTrackPublished', 'LocalTrackUnpublished', 'TrackPublished', 'TrackUnpublished', 'ParticipantDisconnected'].map((name) => [name, name]));
  class LocalTrack { constructor(track) { this.mediaStreamTrack = track; } stop() { this.mediaStreamTrack.stop(); } }
  const { LiveKitVideoTransport } = loadModule('./livekitVideo.ts', {
    'livekit-client': { Track, RoomEvent, LocalVideoTrack: LocalTrack, LocalAudioTrack: LocalTrack },
    '../util': { baseUid: (id) => id.split('#')[0] },
  });
  const callbacks = new Map(), publications = new Map(), published = [], unpublished = [];
  const room = {
    remoteParticipants: new Map(),
    on(name, cb) { callbacks.set(name, cb); return this; },
    off(name, cb) { if (callbacks.get(name) === cb) callbacks.delete(name); return this; },
    localParticipant: {
      getTrackPublication: (source) => publications.get(source),
      async publishTrack(track, options) { published.push(track); if (room.publishGate) await room.publishGate.promise; publications.set(options.source, { track }); },
      async unpublishTrack(track) { unpublished.push(track); for (const [source, pub] of publications) if (pub.track === track) publications.delete(source); },
    },
  };
  const transport = new LiveKitVideoTransport();
  transport.attach(room, { me: 'me', serverId: 'server' });
  const capture = () => {
    const video = { stopped: false, stop() { this.stopped = true; } }, audio = { stopped: false, stop() { this.stopped = true; } };
    return { video, audio, getVideoTracks: () => [video], getAudioTracks: () => [audio] };
  };
  return { transport, room, callbacks, publications, published, unpublished, capture, Track };
}

test('stop during LiveKit video publish cleans the late publication and never publishes audio', async () => {
  const h = livekitHarness(), source = h.capture();
  h.room.publishGate = deferred();
  const start = h.transport.startBroadcast('me', source);
  await h.transport.stopBroadcast('me');
  h.room.publishGate.resolve();
  await start;
  assert.equal(h.published.length, 1);
  assert.equal(h.publications.size, 0);
  assert.equal(source.video.stopped, true);
  assert.equal(source.audio.stopped, true);
});

test('a failed LiveKit audio publication cleans both tracks from the partial broadcast', async () => {
  const h = livekitHarness(), source = h.capture();
  const publish = h.room.localParticipant.publishTrack;
  h.room.localParticipant.publishTrack = async (track, options) => {
    if (options.source === 'screen-audio') throw new Error('signaling disconnected');
    return publish(track, options);
  };
  await assert.rejects(h.transport.startBroadcast('me', source), /signaling disconnected/);
  assert.equal(h.publications.size, 0);
  assert.equal(source.video.stopped, true);
  assert.equal(source.audio.stopped, true);
});

test('LiveKit rejects late subscription after unwatch', () => {
  const h = livekitHarness();
  const publication = { source: 'screen', trackSid: 'screen-a', setSubscribed() {} };
  const participant = { identity: 'alice#one', getTrackPublication: () => publication };
  h.room.remoteParticipants.set(participant.identity, participant);
  h.transport.watch('alice');
  const subscribed = h.callbacks.get('TrackSubscribed');
  h.transport.unwatch('alice');
  subscribed({ kind: 'video' }, publication, participant);
  assert.equal(h.transport.getStreams().length, 0);
});

test('LiveKit subscription from a replaced session cannot overwrite the selected session', () => {
  const h = livekitHarness();
  const publication = { source: 'screen', trackSid: 'screen-a', setSubscribed() {} };
  const old = { identity: 'alice#one', getTrackPublication: () => publication };
  const fresh = { identity: 'alice#two', getTrackPublication: () => ({ ...publication, trackSid: 'screen-b' }) };
  h.room.remoteParticipants.set(old.identity, old);
  h.transport.watch('alice');
  h.room.remoteParticipants.delete(old.identity);
  h.room.remoteParticipants.set(fresh.identity, fresh);
  h.callbacks.get('ParticipantDisconnected')(old);
  h.callbacks.get('TrackSubscribed')({ kind: 'video' }, publication, old);
  h.callbacks.get('TrackSubscribed')({ kind: 'video' }, fresh.getTrackPublication(), fresh);
  assert.equal(h.transport.getStreams().length, 1);
  assert.equal(h.transport.getStreams()[0].key, 'screen-b');
});

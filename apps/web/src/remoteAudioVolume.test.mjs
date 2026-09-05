import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RemoteAudioTrack, RemoteParticipant, Room, Track } from 'livekit-client';

// Exercise the installed, bundled SDK. Only browser devices/AudioContext are doubles:
// attach/rebind/detach, participant source selection and Room.startAudio are real SDK code.
class MediaTrack {
  kind = 'audio'; readyState = 'live'; enabled = true;
  constructor(id) { this.id = id; }
  getSettings() { return {}; }
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return []; }
  addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}
class AudioElement {
  srcObject = null; volume = 1; muted = false; paused = true; parentElement = null;
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}
const globals = { MediaStream: Stream, HTMLAudioElement: AudioElement, HTMLVideoElement: class {} };
const previousGlobals = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  for (const [key, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

// Unlike an immediate-value mock, setTargetAtTime starts at the preceding gain
// and converges exponentially. A start time in the past starts at currentTime.
class Param {
  constructor(context) { this.context = context; this.events = []; }
  at(time) {
    let value = 1;
    for (const event of this.events) {
      if (event.time > time) break;
      value = event.kind === 'target'
        ? event.value + (event.initial - event.value) * Math.exp(-(time - event.time) / event.tau)
        : event.value;
    }
    return value;
  }
  get value() { return this.at(this.context.currentTime); }
  set value(value) { this.setValueAtTime(value, this.context.currentTime); }
  setValueAtTime(value, time) { this.events.push({ kind: 'value', value, time: Math.max(time, this.context.currentTime) }); return this; }
  setTargetAtTime(value, time, tau) {
    time = Math.max(time, this.context.currentTime);
    this.events.push({ kind: 'target', value, time, tau, initial: this.at(time) });
    return this;
  }
  cancelScheduledValues(time) { this.events = this.events.filter((event) => event.time < time); return this; }
}
class AudioNode {
  outputs = new Set();
  constructor(context, kind, stream) { this.context = context; this.kind = kind; this.stream = stream; }
  connect(node) {
    assert.equal(node.context, this.context, 'nodes must not cross AudioContext ownership');
    this.outputs.add(node);
    this.context.connections.push(this.context.output());
    return node;
  }
  disconnect(node) { if (node) this.outputs.delete(node); else this.outputs.clear(); }
}
class Context {
  state = 'running'; currentTime = 12; nodes = []; connections = []; gainsCreated = 0;
  constructor() { this.destination = new AudioNode(this, 'destination'); }
  createGain() {
    const node = new AudioNode(this, 'gain'); node.gain = new Param(this);
    this.nodes.push(node); this.gainsCreated++; return node;
  }
  createMediaStreamSource(stream) {
    const node = new AudioNode(this, 'source', stream); this.nodes.push(node); return node;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  output(time = this.currentTime, trackId) {
    const visit = (node, gain, visited) => {
      if (node === this.destination) return gain;
      if (visited.has(node)) throw new Error('unexpected cycle in playback graph');
      const next = new Set(visited); next.add(node);
      const effective = gain * (node.gain ? node.gain.at(time) : 1);
      return [...node.outputs].reduce((sum, target) => sum + visit(target, effective, next), 0);
    };
    return this.nodes.filter((node) => node.kind === 'source'
      && node.stream?.getAudioTracks().some((track) => track.enabled && (!trackId || track.id === trackId)))
      .reduce((sum, node) => sum + visit(node, 1, new Set()), 0);
  }
}
function fixture(volume, context = new Context()) {
  const media = new MediaTrack('TR_microphone');
  const track = new RemoteAudioTrack(media, media.id, {}, context);
  track.source = Track.Source.Microphone;
  track.setVolume(volume); // preference exists before a subscription/reattach
  const element = new AudioElement();
  return { context, track, media, element };
}
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
function assertSteady(context, volume, message) {
  for (const offset of [0, .01, .1, .5, 2]) close(context.output(context.currentTime + offset), volume, `${message} at +${offset}s`);
}
function assertConnectionBound(context, volume, message) {
  for (const gain of context.connections) assert.ok(gain <= volume + 1e-9, `${message}: connected gain ${gain} exceeds ${volume}`);
}
function assertWebAudioOnly(element) {
  assert.equal(element.muted, true, 'HTML playback must not bypass the WebAudio gain');
  assert.equal(element.volume, 0, 'every attached HTML element stays silent');
}

for (const volume of [0, .02, 1, 2]) {
  test(`saved volume ${volume} is initialized before connecting a fresh graph`, () => {
    const f = fixture(volume); f.track.attach(f.element);
    assertConnectionBound(f.context, volume, 'initial attach');
    assertSteady(f.context, volume, 'initial attach'); assertWebAudioOnly(f.element);
    close(f.track.getVolume(), volume, 'public volume'); f.track.detach();
  });

  test(`same-context resume preserves volume ${volume} without rebuilding gain`, () => {
    const f = fixture(volume); f.track.attach(f.element);
    f.context.currentTime += 5;
    const created = f.context.gainsCreated;
    for (let i = 0; i < 5; i++) f.track.setAudioContext(f.context);
    assert.equal(f.context.gainsCreated, created, 'same context is an idempotent rebind');
    assertSteady(f.context, volume, 'same-context rebind'); assertWebAudioOnly(f.element);
    f.track.detach();
  });

  test(`replacement AudioContext immediately retains volume ${volume}`, () => {
    const f = fixture(volume); f.track.attach(f.element);
    const replacement = new Context(); f.track.setAudioContext(replacement);
    close(f.context.output(), 0, 'old context must be disconnected');
    assertConnectionBound(replacement, volume, 'context replacement');
    assertSteady(replacement, volume, 'context replacement'); assertWebAudioOnly(f.element);
    f.track.detach(); close(replacement.output(), 0, 'replacement cleanup');
  });

  test(`detach and reattach do not ramp volume ${volume} from a default`, () => {
    const f = fixture(volume); f.track.attach(f.element); f.track.detach(f.element);
    close(f.context.output(), 0, 'detached graph');
    f.context.connections = [];
    const replacement = new AudioElement(); f.track.attach(replacement);
    assertConnectionBound(f.context, volume, 'reattach');
    assertSteady(f.context, volume, 'reattach'); assertWebAudioOnly(replacement);
    f.track.detach();
  });
}

test('second attach, repeated attach and detach cannot create HTML volume bypass', () => {
  const f = fixture(.02); f.track.attach(f.element);
  const second = new AudioElement(); f.track.attach(second);
  assertWebAudioOnly(f.element); assertWebAudioOnly(second);
  f.track.attach(second); assertWebAudioOnly(second);
  assert.equal(f.context.gainsCreated, 1, 'extra elements share the existing playback graph');
  f.context.connections = [];
  f.track.detach(f.element);
  assertWebAudioOnly(second); assertSteady(f.context, .02, 'remaining element');
  assertConnectionBound(f.context, .02, 'detach first element');
  f.track.detach(second); close(f.context.output(), 0, 'all elements detached');
});

test('native HTML playback keeps cached zero when attaching another element without webAudioMix', () => {
  const f = fixture(0, undefined);
  // Explicitly remove the factory default context before attaching anything.
  f.track.setAudioContext(undefined);
  f.track.attach(f.element); const second = new AudioElement(); f.track.attach(second);
  close(f.element.volume, 0, 'first HTML volume'); close(second.volume, 0, 'second HTML volume');
  close(f.track.getVolume(), 0, 'cached zero is not confused with an unset preference');
  f.track.detach();
});

for (const volume of [0, .02, 2]) {
  test(`plugin graph rebuild preserves volume ${volume} before connecting`, () => {
    const f = fixture(volume); f.track.attach(f.element);
    const plugin = new AudioNode(f.context, 'plugin');
    f.context.connections = []; f.track.setWebAudioPlugins([plugin]);
    assertConnectionBound(f.context, volume, 'plugin insertion');
    assertSteady(f.context, volume, 'plugin insertion'); assertWebAudioOnly(f.element);
    f.context.connections = []; f.track.setWebAudioPlugins([]);
    assertConnectionBound(f.context, volume, 'plugin removal');
    assertSteady(f.context, volume, 'plugin removal');
    f.track.detach(); plugin.disconnect(); close(f.context.output(), 0, 'plugin cleanup');
  });
}

test('enabling WebAudio on existing HTML elements suppresses every bypass before graph output', () => {
  const f = fixture(.02); f.track.setAudioContext(undefined); f.track.attach(f.element);
  const second = new AudioElement(); f.track.attach(second);
  close(f.element.volume, .02, 'HTML preference before WebAudio');
  const context = new Context(); f.track.setAudioContext(context);
  assertConnectionBound(context, .02, 'first WebAudio context');
  assertSteady(context, .02, 'first WebAudio context');
  assertWebAudioOnly(f.element); assertWebAudioOnly(second);
  f.track.detach();
});

test('real Room.startAudio resumes without resetting microphone or screen-share source volumes', async () => {
  const context = new Context(); const room = new Room({ webAudioMix: { audioContext: context } });
  const participant = new RemoteParticipant({}, 'PA_peer', 'quiet-peer');
  const mic = fixture(.02, context);
  const screen = new RemoteAudioTrack(new MediaTrack('TR_screen'), 'TR_screen', {}, context);
  screen.source = Track.Source.ScreenShareAudio;
  for (const track of [mic.track, screen]) {
    const publication = { track, source: track.source };
    participant.audioTrackPublications.set(track.sid, publication);
    participant.trackPublications.set(track.sid, publication);
  }
  room.remoteParticipants.set(participant.identity, participant);
  participant.setVolume(.02); participant.setVolume(.4, Track.Source.ScreenShareAudio);
  mic.track.attach(mic.element); const screenElement = new AudioElement(); screen.attach(screenElement);
  const created = context.gainsCreated;
  for (let i = 0; i < 4; i++) {
    context.state = i % 2 ? 'running' : 'suspended';
    await room.startAudio();
    assert.equal(context.state, 'running', 'idempotent graph binding must still allow actual context resume');
    assert.equal(context.gainsCreated, created, 'Room.startAudio must not rebuild healthy playback graphs');
    close(context.output(context.currentTime, 'TR_microphone'), .02, 'microphone source gain');
    close(context.output(context.currentTime, 'TR_screen'), .4, 'screen-share source gain');
    assertWebAudioOnly(mic.element); assertWebAudioOnly(screenElement);
  }
  participant.setVolume(0); context.currentTime += 5;
  await room.startAudio();
  close(context.output(context.currentTime, 'TR_microphone'), 0, 'zero microphone gain survives resume');
  close(context.output(context.currentTime, 'TR_screen'), .4, 'microphone change must not change screen volume');
  mic.track.setMuted(true); mic.track.setMuted(false);
  close(context.output(context.currentTime, 'TR_microphone'), 0, 'SDK mute/unmute preserves local gain');
  mic.track.detach(); screen.detach(); close(context.output(), 0, 'room track cleanup');
});

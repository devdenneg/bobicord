import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roomSource = readFileSync(join(webRoot, 'node_modules/livekit-client/src/room/Room.ts'), 'utf8');
const esm = readFileSync(join(webRoot, 'node_modules/livekit-client/dist/livekit-client.esm.mjs'), 'utf8');
const umd = readFileSync(join(webRoot, 'node_modules/livekit-client/dist/livekit-client.umd.js'), 'utf8');

assert.match(roomSource, /if \(isWeb\(\) && this\.options\.disconnectOnPageLeave\) \{[\s\S]{0,500}addEventListener\('freeze', this\.onPageLeave\)/,
  'source freeze registration must be governed by disconnectOnPageLeave');
assert.doesNotMatch(roomSource, /if \(isWeb\(\)\) \{\s*window\.addEventListener\('freeze', this\.onPageLeave\)/,
  'source cannot retain an unconditional freeze disconnect');
assert.match(roomSource, /if \(this\.options\.disconnectOnPageLeave\) \{[\s\S]{0,500}removeEventListener\('freeze', this\.onPageLeave\)/,
  'source listener cleanup follows the same option boundary');

assert.match(esm, /if \(isWeb\(\) && this\.options\.disconnectOnPageLeave\) \{[\s\S]{0,500}addEventListener\('freeze', this\.onPageLeave\)/,
  'the browser ESM bundle contains the guarded freeze listener');
assert.doesNotMatch(esm, /if \(isWeb\(\)\) \{\s*window\.addEventListener\('freeze', this\.onPageLeave\)/,
  'the browser ESM bundle cannot disconnect unconditionally on freeze');
assert.ok(umd.includes('this.options.disconnectOnPageLeave&&(window.addEventListener("pagehide",this.onPageLeave),window.addEventListener("beforeunload",this.onPageLeave),window.addEventListener("freeze",this.onPageLeave))'),
  'the require/UMD bundle contains the same guarded behavior');
assert.ok(!umd.includes('_s()&&window.addEventListener("freeze",this.onPageLeave)'),
  'the require/UMD bundle cannot retain an unconditional freeze listener');
assert.match(roomSource, /this\.audioContext = this\.options\.webAudioMix\.audioContext[\s\S]{0,500}participant\.setAudioContext\(this\.audioContext\)/,
  'pinned LiveKit startAudio re-reads the mutable custom mixer and rebinds remote participants');
assert.match(roomSource, /participant\.setAudioContext\(this\.audioContext\)[\s\S]{0,300}this\.localParticipant\.setAudioContext\(this\.audioContext\)/,
  'pinned LiveKit applies the same replacement context to remote and local tracks');

for (const [label, bundle] of [['source', roomSource], ['ESM', esm]]) {
  assert.match(bundle, /addEventListener\('visibilitychange', handleDummyAudioVisibilityChange\)/,
    `${label} owns the iOS dummy-audio visibility listener by exact callback`);
  assert.match(bundle, /removeEventListener\('visibilitychange', handleDummyAudioVisibilityChange\)/,
    `${label} removes the exact callback when its Room disconnects`);
  assert.doesNotMatch(bundle, /addEventListener\('visibilitychange', \(\) => \{[\s\S]{0,700}triggering startAudio/,
    `${label} cannot retain the anonymous Room-capturing listener`);
}
assert.ok(umd.includes('document.addEventListener("visibilitychange",i.__livekitVisibilityHandler)'),
  'the UMD bundle owns its dummy-audio visibility callback');
assert.ok(umd.includes('document.removeEventListener("visibilitychange",i.__livekitVisibilityHandler)'),
  'the UMD bundle removes its exact dummy-audio callback');

// Exercise the patched browser bundle, not a local model: the first Room owns the shared iOS
// dummy element, a second Room reuses it, and each later owner must return listener count to zero.
{
  class TrackedEventTarget extends EventTarget {
    listeners = new Map();
    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
      const set = this.listeners.get(type) || new Set();
      set.add(listener); this.listeners.set(type, set);
    }
    removeEventListener(type, listener, options) {
      super.removeEventListener(type, listener, options);
      this.listeners.get(type)?.delete(listener);
    }
    listenerCount(type) { return this.listeners.get(type)?.size || 0; }
  }
  const elements = new Map();
  const fakeDocument = new TrackedEventTarget();
  fakeDocument.hidden = false;
  fakeDocument.getElementById = (id) => elements.get(id) || null;
  fakeDocument.createElement = () => {
    const element = {
      id: '', autoplay: false, hidden: false, muted: false, srcObject: null,
      play: () => Promise.resolve(),
      remove() { if (elements.get(this.id) === this) elements.delete(this.id); },
    };
    return element;
  };
  fakeDocument.body = { append: (element) => elements.set(element.id, element) };
  const fakeWindow = new TrackedEventTarget();
  fakeWindow.document = fakeDocument;
  fakeWindow.location = { protocol: 'https:', hostname: 'localhost' };
  const makeEmptyTrack = () => ({ enabled: false, clone: makeEmptyTrack });
  const emptyTrack = makeEmptyTrack();
  class FakeAudioContext {
    state = 'running';
    destination = {};
    createOscillator() { return { connect() {}, start() {} }; }
    createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [emptyTrack] } }; }
    resume() { return Promise.resolve(); }
  }
  class FakeMediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
  }
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      platform: 'iPhone', maxTouchPoints: 5,
      mediaDevices: { addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [] },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext, configurable: true });
  Object.defineProperty(globalThis, 'MediaStream', { value: FakeMediaStream, configurable: true });
  const { Room, RoomEvent } = await import('livekit-client');
  const first = new Room({ disconnectOnPageLeave: false, webAudioMix: true });
  const second = new Room({ disconnectOnPageLeave: false, webAudioMix: true });
  await first.startAudio();
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1);
  await second.startAudio();
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1,
    'a second live Room reuses the shared dummy without another visibility listener');
  first.emit(RoomEvent.Disconnected);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 0,
    'disconnect removes the exact first Room listener');
  await second.startAudio();
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1);
  second.emit(RoomEvent.Disconnected);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 0,
    'a later Room owner also leaves no retired visibility callback');

  const staleMixer = { state: 'closed' };
  const freshMixer = { state: 'running' };
  const rebound = new Room({
    disconnectOnPageLeave: false,
    webAudioMix: { audioContext: staleMixer },
  });
  rebound.options.webAudioMix.audioContext = freshMixer;
  await rebound.startAudio();
  assert.equal(rebound.audioContext, freshMixer,
    'startAudio consumes the exact mutable replacement mixer without reconnecting the Room');
  assert.equal(rebound.localParticipant.audioContext, freshMixer,
    'the existing local participant is rebound to the same fresh mixer');
  rebound.emit(RoomEvent.Disconnected);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 0);
}

console.log('livekit page lifecycle patch: ok');

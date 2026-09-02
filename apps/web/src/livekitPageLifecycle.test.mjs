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
  assert.match(bundle, /sharedDummyAudioEl\.__livekitRoomOwners \?\?= new Set\(\)/,
    `${label} records every Room sharing the iOS dummy-audio element`);
  assert.match(bundle, /addEventListener\('visibilitychange', sharedDummyAudioEl\.__livekitVisibilityHandler\)/,
    `${label} gives the shared dummy one exact visibility callback`);
  assert.match(bundle, /current\.__livekitRoomOwners\?\.delete\(this\)[\s\S]{0,150}current\.__livekitRoomOwners\?\.size/,
    `${label} releases only the disconnected Room's ownership`);
  assert.match(bundle, /removeEventListener\('visibilitychange', current\.__livekitVisibilityHandler\)/,
    `${label} removes the shared callback only with the final Room owner`);
  assert.match(bundle, /current\.__livekitStream\?\.getTracks\(\)\.forEach\(\(?track\)? => track\.stop\(\)\)/,
    `${label} stops the hidden audio track during final cleanup`);
  assert.match(bundle, /current\.remove\(\)[\s\S]{0,100}if \(dummyAudioEl === current\) dummyAudioEl = null/,
    `${label} releases the exact retired dummy reference after removing it`);
  assert.doesNotMatch(bundle, /addEventListener\('visibilitychange', \(\) => \{[\s\S]{0,700}triggering startAudio/,
    `${label} cannot retain the anonymous Room-capturing listener`);
}
assert.ok(umd.includes('document.addEventListener("visibilitychange",i.__livekitVisibilityHandler)'),
  'the UMD bundle owns one shared dummy-audio visibility callback');
assert.ok(umd.includes('i.__livekitRoomOwners||(i.__livekitRoomOwners=new Set)'),
  'the UMD bundle records every Room sharing the dummy element');
assert.ok(umd.includes('t.__livekitRoomOwners.delete(this),t.__livekitRoomOwners.size||'),
  'the UMD bundle preserves the dummy until its final Room owner disconnects');
assert.ok(umd.includes('document.removeEventListener("visibilitychange",t.__livekitVisibilityHandler)'),
  'the UMD bundle removes its exact callback during final cleanup');
assert.ok(umd.includes('t.__livekitStream.getTracks().forEach((e=>e.stop()))'),
  'the UMD bundle stops the hidden track during final cleanup');
assert.ok(umd.includes('t.remove(),i===t&&(i=null)))}))),t.push(i)}this.remoteParticipants'),
  'the UMD bundle releases the retired reference without closing the iOS block early');

for (const [label, bundle] of [['source', roomSource], ['ESM', esm]]) {
  assert.match(bundle, /this\.audioContext && this\.audioContext\.state !== 'running' && this\.audioContext\.state !== 'closed'/,
    `${label} retries WebKit interrupted contexts as well as standard suspended contexts`);
}
assert.ok(umd.includes('this.audioContext&&"running"!==this.audioContext.state&&"closed"!==this.audioContext.state'),
  'the UMD bundle also retries a reusable interrupted context');

for (const [label, bundle] of [['source', roomSource], ['ESM', esm]]) {
  assert.match(bundle, /e\.muted = Boolean\(this\.options\.webAudioMix && this\.audioContext && this\.audioContext\.state !== 'closed'\)[\s\S]{0,100}e\.id !== 'livekit-dummy-audio-el'/,
    `${label} mutes mixed elements only while a usable mixer owns their audio`);
  assert.doesNotMatch(bundle, /elements\.map\(\(?e\)? => \{\s*e\.muted = false/,
    `${label} cannot reopen a full-volume direct path from startAudio`);
}
assert.ok(umd.includes('e.muted=!!(this.options.webAudioMix&&this.audioContext&&"closed"!==this.audioContext.state)&&"livekit-dummy-audio-el"!==e.id'),
  'the UMD bundle also falls back to the direct path when no usable mixer exists');

// Exercise the patched browser bundle, not a local model: two Rooms retain one shared iOS dummy
// element, the first disconnect cannot interrupt the survivor, and the final owner releases all
// browser resources.
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
  let stoppedDummyTracks = 0;
  const makeEmptyTrack = () => ({
    enabled: false,
    clone: makeEmptyTrack,
    stop: () => { stoppedDummyTracks += 1; },
  });
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
  const directFallback = {
    id: 'remote-direct-audio', muted: true, play: () => Promise.resolve(),
  };
  first.remoteParticipants.set('direct-fallback', {
    audioTrackPublications: new Map([['audio', {
      track: { attachedElements: new Set([directFallback]) },
    }]]),
    setAudioContext() {},
  });
  await first.startAudio();
  assert.equal(first.audioContext, undefined,
    'this runtime intentionally has no usable AudioContext');
  assert.equal(directFallback.muted, false,
    'webAudioMix capability without an actual context must keep remote audio audible');
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1);
  await second.startAudio();
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1,
    'a second live Room reuses the shared dummy without another visibility listener');
  const sharedDummy = elements.get('livekit-dummy-audio-el');
  assert.ok(sharedDummy, 'both live Rooms retain one physical dummy element');
  assert.equal(sharedDummy.__livekitRoomOwners.size, 2,
    'both Rooms own the shared dummy before either disconnects');
  first.emit(RoomEvent.Disconnected);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1);
  assert.equal(elements.get('livekit-dummy-audio-el'), sharedDummy,
    'disconnecting the creator cannot remove the surviving Room\'s dummy');
  assert.equal(sharedDummy.__livekitRoomOwners.size, 1,
    'the survivor remains the exact owner after the creator disconnects');
  assert.equal(stoppedDummyTracks, 0,
    'the shared silent track keeps running while one Room is live');
  second.emit(RoomEvent.Disconnected);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 0,
    'the final Room owner leaves no retired visibility callback');
  assert.equal(elements.has('livekit-dummy-audio-el'), false,
    'the final Room owner removes the shared dummy element');
  assert.equal(stoppedDummyTracks, 1,
    'the final Room owner stops the shared silent track exactly once');

  let interruptedResumeCalls = 0;
  class FakeInterruptedAudioContext extends FakeAudioContext {
    state = 'interrupted';
    resume() {
      interruptedResumeCalls += 1;
      this.state = 'running';
      return Promise.resolve();
    }
  }
  fakeWindow.AudioContext = FakeInterruptedAudioContext;
  const interruptedElement = {
    id: 'remote-interrupted-audio', muted: false, play: () => Promise.resolve(),
  };
  const interrupted = new Room({ disconnectOnPageLeave: false, webAudioMix: true });
  interrupted.remoteParticipants.set('interrupted', {
    audioTrackPublications: new Map([['audio', {
      track: { attachedElements: new Set([interruptedElement]) },
    }]]),
    setAudioContext() {},
  });
  await interrupted.startAudio();
  const replacementDummy = elements.get('livekit-dummy-audio-el');
  assert.ok(replacementDummy && replacementDummy !== sharedDummy,
    'a later Room creates a fresh dummy after the prior final owner removed it');
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 1,
    'the replacement dummy owns exactly one fresh visibility callback');
  assert.equal(interruptedResumeCalls, 1,
    'startAudio resumes the exact WebKit interrupted mixer');
  assert.equal(interrupted.audioContext?.state, 'running');
  assert.equal(interruptedElement.muted, true,
    'the direct path stays muted once the mixer is actually running');
  interrupted.emit(RoomEvent.Disconnected);
  assert.equal(fakeDocument.listenerCount('visibilitychange'), 0);
  assert.equal(elements.has('livekit-dummy-audio-el'), false,
    'the replacement Room also removes its dummy during final cleanup');
  assert.equal(stoppedDummyTracks, 2,
    'each retired dummy stream is stopped exactly once');

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

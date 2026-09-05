// Temporary, fail-closed patch for LiveKit 2.20.0's WebAudio volume reset.
// Only the ESM export used by Vite/browser/desktop is patched; no SDK internals
// are overridden at runtime. Remove once an upstream release passes our tests.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const originalHash = '13117f65265462db5cbf1b3fd87e62174e5e968737a01640b71408b7e71c0aad';
export const patchedHash = 'a853f99cfbe385921ca6a0731d815d4c150c11a7be75eec8e5377fd73e5af812';
const hash = (source) => createHash('sha256').update(source).digest('hex');

export function patchSource(source) {
  if (hash(source) !== originalHash) throw new Error('Unexpected LiveKit ESM artifact; review the audio patch before updating the SDK');
  const begin = source.indexOf('class RemoteAudioTrack extends RemoteTrack {');
  const end = source.indexOf('class TrackPublication extends ', begin + 1);
  if (begin < 0 || end < 0) throw new Error('RemoteAudioTrack boundary not found');
  let audio = source.slice(begin, end);
  const replace = (before, after, count = 1) => {
    if (audio.split(before).length - 1 !== count) throw new Error('Unexpected RemoteAudioTrack implementation');
    audio = audio.replaceAll(before, after);
  };
  replace(`    if (this.audioContext && needsNewWebAudioConnection) {
      this.log.debug('using audio context mapping', this.logContext);
      this.connectWebAudio(this.audioContext, element);
      element.volume = 0;
      element.muted = true;
    }`, `    if (this.audioContext) {
      element.volume = 0;
      element.muted = true;
      if (needsNewWebAudioConnection) {
        this.log.debug('using audio context mapping', this.logContext);
        this.connectWebAudio(this.audioContext, element);
      }
    }`);
  replace(`  setAudioContext(audioContext) {
    this.audioContext = audioContext;
    if (audioContext && this.attachedElements.length > 0) {
      this.connectWebAudio(audioContext, this.attachedElements[0]);`, `  setAudioContext(audioContext) {
    if (audioContext && this.audioContext === audioContext && this.gainNode) return;
    this.audioContext = audioContext;
    if (audioContext && this.attachedElements.length > 0) {
      for (const element of this.attachedElements) {
        element.volume = 0;
        element.muted = true;
      }
      this.connectWebAudio(audioContext, this.attachedElements[0]);`);
  replace(`    this.gainNode = context.createGain();
    lastNode.connect(this.gainNode);
    this.gainNode.connect(context.destination);
    if (this.elementVolume) {
      this.gainNode.gain.setTargetAtTime(this.elementVolume, 0, 0.1);
    }`, `    this.gainNode = context.createGain();
    // Initialize BEFORE connecting: a new gain starts at 1, including muted tracks.
    this.gainNode.gain.value = this.elementVolume ?? 1;
    lastNode.connect(this.gainNode);
    this.gainNode.connect(context.destination);`);
  replace('if (this.elementVolume) {', 'if (this.elementVolume !== undefined) {', 2);
  const patched = source.slice(0, begin) + audio + source.slice(end);
  const startAudio = `        yield Promise.all([this.acquireAudioContext(), ...elements.map(e => {
          e.muted = false;
          return e.play();
        })]);`;
  if (patched.split(startAudio).length !== 2) throw new Error('Unexpected Room.startAudio implementation');
  return patched.replace(startAudio, `        yield Promise.all([this.acquireAudioContext(), ...elements.map(e => {
          // Mixed tracks play only through their gain; keep the iOS unlock element audible.
          e.muted = Boolean(this.options.webAudioMix && this.audioContext && this.audioContext.state !== 'closed')
            && e.id !== 'livekit-dummy-audio-el';
          return e.play();
        })]);`);
}

function main() {
  const sdk = new URL('../node_modules/livekit-client/', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', sdk), 'utf8'));
  if (pkg.version !== '2.20.0' || pkg.exports['.'].import !== './dist/livekit-client.esm.mjs') {
    throw new Error('Unexpected LiveKit version/export; review the audio patch');
  }
  const path = new URL('dist/livekit-client.esm.mjs', sdk);
  const source = readFileSync(path, 'utf8');
  if (hash(source) === patchedHash) return;
  if (process.argv.includes('--check')) throw new Error('LiveKit audio patch missing; run npm install in apps/web');
  const patched = patchSource(source);
  if (process.argv.includes('--print-hash')) { console.log(hash(patched)); return; }
  if (hash(patched) !== patchedHash) throw new Error('LiveKit audio patch integrity check failed');
  writeFileSync(path, patched);
  console.log('Applied LiveKit WebAudio volume fix');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

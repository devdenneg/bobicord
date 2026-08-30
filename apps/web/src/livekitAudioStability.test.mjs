import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'livekitAudioStability.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { installLiveKitAudioGainStability } = await import('data:text/javascript,' + encodeURIComponent(js));

class FakeRemoteAudioTrack {}
let contextAssignments = 0;
FakeRemoteAudioTrack.prototype.setAudioContext = function setAudioContext(context) {
  contextAssignments++;
  this.audioContext = context;
};
FakeRemoteAudioTrack.prototype.connectWebAudio = function connectWebAudio(context) {
  const history = [];
  const gain = {
    value: 1,
    setTargetAtTime(value) { history.push(['target', value]); this.value = value; },
    cancelScheduledValues(time) { history.push(['cancel', time]); },
    setValueAtTime(value, time) { history.push(['exact', value, time]); this.value = value; },
  };
  this.gainNode = { gain };
  if (this.elementVolume) gain.setTargetAtTime(this.elementVolume, 0, 0.1);
  this.history = history;
  return 'connected';
};

installLiveKitAudioGainStability(FakeRemoteAudioTrack);
installLiveKitAudioGainStability(FakeRemoteAudioTrack); // idempotent

const runningContext = { state: 'running', currentTime: 7 };
const quiet = new FakeRemoteAudioTrack();
quiet.audioContext = runningContext;
quiet.elementVolume = 0.2;
quiet.setAudioContext(runningContext);
assert.equal(contextAssignments, 0, 'startAudio cannot recreate gains for the same live context');
assert.equal(quiet.connectWebAudio(runningContext, {}), 'connected');
assert.equal(quiet.gainNode.gain.value, 0.2);
assert.deepEqual(quiet.history.at(-1), ['exact', 0.2, 7], 'a new gain ends the same task at the saved value');

const muted = new FakeRemoteAudioTrack();
muted.elementVolume = 0;
muted.connectWebAudio(runningContext, {});
assert.equal(muted.gainNode.gain.value, 0, 'an exact mute is not skipped as a falsy value');
assert.deepEqual(muted.history.at(-1), ['exact', 0, 7]);

const closedContext = { state: 'closed', currentTime: 8 };
muted.audioContext = closedContext;
muted.setAudioContext(closedContext);
assert.equal(contextAssignments, 1, 'a genuinely closed context still follows normal SDK recovery');

console.log('LiveKit audio gain stability: ok');

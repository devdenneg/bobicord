import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'voiceDiagnosticRtc.ts'), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  advanceVoiceDiagnosticSilence,
  emptyVoiceDiagnosticSilenceState,
  voiceDiagnosticInboundExpected,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

assert.equal(voiceDiagnosticInboundExpected({
  transportObservable: true, deafened: false, canPlaybackAudio: true,
  outputAudible: true, speakingRemote: false,
}), false, 'an unmuted but quiet remote participant is not expected audio');
assert.equal(voiceDiagnosticInboundExpected({
  transportObservable: true, deafened: false, canPlaybackAudio: true,
  outputAudible: true, speakingRemote: true,
}), true, 'positive remote-speaking evidence arms inbound silence observation');
for (const excluded of ['transportObservable', 'canPlaybackAudio', 'outputAudible']) {
  const input = {
    transportObservable: true, deafened: false, canPlaybackAudio: true,
    outputAudible: true, speakingRemote: true,
  };
  input[excluded] = false;
  assert.equal(voiceDiagnosticInboundExpected(input), false, `${excluded}=false disarms observation`);
}
assert.equal(voiceDiagnosticInboundExpected({
  transportObservable: true, deafened: true, canPlaybackAudio: true,
  outputAudible: true, speakingRemote: true,
}), false, 'intentional deafen disarms observation');

let state = emptyVoiceDiagnosticSilenceState();
let transition;
for (const now of [2_500, 5_000, 7_500]) {
  transition = advanceVoiceDiagnosticSilence(state, true, true, false, now - 2_500, now);
  state = transition.state;
  assert.equal(transition.started, false, 'fewer than four silent samples cannot report');
}
transition = advanceVoiceDiagnosticSilence(state, true, true, false, 7_500, 10_000);
state = transition.state;
assert.equal(transition.started, true, 'four consecutive intervals spanning at least eight seconds report once');
transition = advanceVoiceDiagnosticSilence(state, true, true, false, 10_000, 12_500);
state = transition.state;
assert.equal(transition.started, false, 'an ongoing stall does not emit repeated starts');
transition = advanceVoiceDiagnosticSilence(state, true, true, true, 12_500, 15_000);
assert.equal(transition.recovered, true, 'the first progressing sample closes a reported stall');
assert.deepEqual(transition.state, emptyVoiceDiagnosticSilenceState());

state = advanceVoiceDiagnosticSilence(emptyVoiceDiagnosticSilenceState(), true, true, false, 0, 2_500).state;
for (const [expected, comparable, label] of [
  [false, true, 'intentional silence'],
  [true, false, 'non-comparable reconnect/background sample'],
]) {
  const reset = advanceVoiceDiagnosticSilence(state, expected, comparable, false, 2_500, 5_000);
  assert.deepEqual(reset.state, emptyVoiceDiagnosticSilenceState(), `${label} resets the consecutive window`);
  assert.equal(reset.started, false);
  assert.equal(reset.recovered, false);
}

console.log('voice diagnostic rtc silence: ok');

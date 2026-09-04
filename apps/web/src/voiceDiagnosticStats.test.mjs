import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./voiceDiagnosticStats.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { summarizeVoiceDiagnosticStats } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
const report = (timestamp, n = 0, ssrc = 7) => new Map([
  ['out', { id: 'out', type: 'outbound-rtp', kind: 'audio', ssrc, timestamp, packetsSent: 100 + n, bytesSent: 500 + 10 * n }],
  ['remote', { id: 'remote', type: 'remote-inbound-rtp', kind: 'audio', ssrc, timestamp, packetsLost: 2 + n, roundTripTime: .025, jitter: .007 }],
  ['in', { id: 'in', type: 'inbound-rtp', mediaType: 'audio', ssrc: 8, timestamp, packetsReceived: 200 + n, bytesReceived: 800 + 20 * n }],
  ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', ssrc: 9, timestamp, packetsSent: 90_000 + n }],
  ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'active-pair' }],
  ['active-pair', { id: 'active-pair', type: 'candidate-pair', currentRoundTripTime: .04, address: 'sensitive-address' }],
  ['old-pair', { id: 'old-pair', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 2 }],
]);

const first = summarizeVoiceDiagnosticStats(report(1000));
assert.deepEqual(first.event, { kind: 'rtc_sample', stage: 'rtc', rttMs: 25, jitterMs: 7 }, 'first report has no made-up lifetime deltas');
const next = summarizeVoiceDiagnosticStats(report(3500, 3), first.state);
assert.deepEqual(next.event, {
  kind: 'rtc_sample', stage: 'rtc', rttMs: 25, jitterMs: 7,
  packetsSentDelta: 3, bytesSentDelta: 30, packetsReceivedDelta: 3, bytesReceivedDelta: 60, packetsLostDelta: 3,
});
assert.equal(JSON.stringify(next.event).includes('active-pair'), false);
assert.equal(JSON.stringify(next).includes('sensitive-address'), false, 'neither event nor retained state contains raw candidate data');
assert.equal(next.state.samples.length, 3, 'video and candidate counters never enter the audio baseline');

const resetSsrc = summarizeVoiceDiagnosticStats(report(6000, 1, 11), next.state);
assert.equal(resetSsrc.event.packetsSentDelta, undefined, 'a reused stat id with a new SSRC gets a new baseline');
assert.equal(resetSsrc.event.packetsLostDelta, undefined);
assert.equal(resetSsrc.event.packetsReceivedDelta, undefined, 'a receiver counter reset does not produce a negative delta');
const afterReset = summarizeVoiceDiagnosticStats(report(8500, 2, 11), resetSsrc.state);
assert.equal(afterReset.event.packetsSentDelta, 1);
const reordered = summarizeVoiceDiagnosticStats(report(7000, 1, 11), afterReset.state);
assert.equal(reordered.event.packetsSentDelta, undefined, 'late reports do not move the baseline backwards');
assert.equal(summarizeVoiceDiagnosticStats(report(11000, 4, 11), reordered.state).event.packetsSentDelta, 2);

const corrected = report(6000, 4);
corrected.get('remote').packetsLost = -1;
assert.equal(summarizeVoiceDiagnosticStats(corrected, next.state).event.packetsLostDelta, 0, 'late packet corrections never create negative loss');
const withoutRemote = report(1000);
withoutRemote.delete('remote');
assert.equal(summarizeVoiceDiagnosticStats(withoutRemote).event.rttMs, 40, 'candidate fallback honors the selected transport over an obsolete pair');
const legacy = new Map([['pair', { id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: .05 }]]);
assert.equal(summarizeVoiceDiagnosticStats({ forEach: (callback) => legacy.forEach(callback) }).event.rttMs, 50);
const invalid = report(1000);
invalid.get('remote').jitter = NaN;
invalid.get('remote').roundTripTime = Infinity;
assert.equal(summarizeVoiceDiagnosticStats(invalid).event.jitterMs, undefined);
assert.equal(summarizeVoiceDiagnosticStats(invalid).event.rttMs, 40);

const many = new Map(Array.from({ length: 100 }, (_, index) => [index, {
  id: String(index), type: 'outbound-rtp', kind: 'audio', timestamp: 1, packetsSent: index,
}]));
assert.equal(summarizeVoiceDiagnosticStats(many).state.samples.length, 64, 'per-report baseline is strictly bounded');
console.log('voice diagnostic stats: ok');

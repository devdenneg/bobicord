import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'voiceDiagnostics.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  VoiceDiagnosticsRecorder,
  VoiceEventLoopStallMonitor,
  detectVoiceDiagnosticClient,
  detectVoiceDiagnosticNetworkType,
  VOICE_DIAGNOSTIC_MAX_EVENTS,
  VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES,
} = await import('data:text/javascript,' + encodeURIComponent(js));

{
  const ios = detectVoiceDiagnosticClient({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    platform: 'iPhone',
    standalone: true,
    effectiveNetworkType: '4g',
    appVersion: '01.002.0003-000004',
  });
  assert.deepEqual(ios, {
    kind: 'web', platform: 'ios', installMode: 'standalone', networkType: '4g', appVersion: '1.2.3.4',
  });
  assert.equal(detectVoiceDiagnosticClient({
    userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5,
  }).platform, 'ipados', 'touch-capable MacIntel identifies iPadOS');
  assert.deepEqual(detectVoiceDiagnosticClient({
    native: true, platform: 'MacIntel', connectionType: 'ethernet', appVersion: 'not a release',
  }), {
    kind: 'native', platform: 'macos', installMode: 'native', networkType: 'ethernet',
  }, 'native mode wins and an unsafe version is omitted');
  assert.equal(detectVoiceDiagnosticNetworkType({ connectionType: 'vpn', effectiveNetworkType: '5g' }), 'other');
  assert.equal(detectVoiceDiagnosticNetworkType({}), 'unknown');
}

{
  let now = 100;
  const recorder = new VoiceDiagnosticsRecorder({
    now: () => now,
    createReportId: () => '0123456789abcdef01234567',
    client: {
      kind: 'web', platform: 'android', installMode: 'browser', networkType: 'wifi',
      appVersion: '2.7.1',
    },
  });
  assert.equal(recorder.record({ kind: 'join_started' }), false, 'an inactive recorder collects nothing');
  recorder.start();
  for (let index = 0; index < VOICE_DIAGNOSTIC_MAX_EVENTS + 12; index += 1) {
    now += 10;
    recorder.record({ kind: 'rtc_sample', reconnectCount: index });
  }
  const accepted = recorder.record({
    kind: 'join_failed',
    stage: 'media_connect',
    outcome: 'failed',
    code: 'network',
    httpStatus: 503,
    documentHidden: false,
    audioLevel: 9,
    eventLoopLagMs: -20,
    // Runtime callers can be JavaScript. These values must never be copied into the report.
    privatePayload: 'DO_NOT_STORE_THIS_VALUE',
    message: 'DO_NOT_STORE_THIS_VALUE',
    stack: 'DO_NOT_STORE_THIS_VALUE',
    atMs: 999_999,
  });
  assert.equal(accepted, true);
  now -= 5_000;
  recorder.record({ kind: 'left' });
  const report = recorder.buildReport('connection_failed');
  assert.equal(report.clientReportId, '0123456789abcdef01234567');
  assert.equal(report.events.length, VOICE_DIAGNOSTIC_MAX_EVENTS);
  assert.equal(report.truncated, true);
  assert.equal(report.events.at(-1).atMs, report.events.at(-2).atMs, 'elapsed time never moves backwards');
  const failure = report.events.at(-2);
  assert.deepEqual(failure, {
    atMs: 1_400,
    kind: 'join_failed',
    stage: 'media_connect',
    outcome: 'failed',
    code: 'network',
    httpStatus: 503,
    documentHidden: false,
    audioLevel: 1,
    eventLoopLagMs: 0,
  });
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_STORE_THIS_VALUE/);
  report.events[0].kind = 'left';
  assert.notEqual(recorder.buildReport('manual').events[0].kind, 'left', 'reports do not expose the ring buffer');
  assert.throws(() => recorder.buildReport('arbitrary_failure'), TypeError);
  recorder.reset();
  assert.equal(recorder.active, false);
  assert.deepEqual(recorder.buildReport('manual').events, []);
}

{
  let now = 0;
  const recorder = new VoiceDiagnosticsRecorder({
    now: () => now,
    createReportId: () => '111111111111111111111111',
    client: { kind: 'native', platform: 'macos', installMode: 'native', networkType: 'ethernet' },
  });
  recorder.start();
  now = 48 * 60 * 60_000;
  recorder.record({ kind: 'rtc_sample' });
  const report = recorder.buildReport('manual');
  assert.equal(report.durationMs, now, 'a multi-day desktop call keeps its real bounded duration');
  assert.equal(report.events[0].atMs, now, 'multi-day event timestamps do not collapse at minute ten');
}

{
  let now = 0;
  const recorder = new VoiceDiagnosticsRecorder({
    now: () => ++now,
    createReportId: () => 'abcdef0123456789abcdef01',
    client: { kind: 'native', platform: 'macos', installMode: 'native', networkType: 'ethernet' },
  });
  recorder.start();
  const full = {
    kind: 'rtc_sample', stage: 'rtc', outcome: 'ok', code: 'none', connectionState: 'connected',
    iceState: 'connected', trackState: 'live', audioContextState: 'running', outputRoute: 'custom',
    micMode: 'voice', networkType: 'ethernet', documentHidden: false, online: true,
    micEnabled: true, publicationMuted: false, upstreamPaused: false, deafened: false,
    pushToTalk: false, speechDetected: true, canPlaybackAudio: true, rttMs: 120_000,
    jitterMs: 120_000, packetsLostDelta: 10_000_000, packetsReceivedDelta: 100_000_000,
    packetsSentDelta: 100_000_000, bytesReceivedDelta: 2_000_000_000,
    bytesSentDelta: 2_000_000_000, concealedSamplesDelta: 2_000_000_000,
    audioLevel: 1, eventLoopLagMs: 120_000, joinElapsedMs: 600_000,
    reconnectCount: 1_000, participantCount: 10_000,
  };
  for (let index = 0; index < VOICE_DIAGNOSTIC_MAX_EVENTS; index++) recorder.record(full);
  const bounded = recorder.buildReport('inbound_silent');
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES,
    'a maximal fixed-schema report fits beneath the route parser limit');
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.events.length < VOICE_DIAGNOSTIC_MAX_EVENTS);
}

{
  let now = 0;
  let hidden = false;
  let nextTimer = 0;
  const timers = new Map();
  const stalls = [];
  const setTimer = (callback) => {
    assert.equal(timers.size, 0, 'the watchdog owns at most one timer');
    const handle = ++nextTimer;
    timers.set(handle, callback);
    return handle;
  };
  const clearTimer = (handle) => { timers.delete(handle); };
  const fire = () => {
    assert.equal(timers.size, 1);
    const [handle, callback] = timers.entries().next().value;
    timers.delete(handle);
    callback();
  };
  const monitor = new VoiceEventLoopStallMonitor((lagMs) => stalls.push(lagMs), {
    now: () => now,
    setTimer,
    clearTimer,
    isDocumentHidden: () => hidden,
    intervalMs: 1_000,
    thresholdMs: 800,
    cooldownMs: 5_000,
  });
  assert.equal(monitor.start(), true);
  assert.equal(monitor.start(), false, 'repeated session activation cannot allocate a second timer');
  now = 1_900;
  fire();
  assert.deepEqual(stalls, [900]);
  now = 3_900;
  fire();
  assert.deepEqual(stalls, [900], 'cooldown suppresses a repeated stall');
  hidden = true;
  now = 10_900;
  fire();
  assert.deepEqual(stalls, [900], 'background timer throttling is not reported as a UI stall');
  hidden = false;
  now = 12_800;
  fire();
  assert.deepEqual(stalls, [900, 900], 'a later visible-page stall is reported after cooldown');
  monitor.stop();
  assert.equal(monitor.active, false);
  assert.equal(timers.size, 0, 'stopping the voice session clears its only timer');

  const throwing = new VoiceEventLoopStallMonitor(() => { throw new Error('observer failure'); }, {
    now: () => now,
    setTimer,
    clearTimer,
    isDocumentHidden: () => false,
    intervalMs: 1_000,
    thresholdMs: 800,
  });
  throwing.start();
  now += 1_900;
  assert.doesNotThrow(fire, 'diagnostics observers cannot destabilize the media session');
  assert.equal(timers.size, 1, 'the watchdog rearms after an observer failure');
  throwing.stop();
}

console.log('voice diagnostics client: ok');

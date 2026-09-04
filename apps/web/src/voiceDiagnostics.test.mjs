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
  let now = 0;
  const secret = 'AUTH_SECRET_MUST_NOT_BE_RECORDED';
  const recorder = new VoiceDiagnosticsRecorder({
    now: () => now,
    createReportId: () => '333333333333333333333333',
    client: { kind: 'web', platform: 'ios', installMode: 'browser', networkType: 'wifi' },
  });
  recorder.start();
  const stages = ['auth_login', 'auth_session', 'auth_profile'];
  const codes = ['auth', 'network', 'timeout', 'aborted', 'unknown', 'rate_limited', 'server', 'invalid_response'];
  for (const [index, code] of codes.entries()) {
    const stage = stages[index % stages.length];
    recorder.record({ kind: 'auth_request_started', stage, outcome: 'started' });
    now += 250;
    recorder.record({
      kind: 'auth_request_finished', stage, outcome: 'failed', code,
      httpStatus: index === 0 ? 401 : 0, requestElapsedMs: 250,
      username: secret, password: secret, token: secret, refreshToken: secret,
      url: secret, body: { password: secret }, headers: { Authorization: secret }, error: secret,
    });
  }
  for (const incident of ['auth_failed', 'auth_recovered']) {
    const report = recorder.buildReport(incident);
    assert.equal(report.durationMs, 2_000);
    assert.deepEqual(report.events[1], {
      atMs: 250, kind: 'auth_request_finished', stage: 'auth_login', outcome: 'failed',
      code: 'auth', httpStatus: 401, requestElapsedMs: 250,
    });
    assert.equal(report.events[3].httpStatus, 0, 'a network failure records no HTTP response');
    assert.doesNotMatch(JSON.stringify(report), /AUTH_SECRET_MUST_NOT_BE_RECORDED/);
  }
  recorder.reset();
  recorder.start();
  const invalidStatuses = [-1, 600, 401.5, '401', NaN, Infinity];
  const elapsedInputs = [-1, 120_001, 1.6, '250', NaN, Infinity];
  for (const [index, httpStatus] of invalidStatuses.entries()) {
    recorder.record({
      kind: 'auth_request_finished', stage: secret, code: secret, httpStatus,
      requestElapsedMs: elapsedInputs[index],
    });
  }
  const bounded = recorder.buildReport('auth_failed');
  assert.deepEqual(bounded.events.map((event) => event.requestElapsedMs), [0, 120_000, 2, undefined, undefined, undefined]);
  assert.equal(bounded.events.some((event) => 'httpStatus' in event || 'stage' in event || 'code' in event), false);
}

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
  const recorder = new VoiceDiagnosticsRecorder({ now: () => 0 });
  recorder.start();
  for (const micCapturePath of ['direct', 'webaudio', 'PRIVATE_DEVICE_PATH']) {
    recorder.record({ kind: 'mic_capture_finished', stage: 'mic_capture', micCapturePath });
  }
  const report = recorder.buildReport('mic_failed');
  assert.deepEqual(report.events.map((event) => event.micCapturePath), ['direct', 'webaudio', undefined]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DEVICE_PATH/);
}

{
  const recorder = new VoiceDiagnosticsRecorder({ now: () => 0 });
  recorder.start();
  const audioSessionTypes = ['auto', 'play-and-record', 'playback', 'ambient', 'transient', 'transient-solo'];
  const audioSessionStates = ['active', 'inactive', 'interrupted'];
  const captureEvents = ['mute', 'unmute', 'ended', 'session_state'];
  for (const [index, audioSessionType] of audioSessionTypes.entries()) {
    recorder.record({
      kind: 'mic_source_changed', stage: 'mic_capture', documentHidden: true,
      rawTrackMuted: true, rawTrackEnabled: true, publishedTrackEnabled: false,
      audioSessionType, audioSessionState: audioSessionStates[index % 3], captureEvent: captureEvents[index % 4],
      label: 'PRIVATE_CAPTURE_DETAIL', deviceId: 'PRIVATE_CAPTURE_DETAIL', osStatus: 'PRIVATE_CAPTURE_DETAIL',
    });
  }
  recorder.record({ kind: 'background', rawTrackMuted: false, rawTrackEnabled: false, publishedTrackEnabled: true });
  recorder.record({
    kind: 'mic_source_changed', audioSessionState: 'PRIVATE_CAPTURE_DETAIL', audioSessionType: 'PRIVATE_CAPTURE_DETAIL',
    captureEvent: 'PRIVATE_CAPTURE_DETAIL', rawTrackMuted: 'true', rawTrackEnabled: 1, publishedTrackEnabled: null,
  });
  const report = recorder.buildReport('mic_failed');
  assert.deepEqual(report.events.slice(0, 6).map((event) => event.audioSessionType), audioSessionTypes);
  assert.deepEqual(report.events[0], {
    atMs: 0, kind: 'mic_source_changed', stage: 'mic_capture', documentHidden: true,
    rawTrackMuted: true, rawTrackEnabled: true, publishedTrackEnabled: false,
    audioSessionType: 'auto', audioSessionState: 'active', captureEvent: 'mute',
  });
  assert.deepEqual(report.events[6], {
    atMs: 0, kind: 'background', rawTrackMuted: false, rawTrackEnabled: false, publishedTrackEnabled: true,
  }, 'the same fixed fields also survive common diagnostic snapshots');
  assert.deepEqual(report.events[7], { atMs: 0, kind: 'mic_source_changed' });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_CAPTURE_DETAIL/);
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
    createReportId: () => '222222222222222222222222',
    client: { kind: 'native', platform: 'windows', installMode: 'native', networkType: 'wifi' },
  });
  const stages = [
    'watch_intent', 'watch_auth', 'watch_listeners', 'watch_native_start',
    'watch_signaling', 'watch_join', 'watch_parent', 'watch_negotiation',
    'watch_track', 'watch_playback', 'watch_recovery',
  ];
  const codes = [
    'signaling_unauthorized', 'signaling_forbidden', 'listener_failed',
    'native_start_failed', 'signaling_closed', 'no_parent', 'negotiation_failed',
    'ice_failed', 'track_missing', 'decode_timeout', 'playback_waiting',
  ];
  const kinds = ['stream_watch_started', 'stream_watch_step', 'stream_watch_retry', 'stream_watch_finished'];
  const transports = ['livekit', 'tree_web', 'tree_native'];
  recorder.start();
  for (let index = 0; index < stages.length; index += 1) {
    assert.equal(recorder.record({
      kind: kinds[index % kinds.length],
      stage: stages[index],
      outcome: index === stages.length - 1 ? 'recovered' : 'started',
      code: codes[index],
      streamTransport: transports[index % transports.length],
      ...(index === 7 ? { watchEndReason: 'auth_handoff' } : {}),
    }), true);
  }
  recorder.record({
    kind: 'stream_watch_step', stage: 'watch_signaling', outcome: 'failed',
    code: 'signaling_closed', streamTransport: 'raw-peer-route',
    watchEndReason: 'raw-lifecycle-detail',
    streamId: 'DO_NOT_STORE_STREAM_ID', sdp: 'DO_NOT_STORE_SDP', error: 'DO_NOT_STORE_ERROR',
  });
  for (const incident of ['stream_watch_succeeded', 'stream_watch_failed', 'stream_watch_recovered']) {
    const report = recorder.buildReport(incident);
    assert.equal(report.incident, incident);
    assert.equal(report.schemaVersion, 1, 'stream diagnostics remain backward-compatible schema v1');
    assert.equal(report.events.length, stages.length + 1);
    assert.deepEqual(report.events.slice(0, stages.length).map((event) => event.stage), stages);
    assert.deepEqual(report.events.slice(0, stages.length).map((event) => event.code), codes);
    assert.deepEqual(report.events.slice(0, stages.length).map((event) => event.streamTransport),
      stages.map((_, index) => transports[index % transports.length]));
    assert.equal(report.events[7].watchEndReason, 'auth_handoff');
    assert.equal('streamTransport' in report.events.at(-1), false, 'unknown transport values are discarded');
    assert.equal('watchEndReason' in report.events.at(-1), false, 'unknown lifecycle reasons are discarded');
    assert.doesNotMatch(JSON.stringify(report), /DO_NOT_STORE/,
      'stream identity, SDP and raw errors never enter the fixed report');
  }
}

{
  let now = 0;
  const recorder = new VoiceDiagnosticsRecorder({
    now: () => now,
    createReportId: () => '454545454545454545454545',
    client: { kind: 'native', platform: 'macos', installMode: 'native', networkType: 'wifi' },
  });
  recorder.start();
  recorder.record({
    kind: 'join_started', stage: 'intent', outcome: 'started', joinElapsedMs: 0,
    token: 'DO_NOT_STORE_TOKEN', deviceId: 'DO_NOT_STORE_DEVICE_ID', rawPayload: 'DO_NOT_STORE_PAYLOAD',
  });
  now = 6_600;
  recorder.record({
    kind: 'media_activated', stage: 'activation', outcome: 'ok', code: 'none', joinElapsedMs: now,
    sdp: 'DO_NOT_STORE_SDP', identity: 'DO_NOT_STORE_IDENTITY',
  });
  recorder.record({ kind: 'join_completed', outcome: 'ok', joinElapsedMs: now });
  const slowJoin = recorder.buildReport('join_stuck');
  assert.deepEqual(slowJoin.events, [
    { atMs: 0, kind: 'join_started', stage: 'intent', outcome: 'started', joinElapsedMs: 0 },
    { atMs: 6_600, kind: 'media_activated', stage: 'activation', outcome: 'ok', code: 'none', joinElapsedMs: 6_600 },
    { atMs: 6_600, kind: 'join_completed', outcome: 'ok', joinElapsedMs: 6_600 },
  ], 'a slow successful join retains only the bounded stage timeline');
  assert.doesNotMatch(JSON.stringify(slowJoin), /DO_NOT_STORE/,
    'a slow successful join cannot upload tokens, device identifiers, SDP or raw payloads');
}

{
  let now = 0;
  const recorder = new VoiceDiagnosticsRecorder({
    now: () => ++now,
    createReportId: () => '333333333333333333333333',
    client: { kind: 'web', platform: 'macos', installMode: 'standalone', networkType: 'wifi' },
  });
  recorder.start();
  recorder.record({
    kind: 'output_route_failed', stage: 'output_route', outcome: 'failed', code: 'invalid_state',
    outputRoute: 'default', outputTarget: 'voice_mixer', outputOperation: 'set_sink',
    error: 'DO_NOT_STORE_RAW_ERROR', deviceId: 'DO_NOT_STORE_DEVICE_ID',
  });
  recorder.record({
    kind: 'output_route_failed', stage: 'output_route', outcome: 'failed', code: 'browser-secret',
    outputTarget: 'hardware-id-from-client', outputOperation: 'raw-browser-method',
  });
  recorder.record({
    kind: 'media_activated', stage: 'activation', outcome: 'failed', code: 'session_closing',
    httpStatus: 409, error: 'DO_NOT_STORE_SERVER_RESPONSE',
  });
  const events = recorder.buildReport('output_route_failed').events;
  assert.deepEqual(events[0], {
    atMs: 1, kind: 'output_route_failed', stage: 'output_route', outcome: 'failed',
    code: 'invalid_state', outputRoute: 'default', outputTarget: 'voice_mixer', outputOperation: 'set_sink',
  });
  assert.deepEqual(events[1], {
    atMs: 2, kind: 'output_route_failed', stage: 'output_route', outcome: 'failed',
  }, 'unknown diagnostic categories are discarded rather than copied');
  assert.deepEqual(events[2], {
    atMs: 3, kind: 'media_activated', stage: 'activation', outcome: 'failed',
    code: 'session_closing', httpStatus: 409,
  }, 'activation closing backoff keeps only its fixed protocol category and HTTP status');
  assert.doesNotMatch(JSON.stringify(events), /DO_NOT_STORE|hardware-id|raw-browser/,
    'output diagnostics contain no raw errors or hardware identifiers');
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
    outputTarget: 'stream_mixer', outputOperation: 'enumerate',
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

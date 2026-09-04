const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  VoiceDiagnosticValidationError,
  VOICE_DIAGNOSTIC_RETENTION_MS,
  createVoiceDiagnosticGlobalLimiter,
  createVoiceDiagnosticUserLimiter,
  createVoiceDiagnosticsStore,
  isVoiceDiagnosticControlIncident,
  isVoiceDiagnosticsAdmin,
  sanitizeVoiceDiagnosticReport,
} = require('./voiceDiagnostics');

assert.equal(VOICE_DIAGNOSTIC_RETENTION_MS, 3 * 24 * 60 * 60_000,
  'production voice diagnostics retain only the latest three days');

function validReport(overrides = {}) {
  return {
    schemaVersion: 1,
    incident: 'join_stuck',
    client: { kind: 'web', platform: 'ios', installMode: 'standalone', networkType: '4g', appVersion: '1.2.3' },
    durationMs: 12_345,
    events: [{ atMs: 0, kind: 'join_started', stage: 'intent', outcome: 'started' }],
    ...overrides,
  };
}

test('diagnostic access is bootstrap-only even for another administrator', () => {
  assert.equal(isVoiceDiagnosticsAdmin({ username: 'denis', is_admin: 0 }), true);
  assert.equal(isVoiceDiagnosticsAdmin({ username: 'other-admin', is_admin: 1 }), false);
  assert.equal(isVoiceDiagnosticsAdmin({ username: 'denis-copy', is_admin: 1 }), false);
  assert.equal(isVoiceDiagnosticsAdmin(null), false);

  const serverSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(serverSource, /app\.get\('\/api\/admin\/diagnostics\/voice', noStoreResponse, requireDiagnosticsAdmin,/,
    'the report list GET is no-store and bootstrap-policy protected');
  assert.match(serverSource, /app\.get\('\/api\/admin\/diagnostics\/voice\/:id', noStoreResponse, requireDiagnosticsAdmin,/,
    'the report detail GET is no-store and bootstrap-policy protected');
  assert.match(serverSource, /req\.path === '\/api\/diag\/voice'[\s\S]*setHeader\('Cache-Control', 'no-store'\)[\s\S]*const parser/,
    'parser failures on the upload endpoint are non-cacheable too');
  assert.match(serverSource, /PAYLOAD_TOO_LARGE[\s\S]*Тело запроса слишком большое/,
    'oversized structured reports never receive a misleading file-upload error');
  assert.doesNotMatch(serverSource, /console\.(?:log|info|warn|error)\([^\n]*\[voice-diag\] stored/,
    'per-report metadata is not copied to Docker logs whose rotation is size-based rather than time-based');
  assert.match(serverSource, /SQLite \+ the diagnostics admin API are the authoritative log/,
    'the bounded SQLite store remains the authoritative server-side diagnostic log');
  assert.match(serverSource, /const voiceDiagIncidentGlobalLimiter = createVoiceDiagnosticGlobalLimiter\(\)/,
    'incident uploads have a process-wide aggregate pressure cap');
  assert.match(serverSource, /const voiceDiagControlGlobalLimiter = createVoiceDiagnosticGlobalLimiter\(\{ limit: 240 \}\)/,
    'successful control reports have an independent aggregate pressure cap');
  assert.match(serverSource, /control \? voiceDiagControlGlobalLimiter : voiceDiagIncidentGlobalLimiter\)\.consume\(\)/,
    'aggregate limiters receive neither an IP nor an account identifier');
  assert.match(serverSource, /sanitizeVoiceDiagnosticReport\(req\.body\)[\s\S]*findExisting\(req\.user\.id, report\.clientReportId\)[\s\S]*voiceDiagControlRateLimiter : voiceDiagIncidentRateLimiter/,
    'validation and durable retry lookup happen before separate control/incident admission');
  assert.match(serverSource, /rawBeforeCreated[\s\S]*rawBeforeId[\s\S]*beforeCreated:[\s\S]*beforeId:/,
    'the admin list validates and forwards both parts of its keyset cursor');
  assert.match(serverSource, /req\.query\.incident != null && typeof req\.query\.incident !== 'string'[\s\S]*req\.query\.client != null && typeof req\.query\.client !== 'string'/,
    'repeated filter parameters are rejected instead of silently broadening the admin query');
  const dockerSource = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerSource, /\bvoiceDiagnostics\.js\b/, 'production server image contains the diagnostics module');
});

test('sanitizer persists only fixed technical fields and canonical values', () => {
  const forbidden = 'secret-value-that-must-never-be-stored';
  const report = sanitizeVoiceDiagnosticReport(validReport({
    token: forbidden,
    password: forbidden,
    url: `https://example.invalid/${forbidden}`,
    chat: forbidden,
    client: {
      kind: 'web', platform: 'ios', installMode: 'standalone', networkType: '4g',
      appVersion: '001.02.3', deviceId: forbidden, label: forbidden, userAgent: forbidden,
    },
    events: [{
      atMs: 12.6, kind: 'rtc_sample', stage: 'rtc', outcome: 'ok', code: 'none',
      outputRoute: 'default', outputTarget: 'voice_mixer', outputOperation: 'set_sink',
      rttMs: 999_999, jitterMs: 2.3456, audioLevel: 0.12349, packetsSentDelta: 18,
      micEnabled: true, documentHidden: false, connectionState: 'connected',
      token: forbidden, sdp: forbidden, iceCandidate: forbidden, ip: forbidden,
      url: forbidden, deviceId: forbidden, deviceLabel: forbidden, message: forbidden,
      error: forbidden, stack: forbidden, peerName: forbidden, pcm: forbidden,
    }],
  }));

  assert.deepEqual(report.client, {
    kind: 'web', platform: 'ios', installMode: 'standalone', networkType: '4g', appVersion: '1.2.3',
  });
  assert.deepEqual(report.events, [{
    atMs: 13, kind: 'rtc_sample', stage: 'rtc', outcome: 'ok', code: 'none',
    outputRoute: 'default', outputTarget: 'voice_mixer', outputOperation: 'set_sink',
    connectionState: 'connected', documentHidden: false, micEnabled: true,
    rttMs: 120_000, jitterMs: 2, packetsSentDelta: 18, audioLevel: 0.123,
  }]);
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(forbidden), false);
  for (const key of ['token', 'password', 'url', 'chat', 'sdp', 'iceCandidate', 'ip', 'deviceId', 'deviceLabel', 'message', 'error', 'stack', 'peerName', 'pcm']) {
    assert.equal(Object.prototype.hasOwnProperty.call(report, key), false, `top-level ${key}`);
    assert.equal(Object.prototype.hasOwnProperty.call(report.events[0], key), false, `event ${key}`);
  }
});

test('microphone capture path is a fixed enum and survives the admin storage roundtrip', () => {
  const db = new Database(':memory:');
  const store = createVoiceDiagnosticsStore(db, { now: () => 20_000 });
  const saved = store.save({ userId: 'owner', username: 'owner', raw: validReport({
    incident: 'mic_failed',
    events: ['direct', 'webaudio', 'PRIVATE_DEVICE_PATH'].map((micCapturePath) => ({
      atMs: 0, kind: 'mic_capture_finished', stage: 'mic_capture', micCapturePath,
    })),
  }) });
  const detail = store.detail(saved.id);
  assert.deepEqual(detail.report.events.map((event) => event.micCapturePath), ['direct', 'webaudio', undefined]);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_DEVICE_PATH/);
  db.close();
});

test('authentication diagnostics retain bounded request metrics, never credentials or response content', () => {
  const secret = 'AUTH_SECRET_MUST_NOT_BE_STORED';
  const codes = ['auth', 'network', 'timeout', 'aborted', 'unknown', 'rate_limited', 'server', 'invalid_response'];
  const stages = ['auth_login', 'auth_session', 'auth_profile'];
  const events = codes.flatMap((code, index) => [
    { atMs: index * 250, kind: 'auth_request_started', stage: stages[index % 3], outcome: 'started' },
    {
      atMs: (index + 1) * 250, kind: 'auth_request_finished', stage: stages[index % 3],
      outcome: 'failed', code, httpStatus: index === 0 ? 401 : 0, requestElapsedMs: 250,
      username: secret, password: secret, token: secret, refreshToken: secret,
      url: secret, body: { password: secret }, headers: { Authorization: secret }, error: secret,
    },
  ]);
  const db = new Database(':memory:');
  const store = createVoiceDiagnosticsStore(db, { now: () => 20_000 });
  for (const incident of ['auth_failed', 'auth_recovered']) {
    const report = validReport({
      incident, durationMs: 2_000, events, userId: secret, username: secret,
      password: secret, body: secret, headers: secret, url: secret, token: secret,
    });
    const saved = store.save({ userId: 'authenticated-owner', username: 'owner', raw: report });
    const detail = store.detail(saved.id);
    assert.equal(detail.userId, 'authenticated-owner');
    assert.equal(detail.username, 'owner');
    assert.equal(detail.report.incident, incident);
    assert.equal(detail.report.durationMs, 2_000);
    assert.deepEqual(detail.report.events[1], {
      atMs: 250, kind: 'auth_request_finished', stage: 'auth_login', outcome: 'failed',
      code: 'auth', httpStatus: 401, requestElapsedMs: 250,
    });
    assert.equal(detail.report.events[3].httpStatus, 0);
    assert.deepEqual(detail.report.events.filter((event) => event.kind === 'auth_request_finished').map((event) => event.code), codes);
    assert.doesNotMatch(JSON.stringify(detail), /AUTH_SECRET_MUST_NOT_BE_STORED/);
    assert.equal(store.list({ incident }).items.length, 1);
  }
  const invalidStatuses = [-1, 600, 401.5, '401', NaN, Infinity];
  const elapsedInputs = [-1, 120_001, 1.6, '250', NaN, Infinity];
  const bounded = sanitizeVoiceDiagnosticReport(validReport({
    incident: 'auth_failed',
    events: invalidStatuses.map((httpStatus, index) => ({
      atMs: index, kind: 'auth_request_finished', stage: secret, code: secret,
      httpStatus, requestElapsedMs: elapsedInputs[index],
    })),
  }));
  assert.deepEqual(bounded.events.map((event) => event.requestElapsedMs), [0, 120_000, 2, undefined, undefined, undefined]);
  assert.equal(bounded.events.some((event) => 'httpStatus' in event || 'stage' in event || 'code' in event), false);
  db.close();
});

test('authentication recoveries use control admission and never evict failures at storage capacity', () => {
  assert.equal(isVoiceDiagnosticControlIncident('auth_recovered'), true);
  assert.equal(isVoiceDiagnosticControlIncident('auth_failed'), false);
  for (const limits of [{ maxRows: 10, maxRowsPerUser: 1 }, { maxRows: 1, maxRowsPerUser: 10 }]) {
    const db = new Database(':memory:');
    let now = 20_000;
    const store = createVoiceDiagnosticsStore(db, { now: () => now++, ...limits });
    const failed = store.save({ userId: 'owner', username: 'owner', raw: validReport({ incident: 'auth_failed' }) });
    const recovered = store.save({ userId: 'owner', username: 'owner', raw: validReport({ incident: 'auth_recovered' }) });
    assert.deepEqual(store.list().items.map((item) => item.id), [failed.id]);
    assert.equal(store.detail(recovered.id), null);
    db.close();
  }
});

test('output diagnostics preserve only privacy-safe source and operation categories', () => {
  const forbidden = 'raw-output-detail-that-must-not-be-stored';
  const report = sanitizeVoiceDiagnosticReport(validReport({
    incident: 'output_route_failed',
    events: [
      {
        atMs: 1, kind: 'output_route_failed', stage: 'output_route', outcome: 'failed',
        code: 'invalid_state', outputRoute: 'custom', outputTarget: 'media_element',
        outputOperation: 'set_sink', error: forbidden, deviceId: forbidden,
      },
      {
        atMs: 2, kind: 'output_route_failed', stage: 'output_route', outcome: 'failed',
        code: forbidden, outputTarget: forbidden, outputOperation: forbidden,
      },
      {
        atMs: 3, kind: 'media_activated', stage: 'activation', outcome: 'failed',
        code: 'session_closing', httpStatus: 409, error: forbidden,
      },
    ],
  }));
  assert.deepEqual(report.events[0], {
    atMs: 1, kind: 'output_route_failed', stage: 'output_route', outcome: 'failed',
    code: 'invalid_state', outputRoute: 'custom', outputTarget: 'media_element',
    outputOperation: 'set_sink',
  });
  assert.deepEqual(report.events[1], {
    atMs: 2, kind: 'output_route_failed', stage: 'output_route', outcome: 'failed',
  });
  assert.deepEqual(report.events[2], {
    atMs: 3, kind: 'media_activated', stage: 'activation', outcome: 'failed',
    code: 'session_closing', httpStatus: 409,
  });
  assert.equal(JSON.stringify(report).includes(forbidden), false);
});

test('sanitizer accepts bounded stream-watch stages while discarding identities and raw transport data', () => {
  const forbidden = 'stream-secret-that-must-not-be-stored';
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
  const events = stages.map((stage, index) => ({
    atMs: index * 10,
    kind: kinds[index % kinds.length],
    stage,
    outcome: index === stages.length - 1 ? 'recovered' : 'started',
    code: codes[index],
    streamTransport: transports[index % transports.length],
    ...(index === 7 ? { watchEndReason: 'auth_handoff' } : {}),
    streamId: forbidden,
    streamer: forbidden,
    url: forbidden,
    sdp: forbidden,
    iceCandidate: forbidden,
    error: forbidden,
  }));

  for (const incident of ['stream_watch_succeeded', 'stream_watch_failed', 'stream_watch_recovered']) {
    const report = sanitizeVoiceDiagnosticReport(validReport({
      incident,
      viewerUserId: forbidden,
      viewerUsername: forbidden,
      streamId: forbidden,
      events,
    }));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.incident, incident);
    assert.deepEqual(report.events.map((event) => event.stage), stages);
    assert.deepEqual(report.events.map((event) => event.code), codes);
    assert.deepEqual(report.events.map((event) => event.streamTransport),
      stages.map((_, index) => transports[index % transports.length]));
    assert.equal(report.events[7].watchEndReason, 'auth_handoff');
    assert.equal(JSON.stringify(report).includes(forbidden), false,
      'viewer identity comes from server auth and raw media/signaling values are discarded');
  }

  const unknownTransport = sanitizeVoiceDiagnosticReport(validReport({
    incident: 'stream_watch_failed',
    events: [{
      atMs: 20_000, kind: 'stream_watch_finished', stage: 'watch_playback',
      outcome: 'timed_out', code: 'decode_timeout', streamTransport: 'peer-id-from-client',
      watchEndReason: 'private-lifecycle-detail',
    }],
  }));
  assert.deepEqual(unknownTransport.events[0], {
    atMs: 20_000, kind: 'stream_watch_finished', stage: 'watch_playback',
    outcome: 'timed_out', code: 'decode_timeout',
  });

  const endReasons = [
    'user_close', 'view_switch', 'server_exit', 'auth_handoff', 'session_terminal',
    'logout', 'engine_dispose', 'connection_loss', 'stream_ended', 'quality_change',
    'recovery_failed', 'playback_timeout', 'superseded', 'unknown',
  ];
  const reasonReport = sanitizeVoiceDiagnosticReport(validReport({
    incident: 'stream_watch_failed',
    events: endReasons.map((watchEndReason, index) => ({
      atMs: index, kind: 'stream_watch_finished', stage: 'watch_playback',
      outcome: 'cancelled', code: 'aborted', watchEndReason,
    })),
  }));
  assert.deepEqual(reasonReport.events.map((event) => event.watchEndReason), endReasons,
    'only the fixed privacy-safe lifecycle taxonomy survives server validation');
});

test('store persists the sanitized watch end reason in admin detail', () => {
  const db = new Database(':memory:');
  const store = createVoiceDiagnosticsStore(db, {
    now: () => 10_000,
    randomId: () => '000000000000000000000001',
  });
  const saved = store.save({
    userId: 'viewer',
    username: 'viewer',
    raw: validReport({
      incident: 'stream_watch_failed',
      events: [{
        atMs: 120, kind: 'stream_watch_finished', stage: 'watch_playback',
        outcome: 'cancelled', code: 'aborted', watchEndReason: 'view_switch',
      }],
    }),
  });

  assert.equal(store.detail(saved.id).report.events[0].watchEndReason, 'view_switch');
  db.close();
});

test('sanitizer preserves a bounded multi-day call timeline', () => {
  const twoDays = 2 * 24 * 60 * 60_000;
  const report = sanitizeVoiceDiagnosticReport(validReport({
    durationMs: twoDays,
    events: [{ atMs: twoDays, kind: 'rtc_sample' }],
  }));
  assert.equal(report.durationMs, twoDays);
  assert.equal(report.events[0].atMs, twoDays);
});

test('sanitizer bounds event count and rejects reports without valid enum events', () => {
  const events = Array.from({ length: 140 }, (_, index) => ({ atMs: index, kind: 'rtc_sample' }));
  const bounded = sanitizeVoiceDiagnosticReport(validReport({ events }));
  assert.equal(bounded.events.length, 128);
  assert.equal(bounded.events[0].atMs, 12);
  assert.equal(bounded.truncated, true);

  assert.throws(
    () => sanitizeVoiceDiagnosticReport(validReport({ events: [{ atMs: 0, kind: 'raw_log', message: 'no' }] })),
    (error) => error instanceof VoiceDiagnosticValidationError && error.code === 'no_events',
  );
  assert.throws(
    () => sanitizeVoiceDiagnosticReport(validReport({ incident: 'arbitrary-incident' })),
    (error) => error instanceof VoiceDiagnosticValidationError && error.code === 'bad_incident',
  );
});

test('sanitizer accounts for the truncated marker inside the byte limit', () => {
  const raw = validReport({
    events: [
      { atMs: 0, kind: 'join_started', stage: 'intent' },
      { atMs: 1, kind: 'hub_connected', stage: 'hub' },
    ],
  });
  const withoutMarker = sanitizeVoiceDiagnosticReport(raw);
  const exactBoundary = Buffer.byteLength(JSON.stringify(withoutMarker), 'utf8');
  const bounded = sanitizeVoiceDiagnosticReport({ ...raw, truncated: true }, { maxPayloadBytes: exactBoundary });

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.events.length, 1, 'one more event is dropped when the marker crosses the byte boundary');
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= exactBoundary);
});

test('global diagnostic backpressure keeps aggregate counters only', () => {
  let clock = 1_000;
  const limiter = createVoiceDiagnosticGlobalLimiter({ limit: 2, windowMs: 100, now: () => clock });
  assert.equal(limiter.consume.length, 0, 'the aggregate limiter accepts no IP or account key');
  assert.deepEqual(limiter.consume(), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume(), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.consume(), { allowed: false, retryAfterMs: 100 });
  clock = 1_099;
  assert.deepEqual(limiter.consume(), { allowed: false, retryAfterMs: 1 });
  clock = 1_100;
  assert.deepEqual(limiter.consume(), { allowed: true, retryAfterMs: 0 });
});

test('user admission keeps burst and hourly limits across owners and bounded capacity', () => {
  let clock = 1_000;
  const limiter = createVoiceDiagnosticUserLimiter({ burstLimit: 2, hourlyLimit: 3, maxUsers: 2, now: () => clock });
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, true);
  assert.deepEqual(limiter.consume('a'), { allowed: false, retryAfterMs: 60_000 });
  assert.equal(limiter.consume('b').allowed, true, 'an incident from another account has an independent budget');
  assert.equal(limiter.consume('c').allowed, false, 'capacity cannot evict a spent budget to make it reusable');
  assert.equal(limiter.consume('a').allowed, false);
  clock += 60_000;
  assert.equal(limiter.consume('a').allowed, true);
  assert.deepEqual(limiter.consume('a'), { allowed: false, retryAfterMs: 59 * 60_000 });
  clock += 60 * 60_000;
  assert.equal(limiter.consume('c').allowed, true, 'expired owners no longer occupy the bounded admission table');
});

test('restoring diagnostics migrates existing reports without replacing their contents', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE voice_diagnostics(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL,
    incident TEXT NOT NULL, client_kind TEXT NOT NULL, platform TEXT NOT NULL,
    created INTEGER NOT NULL, event_count INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
  )`);
  const payload = JSON.stringify(validReport());
  db.prepare('INSERT INTO voice_diagnostics VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    '000000000000000000000001', 'old-user', 'old-user', 'join_stuck', 'web', 'ios', 1_000, 1, 12_345, 0, payload,
  );
  const store = createVoiceDiagnosticsStore(db, { now: () => 2_000 });
  assert.deepEqual(store.list().items.map((row) => row.id), ['000000000000000000000001']);
  assert.deepEqual(store.detail('000000000000000000000001').report, JSON.parse(payload));
  assert.equal(db.prepare('SELECT payload FROM voice_diagnostics').get().payload, payload);
  assert.equal(db.prepare('PRAGMA table_info(voice_diagnostics)').all().some((row) => row.name === 'client_report_id'), true);
  db.close();
});

test('normal completed sessions and successful joins use the lower-priority control lane', () => {
  assert.equal(isVoiceDiagnosticControlIncident('join_succeeded'), true);
  assert.equal(isVoiceDiagnosticControlIncident('session_ended'), true);
  assert.equal(isVoiceDiagnosticControlIncident('stream_watch_succeeded'), true);
  assert.equal(isVoiceDiagnosticControlIncident('stream_watch_failed'), false);
  assert.equal(isVoiceDiagnosticControlIncident('stream_watch_recovered'), false);
  assert.equal(isVoiceDiagnosticControlIncident('join_stuck'), false);
});

test('store enforces per-user/global caps, TTL, filters, detail and account purge', () => {
  const db = new Database(':memory:');
  let clock = 1_000;
  let sequence = 0;
  const store = createVoiceDiagnosticsStore(db, {
    now: () => clock,
    randomId: () => (++sequence).toString(16).padStart(24, '0'),
    retentionMs: 100,
    maxRows: 3,
    maxRowsPerUser: 2,
  });
  const save = (userId, incident = 'join_stuck', kind = 'web') => {
    const result = store.save({
      userId,
      username: `user-${userId}`,
      raw: validReport({
        clientReportId: (++sequence).toString(16).padStart(24, '0'),
        incident, client: { kind, platform: 'unknown', installMode: kind === 'native' ? 'native' : 'browser' },
      }),
    });
    clock += 1;
    return result;
  };

  save('a');
  save('a');
  const latestA = save('a');
  assert.deepEqual(Object.keys(latestA).sort(), ['client', 'createdAt', 'eventCount', 'id', 'incident', 'platform'],
    'the value available to server logging contains metadata only');
  assert.equal(store.list({ limit: 100 }).items.filter((row) => row.userId === 'a').length, 2);
  assert.equal(store.detail(latestA.id).report.incident, 'join_stuck');

  save('b', 'ui_stall', 'native');
  save('c', 'playback_blocked');
  const all = store.list({ limit: 100 }).items;
  assert.equal(all.length, 3);
  assert.equal(all.some((row) => row.id === latestA.id), true);
  assert.deepEqual(store.list({ limit: 100, incident: 'ui_stall' }).items.map((row) => row.userId), ['b']);
  assert.deepEqual(store.list({ limit: 100, client: 'native' }).items.map((row) => row.userId), ['b']);
  assert.deepEqual(store.list({ limit: 100, incident: 'not-allowlisted' }), { items: [], nextCursor: null });

  assert.equal(store.purgeUser('b'), 1);
  assert.equal(store.list({ limit: 100 }).items.some((row) => row.userId === 'b'), false);

  clock = 1_500;
  assert.deepEqual(store.list({ limit: 100 }), { items: [], nextCursor: null });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM voice_diagnostics').get().count, 0);
  db.close();
});

test('store makes a client retry idempotent per authenticated account', () => {
  const db = new Database(':memory:');
  let clock = 5_000;
  let sequence = 0;
  const store = createVoiceDiagnosticsStore(db, {
    now: () => clock++,
    randomId: () => (++sequence).toString(16).padStart(24, '0'),
  });
  const report = validReport({ clientReportId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const first = store.save({ userId: 'owner-a', username: 'a', raw: report });
  assert.deepEqual(store.findExisting('owner-a', report.clientReportId), first,
    'the route can acknowledge a durable retry before consuming another rate-limit slot');
  assert.equal(store.findExisting('owner-b', report.clientReportId), null,
    'a durable retry lookup never crosses authenticated accounts');
  const retry = store.save({ userId: 'owner-a', username: 'a', raw: report });
  const anotherAccount = store.save({ userId: 'owner-b', username: 'b', raw: report });

  assert.deepEqual(retry, first, 'a lost 201 response can be retried without adding a second row');
  assert.notEqual(anotherAccount.id, first.id, 'the idempotency scope never crosses accounts');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM voice_diagnostics').get().count, 2);
  db.close();
});

test('storage caps evict successful controls before incidents', () => {
  const db = new Database(':memory:');
  let clock = 20_000;
  let sequence = 0;
  const store = createVoiceDiagnosticsStore(db, {
    now: () => clock++,
    randomId: () => (++sequence).toString(16).padStart(24, '0'),
    retentionMs: 10_000,
    maxRows: 3,
    maxRowsPerUser: 2,
  });
  const save = (userId, incident) => store.save({
    userId,
    username: userId,
    raw: validReport({
      clientReportId: (++sequence).toString(16).padStart(24, '0'),
      incident,
    }),
  });

  const oldFailure = save('owner-a', 'stream_watch_failed');
  const oldSuccess = save('owner-a', 'stream_watch_succeeded');
  const newSuccess = save('owner-a', 'join_succeeded');
  const ownerRows = store.list({ limit: 20 }).items.filter((row) => row.userId === 'owner-a');
  assert.equal(ownerRows.some((row) => row.id === oldFailure.id), true,
    'an older failure survives newer successful controls for the same user');
  assert.equal(ownerRows.some((row) => row.id === oldSuccess.id), false);
  assert.equal(ownerRows.some((row) => row.id === newSuccess.id), true);

  const globalSuccess = save('owner-b', 'session_ended');
  const globalFailure = save('owner-c', 'stream_watch_failed');
  const globalRecovery = save('owner-d', 'stream_watch_recovered');
  const globalRows = store.list({ limit: 20 }).items;
  assert.equal(globalRows.some((row) => row.id === globalSuccess.id), false,
    'global overflow discards a control before any incident');
  assert.equal(globalRows.some((row) => row.id === oldFailure.id), true);
  assert.equal(globalRows.some((row) => row.id === globalFailure.id), true);
  assert.equal(globalRows.some((row) => row.id === globalRecovery.id), true);
  db.close();
});

test('a retry after retention never acknowledges an expired invisible row', () => {
  const db = new Database(':memory:');
  let clock = 5_000;
  let sequence = 0;
  const store = createVoiceDiagnosticsStore(db, {
    now: () => clock,
    randomId: () => (++sequence).toString(16).padStart(24, '0'),
    retentionMs: 100,
    maxRows: 20,
    maxRowsPerUser: 20,
  });
  const report = validReport({ clientReportId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const first = store.save({ userId: 'owner', username: 'owner', raw: report });

  clock = 5_101;
  const retried = store.save({ userId: 'owner', username: 'owner', raw: report });

  assert.notEqual(retried.id, first.id, 'the expired idempotency row is pruned before lookup');
  assert.equal(store.detail(first.id), null);
  assert.equal(store.detail(retried.id)?.id, retried.id,
    'a successful retry response always points to a report visible in the bounded read window');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM voice_diagnostics').get().count, 1);
  db.close();
});

test('compound cursor does not skip reports created in the same millisecond', () => {
  const db = new Database(':memory:');
  let sequence = 0;
  const store = createVoiceDiagnosticsStore(db, {
    now: () => 10_000,
    randomId: () => (++sequence).toString(16).padStart(24, '0'),
    retentionMs: 1_000,
    maxRows: 20,
    maxRowsPerUser: 20,
  });
  for (let index = 0; index < 5; index += 1) {
    store.save({ userId: 'same-time', username: 'same-time', raw: validReport() });
  }

  const received = [];
  let cursor = null;
  do {
    const page = store.list({
      limit: 2,
      ...(cursor ? { beforeCreated: cursor.createdAt, beforeId: cursor.id } : {}),
    });
    received.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(received, [5, 4, 3, 2, 1].map((id) => id.toString(16).padStart(24, '0')));
  assert.equal(new Set(received).size, 5);
  assert.deepEqual(store.list({ limit: 2, beforeCreated: 10_000 }), { items: [], nextCursor: null },
    'a partial cursor must not broaden the query');
  db.close();
});

test('read paths enforce the exact retention boundary', () => {
  const db = new Database(':memory:');
  let clock = 1_000;
  const store = createVoiceDiagnosticsStore(db, {
    now: () => clock,
    randomId: () => '000000000000000000000001',
    retentionMs: 100,
    maxRows: 20,
    maxRowsPerUser: 20,
  });
  const saved = store.save({ userId: 'ttl', username: 'ttl', raw: validReport() });

  clock = 1_100;
  assert.deepEqual(store.list({ limit: 10 }).items.map((item) => item.id), [saved.id],
    'a report exactly as old as the retention duration remains readable');
  assert.equal(store.detail(saved.id)?.id, saved.id);

  clock = 1_101;
  assert.deepEqual(store.list({ limit: 10 }), { items: [], nextCursor: null });
  assert.equal(store.detail(saved.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM voice_diagnostics').get().count, 0);
  db.close();
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  VoiceDiagnosticValidationError,
  VOICE_DIAGNOSTIC_RETENTION_MS,
  createVoiceDiagnosticGlobalLimiter,
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
    assert.equal(JSON.stringify(report).includes(forbidden), false,
      'viewer identity comes from server auth and raw media/signaling values are discarded');
  }

  const unknownTransport = sanitizeVoiceDiagnosticReport(validReport({
    incident: 'stream_watch_failed',
    events: [{
      atMs: 20_000, kind: 'stream_watch_finished', stage: 'watch_playback',
      outcome: 'timed_out', code: 'decode_timeout', streamTransport: 'peer-id-from-client',
    }],
  }));
  assert.deepEqual(unknownTransport.events[0], {
    atMs: 20_000, kind: 'stream_watch_finished', stage: 'watch_playback',
    outcome: 'timed_out', code: 'decode_timeout',
  });
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

test('only successful stream watches use the lower-priority control lane', () => {
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
  const newSuccess = save('owner-a', 'stream_watch_succeeded');
  const ownerRows = store.list({ limit: 20 }).items.filter((row) => row.userId === 'owner-a');
  assert.equal(ownerRows.some((row) => row.id === oldFailure.id), true,
    'an older failure survives newer successful controls for the same user');
  assert.equal(ownerRows.some((row) => row.id === oldSuccess.id), false);
  assert.equal(ownerRows.some((row) => row.id === newSuccess.id), true);

  const globalSuccess = save('owner-b', 'stream_watch_succeeded');
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

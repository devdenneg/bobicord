'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createPersistentSessionManager, installPersistentSessionSchema } = require('./authSessions');
const { createVoiceMediaRevocationStore, createVoiceMediaRevocationWorker } = require('./voiceMediaRevocations');
const {
  VoiceAuthRevokedError,
  createVoiceAuthSubjectCodec,
  createVoiceSessionId,
  voiceSessionAuthSubject,
  voiceSessionMatchesSubject,
  releaseExactVoiceLease,
  createVoiceAuthTargetRegistry,
} = require('./voiceAuthRegistry');

function fixture(options = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users(
      id TEXT PRIMARY KEY,username TEXT NOT NULL,session_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memberships(user_id TEXT NOT NULL,server_id TEXT NOT NULL);
    CREATE TABLE voice_channels(id TEXT PRIMARY KEY,server_id TEXT NOT NULL);
    CREATE TABLE voice_leases(
      user_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL DEFAULT '',server_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',claimed_at INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE auth_sessions(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,revoked_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE auth_legacy_token_revocations(
      token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,
      revoked_at INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT ''
    );
  `);
  const revocations = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
  const targets = createVoiceAuthTargetRegistry(db, revocations, options);
  const codec = createVoiceAuthSubjectCodec('registry-test-secret-that-is-long-enough');
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run('u1', 'alice');
  return { db, revocations, targets, codec };
}

function target(subject, authKey, room, identity, overrides = {}) {
  return {
    authSubject: subject,
    authKind: 'persistent',
    authKey,
    userId: 'u1',
    room,
    identity,
    issued: 1_000,
    tokenExpires: 601_000,
    ...overrides,
  };
}

test('voice session identity contains only an opaque exact-session HMAC subject', () => {
  const codec = createVoiceAuthSubjectCodec('codec-test-secret-that-is-long-enough');
  const first = codec.persistent('u1', 'persistent-session-A');
  const second = codec.persistent('u1', 'persistent-session-B');
  const legacy = codec.legacy('u1', 'f'.repeat(64));
  assert.notEqual(first, second);
  assert.notEqual(first, legacy);
  assert.doesNotMatch(first, /persistent|session|u1|ffff/u);

  const sessionId = createVoiceSessionId(7, first, () => Buffer.alloc(8, 3));
  assert.equal(voiceSessionAuthSubject(sessionId), first);
  assert.equal(voiceSessionMatchesSubject(sessionId, first), true);
  assert.equal(voiceSessionMatchesSubject(sessionId, second), false);
  assert.doesNotMatch(sessionId, /persistent-session-A/u);
});

test('persistent logout transaction enqueues only that device exact hub/media identities', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO auth_sessions(id,user_id) VALUES(?,?)').run('session-A', 'u1');
  f.db.prepare('INSERT INTO auth_sessions(id,user_id) VALUES(?,?)').run('session-B', 'u1');
  const a = f.codec.persistent('u1', 'session-A');
  const b = f.codec.persistent('u1', 'session-B');
  const identityA = `alice#${createVoiceSessionId(2, a, () => Buffer.alloc(8, 1))}`;
  const identityB = `alice#${createVoiceSessionId(2, b, () => Buffer.alloc(8, 2))}`;
  f.targets.register(target(a, 'session-A', 'srv:s1', identityA), () => true);
  f.targets.register(target(a, 'session-A', 'voice:s1:c1', `${identityA}~4`), () => true);
  f.targets.register(target(b, 'session-B', 'srv:s1', identityB), () => true);
  f.targets.register(target(b, 'session-B', 'voice:s1:c1', `${identityB}~5`), () => true);

  f.db.exec('BEGIN IMMEDIATE');
  f.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(2_000, 'session-A');
  assert.ok(f.revocations.get('srv:s1', identityA));
  assert.ok(f.revocations.get('voice:s1:c1', `${identityA}~4`));
  assert.equal(f.revocations.get('srv:s1', identityB), null);
  assert.equal(f.targets.list(b).length, 2);
  f.db.exec('ROLLBACK');

  assert.equal(f.revocations.get('srv:s1', identityA), null);
  assert.equal(f.targets.list(a).length, 2, 'registry deletion must rollback with auth revocation');
  f.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(2_000, 'session-A');
  const exact = f.revocations.get('srv:s1', identityA);
  assert.equal(exact.revokeTokenTs, 3);
  assert.equal(exact.retryUntil, 601_000);
  assert.equal(f.targets.list(a).length, 0);
  assert.equal(f.targets.list(b).length, 2, 'another device remains registered and untouched');
  f.db.close();
});

test('account-wide session-version revoke durably fences even pre-connect tokens for every device', async () => {
  const f = fixture();
  f.db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run('u2', 'bob');
  const sessionA = f.codec.persistent('u1', 'session-A');
  const sessionB = f.codec.persistent('u1', 'session-B');
  const otherAccount = f.codec.persistent('u2', 'session-C');
  const issued = Date.now();
  const expiresA = issued + 10 * 60_000;
  const expiresB = issued + 2 * 60_000;
  f.targets.register(target(sessionA, 'session-A', 'srv:s1', 'alice#pre-connect', {
    issued, tokenExpires: expiresA,
  }), () => true);
  f.targets.register(target(sessionB, 'session-B', 'voice:s1:c1', 'alice#device-b~2', {
    issued, tokenExpires: expiresB,
  }), () => true);
  f.targets.register(target(otherAccount, 'session-C', 'srv:s1', 'bob#still-current', {
    userId: 'u2', issued, tokenExpires: expiresA,
  }), () => true);

  f.db.exec('BEGIN IMMEDIATE');
  f.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run('u1');
  assert.ok(f.revocations.get('srv:s1', 'alice#pre-connect'));
  assert.equal(f.targets.list(sessionA).length, 0);
  assert.equal(f.targets.list(sessionB).length, 0);
  assert.equal(f.targets.list(otherAccount).length, 1, 'another account must remain untouched');
  f.db.exec('ROLLBACK');
  assert.equal(f.revocations.get('srv:s1', 'alice#pre-connect'), null);
  assert.equal(f.targets.list(sessionA).length, 1, 'outbox and registry changes roll back together');

  const lowerCutoff = Math.floor(Date.now() / 1000) + 1;
  f.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run('u1');
  const upperCutoff = Math.floor(Date.now() / 1000) + 1;
  const preConnect = f.revocations.get('srv:s1', 'alice#pre-connect');
  const deviceB = f.revocations.get('voice:s1:c1', 'alice#device-b~2');
  assert.ok(preConnect.revokeTokenTs >= lowerCutoff && preConnect.revokeTokenTs <= upperCutoff);
  assert.equal(deviceB.revokeTokenTs, preConnect.revokeTokenTs, 'one account mutation has one fixed cutoff');
  assert.equal(preConnect.retryUntil, expiresA);
  assert.equal(deviceB.retryUntil, expiresB);
  assert.equal(f.targets.list(sessionA).length, 0);
  assert.equal(f.targets.list(sessionB).length, 0);
  assert.equal(f.targets.list(otherAccount).length, 1);

  let clock = issued;
  const missing = Object.assign(new Error('participant not found'), { statusCode: 404 });
  const worker = createVoiceMediaRevocationWorker({
    store: f.revocations,
    removeParticipant: async () => { throw missing; },
    deleteRoom: async () => {},
    isMissing: (error) => error === missing,
    now: () => clock,
  });
  await worker.run(preConnect);
  assert.ok(f.revocations.get('srv:s1', 'alice#pre-connect'),
    'a token revoked before first connection stays fenced until its immutable expiry');
  clock = expiresA + 1;
  await worker.run(f.revocations.get('srv:s1', 'alice#pre-connect'));
  assert.equal(f.revocations.get('srv:s1', 'alice#pre-connect'), null,
    'the missing target is removed only after the token can no longer connect');
  f.db.close();
});

test('exact lease release cannot clear another device ownership', () => {
  const codec = createVoiceAuthSubjectCodec('lease-test-secret-that-is-long-enough');
  const subjectA = codec.persistent('u1', 'session-A');
  const subjectB = codec.persistent('u1', 'session-B');
  const sessionB = createVoiceSessionId(1, subjectB, () => Buffer.alloc(8, 4));
  let lease = { sessionId: sessionB, serverId: 's1', channelId: 'c1', epoch: 9 };
  const calls = [];
  const store = {
    read: () => ({ lease, currentEpoch: 9 }),
    release: (userId, sessionId, epoch) => {
      calls.push({ userId, sessionId, epoch });
      lease = null;
      return { lease: null, currentEpoch: 9, released: true };
    },
  };

  assert.equal(releaseExactVoiceLease(store, 'u1', subjectA), null);
  assert.deepEqual(calls, []);
  const released = releaseExactVoiceLease(store, 'u1', subjectB);
  assert.equal(released.previousLease.sessionId, sessionB);
  assert.equal(calls.length, 1);
});

test('persistent session manager logout activates the registry trigger with its authentic refresh', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users(
      id TEXT PRIMARY KEY,username TEXT NOT NULL,session_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memberships(user_id TEXT NOT NULL,server_id TEXT NOT NULL);
    CREATE TABLE voice_channels(id TEXT PRIMARY KEY,server_id TEXT NOT NULL);
    CREATE TABLE voice_leases(
      user_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL DEFAULT '',server_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',claimed_at INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0
    );
  `);
  installPersistentSessionSchema(db);
  const revocations = createVoiceMediaRevocationStore(db);
  const registry = createVoiceAuthTargetRegistry(db, revocations);
  const secret = 'manager-test-secret-that-is-at-least-32-bytes';
  const manager = createPersistentSessionManager({ db, sessionSecret: secret, now: () => 10_000 });
  db.prepare('INSERT INTO users(id,username,session_version) VALUES(?,?,0)').run('u1', 'alice');
  const session = manager.create('u1', { clientKind: 'native' });
  const subject = createVoiceAuthSubjectCodec(secret).persistent('u1', session.sessionId);
  registry.register(target(subject, session.sessionId, 'srv:s1', 'alice#exact'), () => true);

  assert.equal(manager.logoutRefresh(session.refreshToken, { clientKind: 'native' }), true);
  assert.ok(revocations.get('srv:s1', 'alice#exact'));
  assert.equal(registry.list(subject).length, 0);
  assert.equal(manager.logoutRefresh(session.refreshToken, { clientKind: 'native' }), false,
    'idempotent retry cannot recreate or delete another target');
  db.close();
});

test('legacy logout moves only that exact bearer targets into the durable outbox', () => {
  const f = fixture();
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const a = f.codec.legacy('u1', hashA);
  const b = f.codec.legacy('u1', hashB);
  f.targets.register(target(a, hashA, 'srv:s1', 'alice#legacy-a', { authKind: 'legacy' }), () => true);
  f.targets.register(target(b, hashB, 'srv:s1', 'alice#legacy-b', { authKind: 'legacy' }), () => true);

  f.db.prepare(`INSERT INTO auth_legacy_token_revocations(token_hash,user_id,revoked_at,reason)
    VALUES(?,?,?,?)`).run(hashA, 'u1', 5_000, 'logout');
  assert.ok(f.revocations.get('srv:s1', 'alice#legacy-a'));
  assert.equal(f.revocations.get('srv:s1', 'alice#legacy-b'), null);
  assert.equal(f.targets.list(a).length, 0);
  assert.equal(f.targets.list(b).length, 1);
  f.db.close();
});

test('registration is fail-closed after logout and bounds old targets through the same outbox', () => {
  const f = fixture({ maxTargetsPerSubject: 2, maxTargetsGlobal: 2 });
  f.db.prepare('INSERT INTO auth_sessions(id,user_id) VALUES(?,?)').run('session-A', 'u1');
  const subject = f.codec.persistent('u1', 'session-A');
  f.targets.register(target(subject, 'session-A', 'srv:s1', 'alice#one', { issued: 1 }), () => true);
  f.targets.register(target(subject, 'session-A', 'srv:s2', 'alice#two', { issued: 2 }), () => true);
  const result = f.targets.register(
    target(subject, 'session-A', 'srv:s3', 'alice#three', { issued: 3 }),
    () => true,
  );
  assert.equal(result.evicted, 1);
  assert.ok(f.revocations.get('srv:s1', 'alice#one'), 'oldest overflow is revoked, never silently forgotten');
  assert.equal(f.targets.list(subject).length, 2);

  f.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(4_000, 'session-A');
  assert.throws(() => f.targets.register(
    target(subject, 'session-A', 'srv:s4', 'alice#late', { issued: 5_000 }),
    () => false,
  ), VoiceAuthRevokedError);
  assert.equal(f.targets.list(subject).length, 0);
  assert.equal(f.revocations.get('srv:s4', 'alice#late'), null);
  f.db.close();
});

test('logout routes commit exact voice outbox work before scheduling non-blocking LiveKit retry', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const helperStart = source.indexOf('function finishExactVoiceLogout');
  const helperEnd = source.indexOf('\n}', helperStart);
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /setImmediate\(\(\) => \{[\s\S]*?retryDueForVoiceSession\([\s\S]*?1000,[\s\S]*?\);/u);
  assert.doesNotMatch(helper, /await|withTimeout/u);

  for (const pathName of [
    "app.post('/api/auth/session/logout'",
    "app.post('/api/auth/session/logout-recover'",
    "app.post('/api/auth/session/logout-legacy'",
  ]) {
    const start = source.indexOf(pathName);
    const end = source.indexOf('\n}));', start);
    const route = source.slice(start, end + 5);
    assert.ok(route.indexOf('releaseVoiceLeaseFor') < route.indexOf('finishExactVoiceLogout'),
      `${pathName} must release/enqueue before scheduling external work`);
    assert.doesNotMatch(route, /await\s+(?:voiceMediaRevocationWorker|scheduleVoice)/u);
  }

  assert.match(source, /function closePersistentLogoutRealtime[\s\S]*?closePersistentRealtimeSession\(logoutSubject\.sessionId\);[\s\S]*?closeLegacyRealtimeSession\(logoutSubject\.legacyTokenHash\);/u,
    'an upgraded exact logout must close both persistent and legacy realtime transports');
  const legacyLogout = source.slice(
    source.indexOf("app.post('/api/auth/session/logout-legacy'"),
    source.indexOf("app.post('/api/register'"),
  );
  assert.match(legacyLogout, /WHERE legacy_token_hash=\? AND user_id=\?/u);
  assert.match(legacyLogout, /clearSessionPushEndpoints\(db, req\.user\.id, upgradedSessionId\)/u);
  assert.match(legacyLogout, /closePersistentRealtimeSession\(upgradedSessionId\)/u,
    'legacy logout of an upgraded exact device must close its persistent realtime transport');

  const hubTokenRoute = source.slice(
    source.indexOf("app.get('/api/servers/:id/token'"),
    source.indexOf('/* ---------------- ACCOUNT-WIDE SETTINGS', source.indexOf("app.get('/api/servers/:id/token'")),
  );
  assert.ok(hubTokenRoute.indexOf('registerVoiceAuthTarget(') < hubTokenRoute.indexOf('res.json('),
    'hub target must be durable before its token response can be observed');
  const mediaTokenRoute = source.slice(
    source.indexOf("app.post('/api/voice/media-token'"),
    source.indexOf("app.post('/api/voice/media/activate'"),
  );
  assert.ok(mediaTokenRoute.indexOf('registerVoiceAuthTarget(') < mediaTokenRoute.indexOf('return res.json('),
    'media target must be durable before its token response can be observed');
});

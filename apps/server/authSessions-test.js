'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const {
  PersistentSessionError,
  WEB_CSRF_COOKIE,
  WEB_REFRESH_COOKIE,
  clearWebSessionCookieHeaders,
  createPersistentSessionManager,
  installPersistentSessionSchema,
  parseCookieHeader,
  parseExactHttpOrigins,
  persistentSessionRateSubject,
  transportRequest,
  webSessionCookieHeaders,
} = require('./authSessions');

const SECRET = 'persistent-session-test-secret-at-least-32-bytes';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare("INSERT INTO users(id,username,session_version) VALUES('u_alice','alice',0)").run();
  let timestamp = Date.parse('2026-08-30T12:00:00.000Z');
  const manager = createPersistentSessionManager({
    db,
    sessionSecret: SECRET,
    now: () => timestamp,
    accessTtlSeconds: 900,
  });
  return {
    db,
    manager,
    user() { return db.prepare("SELECT * FROM users WHERE id='u_alice'").get(); },
    advance(ms) { timestamp += ms; },
    close() { db.close(); },
  };
}

function errorCode(code) {
  return (error) => error instanceof PersistentSessionError && error.code === code;
}

function cookieHeader(bundle) {
  return webSessionCookieHeaders(bundle.refreshToken, bundle.csrfToken)
    .map((value) => value.split(';', 1)[0]).join('; ');
}

test('schema is idempotent and stores only hashes of refresh and CSRF credentials', (t) => {
  const f = fixture();
  t.after(() => f.close());
  installPersistentSessionSchema(f.db);
  const bundle = f.manager.create(f.user(), { clientKind: 'web', deviceName: 'Browser' });
  assert.match(bundle.refreshToken, /^rr1\.[A-Za-z0-9_-]{32}\.0\.[A-Za-z0-9_-]{43}$/u);
  assert.match(bundle.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
  const row = f.db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(bundle.sessionId);
  assert.equal(row.refresh_hash.length, 64);
  assert.equal(row.csrf_hash.length, 64);
  assert.equal(JSON.stringify(row).includes(bundle.refreshToken), false);
  assert.equal(JSON.stringify(row).includes(bundle.csrfToken), false);
  const payload = jwt.verify(bundle.accessToken, SECRET, { algorithms: ['HS256'] });
  assert.equal(payload.typ, 'session');
  assert.equal(payload.sid, bundle.sessionId);
  assert.equal(payload.sv, 0);
  assert.ok(payload.exp - payload.iat <= 900);
  assert.equal(f.manager.verifyAccessPayload(payload, f.user()), true);
});

test('rotation repairs bounded delayed cookie writes without accepting arbitrarily old generations', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const initial = f.manager.create(f.user(), { clientKind: 'web' });
  const first = f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: initial.csrfToken,
  });
  assert.notEqual(first.refreshToken, initial.refreshToken);
  const recovered = f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: initial.csrfToken,
  });
  assert.equal(recovered.refreshToken, first.refreshToken);
  assert.equal(recovered.recovered, true);

  const second = f.manager.refresh(first.refreshToken, {
    clientKind: 'web', csrfToken: first.csrfToken,
  });
  assert.notEqual(second.refreshToken, first.refreshToken);
  const delayed = f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: initial.csrfToken,
  });
  assert.equal(delayed.refreshToken, second.refreshToken,
    'a delayed response from another tab must be repaired to the current cookie generation');

  let current = second;
  for (let generation = 3; generation <= 9; generation += 1) {
    current = f.manager.refresh(current.refreshToken, {
      clientKind: 'web', csrfToken: current.csrfToken,
    });
  }
  assert.throws(() => f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: initial.csrfToken,
  }), errorCode('REFRESH_STALE'));
  // An out-of-window stale/forged tab cannot destroy the current credential.
  assert.doesNotThrow(() => f.manager.refresh(current.refreshToken, {
    clientKind: 'web', csrfToken: current.csrfToken,
  }));
});

test('refresh sessions have no idle or absolute server expiry and global session_version still revokes them', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const initial = f.manager.create(f.user(), { clientKind: 'native' });
  f.advance(25 * 365 * 24 * 60 * 60 * 1000);
  const refreshed = f.manager.refresh(initial.refreshToken, { clientKind: 'native' });
  assert.match(refreshed.refreshToken, /^rr1\./u);

  f.db.prepare("UPDATE users SET session_version=session_version+1 WHERE id='u_alice'").run();
  assert.throws(() => f.manager.refresh(refreshed.refreshToken, { clientKind: 'native' }), errorCode('SESSION_REVOKED'));
  const payload = jwt.verify(refreshed.accessToken, SECRET, { algorithms: ['HS256'], ignoreExpiration: true });
  assert.equal(f.manager.verifyAccessPayload(payload, f.user()), false);
});

test('a security change preserves and rotates only the current device session', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const current = f.manager.create(f.user(), { clientKind: 'web' });
  const other = f.manager.create(f.user(), { clientKind: 'native' });
  f.db.prepare("UPDATE users SET session_version=1 WHERE id='u_alice'").run();
  const preserved = f.manager.preserveAfterSecurityChange(current.sessionId, f.user(), 'password-change', 'web');
  assert.ok(preserved);
  assert.notEqual(preserved.refreshToken, current.refreshToken);
  const recovered = f.manager.refresh(current.refreshToken, {
    clientKind: 'web', csrfToken: current.csrfToken,
  });
  assert.equal(recovered.refreshToken, preserved.refreshToken);
  assert.throws(() => f.manager.refresh(other.refreshToken, { clientKind: 'native' }), errorCode('SESSION_REVOKED'));
  const access = jwt.verify(preserved.accessToken, SECRET, { algorithms: ['HS256'] });
  assert.equal(access.sv, 1);
  assert.equal(f.manager.verifyAccessPayload(access, f.user()), true);
});

test('legacy upgrade is idempotent and explicit logout cannot resurrect it', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const legacyToken = jwt.sign({ id: 'u_alice', sub: 'u_alice', sv: 0, typ: 'session' }, SECRET, {
    algorithm: 'HS256', expiresIn: '30d',
  });
  const upgraded = f.manager.create(f.user(), { clientKind: 'native', legacyToken });
  const retry = f.manager.create(f.user(), { clientKind: 'native', legacyToken });
  assert.equal(retry.sessionId, upgraded.sessionId);
  assert.equal(retry.refreshToken, upgraded.refreshToken);
  assert.equal(retry.recovered, true);
  assert.equal(f.manager.verifyLegacyToken(legacyToken, f.user()), true);
  assert.equal(
    f.manager.logoutRefreshSubject(upgraded.refreshToken, { clientKind: 'native' }).legacyTokenHash,
    f.manager.legacyTokenKey(legacyToken),
    'an upgraded logout retains only the exact legacy hash needed to close its old realtime sockets',
  );
  assert.equal(f.manager.logoutRefresh(upgraded.refreshToken, { clientKind: 'native' }), true);
  assert.equal(f.manager.verifyLegacyToken(legacyToken, f.user()), false);
  assert.throws(() => f.manager.create(f.user(), { clientKind: 'native', legacyToken }), errorCode('SESSION_REVOKED'));
});

test('an explicit legacy logout creates a hash-only tombstone without changing other devices', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const first = jwt.sign({ id: 'u_alice', sub: 'u_alice', sv: 0, typ: 'session', device: 1 }, SECRET, {
    algorithm: 'HS256', expiresIn: '30d',
  });
  const second = jwt.sign({ id: 'u_alice', sub: 'u_alice', sv: 0, typ: 'session', device: 2 }, SECRET, {
    algorithm: 'HS256', expiresIn: '30d',
  });
  f.manager.logoutLegacy(first, f.user());
  assert.equal(f.manager.verifyLegacyToken(first, f.user()), false);
  assert.equal(f.manager.verifyLegacyToken(second, f.user()), true);
  const row = f.db.prepare('SELECT * FROM auth_legacy_token_revocations').get();
  assert.equal(JSON.stringify(row).includes(first), false);
});

test('logout accepts an authentic older generation, revokes access immediately and remains idempotent', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const initial = f.manager.create(f.user(), { clientKind: 'web' });
  const first = f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: initial.csrfToken,
  });
  const second = f.manager.refresh(first.refreshToken, {
    clientKind: 'web', csrfToken: first.csrfToken,
  });
  assert.equal(f.manager.logoutRefresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: initial.csrfToken,
  }), true);
  const payload = jwt.verify(second.accessToken, SECRET, { algorithms: ['HS256'] });
  assert.equal(f.manager.verifyAccessPayload(payload, f.user()), false);
  assert.equal(f.manager.logoutRefresh(second.refreshToken, {
    clientKind: 'web', csrfToken: second.csrfToken,
  }), false);
  assert.deepEqual(f.manager.logoutRefreshSubject(second.refreshToken, {
    clientKind: 'web', csrfToken: second.csrfToken,
  }), {
    userId: 'u_alice', sessionId: second.sessionId, legacyTokenHash: '', revoked: true,
  },
  'a response-lost retry can still atomically acknowledge account-scoped push cleanup');
  const forged = second.refreshToken.slice(0, -1) + (second.refreshToken.endsWith('A') ? 'B' : 'A');
  assert.equal(f.manager.logoutRefreshSubject(forged, {
    clientKind: 'web', csrfToken: second.csrfToken,
  }), null, 'a forged token cannot use a revoked session id to clean another account endpoint');
});

test('web logout recovery bypasses only desynchronised CSRF and still requires an authentic refresh', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const bundle = f.manager.create(f.user(), { clientKind: 'web' });
  assert.throws(() => f.manager.logoutRefresh(bundle.refreshToken, {
    clientKind: 'web', csrfToken: 'wrong-csrf-token',
  }), errorCode('AUTH_CSRF_INVALID'));
  assert.equal(f.manager.logoutRefresh(bundle.refreshToken, {
    clientKind: 'web', allowCsrfRecovery: true, reason: 'logout-csrf-recovery',
  }), true);
  const payload = jwt.verify(bundle.accessToken, SECRET, { algorithms: ['HS256'] });
  assert.equal(f.manager.verifyAccessPayload(payload, f.user()), false);

  const second = f.manager.create(f.user(), { clientKind: 'web' });
  const forged = second.refreshToken.slice(0, -1) + (second.refreshToken.endsWith('A') ? 'B' : 'A');
  assert.equal(f.manager.logoutRefresh(forged, {
    clientKind: 'web', allowCsrfRecovery: true,
  }), false, 'recovery must not revoke a session without its HMAC-bound refresh proof');
  assert.doesNotThrow(() => f.manager.refresh(second.refreshToken, {
    clientKind: 'web', csrfToken: second.csrfToken,
  }));
});

test('web resume recovery repairs only an authentic current or previous refresh generation', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const initial = f.manager.create(f.user(), { clientKind: 'web' });
  assert.throws(() => f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', csrfToken: 'missing-readable-cookie',
  }), errorCode('AUTH_CSRF_INVALID'));
  const recovered = f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', allowCsrfRecovery: true,
  });
  assert.equal(recovered.sessionId, initial.sessionId);
  assert.notEqual(recovered.refreshToken, initial.refreshToken);
  assert.match(recovered.csrfToken, /^[A-Za-z0-9_-]{43}$/u);

  const previousRecovery = f.manager.refresh(initial.refreshToken, {
    clientKind: 'web', allowCsrfRecovery: true,
  });
  assert.equal(previousRecovery.refreshToken, recovered.refreshToken);
  const forged = recovered.refreshToken.slice(0, -1) + (recovered.refreshToken.endsWith('A') ? 'B' : 'A');
  assert.throws(() => f.manager.refresh(forged, {
    clientKind: 'web', allowCsrfRecovery: true,
  }), errorCode('REFRESH_STALE'));
});

test('persistent browser origin config accepts only explicit HTTP(S) origins', () => {
  assert.deepEqual([...parseExactHttpOrigins('https://chat.example, http://localhost:5173/')], [
    'https://chat.example', 'http://localhost:5173',
  ]);
  for (const invalid of [
    'https://*.example.com',
    'https://chat.example/path',
    'https://chat.example?tenant=one',
    'tauri://localhost',
    'not-an-origin',
  ]) {
    assert.throws(() => parseExactHttpOrigins(invalid), /PERSISTENT_WEB_ORIGINS/u);
  }
});

test('cookie transport is exact-origin and double-submit CSRF protected; native bearer stays separate', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const bundle = f.manager.create(f.user(), { clientKind: 'web' });
  const webOrigins = parseExactHttpOrigins('https://reelay.online,https://chat.example');
  const nativeOrigins = new Set(['tauri://localhost']);
  const request = {
    headers: {
      origin: 'https://reelay.online',
      cookie: cookieHeader(bundle),
      'x-relay-auth-protocol': 'persistent-v1',
      'x-relay-auth-transport': 'cookie-v1',
      'x-relay-csrf': bundle.csrfToken,
    },
  };
  assert.deepEqual(transportRequest(request, { webOrigins, nativeOrigins }), {
    kind: 'web', refreshToken: bundle.refreshToken, csrfToken: bundle.csrfToken,
  });
  assert.deepEqual(transportRequest({ headers: { ...request.headers, origin: 'https://chat.example' } }, {
    webOrigins, nativeOrigins,
  }), {
    kind: 'web', refreshToken: bundle.refreshToken, csrfToken: bundle.csrfToken,
  });
  assert.throws(() => transportRequest({ headers: { ...request.headers, origin: 'https://evil.example' } }, {
    webOrigins, nativeOrigins,
  }), errorCode('AUTH_ORIGIN_FORBIDDEN'));
  assert.throws(() => transportRequest({ headers: { ...request.headers, 'x-relay-csrf': '1' } }, {
    webOrigins, nativeOrigins,
  }), errorCode('AUTH_CSRF_INVALID'));
  assert.deepEqual(transportRequest({ headers: {
    'x-relay-auth-protocol': 'persistent-v1',
    'x-relay-auth-transport': 'bearer-v1',
    authorization: `Refresh ${bundle.refreshToken}`,
  } }, { webOrigins, nativeOrigins }), {
    kind: 'native', refreshToken: bundle.refreshToken, csrfToken: '',
  });
  assert.throws(() => transportRequest({ headers: {
    origin: 'https://reelay.online',
    'x-relay-auth-protocol': 'persistent-v1',
    'x-relay-auth-transport': 'bearer-v1',
    authorization: `Refresh ${bundle.refreshToken}`,
  } }, { webOrigins, nativeOrigins }), errorCode('AUTH_ORIGIN_FORBIDDEN'));
});

test('web cookies are host-only secure strict cookies and clear with the same scope', () => {
  const set = webSessionCookieHeaders('refresh-token', 'csrf-token');
  assert.equal(set.length, 2);
  assert.match(set[0], new RegExp(`^${WEB_REFRESH_COOKIE}=`));
  assert.match(set[0], /; Path=\/;/u);
  assert.match(set[0], /; Secure;/u);
  assert.match(set[0], /; HttpOnly;/u);
  assert.match(set[0], /; SameSite=Strict;/u);
  assert.doesNotMatch(set[0], /Domain=/iu);
  assert.match(set[1], new RegExp(`^${WEB_CSRF_COOKIE}=`));
  assert.doesNotMatch(set[1], /HttpOnly/iu);
  assert.equal(clearWebSessionCookieHeaders().every((value) => /Max-Age=0/u.test(value)), true);
  const parsed = parseCookieHeader(`${WEB_REFRESH_COOKIE}=abc; ${WEB_CSRF_COOKIE}=def`);
  assert.equal(parsed[WEB_REFRESH_COOKIE], 'abc');
  assert.equal(parsed[WEB_CSRF_COOKIE], 'def');
});

test('persistent session rate limits survive retries and reopen after their bounded window', (t) => {
  const f = fixture();
  t.after(() => f.close());
  assert.doesNotThrow(() => f.manager.checkRate('refresh-session', 'session-1', {
    limit: 2, windowMs: 1000,
  }));
  assert.doesNotThrow(() => f.manager.checkRate('refresh-session', 'session-1', {
    limit: 2, windowMs: 1000,
  }));
  assert.throws(() => f.manager.checkRate('refresh-session', 'session-1', {
    limit: 2, windowMs: 1000,
  }), errorCode('AUTH_RATE_LIMITED'));
  // A different session cannot consume this session's budget.
  assert.doesNotThrow(() => f.manager.checkRate('refresh-session', 'session-2', {
    limit: 2, windowMs: 1000,
  }));
  f.advance(1001);
  assert.doesNotThrow(() => f.manager.checkRate('refresh-session', 'session-1', {
    limit: 2, windowMs: 1000,
  }));
});

test('anonymous recover probes never share a global empty per-session rate bucket', () => {
  for (let index = 0; index < 25; index += 1) {
    assert.equal(persistentSessionRateSubject(''), null);
    assert.equal(persistentSessionRateSubject(`malformed-cookie-${index}`), null);
  }
  assert.equal(persistentSessionRateSubject('legacy.jwt.opaque', { allowOpaque: true }), 'legacy.jwt.opaque');
});

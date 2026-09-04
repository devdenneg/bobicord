'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AuthError, createAuthManager, formatPasswordHash, passwordPrehash } = require('./auth');
const { createNativeAuthCompatibility, nativeAuthRequested, requireNativeAuthTransport, nativeRefreshCredential } = require('./nativeAuthCompat');

const secret = 'test-only-native-auth-compat-secret';
const password = 'Test login phrase 2026!';
const nativeHeaders = { 'x-relay-auth-protocol': 'persistent-v1', 'x-relay-auth-transport': 'bearer-v1', origin: 'tauri://localhost' };
const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const code = (expected) => (error) => error instanceof AuthError && error.code === expected;

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,
    passhash TEXT NOT NULL,avatar_color INTEGER NOT NULL DEFAULT 0,avatar_url TEXT NOT NULL DEFAULT '',
    profile_banner_url TEXT NOT NULL DEFAULT '',bio TEXT NOT NULL DEFAULT '',is_admin INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
    CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL);`);
  const auth = createAuthManager({ db, sessionSecret: secret, codePepper: 'test-only-pepper'.repeat(4),
    mailer: { available: false }, config: { bcryptRounds: 4, emailEnforcement: 'off' } });
  const passhash = formatPasswordHash(bcrypt.hashSync(passwordPrehash(password), 4));
  db.prepare('INSERT INTO users(id,username,display_name,passhash,created,email_verified_at) VALUES(?,?,?,?,?,?)')
    .run('user-1', 'user', 'Test User', passhash, Date.now(), Date.now());
  const user = () => db.prepare('SELECT * FROM users WHERE id=?').get('user-1');
  const compat = createNativeAuthCompatibility({ db, sessionSecret: secret });
  const baseVerify = auth.verifySession;
  auth.verifySession = (token, options) => compat.verifyContext(baseVerify(token, options), token);
  const notifyConns = new Map(), treeSrv = { peers: new Map() };
  const routes = new Map();
  const context = {
    app: { post: (url, ...handlers) => routes.set(url, handlers) },
    db, authManager: auth, nativeAuthCompat: compat, nativeAuthRequested, requireNativeAuthTransport, nativeRefreshCredential,
    AuthError, notifyConns, treeSrv, Buffer, formatPasswordHash, passwordPrehash, norm: (value) => String(value || '').trim().toLowerCase(),
    DUMMY_LOGIN_HASH: passhash,
    sessionPayload: (u) => ({ user: { id: u.id, username: u.username }, account: { state: 'ready' } }),
    bearerToken: (req) => String(req.headers.authorization || '').replace(/^Bearer /, ''),
    authRoute: (fn) => fn,
    requireSession(req) {
      const result = auth.verifySession(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      req.user = result.user; req.authPayload = result.payload; req.authState = result.state;
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function sendNativeAuthBundle('), source.indexOf('// Имена всегда выпускает наш upload route')), context);
  for (const url of ['/api/login', '/api/auth/session/refresh', '/api/auth/session/logout', '/api/auth/session/upgrade', '/api/auth/session/logout-legacy']) {
    const start = source.indexOf(`app.post('${url}',`);
    assert.ok(start >= 0, `${url} must remain available to installed clients`);
    const end = source.indexOf('\n}));', start) + '\n}));'.length;
    vm.runInContext(source.slice(start, end), context);
  }
  async function post(url, { headers = nativeHeaders, body = {} } = {}) {
    const req = { headers, body, ip: 'test-client' };
    const response = { status: 200, headers: {}, body: null };
    const res = { setHeader: (key, value) => { response.headers[key] = value; }, json: (value) => { response.body = value; return response; } };
    try { for (const handler of routes.get(url)) await handler(req, res); }
    catch (error) { if (!(error instanceof AuthError)) throw error; response.status = error.status; response.body = { error: { code: error.code } }; }
    return response;
  }
  return { db, compat, auth, user, post, notifyConns, treeSrv };
}

// These constraints are the actual parse_persistent_bundle contract from the installed
// ab6f8a9 native_auth.rs, not merely the shape accepted by today's renderer.
function assertInstalledNativeBundle(body) {
  assert.equal(body.protocol, 'persistent-v1');
  assert.equal(body.token, body.accessToken); assert.ok(body.accessToken.length > 0);
  assert.ok(Number.isSafeInteger(body.accessExpiresAt) && body.accessExpiresAt > Date.now() - 5000);
  assert.match(body.sessionId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(body.refreshToken, /^rr1\.[A-Za-z0-9_-]{32}\.[0-9a-z]{1,11}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(body.refreshToken.split('.')[1], body.sessionId);
  assert.equal(typeof body.user.id, 'string'); assert.ok(body.user.id);
  assert.equal(typeof body.user.username, 'string'); assert.ok(body.user.username);
  assert.ok(['ready', 'email_required', 'email_verification'].includes(body.account.state));
  assert.equal(body.user.passhash, undefined);
  assert.equal(body.csrfToken, undefined);
  const { refreshToken, ...renderer } = body;
  assert.equal(JSON.stringify(renderer).includes(refreshToken), false);
}

test('installed native pending logout drains after expired access, then login and refresh satisfy its broker', async () => {
  const f = setup();
  const old = f.compat.create(f.user());
  const expired = jwt.sign({ sub: f.user().id, sv: 0, sid: old.sessionId, sg: 0, typ: 'session', exp: Math.floor(Date.now() / 1000) - 1 }, secret);
  assert.throws(() => f.auth.verifySession(expired), code('UNAUTHORIZED'));
  const headers = { ...nativeHeaders, authorization: `Refresh ${old.refreshToken}` };
  const logout = await f.post('/api/auth/session/logout', { headers });
  assert.equal(logout.status, 200); assert.equal(logout.body.ok, true);
  assert.ok(f.db.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(old.sessionId).revoked_at);
  assert.throws(() => f.auth.verifySession(old.accessToken), code('SESSION_REVOKED'));
  assert.throws(() => f.compat.refresh(old.refreshToken), code('SESSION_REVOKED'));
  const retry = await f.post('/api/auth/session/logout', { headers });
  assert.equal(retry.status, 200, 'lost logout responses can be retried');
  const login = await f.post('/api/login', { body: { username: 'user', password } });
  assert.equal(login.status, 200); assertInstalledNativeBundle(login.body);
  assert.equal(f.auth.verifySession(login.body.accessToken).user.id, f.user().id);
  const refreshed = await f.post('/api/auth/session/refresh', { headers: { ...nativeHeaders, authorization: `Refresh ${login.body.refreshToken}` } });
  assert.equal(refreshed.status, 200); assertInstalledNativeBundle(refreshed.body);
  assert.equal(refreshed.body.sessionId, login.body.sessionId, 'broker rejects a changed device session');
  assert.notEqual(refreshed.body.refreshToken, login.body.refreshToken);
  assert.equal(f.db.prepare('SELECT session_version FROM users WHERE id=?').get(f.user().id).session_version, 0);
  f.db.close();
});

test('historical rr1 rows survive initialization and recover a lost refresh response', () => {
  const f = setup();
  const id = 'A'.repeat(32), generation = 6;
  // Independent transcription of the original server's domain and token format.
  const key = crypto.createHmac('sha256', secret).update('RelayApp opaque refresh credentials v1\0', 'utf8').digest();
  const make = (n) => `rr1.${id}.${n.toString(36)}.${crypto.createHmac('sha256', key).update(`refresh\0${id}\0${n.toString(36)}`, 'utf8').digest('base64url')}`;
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const original = make(generation);
  f.db.prepare(`INSERT INTO auth_sessions(id,user_id,session_version,refresh_hash,previous_refresh_hash,generation,previous_generation,
    csrf_hash,client_kind,created,last_used) VALUES(?,?,0,?,?,?,?,?,'native',?,?)`)
    .run(id, f.user().id, hash(original), hash(make(generation - 1)), generation, generation - 1, 'unused-for-native', 100, 200);
  const reopened = createNativeAuthCompatibility({ db: f.db, sessionSecret: secret });
  const rotated = reopened.refresh(original), recovered = reopened.refresh(original);
  assert.equal(rotated.sessionId, id); assert.equal(rotated.refreshToken, make(generation + 1));
  assert.equal(recovered.refreshToken, rotated.refreshToken);
  assert.equal(f.db.prepare('SELECT created FROM auth_sessions WHERE id=?').get(id).created, 100);
  const ancient = make(0);
  reopened.logout(ancient); // the original broker's explicit logout accepts any authentic generation
  assert.throws(() => reopened.refresh(rotated.refreshToken), code('SESSION_REVOKED'));
  f.db.close();
});

test('native endpoints reject forged secrets and browser origins without revoking real sessions', async () => {
  const f = setup(); const original = f.compat.create(f.user());
  const forged = original.refreshToken.slice(0, -1) + (original.refreshToken.endsWith('A') ? 'B' : 'A');
  for (const url of ['/api/auth/session/refresh', '/api/auth/session/logout']) {
    const bad = await f.post(url, { headers: { ...nativeHeaders, authorization: `Refresh ${forged}` } });
    assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'REFRESH_INVALID');
    const origin = await f.post(url, { headers: { ...nativeHeaders, origin: 'https://attacker.invalid', authorization: `Refresh ${original.refreshToken}` } });
    assert.equal(origin.status, 403);
    const cookie = await f.post(url, { headers: { ...nativeHeaders, 'x-relay-auth-transport': 'cookie-v1', cookie: `__Host-relay_refresh=${original.refreshToken}` } });
    assert.equal(cookie.status, 400);
  }
  assert.equal(f.db.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(original.sessionId).revoked_at, 0);
  assert.equal((await f.post('/api/login', { body: { username: 'user', password: 'wrong password' } })).status, 401);
  f.db.close();
});

test('ordinary browser login remains legacy and native logout leaves its bearer and other device intact', async () => {
  const f = setup();
  const browser = await f.post('/api/login', { headers: {}, body: { username: 'user', password } });
  assert.equal(browser.status, 200); assert.ok(browser.body.token);
  assert.equal(browser.body.protocol, undefined); assert.equal(browser.body.refreshToken, undefined);
  const first = f.compat.create(f.user()), other = f.compat.create(f.user());
  f.compat.logout(first.refreshToken);
  assert.equal(f.auth.verifySession(browser.body.token).user.id, f.user().id);
  assert.equal(f.auth.verifySession(other.accessToken).user.id, f.user().id);
  assert.ok(f.compat.refresh(other.refreshToken));
  f.db.close();
});

test('logout closes exactly its native sockets and removes only owned requested push subscriptions', async () => {
  const f = setup(); const first = f.compat.create(f.user()), other = f.compat.create(f.user());
  const socket = (sessionId) => ({ _authSessionId: sessionId, __authSessionId: sessionId, closed: 0, close() { this.closed++; } });
  const ownNotify = socket(first.sessionId), otherNotify = socket(other.sessionId), ownTree = socket(first.sessionId), otherTree = socket(other.sessionId);
  f.notifyConns.set(f.user().id, new Set([ownNotify, otherNotify]));
  f.treeSrv.peers.set('one', { ws: ownTree }); f.treeSrv.peers.set('two', { ws: otherTree });
  f.db.prepare('INSERT INTO push_subs(endpoint,user_id) VALUES(?,?)').run('https://push.invalid/own', f.user().id);
  f.db.prepare('INSERT INTO push_subs(endpoint,user_id) VALUES(?,?)').run('https://push.invalid/other', 'other-user');
  const result = await f.post('/api/auth/session/logout', { headers: { ...nativeHeaders, authorization: `Refresh ${first.refreshToken}` },
    body: { pushCleanups: [{ userId: f.user().id, endpoint: 'https://push.invalid/own' }, { userId: 'other-user', endpoint: 'https://push.invalid/other' }] } });
  assert.equal(result.status, 200); assert.equal(ownNotify.closed, 1); assert.equal(ownTree.closed, 1);
  assert.equal(otherNotify.closed, 0); assert.equal(otherTree.closed, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 1);
  f.db.close();
});

test('legacy native upgrade is idempotent and cannot resurrect an explicitly logged out token', async () => {
  const f = setup(); const token = f.auth.issueSession(f.user());
  const headers = { ...nativeHeaders, authorization: `Bearer ${token}` };
  const first = await f.post('/api/auth/session/upgrade', { headers }), second = await f.post('/api/auth/session/upgrade', { headers });
  assert.equal(first.status, 200); assertInstalledNativeBundle(first.body); assert.equal(first.body.sessionId, second.body.sessionId);
  await f.post('/api/auth/session/logout', { headers: { ...nativeHeaders, authorization: `Refresh ${first.body.refreshToken}` } });
  assert.equal((await f.post('/api/auth/session/upgrade', { headers })).status, 401);
  assert.throws(() => f.auth.verifySession(token), code('SESSION_REVOKED'));
  f.db.close();
});

test('account security changes invalidate old sessions while preserving the current native broker identity', () => {
  const f = setup(); const original = f.compat.create(f.user()), other = f.compat.create(f.user());
  f.db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(f.user().id);
  const preserved = f.compat.preserveAfterSecurityChange(original.sessionId, f.user(), 0);
  assert.equal(preserved.sessionId, original.sessionId);
  assert.equal(f.auth.verifySession(preserved.accessToken).payload.sv, 1);
  assert.throws(() => f.auth.verifySession(other.accessToken), code('SESSION_REVOKED'));
  assert.throws(() => f.compat.refresh(other.refreshToken), code('SESSION_REVOKED'));
  f.compat.logout(preserved.refreshToken);
  assert.throws(() => f.compat.preserveAfterSecurityChange(preserved.sessionId, f.user(), 1), code('SESSION_REVOKED'));
  f.db.close();
});

test('native routes have a bounded per-IP request budget and production image includes compatibility', () => {
  const f = setup(); for (let n = 0; n < 120; n++) f.compat.limit({ ip: 'one-client' });
  assert.throws(() => f.compat.limit({ ip: 'one-client' }), code('AUTH_RATE_LIMITED'));
  f.compat.limit({ ip: 'other-client' });
  assert.match(fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8'), /\bnativeAuthCompat\.js\b/);
  assert.match(fs.readFileSync(path.join(__dirname, 'tree.js'), 'utf8'), /ws\.__authSessionId = payload\.sid/);
  f.db.close();
});

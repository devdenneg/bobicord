'use strict';

// Native builds issued before the September rollback store rr1 credentials in the OS
// broker and require persistent-v1 responses. Keep that wire contract without restoring
// media-room activation or changing the browser's legacy login response.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { AuthError } = require('./auth');

const REFRESH_RE = /^rr1\.([A-Za-z0-9_-]{32})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/;
const NATIVE_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const equal = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const fail = (code = 'REFRESH_INVALID', message = 'Сессия завершена. Войдите снова.') => { throw new AuthError(401, code, message); };

function nativeAuthRequested(req) {
  return req.headers['x-relay-auth-protocol'] === 'persistent-v1'
    && req.headers['x-relay-auth-transport'] === 'bearer-v1';
}

function requireNativeAuthTransport(req) {
  if (!nativeAuthRequested(req)) throw new AuthError(400, 'AUTH_TRANSPORT_INVALID', 'Ожидается защищённая сессия приложения.');
  const origin = String(req.headers.origin || '');
  if (origin && !NATIVE_ORIGINS.has(origin)) throw new AuthError(403, 'AUTH_ORIGIN_FORBIDDEN', 'Источник запроса авторизации запрещён.');
}

function nativeRefreshCredential(req) {
  requireNativeAuthTransport(req);
  return /^Refresh ([A-Za-z0-9._-]+)$/.exec(String(req.headers.authorization || ''))?.[1] || '';
}

function createNativeAuthCompatibility({ db, sessionSecret, now = Date.now }) {
  if (!sessionSecret) throw new TypeError('native auth requires sessionSecret');
  // The table shape and HMAC domain intentionally match the installed client's original server.
  // Existing rows, generations, revocations and legacy-token tombstones must survive rollback.
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_version INTEGER NOT NULL,
      refresh_hash TEXT NOT NULL, previous_refresh_hash TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0, previous_generation INTEGER NOT NULL DEFAULT -1,
      csrf_hash TEXT NOT NULL, client_kind TEXT NOT NULL CHECK(client_kind IN ('web','native')),
      device_name TEXT NOT NULL DEFAULT '', legacy_token_hash TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL, last_used INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT 0, revoke_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id,revoked_at,last_used);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_legacy_token
      ON auth_sessions(legacy_token_hash) WHERE legacy_token_hash<>'';
    CREATE TABLE IF NOT EXISTS auth_legacy_token_revocations(
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, revoked_at INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT ''
    );
  `);
  const key = crypto.createHmac('sha256', sessionSecret).update('RelayApp opaque refresh credentials v1\0').digest();
  const proof = (label) => crypto.createHmac('sha256', key).update(label).digest('base64url');
  const tokenFor = (id, generation) => `rr1.${id}.${generation.toString(36)}.${proof(`refresh\0${id}\0${generation.toString(36)}`)}`;
  const rowFor = db.prepare('SELECT * FROM auth_sessions WHERE id=?');
  const userFor = db.prepare('SELECT * FROM users WHERE id=?');
  const revokedLegacy = db.prepare('SELECT 1 FROM auth_legacy_token_revocations WHERE token_hash=?');
  const byLegacy = db.prepare('SELECT * FROM auth_sessions WHERE legacy_token_hash=?');
  const rates = new Map();

  function limit(req) {
    const at = now(), ip = String(req.ip || '').slice(0, 128);
    let item = rates.get(ip);
    if (!item || at - item.at >= 60_000) {
      if (rates.size >= 4096) rates.delete(rates.keys().next().value);
      item = { at, count: 0 }; rates.set(ip, item);
    }
    if (++item.count > 120) throw new AuthError(429, 'AUTH_RATE_LIMITED', 'Слишком много запросов. Повторите позже.');
  }
  function parse(raw) {
    const match = REFRESH_RE.exec(String(raw || ''));
    if (!match) fail();
    const generation = Number.parseInt(match[2], 36);
    if (!Number.isSafeInteger(generation) || generation < 0
      || !equal(raw, tokenFor(match[1], generation))) fail();
    return { id: match[1], generation, raw };
  }
  function validUser(row) {
    const user = row && userFor.get(row.user_id);
    if (!row || row.revoked_at || !user || Number(row.session_version) !== (Number(user.session_version) || 0)) fail('SESSION_REVOKED');
    return user;
  }
  function bundle(row, user) {
    const issued = Math.floor(now() / 1000), ttl = 900;
    const accessToken = jwt.sign({ id: user.id, sub: user.id, sv: Number(user.session_version) || 0,
      sid: row.id, sg: Number(row.generation), typ: 'session', iat: issued, exp: issued + ttl }, sessionSecret, { algorithm: 'HS256' });
    return { protocol: 'persistent-v1', token: accessToken, accessToken, accessExpiresAt: (issued + ttl) * 1000,
      sessionId: row.id, refreshToken: tokenFor(row.id, Number(row.generation)), user };
  }
  const createTx = db.transaction((user, legacyToken = '') => {
    const legacyHash = legacyToken ? hash(legacyToken) : '';
    if (legacyHash) {
      if (revokedLegacy.get(legacyHash)) fail('SESSION_REVOKED');
      const existing = byLegacy.get(legacyHash);
      if (existing) {
        if (existing.user_id !== user.id || existing.client_kind !== 'native') fail('SESSION_REVOKED');
        return bundle(existing, validUser(existing));
      }
    }
    const id = crypto.randomBytes(24).toString('base64url'), at = now();
    db.prepare(`INSERT INTO auth_sessions(id,user_id,session_version,refresh_hash,csrf_hash,client_kind,
      device_name,legacy_token_hash,created,last_used) VALUES(?,?,?,?,?,'native','RelayApp desktop',?,?,?)`)
      .run(id, user.id, Number(user.session_version) || 0, hash(tokenFor(id, 0)), hash(proof(`csrf\0${id}`)), legacyHash, at, at);
    return bundle(rowFor.get(id), user);
  });
  const refreshTx = db.transaction((raw) => {
    const supplied = parse(raw), row = rowFor.get(supplied.id);
    if (!row || row.client_kind !== 'native') fail();
    const user = validUser(row), generation = Number(row.generation);
    if (supplied.generation > generation || supplied.generation < Math.max(0, generation - 8)) fail('REFRESH_STALE', 'Сессия уже обновлена. Повторите вход.');
    if (supplied.generation === generation) {
      if (!equal(hash(raw), row.refresh_hash) || generation >= Number.MAX_SAFE_INTEGER - 1) fail();
      db.prepare(`UPDATE auth_sessions SET previous_refresh_hash=refresh_hash,previous_generation=generation,
        refresh_hash=?,generation=?,last_used=? WHERE id=?`)
        .run(hash(tokenFor(row.id, generation + 1)), generation + 1, now(), row.id);
    } else db.prepare('UPDATE auth_sessions SET last_used=? WHERE id=?').run(now(), row.id);
    return bundle(rowFor.get(row.id), user);
  });
  const logoutTx = db.transaction((raw) => {
    const supplied = parse(raw), row = rowFor.get(supplied.id);
    if (!row) return null; // no durable session can be resumed by this credential
    if (row.client_kind !== 'native') fail();
    db.prepare("UPDATE auth_sessions SET revoked_at=?,revoke_reason='native-logout' WHERE id=? AND revoked_at=0").run(now(), row.id);
    if (row.legacy_token_hash) db.prepare(`INSERT OR IGNORE INTO auth_legacy_token_revocations(token_hash,user_id,revoked_at,reason)
      VALUES(?,?,?,'native-logout')`).run(row.legacy_token_hash, row.user_id, now());
    return { userId: row.user_id, sessionId: row.id, legacyTokenHash: row.legacy_token_hash };
  });
  const logoutLegacyTx = db.transaction((token, user) => {
    const tokenHash = hash(token), row = byLegacy.get(tokenHash);
    db.prepare(`INSERT OR IGNORE INTO auth_legacy_token_revocations(token_hash,user_id,revoked_at,reason)
      VALUES(?,?,?,'legacy-logout')`).run(tokenHash, user.id, now());
    if (row && row.user_id === user.id) db.prepare("UPDATE auth_sessions SET revoked_at=?,revoke_reason='legacy-logout' WHERE id=? AND revoked_at=0").run(now(), row.id);
    return { userId: user.id, sessionId: row?.id || '', legacyTokenHash: tokenHash };
  });
  const preserveTx = db.transaction((sessionId, user, previousVersion) => {
    const row = rowFor.get(String(sessionId || ''));
    if (!row || row.client_kind !== 'native' || row.user_id !== user.id || row.revoked_at
      || Number(row.session_version) !== previousVersion
      || (Number(userFor.get(user.id)?.session_version) || 0) !== (Number(user.session_version) || 0)) fail('SESSION_REVOKED');
    const generation = Number(row.generation) + 1;
    if (!Number.isSafeInteger(generation)) fail('SESSION_REVOKED');
    db.prepare(`UPDATE auth_sessions SET session_version=?,previous_refresh_hash=refresh_hash,previous_generation=generation,
      refresh_hash=?,generation=?,last_used=? WHERE id=? AND revoked_at=0`)
      .run(Number(user.session_version) || 0, hash(tokenFor(row.id, generation)), generation, now(), row.id);
    return bundle(rowFor.get(row.id), user);
  });
  function verifyContext(context, token) {
    const { user, payload } = context;
    if (payload.sid != null) {
      const row = typeof payload.sid === 'string' ? rowFor.get(payload.sid) : null;
      if (!row || row.user_id !== user.id || row.revoked_at || Number(row.session_version) !== (Number(user.session_version) || 0)
        || !Number.isSafeInteger(payload.sg) || payload.sg < 0 || payload.sg > Number(row.generation)) fail('SESSION_REVOKED');
    } else {
      const tokenHash = hash(token);
      if (revokedLegacy.get(tokenHash)) fail('SESSION_REVOKED');
      const upgraded = byLegacy.get(tokenHash);
      if (upgraded && (upgraded.revoked_at || upgraded.user_id !== user.id
        || Number(upgraded.session_version) !== (Number(user.session_version) || 0))) fail('SESSION_REVOKED');
    }
    return context;
  }
  return { limit, create: (user, legacy) => createTx.immediate(user, legacy), refresh: (token) => refreshTx.immediate(token),
    preserveAfterSecurityChange: (id, user, version) => preserveTx.immediate(id, user, version),
    logoutLegacy: (token, user) => logoutLegacyTx.immediate(token, user),
    logout: (token) => logoutTx.immediate(token), verifyContext, tokenHash: hash };
}

module.exports = { createNativeAuthCompatibility, nativeAuthRequested, requireNativeAuthTransport, nativeRefreshCredential };

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const REFRESH_TOKEN_RE = /^rr1\.([A-Za-z0-9_-]{32})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/u;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{32}$/u;
const CSRF_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;
const ACCESS_SESSION_ID_RE = SESSION_ID_RE;
const WEB_REFRESH_COOKIE = '__Host-relay_refresh';
const WEB_CSRF_COOKIE = '__Host-relay_csrf';
const PERSISTENT_PROTOCOL = 'persistent-v1';
const COOKIE_TRANSPORT = 'cookie-v1';
const BEARER_TRANSPORT = 'bearer-v1';
const REFRESH_RECOVERY_GENERATIONS = 8;
// Chromium clamps persistent cookies to roughly 400 days. Refresh renews both cookies, while the
// authoritative server-side session itself deliberately has no idle or absolute expiry.
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

class PersistentSessionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PersistentSessionError';
    this.status = status;
    this.code = code;
  }
}

function sessionFail(status, code, message) {
  throw new PersistentSessionError(status, code, message);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function installPersistentSessionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_version INTEGER NOT NULL,
      refresh_hash TEXT NOT NULL,
      previous_refresh_hash TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0,
      previous_generation INTEGER NOT NULL DEFAULT -1,
      csrf_hash TEXT NOT NULL,
      client_kind TEXT NOT NULL CHECK(client_kind IN ('web','native')),
      device_name TEXT NOT NULL DEFAULT '',
      legacy_token_hash TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT 0,
      revoke_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
      ON auth_sessions(user_id, revoked_at, last_used);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_legacy_token
      ON auth_sessions(legacy_token_hash) WHERE legacy_token_hash <> '';

    CREATE TABLE IF NOT EXISTS auth_legacy_token_revocations(
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      revoked_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_auth_legacy_token_revocations_user
      ON auth_legacy_token_revocations(user_id, revoked_at);

    CREATE TABLE IF NOT EXISTS auth_session_rate_limits(
      scope TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      window_started INTEGER NOT NULL,
      count INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY(scope, key_hash)
    );
  `);
}

function parseRefreshToken(value) {
  const raw = String(value || '');
  const match = REFRESH_TOKEN_RE.exec(raw);
  if (!match) return null;
  const generation = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  return { raw, sessionId: match[1], generation };
}

function persistentSessionRateSubject(value, { allowOpaque = false } = {}) {
  const parsed = parseRefreshToken(value);
  if (parsed) return parsed.sessionId;
  const opaque = String(value || '');
  // Missing/malformed refresh cookies must not share one global per-session bucket: anonymous
  // browser boots are unrelated principals and are already covered by the coarse IP backstop.
  // Upgrade is the sole opaque-credential caller and opts in with its exact legacy bearer.
  return allowOpaque && opaque ? opaque.slice(0, 16_384) : null;
}

function parseExactHttpOrigins(value, variableName = 'PERSISTENT_WEB_ORIGINS') {
  const origins = new Set();
  for (const raw of String(value || '').split(',')) {
    const candidate = raw.trim();
    if (!candidate) continue;
    let parsed;
    try { parsed = new URL(candidate); }
    catch { throw new Error(`${variableName} contains an invalid origin: ${candidate}`); }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || candidate.includes('*') || parsed.origin === 'null') {
      throw new Error(`${variableName} must contain exact HTTP(S) origins without paths or wildcards: ${candidate}`);
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function parseCookieHeader(header) {
  const result = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || Object.prototype.hasOwnProperty.call(result, name)) continue;
    try { result[name] = decodeURIComponent(value); }
    catch { result[name] = value; }
  }
  return result;
}

function webSessionCookieHeaders(refreshToken, csrfToken) {
  return [
    `${WEB_REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Strict; Priority=High`,
    `${WEB_CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Secure; SameSite=Strict; Priority=High`,
  ];
}

function clearWebSessionCookieHeaders() {
  const expired = 'Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict';
  return [
    `${WEB_REFRESH_COOKIE}=; ${expired}; HttpOnly`,
    `${WEB_CSRF_COOKIE}=; ${expired}`,
  ];
}

function persistentProtocolRequested(req) {
  return String(req && req.headers && req.headers['x-relay-auth-protocol'] || '') === PERSISTENT_PROTOCOL;
}

function exactOrigin(req) {
  return String(req && req.headers && req.headers.origin || '');
}

function transportRequest(req, { webOrigins, nativeOrigins, bootstrap = false } = {}) {
  if (!persistentProtocolRequested(req)) {
    sessionFail(400, 'AUTH_PROTOCOL_REQUIRED', 'Клиент не запросил безопасную сессию.');
  }
  const transport = String(req.headers['x-relay-auth-transport'] || '');
  const origin = exactOrigin(req);
  if (transport === COOKIE_TRANSPORT) {
    if (!origin || !webOrigins || !webOrigins.has(origin)) {
      sessionFail(403, 'AUTH_ORIGIN_FORBIDDEN', 'Источник запроса авторизации запрещён.');
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    const csrfHeader = String(req.headers['x-relay-csrf'] || '');
    if (bootstrap) {
      if (csrfHeader !== '1') sessionFail(403, 'AUTH_CSRF_INVALID', 'Проверка безопасности запроса не пройдена.');
    } else if (!CSRF_TOKEN_RE.test(csrfHeader)
      || !CSRF_TOKEN_RE.test(String(cookies[WEB_CSRF_COOKIE] || ''))
      || !safeEqual(csrfHeader, cookies[WEB_CSRF_COOKIE])) {
      sessionFail(403, 'AUTH_CSRF_INVALID', 'Проверка безопасности запроса не пройдена.');
    }
    return {
      kind: 'web',
      refreshToken: String(cookies[WEB_REFRESH_COOKIE] || ''),
      csrfToken: csrfHeader,
    };
  }
  if (transport === BEARER_TRANSPORT) {
    if (origin && (!nativeOrigins || !nativeOrigins.has(origin))) {
      sessionFail(403, 'AUTH_ORIGIN_FORBIDDEN', 'Источник запроса авторизации запрещён.');
    }
    const authorization = String(req.headers.authorization || '');
    const match = /^Refresh ([A-Za-z0-9._-]+)$/u.exec(authorization);
    return { kind: 'native', refreshToken: match ? match[1] : '', csrfToken: '' };
  }
  sessionFail(400, 'AUTH_TRANSPORT_INVALID', 'Неизвестный способ хранения сессии.');
}

function createPersistentSessionManager(options) {
  if (!options || !options.db) throw new TypeError('createPersistentSessionManager requires db');
  const db = options.db;
  const sessionSecret = String(options.sessionSecret || '');
  if (!sessionSecret) throw new TypeError('createPersistentSessionManager requires sessionSecret');
  const now = options.now || (() => Date.now());
  const accessTtlSeconds = Math.max(300, Math.min(3600, Number(options.accessTtlSeconds) || 15 * 60));
  const refreshKey = crypto.createHmac('sha256', sessionSecret)
    .update('RelayApp opaque refresh credentials v1\0', 'utf8').digest();
  installPersistentSessionSchema(db);

  function userRow(userOrId) {
    const user = typeof userOrId === 'object' && userOrId
      ? userOrId
      : db.prepare('SELECT * FROM users WHERE id=?').get(String(userOrId || ''));
    if (!user) sessionFail(401, 'UNAUTHORIZED', 'Не авторизован.');
    return user;
  }

  function tokenFor(sessionId, generation) {
    const encodedGeneration = Number(generation).toString(36);
    const proof = crypto.createHmac('sha256', refreshKey)
      .update(`refresh\0${sessionId}\0${encodedGeneration}`, 'utf8').digest('base64url');
    return `rr1.${sessionId}.${encodedGeneration}.${proof}`;
  }

  function csrfFor(sessionId) {
    return crypto.createHmac('sha256', refreshKey)
      .update(`csrf\0${sessionId}`, 'utf8').digest('base64url');
  }

  function currentResult(row, user, { recovered = false } = {}) {
    return {
      row,
      user,
      refreshToken: tokenFor(row.id, row.generation),
      csrfToken: csrfFor(row.id),
      recovered,
    };
  }

  function issueAccess(result) {
    const sessionVersion = Number(result.user.session_version) || 0;
    const token = jwt.sign({
      id: result.user.id,
      sub: result.user.id,
      sv: sessionVersion,
      sid: result.row.id,
      sg: Number(result.row.generation) || 0,
      // Keep typ=session during a rolling deployment: an old API instance can validate this
      // short-lived JWT for at most accessTtlSeconds. New instances recognize sid/sg and also
      // require the durable session row, so logout is immediate once the old pool is drained.
      typ: 'session',
    }, sessionSecret, { algorithm: 'HS256', expiresIn: accessTtlSeconds });
    const decoded = jwt.decode(token);
    return {
      accessToken: token,
      accessExpiresAt: Number(decoded && decoded.exp) * 1000,
      sessionId: result.row.id,
      refreshToken: result.refreshToken,
      csrfToken: result.csrfToken,
      recovered: result.recovered,
      user: result.user,
      clientKind: result.row.client_kind,
    };
  }

  function create(userOrId, { clientKind, deviceName = '', legacyToken = '' } = {}) {
    const user = userRow(userOrId);
    if (!['web', 'native'].includes(clientKind)) {
      sessionFail(400, 'AUTH_TRANSPORT_INVALID', 'Неизвестный способ хранения сессии.');
    }
    const legacyTokenHash = legacyToken ? sha256(legacyToken) : '';
    if (legacyTokenHash) {
      const revoked = db.prepare('SELECT 1 FROM auth_legacy_token_revocations WHERE token_hash=?').get(legacyTokenHash);
      if (revoked) sessionFail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
      const existing = db.prepare('SELECT * FROM auth_sessions WHERE legacy_token_hash=?').get(legacyTokenHash);
      if (existing) {
        if (existing.user_id !== user.id || existing.revoked_at
          || Number(existing.session_version) !== (Number(user.session_version) || 0)) {
          sessionFail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
        }
        if (existing.client_kind !== clientKind) {
          sessionFail(409, 'SESSION_ALREADY_UPGRADED', 'Эта старая сессия уже обновлена на другом клиенте.');
        }
        return issueAccess(currentResult(existing, user, { recovered: true }));
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const id = crypto.randomBytes(24).toString('base64url');
      const refreshToken = tokenFor(id, 0);
      const csrfToken = csrfFor(id);
      const at = now();
      try {
        db.prepare(`INSERT INTO auth_sessions(
          id,user_id,session_version,refresh_hash,previous_refresh_hash,generation,previous_generation,
          csrf_hash,client_kind,device_name,legacy_token_hash,created,last_used,revoked_at,revoke_reason
        ) VALUES(?,?,?,?, '',0,-1,?,?,?,?,?,?,0,'')`).run(
          id, user.id, Number(user.session_version) || 0, sha256(refreshToken), sha256(csrfToken),
          clientKind, String(deviceName || '').slice(0, 120), legacyTokenHash, at, at,
        );
        return issueAccess(currentResult(db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(id), user));
      } catch (error) {
        if (!String(error && error.code || '').startsWith('SQLITE_CONSTRAINT')) throw error;
        if (legacyTokenHash) {
          const existing = db.prepare('SELECT * FROM auth_sessions WHERE legacy_token_hash=?').get(legacyTokenHash);
          if (existing && !existing.revoked_at && existing.user_id === user.id
            && existing.client_kind === clientKind
            && Number(existing.session_version) === (Number(user.session_version) || 0)) {
            return issueAccess(currentResult(existing, user, { recovered: true }));
          }
        }
      }
    }
    sessionFail(503, 'AUTH_SESSION_UNAVAILABLE', 'Не удалось создать сессию. Попробуйте снова.');
  }

  const rotateTx = db.transaction((parsed, csrfToken, clientKind, allowCsrfRecovery) => {
    const row = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(parsed.sessionId);
    if (!row || row.revoked_at) sessionFail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
    if (row.client_kind !== clientKind) {
      sessionFail(401, 'REFRESH_INVALID', 'Не удалось обновить сессию.');
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
    if (!user || Number(row.session_version) !== (Number(user.session_version) || 0)) {
      db.prepare("UPDATE auth_sessions SET revoked_at=?,revoke_reason='session-version' WHERE id=? AND revoked_at=0")
        .run(now(), row.id);
      sessionFail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
    }
    if (row.client_kind === 'web' && !allowCsrfRecovery
      && (!CSRF_TOKEN_RE.test(String(csrfToken || '')) || !safeEqual(row.csrf_hash, sha256(csrfToken)))) {
      sessionFail(403, 'AUTH_CSRF_INVALID', 'Проверка безопасности запроса не пройдена.');
    }
    const suppliedHash = sha256(parsed.raw);
    if (parsed.generation === Number(row.generation) && safeEqual(suppliedHash, row.refresh_hash)) {
      if (row.generation >= Number.MAX_SAFE_INTEGER - 1) {
        sessionFail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
      }
      const nextGeneration = Number(row.generation) + 1;
      const nextToken = tokenFor(row.id, nextGeneration);
      db.prepare(`UPDATE auth_sessions SET previous_refresh_hash=refresh_hash,previous_generation=generation,
        refresh_hash=?,generation=?,last_used=? WHERE id=?`)
        .run(sha256(nextToken), nextGeneration, now(), row.id);
      const updated = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(row.id);
      return currentResult(updated, user);
    }
    if (parsed.generation === Number(row.previous_generation)
      && safeEqual(suppliedHash, row.previous_refresh_hash)) {
      db.prepare('UPDATE auth_sessions SET last_used=? WHERE id=?').run(now(), row.id);
      return currentResult(db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(row.id), user, { recovered: true });
    }
    // Cookie writes from concurrent tabs can be committed out of response order. Keep a small,
    // bounded authentic-generation window so a delayed Set-Cookie cannot strand the durable row.
    // The token is HMAC-bound to this session+generation; forged and older-than-window replays fail.
    const generation = Number(row.generation);
    if (parsed.generation < generation
      && parsed.generation >= Math.max(0, generation - REFRESH_RECOVERY_GENERATIONS)
      && safeEqual(parsed.raw, tokenFor(row.id, parsed.generation))) {
      db.prepare('UPDATE auth_sessions SET last_used=? WHERE id=?').run(now(), row.id);
      return currentResult(db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(row.id), user, { recovered: true });
    }
    sessionFail(401, 'REFRESH_STALE', 'Сессия на этом устройстве уже была обновлена.');
  });

  function refresh(refreshToken, { csrfToken = '', clientKind, allowCsrfRecovery = false } = {}) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) sessionFail(401, 'REFRESH_INVALID', 'Не удалось обновить сессию.');
    // Like logout recovery, resume recovery is exact-origin web-only. It repairs a missing readable
    // CSRF partner for an authentic current/previous refresh generation; ordinary refresh never
    // bypasses double-submit validation and older replayed generations remain rejected.
    const recover = clientKind === 'web' && allowCsrfRecovery === true;
    const result = rotateTx.immediate
      ? rotateTx.immediate(parsed, csrfToken, clientKind, recover)
      : rotateTx(parsed, csrfToken, clientKind, recover);
    return issueAccess(result);
  }

  function verifyAccessPayload(payload, user) {
    if (!payload || payload.typ !== 'session' || !ACCESS_SESSION_ID_RE.test(String(payload.sid || ''))) return false;
    const row = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(payload.sid);
    if (!row || row.revoked_at || row.user_id !== user.id) return false;
    const version = Number(user.session_version) || 0;
    if (Number(row.session_version) !== version || payload.sv !== version) return false;
    const generation = Number(payload.sg);
    return Number.isSafeInteger(generation) && generation >= 0 && generation <= Number(row.generation);
  }

  function verifyLegacyToken(rawToken, user) {
    const tokenHash = legacyTokenKey(rawToken);
    if (db.prepare('SELECT 1 FROM auth_legacy_token_revocations WHERE token_hash=?').get(tokenHash)) return false;
    const upgraded = db.prepare('SELECT * FROM auth_sessions WHERE legacy_token_hash=?').get(tokenHash);
    if (!upgraded) return true;
    return !upgraded.revoked_at && upgraded.user_id === user.id
      && Number(upgraded.session_version) === (Number(user.session_version) || 0);
  }

  function legacyTokenKey(rawToken) {
    return sha256(rawToken);
  }

  const preserveCurrentSession = (sessionId, user, reason, clientKind) => {
    const row = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(String(sessionId || ''));
    if (!row || row.revoked_at || row.user_id !== user.id || row.client_kind !== clientKind) return null;
    const currentUser = db.prepare('SELECT session_version FROM users WHERE id=?').get(user.id);
    if (!currentUser
      || (Number(currentUser.session_version) || 0) !== (Number(user.session_version) || 0)) return null;
    const at = now();
    db.prepare(`UPDATE auth_sessions SET revoked_at=?,revoke_reason=?
      WHERE user_id=? AND id<>? AND revoked_at=0`).run(at, String(reason || 'security-change'), user.id, row.id);
    if (Number(row.generation) >= Number.MAX_SAFE_INTEGER - 1) {
      sessionFail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
    }
    const nextGeneration = Number(row.generation) + 1;
    const nextToken = tokenFor(row.id, nextGeneration);
    db.prepare(`UPDATE auth_sessions SET session_version=?,previous_refresh_hash=refresh_hash,
      previous_generation=generation,refresh_hash=?,generation=?,last_used=? WHERE id=?`)
      .run(Number(user.session_version) || 0, sha256(nextToken), nextGeneration, at, row.id);
    return db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(row.id);
  };
  const preserveTx = db.transaction(preserveCurrentSession);

  function preserveAfterSecurityChange(sessionId, userOrId, reason, clientKind) {
    const user = userRow(userOrId);
    // Password/email mutations invoke this while their own SQLite transaction is still open, so
    // the selected device row advances atomically with users.session_version. Standalone callers
    // retain an IMMEDIATE transaction. This removes the crash/WS-refresh window where every device,
    // including the current one, could become stale before it was preserved.
    const row = db.inTransaction
      ? preserveCurrentSession(sessionId, user, reason, clientKind)
      : (preserveTx.immediate
          ? preserveTx.immediate(sessionId, user, reason, clientKind)
          : preserveTx(sessionId, user, reason, clientKind));
    return row ? issueAccess(currentResult(row, user)) : null;
  }

  function currentAccess(sessionId, userOrId, clientKind) {
    const user = userRow(userOrId);
    const row = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(String(sessionId || ''));
    if (!row || row.revoked_at || row.user_id !== user.id || row.client_kind !== clientKind
      || Number(row.session_version) !== (Number(user.session_version) || 0)) {
      return null;
    }
    return issueAccess(currentResult(row, user, { recovered: true }));
  }

  /** Authenticate a logout retry even after the row was already revoked by a response-lost pass. */
  function logoutRefreshSubject(refreshToken, {
    csrfToken = '', clientKind, allowCsrfRecovery = false,
  } = {}) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return null;
    const row = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(parsed.sessionId);
    if (!row || row.client_kind !== clientKind) return null;
    // Verify the high-entropy HMAC proof before reporting CSRF state for the referenced row.
    if (!safeEqual(parsed.raw, tokenFor(parsed.sessionId, parsed.generation))) return null;
    const recover = clientKind === 'web' && allowCsrfRecovery === true;
    if (row.client_kind === 'web' && !recover
      && (!CSRF_TOKEN_RE.test(String(csrfToken || '')) || !safeEqual(row.csrf_hash, sha256(csrfToken)))) {
      sessionFail(403, 'AUTH_CSRF_INVALID', 'Проверка безопасности запроса не пройдена.');
    }
    return {
      userId: row.user_id,
      sessionId: row.id,
      legacyTokenHash: row.legacy_token_hash || '',
      revoked: Boolean(row.revoked_at),
    };
  }

  const revokeRefreshTx = db.transaction((parsed, csrfToken, clientKind, reason, allowCsrfRecovery) => {
    const row = db.prepare('SELECT * FROM auth_sessions WHERE id=?').get(parsed.sessionId);
    if (!row || row.revoked_at) return false;
    if (row.client_kind !== clientKind) return false;
    if (row.client_kind === 'web' && !allowCsrfRecovery
      && (!CSRF_TOKEN_RE.test(String(csrfToken || '')) || !safeEqual(row.csrf_hash, sha256(csrfToken)))) {
      sessionFail(403, 'AUTH_CSRF_INVALID', 'Проверка безопасности запроса не пройдена.');
    }
    // Logout is deliberately idempotent across arbitrarily old, but authentic, generations. The
    // HMAC proof binds the credential to this exact session id and generation, so a response-loss
    // race cannot leave a device logged in merely because its cookie was two rotations behind.
    if (!safeEqual(parsed.raw, tokenFor(parsed.sessionId, parsed.generation))) return false;
    db.prepare('UPDATE auth_sessions SET revoked_at=?,revoke_reason=? WHERE id=? AND revoked_at=0')
      .run(now(), String(reason || 'logout'), row.id);
    if (row.legacy_token_hash) {
      db.prepare(`INSERT OR IGNORE INTO auth_legacy_token_revocations(token_hash,user_id,revoked_at,reason)
        VALUES(?,?,?,?)`).run(row.legacy_token_hash, row.user_id, now(), String(reason || 'logout'));
    }
    return true;
  });

  function logoutRefresh(refreshToken, {
    csrfToken = '', clientKind, reason = 'logout', allowCsrfRecovery = false,
  } = {}) {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return false;
    // Recovery is intentionally limited to web logout. The route still requires an exact allowed
    // Origin, SameSite=Strict host-only cookie transport and a valid HMAC-bound refresh credential;
    // it only repairs a desynchronised readable CSRF cookie and can never mint/return access.
    const recover = clientKind === 'web' && allowCsrfRecovery === true;
    return revokeRefreshTx.immediate
      ? revokeRefreshTx.immediate(parsed, csrfToken, clientKind, reason, recover)
      : revokeRefreshTx(parsed, csrfToken, clientKind, reason, recover);
  }

  function logoutLegacy(rawToken, userOrId, reason = 'logout') {
    const user = userRow(userOrId);
    const tokenHash = legacyTokenKey(rawToken);
    const at = now();
    const transaction = db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO auth_legacy_token_revocations(token_hash,user_id,revoked_at,reason)
        VALUES(?,?,?,?)`).run(tokenHash, user.id, at, reason);
      db.prepare(`UPDATE auth_sessions SET revoked_at=?,revoke_reason=?
        WHERE legacy_token_hash=? AND user_id=? AND revoked_at=0`).run(at, reason, tokenHash, user.id);
    });
    transaction.immediate ? transaction.immediate() : transaction();
  }

  function purgeUser(userId) {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM auth_legacy_token_revocations WHERE user_id=?').run(userId);
    });
    transaction.immediate ? transaction.immediate() : transaction();
  }

  let lastRateCleanup = 0;
  const consumeRateTx = db.transaction((scope, keyHash, limit, windowMs, at) => {
    const row = db.prepare('SELECT * FROM auth_session_rate_limits WHERE scope=? AND key_hash=?')
      .get(scope, keyHash);
    if (!row || at - Number(row.window_started) >= windowMs) {
      db.prepare(`INSERT INTO auth_session_rate_limits(scope,key_hash,window_started,count,updated)
        VALUES(?,?,?,1,?) ON CONFLICT(scope,key_hash) DO UPDATE SET
        window_started=excluded.window_started,count=1,updated=excluded.updated`)
        .run(scope, keyHash, at, at);
      return { allowed: true, retryAfterMs: 0 };
    }
    if (Number(row.count) >= limit) {
      return { allowed: false, retryAfterMs: Math.max(1, windowMs - (at - Number(row.window_started))) };
    }
    db.prepare(`UPDATE auth_session_rate_limits SET count=count+1,updated=?
      WHERE scope=? AND key_hash=?`).run(at, scope, keyHash);
    return { allowed: true, retryAfterMs: 0 };
  });

  function checkRate(scope, subject, { limit, windowMs } = {}) {
    const normalizedScope = String(scope || '').slice(0, 64);
    // IP is only a coarse abuse backstop: mobile carrier NATs and company proxies can legitimately
    // aggregate many thousands of devices. The high-entropy per-session key below remains the
    // strict limiter, so the shared IP budget must not log out an entire carrier every 15 minutes.
    const boundedLimit = Math.max(1, Math.min(100_000, Number(limit) || 1));
    const boundedWindow = Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(windowMs) || 60 * 1000));
    const keyHash = crypto.createHmac('sha256', refreshKey)
      .update(`rate\0${normalizedScope}\0${String(subject || '')}`, 'utf8').digest('hex');
    const at = now();
    if (at - lastRateCleanup >= 60 * 60 * 1000) {
      db.prepare('DELETE FROM auth_session_rate_limits WHERE updated<?')
        .run(at - 48 * 60 * 60 * 1000);
      lastRateCleanup = at;
    }
    const result = consumeRateTx.immediate
      ? consumeRateTx.immediate(normalizedScope, keyHash, boundedLimit, boundedWindow, at)
      : consumeRateTx(normalizedScope, keyHash, boundedLimit, boundedWindow, at);
    if (!result.allowed) {
      const error = new PersistentSessionError(429, 'AUTH_RATE_LIMITED', 'Слишком много запросов. Попробуйте позже.');
      error.details = { retryAfterMs: result.retryAfterMs };
      throw error;
    }
    return result;
  }

  return {
    create,
    refresh,
    verifyAccessPayload,
    verifyLegacyToken,
    legacyTokenKey,
    preserveAfterSecurityChange,
    currentAccess,
    logoutRefreshSubject,
    logoutRefresh,
    logoutLegacy,
    purgeUser,
    checkRate,
    accessTtlSeconds,
  };
}

module.exports = {
  ACCESS_SESSION_ID_RE,
  BEARER_TRANSPORT,
  COOKIE_TRANSPORT,
  PERSISTENT_PROTOCOL,
  PersistentSessionError,
  WEB_CSRF_COOKIE,
  WEB_REFRESH_COOKIE,
  clearWebSessionCookieHeaders,
  createPersistentSessionManager,
  installPersistentSessionSchema,
  parseCookieHeader,
  parseExactHttpOrigins,
  parseRefreshToken,
  persistentSessionRateSubject,
  persistentProtocolRequested,
  transportRequest,
  webSessionCookieHeaders,
};

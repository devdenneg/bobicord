'use strict';

const crypto = require('node:crypto');

const AUTH_SUBJECT_RE = /^va1_[A-Za-z0-9_-]{22}$/u;
const VOICE_SESSION_SUBJECT_RE = /^v[0-9]+\.(va1_[A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]+$/u;
const DEFAULT_MAX_TARGETS_PER_SUBJECT = 64;
const DEFAULT_MAX_TARGETS_GLOBAL = 100_000;
const PERSISTENT_REVOKE_TRIGGER = 'trg_voice_auth_target_persistent_revoke';
const LEGACY_REVOKE_TRIGGER = 'trg_voice_auth_target_legacy_revoke';
const ACCOUNT_REVOKE_TRIGGER = 'trg_voice_auth_target_account_revoke';

class VoiceAuthRevokedError extends Error {
  constructor() {
    super('voice authorization session is no longer current');
    this.name = 'VoiceAuthRevokedError';
    this.code = 'VOICE_AUTH_REVOKED';
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function createVoiceAuthSubjectCodec(sessionSecret) {
  const secret = String(sessionSecret || '');
  if (!secret) throw new TypeError('sessionSecret is required');
  const key = crypto.createHmac('sha256', secret)
    .update('RelayApp immutable LiveKit auth subjects v1\0', 'utf8').digest();

  function subject(kind, userId, authKey) {
    const normalizedKind = String(kind || '');
    const normalizedUserId = String(userId || '');
    const normalizedKey = String(authKey || '');
    if (!['persistent', 'legacy'].includes(normalizedKind)
      || !normalizedUserId || !normalizedKey) throw new TypeError('exact voice auth subject is required');
    const proof = crypto.createHmac('sha256', key)
      .update(`${normalizedKind}\0${normalizedUserId}\0${normalizedKey}`, 'utf8')
      .digest('base64url').slice(0, 22);
    return `va1_${proof}`;
  }

  return Object.freeze({
    persistent: (userId, sessionId) => subject('persistent', userId, sessionId),
    legacy: (userId, tokenHash) => subject('legacy', userId, tokenHash),
  });
}

function createVoiceSessionId(sessionVersion, authSubject, randomBytes = crypto.randomBytes) {
  const version = Math.max(0, Math.floor(Number(sessionVersion) || 0));
  const normalizedSubject = String(authSubject || '');
  if (!AUTH_SUBJECT_RE.test(normalizedSubject)) throw new TypeError('invalid voice auth subject');
  const nonce = randomBytes(8).toString('base64url');
  return `v${version}.${normalizedSubject}.${nonce}`;
}

function voiceSessionAuthSubject(sessionId) {
  const match = VOICE_SESSION_SUBJECT_RE.exec(String(sessionId || ''));
  return match ? match[1] : '';
}

function voiceSessionMatchesSubject(sessionId, authSubject) {
  const expected = String(authSubject || '');
  const actual = voiceSessionAuthSubject(sessionId);
  if (!AUTH_SUBJECT_RE.test(expected) || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

function releaseExactVoiceLease(voiceLeases, userId, authSubject) {
  if (!voiceLeases || typeof voiceLeases.read !== 'function' || typeof voiceLeases.release !== 'function') {
    throw new TypeError('voice lease store is required');
  }
  const state = voiceLeases.read(userId);
  if (!state.lease || !voiceSessionMatchesSubject(state.lease.sessionId, authSubject)) return null;
  const previousLease = state.lease;
  const released = voiceLeases.release(userId, previousLease.sessionId, previousLease.epoch);
  return released.released ? { previousLease, released } : null;
}

function installVoiceAuthRegistrySchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('db is required');
  }
  const install = db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS voice_auth_targets(
      auth_subject TEXT NOT NULL,
      auth_kind TEXT NOT NULL CHECK(auth_kind IN ('persistent','legacy')),
      auth_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      room TEXT NOT NULL,
      identity TEXT NOT NULL,
      issued INTEGER NOT NULL,
      token_expires INTEGER NOT NULL,
      PRIMARY KEY(auth_subject,room,identity)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_auth_targets_credential
      ON voice_auth_targets(auth_kind,auth_key,issued);
    CREATE INDEX IF NOT EXISTS idx_voice_auth_targets_oldest
      ON voice_auth_targets(issued,auth_subject,room,identity);
    CREATE INDEX IF NOT EXISTS idx_voice_auth_targets_user
      ON voice_auth_targets(user_id,issued);

    DROP TRIGGER IF EXISTS ${ACCOUNT_REVOKE_TRIGGER};
    CREATE TRIGGER ${ACCOUNT_REVOKE_TRIGGER}
    AFTER UPDATE OF session_version ON users
    WHEN NEW.session_version>OLD.session_version
    BEGIN
      INSERT INTO voice_media_revocations(
        room,identity,created,attempts,next_attempt,revoke_token_ts,retry_until,auth_subject
      )
      SELECT room,identity,
        CAST(strftime('%s','now') AS INTEGER)*1000,0,0,
        CAST(strftime('%s','now') AS INTEGER)+1,
        MAX(token_expires,CAST(strftime('%s','now') AS INTEGER)*1000+1000),auth_subject
      FROM voice_auth_targets
      WHERE user_id=NEW.id
      ON CONFLICT(room,identity) DO UPDATE SET
        next_attempt=0,
        revoke_token_ts=MAX(voice_media_revocations.revoke_token_ts,excluded.revoke_token_ts),
        retry_until=MAX(voice_media_revocations.retry_until,excluded.retry_until),
        auth_subject=excluded.auth_subject;
      DELETE FROM voice_auth_targets WHERE user_id=NEW.id;
    END;

    DROP TRIGGER IF EXISTS ${PERSISTENT_REVOKE_TRIGGER};
    CREATE TRIGGER ${PERSISTENT_REVOKE_TRIGGER}
    AFTER UPDATE OF revoked_at ON auth_sessions
    WHEN OLD.revoked_at=0 AND NEW.revoked_at<>0
    BEGIN
      INSERT INTO voice_media_revocations(
        room,identity,created,attempts,next_attempt,revoke_token_ts,retry_until,auth_subject
      )
      SELECT room,identity,NEW.revoked_at,0,0,
        CAST(NEW.revoked_at / 1000 AS INTEGER) + 1,
        MAX(token_expires,NEW.revoked_at + 1000),auth_subject
      FROM voice_auth_targets
      WHERE auth_kind='persistent' AND auth_key=NEW.id
      ON CONFLICT(room,identity) DO UPDATE SET
        next_attempt=0,
        revoke_token_ts=MAX(voice_media_revocations.revoke_token_ts,excluded.revoke_token_ts),
        retry_until=MAX(voice_media_revocations.retry_until,excluded.retry_until),
        auth_subject=excluded.auth_subject;
      DELETE FROM voice_auth_targets WHERE auth_kind='persistent' AND auth_key=NEW.id;
    END;

    DROP TRIGGER IF EXISTS ${LEGACY_REVOKE_TRIGGER};
    CREATE TRIGGER ${LEGACY_REVOKE_TRIGGER}
    AFTER INSERT ON auth_legacy_token_revocations
    BEGIN
      INSERT INTO voice_media_revocations(
        room,identity,created,attempts,next_attempt,revoke_token_ts,retry_until,auth_subject
      )
      SELECT room,identity,NEW.revoked_at,0,0,
        CAST(NEW.revoked_at / 1000 AS INTEGER) + 1,
        MAX(token_expires,NEW.revoked_at + 1000),auth_subject
      FROM voice_auth_targets
      WHERE auth_kind='legacy' AND auth_key=NEW.token_hash
      ON CONFLICT(room,identity) DO UPDATE SET
        next_attempt=0,
        revoke_token_ts=MAX(voice_media_revocations.revoke_token_ts,excluded.revoke_token_ts),
        retry_until=MAX(voice_media_revocations.retry_until,excluded.retry_until),
        auth_subject=excluded.auth_subject;
      DELETE FROM voice_auth_targets WHERE auth_kind='legacy' AND auth_key=NEW.token_hash;
    END;
  `));
  if (typeof install.immediate === 'function') install.immediate();
  else install();
}

function createVoiceAuthTargetRegistry(db, revocations, options = {}) {
  if (!revocations || typeof revocations.enqueueParticipant !== 'function') {
    throw new TypeError('revocation store is required');
  }
  installVoiceAuthRegistrySchema(db);
  const maxPerSubject = boundedInteger(
    options.maxTargetsPerSubject,
    DEFAULT_MAX_TARGETS_PER_SUBJECT,
    1,
    1024,
  );
  const maxGlobal = boundedInteger(
    options.maxTargetsGlobal,
    DEFAULT_MAX_TARGETS_GLOBAL,
    maxPerSubject,
    1_000_000,
  );
  const put = db.prepare(`
    INSERT INTO voice_auth_targets(
      auth_subject,auth_kind,auth_key,user_id,room,identity,issued,token_expires
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(auth_subject,room,identity) DO UPDATE SET
      auth_kind=excluded.auth_kind,
      auth_key=excluded.auth_key,
      user_id=excluded.user_id,
      issued=MAX(voice_auth_targets.issued,excluded.issued),
      token_expires=MAX(voice_auth_targets.token_expires,excluded.token_expires)
  `);
  const overflowSubject = db.prepare(`SELECT * FROM voice_auth_targets
    WHERE auth_subject=? ORDER BY issued DESC,room DESC,identity DESC LIMIT -1 OFFSET ?`);
  const countAll = db.prepare('SELECT COUNT(*) AS count FROM voice_auth_targets');
  const overflowGlobal = db.prepare(`SELECT * FROM voice_auth_targets
    ORDER BY issued ASC,auth_subject ASC,room ASC,identity ASC LIMIT ?`);
  const remove = db.prepare(`DELETE FROM voice_auth_targets
    WHERE auth_subject=? AND room=? AND identity=?`);
  const listSubject = db.prepare(`SELECT * FROM voice_auth_targets
    WHERE auth_subject=? ORDER BY issued ASC,room ASC,identity ASC`);

  function normalizeTarget(target) {
    const authSubject = String(target && target.authSubject || '');
    const authKind = String(target && target.authKind || '');
    const authKey = String(target && target.authKey || '');
    const userId = String(target && target.userId || '');
    const room = String(target && target.room || '');
    const identity = String(target && target.identity || '');
    const issued = Math.max(0, Math.floor(Number(target && target.issued) || 0));
    const tokenExpires = Math.max(issued + 1000, Math.floor(Number(target && target.tokenExpires) || 0));
    if (!AUTH_SUBJECT_RE.test(authSubject) || !['persistent', 'legacy'].includes(authKind)
      || !authKey || authKey.length > 256 || !userId || userId.length > 128
      || !room || room.length > 512 || !identity || identity.length > 512) {
      throw new TypeError('invalid exact voice auth target');
    }
    return { authSubject, authKind, authKey, userId, room, identity, issued, tokenExpires };
  }

  function queueAndRemove(row, at) {
    revocations.enqueueParticipant(row.room, row.identity, at, {
      revokeTokenTs: Math.floor(at / 1000) + 1,
      retryUntil: Math.max(Number(row.token_expires) || 0, at + 1000),
      authSubject: row.auth_subject,
    });
    remove.run(row.auth_subject, row.room, row.identity);
  }

  const registerTx = db.transaction((rawTarget, validateCurrent) => {
    const target = normalizeTarget(rawTarget);
    if (typeof validateCurrent !== 'function' || validateCurrent() !== true) {
      throw new VoiceAuthRevokedError();
    }
    put.run(
      target.authSubject, target.authKind, target.authKey, target.userId,
      target.room, target.identity, target.issued, target.tokenExpires,
    );
    const evicted = new Set();
    for (const row of overflowSubject.all(target.authSubject, maxPerSubject)) {
      queueAndRemove(row, target.issued);
      evicted.add(`${row.auth_subject}\n${row.room}\n${row.identity}`);
    }
    const excess = Number(countAll.get().count) - maxGlobal;
    if (excess > 0) {
      for (const row of overflowGlobal.all(excess)) {
        const key = `${row.auth_subject}\n${row.room}\n${row.identity}`;
        if (evicted.has(key)) continue;
        queueAndRemove(row, target.issued);
        evicted.add(key);
      }
    }
    return { target, evicted: evicted.size };
  });

  return Object.freeze({
    register(target, validateCurrent) {
      return typeof registerTx.immediate === 'function'
        ? registerTx.immediate(target, validateCurrent)
        : registerTx(target, validateCurrent);
    },
    list(authSubject) {
      const value = String(authSubject || '');
      return AUTH_SUBJECT_RE.test(value) ? listSubject.all(value) : [];
    },
  });
}

module.exports = {
  ACCOUNT_REVOKE_TRIGGER,
  AUTH_SUBJECT_RE,
  VoiceAuthRevokedError,
  createVoiceAuthSubjectCodec,
  createVoiceSessionId,
  voiceSessionAuthSubject,
  voiceSessionMatchesSubject,
  releaseExactVoiceLease,
  installVoiceAuthRegistrySchema,
  createVoiceAuthTargetRegistry,
};

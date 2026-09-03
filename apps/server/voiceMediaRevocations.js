'use strict';

const ROOM_DELETE_IDENTITY = '';
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_USERNAME_DRAIN_TIMEOUT_MS = 3_000;
const LOGOUT_MISSING_MAX_DELAY_MS = 15_000;
const LEASE_UPDATE_TRIGGER = 'trg_voice_media_revoke_lease_update';
const LEASE_DELETE_TRIGGER = 'trg_voice_media_revoke_lease_delete';
const CHANNEL_DELETE_TRIGGER = 'trg_voice_media_revoke_channel_delete';
const MEMBERSHIP_DELETE_TRIGGER = 'trg_voice_media_revoke_membership_delete';
const AUTH_SUBJECT_RE = /^va1_[A-Za-z0-9_-]{22}$/u;

function installVoiceMediaRevocationSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function'
    || typeof db.transaction !== 'function') {
    throw new TypeError('db is required');
  }
  const install = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS voice_media_revocations(
      room TEXT NOT NULL,
      identity TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0,
      revoke_token_ts INTEGER NOT NULL DEFAULT 0,
      retry_until INTEGER NOT NULL DEFAULT 0,
      auth_subject TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(room, identity)
    )`);
    // Existing databases predate logout-to-LiveKit fencing. Both migrations are additive and the
    // trigger install below happens only after the columns are available.
    for (const sql of [
      'ALTER TABLE voice_media_revocations ADD COLUMN revoke_token_ts INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE voice_media_revocations ADD COLUMN retry_until INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE voice_media_revocations ADD COLUMN auth_subject TEXT NOT NULL DEFAULT ''",
    ]) {
      try { db.exec(sql); } catch { /** column already exists */ }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_voice_media_revocations_due
      ON voice_media_revocations(next_attempt, created);
    DROP TRIGGER IF EXISTS ${LEASE_UPDATE_TRIGGER};
    CREATE TRIGGER ${LEASE_UPDATE_TRIGGER}
    AFTER UPDATE ON voice_leases
    WHEN OLD.active=1 AND (
      NEW.active<>1 OR NEW.epoch<>OLD.epoch OR NEW.session_id<>OLD.session_id
      OR NEW.server_id<>OLD.server_id OR NEW.channel_id<>OLD.channel_id
    )
    BEGIN
      INSERT INTO voice_media_revocations(room,identity,created,attempts,next_attempt)
      SELECT
        'voice:' || OLD.server_id || ':' || OLD.channel_id,
        users.username || '#' || OLD.session_id || '~' || OLD.epoch,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        0,
        0
      FROM users WHERE users.id=OLD.user_id
      ON CONFLICT(room,identity) DO UPDATE SET next_attempt=0;
    END;

    DROP TRIGGER IF EXISTS ${LEASE_DELETE_TRIGGER};
    CREATE TRIGGER ${LEASE_DELETE_TRIGGER}
    BEFORE DELETE ON voice_leases
    WHEN OLD.active=1
    BEGIN
      INSERT INTO voice_media_revocations(room,identity,created,attempts,next_attempt)
      SELECT
        'voice:' || OLD.server_id || ':' || OLD.channel_id,
        users.username || '#' || OLD.session_id || '~' || OLD.epoch,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        0,
        0
      FROM users WHERE users.id=OLD.user_id
      ON CONFLICT(room,identity) DO UPDATE SET next_attempt=0;
    END;

    DROP TRIGGER IF EXISTS ${CHANNEL_DELETE_TRIGGER};
    CREATE TRIGGER ${CHANNEL_DELETE_TRIGGER}
    BEFORE DELETE ON voice_channels
    BEGIN
      INSERT INTO voice_media_revocations(room,identity,created,attempts,next_attempt)
      VALUES(
        'voice:' || OLD.server_id || ':' || OLD.id,
        '',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        0,
        0
      )
      ON CONFLICT(room,identity) DO UPDATE SET next_attempt=0;
    END;

    DROP TRIGGER IF EXISTS ${MEMBERSHIP_DELETE_TRIGGER};
    CREATE TRIGGER ${MEMBERSHIP_DELETE_TRIGGER}
    BEFORE DELETE ON memberships
    BEGIN
      INSERT INTO voice_media_revocations(room,identity,created,attempts,next_attempt)
      SELECT
        'voice:' || voice_leases.server_id || ':' || voice_leases.channel_id,
        users.username || '#' || voice_leases.session_id || '~' || voice_leases.epoch,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        0,
        0
      FROM voice_leases
      JOIN users ON users.id=voice_leases.user_id
      WHERE voice_leases.user_id=OLD.user_id
        AND voice_leases.server_id=OLD.server_id
        AND voice_leases.active=1
      ON CONFLICT(room,identity) DO UPDATE SET next_attempt=0;
    END;
  `);
  });
  if (typeof install.immediate === 'function') install.immediate();
  else install();
}

function normalizeScope(room, identity = ROOM_DELETE_IDENTITY) {
  const normalizedRoom = String(room || '');
  const normalizedIdentity = String(identity || '');
  if (!normalizedRoom || normalizedRoom.length > 512 || normalizedIdentity.length > 512) {
    throw new TypeError('invalid voice media revocation scope');
  }
  return { room: normalizedRoom, identity: normalizedIdentity };
}

function rowToTarget(row) {
  if (!row) return null;
  return {
    room: row.room,
    identity: row.identity,
    created: Number(row.created) || 0,
    attempts: Number(row.attempts) || 0,
    nextAttempt: Number(row.next_attempt) || 0,
    ...(Number(row.revoke_token_ts) > 0 ? { revokeTokenTs: Number(row.revoke_token_ts) } : {}),
    ...(Number(row.retry_until) > 0 ? { retryUntil: Number(row.retry_until) } : {}),
    ...(row.auth_subject ? { authSubject: row.auth_subject } : {}),
  };
}

function voiceMediaRevocationRetryAfterSeconds(nextAttempt, at = Date.now()) {
  const rawNextAttempt = Number(nextAttempt);
  const rawAt = Number(at);
  if (nextAttempt == null || !Number.isFinite(rawNextAttempt) || !Number.isFinite(rawAt)) return 1;
  const waitMs = Math.max(0, Math.floor(rawNextAttempt) - Math.max(0, Math.floor(rawAt)));
  return Math.max(1, Math.min(
    Math.ceil(DEFAULT_MAX_DELAY_MS / 1000),
    Math.ceil(waitMs / 1000),
  ));
}

function voiceMediaClosingResult(store, username, authSubject, at = Date.now()) {
  if (!store || typeof store.nextAttemptForVoiceSession !== 'function') {
    throw new TypeError('voice media revocation retry store is required');
  }
  return {
    status: 409,
    error: 'Previous voice media session is still closing',
    retryAfterSeconds: voiceMediaRevocationRetryAfterSeconds(
      store.nextAttemptForVoiceSession(username, authSubject),
      at,
    ),
  };
}

function createVoiceMediaRevocationStore(db, options = {}) {
  installVoiceMediaRevocationSchema(db);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS);
  const insert = db.prepare(`
    INSERT INTO voice_media_revocations(
      room,identity,created,attempts,next_attempt,revoke_token_ts,retry_until,auth_subject
    ) VALUES(?,?,?,0,0,?,?,?)
    ON CONFLICT(room,identity) DO UPDATE SET
      created=MIN(voice_media_revocations.created, excluded.created),
      next_attempt=0,
      revoke_token_ts=MAX(voice_media_revocations.revoke_token_ts, excluded.revoke_token_ts),
      retry_until=MAX(voice_media_revocations.retry_until, excluded.retry_until),
      auth_subject=CASE WHEN excluded.auth_subject<>'' THEN excluded.auth_subject
        ELSE voice_media_revocations.auth_subject END
  `);
  const get = db.prepare('SELECT * FROM voice_media_revocations WHERE room=? AND identity=?');
  const remove = db.prepare('DELETE FROM voice_media_revocations WHERE room=? AND identity=?');
  const updateFailure = db.prepare(`
    UPDATE voice_media_revocations SET attempts=?,next_attempt=?
    WHERE room=? AND identity=?
  `);
  const due = db.prepare(`
    SELECT * FROM voice_media_revocations
    WHERE next_attempt<=?
    ORDER BY next_attempt ASC,created ASC,room ASC,identity ASC
    LIMIT ?
  `);
  const dueUsername = db.prepare(`
    SELECT * FROM voice_media_revocations
    WHERE next_attempt<=?
      AND identity<>''
      AND instr(identity,'#')>1
      AND substr(identity,1,instr(identity,'#')-1)=?
    ORDER BY next_attempt ASC,created ASC,room ASC,identity ASC
    LIMIT ?
  `);
  const pendingUsername = db.prepare(`
    SELECT 1 FROM voice_media_revocations
    WHERE identity<>'' AND substr(identity,1,instr(identity,'#')-1)=?
    LIMIT 1
  `);
  const dueVoiceSession = db.prepare(`
    SELECT * FROM voice_media_revocations
    WHERE next_attempt<=?
      AND identity<>''
      AND instr(identity,'#')>1
      AND substr(identity,1,instr(identity,'#')-1)=?
      AND (auth_subject='' OR auth_subject=?)
    ORDER BY next_attempt ASC,created ASC,room ASC,identity ASC
    LIMIT ?
  `);
  const pendingVoiceSession = db.prepare(`
    SELECT 1 FROM voice_media_revocations
    WHERE identity<>'' AND substr(identity,1,instr(identity,'#')-1)=?
      AND (auth_subject='' OR auth_subject=?)
    LIMIT 1
  `);
  const nextVoiceSessionAttempt = db.prepare(`
    SELECT MIN(next_attempt) AS next_attempt FROM voice_media_revocations
    WHERE identity<>'' AND instr(identity,'#')>1
      AND substr(identity,1,instr(identity,'#')-1)=?
      AND (auth_subject='' OR auth_subject=?)
  `);

  function enqueue(room, identity = ROOM_DELETE_IDENTITY, now = Date.now(), options = {}) {
    const scope = normalizeScope(room, identity);
    const created = Math.max(0, Math.floor(Number(now) || 0));
    const revokeTokenTs = Math.max(0, Math.floor(Number(options.revokeTokenTs) || 0));
    const retryUntil = Math.max(0, Math.floor(Number(options.retryUntil) || 0));
    const authSubject = AUTH_SUBJECT_RE.test(String(options.authSubject || ''))
      ? String(options.authSubject) : '';
    insert.run(scope.room, scope.identity, created, revokeTokenTs, retryUntil, authSubject);
    return rowToTarget(get.get(scope.room, scope.identity));
  }

  function complete(room, identity = ROOM_DELETE_IDENTITY) {
    const scope = normalizeScope(room, identity);
    return remove.run(scope.room, scope.identity).changes > 0;
  }

  function fail(room, identity = ROOM_DELETE_IDENTITY, now = Date.now(), options = {}) {
    const scope = normalizeScope(room, identity);
    const current = rowToTarget(get.get(scope.room, scope.identity));
    if (!current) return null;
    const attempts = Math.min(1_000_000, current.attempts + 1);
    const requestedMaxDelay = Number(options.maxDelayMs);
    const failureMaxDelay = Number.isFinite(requestedMaxDelay) && requestedMaxDelay > 0
      ? Math.max(1, Math.min(maxDelayMs, Math.floor(requestedMaxDelay)))
      : maxDelayMs;
    const delay = Math.min(failureMaxDelay, baseDelayMs * (2 ** Math.min(attempts - 1, 16)));
    const nextAttempt = Math.max(0, Math.floor(Number(now) || 0)) + delay;
    updateFailure.run(attempts, nextAttempt, scope.room, scope.identity);
    return rowToTarget(get.get(scope.room, scope.identity));
  }

  function listDue(now = Date.now(), limit = 50) {
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 50)));
    return due.all(Math.max(0, Math.floor(Number(now) || 0)), boundedLimit).map(rowToTarget);
  }

  function listDueForUsername(username, at = Date.now(), limit = 50) {
    const value = String(username || '');
    if (!value) return [];
    const boundedAt = Math.max(0, Math.floor(Number(at) || 0));
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 50)));
    return dueUsername.all(boundedAt, value, boundedLimit).map(rowToTarget);
  }

  function hasPendingUsername(username) {
    const value = String(username || '');
    return !!value && !!pendingUsername.get(value);
  }

  function listDueForVoiceSession(username, authSubject, at = Date.now(), limit = 50) {
    const value = String(username || '');
    const subject = String(authSubject || '');
    if (!value || !AUTH_SUBJECT_RE.test(subject)) return [];
    const boundedAt = Math.max(0, Math.floor(Number(at) || 0));
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 50)));
    return dueVoiceSession.all(boundedAt, value, subject, boundedLimit).map(rowToTarget);
  }

  function hasPendingVoiceSession(username, authSubject) {
    const value = String(username || '');
    const subject = String(authSubject || '');
    return !!value && AUTH_SUBJECT_RE.test(subject)
      && !!pendingVoiceSession.get(value, subject);
  }

  function nextAttemptForVoiceSession(username, authSubject) {
    const value = String(username || '');
    const subject = String(authSubject || '');
    if (!value || !AUTH_SUBJECT_RE.test(subject)) return null;
    const nextAttempt = nextVoiceSessionAttempt.get(value, subject)?.next_attempt;
    if (nextAttempt == null || !Number.isFinite(Number(nextAttempt))) return null;
    return Math.max(0, Math.floor(Number(nextAttempt)));
  }

  return Object.freeze({
    enqueueParticipant: (room, identity, now, options) => enqueue(room, identity, now, options),
    enqueueRoom: (room, now) => enqueue(room, ROOM_DELETE_IDENTITY, now),
    complete,
    fail,
    listDue,
    listDueForUsername,
    hasPendingUsername,
    listDueForVoiceSession,
    hasPendingVoiceSession,
    nextAttemptForVoiceSession,
    get: (room, identity = ROOM_DELETE_IDENTITY) => {
      const scope = normalizeScope(room, identity);
      return rowToTarget(get.get(scope.room, scope.identity));
    },
  });
}

function createVoiceMediaRevocationWorker(options = {}) {
  const store = options.store;
  const removeParticipant = options.removeParticipant;
  const deleteRoom = options.deleteRoom;
  const isMissing = typeof options.isMissing === 'function' ? options.isMissing : () => false;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  if (!store || typeof store.enqueueParticipant !== 'function' || typeof store.enqueueRoom !== 'function'
    || typeof store.listDue !== 'function' || typeof store.listDueForUsername !== 'function'
    || typeof store.listDueForVoiceSession !== 'function'
    || typeof store.complete !== 'function'
    || typeof store.fail !== 'function' || typeof removeParticipant !== 'function'
    || typeof deleteRoom !== 'function') {
    throw new TypeError('voice media revocation worker dependencies are required');
  }

  const pending = new Map();
  let retryRunning = false;
  const keyOf = (target) => `${target.room}\n${target.identity}`;

  function run(target) {
    const key = keyOf(target);
    const existing = pending.get(key);
    if (existing) return existing;
    let tracked;
    tracked = Promise.resolve().then(() => target.identity === ROOM_DELETE_IDENTITY
      ? deleteRoom(target)
      : removeParticipant(target))
      .then(
        () => { store.complete(target.room, target.identity); },
        (error) => {
          if (isMissing(error)) {
            if (Number(target.retryUntil) > now()) {
              // A logout may win after a token is minted but before the response lets it connect.
              // Keep retrying a missing exact identity until that token can no longer be presented.
              store.fail(target.room, target.identity, now(), {
                maxDelayMs: LOGOUT_MISSING_MAX_DELAY_MS,
              });
              return;
            }
            store.complete(target.room, target.identity);
            return;
          }
          store.fail(target.room, target.identity, now());
          throw error;
        },
      )
      .finally(() => { if (pending.get(key) === tracked) pending.delete(key); });
    pending.set(key, tracked);
    return tracked;
  }

  function scheduleParticipant(room, identity, options = {}) {
    // Persist synchronously before Promise.then starts the external RPC.
    return run(store.enqueueParticipant(room, identity, now(), options));
  }

  function scheduleRoom(room) {
    return run(store.enqueueRoom(room, now()));
  }

  async function retryDue(at = now(), limit = 50) {
    if (retryRunning) return [];
    retryRunning = true;
    try {
      const results = await Promise.allSettled(store.listDue(at, limit).map(run));
      return results;
    } finally { retryRunning = false; }
  }

  async function retryDueForUsername(username, at = now(), limit = 50) {
    // Deliberately shares run()/pending with the global retry. A foreground activation drain and
    // the periodic worker may select the same durable row, but only one LiveKit RPC may own it.
    return Promise.allSettled(store.listDueForUsername(username, at, limit).map(run));
  }

  async function retryDueForVoiceSession(username, authSubject, at = now(), limit = 50) {
    return Promise.allSettled(store.listDueForVoiceSession(username, authSubject, at, limit).map(run));
  }

  return Object.freeze({
    run, scheduleParticipant, scheduleRoom, retryDue, retryDueForUsername, retryDueForVoiceSession,
  });
}

async function drainDueVoiceMediaRevocations(store, worker, username, options = {}) {
  if (!store || typeof store.hasPendingUsername !== 'function'
    || !worker || typeof worker.retryDueForUsername !== 'function') {
    throw new TypeError('voice media revocation drain dependencies are required');
  }
  const value = String(username || '');
  if (!value) return false;
  const authSubject = String(options.authSubject || '');
  const exactSession = AUTH_SUBJECT_RE.test(authSubject);
  if (exactSession && (typeof store.hasPendingVoiceSession !== 'function'
    || typeof worker.retryDueForVoiceSession !== 'function')) {
    throw new TypeError('voice session revocation drain dependencies are required');
  }
  const hasPending = () => exactSession
    ? store.hasPendingVoiceSession(value, authSubject)
    : store.hasPendingUsername(value);
  if (!hasPending()) return true;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Math.max(0, Number.isFinite(requestedTimeout)
    ? requestedTimeout : DEFAULT_USERNAME_DRAIN_TIMEOUT_MS);
  let timer;
  // Keep the retry rejection observed even when the deadline wins. The underlying exact removal is
  // allowed to finish and update the durable row; this request remains conservative and decides only
  // from the authoritative pending fence immediately after its bounded wait.
  const retry = Promise.resolve().then(() => {
    if (exactSession) return options.at === undefined
      ? worker.retryDueForVoiceSession(value, authSubject)
      : worker.retryDueForVoiceSession(value, authSubject, options.at);
    return options.at === undefined
      ? worker.retryDueForUsername(value)
      : worker.retryDueForUsername(value, options.at);
  });
  const observedRetry = retry.catch(() => {});
  await Promise.race([
    observedRetry,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  return !hasPending();
}

module.exports = {
  ROOM_DELETE_IDENTITY,
  DEFAULT_USERNAME_DRAIN_TIMEOUT_MS,
  LOGOUT_MISSING_MAX_DELAY_MS,
  LEASE_UPDATE_TRIGGER,
  LEASE_DELETE_TRIGGER,
  CHANNEL_DELETE_TRIGGER,
  MEMBERSHIP_DELETE_TRIGGER,
  installVoiceMediaRevocationSchema,
  createVoiceMediaRevocationStore,
  createVoiceMediaRevocationWorker,
  drainDueVoiceMediaRevocations,
  voiceMediaClosingResult,
  voiceMediaRevocationRetryAfterSeconds,
};

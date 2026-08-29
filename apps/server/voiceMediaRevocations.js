'use strict';

const ROOM_DELETE_IDENTITY = '';
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const LEASE_UPDATE_TRIGGER = 'trg_voice_media_revoke_lease_update';
const LEASE_DELETE_TRIGGER = 'trg_voice_media_revoke_lease_delete';
const CHANNEL_DELETE_TRIGGER = 'trg_voice_media_revoke_channel_delete';
const MEMBERSHIP_DELETE_TRIGGER = 'trg_voice_media_revoke_membership_delete';

function installVoiceMediaRevocationSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function'
    || typeof db.transaction !== 'function') {
    throw new TypeError('db is required');
  }
  const install = db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS voice_media_revocations(
      room TEXT NOT NULL,
      identity TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room, identity)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_media_revocations_due
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
  `));
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
  };
}

function createVoiceMediaRevocationStore(db, options = {}) {
  installVoiceMediaRevocationSchema(db);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS);
  const insert = db.prepare(`
    INSERT INTO voice_media_revocations(room,identity,created,attempts,next_attempt)
    VALUES(?,?,?,0,0)
    ON CONFLICT(room,identity) DO UPDATE SET
      created=MIN(voice_media_revocations.created, excluded.created),
      next_attempt=0
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
  const pendingUsername = db.prepare(`
    SELECT 1 FROM voice_media_revocations
    WHERE identity<>'' AND substr(identity,1,instr(identity,'#')-1)=?
    LIMIT 1
  `);

  function enqueue(room, identity = ROOM_DELETE_IDENTITY, now = Date.now()) {
    const scope = normalizeScope(room, identity);
    const created = Math.max(0, Math.floor(Number(now) || 0));
    insert.run(scope.room, scope.identity, created);
    return rowToTarget(get.get(scope.room, scope.identity));
  }

  function complete(room, identity = ROOM_DELETE_IDENTITY) {
    const scope = normalizeScope(room, identity);
    return remove.run(scope.room, scope.identity).changes > 0;
  }

  function fail(room, identity = ROOM_DELETE_IDENTITY, now = Date.now()) {
    const scope = normalizeScope(room, identity);
    const current = rowToTarget(get.get(scope.room, scope.identity));
    if (!current) return null;
    const attempts = Math.min(1_000_000, current.attempts + 1);
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempts - 1, 16)));
    const nextAttempt = Math.max(0, Math.floor(Number(now) || 0)) + delay;
    updateFailure.run(attempts, nextAttempt, scope.room, scope.identity);
    return rowToTarget(get.get(scope.room, scope.identity));
  }

  function listDue(now = Date.now(), limit = 50) {
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 50)));
    return due.all(Math.max(0, Math.floor(Number(now) || 0)), boundedLimit).map(rowToTarget);
  }

  function hasPendingUsername(username) {
    const value = String(username || '');
    return !!value && !!pendingUsername.get(value);
  }

  return Object.freeze({
    enqueueParticipant: (room, identity, now) => enqueue(room, identity, now),
    enqueueRoom: (room, now) => enqueue(room, ROOM_DELETE_IDENTITY, now),
    complete,
    fail,
    listDue,
    hasPendingUsername,
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
    || typeof store.listDue !== 'function' || typeof store.complete !== 'function'
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

  function scheduleParticipant(room, identity) {
    // Persist synchronously before Promise.then starts the external RPC.
    return run(store.enqueueParticipant(room, identity, now()));
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

  return Object.freeze({ run, scheduleParticipant, scheduleRoom, retryDue });
}

module.exports = {
  ROOM_DELETE_IDENTITY,
  LEASE_UPDATE_TRIGGER,
  LEASE_DELETE_TRIGGER,
  CHANNEL_DELETE_TRIGGER,
  MEMBERSHIP_DELETE_TRIGGER,
  installVoiceMediaRevocationSchema,
  createVoiceMediaRevocationStore,
  createVoiceMediaRevocationWorker,
};

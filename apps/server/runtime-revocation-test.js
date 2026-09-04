'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { TRIGGER_NAME, installRuntimeRevocationSchema } = require('./runtimeRevocation');

function createBaseSchema(db) {
  db.exec(`
    CREATE TABLE users(
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memberships(
      user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      PRIMARY KEY(user_id, server_id)
    );
    CREATE TABLE push_subs(
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE voice_leases(
      user_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL DEFAULT '',
      server_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      claimed_at INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE voice_session_intents(
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      intent INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY(user_id, session_id)
    );
    CREATE TABLE voice_user_intents(
      user_id TEXT PRIMARY KEY,
      ticket INTEGER NOT NULL
    );
  `);
}

function seedRuntimeState(db, options = {}) {
  const userId = options.userId || 'u1';
  const username = options.username || 'denis';
  const sessionVersion = options.sessionVersion || 0;
  db.prepare('INSERT INTO users(id,username,session_version) VALUES(?,?,?)')
    .run(userId, username, sessionVersion);
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run(userId, 's1');
  db.prepare('INSERT INTO push_subs(endpoint,user_id) VALUES(?,?)').run('https://push/1', userId);
  db.prepare(`INSERT INTO voice_leases(
    user_id,epoch,session_id,server_id,channel_id,claimed_at,active
  ) VALUES(?,?,?,?,?,?,1)`).run(userId, 7, 'voice-session', 's1', 'c1', 1234);
  db.prepare('INSERT INTO voice_session_intents(user_id,session_id,intent,updated) VALUES(?,?,?,?)')
    .run(userId, 'voice-session', 4, 1234);
  db.prepare('INSERT INTO voice_user_intents(user_id,ticket) VALUES(?,?)').run(userId, 9);
}

function readRuntimeState(db, userId = 'u1') {
  return {
    revoke: db.prepare('SELECT * FROM auth_runtime_revocations WHERE user_id=?').get(userId),
    rooms: db.prepare(`SELECT server_id,revoked_before_version
      FROM auth_runtime_revocation_rooms WHERE user_id=? ORDER BY server_id`).all(userId),
    pushCount: db.prepare('SELECT COUNT(*) AS count FROM push_subs WHERE user_id=?').get(userId).count,
    lease: db.prepare('SELECT * FROM voice_leases WHERE user_id=?').get(userId),
    sessionIntentCount: db.prepare('SELECT COUNT(*) AS count FROM voice_session_intents WHERE user_id=?')
      .get(userId).count,
    userIntentCount: db.prepare('SELECT COUNT(*) AS count FROM voice_user_intents WHERE user_id=?')
      .get(userId).count,
  };
}

test('rollback removes the outbox mutation and restores push and voice state', () => {
  const db = new Database(':memory:');
  createBaseSchema(db);
  seedRuntimeState(db);
  installRuntimeRevocationSchema(db);

  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run('u1');
  const during = readRuntimeState(db);
  assert.equal(during.revoke.revoked_before_version, 1);
  assert.deepEqual(during.rooms, [{ server_id: 's1', revoked_before_version: 1 }]);
  assert.equal(during.pushCount, 0);
  assert.equal(during.lease.active, 0);
  assert.equal(during.lease.epoch, 8);
  assert.equal(during.sessionIntentCount, 0);
  assert.equal(during.userIntentCount, 0);
  db.exec('ROLLBACK');

  const after = readRuntimeState(db);
  assert.equal(after.revoke, undefined);
  assert.deepEqual(after.rooms, []);
  assert.equal(after.pushCount, 1);
  assert.equal(after.lease.active, 1);
  assert.equal(after.lease.epoch, 7);
  assert.equal(after.lease.session_id, 'voice-session');
  assert.equal(after.sessionIntentCount, 1);
  assert.equal(after.userIntentCount, 1);
  assert.equal(db.prepare('SELECT session_version FROM users WHERE id=?').get('u1').session_version, 0);
  db.close();
});

test('committed target survives close, reopen and later membership deletion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-revoke-'));
  const filename = path.join(directory, 'voice.db');
  try {
    let db = new Database(filename);
    createBaseSchema(db);
    seedRuntimeState(db);
    installRuntimeRevocationSchema(db);
    db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run('u1');
    db.prepare('DELETE FROM memberships WHERE user_id=? AND server_id=?').run('u1', 's1');
    db.close();

    db = new Database(filename, { readonly: true });
    const state = readRuntimeState(db);
    assert.equal(state.revoke.username, 'denis');
    assert.equal(state.revoke.revoked_before_version, 1);
    assert.deepEqual(state.rooms, [{ server_id: 's1', revoked_before_version: 1 }]);
    assert.equal(state.pushCount, 0);
    assert.deepEqual(
      {
        epoch: state.lease.epoch,
        session_id: state.lease.session_id,
        server_id: state.lease.server_id,
        channel_id: state.lease.channel_id,
        claimed_at: state.lease.claimed_at,
        active: state.lease.active,
      },
      { epoch: 8, session_id: '', server_id: '', channel_id: '', claimed_at: 0, active: 0 },
    );
    assert.equal(state.sessionIntentCount, 0);
    assert.equal(state.userIntentCount, 0);
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('overlapping bumps raise cutoffs and retain every exact room target', () => {
  const db = new Database(':memory:');
  createBaseSchema(db);
  seedRuntimeState(db);
  installRuntimeRevocationSchema(db);

  db.prepare('UPDATE users SET session_version=1 WHERE id=?').run('u1');
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's2');
  db.prepare('UPDATE users SET username=?,session_version=2 WHERE id=?').run('denis-new', 'u1');
  assert.equal(db.prepare('SELECT revoked_before_version FROM auth_runtime_revocations WHERE user_id=?')
    .get('u1').revoked_before_version, 2);
  assert.deepEqual(readRuntimeState(db).rooms, [
    { server_id: 's1', revoked_before_version: 2 },
    { server_id: 's2', revoked_before_version: 2 },
  ]);

  db.prepare('DELETE FROM memberships WHERE user_id=? AND server_id=?').run('u1', 's1');
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's3');
  db.prepare('UPDATE users SET session_version=3 WHERE id=?').run('u1');
  const state = readRuntimeState(db);
  assert.equal(state.revoke.username, 'denis-new');
  assert.equal(state.revoke.revoked_before_version, 3);
  assert.equal(state.revoke.attempts, 0);
  assert.equal(state.revoke.next_attempt, 0);
  assert.deepEqual(state.rooms, [
    { server_id: 's1', revoked_before_version: 2 },
    { server_id: 's2', revoked_before_version: 3 },
    { server_id: 's3', revoked_before_version: 3 },
  ]);
  db.close();
});

test('legacy outbox migration adds and backfills cutoffs idempotently', () => {
  const db = new Database(':memory:');
  createBaseSchema(db);
  seedRuntimeState(db, { sessionVersion: 7 });
  db.exec(`
    CREATE TABLE auth_runtime_revocations(
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      reason TEXT NOT NULL,
      created INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE auth_runtime_revocation_rooms(
      user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      PRIMARY KEY(user_id, server_id)
    );
  `);
  db.prepare(`INSERT INTO auth_runtime_revocations(
    user_id,username,reason,created,attempts,next_attempt
  ) VALUES(?,?,?,?,?,?)`).run('u1', 'denis', 'legacy', 100, 2, 200);
  db.prepare('INSERT INTO auth_runtime_revocation_rooms(user_id,server_id) VALUES(?,?)').run('u1', 's1');

  installRuntimeRevocationSchema(db);
  installRuntimeRevocationSchema(db);

  assert.equal(tableColumnCount(db, 'auth_runtime_revocations', 'revoked_before_version'), 1);
  assert.equal(tableColumnCount(db, 'auth_runtime_revocation_rooms', 'revoked_before_version'), 1);
  assert.equal(db.prepare('SELECT revoked_before_version FROM auth_runtime_revocations WHERE user_id=?')
    .get('u1').revoked_before_version, 7);
  assert.equal(db.prepare(`SELECT revoked_before_version FROM auth_runtime_revocation_rooms
    WHERE user_id=? AND server_id=?`).get('u1', 's1').revoked_before_version, 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name=?")
    .get(TRIGGER_NAME).count, 1);

  db.prepare('UPDATE users SET session_version=8 WHERE id=?').run('u1');
  assert.equal(db.prepare('SELECT revoked_before_version FROM auth_runtime_revocations WHERE user_id=?')
    .get('u1').revoked_before_version, 8);
  db.close();
});

function tableColumnCount(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().filter((item) => item.name === column).length;
}

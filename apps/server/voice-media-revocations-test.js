'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  createVoiceMediaRevocationStore,
  createVoiceMediaRevocationWorker,
} = require('./voiceMediaRevocations');

function createVoiceSchema(db) {
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL);
    CREATE TABLE memberships(
      user_id TEXT NOT NULL,server_id TEXT NOT NULL,
      PRIMARY KEY(user_id,server_id)
    );
    CREATE TABLE voice_channels(
      id TEXT PRIMARY KEY,server_id TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL DEFAULT 0
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
  `);
}

test('lease mutation snapshots the old exact participant in the same transaction', () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run('u1', 'alice');
  db.prepare('INSERT INTO voice_channels(id,server_id) VALUES(?,?)').run('c1', 's1');
  db.prepare(`INSERT INTO voice_leases(
    user_id,epoch,session_id,server_id,channel_id,claimed_at,active
  ) VALUES(?,?,?,?,?,?,1)`).run('u1', 7, 'v2.old', 's1', 'c1', 1);
  const outbox = createVoiceMediaRevocationStore(db);

  db.exec('BEGIN IMMEDIATE');
  db.prepare(`UPDATE voice_leases SET
    epoch=8,session_id='v2.new',server_id='s1',channel_id='c1',active=1
    WHERE user_id='u1'`).run();
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.old~7'));
  db.exec('ROLLBACK');

  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7'), null);
  assert.equal(db.prepare('SELECT epoch FROM voice_leases WHERE user_id=?').get('u1').epoch, 7);

  db.prepare(`UPDATE voice_leases SET
    session_id='',server_id='',channel_id='',claimed_at=0,active=0
    WHERE user_id='u1'`).run();
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.old~7'));
  db.close();
});

test('deleting an active lease snapshots its participant before the row disappears', () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run('u1', 'alice');
  db.prepare(`INSERT INTO voice_leases(
    user_id,epoch,session_id,server_id,channel_id,claimed_at,active
  ) VALUES(?,?,?,?,?,?,1)`).run('u1', 7, 'v2.old', 's1', 'c1', 1);
  const outbox = createVoiceMediaRevocationStore(db);

  db.prepare('DELETE FROM voice_leases WHERE user_id=?').run('u1');
  assert.equal(db.prepare('SELECT 1 FROM voice_leases WHERE user_id=?').get('u1'), undefined);
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.old~7'));
  db.close();
});

test('membership removal snapshots the active participant before kick or leave commits', () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run('u1', 'alice');
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  db.prepare(`INSERT INTO voice_leases(
    user_id,epoch,session_id,server_id,channel_id,claimed_at,active
  ) VALUES(?,?,?,?,?,?,1)`).run('u1', 7, 'v2.old', 's1', 'c1', 1);
  const outbox = createVoiceMediaRevocationStore(db);

  db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM memberships WHERE user_id=? AND server_id=?').run('u1', 's1');
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.old~7'));
  db.exec('COMMIT');

  assert.equal(db.prepare('SELECT 1 FROM memberships WHERE user_id=?').get('u1'), undefined);
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.old~7'));
  db.close();
});

test('channel deletion leaves a durable room target after the source row is gone', () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  db.prepare('INSERT INTO voice_channels(id,server_id) VALUES(?,?)').run('c1', 's1');
  db.prepare('DELETE FROM voice_channels WHERE id=?').run('c1');

  assert.equal(db.prepare('SELECT 1 FROM voice_channels WHERE id=?').get('c1'), undefined);
  assert.deepEqual(outbox.get('voice:s1:c1'), {
    room: 'voice:s1:c1', identity: '', created: outbox.get('voice:s1:c1').created,
    attempts: 0, nextAttempt: 0,
  });
  db.close();
});

test('failed RPC target survives restart and becomes due after backoff', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-voice-media-revoke-'));
  const filename = path.join(directory, 'voice.db');
  try {
    let db = new Database(filename);
    createVoiceSchema(db);
    let outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
    outbox.enqueueParticipant('voice:s1:c1', 'alice#v2.old~7', 1_000);
    const failed = outbox.fail('voice:s1:c1', 'alice#v2.old~7', 1_000);
    assert.equal(failed.attempts, 1);
    assert.equal(failed.nextAttempt, 1_100);
    assert.deepEqual(outbox.listDue(1_099), []);
    db.close();

    db = new Database(filename);
    outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
    assert.equal(outbox.listDue(1_100).length, 1);
    assert.equal(outbox.complete('voice:s1:c1', 'alice#v2.old~7'), true);
    assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7'), null);
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('old and new epoch targets cannot delete or unblock each other', () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  outbox.enqueueParticipant('voice:s1:c1', 'alice#v2.same~7', 100);
  outbox.enqueueParticipant('voice:s1:c1', 'alice#v2.same~8', 101);
  outbox.enqueueRoom('voice:s1:deleted', 102);

  assert.equal(outbox.hasPendingUsername('alice'), true);
  outbox.complete('voice:s1:c1', 'alice#v2.same~7');
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.same~8'));
  assert.ok(outbox.get('voice:s1:deleted'));
  assert.equal(outbox.hasPendingUsername('alice'), true);
  outbox.complete('voice:s1:c1', 'alice#v2.same~8');
  assert.equal(outbox.hasPendingUsername('alice'), false);
  db.close();
});

test('worker persists before RPC, retains transient failures and retries to success', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
  let clock = 1_000;
  let calls = 0;
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => clock,
    removeParticipant: async (target) => {
      calls += 1;
      assert.ok(outbox.get(target.room, target.identity), 'target must exist before RPC');
      if (calls === 1) throw new Error('temporary LiveKit outage');
    },
    deleteRoom: async () => {},
  });

  const first = worker.scheduleParticipant('voice:s1:c1', 'alice#v2.old~7');
  assert.ok(outbox.get('voice:s1:c1', 'alice#v2.old~7'));
  await assert.rejects(first, /temporary LiveKit outage/u);
  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7').nextAttempt, 1_100);

  clock = 1_100;
  const retried = await worker.retryDue();
  assert.equal(retried[0].status, 'fulfilled');
  assert.equal(calls, 2);
  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7'), null);
  db.close();
});

test('worker completes missing participants and executes durable room targets', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  const deletedRooms = [];
  const missing = Object.assign(new Error('participant not found'), { statusCode: 404 });
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    removeParticipant: async () => { throw missing; },
    deleteRoom: async ({ room }) => { deletedRooms.push(room); },
    isMissing: (error) => error?.statusCode === 404,
  });

  await worker.scheduleParticipant('voice:s1:c1', 'alice#v2.old~7');
  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7'), null);
  await worker.scheduleRoom('voice:s1:deleted');
  assert.deepEqual(deletedRooms, ['voice:s1:deleted']);
  assert.equal(outbox.get('voice:s1:deleted'), null);
  db.close();
});

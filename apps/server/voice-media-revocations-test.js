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
  drainDueVoiceMediaRevocations,
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

test('per-username due listing filters exact user, due time and participant targets', () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
  outbox.enqueueParticipant('voice:s1:a', 'alice#v2.old~7', 100);
  outbox.enqueueParticipant('voice:s1:b', 'alice2#v2.other~3', 101);
  outbox.enqueueParticipant('voice:s1:c', 'bob#v2.other~4', 102);
  outbox.enqueueParticipant('voice:s1:d', 'alice#v2.future~8', 103);
  outbox.enqueueRoom('voice:s1:deleted', 104);
  outbox.fail('voice:s1:d', 'alice#v2.future~8', 1_000);

  assert.deepEqual(outbox.listDueForUsername('alice', 1_099).map((target) => target.identity), [
    'alice#v2.old~7',
  ]);
  assert.deepEqual(outbox.listDueForUsername('alice', 1_100).map((target) => target.identity), [
    'alice#v2.old~7',
    'alice#v2.future~8',
  ]);
  assert.deepEqual(outbox.listDueForUsername('alice2', 1_100).map((target) => target.identity), [
    'alice2#v2.other~3',
  ]);
  assert.deepEqual(outbox.listDueForUsername('nobody', 1_100), []);
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

test('per-username retry respects transient backoff and retries when the target becomes due', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
  let clock = 1_000;
  let calls = 0;
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => clock,
    removeParticipant: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary LiveKit outage');
    },
    deleteRoom: async () => {},
  });

  await assert.rejects(
    worker.scheduleParticipant('voice:s1:c1', 'alice#v2.old~7'),
    /temporary LiveKit outage/u,
  );
  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7').nextAttempt, 1_100);
  assert.deepEqual(await worker.retryDueForUsername('alice', 1_099), []);
  assert.equal(calls, 1, 'a foreground drain must not bypass durable backoff');

  clock = 1_100;
  const retried = await worker.retryDueForUsername('alice');
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, 'fulfilled');
  assert.equal(calls, 2);
  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7'), null);
  db.close();
});

test('first join stays fail-closed until the default revocation backoff is due', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  let clock = 0;
  const removed = [];
  const deletedRooms = [];
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => clock,
    removeParticipant: async (target) => {
      removed.push(`${target.room}\n${target.identity}`);
      if (target.identity === 'alice#v2.stale~7' && removed.length === 1) {
        throw new Error('temporary LiveKit outage');
      }
    },
    deleteRoom: async (target) => { deletedRooms.push(target.room); },
  });

  await assert.rejects(
    worker.scheduleParticipant('voice:s1:old', 'alice#v2.stale~7'),
    /temporary LiveKit outage/u,
  );
  outbox.enqueueParticipant('voice:s2:foreign', 'bob#v2.other~4', clock);
  outbox.enqueueRoom('voice:s3:deleted', clock);
  const stale = outbox.get('voice:s1:old', 'alice#v2.stale~7');
  assert.equal(stale.nextAttempt, 5_000, 'production base backoff must remain five seconds');

  const transactionDeadline = 10_000;
  for (const at of [0, 4_999]) {
    clock = at;
    assert.equal(await drainDueVoiceMediaRevocations(outbox, worker, 'alice', {
      at: clock,
      timeoutMs: 50,
    }), false, 'activation must remain fail-closed before the exact row becomes due');
    assert.equal(removed.length, 1, 'foreground activation must not bypass durable backoff');
  }

  clock = 5_000;
  assert.equal(await drainDueVoiceMediaRevocations(outbox, worker, 'alice', {
    at: clock,
    timeoutMs: 50,
  }), true, 'the due exact removal must unblock the same activation transaction');
  assert.ok(clock < transactionDeadline, 'the base retry must fit inside the ten-second transaction budget');
  assert.deepEqual(removed, [
    'voice:s1:old\nalice#v2.stale~7',
    'voice:s1:old\nalice#v2.stale~7',
  ]);
  assert.equal(outbox.get('voice:s1:old', 'alice#v2.stale~7'), null);
  assert.ok(outbox.get('voice:s2:foreign', 'bob#v2.other~4'), 'another user must not be drained');
  assert.ok(outbox.get('voice:s3:deleted'), 'room deletion must stay with the global worker');
  assert.deepEqual(deletedRooms, []);
  db.close();
});

test('production foreground drain times out fail-closed when its worker is hung', { timeout: 250 }, async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  outbox.enqueueParticipant('voice:s1:old', 'alice#v2.stale~7', 0);
  const hungWorker = { retryDueForUsername: () => new Promise(() => {}) };

  assert.equal(await drainDueVoiceMediaRevocations(outbox, hungWorker, 'alice', {
    at: 0,
    timeoutMs: 5,
  }), false);
  assert.ok(outbox.get('voice:s1:old', 'alice#v2.stale~7'));
  db.close();
});

test('global and per-username retries share one in-flight removal', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  outbox.enqueueParticipant('voice:s1:c1', 'alice#v2.old~7', 1_000);
  const removal = deferred();
  let calls = 0;
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => 1_000,
    removeParticipant: async () => { calls += 1; await removal.promise; },
    deleteRoom: async () => {},
  });

  const globalRetry = worker.retryDue(1_000);
  const usernameRetry = worker.retryDueForUsername('alice', 1_000);
  await Promise.resolve();
  assert.equal(calls, 1, 'both drains must reuse the shared pending owner');
  removal.resolve();
  const [globalResults, usernameResults] = await Promise.all([globalRetry, usernameRetry]);
  assert.equal(globalResults[0].status, 'fulfilled');
  assert.equal(usernameResults[0].status, 'fulfilled');
  assert.equal(calls, 1);
  assert.equal(outbox.get('voice:s1:c1', 'alice#v2.old~7'), null);
  db.close();
});

test('activation route uses the production drain before a bounded LiveKit permission grant', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/api/voice/media/activate'");
  const routeEnd = source.indexOf('\n});', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'voice media activation route must exist');
  const route = source.slice(routeStart, routeEnd + 4);
  const firstDrain = route.indexOf('drainDueVoiceMediaRevocations(');
  const secondDrain = route.indexOf('drainDueVoiceMediaRevocations(', firstDrain + 1);
  const activation = route.indexOf('activateVoiceMediaParticipant(rsc, room, identity)');
  const finalPendingFence = route.indexOf('voiceMediaRevocations.hasPendingVoiceSession(req.user.username, voiceAuth.authSubject)');
  assert.ok(firstDrain >= 0 && secondDrain > firstDrain && activation > secondDrain,
    'both preflight pending guards must actively drain due rows before granting permissions');
  assert.match(
    route,
    /drainDueVoiceMediaRevocations\(\s*voiceMediaRevocations,\s*voiceMediaRevocationWorker,\s*req\.user\.username,\s*\{ timeoutMs: VOICE_MEDIA_DRAIN_TIMEOUT_MS, authSubject: voiceAuth\.authSubject \},/u,
    'the route must execute the bounded exact-auth-session drain helper',
  );
  assert.ok(finalPendingFence > activation,
    'authorization changes during the permission RPC must remain fail-closed');
  assert.match(
    route,
    /await withTimeout\(\s*activateVoiceMediaParticipant\(rsc, room, identity\),\s*VOICE_MEDIA_RPC_TIMEOUT_MS,/u,
    'LiveKit UpdateParticipant must not hold the per-user claim queue without a deadline',
  );
});

test('pending logout of one device does not fence another device of the same account', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db);
  const subjectA = `va1_${'a'.repeat(22)}`;
  const subjectB = `va1_${'b'.repeat(22)}`;
  outbox.enqueueParticipant('srv:s1', 'alice#device-a', 1_000, { authSubject: subjectA });

  assert.equal(outbox.hasPendingVoiceSession('alice', subjectA), true);
  assert.equal(outbox.hasPendingVoiceSession('alice', subjectB), false,
    'exact A logout must not block B activation while LiveKit A removal retries');

  const removed = [];
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => 1_000,
    removeParticipant: async (target) => { removed.push(target.identity); },
    deleteRoom: async () => {},
  });
  assert.equal(await drainDueVoiceMediaRevocations(outbox, worker, 'alice', {
    at: 1_000,
    timeoutMs: 50,
    authSubject: subjectB,
  }), true);
  assert.deepEqual(removed, []);
  assert.ok(outbox.get('srv:s1', 'alice#device-a'));

  outbox.enqueueParticipant('srv:s2', 'alice#legacy-unknown', 1_000);
  assert.equal(outbox.hasPendingVoiceSession('alice', subjectB), true,
    'unattributed rollout targets remain conservatively account-wide');
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

test('logout target keeps its fixed token cutoff and retries a pre-connect missing participant', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
  const missing = Object.assign(new Error('participant not found'), { statusCode: 404 });
  let clock = 2_000;
  let calls = 0;
  const seen = [];
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => clock,
    removeParticipant: async (target) => {
      calls += 1;
      seen.push({ revokeTokenTs: target.revokeTokenTs, retryUntil: target.retryUntil });
      if (calls === 1) throw missing;
    },
    deleteRoom: async () => {},
    isMissing: (error) => error?.statusCode === 404,
  });

  await worker.scheduleParticipant('srv:s1', 'alice#exact-device', {
    revokeTokenTs: 3,
    retryUntil: 5_000,
  });
  assert.deepEqual(seen, [{ revokeTokenTs: 3, retryUntil: 5_000 }]);
  assert.equal(outbox.get('srv:s1', 'alice#exact-device').nextAttempt, 2_100,
    'missing before token expiry remains durable for a late connection');

  clock = 2_100;
  await worker.retryDue();
  assert.deepEqual(seen[1], { revokeTokenTs: 3, retryUntil: 5_000 },
    'retry uses logout cutoff, not a moving timestamp that could target another generation');
  assert.equal(outbox.get('srv:s1', 'alice#exact-device'), null);
  db.close();
});

test('missing logout target completes only after its undelivered token has expired', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db, { baseDelayMs: 100, maxDelayMs: 800 });
  const missing = Object.assign(new Error('participant not found'), { statusCode: 404 });
  let clock = 2_000;
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => clock,
    removeParticipant: async () => { throw missing; },
    deleteRoom: async () => {},
    isMissing: (error) => error?.statusCode === 404,
  });

  await worker.scheduleParticipant('srv:s1', 'alice#never-connected', {
    revokeTokenTs: 3,
    retryUntil: 2_050,
  });
  assert.ok(outbox.get('srv:s1', 'alice#never-connected'));
  clock = 2_100;
  await worker.retryDue();
  assert.equal(outbox.get('srv:s1', 'alice#never-connected'), null);
  db.close();
});

test('a missing pre-connect logout target never backs off beyond the bounded retry cadence', async () => {
  const db = new Database(':memory:');
  createVoiceSchema(db);
  const outbox = createVoiceMediaRevocationStore(db, {
    baseDelayMs: 5_000,
    maxDelayMs: 5 * 60_000,
  });
  let clock = 1_000;
  const missing = Object.assign(new Error('participant not found'), { statusCode: 404 });
  const worker = createVoiceMediaRevocationWorker({
    store: outbox,
    now: () => clock,
    removeParticipant: async () => { throw missing; },
    deleteRoom: async () => {},
    isMissing: error => error === missing,
  });
  outbox.enqueueParticipant('srv:s1', 'alice#late-device', clock, {
    revokeTokenTs: 2,
    retryUntil: 10 * 60_000,
    authSubject: 'va1_1234567890123456789012',
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    await worker.retryDue(clock);
    const pending = outbox.get('srv:s1', 'alice#late-device');
    assert.ok(pending.nextAttempt - clock <= 15_000,
      'a token that may still connect must be fenced again within fifteen seconds');
    clock = pending.nextAttempt;
  }
  db.close();
});

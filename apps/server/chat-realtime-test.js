'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  admitBoundedNotifySocket,
  canonicalReactionIdentity,
  chatClearedEvent,
  chatReadyEvent,
  chatResyncEvent,
  createChatRateLimiter,
  createChatRealtimeFanout,
  createChatRevisionStore,
  createNotifyInboundGuard,
  cleanupInvalidLegacyReactions,
  hasAllMention,
  messageCreatedEvent,
  messageDeletedEvent,
  messageUpdatedEvent,
  reactionsUpdatedEvent,
  sanitizeMessageEmotes,
  sendBoundedNotifyFrames,
} = require('./chatRealtime');

function canonicalMessage(overrides = {}) {
  return {
    id: 7,
    uid: 'u_alice',
    name: 'Alice',
    color: 0x123456,
    text: 'hello',
    em: { Wave: '01H_abc-123', Broken: 42 },
    img: '',
    files: [],
    ts: 1_700_000_000_000,
    edited: false,
    mkey: 'client-7',
    injected: 'must not leave the server',
    ...overrides,
  };
}

test('strict canonical builders expose version, revision and only bounded server fields', () => {
  const created = messageCreatedEvent('srv_1', 9, canonicalMessage({
    files: [{ url: '/api/files/test.bin', name: 'test.bin', size: 1.5, mime: 'application/octet-stream', kind: 'file' }],
  }), 'client-7');
  assert.equal(created.t, 'chat-event');
  assert.equal(created.v, 1);
  assert.equal(created.serverId, 'srv_1');
  assert.equal(created.rev, 9);
  assert.equal(created.event.type, 'message.created');
  assert.equal(created.event.mkey, 'client-7');
  assert.equal(created.event.message.mkey, 'client-7');
  assert.deepEqual(created.event.message.em, { Wave: '01H_abc-123' });
  assert.equal(created.event.message.files[0].size, 2,
    'fractional REST input is normalized to the integer realtime contract');
  assert.equal(Number.isSafeInteger(created.event.message.files[0].size), true);
  assert.equal('injected' in created.event.message, false);

  assert.deepEqual(messageUpdatedEvent('srv_1', 10, 7, 'edited').event,
    { type: 'message.updated', messageId: 7, text: 'edited', edited: true });
  assert.deepEqual(messageDeletedEvent('srv_1', 11, 7).event,
    { type: 'message.deleted', messageId: 7 });
  assert.deepEqual(chatClearedEvent('srv_1', 12).event, { type: 'chat.cleared' });
  assert.deepEqual(chatReadyEvent(), { t: 'chat-ready', v: 1 });
  assert.deepEqual(chatResyncEvent('srv_1', 'reconnect'),
    { t: 'chat-resync', v: 1, serverId: 'srv_1', reason: 'reconnect' });

  assert.equal(messageCreatedEvent('srv_1', 0, canonicalMessage(), 'x'), null, 'revision zero is never an incremental');
  assert.equal(messageCreatedEvent('srv_1', 1, canonicalMessage(), 'x', 100), null,
    'oversized canonical state becomes resync rather than a partial frame');
});

test('reaction snapshots are exact per recipient and strictly bounded', () => {
  const mine = reactionsUpdatedEvent('srv_1', 3, 7, [
    { id: 'em_1', name: 'Wave', count: 2, mine: true },
  ]);
  const other = reactionsUpdatedEvent('srv_1', 3, 7, [
    { id: 'em_1', name: 'Wave', count: 2, mine: false },
  ]);
  assert.equal(mine.event.reactions[0].mine, true);
  assert.equal(other.event.reactions[0].mine, false);
  assert.equal(reactionsUpdatedEvent('srv_1', 3, 7, [{ id: 'em', name: 'x', count: 1001, mine: false }]), null);
  assert.deepEqual(canonicalReactionIdentity('abc_123', 'Wave'), { id: 'abc_123', name: 'Wave' });
  assert.equal(canonicalReactionIdentity(' abc_123 ', 'Wave'), null, 'padded ids are rejected, never trimmed into a different DB key');
  assert.equal(reactionsUpdatedEvent('srv_1', 3, 7, [
    { id: ' abc_123 ', name: 'Wave', count: 1, mine: true },
  ]), null, 'event serialization cannot transform a persisted identity');
});

test('padded reaction ids are rejected identically for add and remove before persistence', () => {
  for (const add of [true, false]) {
    const body = { emoteId: ' abc_123 ', emoteName: 'Wave', add };
    assert.equal(canonicalReactionIdentity(body.emoteId, body.emoteName), null);
  }
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const start = source.indexOf("app.post('/api/servers/:id/messages/:mid/react'");
  const end = source.indexOf("app.patch('/api/servers/:id/messages/:mid'", start);
  const route = source.slice(start, end);
  assert.ok(route.indexOf("typeof req.body.add !== 'boolean'") < route.indexOf('const mutateReaction'));
  assert.ok(route.indexOf('canonicalReactionIdentity(req.body.emoteId, req.body.emoteName)')
    < route.indexOf('const mutateReaction'));
  assert.doesNotMatch(route, /emoteId[^\n]+\.trim\(/u);
  assert.match(route, /changed: mutation\.changes > 0/u);
});

test('startup cleanup removes predeploy invalid reaction identities and advances revision', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE reactions(
    server_id TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    emote_id TEXT NOT NULL,
    emote_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL
  )`);
  db.prepare('INSERT INTO reactions VALUES(?,?,?,?,?,?)').run('srv_1', 1, 'valid_id', 'Wave', 'alice', 1);
  db.prepare('INSERT INTO reactions VALUES(?,?,?,?,?,?)').run('srv_1', 1, ' padded ', 'Wave', 'bob', 2);
  const revisions = createChatRevisionStore(db);
  const cleaned = cleanupInvalidLegacyReactions(db, revisions, { batchSize: 1 });
  assert.equal(cleaned.removed, 1);
  assert.deepEqual(cleaned.revisedServers, ['srv_1']);
  assert.equal(revisions.current('srv_1'), 1);
  assert.deepEqual(db.prepare('SELECT emote_id FROM reactions').all(), [{ emote_id: 'valid_id' }]);
  db.close();
});

test('message emote maps accept only bounded string-to-string identifiers', () => {
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`name${index}`, `id_${index}`]));
  const sanitized = sanitizeMessageEmotes({ ok: 'id_1', number: 7, ['bad\nname']: 'id_2', ...many });
  assert.equal(sanitized.ok, 'id_1');
  assert.equal('number' in sanitized, false);
  assert.equal('bad\nname' in sanitized, false);
  assert.ok(Object.keys(sanitized).length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized), 'utf8') <= 4000);
});

test('revision bump participates in the caller SQLite transaction', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY)');
  const revisions = createChatRevisionStore(db);
  assert.equal(revisions.current('srv_1'), 0);

  const commit = db.transaction(() => {
    db.prepare('INSERT INTO items(id) VALUES(1)').run();
    return revisions.bump('srv_1');
  });
  assert.equal(commit(), 1);
  assert.equal(revisions.current('srv_1'), 1);

  const rollback = db.transaction(() => {
    db.prepare('INSERT INTO items(id) VALUES(2)').run();
    revisions.bump('srv_1');
    throw new Error('rollback');
  });
  assert.throws(() => rollback(), /rollback/);
  assert.equal(revisions.current('srv_1'), 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM items').get().count, 1);
  db.close();
});

test('revision migration and clear watermark are atomic and monotonic', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE chat_revisions(
    server_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare('INSERT INTO chat_revisions(server_id,revision) VALUES(?,?)').run('legacy', 4);
  const revisions = createChatRevisionStore(db);
  assert.ok(db.prepare('PRAGMA table_info(chat_revisions)').all()
    .some((column) => column.name === 'last_clear_revision'));
  assert.deepEqual(revisions.snapshot('legacy'), { revision: 4, lastClearRevision: 0 });
  assert.equal(revisions.currentClear('legacy'), 0);

  assert.equal(revisions.bump('legacy'), 5);
  assert.deepEqual(revisions.snapshot('legacy'), { revision: 5, lastClearRevision: 0 });
  assert.equal(revisions.bump('legacy', { clear: true }), 6);
  assert.deepEqual(revisions.snapshot('legacy'), { revision: 6, lastClearRevision: 6 });
  assert.equal(revisions.bump('legacy'), 7);
  assert.deepEqual(revisions.snapshot('legacy'), { revision: 7, lastClearRevision: 6 });

  const rollback = db.transaction(() => {
    revisions.bump('legacy', { clear: true });
    assert.deepEqual(revisions.snapshot('legacy'), { revision: 8, lastClearRevision: 8 });
    throw new Error('rollback clear');
  });
  assert.throws(() => rollback(), /rollback clear/u);
  assert.deepEqual(revisions.snapshot('legacy'), { revision: 7, lastClearRevision: 6 });

  assert.equal(revisions.bump('new-server', true), 1);
  assert.deepEqual(revisions.snapshot('new-server'), { revision: 1, lastClearRevision: 1 });
  db.close();
});

test('per-account limiter is bounded and mass mention does not double-charge total', () => {
  const limiter = createChatRateLimiter({
    policies: {
      total: [{ limit: 2, windowMs: 1_000 }],
      message: [{ limit: 10, windowMs: 1_000 }],
      mentionAll: [{ limit: 1, windowMs: 1_000 }],
    },
    maxEntries: 4,
  });
  assert.equal(limiter.consume('alice', 'message', 0).allowed, true);
  assert.equal(limiter.consume('alice', 'mentionAll', 1, { includeTotal: false }).allowed, true);
  assert.equal(limiter.consume('alice', 'message', 2).allowed, true);
  assert.equal(limiter.consume('alice', 'message', 3).allowed, false);
  assert.equal(limiter.consume('bob', 'message', 3).allowed, true);
  assert.ok(limiter.size <= 4);
  assert.equal(hasAllMention('hello @все!'), true);
  assert.equal(hasAllMention('mail@alloy'), false);
});

function fakeSocket(userId, serverId, bufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount,
    _userId: userId,
    _chatServerId: serverId,
    sent: [],
    terminated: false,
    send(data) { this.sent.push(JSON.parse(data)); },
    terminate() { this.terminated = true; this.readyState = 3; },
  };
}

test('fanout uses current membership and exact connected-server subscription', () => {
  const memberships = new Set(['alice', 'bob']);
  const alice = fakeSocket('alice', 'srv_1');
  const aliceOtherServer = fakeSocket('alice', 'srv_2');
  const bob = fakeSocket('bob', 'srv_1');
  const sockets = new Map([
    ['alice', new Set([alice, aliceOtherServer])],
    ['bob', new Set([bob])],
  ]);
  const fanout = createChatRealtimeFanout({
    currentMemberIds: () => [...memberships],
    socketsForUser: (uid) => sockets.get(uid),
    isCurrentMember: (uid) => memberships.has(uid),
  });
  const event = messageDeletedEvent('srv_1', 1, 7);
  let builds = 0;
  const result = fanout.broadcast('srv_1', () => { builds++; return event; });
  assert.equal(result.delivered, 2);
  assert.equal(builds, 2, 'one personalized envelope per eligible account, none for another server');
  assert.equal(alice.sent[0].event.type, 'message.deleted');
  assert.equal(aliceOtherServer.sent.length, 0);
  assert.equal(bob.sent.length, 1);

  memberships.delete('bob');
  fanout.broadcast('srv_1', () => messageDeletedEvent('srv_1', 2, 8));
  assert.equal(bob.sent.length, 1, 'a kicked member receives no later frame on its authenticated account socket');
});

test('congested sockets are terminated; healthy oversized state gets an immediate resync', () => {
  const congested = fakeSocket('alice', 'srv_1', 300_000);
  const healthy = fakeSocket('bob', 'srv_1', 0);
  const sockets = new Map([['alice', new Set([congested])], ['bob', new Set([healthy])]]);
  const fanout = createChatRealtimeFanout({
    currentMemberIds: () => ['alice', 'bob'],
    socketsForUser: (uid) => sockets.get(uid),
    isCurrentMember: () => true,
  });
  fanout.broadcast('srv_1', (uid) => uid === 'alice' ? messageDeletedEvent('srv_1', 1, 7) : null);
  assert.equal(congested.terminated, true);
  assert.deepEqual(healthy.sent, [{ t: 'chat-resync', v: 1, serverId: 'srv_1', reason: 'backpressure' }]);
});

test('notify socket admission rejects only the new transport at the account cap', () => {
  const closed = [];
  const make = (openedAt) => ({ _openedAt: openedAt, close(code) { closed.push([openedAt, code]); } });
  const a = make(1), b = make(2), c = make(3);
  const sockets = new Set([a, b]);
  assert.equal(admitBoundedNotifySocket(sockets, c, 2), false);
  assert.deepEqual([...sockets], [a, b]);
  assert.deepEqual(closed, [[3, 4008]]);
});

test('generic notify frames are size/backpressure bounded without touching account state', () => {
  const healthy = fakeSocket('alice', 'srv_1');
  const congested = fakeSocket('alice', 'srv_1', 300_000);
  const result = sendBoundedNotifyFrames(new Set([healthy, congested]), { t: 'read', serverId: 'srv_1', lastRead: 7 });
  assert.equal(result.delivered, 1);
  assert.equal(result.terminated, 1);
  assert.equal(congested.terminated, true);
  assert.equal(sendBoundedNotifyFrames(new Set([healthy]), { body: 'x'.repeat(70_000) }).rejected, true);
});

test('notify inbound guard accepts normal heartbeat/presence and closes frame floods', () => {
  const guard = createNotifyInboundGuard({ burstLimit: 2, burstWindowMs: 1_000, minuteLimit: 10, minuteWindowMs: 60_000 });
  const socket = { _userId: 'alice' };
  assert.deepEqual(guard.inspect(socket, Buffer.from('{"t":"ping"}'), 0).value, { t: 'ping' });
  const presence = guard.inspect(socket, Buffer.from(JSON.stringify({
    t: 'presence', away: false, activeServerId: null, connectedServerId: 'srv_1', lastReleaseSid: 0,
    chatProtocol: 1,
  })), 1);
  assert.equal(presence.allowed, true);
  assert.equal(presence.value.chatProtocol, 1);
  assert.equal(guard.inspect(socket, Buffer.from('{"t":"ping"}'), 2).allowed, false);

  const malformed = createNotifyInboundGuard().inspect({ _userId: 'bob' }, Buffer.from('{"t":"presence","away":false,"extra":1}'), 0);
  assert.deepEqual({ allowed: malformed.allowed, code: malformed.code }, { allowed: false, code: 4009 });
  const fakeProtocol = createNotifyInboundGuard().inspect({ _userId: 'carol' }, Buffer.from('{"t":"presence","away":false,"chatProtocol":0}'), 0);
  assert.deepEqual({ allowed: fakeProtocol.allowed, code: fakeProtocol.code }, { allowed: false, code: 4009 });
});

test('notify inbound account bucket survives socket reconnects and stays bounded', () => {
  const guard = createNotifyInboundGuard({
    burstLimit: 100,
    minuteLimit: 100,
    accountBurstLimit: 2,
    accountMinuteLimit: 10,
    maxAccounts: 2,
  });
  const ping = Buffer.from('{"t":"ping"}');
  assert.equal(guard.inspect({ _userId: 'alice' }, ping, 0).allowed, true);
  assert.equal(guard.inspect({ _userId: 'alice' }, ping, 1).allowed, true);
  assert.equal(guard.inspect({ _userId: 'alice' }, ping, 2).allowed, false,
    'a new socket cannot reset the account allowance');
  assert.equal(guard.inspect({ _userId: 'bob' }, ping, 2).allowed, true);
  assert.equal(guard.inspect({ _userId: 'carol' }, ping, 2).allowed, true);
  assert.ok(guard.accountSize <= 2);
});

test('server integration fences every chat mutation and packages the runtime module', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const createStart = source.indexOf("app.post('/api/servers/:id/messages', requireAuth");
  const reactionStart = source.indexOf("app.post('/api/servers/:id/messages/:mid/react'", createStart);
  const createRoute = source.slice(createStart, reactionStart);
  assert.ok(createRoute.indexOf('if (duplicate) return res.json') < createRoute.indexOf("allowChatMutation(req, res, 'message')"),
    'idempotent recovery precedes the mutation limiter');
  assert.match(createRoute, /const persistMessage = db\.transaction[\s\S]*bumpChatRevision\(sid\)/u);
  assert.match(createRoute, /DELETE FROM reactions WHERE server_id=\? AND msg_id IN[\s\S]*DELETE FROM messages WHERE server_id=\?/u);

  const clearStart = source.indexOf("app.post('/api/servers/:id/clear', requireAuth");
  const clearRoute = source.slice(clearStart, source.indexOf("app.get('/api/servers/:id/token'", clearStart));
  assert.match(clearRoute, /db\.transaction[\s\S]*bumpChatRevision\(sid, \{ clear: true \}\)/u);

  const historyStart = source.indexOf("app.get('/api/servers/:id/messages', requireAuth");
  const exactStart = source.indexOf("app.get('/api/servers/:id/messages/:mid'", historyStart);
  const historyRoute = source.slice(historyStart, exactStart);
  assert.match(historyRoute, /const readSnapshot = db\.transaction[\s\S]*chatRevisions\.snapshot\(sid\)[\s\S]*lastClearRevision/u);

  const editStart = source.indexOf("app.patch('/api/servers/:id/messages/:mid'", reactionStart);
  const deleteStart = source.indexOf("app.delete('/api/servers/:id/messages/:mid'", editStart);
  const editRoute = source.slice(editStart, deleteStart);
  assert.ok(editRoute.indexOf('isMember(req.user.id, sid)') < editRoute.indexOf('UPDATE messages'));
  const deleteRoute = source.slice(deleteStart, source.indexOf("app.get('/healthz'", deleteStart));
  assert.ok(deleteRoute.indexOf('isMember(req.user.id, sid)') < deleteRoute.indexOf('DELETE FROM messages'));
  assert.match(source, /affectedChatServers[\s\S]*const purgeAccountChat = db\.transaction[\s\S]*bumpChatRevision\(serverId\)/u);
  assert.match(source, /connectedServerId[\s\S]*chatRealtime\.requestResync\(ws, chatServerId, 'reconnect'\)/u);

  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /chatRealtime\.js/u);
});

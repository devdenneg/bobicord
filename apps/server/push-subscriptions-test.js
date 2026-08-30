'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Database = require('better-sqlite3');
const {
  clearRequestedPushEndpoints,
  clearSessionPushEndpoints,
  installPushSubscriptionPrivacySchema,
  normalizedPushEndpoint,
  normalizedPushPrivacy,
  pushPayloadForSubscription,
  requestedPushCleanups,
  unsubscribeOwnedPushEndpoint,
} = require('./pushSubscriptions');

test('legacy push subscriptions migrate to fail-closed per-endpoint privacy', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '')");
  db.exec('CREATE TABLE push_prefs(user_id TEXT PRIMARY KEY,mention INTEGER NOT NULL DEFAULT 1,stream INTEGER NOT NULL DEFAULT 1)');
  db.prepare('INSERT INTO push_prefs(user_id,mention,stream) VALUES(?,?,?)').run('alice', 0, 1);
  db.prepare('INSERT INTO push_subs(endpoint,user_id) VALUES(?,?)').run('https://push.example/legacy', 'alice');
  installPushSubscriptionPrivacySchema(db);
  installPushSubscriptionPrivacySchema(db);
  assert.equal(db.prepare('SELECT privacy FROM push_subs WHERE endpoint=?').get('https://push.example/legacy').privacy, 'hidden');
  assert.deepEqual(db.prepare('SELECT mention,stream FROM push_subs WHERE endpoint=?').get('https://push.example/legacy'), {
    mention: 0, stream: 1,
  }, 'legacy account-global prefs are copied once into each endpoint');
  assert.equal(db.prepare("PRAGMA table_info(push_subs)").all().filter((column) => column.name === 'privacy').length, 1,
    'the migration is idempotent');
  db.close();
});

test('a partially completed migration never overwrites an existing device-local preference', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE push_subs(
    endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '',
    mention INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec('CREATE TABLE push_prefs(user_id TEXT PRIMARY KEY,mention INTEGER NOT NULL DEFAULT 1,stream INTEGER NOT NULL DEFAULT 1)');
  db.prepare('INSERT INTO push_prefs(user_id,mention,stream) VALUES(?,?,?)').run('alice', 1, 0);
  db.prepare('INSERT INTO push_subs(endpoint,user_id,mention) VALUES(?,?,?)')
    .run('https://push.example/partially-migrated-phone', 'alice', 0);
  installPushSubscriptionPrivacySchema(db);
  assert.deepEqual(db.prepare('SELECT privacy,mention,stream FROM push_subs').get(), {
    privacy: 'hidden', mention: 0, stream: 0,
  }, 'the existing mention stays per-device while only the newly-added stream copies legacy state');
  db.close();
});

test('push payload privacy is endpoint-specific and removes private content before delivery', () => {
  const source = {
    kind: 'mention', title: 'Секретный отправитель', body: 'Секретный текст', serverId: 'server-a',
  };
  assert.deepEqual(pushPayloadForSubscription(source, 'full'), { ...source, privacy: 'full' });
  assert.deepEqual(pushPayloadForSubscription(source, 'sender'), { ...source, body: '', privacy: 'sender' });
  for (const privacy of [undefined, null, 'broken']) {
    const payload = pushPayloadForSubscription(source, privacy);
    assert.equal(normalizedPushPrivacy(privacy), 'hidden');
    assert.deepEqual(payload, {
      ...source, title: 'RelayApp', body: 'Новое упоминание', privacy: 'hidden',
    });
    assert.doesNotMatch(JSON.stringify(payload), /Секретн/);
  }
  assert.equal(source.body, 'Секретный текст', 'per-endpoint redaction never mutates the shared payload');
});

test('server stores and applies privacy on the exact subscription row', () => {
  const index = readFileSync(require.resolve('./index'), 'utf8');
  assert.match(index, /privacy TEXT NOT NULL DEFAULT 'hidden'/);
  assert.match(index, /normalizedPushPrivacy\(pr && pr\.privacy\)/);
  assert.match(index, /pushPayloadForSubscription\(payload, r\.privacy\)/);
  assert.match(index, /AND s\.\$\{prefCol\}=1/);
  assert.match(index, /ON CONFLICT\(endpoint\)[^\n]+privacy=excluded\.privacy,mention=excluded\.mention,stream=excluded\.stream/);
  assert.match(index, /const persist = db\.transaction\(\(\) => \{[\s\S]*authManager\.verifySession\(bearerToken\(req\)[\s\S]*INSERT INTO push_subs/,
    'the endpoint commit revalidates authentication under the same immediate write transaction');
  assert.match(index, /res\.json\(\{ ok: true, userId: req\.user\.id, endpoint \}\)/,
    'the client receives exact endpoint/account ownership confirmation');
});

test('opposing per-device kind preferences never overwrite each other', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE push_subs(
    endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,privacy TEXT NOT NULL DEFAULT 'hidden',
    mention INTEGER NOT NULL DEFAULT 1,stream INTEGER NOT NULL DEFAULT 1
  )`);
  const insert = db.prepare('INSERT INTO push_subs(endpoint,user_id,mention,stream) VALUES(?,?,?,?)');
  insert.run('https://push.example/phone', 'alice', 0, 1);
  insert.run('https://push.example/desktop', 'alice', 1, 0);
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subs WHERE user_id=? AND mention=1').all('alice'), [
    { endpoint: 'https://push.example/desktop' },
  ]);
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subs WHERE user_id=? AND stream=1').all('alice'), [
    { endpoint: 'https://push.example/phone' },
  ]);
  db.close();
});

test('push cleanup is bounded, validated and scoped to the authenticated account', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '')");
  db.prepare('INSERT INTO push_subs(endpoint,user_id,session_id) VALUES(?,?,?)').run('https://push.example/alice', 'alice', 'session-a');
  db.prepare('INSERT INTO push_subs(endpoint,user_id,session_id) VALUES(?,?,?)').run('https://push.example/bob', 'bob', 'session-b');
  const body = { pushCleanups: [
    { userId: 'alice', endpoint: 'https://push.example/alice' },
    { userId: 'alice', endpoint: 'https://push.example/bob' },
    { userId: 'bob', endpoint: 'https://push.example/bob' },
    { userId: 'alice', endpoint: 'http://push.example/insecure' },
  ] };
  const acknowledgement = clearRequestedPushEndpoints(db, body, 'alice');
  assert.deepEqual(acknowledgement, {
    userId: 'alice',
    endpoints: ['https://push.example/alice', 'https://push.example/bob'],
  });
  assert.equal(db.prepare('SELECT 1 FROM push_subs WHERE endpoint=?').get('https://push.example/alice'), undefined);
  assert.ok(db.prepare('SELECT 1 FROM push_subs WHERE endpoint=?').get('https://push.example/bob'),
    'an endpoint owned by another account must survive a forged cleanup claim');
  db.close();
});

test('session logout deletes subscriptions without relying on page storage or endpoint discovery', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '')");
  const insert = db.prepare('INSERT INTO push_subs(endpoint,user_id,session_id) VALUES(?,?,?)');
  insert.run('https://push.example/current', 'alice', 'session-current');
  insert.run('https://push.example/other-device', 'alice', 'session-other');
  insert.run('https://push.example/other-user', 'bob', 'session-current');
  assert.equal(clearSessionPushEndpoints(db, 'alice', 'session-current'), 1);
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subs ORDER BY endpoint').all().map((row) => row.endpoint), [
    'https://push.example/other-device', 'https://push.example/other-user',
  ]);
  assert.equal(clearSessionPushEndpoints(db, 'alice', ''), 0, 'legacy/unknown sessions never widen to all account endpoints');
  db.close();
});

test('local unsubscribe permission distinguishes an absent endpoint from another account owner', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE push_subs(endpoint TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '')");
  db.prepare('INSERT INTO push_subs(endpoint,user_id) VALUES(?,?)').run('https://push.example/bob', 'bob');
  assert.deepEqual(unsubscribeOwnedPushEndpoint(db, 'https://push.example/bob', 'alice'), {
    removed: false, safeToUnsubscribe: false,
  });
  assert.ok(db.prepare('SELECT 1 FROM push_subs WHERE endpoint=?').get('https://push.example/bob'));
  assert.deepEqual(unsubscribeOwnedPushEndpoint(db, 'https://push.example/missing', 'alice'), {
    removed: false, safeToUnsubscribe: true,
  });
  db.prepare('INSERT INTO push_subs(endpoint,user_id) VALUES(?,?)').run('https://push.example/alice', 'alice');
  assert.deepEqual(unsubscribeOwnedPushEndpoint(db, 'https://push.example/alice', 'alice'), {
    removed: true, safeToUnsubscribe: true,
  });
  db.close();
});

test('push endpoint and cleanup input have finite protocol/size/count bounds', () => {
  assert.equal(normalizedPushEndpoint('http://push.example/no'), '');
  assert.equal(normalizedPushEndpoint('javascript:alert(1)'), '');
  assert.equal(normalizedPushEndpoint('https://push.example/ok'), 'https://push.example/ok');
  assert.equal(normalizedPushEndpoint('https://push.example/' + 'x'.repeat(2048)), '');
  const records = requestedPushCleanups({ pushCleanups: Array.from({ length: 50 }, (_, index) => ({
    userId: 'u', endpoint: `https://push.example/${index}`,
  })) });
  assert.equal(records.length, 32);
});

test('production image contains the push ownership helper required by index.js', () => {
  const dockerfile = readFileSync(require.resolve('./Dockerfile'), 'utf8');
  assert.match(dockerfile, /\bpushSubscriptions\.js\b/);
});

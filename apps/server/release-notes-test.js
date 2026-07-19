const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  finalizeRelease,
  formatReleaseText,
  installReleaseSchema,
  parseReleaseMeta,
  prepareRelease,
} = require('./releaseNotes');

const DEFAULT_NOTE = 'Чат получил красивую карточку этого обновления.';

function makeDb(filename = ':memory:') {
  const db = new Database(filename);
  if (filename !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memberships(user_id TEXT NOT NULL, server_id TEXT NOT NULL, PRIMARY KEY(user_id, server_id));
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_color INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      emotes TEXT NOT NULL DEFAULT '{}',
      image TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      client_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_ckey ON messages(server_id,user_id,client_key) WHERE client_key<>'';
  `);
  installReleaseSchema(db);
  return db;
}

function socket(serverId) { return { readyState: 1, _activeServerId: serverId }; }
function payload(sha, options = {}) {
  const source = options.source || 'web';
  return {
    sha,
    source,
    requiredComponents: options.requiredComponents || [source],
    attempt: options.attempt || `${sha}:1`,
    title: 'ignored',
    notes: options.notes || [DEFAULT_NOTE],
    version: options.version,
    publish: options.publish !== false,
    ...(options.commitCandidates ? { commitCandidates: options.commitCandidates } : {}),
  };
}

function candidate(sha, note, components) {
  return { sha, notes: note ? [note] : [], components };
}

// Basic single-component publish: duplicate tabs count once, repeated prepare/finalize are
// idempotent, and a retry returns enough authoritative data for at-least-once live delivery.
(() => {
  const db = makeDb();
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u2', 's1');
  const conns = new Map([
    ['u1', new Set([socket('s1'), socket('s1')])], // две вкладки = один человек
    ['u2', new Set([socket('forged')])],            // не участник forged-сервера
  ]);
  const sha = 'a'.repeat(40), attempt = `${sha}:1`;
  const prepared = prepareRelease(db, conns, payload(sha), 1000);
  assert.deepStrictEqual(prepared.targets, [{ serverId: 's1', audience: 1 }]);

  const repeated = prepareRelease(db, new Map(), payload(sha), 1100);
  assert.strictEqual(repeated.created, false);
  assert.strictEqual(repeated.snapshotReplaced, false);
  assert.deepStrictEqual(repeated.targets, [{ serverId: 's1', audience: 1 }]);

  const published = finalizeRelease(db, sha, 'web', attempt, 2000);
  assert.strictEqual(published.state, 'published');
  assert.strictEqual(published.deliveries.length, 1);
  assert.strictEqual(published.text, formatReleaseText([DEFAULT_NOTE]));
  const stored = db.prepare('SELECT kind,text,client_key,meta FROM messages').get();
  assert.strictEqual(stored.kind, 'release');
  assert.strictEqual(stored.text, published.text);
  assert.strictEqual(stored.client_key, `release:${sha}`);

  const duplicate = finalizeRelease(db, sha, 'web', attempt, 3000);
  assert.strictEqual(duplicate.changed, false);
  assert.strictEqual(duplicate.state, 'published');
  assert.deepStrictEqual(duplicate.release, published.release);
  assert.deepStrictEqual(duplicate.deliveries, published.deliveries);
  assert.strictEqual(duplicate.text, published.text);
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 1);

  assert.deepStrictEqual(parseReleaseMeta(stored.kind, stored.meta).notes, [DEFAULT_NOTE]);
  assert.strictEqual(parseReleaseMeta('release', '{broken'), undefined);
  db.close();
})();

// A zero snapshot is permanent for a successful attempt. The same attempt never resamples users
// who arrived later, so finalize marks the release skipped and it cannot pop up retroactively.
(() => {
  const db = makeDb();
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  const sha = 'b'.repeat(40), attempt = `${sha}:1`;
  const empty = prepareRelease(db, new Map(), payload(sha), 4000);
  assert.strictEqual(empty.targets.length, 0);
  const later = prepareRelease(db, new Map([['u1', new Set([socket('s1')])]]), payload(sha), 5000);
  assert.strictEqual(later.snapshotReplaced, false);
  assert.strictEqual(later.targets.length, 0);
  assert.strictEqual(finalizeRelease(db, sha, 'web', attempt, 6000).state, 'skipped');
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 0);
  db.close();
})();

// Mixed web+desktop releases publish only after both successful components. Either workflow may
// prepare first, but an unrelated source cannot complete or hijack the release.
(() => {
  const db = makeDb();
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  const conns = new Map([['u1', new Set([socket('s1')])]]);
  const sha = 'c'.repeat(40), attempt = `${sha}:1`;
  const components = ['web', 'desktop'];
  prepareRelease(db, conns, payload(sha, { source: 'web', requiredComponents: components }), 1000);
  const desktopPrepare = prepareRelease(db, new Map(), payload(sha, {
    source: 'desktop', requiredComponents: components, version: '0.1.42',
  }), 1100);
  assert.deepStrictEqual(desktopPrepare.requiredComponents, components);
  assert.throws(() => finalizeRelease(db, sha, 'manual', attempt, 1200), /source mismatch/u);

  const webDone = finalizeRelease(db, sha, 'web', attempt, 2000);
  assert.strictEqual(webDone.state, 'pending');
  assert.deepStrictEqual(webDone.completedComponents, ['web']);
  assert.deepStrictEqual(webDone.pendingComponents, ['desktop']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 0);
  assert.strictEqual(finalizeRelease(db, sha, 'web', attempt, 2100).changed, false);

  const desktopDone = finalizeRelease(db, sha, 'desktop', attempt, 3000);
  assert.strictEqual(desktopDone.state, 'published');
  assert.strictEqual(desktopDone.release.version, '0.1.42');
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 1);
  const retryFromOtherRequiredSource = finalizeRelease(db, sha, 'web', attempt, 3100);
  assert.strictEqual(retryFromOtherRequiredSource.state, 'published');
  assert.ok(retryFromOtherRequiredSource.release);
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 1);
  db.close();
})();

// A newer CI attempt may replace a failed, wholly-uncompleted snapshot. The same/older attempt is
// inert; after one component succeeds the audience is locked for the remaining component.
(() => {
  const db = makeDb();
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u2', 's2');
  const sha = 'd'.repeat(40), components = ['web', 'desktop'];
  const attempt1 = `${sha}:1`, attempt2 = `${sha}:2`, attempt3 = `${sha}:3`;
  prepareRelease(db, new Map(), payload(sha, { requiredComponents: components, attempt: attempt1 }), 1000);

  const sameAttempt = prepareRelease(db, new Map([['u1', new Set([socket('s1')])]]),
    payload(sha, { requiredComponents: components, attempt: attempt1 }), 1100);
  assert.strictEqual(sameAttempt.targets.length, 0);
  assert.strictEqual(sameAttempt.snapshotReplaced, false);

  const newAttempt = prepareRelease(db, new Map([['u1', new Set([socket('s1')])]]),
    payload(sha, { requiredComponents: components, attempt: attempt2 }), 1200);
  assert.strictEqual(newAttempt.snapshotReplaced, true);
  assert.deepStrictEqual(newAttempt.targets, [{ serverId: 's1', audience: 1 }]);
  assert.throws(() => finalizeRelease(db, sha, 'web', attempt1, 1300), /stale release attempt/u);

  assert.strictEqual(finalizeRelease(db, sha, 'web', attempt2, 2000).state, 'pending');
  const locked = prepareRelease(db, new Map([['u2', new Set([socket('s2')])]]),
    payload(sha, { source: 'desktop', requiredComponents: components, attempt: attempt3 }), 2100);
  assert.strictEqual(locked.snapshotReplaced, false);
  assert.strictEqual(locked.attempt, attempt2);
  assert.deepStrictEqual(locked.targets, [{ serverId: 's1', audience: 1 }]);
  assert.strictEqual(finalizeRelease(db, sha, 'desktop', attempt3, 3000).state, 'published');
  db.close();
})();

// Separate SQLite connections model old/new containers and independent workflows. Retrying from
// the second process observes the committed row and never inserts a second system message.
(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-release-'));
  const filename = path.join(dir, 'voice.db');
  let first, second;
  try {
    first = makeDb(filename);
    second = makeDb(filename);
    first.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
    const sha = 'e'.repeat(40), attempt = `${sha}:1`;
    const conns = new Map([['u1', new Set([socket('s1')])]]);
    assert.strictEqual(prepareRelease(first, conns, payload(sha), 1000).created, true);
    assert.strictEqual(prepareRelease(second, new Map(), payload(sha), 1100).created, false);
    assert.strictEqual(finalizeRelease(second, sha, 'web', attempt, 2000).state, 'published');
    assert.strictEqual(finalizeRelease(first, sha, 'web', attempt, 2100).changed, false);
    assert.strictEqual(first.prepare('SELECT COUNT(*) count FROM messages').get().count, 1);
  } finally {
    if (second) second.close();
    if (first) first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// Startup upgrades an early preview DB in place; production does not require a manual migration.
(() => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE deploy_releases(
    sha TEXT PRIMARY KEY,source TEXT NOT NULL,title TEXT NOT NULL,notes TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',
    created INTEGER NOT NULL,finalized INTEGER NOT NULL DEFAULT 0
  )`);
  installReleaseSchema(db);
  const columns = new Set(db.prepare('PRAGMA table_info(deploy_releases)').all().map((row) => row.name));
  assert.ok(columns.has('required_components'));
  assert.ok(columns.has('attempt'));
  db.close();
})();

// A release that never reached prepare is recovered from the bounded first-parent candidates.
// Coverage also makes late workflows idempotent, and a zero-audience skip advances the cursor.
(() => {
  const db = makeDb();
  db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  const conns = new Map([['u1', new Set([socket('s1')])]]);
  const a = '1'.repeat(40), b = '2'.repeat(40), c = '3'.repeat(40);
  const noteA = 'Исправлена потеря патчноута после неудачного обновления.';
  const noteB = 'Несколько коммитов теперь объединяются в одно сообщение.';
  const noteC = 'Следующее обновление больше не повторяет старые пункты.';
  const candidatesAB = [candidate(a, noteA, ['web']), candidate(b, noteB, ['web'])];
  prepareRelease(db, conns, payload(b, { notes: [noteB], commitCandidates: candidatesAB }), 1000);
  const published = finalizeRelease(db, b, 'web', `${b}:1`, 2000);
  assert.deepStrictEqual(published.release.notes, [noteA, noteB]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM deploy_release_coverage').get().count, 2);

  const lateA = prepareRelease(db, conns, payload(a, {
    notes: [noteA], commitCandidates: [candidate(a, noteA, ['web'])],
  }), 2100);
  assert.strictEqual(lateA.state, 'superseded');
  assert.strictEqual(finalizeRelease(db, a, 'web', `${a}:1`, 2200).state, 'superseded');
  assert.strictEqual(finalizeRelease(db, b, 'web', `${b}:1`, 2300).changed, false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 1);

  const emptyDb = makeDb();
  prepareRelease(emptyDb, new Map(), payload(b, { notes: [noteB], commitCandidates: candidatesAB }), 3000);
  assert.strictEqual(finalizeRelease(emptyDb, b, 'web', `${b}:1`, 3100).state, 'skipped');
  emptyDb.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
  const candidatesABC = [...candidatesAB, candidate(c, noteC, ['web'])];
  prepareRelease(emptyDb, conns, payload(c, { notes: [noteC], commitCandidates: candidatesABC }), 3200);
  const afterSkip = finalizeRelease(emptyDb, c, 'web', `${c}:1`, 3300);
  assert.deepStrictEqual(afterSkip.release.notes, [noteC]);
  assert.strictEqual(emptyDb.prepare('SELECT COUNT(*) count FROM deploy_release_coverage').get().count, 3);
  emptyDb.close();
  db.close();
})();

// A later desktop descendant may carry a mixed release whose web half already succeeded.
// A web-only descendant cannot absorb that release because its desktop half is still missing.
(() => {
  const runCase = (compatible) => {
    const db = makeDb();
    db.prepare('INSERT INTO memberships(user_id,server_id) VALUES(?,?)').run('u1', 's1');
    const conns = new Map([['u1', new Set([socket('s1')])]]);
    const a = compatible ? '4'.repeat(40) : '6'.repeat(40);
    const b = compatible ? '5'.repeat(40) : '7'.repeat(40);
    const noteA = 'Составное обновление корректно дожидается обеих платформ.';
    const noteB = compatible
      ? 'Настольная сборка завершает ранее начатое обновление.'
      : 'Веб-обновление публикуется независимо от настольной сборки.';
    const both = ['web', 'desktop'];
    prepareRelease(db, conns, payload(a, {
      requiredComponents: both,
      notes: [noteA],
      commitCandidates: [candidate(a, noteA, both)],
    }), 1000);
    assert.strictEqual(finalizeRelease(db, a, 'web', `${a}:1`, 1100).state, 'pending');

    const source = compatible ? 'desktop' : 'web';
    const nextComponents = [source];
    prepareRelease(db, conns, payload(b, {
      source,
      requiredComponents: nextComponents,
      notes: [noteB],
      commitCandidates: [candidate(a, noteA, both), candidate(b, noteB, nextComponents)],
    }), 1200);
    const olderState = db.prepare('SELECT state FROM deploy_releases WHERE sha=?').get(a).state;
    assert.strictEqual(olderState, compatible ? 'superseded' : 'pending');
    const result = finalizeRelease(db, b, source, `${b}:1`, 1300);
    assert.deepStrictEqual(result.release.notes, compatible ? [noteA, noteB] : [noteB]);
    if (compatible) assert.strictEqual(finalizeRelease(db, a, 'desktop', `${a}:1`, 1400).state, 'superseded');
    db.close();
  };
  runCase(true);
  runCase(false);
})();

console.log('release notes tests: ok');

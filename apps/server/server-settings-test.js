'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const {
  applyServerVolumeMutation,
  boundedAccountSettings,
  createServerVolumeSettingsStore,
  normalizeServerVolumeMutation,
  sanitizeServerVolumeData,
} = require('./serverSettings');

assert.deepEqual(JSON.parse(JSON.stringify(sanitizeServerVolumeData({
  users: { alice: 0.2, loud: 9, bad: '1' },
  streams: { alice: 0.4, loud: 9 },
}))), {
  users: { alice: 0.2, loud: 2 },
  streams: { alice: 0.4, loud: 1 },
}, 'nested volume maps survive strict sanitization');

let shared = {};
shared = applyServerVolumeMutation(shared, { section: 'users', key: 'alice', value: 0.2 });
shared = applyServerVolumeMutation(shared, { section: 'users', key: 'bob', value: 0.3 });
assert.deepEqual(JSON.parse(JSON.stringify(shared.users)), { alice: 0.2, bob: 0.3 },
  'two clients changing different people cannot replace the whole map');
shared = applyServerVolumeMutation(shared, { section: 'streams', key: 'alice', value: 4 });
assert.equal(shared.streams.alice, 1);
assert.equal(normalizeServerVolumeMutation({ section: 'users', key: '__proto__', value: 1 }), null);
assert.equal(normalizeServerVolumeMutation({ section: 'users', key: 'alice', value: '1' }), null);

const account = JSON.parse(boundedAccountSettings({
  keybinds: { muteMic: ['ControlLeft', 'KeyM'], deafen: ['ControlLeft', 'KeyD'] },
  disableGlobalHotkeys: false,
  hkResetV: 2,
}));
assert.deepEqual(account.keybinds.muteMic, ['ControlLeft', 'KeyM'], 'nested account keybinds are not silently erased');
assert.equal(account.disableGlobalHotkeys, false);

const db = new Database(':memory:');
db.exec(`CREATE TABLE server_settings(
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(user_id, server_id)
)`);
const store = createServerVolumeSettingsStore(db);
store.replace('account', 'server', { users: { alice: 0.2 }, streams: { alice: 0.4 } });
assert.deepEqual(JSON.parse(JSON.stringify(store.get('account', 'server'))), {
  users: { alice: 0.2 }, streams: { alice: 0.4 },
}, 'legacy whole-map clients keep nested volume maps through SQLite');
store.patch('account', 'server', { section: 'users', key: 'bob', value: 0.3 });
store.patch('account', 'server', { section: 'streams', key: 'bob', value: 0.6 });
assert.deepEqual(JSON.parse(JSON.stringify(store.get('account', 'server'))), {
  users: { alice: 0.2, bob: 0.3 }, streams: { alice: 0.4, bob: 0.6 },
}, 'field patches from separate clients preserve every unrelated SQLite value');
db.close();

assert.match(fs.readFileSync('Dockerfile', 'utf8'), /\bserverSettings\.js\b/,
  'the production image packages the settings store required by index.js');

console.log('server settings: ok');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const { passwordPrehash } = require('./auth');
const { bootstrapAdmin, runCli } = require('./bootstrap-admin');

const PASSWORD = 'Случайный пароль 2026! море';
const EMAIL = 'Denis.Admin@example.com';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bootstrap-admin-'));
  const dbFile = path.join(directory, 'voice.db');
  const emailFile = path.join(directory, 'email');
  const passwordFile = path.join(directory, 'password');
  fs.writeFileSync(emailFile, `${EMAIL}\n`, { mode: 0o600 });
  fs.writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(emailFile, 0o600);
    fs.chmodSync(passwordFile, 0o600);
  } catch {
    // Windows does not expose POSIX mode bits; production enforcement is Linux-only.
  }
  return {
    directory,
    dbFile,
    emailFile,
    passwordFile,
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function bootstrap(fx, overrides = {}) {
  return bootstrapAdmin({
    dbFile: fx.dbFile,
    emailFile: fx.emailFile,
    passwordFile: fx.passwordFile,
    bcryptRounds: 4,
    enforceRootOwner: false,
    createdAt: 1_700_000_000_000,
    randomBytes: () => Buffer.from('0011223344556677', 'hex'),
    ...overrides,
  });
}

test('creates exact verified denis with a prehash-v1 bcrypt credential', () => {
  const fx = fixture();
  try {
    assert.deepEqual(bootstrap(fx), { username: 'denis', createdAt: 1_700_000_000_000 });
    const db = new Database(fx.dbFile, { readonly: true });
    const user = db.prepare('SELECT * FROM users WHERE username=?').get('denis');
    db.close();

    assert.equal(user.id, 'u_0011223344556677');
    assert.equal(user.username, 'denis');
    assert.equal(user.is_admin, 1);
    assert.equal(user.email, EMAIL);
    assert.equal(user.email_key, EMAIL.toLowerCase());
    assert.equal(user.email_verified_at, 1_700_000_000_000);
    assert.equal(user.password_changed_at, 1_700_000_000_000);
    assert.match(user.passhash, /^prehash-v1\$/u);
    assert.equal(bcrypt.compareSync(passwordPrehash(PASSWORD), user.passhash.slice('prehash-v1$'.length)), true);
  } finally {
    fx.cleanup();
  }
});

test('refuses a repeat without replacing the existing administrator', () => {
  const fx = fixture();
  try {
    bootstrap(fx);
    fs.writeFileSync(fx.passwordFile, 'Другой безопасный пароль 2026!\n');
    assert.throws(() => bootstrap(fx), (error) => error && error.code === 'ADMIN_EXISTS');

    const db = new Database(fx.dbFile, { readonly: true });
    const users = db.prepare('SELECT username,passhash FROM users').all();
    db.close();
    assert.equal(users.length, 1);
    assert.equal(bcrypt.compareSync(passwordPrehash(PASSWORD), users[0].passhash.slice('prehash-v1$'.length)), true);
  } finally {
    fx.cleanup();
  }
});

test('recovers denis even when unrelated users already exist', () => {
  const fx = fixture();
  try {
    const db = new Database(fx.dbFile);
    db.exec(`CREATE TABLE users(
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      passhash TEXT NOT NULL,
      avatar_color INTEGER NOT NULL DEFAULT 0,
      bio TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO users(id,username,display_name,passhash,created)
      VALUES('u_alice','alice','Alice','legacy-hash',1)`).run();
    db.close();

    bootstrap(fx);
    const verified = new Database(fx.dbFile, { readonly: true });
    assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
    assert.equal(verified.prepare("SELECT is_admin FROM users WHERE username='denis'").get().is_admin, 1);
    verified.close();
  } finally {
    fx.cleanup();
  }
});

test('refuses case-insensitive denis collision', () => {
  const fx = fixture();
  try {
    const db = new Database(fx.dbFile);
    db.exec(`CREATE TABLE users(
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      passhash TEXT NOT NULL,
      avatar_color INTEGER NOT NULL DEFAULT 0,
      bio TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO users(id,username,display_name,passhash,created)
      VALUES('u_other','Denis','Other','legacy-hash',1)`).run();
    db.close();
    assert.throws(() => bootstrap(fx), (error) => error && error.code === 'ADMIN_EXISTS');
  } finally {
    fx.cleanup();
  }
});

test('CLI rejects arguments and inline secret values', () => {
  const fx = fixture();
  try {
    const base = {
      BOOTSTRAP_ADMIN_DB_FILE: fx.dbFile,
      BOOTSTRAP_ADMIN_EMAIL_FILE: fx.emailFile,
      BOOTSTRAP_ADMIN_PASSWORD_FILE: fx.passwordFile,
    };
    assert.throws(
      () => runCli({ argv: ['node', 'bootstrap-admin.js', EMAIL], env: base }),
      (error) => error && error.code === 'CLI_ARGUMENTS_FORBIDDEN',
    );
    assert.throws(
      () => runCli({ argv: ['node', 'bootstrap-admin.js'], env: { ...base, BOOTSTRAP_ADMIN_PASSWORD: PASSWORD } }),
      (error) => error && error.code === 'INLINE_SECRETS_FORBIDDEN',
    );
  } finally {
    fx.cleanup();
  }
});

test('rejects a secret file readable by group or other users', {
  skip: process.platform === 'win32',
}, () => {
  const fx = fixture();
  try {
    fs.chmodSync(fx.passwordFile, 0o644);
    assert.throws(
      () => bootstrap(fx),
      (error) => error && error.code === 'INSECURE_SECRET_PERMISSIONS',
    );
    assert.equal(fs.existsSync(fx.dbFile), true);
    const db = new Database(fx.dbFile, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    db.close();
  } finally {
    fx.cleanup();
  }
});

test('CLI output never contains the email or password', () => {
  const fx = fixture();
  try {
    let output = '';
    runCli({
      argv: ['node', 'bootstrap-admin.js'],
      env: {
        BOOTSTRAP_ADMIN_DB_FILE: fx.dbFile,
        BOOTSTRAP_ADMIN_EMAIL_FILE: fx.emailFile,
        BOOTSTRAP_ADMIN_PASSWORD_FILE: fx.passwordFile,
      },
      stdout: { write(value) { output += value; } },
      bootstrapOptions: { bcryptRounds: 4, enforceRootOwner: false },
    });
    assert.doesNotMatch(output, new RegExp(EMAIL.replace('.', '\\.')));
    assert.equal(output.includes(PASSWORD), false);
    assert.match(output, /Администратор denis создан/u);
  } finally {
    fx.cleanup();
  }
});

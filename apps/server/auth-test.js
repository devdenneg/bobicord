'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  AuthError,
  createAuthManager,
  installAuthSchema,
  installVerifiedRegistrationGuard,
  normalizeEmail,
  validatePassword,
  verifiedEmailForOwner,
} = require('./auth');

const STRONG_PASSWORD = 'Верный длинный пароль 2026!';

test('full email is exposed only for a verified account-owner payload', () => {
  assert.equal(verifiedEmailForOwner({ email: 'owner@example.com', email_verified_at: 1 }), 'owner@example.com');
  assert.equal(verifiedEmailForOwner({ email: 'pending@example.com', email_verified_at: 0 }), '');
  assert.equal(verifiedEmailForOwner(null), '');
});

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function errorCode(expected) {
  return (error) => error instanceof AuthError && error.code === expected;
}

function createUsersTable(db) {
  db.exec(`CREATE TABLE users(
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    passhash TEXT NOT NULL,
    avatar_color INTEGER NOT NULL DEFAULT 0,
    avatar_url TEXT NOT NULL DEFAULT '',
    profile_banner_url TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  )`);
}

function fakeMailer() {
  const messages = [];
  return {
    available: true,
    messages,
    async sendEmailCode(payload) { messages.push({ kind: 'code', ...payload }); },
    async sendPasswordReset(payload) { messages.push({ kind: 'reset', ...payload }); },
    async sendPasswordChanged(payload) { messages.push({ kind: 'changed', ...payload }); },
    async sendEmailBound(payload) { messages.push({ kind: 'bound', ...payload }); },
  };
}

function setup(options = {}) {
  const db = new Database(':memory:');
  createUsersTable(db);
  const mailer = options.mailer || fakeMailer();
  let timestamp = options.timestamp || Date.parse('2026-07-19T12:00:00.000Z');
  const manager = createAuthManager({
    db,
    mailer,
    codePepper: options.codePepper === undefined ? 'p'.repeat(64) : options.codePepper,
    sessionSecret: 'test-session-secret',
    now: () => timestamp,
    config: {
      bcryptRounds: 4,
      sendCooldownMs: 1000,
      emailCodeTtlMs: 10 * 60 * 1000,
      emailFlowMaxMs: 30 * 60 * 1000,
      resetTtlMs: 20 * 60 * 1000,
      resetSendCooldownMs: 1000,
      resetResponseMinMs: 0,
      ...(options.config || {}),
    },
  });
  return {
    db,
    mailer,
    manager,
    now: () => timestamp,
    advance(ms) { timestamp += ms; },
    close() { db.close(); },
  };
}

function insertLegacy(db, username = 'legacy', password = 'старый пароль') {
  const id = `u_${username}`;
  db.prepare(`INSERT INTO users(id,username,display_name,passhash,avatar_color,bio,is_admin,created)
    VALUES(?,?,?,?,0,'',0,?)`).run(id, username, username, bcrypt.hashSync(password, 4), Date.now());
  return { id, username, password };
}

function latest(messages, kind) {
  return [...messages].reverse().find((message) => message.kind === kind);
}

test('schema migration is idempotent and validators use one explicit email identity policy', () => {
  const db = new Database(':memory:');
  createUsersTable(db);
  installAuthSchema(db);
  installAuthSchema(db);
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  for (const column of ['email', 'email_key', 'email_verified_at', 'session_version', 'password_changed_at']) {
    assert.equal(columns.has(column), true);
  }
  assert.deepEqual(normalizeEmail(' Alice@ExAmPle.com '), {
    email: 'Alice@example.com', key: 'alice@example.com',
  });
  assert.throws(() => normalizeEmail('not-an-email'), errorCode('INVALID_EMAIL'));
  assert.throws(() => validatePassword('коротко'), errorCode('WEAK_PASSWORD'));
  assert.throws(() => validatePassword('12345678901234567890'), errorCode('WEAK_PASSWORD'));
  assert.throws(() => validatePassword('qwertyuiop123456789'), errorCode('WEAK_PASSWORD'));
  assert.throws(() => validatePassword('alice-super-long-password-2026', { username: 'alice' }), errorCode('WEAK_PASSWORD'));
  assert.equal(validatePassword(STRONG_PASSWORD), STRONG_PASSWORD.normalize('NFC'));
  const unicode64 = Array.from('Длинная фраза с разными словами 2026! '.repeat(3)).slice(0, 64).join('');
  assert.equal(Array.from(validatePassword(unicode64)).length, 64);
  installVerifiedRegistrationGuard(db);
  assert.throws(() => insertLegacy(db, 'rollback'), /verified email required/u);
  db.prepare(`INSERT INTO users(
    id,username,display_name,passhash,avatar_color,bio,is_admin,created,email,email_key,email_verified_at
  ) VALUES('u_verified','verified','verified','hash',0,'',0,1,'verified@example.com','verified@example.com',1)`).run();
  db.close();
});

test('registration is invite-only, request-idempotent and creates no user before a 4-digit proof', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const { manager, db, mailer } = fixture;
  const invite = manager.currentInvite({ username: 'denis' });
  const request = {
    username: 'alice',
    password: STRONG_PASSWORD,
    email: 'Alice@example.com',
    inviteCode: invite.code,
    requestId: 'signup-request-0001',
    ip: '203.0.113.10',
  };
  await assert.rejects(manager.startRegistration({ ...request, inviteCode: 'WRONGCODE1234567890' }), errorCode('INVALID_INVITE'));
  const challenge = await manager.startRegistration(request);
  assert.match(challenge.flowId, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(challenge.challengeId, challenge.flowId);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM users').get().count, 0);
  assert.match(latest(mailer.messages, 'code').code, /^\d{4}$/u);
  assert.equal(JSON.stringify(challenge).includes(latest(mailer.messages, 'code').code), false);

  const duplicate = await manager.startRegistration(request);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.flowId, challenge.flowId);
  assert.equal(mailer.messages.filter((message) => message.kind === 'code').length, 1);
  await assert.rejects(manager.startRegistration({ ...request, email: 'other@example.com' }), errorCode('IDEMPOTENCY_CONFLICT'));

  const verified = manager.verifyRegistration({
    flowId: challenge.flowId,
    code: latest(mailer.messages, 'code').code,
    ip: request.ip,
  });
  assert.equal(verified.user.username, 'alice');
  assert.equal(verified.user.emailVerified, true);
  assert.equal(db.prepare('SELECT uses FROM auth_registration_invites WHERE day=?').get(invite.day).uses, 1);
  assert.throws(() => manager.verifyRegistration({ flowId: challenge.flowId, code: '0000', ip: request.ip }), errorCode('FLOW_CONSUMED'));
});

test('parallel registration retry sends one email and consumes one invite email budget slot', async (t) => {
  const mailer = fakeMailer();
  const send = mailer.sendEmailCode.bind(mailer);
  mailer.sendEmailCode = async (payload) => {
    await send(payload);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const fixture = setup({ mailer, config: { inviteMaxSends: 2 } });
  t.after(() => fixture.close());
  const invite = fixture.manager.currentInvite({ username: 'denis' });
  const request = {
    username: 'parallel', password: STRONG_PASSWORD, email: 'parallel@example.com',
    inviteCode: invite.code, requestId: 'signup-parallel-01', ip: '203.0.113.60',
  };
  const [first, second] = await Promise.all([
    fixture.manager.startRegistration(request), fixture.manager.startRegistration(request),
  ]);
  assert.equal(first.flowId, second.flowId);
  assert.equal(mailer.messages.filter((message) => message.kind === 'code').length, 1);
  const row = fixture.db.prepare('SELECT email_sends FROM auth_registration_invites WHERE day=?').get(invite.day);
  assert.equal(row.email_sends, 1);
  fixture.advance(1001);
  await fixture.manager.resendRegistration({ flowId: first.flowId, ip: request.ip });
  assert.equal(fixture.db.prepare('SELECT email_sends FROM auth_registration_invites WHERE day=?').get(invite.day).email_sends, 2);
  await assert.rejects(fixture.manager.startRegistration({
    ...request, username: 'parallel2', email: 'parallel2@example.com', requestId: 'signup-parallel-02',
  }), errorCode('INVITE_SENDS_EXHAUSTED'));
});

test('a delivered code remains verifiable during an SMTP outage', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const invite = fixture.manager.currentInvite({ username: 'denis' });
  const challenge = await fixture.manager.startRegistration({
    username: 'delivered', password: STRONG_PASSWORD, email: 'delivered@example.com',
    inviteCode: invite.code, requestId: 'signup-delivered-01', ip: '203.0.113.61',
  });
  const code = latest(fixture.mailer.messages, 'code').code;
  fixture.mailer.available = false;
  assert.equal(fixture.manager.verifyRegistration({
    flowId: challenge.flowId, code, ip: '203.0.113.61',
  }).user.username, 'delivered');
});

test('failed initial delivery retries through cooldown and invite email budget', async (t) => {
  const mailer = fakeMailer();
  let attempts = 0;
  mailer.sendEmailCode = async (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary delivery failure');
    mailer.messages.push({ kind: 'code', ...payload });
  };
  const fixture = setup({ mailer, config: { inviteMaxSends: 2 } });
  t.after(() => fixture.close());
  const invite = fixture.manager.currentInvite({ username: 'denis' });
  const request = {
    username: 'mailretry', password: STRONG_PASSWORD, email: 'mailretry@example.com',
    inviteCode: invite.code, requestId: 'signup-mail-retry-01', ip: '203.0.113.64',
  };
  await assert.rejects(fixture.manager.startRegistration(request), errorCode('EMAIL_DELIVERY_FAILED'));
  await assert.rejects(fixture.manager.startRegistration(request), errorCode('RESEND_COOLDOWN'));
  assert.equal(attempts, 1);
  fixture.advance(1001);
  const resumed = await fixture.manager.startRegistration(request);
  assert.ok(resumed.flowId);
  assert.equal(attempts, 2);
  assert.equal(fixture.db.prepare('SELECT email_sends FROM auth_registration_invites WHERE day=?').get(invite.day).email_sends, 2);
});

test('wrong code attempts persist, and resend replaces the code without resetting attempts', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const { manager, db, mailer } = fixture;
  const invite = manager.currentInvite({ username: 'denis' });
  const challenge = await manager.startRegistration({
    username: 'charlie', password: STRONG_PASSWORD, email: 'charlie@example.com',
    inviteCode: invite.code, requestId: 'signup-request-0002', ip: '203.0.113.11',
  });
  const firstCode = latest(mailer.messages, 'code').code;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => manager.verifyRegistration({ flowId: challenge.flowId, code: '9999', ip: '203.0.113.11' }),
      (error) => ['INVALID_CODE', 'CODE_ATTEMPTS_EXCEEDED'].includes(error.code));
  }
  assert.equal(db.prepare('SELECT attempts FROM auth_email_flows WHERE id=?').get(challenge.flowId).attempts, 2);
  fixture.advance(1001);
  await manager.resendRegistration({ flowId: challenge.flowId, ip: '203.0.113.11' });
  const secondCode = latest(mailer.messages, 'code').code;
  assert.equal(db.prepare('SELECT attempts FROM auth_email_flows WHERE id=?').get(challenge.flowId).attempts, 2);
  assert.throws(() => manager.verifyRegistration({ flowId: challenge.flowId, code: firstCode, ip: '203.0.113.11' }), errorCode('INVALID_CODE'));
  const result = manager.verifyRegistration({ flowId: challenge.flowId, code: secondCode, ip: '203.0.113.11' });
  assert.equal(result.user.username, 'charlie');
});

test('five failed email-code attempts lock a flow even across resends', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const { manager, db } = fixture;
  const invite = manager.currentInvite({ username: 'denis' });
  const challenge = await manager.startRegistration({
    username: 'locked', password: STRONG_PASSWORD, email: 'locked@example.com',
    inviteCode: invite.code, requestId: 'signup-request-0003', ip: '203.0.113.12',
  });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.throws(() => manager.verifyRegistration({ flowId: challenge.flowId, code: '9999', ip: '203.0.113.12' }),
      errorCode(attempt === 5 ? 'CODE_ATTEMPTS_EXCEEDED' : 'INVALID_CODE'));
  }
  assert.equal(db.prepare('SELECT attempts FROM auth_email_flows WHERE id=?').get(challenge.flowId).attempts, 5);
  fixture.advance(1001);
  await assert.rejects(manager.resendRegistration({ flowId: challenge.flowId, ip: '203.0.113.12' }), errorCode('CODE_ATTEMPTS_EXCEEDED'));
});

test('daily Moscow invite survives midnight for an existing flow and emergency rotation revokes old generation', async (t) => {
  const fixture = setup({ timestamp: Date.parse('2026-07-19T20:59:30.000Z') });
  t.after(() => fixture.close());
  const { manager, mailer } = fixture;
  const oldInvite = manager.currentInvite({ username: 'denis' });
  const challenge = await manager.startRegistration({
    username: 'midnight', password: STRONG_PASSWORD, email: 'midnight@example.com',
    inviteCode: oldInvite.code, requestId: 'signup-midnight-01', ip: '203.0.113.13',
  });
  const code = latest(mailer.messages, 'code').code;
  const pendingAcrossMidnight = await manager.startRegistration({
    username: 'oldpending', password: STRONG_PASSWORD, email: 'oldpending@example.com',
    inviteCode: oldInvite.code, requestId: 'signup-old-pending-01', ip: '203.0.113.15',
  });
  const pendingCode = latest(mailer.messages, 'code').code;
  fixture.advance(61 * 1000);
  const newInvite = manager.currentInvite({ username: 'denis' });
  assert.notEqual(newInvite.day, oldInvite.day);
  assert.notEqual(newInvite.code, oldInvite.code);
  assert.equal(manager.verifyRegistration({ flowId: challenge.flowId, code, ip: '203.0.113.13' }).user.username, 'midnight');

  const second = await manager.startRegistration({
    username: 'revoked', password: STRONG_PASSWORD, email: 'revoked@example.com',
    inviteCode: newInvite.code, requestId: 'signup-rotate-0001', ip: '203.0.113.14',
  });
  const secondCode = latest(mailer.messages, 'code').code;
  const rotated = manager.rotateInvite({ username: 'denis' });
  assert.notEqual(rotated.code, newInvite.code);
  assert.throws(() => manager.verifyRegistration({ flowId: second.flowId, code: secondCode, ip: '203.0.113.14' }), errorCode('FLOW_CONSUMED'));
  assert.throws(() => manager.verifyRegistration({
    flowId: pendingAcrossMidnight.flowId, code: pendingCode, ip: '203.0.113.15',
  }), errorCode('FLOW_CONSUMED'));
  assert.throws(() => manager.currentInvite({ username: 'other-admin', is_admin: 1 }), errorCode('DENIS_ONLY'));
});

test('lower invite limits apply to pending flows from the previous Moscow day', async (t) => {
  const fixture = setup({
    timestamp: Date.parse('2026-07-19T20:59:30.000Z'),
    config: { inviteMaxUses: 5, inviteMaxSends: 5 },
  });
  t.after(() => fixture.close());
  const { db, mailer, now } = fixture;
  const invite = fixture.manager.currentInvite({ username: 'denis' });
  const first = await fixture.manager.startRegistration({
    username: 'limitfirst', password: STRONG_PASSWORD, email: 'limitfirst@example.com',
    inviteCode: invite.code, requestId: 'signup-limit-first', ip: '203.0.113.16',
  });
  const firstCode = latest(mailer.messages, 'code').code;
  const second = await fixture.manager.startRegistration({
    username: 'limitsecond', password: STRONG_PASSWORD, email: 'limitsecond@example.com',
    inviteCode: invite.code, requestId: 'signup-limit-second', ip: '203.0.113.17',
  });
  const secondCode = latest(mailer.messages, 'code').code;
  fixture.advance(61 * 1000);
  const stricter = createAuthManager({
    db, mailer, codePepper: 'p'.repeat(64), sessionSecret: 'test-session-secret', now,
    config: {
      bcryptRounds: 4, sendCooldownMs: 1000, inviteMaxUses: 1, inviteMaxSends: 2,
      emailCodeTtlMs: 10 * 60 * 1000, emailFlowMaxMs: 30 * 60 * 1000,
    },
  });
  assert.equal(stricter.verifyRegistration({
    flowId: first.flowId, code: firstCode, ip: '203.0.113.16',
  }).user.username, 'limitfirst');
  assert.throws(() => stricter.verifyRegistration({
    flowId: second.flowId, code: secondCode, ip: '203.0.113.17',
  }), errorCode('INVITE_EXHAUSTED'));
  await assert.rejects(stricter.resendRegistration({
    flowId: second.flowId, ip: '203.0.113.17',
  }), errorCode('INVITE_SENDS_EXHAUSTED'));
});

test('legacy binding requires the current password, resumes active challenge and revokes old JWTs', async (t) => {
  const fixture = setup({ config: { emailEnforcement: 'required' } });
  t.after(() => fixture.close());
  const { manager, db, mailer } = fixture;
  const legacy = insertLegacy(db);
  const oldToken = manager.issueSession(legacy.id);
  const oldIdOnlyToken = jwt.sign({ id: legacy.id }, 'test-session-secret', { expiresIn: '1h' });
  const oldUsernameToken = jwt.sign({ u: legacy.username }, 'test-session-secret', { expiresIn: '1h' });
  assert.equal(manager.verifySession(oldIdOnlyToken).user.id, legacy.id);
  assert.equal(manager.verifySession(oldUsernameToken).user.id, legacy.id);
  assert.equal(manager.sessionState(legacy.id).emailRequired, true);
  await assert.rejects(manager.startEmailBinding({
    userId: legacy.id, password: 'wrong', email: 'legacy@example.com',
    requestId: 'binding-request-01', ip: '203.0.113.20',
  }), errorCode('INVALID_PASSWORD'));

  const challenge = await manager.startEmailBinding({
    userId: legacy.id, password: legacy.password, email: 'legacy@example.com',
    requestId: 'binding-request-02', ip: '203.0.113.20',
  });
  assert.equal(manager.sessionState(legacy.id).activeBinding.flowId, challenge.flowId);
  const duplicate = await manager.startEmailBinding({
    userId: legacy.id, password: legacy.password, email: 'legacy@example.com',
    requestId: 'binding-request-02', ip: '203.0.113.20',
  });
  assert.equal(duplicate.idempotent, true);
  const result = manager.verifyEmailBinding({
    userId: legacy.id, flowId: challenge.flowId, code: latest(mailer.messages, 'code').code, ip: '203.0.113.20',
  });
  assert.equal(result.user.sessionVersion, 1);
  assert.equal(manager.sessionState(legacy.id).ready, true);
  assert.throws(() => manager.verifySession(oldToken), errorCode('SESSION_REVOKED'));
  assert.throws(() => manager.verifySession(oldIdOnlyToken), errorCode('SESSION_REVOKED'));
  assert.throws(() => manager.verifySession(oldUsernameToken), errorCode('SESSION_REVOKED'));
  const fresh = manager.issueSession(legacy.id);
  assert.equal(manager.verifySession(fresh, { requireVerified: true }).user.id, legacy.id);
  await immediate();
  assert.equal(mailer.messages.some((message) => message.kind === 'bound'), true);
});

test('new binding intent supersedes the old flow and support recovery is one-use', async (t) => {
  const fixture = setup({ config: { emailEnforcement: 'required' } });
  t.after(() => fixture.close());
  const legacy = insertLegacy(fixture.db, 'migration', 'старый пароль');
  const first = await fixture.manager.startEmailBinding({
    userId: legacy.id, password: legacy.password, email: 'first@example.com',
    requestId: 'binding-first-01', ip: '203.0.113.62',
  });
  const firstCode = latest(fixture.mailer.messages, 'code').code;
  const second = await fixture.manager.startEmailBinding({
    userId: legacy.id, password: legacy.password, email: 'second@example.com',
    requestId: 'binding-second-01', ip: '203.0.113.62',
  });
  assert.throws(() => fixture.manager.verifyEmailBinding({
    userId: legacy.id, flowId: first.flowId, code: firstCode, ip: '203.0.113.62',
  }), errorCode('FLOW_CONSUMED'));
  assert.equal(fixture.manager.sessionState(legacy.id).activeBinding.flowId, second.flowId);

  const support = fixture.manager.createEmailBindingSupportCode({ id: 'u_denis', username: 'denis' }, legacy.id);
  assert.match(support.code, /^[0-9A-HJKMNP-TV-Z]{12}$/u);
  const recovered = await fixture.manager.startEmailBinding({
    userId: legacy.id, supportCode: support.code, email: 'recovered@example.com',
    requestId: 'binding-support-01', ip: '203.0.113.63',
  });
  assert.ok(recovered.flowId);
  await assert.rejects(fixture.manager.startEmailBinding({
    userId: legacy.id, supportCode: support.code, email: 'another@example.com',
    requestId: 'binding-support-02', ip: '203.0.113.63',
  }), errorCode('RECOVERY_CODE_REQUIRED'));
});

test('optional rollout stays usable without verified SMTP, while required mode fails closed', async () => {
  const mailer = { available: false };
  const fixture = setup({ mailer, codePepper: '', config: { emailEnforcement: 'optional' } });
  const legacy = insertLegacy(fixture.db, 'offline', 'старый пароль');
  assert.deepEqual(fixture.manager.sessionState(legacy.id), {
    emailAvailable: false,
    emailVerified: false,
    emailRequired: false,
    emailEnforced: false,
    ready: true,
    maskedEmail: '',
    activeBinding: null,
  });
  await assert.rejects(fixture.manager.startEmailBinding({
    userId: legacy.id, password: legacy.password, email: 'offline@example.com', requestId: 'binding-offline-1', ip: '127.0.0.1',
  }), errorCode('EMAIL_UNAVAILABLE'));
  assert.equal(fixture.manager.checkLoginRate({ username: legacy.username, ip: '127.0.0.1' }).allowed, true);
  fixture.close();

  const db = new Database(':memory:');
  createUsersTable(db);
  assert.throws(() => createAuthManager({
    db, mailer, codePepper: '', sessionSecret: 'secret', config: { emailEnforcement: 'required' },
  }), /requires a 32-byte code pepper/u);
  db.close();

  const sharedSecretDb = new Database(':memory:');
  createUsersTable(sharedSecretDb);
  const sharedSecret = 's'.repeat(64);
  assert.throws(() => createAuthManager({
    db: sharedSecretDb,
    mailer,
    codePepper: Buffer.from(sharedSecret, 'utf8'),
    sessionSecret: sharedSecret,
    config: { emailEnforcement: 'optional' },
  }), /must differ from SESSION_SECRET/u);
  sharedSecretDb.close();
});

test('forgot-password response is neutral; a 256-bit one-use token resets the password and all sessions', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const { manager, db, mailer } = fixture;
  const invite = manager.currentInvite({ username: 'denis' });
  const challenge = await manager.startRegistration({
    username: 'recover', password: STRONG_PASSWORD, email: 'recover@example.com',
    inviteCode: invite.code, requestId: 'signup-recovery-01', ip: '203.0.113.30',
  });
  const user = manager.verifyRegistration({
    flowId: challenge.flowId, code: latest(mailer.messages, 'code').code, ip: '203.0.113.30',
  }).user;
  const oldToken = manager.issueSession(user.id);
  const response = await manager.startPasswordReset({ email: 'recover@example.com', ip: '203.0.113.30' });
  assert.deepEqual(response, { accepted: true });
  assert.equal(JSON.stringify(response).includes('token'), false);
  await immediate();
  const firstResetMail = latest(mailer.messages, 'reset');
  assert.equal(firstResetMail.username, 'recover');
  assert.match(firstResetMail.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(manager.inspectPasswordReset({ token: firstResetMail.token, ip: '203.0.113.30' }).valid, true);

  fixture.advance(1001);
  assert.deepEqual(await manager.startPasswordReset({ email: 'recover@example.com', ip: '203.0.113.30' }), { accepted: true });
  await immediate();
  const resetMail = latest(mailer.messages, 'reset');
  assert.notEqual(resetMail.token, firstResetMail.token);
  assert.throws(() => manager.inspectPasswordReset({ token: firstResetMail.token, ip: '203.0.113.30' }), errorCode('RESET_INVALID'));
  assert.equal(resetMail.username, 'recover');
  assert.match(resetMail.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(manager.inspectPasswordReset({ token: resetMail.token, ip: '203.0.113.30' }).valid, true);

  const newPassword = 'Совершенно новый длинный пароль 2026!';
  assert.deepEqual(await manager.completePasswordReset({ token: resetMail.token, newPassword, ip: '203.0.113.30' }), {
    ok: true, userId: user.id, username: 'recover',
  });
  const storedHash = db.prepare('SELECT passhash FROM users WHERE id=?').get(user.id).passhash;
  assert.match(storedHash, /^prehash-v1\$/u);
  assert.equal(await manager.comparePassword(storedHash, newPassword), true);
  assert.throws(() => manager.verifySession(oldToken), errorCode('SESSION_REVOKED'));
  await assert.rejects(manager.completePasswordReset({ token: resetMail.token, newPassword, ip: '203.0.113.30' }), errorCode('RESET_INVALID'));
  await immediate();
  const changed = latest(mailer.messages, 'changed');
  assert.equal(changed.username, 'recover');
  assert.equal('token' in changed || 'password' in changed, false);

  const before = mailer.messages.length;
  assert.deepEqual(await manager.startPasswordReset({ email: 'missing@example.com', ip: '203.0.113.31' }), { accepted: true });
  await immediate();
  assert.equal(mailer.messages.length, before);
});

test('authenticated password change keeps a fresh session, revokes old sessions and pending reset links', async (t) => {
  const fixture = setup({ config: { passwordChangeFailureLimit: 2 } });
  t.after(() => fixture.close());
  const { manager, db, mailer } = fixture;
  const currentPassword = `test-${STRONG_PASSWORD}`;
  const invite = manager.currentInvite({ username: 'denis' });
  const challenge = await manager.startRegistration({
    username: 'passwordowner', password: currentPassword, email: 'passwordowner@example.com',
    inviteCode: invite.code, requestId: 'signup-password-owner', ip: '203.0.113.70',
  });
  const user = manager.verifyRegistration({
    flowId: challenge.flowId, code: latest(mailer.messages, 'code').code, ip: '203.0.113.70',
  }).user;
  const oldToken = manager.issueSession(user.id);

  await manager.startPasswordReset({ email: 'passwordowner@example.com', ip: '203.0.113.71' });
  await immediate();
  const pendingReset = latest(mailer.messages, 'reset').token;
  const nextPassword = 'Новая безопасная парольная фраза 2026!';
  const changed = await manager.changePassword({
    userId: user.id, currentPassword, newPassword: nextPassword, ip: '203.0.113.70',
  });
  assert.deepEqual(changed, {
    ok: true, userId: user.id, username: 'passwordowner', sessionVersion: 1,
  });
  assert.throws(() => manager.verifySession(oldToken), errorCode('SESSION_REVOKED'));
  const freshToken = manager.issueSession(user.id);
  assert.equal(manager.verifySession(freshToken, { requireVerified: true }).user.id, user.id);
  const stored = db.prepare('SELECT passhash,password_changed_at,session_version FROM users WHERE id=?').get(user.id);
  assert.match(stored.passhash, /^prehash-v1\$/u);
  assert.equal(stored.password_changed_at, fixture.now());
  assert.equal(stored.session_version, 1);
  assert.equal(await manager.comparePassword(stored.passhash, currentPassword), false);
  assert.equal(await manager.comparePassword(stored.passhash, nextPassword), true);
  assert.throws(() => manager.inspectPasswordReset({ token: pendingReset, ip: '203.0.113.71' }), errorCode('RESET_INVALID'));
  await immediate();
  const notification = latest(mailer.messages, 'changed');
  assert.equal(notification.username, 'passwordowner');
  assert.equal('password' in notification || 'token' in notification, false);

  await assert.rejects(manager.changePassword({
    userId: user.id, currentPassword: 'неверный пароль', newPassword: 'Ещё одна безопасная парольная фраза!', ip: '203.0.113.72',
  }), (error) => errorCode('INVALID_CURRENT_PASSWORD')(error) && error.details.attemptsRemaining === 1);
  await assert.rejects(manager.changePassword({
    userId: user.id, currentPassword: 'снова неверный', newPassword: 'Ещё одна безопасная парольная фраза!', ip: '203.0.113.73',
  }), (error) => errorCode('INVALID_CURRENT_PASSWORD')(error) && error.details.attemptsRemaining === 0);
  await assert.rejects(manager.changePassword({
    userId: user.id, currentPassword: 'третья попытка', newPassword: 'Ещё одна безопасная парольная фраза!', ip: '203.0.113.74',
  }), errorCode('PASSWORD_CHANGE_RATE_LIMITED'));
  await assert.rejects(manager.changePassword({
    userId: user.id, currentPassword: nextPassword, newPassword: nextPassword, ip: '203.0.113.75',
  }), errorCode('PASSWORD_CHANGE_RATE_LIMITED'));
  fixture.advance(15 * 60 * 1000 + 1);
  await assert.rejects(manager.changePassword({
    userId: user.id, currentPassword: nextPassword, newPassword: nextPassword, ip: '203.0.113.75',
  }), errorCode('PASSWORD_UNCHANGED'));
});

test('parallel password changes use compare-and-swap so only one request can win', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const currentPassword = 'Исходная безопасная парольная фраза!';
  const passhash = await fixture.manager.hashPassword(currentPassword);
  fixture.db.prepare(`INSERT INTO users(
    id,username,display_name,passhash,avatar_color,bio,is_admin,created,email,email_key,email_verified_at
  ) VALUES('u_password_race','passwordrace','passwordrace',?,0,'',0,1,'race@example.com','race@example.com',1)`).run(passhash);
  const attempts = await Promise.allSettled([
    fixture.manager.changePassword({
      userId: 'u_password_race', currentPassword, newPassword: 'Первый новый безопасный пароль 2026!', ip: '203.0.113.74',
    }),
    fixture.manager.changePassword({
      userId: 'u_password_race', currentPassword, newPassword: 'Второй новый безопасный пароль 2026!', ip: '203.0.113.74',
    }),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find((result) => result.status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  if (rejected?.status === 'rejected') assert.equal(rejected.reason.code, 'PASSWORD_CHANGE_CONFLICT');
  assert.equal(fixture.db.prepare('SELECT session_version FROM users WHERE id=?').get('u_password_race').session_version, 1);
  await immediate();
  assert.equal(fixture.mailer.messages.filter((message) => message.kind === 'changed').length, 1);
});

test('login throttling persists per username and IP without making a public username globally lockable', (t) => {
  const fixture = setup({ config: { loginAccountFailureLimit: 2 } });
  t.after(() => fixture.close());
  const { manager, db, mailer, now } = fixture;
  manager.checkLoginRate({ username: 'victim', ip: '203.0.113.40' });
  manager.checkLoginRate({ username: 'victim', ip: '203.0.113.40', success: false });
  manager.checkLoginRate({ username: 'victim', ip: '203.0.113.40', success: false });
  assert.equal(manager.checkLoginRate({ username: 'victim', ip: '203.0.113.40' }).allowed, true);
  assert.throws(() => manager.checkLoginRate({
    username: 'victim', ip: '203.0.113.40', success: false,
  }), errorCode('LOGIN_RATE_LIMITED'));
  const recreated = createAuthManager({
    db, mailer, codePepper: 'p'.repeat(64), sessionSecret: 'test-session-secret', now,
    config: { bcryptRounds: 4, loginAccountFailureLimit: 2 },
  });
  assert.equal(recreated.checkLoginRate({ username: 'victim', ip: '203.0.113.40' }).allowed, true);
  assert.throws(() => recreated.checkLoginRate({
    username: 'victim', ip: '203.0.113.40', success: false,
  }), errorCode('LOGIN_RATE_LIMITED'));
  assert.equal(recreated.checkLoginRate({ username: 'victim', ip: '203.0.113.41' }).allowed, true);
  assert.equal(recreated.checkLoginRate({
    username: 'victim', ip: '203.0.113.41', success: false,
  }).allowed, true);
  recreated.checkLoginRate({ username: 'victim', ip: '203.0.113.40', success: true });
  assert.equal(recreated.checkLoginRate({
    username: 'victim', ip: '203.0.113.40', success: false,
  }).allowed, true);
});

test('purgeUser removes pending authentication state', async (t) => {
  const fixture = setup();
  t.after(() => fixture.close());
  const legacy = insertLegacy(fixture.db, 'purged', 'старый пароль');
  await fixture.manager.startEmailBinding({
    userId: legacy.id, password: legacy.password, email: 'purged@example.com',
    requestId: 'binding-purge-01', ip: '203.0.113.50',
  });
  fixture.manager.purgeUser(legacy.id);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM auth_email_flows WHERE user_id=?').get(legacy.id).count, 0);
});

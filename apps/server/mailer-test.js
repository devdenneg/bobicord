'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSmtpMailer,
  loadMailerConfig,
  buildPasswordResetMessage,
} = require('./mailer');

function smtpFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mailer-'));
  const passwordFile = path.join(directory, 'smtp-password');
  fs.writeFileSync(passwordFile, 'correct horse battery staple\n', { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    APP_PUBLIC_URL: 'https://reelay.online',
    MAIL_FROM_NAME: 'RelayApp',
    MAIL_FROM_ADDRESS: 'no-reply@reelay.online',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: '0',
    SMTP_REQUIRE_TLS: '1',
    SMTP_USER: 'relay-user',
    SMTP_PASSWORD_FILE: passwordFile,
  };
}

test('missing SMTP configuration stays unavailable without attempting delivery', async () => {
  const mailer = createSmtpMailer({ env: {} });
  assert.equal(mailer.configured, false);
  assert.equal(await mailer.verify(), false);
  await assert.rejects(() => mailer.sendEmailCode({ to: 'user@example.com', code: '1234' }), {
    code: 'MAIL_UNAVAILABLE',
  });

  const composeDefault = loadMailerConfig({
    SMTP_PASSWORD_FILE: '/run/secrets/smtp_password',
    APP_PUBLIC_URL: 'https://reelay.online',
  });
  assert.equal(composeDefault.configured, false);
});

test('SMTP password is read from a file and remains absent from serialised configuration', (t) => {
  const config = loadMailerConfig(smtpFixture(t));
  assert.equal(config.configured, true);
  assert.equal(config.password, 'correct horse battery staple');
  assert.equal(Object.keys(config).includes('password'), false);
  assert.equal(JSON.stringify(config).includes('correct horse battery staple'), false);
});

test('SMTP transport enforces TLS and sends Russian code mail without URL or file access', async (t) => {
  let transportOptions = null;
  let delivered = null;
  const nodemailer = {
    createTransport(options) {
      transportOptions = options;
      return {
        async verify() { return true; },
        async sendMail(message) { delivered = message; return { accepted: [message.to] }; },
      };
    },
  };
  const mailer = createSmtpMailer({ env: smtpFixture(t), nodemailer });
  assert.equal(await mailer.verify(), true);
  await mailer.sendEmailCode({
    to: 'person@example.com',
    code: '0427',
    purpose: 'registration',
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  assert.equal(transportOptions.requireTLS, true);
  assert.equal(transportOptions.secure, false);
  assert.equal(transportOptions.tls.rejectUnauthorized, true);
  assert.equal(transportOptions.disableFileAccess, true);
  assert.equal(transportOptions.disableUrlAccess, true);
  assert.equal(delivered.to, 'person@example.com');
  assert.match(delivered.subject, /RelayApp/u);
  assert.match(delivered.text, /0427/u);
  assert.match(delivered.text, /регистрац/iu);
  assert.equal(delivered.disableFileAccess, true);
  assert.equal(delivered.disableUrlAccess, true);
});

test('SMTP configuration rejects plaintext authentication on custom submission ports', (t) => {
  assert.throws(() => loadMailerConfig({
    ...smtpFixture(t), SMTP_PORT: '2525', SMTP_SECURE: '0', SMTP_REQUIRE_TLS: '0',
  }), { code: 'MAIL_CONFIG_INVALID' });
});

test('recipient rejection does not trip the global breaker, but a transport failure does', async (t) => {
  const failures = [
    Object.assign(new Error('mailbox unavailable'), { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }),
    Object.assign(new Error('socket closed'), { code: 'ECONNECTION', command: 'CONN' }),
  ];
  const nodemailer = {
    createTransport() {
      return {
        async verify() { return true; },
        async sendMail() { throw failures.shift(); },
      };
    },
  };
  const mailer = createSmtpMailer({ env: smtpFixture(t), nodemailer });
  await mailer.verify();
  await assert.rejects(() => mailer.sendEmailCode({
    to: 'missing@example.com', code: '1234', purpose: 'registration', expiresAt: Date.now() + 60_000,
  }), { code: 'MAIL_DELIVERY_FAILED' });
  assert.equal(mailer.available, true);
  await assert.rejects(() => mailer.sendEmailCode({
    to: 'user@example.com', code: '1234', purpose: 'registration', expiresAt: Date.now() + 60_000,
  }), { code: 'MAIL_DELIVERY_FAILED' });
  assert.equal(mailer.available, false);
  assert.equal(await mailer.verify(), true);
  assert.equal(mailer.available, true);
});

test('password reset uses a one-use random token in the fragment and escapes account data', () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const message = buildPasswordResetMessage({
    username: '<img src=x onerror=alert(1)>',
    token,
    expiresAt: Date.now() + 15 * 60 * 1000,
    appPublicUrl: 'https://reelay.online',
  });
  assert.match(message.text, new RegExp(`/reset-password#token=${token}`));
  assert.doesNotMatch(message.text, /\?token=/u);
  assert.doesNotMatch(message.html, /<img src=x/u);
  assert.match(message.html, /&lt;img/u);
});

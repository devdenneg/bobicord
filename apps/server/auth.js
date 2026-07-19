'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { domainToASCII } = require('url');

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const FLOW_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^\d{4}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PASSWORD_HASH_PREFIX = 'prehash-v1$';
const COMMON_PASSWORDS = new Set([
  '123456789012345', '1234567890123456', 'qwertyuiopasdfg', 'qwertyuiopasdfgh',
  'passwordpassword', 'password123456', 'adminadminadmin', 'letmeinletmein123',
  'relayapprelayapp', 'reelayreelay123', 'iloveyouiloveyou', 'abc123abc123abc',
  'qwerty123456789', 'qwertyuiop12345', 'asdfghjkl123456', 'zxcvbnm12345678',
  'administrator123', 'welcome123456789', 'password123456789', 'парольпарольпароль',
  'йцукенгшщзхъ1234', 'любовьлюбовь1234',
]);

const DEFAULTS = Object.freeze({
  emailCodeTtlMs: 10 * 60 * 1000,
  emailFlowMaxMs: 30 * 60 * 1000,
  emailCodeMaxAttempts: 5,
  sendCooldownMs: 60 * 1000,
  sendMaxPerHour: 5,
  resetTtlMs: 30 * 60 * 1000,
  resetSendCooldownMs: 60 * 1000,
  resetResponseMinMs: 300,
  inviteTimeZone: 'Europe/Moscow',
  inviteMaxUses: 25,
  inviteMaxSends: 50,
  bcryptRounds: 12,
  bcryptConcurrency: 4,
  bcryptQueueLimit: 32,
  sessionTtl: '30d',
  emailEnforcement: 'optional',
  loginIpLimit: 30,
  loginAccountFailureLimit: 8,
});

class AuthError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new AuthError(status, code, message, details);
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    fail(400, 'INVALID_USERNAME', 'Логин: 3–20 символов, латиница, цифры или _.');
  }
  return username;
}

function normalizeEmail(value) {
  const raw = String(value || '').normalize('NFC').trim();
  if (!raw || raw.length > 254 || /[\u0000-\u0020\u007f]/u.test(raw)) {
    fail(400, 'INVALID_EMAIL', 'Введите корректный адрес электронной почты.');
  }
  const at = raw.lastIndexOf('@');
  if (at < 1 || at !== raw.indexOf('@')) fail(400, 'INVALID_EMAIL', 'Введите корректный адрес электронной почты.');
  const local = raw.slice(0, at);
  const asciiDomain = domainToASCII(raw.slice(at + 1)).toLowerCase();
  if (!local || Buffer.byteLength(local, 'utf8') > 64 || !asciiDomain || asciiDomain.length > 253
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) {
    fail(400, 'INVALID_EMAIL', 'Введите корректный адрес электронной почты.');
  }
  const labels = asciiDomain.split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63
    || !/^[a-z0-9-]+$/u.test(label) || label.startsWith('-') || label.endsWith('-'))) {
    fail(400, 'INVALID_EMAIL', 'Введите корректный адрес электронной почты.');
  }
  // Политику сравнения фиксируем явно: без provider-specific преобразований точек и plus-tags.
  // Local-part case-sensitive по SMTP, но практически все пользовательские провайдеры сравнивают
  // его без регистра; для однозначного восстановления один адрес занимает один аккаунт.
  const email = `${local}@${asciiDomain}`;
  return { email, key: email.toLowerCase() };
}

function validatePassword(value, context = {}) {
  const password = String(value || '').normalize('NFC');
  const length = Array.from(password).length;
  if (length < 15) fail(400, 'WEAK_PASSWORD', 'Пароль должен содержать не менее 15 символов.');
  if (length > 64) fail(400, 'PASSWORD_TOO_LONG', 'Пароль должен быть не длиннее 64 символов.');
  const folded = password.toLocaleLowerCase('ru-RU').replace(/\s+/gu, '');
  const repeatedUnit = /^(.{1,8})\1{2,}$/u.test(folded);
  const predictableSequence = /^\d+$/u.test(folded)
    || /(?:0123456789|1234567890|9876543210|qwertyuiop|asdfghjkl|zxcvbnm|йцукенгшщз|фывапролдж|ячсмитьбю)/u.test(folded);
  if (COMMON_PASSWORDS.has(folded) || repeatedUnit || predictableSequence) {
    fail(400, 'WEAK_PASSWORD', 'Выберите менее распространённый и непредсказуемый пароль.');
  }
  const pieces = [];
  if (context.username) pieces.push(String(context.username).toLowerCase());
  if (context.email) pieces.push(String(context.email).split('@')[0].toLowerCase());
  if (pieces.some((piece) => piece.length >= 3 && folded.includes(piece.replace(/\s+/gu, '')))) {
    fail(400, 'WEAK_PASSWORD', 'Пароль не должен содержать логин или адрес почты.');
  }
  return password;
}

function passwordLoginCandidates(value) {
  const raw = String(value || '');
  const normalized = raw.normalize('NFC');
  return normalized === raw ? [raw] : [raw, normalized];
}

function passwordPrehash(value) {
  return crypto.createHash('sha256')
    .update('RelayApp password prehash v1\0', 'utf8')
    .update(String(value || '').normalize('NFC'), 'utf8')
    .digest('base64url');
}

function formatPasswordHash(bcryptHash) {
  return PASSWORD_HASH_PREFIX + String(bcryptHash || '');
}

function readCodePepperFile(file) {
  const location = String(file || '').trim();
  if (!location || /[\r\n\u0000]/u.test(location)) return Buffer.alloc(0);
  try {
    const stat = fs.statSync(location);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024) return Buffer.alloc(0);
    const value = fs.readFileSync(location, 'utf8').replace(/(?:\r\n|\n|\r)+$/u, '');
    const lowered = value.toLocaleLowerCase('en-US');
    if (Buffer.byteLength(value, 'utf8') < 32 || /\s/u.test(value)
      || /(change[_-]?me|placeholder|example|dev-secret)/iu.test(lowered)
      || value.split('').every((character) => character === value[0])) return Buffer.alloc(0);
    return Buffer.from(value, 'utf8');
  } catch {
    return Buffer.alloc(0);
  }
}

function maskEmail(value) {
  const email = String(value || '');
  const at = email.lastIndexOf('@');
  if (at < 1) return '';
  const local = email.slice(0, at);
  const shown = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, Math.min(6, local.length - shown.length)))}@${email.slice(at + 1)}`;
}

// The full address is account-private data. Call this helper only while serializing the
// authenticated account owner; public member/profile payloads must never use it.
function verifiedEmailForOwner(row) {
  return row && row.email_verified_at ? String(row.email || '') : '';
}

function ensureUserColumn(db, name, definition) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!columns.size) throw new Error('installAuthSchema requires an existing users table');
  if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}

function installAuthSchema(db) {
  ensureUserColumn(db, 'email', "TEXT NOT NULL DEFAULT ''");
  ensureUserColumn(db, 'email_key', "TEXT NOT NULL DEFAULT ''");
  ensureUserColumn(db, 'email_verified_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureUserColumn(db, 'session_version', 'INTEGER NOT NULL DEFAULT 0');
  ensureUserColumn(db, 'password_changed_at', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verified_email
      ON users(email_key) WHERE email_key <> '' AND email_verified_at > 0;

    CREATE TABLE IF NOT EXISTS auth_email_flows(
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('registration','binding')),
      user_id TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      email_key TEXT NOT NULL,
      passhash TEXT NOT NULL DEFAULT '',
      invite_day TEXT NOT NULL DEFAULT '',
      invite_generation INTEGER NOT NULL DEFAULT 0,
      code_generation INTEGER NOT NULL DEFAULT 0,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sends INTEGER NOT NULL DEFAULT 1,
      send_window_started INTEGER NOT NULL,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      absolute_expires INTEGER NOT NULL,
      resend_after INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_auth_email_flow_user
      ON auth_email_flows(user_id, purpose, consumed, absolute_expires);
    CREATE INDEX IF NOT EXISTS idx_auth_email_flow_identity
      ON auth_email_flows(username, email_key, purpose, consumed);

    CREATE TABLE IF NOT EXISTS auth_email_binding_support(
      user_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_password_resets(
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_auth_password_reset_user
      ON auth_password_resets(user_id, used, expires);

    CREATE TABLE IF NOT EXISTS auth_rate_limits(
      scope TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      window_started INTEGER NOT NULL,
      count INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      PRIMARY KEY(scope, key_hash)
    );

    CREATE TABLE IF NOT EXISTS auth_registration_invites(
      day TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0,
      email_sends INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL,
      max_sends INTEGER NOT NULL DEFAULT 50,
      rotated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const flowColumns = new Set(db.prepare('PRAGMA table_info(auth_email_flows)').all().map((column) => column.name));
  if (!flowColumns.has('delivery_started')) {
    db.exec('ALTER TABLE auth_email_flows ADD COLUMN delivery_started INTEGER NOT NULL DEFAULT 0');
  }
  const inviteColumns = new Set(db.prepare('PRAGMA table_info(auth_registration_invites)').all().map((column) => column.name));
  if (!inviteColumns.has('email_sends')) {
    db.exec('ALTER TABLE auth_registration_invites ADD COLUMN email_sends INTEGER NOT NULL DEFAULT 0');
  }
  if (!inviteColumns.has('max_sends')) {
    db.exec('ALTER TABLE auth_registration_invites ADD COLUMN max_sends INTEGER NOT NULL DEFAULT 50');
  }
}

// This database invariant survives an application rollback: the removed public /api/register
// route from an older image cannot silently create another account without verified email.
// Install only after the one-time users.json migration has completed.
function installVerifiedRegistrationGuard(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS auth_require_verified_email_before_user_insert
    BEFORE INSERT ON users
    WHEN NEW.email_key = '' OR NEW.email_verified_at <= 0
    BEGIN
      SELECT RAISE(ABORT, 'verified email required');
    END;
  `);
}

function encodeCrockford(buffer, length) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (output.length >= length) break;
    value &= bits ? (1 << bits) - 1 : 0;
  }
  if (bits > 0 && output.length < length) output += CROCKFORD[(value << (5 - bits)) & 31];
  return output.slice(0, length);
}

function dayKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextDayBoundary(timestamp, timeZone) {
  const current = dayKey(timestamp, timeZone);
  let low = timestamp;
  let high = timestamp + 30 * 60 * 60 * 1000;
  while (dayKey(high, timeZone) === current) high += 24 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dayKey(middle, timeZone) === current) low = middle;
    else high = middle;
  }
  return high;
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAuthManager(options) {
  if (!options || !options.db) throw new TypeError('createAuthManager requires db');
  const db = options.db;
  const mailer = options.mailer || null;
  const bcryptImpl = options.bcryptImpl || bcrypt;
  const logger = options.logger || { warn() {}, error() {} };
  const now = options.now || (() => Date.now());
  const config = { ...DEFAULTS, ...(options.config || {}) };
  const pepper = Buffer.isBuffer(options.codePepper)
    ? Buffer.from(options.codePepper)
    : Buffer.from(String(options.codePepper || ''), 'utf8');
  const sessionSecret = String(options.sessionSecret || '');
  if (pepper.length > 0 && sessionSecret && safeEqual(pepper, Buffer.from(sessionSecret, 'utf8'))) {
    throw new Error('AUTH_CODE_PEPPER must differ from SESSION_SECRET');
  }
  const rateSecret = pepper.length >= 32
    ? pepper
    : crypto.createHash('sha256').update(`auth-rate\0${sessionSecret}`).digest();
  let bcryptActive = 0;
  const bcryptWaiters = [];

  installAuthSchema(db);

  function isEmailAvailable() {
    return pepper.length >= 32 && !!mailer && mailer.available !== false;
  }
  if (config.emailEnforcement === 'required' && pepper.length < 32) {
    throw new Error('AUTH_EMAIL_ENFORCEMENT=required requires a 32-byte code pepper');
  }

  function ensureEmailAvailable() {
    if (!isEmailAvailable()) fail(503, 'EMAIL_UNAVAILABLE', 'Отправка почты временно недоступна. Попробуйте позже.');
  }

  function ensurePepperAvailable() {
    if (pepper.length < 32) fail(503, 'AUTH_UNAVAILABLE', 'Управление доступом временно недоступно.');
  }

  function hmac(label, value) {
    if (pepper.length < 32) fail(503, 'EMAIL_UNAVAILABLE', 'Отправка почты временно недоступна. Попробуйте позже.');
    return crypto.createHmac('sha256', pepper).update(`${label}\0${value}`).digest('hex');
  }

  function requestKey(purpose, owner, requestId) {
    const value = String(requestId || '');
    if (!REQUEST_ID_RE.test(value)) fail(400, 'INVALID_REQUEST_ID', 'Повторите действие ещё раз.');
    return hmac('request-id', `${purpose}\0${owner}\0${value}`);
  }

  function fingerprint(purpose, values) {
    return hmac('request-fingerprint', `${purpose}\0${values.map((value) => String(value)).join('\0')}`);
  }

  function codeFor(flowId, generation) {
    const digest = crypto.createHmac('sha256', pepper)
      .update(`email-code\0${flowId}\0${generation}`).digest();
    const value = digest.readUInt32BE(0) % 10000;
    return String(value).padStart(4, '0');
  }

  function hashCode(flowId, generation, code) {
    return hmac('email-code-proof', `${flowId}\0${generation}\0${code}`);
  }

  function flowView(row, idempotent = false) {
    return {
      flowId: row.id,
      challengeId: row.id,
      maskedEmail: maskEmail(row.email),
      emailMasked: maskEmail(row.email),
      expiresAt: row.expires,
      resendAt: row.resend_after,
      attemptsRemaining: Math.max(0, config.emailCodeMaxAttempts - row.attempts),
      delivered: !!row.delivered,
      idempotent,
    };
  }

  function publicUser(row) {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url || '',
      profileBannerUrl: row.profile_banner_url || '',
      bio: row.bio || '',
      isAdmin: !!row.is_admin || row.username === 'denis',
      emailVerified: !!row.email_verified_at,
      emailRequired: !row.email_verified_at && (config.emailEnforcement === 'required'
        || (config.emailEnforcement === 'optional' && isEmailAvailable())),
      maskedEmail: row.email_verified_at ? maskEmail(row.email) : '',
      sessionVersion: Number(row.session_version) || 0,
    };
  }

  const runRateTx = db.transaction((scope, keyHash, limit, windowMs, at) => {
    const row = db.prepare('SELECT * FROM auth_rate_limits WHERE scope=? AND key_hash=?').get(scope, keyHash);
    if (!row || at - row.window_started >= windowMs) {
      db.prepare(`INSERT INTO auth_rate_limits(scope,key_hash,window_started,count,updated) VALUES(?,?,?,?,?)
        ON CONFLICT(scope,key_hash) DO UPDATE SET window_started=excluded.window_started,count=excluded.count,updated=excluded.updated`)
        .run(scope, keyHash, at, 1, at);
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterMs: 0 };
    }
    if (row.count >= limit) return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, windowMs - (at - row.window_started)) };
    db.prepare('UPDATE auth_rate_limits SET count=count+1,updated=? WHERE scope=? AND key_hash=?').run(at, scope, keyHash);
    return { allowed: true, remaining: Math.max(0, limit - row.count - 1), retryAfterMs: 0 };
  });

  function rateHash(scope, subject) {
    return crypto.createHmac('sha256', rateSecret).update(`rate-key\0${scope}\0${subject}`).digest('hex');
  }

  function consumeRate(scope, subject, limit, windowMs, { quiet = false } = {}) {
    const result = runRateTx.immediate
      ? runRateTx.immediate(scope, rateHash(scope, subject), limit, windowMs, now())
      : runRateTx(scope, rateHash(scope, subject), limit, windowMs, now());
    if (!result.allowed && !quiet) {
      fail(429, 'RATE_LIMITED', 'Слишком много попыток. Попробуйте позже.', { retryAfterMs: result.retryAfterMs });
    }
    return result;
  }

  function clearRate(scope, subject) {
    db.prepare('DELETE FROM auth_rate_limits WHERE scope=? AND key_hash=?')
      .run(scope, rateHash(scope, subject));
  }

  function normalizedIp(ip) {
    let value = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/gu, '');
    const zone = value.indexOf('%');
    if (zone >= 0) value = value.slice(0, zone);
    const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
    if (mapped && net.isIP(mapped[1]) === 4) value = mapped[1];
    if (net.isIP(value) === 4) return value.split('.').map((part) => String(Number(part))).join('.');
    if (net.isIP(value) !== 6) return (value || 'unknown').slice(0, 128);
    const halves = value.split('::');
    const parseHalf = (half) => half ? half.split(':').filter(Boolean).flatMap((part) => {
      if (net.isIP(part) === 4) {
        const bytes = part.split('.').map(Number);
        return [((bytes[0] << 8) | bytes[1]).toString(16), ((bytes[2] << 8) | bytes[3]).toString(16)];
      }
      return [part];
    }) : [];
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] || '');
    const zeros = Math.max(0, 8 - left.length - right.length);
    return [...left, ...Array(zeros).fill('0'), ...right]
      .map((part) => Number.parseInt(part || '0', 16).toString(16)).join(':');
  }

  function consumeIpRate(scope, ip, limit, windowMs, options) {
    const exact = normalizedIp(ip);
    const exactResult = consumeRate(scope, exact, limit, windowMs, options);
    if (!exactResult.allowed || net.isIP(exact) !== 6) return exactResult;
    const prefix = `${exact.split(':').slice(0, 4).join(':')}::/64`;
    return consumeRate(`${scope}-network`, prefix, Math.max(limit, limit * 4), windowMs, options);
  }

  async function withBcryptSlot(work) {
    const limit = Math.max(1, Math.min(16, Number(config.bcryptConcurrency) || 4));
    const queueLimit = Math.max(limit, Math.min(256, Number(config.bcryptQueueLimit) || 32));
    if (bcryptActive >= limit) {
      if (bcryptWaiters.length >= queueLimit) {
        fail(503, 'AUTH_BUSY', 'Сервис авторизации занят. Повторите через несколько секунд.', { retryAfterMs: 3000 });
      }
      await new Promise((resolve) => bcryptWaiters.push(resolve));
    }
    bcryptActive += 1;
    try { return await work(); }
    finally {
      bcryptActive -= 1;
      const next = bcryptWaiters.shift();
      if (next) next();
    }
  }

  async function comparePassword(passhash, value) {
    const stored = String(passhash || '');
    if (stored.startsWith(PASSWORD_HASH_PREFIX)) {
      return withBcryptSlot(() => bcryptImpl.compare(passwordPrehash(value), stored.slice(PASSWORD_HASH_PREFIX.length)));
    }
    return withBcryptSlot(async () => {
      for (const candidate of passwordLoginCandidates(value)) {
        if (await bcryptImpl.compare(candidate, stored)) return true;
      }
      return false;
    });
  }

  async function hashPassword(value) {
    const digest = passwordPrehash(value);
    return formatPasswordHash(await withBcryptSlot(() => bcryptImpl.hash(digest, config.bcryptRounds)));
  }

  function inviteCode(day, generation) {
    const digest = crypto.createHmac('sha256', pepper)
      .update(`daily-invite\0${day}\0${generation}`).digest();
    return encodeCrockford(digest, 20);
  }

  function normalizeInvite(value) {
    return String(value || '').toUpperCase().replace(/[\s-]+/gu, '');
  }

  function inviteRowFor(day) {
    db.prepare(`INSERT OR IGNORE INTO auth_registration_invites(
      day,generation,uses,email_sends,max_uses,max_sends,rotated_at
    ) VALUES(?,0,0,0,?,?,0)`).run(day, config.inviteMaxUses, config.inviteMaxSends);
    // Конфигурация лимитов является текущей политикой, а не только значением при первом
    // создании строки. Понижение лимита начинает действовать сразу и не обнуляет счётчики.
    db.prepare(`UPDATE auth_registration_invites SET max_uses=?,max_sends=?
      WHERE day=? AND (max_uses<>? OR max_sends<>?)`)
      .run(config.inviteMaxUses, config.inviteMaxSends, day, config.inviteMaxUses, config.inviteMaxSends);
    return db.prepare('SELECT * FROM auth_registration_invites WHERE day=?').get(day);
  }

  function requireDenis(user) {
    if (!user || user.username !== 'denis') fail(403, 'DENIS_ONLY', 'Пригласительный код доступен только denis.');
  }

  function currentInvite(user) {
    ensurePepperAvailable();
    requireDenis(user);
    const at = now();
    const day = dayKey(at, config.inviteTimeZone);
    const row = inviteRowFor(day);
    return {
      code: inviteCode(day, row.generation),
      day,
      generation: row.generation,
      uses: row.uses,
      maxUses: row.max_uses,
      emailSends: row.email_sends,
      maxEmailSends: row.max_sends,
      validUntil: nextDayBoundary(at, config.inviteTimeZone),
    };
  }

  function rotateInvite(user) {
    ensurePepperAvailable();
    requireDenis(user);
    const at = now();
    const day = dayKey(at, config.inviteTimeZone);
    inviteRowFor(day);
    const rotate = db.transaction(() => {
      db.prepare(`UPDATE auth_registration_invites SET
        generation=generation+1,uses=0,email_sends=0,max_uses=?,max_sends=?,rotated_at=? WHERE day=?`)
        .run(config.inviteMaxUses, config.inviteMaxSends, at, day);
      // Экстренная ротация должна отзывать уже начатые регистрации любой даты. Иначе код,
      // созданный до полуночи, переживёт ручную ротацию следующего суточного кода.
      db.prepare("UPDATE auth_email_flows SET consumed=1 WHERE purpose='registration' AND consumed=0").run();
    });
    rotate.immediate ? rotate.immediate() : rotate();
    return currentInvite(user);
  }

  function validateCurrentInvite(value) {
    const day = dayKey(now(), config.inviteTimeZone);
    const row = inviteRowFor(day);
    const supplied = normalizeInvite(value);
    const expected = inviteCode(day, row.generation);
    if (!safeEqual(supplied, expected)) fail(403, 'INVALID_INVITE', 'Пригласительный код недействителен.');
    if (row.uses >= row.max_uses) fail(403, 'INVITE_EXHAUSTED', 'Лимит регистраций по этому коду исчерпан.');
    if (row.email_sends >= row.max_sends) {
      fail(403, 'INVITE_SENDS_EXHAUSTED', 'Лимит писем по этому коду исчерпан. denis может сразу обновить код.');
    }
    return { day, generation: row.generation };
  }

  async function deliverCode(row) {
    const code = codeFor(row.id, row.code_generation);
    await mailer.sendEmailCode({ to: row.email, code, purpose: row.purpose, expiresAt: row.expires });
    db.prepare('UPDATE auth_email_flows SET delivered=1,delivery_started=0 WHERE id=? AND code_generation=? AND consumed=0')
      .run(row.id, row.code_generation);
  }

  async function claimAndDeliver(row) {
    const at = now();
    const claimed = db.prepare(`UPDATE auth_email_flows SET delivery_started=?
      WHERE id=? AND code_generation=? AND consumed=0 AND delivered=0
        AND (delivery_started=0 OR delivery_started<?)`)
      .run(at, row.id, row.code_generation, at - 2 * 60 * 1000);
    if (claimed.changes !== 1) return db.prepare('SELECT * FROM auth_email_flows WHERE id=?').get(row.id);
    try {
      await deliverCode({ ...row, delivery_started: at });
    } catch (error) {
      db.prepare(`UPDATE auth_email_flows SET delivery_started=0
        WHERE id=? AND code_generation=? AND delivered=0`).run(row.id, row.code_generation);
      throw error;
    }
    return db.prepare('SELECT * FROM auth_email_flows WHERE id=?').get(row.id);
  }

  async function resumeIdempotentFlow(row, expectedFingerprint, ip) {
    if (!safeEqual(row.request_fingerprint, expectedFingerprint)) {
      fail(409, 'IDEMPOTENCY_CONFLICT', 'Этот запрос уже использован с другими данными.');
    }
    if (row.consumed) fail(409, 'FLOW_CONSUMED', 'Это подтверждение уже использовано.');
    if (row.absolute_expires <= now()) fail(410, 'FLOW_EXPIRED', 'Подтверждение устарело. Начните заново.');
    if (!row.delivered) {
      // A concurrent duplicate observes the in-flight lease and returns the same opaque flow.
      // After an actual failure delivery_started is reset; retries then go through the normal
      // cooldown, send counters and invite-wide email budget instead of hammering SMTP.
      if (row.delivery_started > now() - 2 * 60 * 1000) return flowView(row, true);
      return resendFlow({ flowId: row.id, ip }, row.purpose, row.purpose === 'binding' ? row.user_id : null);
    }
    if (row.expires <= now()) fail(410, 'FLOW_EXPIRED', 'Код устарел. Запросите новый.');
    return flowView(row, true);
  }

  function checkIdentityAvailability(username, emailKey) {
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)
      || db.prepare("SELECT 1 FROM users WHERE email_key=? AND email_verified_at>0").get(emailKey)) {
      fail(409, 'IDENTITY_UNAVAILABLE', 'Логин или адрес почты уже используется.');
    }
  }

  async function startRegistration(input) {
    ensureEmailAvailable();
    const username = normalizeUsername(input.username);
    if (username === 'denis') fail(409, 'IDENTITY_UNAVAILABLE', 'Логин или адрес почты уже используется.');
    const normalizedEmail = normalizeEmail(input.email);
    const password =
      validatePassword(input.password, { username, email: normalizedEmail.email });
    const key = requestKey('registration', 'public', input.requestId);
    const fp = fingerprint('registration', [username, normalizedEmail.key, password, normalizeInvite(input.inviteCode)]);
    const existing = db.prepare('SELECT * FROM auth_email_flows WHERE request_key=?').get(key);
    if (existing) return resumeIdempotentFlow(existing, fp, input.ip);

    consumeIpRate('registration-ip', input.ip, 5, 60 * 60 * 1000);
    const invite = validateCurrentInvite(input.inviteCode);
    // Invalid public invite guesses must not let an attacker burn another person's email/login
    // budget. Only a valid current invite reaches identity-specific throttles.
    consumeRate('registration-email', normalizedEmail.key, 3, 60 * 60 * 1000);
    consumeRate('registration-username', username, 3, 60 * 60 * 1000);
    checkIdentityAvailability(username, normalizedEmail.key);
    const passhash = await hashPassword(password);
    const at = now();
    const flowId = crypto.randomBytes(32).toString('base64url');
    const generation = 0;
    const expires = Math.min(at + config.emailCodeTtlMs, at + config.emailFlowMaxMs);
    const createRegistration = db.transaction(() => {
      const inserted = db.prepare(`INSERT OR IGNORE INTO auth_email_flows(
        id,request_key,request_fingerprint,purpose,user_id,username,email,email_key,passhash,
        invite_day,invite_generation,code_generation,code_hash,attempts,sends,send_window_started,
        created,expires,absolute_expires,resend_after,delivered,consumed
      ) VALUES(?,?,?,'registration','',?,?,?,?,?,?,?,?,0,1,?,?,?,?,?,0,0)`)
        .run(flowId, key, fp, username, normalizedEmail.email, normalizedEmail.key, passhash,
          invite.day, invite.generation, generation, hashCode(flowId, generation, codeFor(flowId, generation)),
          at, at, expires, at + config.emailFlowMaxMs, at + config.sendCooldownMs);
      const persisted = db.prepare('SELECT * FROM auth_email_flows WHERE request_key=?').get(key);
      if (inserted.changes === 1) {
        const reserved = db.prepare(`UPDATE auth_registration_invites SET email_sends=email_sends+1
          WHERE day=? AND generation=? AND email_sends<max_sends`).run(invite.day, invite.generation);
        if (reserved.changes !== 1) {
          const current = db.prepare('SELECT * FROM auth_registration_invites WHERE day=?').get(invite.day);
          if (!current || current.generation !== invite.generation) {
            fail(403, 'INVITE_REVOKED', 'Пригласительный код был отозван.');
          }
          fail(403, 'INVITE_SENDS_EXHAUSTED', 'Лимит писем по этому коду исчерпан. denis может сразу обновить код.');
        }
      }
      return { inserted: inserted.changes === 1, row: persisted };
    });
    const created = createRegistration.immediate ? createRegistration.immediate() : createRegistration();
    let row = created.row;
    if (!created.inserted) return resumeIdempotentFlow(row, fp, input.ip);
    try { row = await claimAndDeliver(row); }
    catch (error) {
      logger.warn?.('[auth] registration email delivery failed');
      fail(503, 'EMAIL_DELIVERY_FAILED', 'Не удалось отправить письмо. Попробуйте позже.');
    }
    return flowView(row, false);
  }

  function verifyCodeInTransaction(flowId, purpose, userId, code, onSuccess) {
    if (!FLOW_ID_RE.test(String(flowId || '')) || !CODE_RE.test(String(code || ''))) {
      fail(400, 'INVALID_CODE', 'Введите четыре цифры из письма.');
    }
    const transaction = db.transaction(() => {
      const row = db.prepare('SELECT * FROM auth_email_flows WHERE id=?').get(flowId);
      if (!row || row.purpose !== purpose || (userId != null && row.user_id !== userId)) {
        fail(400, 'INVALID_CODE', 'Код неверен или устарел.');
      }
      const at = now();
      if (row.consumed) fail(409, 'FLOW_CONSUMED', 'Это подтверждение уже использовано.');
      if (!row.delivered || row.expires <= at || row.absolute_expires <= at) {
        fail(410, 'FLOW_EXPIRED', 'Код устарел. Запросите новый.');
      }
      if (row.attempts >= config.emailCodeMaxAttempts) {
        fail(429, 'CODE_ATTEMPTS_EXCEEDED', 'Попытки закончились. Начните подтверждение заново.');
      }
      const expected = hashCode(row.id, row.code_generation, String(code));
      if (!safeEqual(expected, row.code_hash)) {
        db.prepare('UPDATE auth_email_flows SET attempts=attempts+1 WHERE id=?').run(row.id);
        const remaining = config.emailCodeMaxAttempts - row.attempts - 1;
        return remaining <= 0
          ? { verificationError: [429, 'CODE_ATTEMPTS_EXCEEDED', 'Попытки закончились. Начните подтверждение заново.'] }
          : { verificationError: [400, 'INVALID_CODE', 'Код неверен.', { attemptsRemaining: remaining }] };
      }
      const result = onSuccess(row, at);
      db.prepare('UPDATE auth_email_flows SET consumed=1 WHERE id=?').run(row.id);
      return result;
    });
    const result = transaction.immediate ? transaction.immediate() : transaction();
    if (result && result.verificationError) fail(...result.verificationError);
    return result;
  }

  function verifyRegistration(input) {
    ensurePepperAvailable();
    consumeIpRate('email-code-ip', input.ip, 30, 60 * 60 * 1000);
    const result = verifyCodeInTransaction(input.flowId, 'registration', null, input.code, (row, at) => {
      checkIdentityAvailability(row.username, row.email_key);
      const invite = inviteRowFor(row.invite_day);
      if (!invite || invite.generation !== row.invite_generation) {
        fail(403, 'INVITE_REVOKED', 'Пригласительный код был отозван.');
      }
      const used = db.prepare('UPDATE auth_registration_invites SET uses=uses+1 WHERE day=? AND generation=? AND uses<max_uses')
        .run(row.invite_day, row.invite_generation);
      if (used.changes !== 1) fail(403, 'INVITE_EXHAUSTED', 'Лимит регистраций по этому коду исчерпан.');
      const userId = `u_${crypto.randomBytes(8).toString('hex')}`;
      let color = 0;
      for (const char of row.username) color = (color * 31 + char.charCodeAt(0)) >>> 0;
      db.prepare(`INSERT INTO users(
        id,username,display_name,passhash,avatar_color,bio,created,email,email_key,email_verified_at,session_version,password_changed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)`)
        .run(userId, row.username, row.username, row.passhash, color % 8, '', at,
          row.email, row.email_key, at, at);
      return db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    });
    return { user: publicUser(result) };
  }

  async function startEmailBinding(input) {
    ensureEmailAvailable();
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(String(input.userId || ''));
    if (!user) fail(401, 'UNAUTHORIZED', 'Не авторизован.');
    if (user.email_verified_at) fail(409, 'EMAIL_ALREADY_VERIFIED', 'Почта уже подтверждена.');
    const normalizedEmail = normalizeEmail(input.email);
    const key = requestKey('binding', user.id, input.requestId);
    const fp = fingerprint('binding', [
      user.id, normalizedEmail.key, String(input.password || ''), normalizeInvite(input.supportCode),
    ]);
    const existing = db.prepare('SELECT * FROM auth_email_flows WHERE request_key=?').get(key);
    if (existing) return resumeIdempotentFlow(existing, fp, input.ip);

    consumeIpRate('binding-ip', input.ip, 10, 60 * 60 * 1000);
    consumeRate('binding-user', user.id, 5, 60 * 60 * 1000);
    const at = now();
    const currentPassword = String(input.password || '');
    const passwordValid = currentPassword ? await comparePassword(user.passhash, currentPassword) : false;
    let supportValid = false;
    if (!passwordValid) {
      consumeRate('binding-support-user', user.id, 8, 15 * 60 * 1000);
      consumeIpRate('binding-support-ip', input.ip, 20, 15 * 60 * 1000);
      const support = db.prepare(`SELECT * FROM auth_email_binding_support
        WHERE user_id=? AND used=0 AND expires>?`).get(user.id, at);
      const supplied = normalizeInvite(input.supportCode);
      supportValid = !!support && supplied.length >= 10
        && safeEqual(support.code_hash, hmac('binding-support', `${user.id}\0${supplied}`));
      if (!supportValid) {
        fail(401, currentPassword ? 'INVALID_PASSWORD' : 'RECOVERY_CODE_REQUIRED',
          currentPassword
            ? 'Неверный пароль. Если вы его забыли, получите одноразовый код у denis.'
            : 'Введите текущий пароль или одноразовый код восстановления от denis.', {
            field: currentPassword ? 'currentPassword' : 'supportCode', recoveryAvailable: true,
          });
      }
    }
    if (db.prepare("SELECT 1 FROM users WHERE email_key=? AND email_verified_at>0 AND id<>?").get(normalizedEmail.key, user.id)) {
      fail(409, 'EMAIL_IN_USE', 'Этот адрес почты уже используется.');
    }
    const flowId = crypto.randomBytes(32).toString('base64url');
    const generation = 0;
    const expires = Math.min(at + config.emailCodeTtlMs, at + config.emailFlowMaxMs);
    const createBinding = db.transaction(() => {
      const inserted = db.prepare(`INSERT OR IGNORE INTO auth_email_flows(
        id,request_key,request_fingerprint,purpose,user_id,username,email,email_key,passhash,
        invite_day,invite_generation,code_generation,code_hash,attempts,sends,send_window_started,
        created,expires,absolute_expires,resend_after,delivered,consumed
      ) VALUES(?,?,?,'binding',?,?,?,?,'','',0,?,?,0,1,?,?,?,?,?,0,0)`)
        .run(flowId, key, fp, user.id, user.username, normalizedEmail.email, normalizedEmail.key,
          generation, hashCode(flowId, generation, codeFor(flowId, generation)),
          at, at, expires, at + config.emailFlowMaxMs, at + config.sendCooldownMs);
      const persisted = db.prepare('SELECT * FROM auth_email_flows WHERE request_key=?').get(key);
      if (inserted.changes === 1) {
        db.prepare(`UPDATE auth_email_flows SET consumed=1
          WHERE purpose='binding' AND user_id=? AND id<>? AND consumed=0`).run(user.id, persisted.id);
        if (supportValid) {
          const consumed = db.prepare(`UPDATE auth_email_binding_support SET used=1
            WHERE user_id=? AND used=0 AND expires>?`).run(user.id, at);
          if (consumed.changes !== 1) {
            fail(409, 'RECOVERY_CODE_USED', 'Код восстановления уже использован. Запросите новый у denis.');
          }
        }
      }
      return { inserted: inserted.changes === 1, row: persisted };
    });
    const created = createBinding.immediate ? createBinding.immediate() : createBinding();
    if (!created.inserted) return resumeIdempotentFlow(created.row, fp, input.ip);
    let row = created.row;
    try { row = await claimAndDeliver(row); }
    catch (error) {
      logger.warn?.('[auth] binding email delivery failed');
      fail(503, 'EMAIL_DELIVERY_FAILED', 'Не удалось отправить письмо. Попробуйте позже.');
    }
    return flowView(row, false);
  }

  function verifyEmailBinding(input) {
    ensurePepperAvailable();
    consumeIpRate('email-code-ip', input.ip, 30, 60 * 60 * 1000);
    const result = verifyCodeInTransaction(input.flowId, 'binding', String(input.userId || ''), input.code, (row, at) => {
      if (db.prepare("SELECT 1 FROM users WHERE email_key=? AND email_verified_at>0 AND id<>?").get(row.email_key, row.user_id)) {
        fail(409, 'EMAIL_IN_USE', 'Этот адрес почты уже используется.');
      }
      const changed = db.prepare(`UPDATE users SET email=?,email_key=?,email_verified_at=?,session_version=session_version+1
        WHERE id=? AND email_verified_at=0`).run(row.email, row.email_key, at, row.user_id);
      if (changed.changes !== 1) fail(409, 'EMAIL_ALREADY_VERIFIED', 'Почта уже подтверждена.');
      return db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id);
    });
    if (typeof mailer.sendEmailBound === 'function') {
      Promise.resolve().then(() => mailer.sendEmailBound({ to: result.email, username: result.username }))
        .catch(() => logger.warn?.('[auth] email-bound notification failed'));
    }
    return { user: publicUser(result) };
  }

  async function resendFlow(input, purpose, userId) {
    ensureEmailAvailable();
    const flowId = String(input.flowId || '');
    if (!FLOW_ID_RE.test(flowId)) fail(400, 'FLOW_NOT_FOUND', 'Подтверждение не найдено.');
    consumeIpRate('email-resend-ip', input.ip, 20, 60 * 60 * 1000);
    const transaction = db.transaction(() => {
      const row = db.prepare('SELECT * FROM auth_email_flows WHERE id=?').get(flowId);
      const at = now();
      if (!row || row.purpose !== purpose || (userId != null && row.user_id !== userId) || row.consumed) {
        fail(404, 'FLOW_NOT_FOUND', 'Подтверждение не найдено.');
      }
      if (row.absolute_expires <= at) fail(410, 'FLOW_EXPIRED', 'Подтверждение устарело. Начните заново.');
      if (row.attempts >= config.emailCodeMaxAttempts) {
        fail(429, 'CODE_ATTEMPTS_EXCEEDED', 'Попытки закончились. Начните подтверждение заново.');
      }
      if (row.resend_after > at) {
        fail(429, 'RESEND_COOLDOWN', 'Новое письмо можно запросить чуть позже.', { retryAfterMs: row.resend_after - at });
      }
      const windowStarted = at - row.send_window_started >= 60 * 60 * 1000 ? at : row.send_window_started;
      const sends = windowStarted === at ? 0 : row.sends;
      if (sends >= config.sendMaxPerHour) fail(429, 'SEND_LIMITED', 'Слишком много писем. Попробуйте позже.');
      if (purpose === 'registration') {
        inviteRowFor(row.invite_day);
        const reserved = db.prepare(`UPDATE auth_registration_invites SET email_sends=email_sends+1
          WHERE day=? AND generation=? AND email_sends<max_sends`).run(row.invite_day, row.invite_generation);
        if (reserved.changes !== 1) {
          const invite = db.prepare('SELECT * FROM auth_registration_invites WHERE day=?').get(row.invite_day);
          if (!invite || invite.generation !== row.invite_generation) {
            fail(403, 'INVITE_REVOKED', 'Пригласительный код был отозван.');
          }
          fail(403, 'INVITE_SENDS_EXHAUSTED', 'Лимит писем по этому коду исчерпан. denis может сразу обновить код.');
        }
      }
      const generation = row.code_generation + 1;
      const expires = Math.min(at + config.emailCodeTtlMs, row.absolute_expires);
      db.prepare(`UPDATE auth_email_flows SET code_generation=?,code_hash=?,sends=?,send_window_started=?,
        expires=?,resend_after=?,delivered=0,delivery_started=? WHERE id=?`)
        .run(generation, hashCode(row.id, generation, codeFor(row.id, generation)), sends + 1,
          windowStarted, expires, at + config.sendCooldownMs, at, row.id);
      return db.prepare('SELECT * FROM auth_email_flows WHERE id=?').get(row.id);
    });
    let row = transaction.immediate ? transaction.immediate() : transaction();
    try { await deliverCode(row); }
    catch (error) {
      db.prepare(`UPDATE auth_email_flows SET delivery_started=0
        WHERE id=? AND code_generation=? AND delivered=0`).run(row.id, row.code_generation);
      logger.warn?.('[auth] verification email resend failed');
      fail(503, 'EMAIL_DELIVERY_FAILED', 'Не удалось отправить письмо. Попробуйте позже.');
    }
    row = db.prepare('SELECT * FROM auth_email_flows WHERE id=?').get(row.id);
    return flowView(row, false);
  }

  const resendRegistration = (input) => resendFlow(input, 'registration', null);
  const resendEmailBinding = (input) => resendFlow(input, 'binding', String(input.userId || ''));

  function genericResetResponse() { return { accepted: true }; }

  function dispatchMail(work, label) {
    Promise.resolve().then(work).catch(() => logger.warn?.(`[auth] ${label} email delivery failed`));
  }

  async function startPasswordReset(input) {
    const startedAt = Date.now();
    const neutralResponse = async () => {
      const minimum = Math.max(0, Math.min(2000, Number(config.resetResponseMinMs) || 0));
      const target = minimum ? minimum + crypto.randomInt(0, 76) : 0;
      const remaining = target - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return genericResetResponse();
    };
    // Global mail availability is not an account-enumeration signal: every address receives the
    // same 503 while delivery is down, instead of a misleading success that cannot send anything.
    ensureEmailAvailable();
    const ipRate = consumeIpRate('reset-start-ip', input.ip, 8, 60 * 60 * 1000, { quiet: true });
    let normalizedEmail;
    try { normalizedEmail = normalizeEmail(input.email); }
    catch { return neutralResponse(); }
    const subjectRate = consumeRate('reset-start-email', normalizedEmail.key, 3, 60 * 60 * 1000, { quiet: true });
    if (!ipRate.allowed || !subjectRate.allowed) return neutralResponse();
    const user = db.prepare("SELECT * FROM users WHERE email_key=? AND email_verified_at>0").get(normalizedEmail.key);
    if (!user) {
      if (typeof mailer.equalizePasswordReset === 'function') dispatchMail(() => mailer.equalizePasswordReset(), 'reset-cover');
      return neutralResponse();
    }
    const recentReset = db.prepare('SELECT MAX(created) AS created FROM auth_password_resets WHERE user_id=?')
      .get(user.id);
    if (recentReset && recentReset.created
      && now() - Number(recentReset.created) < config.resetSendCooldownMs) {
      return neutralResponse();
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const at = now();
    const expiresAt = at + config.resetTtlMs;
    const replaceReset = db.transaction(() => {
      // Новое письмо немедленно отзывает все прежние ссылки этого аккаунта. Вставка и отзыв
      // атомарны: ошибка записи не должна оставить пользователя вообще без рабочей ссылки.
      db.prepare('UPDATE auth_password_resets SET used=1 WHERE user_id=? AND used=0').run(user.id);
      db.prepare('INSERT INTO auth_password_resets(token_hash,user_id,created,expires,used) VALUES(?,?,?,?,0)')
        .run(tokenHash, user.id, at, expiresAt);
    });
    replaceReset.immediate ? replaceReset.immediate() : replaceReset();
    dispatchMail(() => mailer.sendPasswordReset({
      to: user.email, username: user.username, token, expiresAt,
    }), 'password-reset');
    return neutralResponse();
  }

  function resetRow(token) {
    const raw = String(token || '');
    if (!RESET_TOKEN_RE.test(raw)) return null;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return db.prepare(`SELECT r.*,u.username,u.email,u.email_verified_at
      FROM auth_password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?`).get(hash) || null;
  }

  function inspectPasswordReset(input) {
    consumeIpRate('reset-inspect-ip', input.ip, 30, 60 * 60 * 1000);
    const row = resetRow(input.token);
    if (!row || row.used || row.expires <= now() || !row.email_verified_at) {
      fail(400, 'RESET_INVALID', 'Ссылка недействительна или устарела.');
    }
    return { valid: true, username: row.username, expiresAt: row.expires };
  }

  async function completePasswordReset(input) {
    consumeIpRate('reset-complete-ip', input.ip, 20, 60 * 60 * 1000);
    const first = resetRow(input.token);
    if (!first || first.used || first.expires <= now() || !first.email_verified_at) {
      fail(400, 'RESET_INVALID', 'Ссылка недействительна или устарела.');
    }
    const password =
      validatePassword(input.newPassword, { username: first.username, email: first.email });
    const passhash = await hashPassword(password);
    const tokenHash = crypto.createHash('sha256').update(String(input.token)).digest('hex');
    const transaction = db.transaction(() => {
      const row = db.prepare(`SELECT r.*,u.username,u.email,u.email_verified_at
        FROM auth_password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?`).get(tokenHash);
      const at = now();
      if (!row || row.used || row.expires <= at || !row.email_verified_at) {
        fail(400, 'RESET_INVALID', 'Ссылка недействительна или устарела.');
      }
      db.prepare(`UPDATE users SET passhash=?,password_changed_at=?,session_version=session_version+1 WHERE id=?`)
        .run(passhash, at, row.user_id);
      db.prepare('UPDATE auth_password_resets SET used=1 WHERE user_id=? AND used=0').run(row.user_id);
      return { to: row.email, userId: row.user_id, username: row.username, changedAt: at };
    });
    const changed = transaction.immediate ? transaction.immediate() : transaction();
    dispatchMail(() => mailer.sendPasswordChanged(changed), 'password-changed');
    return { ok: true, userId: changed.userId, username: changed.username };
  }

  function sessionState(userOrId) {
    const user = typeof userOrId === 'object' && userOrId
      ? userOrId
      : db.prepare('SELECT * FROM users WHERE id=?').get(String(userOrId || ''));
    if (!user) fail(401, 'UNAUTHORIZED', 'Не авторизован.');
    const available = isEmailAvailable();
    const verified = !!user.email_verified_at;
    let activeBinding = null;
    if (!verified) {
      const row = db.prepare(`SELECT * FROM auth_email_flows
        WHERE user_id=? AND purpose='binding' AND consumed=0 AND absolute_expires>?
        ORDER BY created DESC LIMIT 1`).get(user.id, now());
      if (row) activeBinding = {
        flowId: row.id,
        maskedEmail: maskEmail(row.email),
        expiresAt: row.expires,
        resendAt: row.resend_after,
        attemptsRemaining: Math.max(0, config.emailCodeMaxAttempts - row.attempts),
        delivered: !!row.delivered,
      };
    }
    // required is fail-closed even when SMTP becomes unavailable after startup. optional remains
    // a compatibility rollout and prompts only while mail can actually complete the flow.
    const emailRequired = !verified && (config.emailEnforcement === 'required'
      || (config.emailEnforcement === 'optional' && available));
    return {
      emailAvailable: available,
      emailVerified: verified,
      emailRequired,
      emailEnforced: config.emailEnforcement === 'required' && !verified,
      ready: !emailRequired,
      maskedEmail: verified ? maskEmail(user.email) : '',
      activeBinding,
    };
  }

  function checkLoginRate(input) {
    const username = String(input.username || '').trim().toLowerCase();
    const ip = normalizedIp(input.ip);
    const credentialSubject = `${username}\0${ip}`;
    if (input.success === true) {
      clearRate('login-credential-fail', credentialSubject);
      return { allowed: true };
    }
    if (input.success === false) {
      const result = consumeRate('login-credential-fail', credentialSubject,
        config.loginAccountFailureLimit, 15 * 60 * 1000, { quiet: true });
      if (!result.allowed) fail(429, 'LOGIN_RATE_LIMITED', 'Слишком много попыток входа. Попробуйте позже.', { retryAfterMs: result.retryAfterMs });
      return result;
    }
    consumeIpRate('login-ip', ip, config.loginIpLimit, 15 * 60 * 1000);
    // Do not hard-lock a public username before checking the password: usernames are visible in
    // chat, so a third party could otherwise keep denis or any member permanently locked out.
    // The per-IP budget protects bcrypt; the (username, IP) budget penalizes only failed results.
    return { allowed: true };
  }

  function createEmailBindingSupportCode(actor, userId, ttlMs = 10 * 60 * 1000) {
    ensurePepperAvailable();
    requireDenis(actor);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(String(userId || ''));
    if (!target) fail(404, 'USER_NOT_FOUND', 'Пользователь не найден.');
    if (target.email_verified_at) fail(409, 'EMAIL_ALREADY_VERIFIED', 'Почта уже подтверждена.');
    const duration = Math.max(60 * 1000, Math.min(15 * 60 * 1000, Number(ttlMs) || 10 * 60 * 1000));
    const code = encodeCrockford(crypto.randomBytes(10), 12);
    const createdAt = now();
    const expiresAt = now() + duration;
    db.prepare(`INSERT INTO auth_email_binding_support(user_id,code_hash,created,expires,used,created_by)
      VALUES(?,?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET
        code_hash=excluded.code_hash,created=excluded.created,expires=excluded.expires,used=0,created_by=excluded.created_by`)
      .run(target.id, hmac('binding-support', `${target.id}\0${code}`), createdAt, expiresAt, actor.id);
    return { userId: target.id, code, expiresAt };
  }

  function issueSession(userOrId) {
    if (!sessionSecret) throw new Error('sessionSecret is required to issue sessions');
    const user = typeof userOrId === 'object' && userOrId
      ? userOrId
      : db.prepare('SELECT * FROM users WHERE id=?').get(String(userOrId || ''));
    if (!user) fail(401, 'UNAUTHORIZED', 'Не авторизован.');
    return jwt.sign({ id: user.id, sub: user.id, sv: Number(user.session_version) || 0, typ: 'session' },
      sessionSecret, { algorithm: 'HS256', expiresIn: config.sessionTtl });
  }

  function verifySession(token, { requireVerified = false } = {}) {
    if (!sessionSecret) throw new Error('sessionSecret is required to verify sessions');
    let payload;
    try { payload = jwt.verify(String(token || ''), sessionSecret, { algorithms: ['HS256'] }); }
    catch { fail(401, 'UNAUTHORIZED', 'Не авторизован.'); }
    if (payload.typ && payload.typ !== 'session') fail(401, 'UNAUTHORIZED', 'Не авторизован.');
    let user = null;
    const id = payload.sub || payload.id;
    if (id) user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    else if (payload.u) user = db.prepare('SELECT * FROM users WHERE username=?').get(payload.u);
    if (!user) fail(401, 'UNAUTHORIZED', 'Не авторизован.');
    const version = Number(user.session_version) || 0;
    if (payload.sv == null ? version !== 0 : (!Number.isSafeInteger(payload.sv) || payload.sv !== version)) {
      fail(401, 'SESSION_REVOKED', 'Сессия завершена. Войдите снова.');
    }
    const state = sessionState(user);
    if (requireVerified && state.emailEnforced) {
      fail(428, 'EMAIL_VERIFICATION_REQUIRED', 'Сначала подтвердите электронную почту.');
    }
    return { user, state, payload };
  }

  function purgeUser(userId) {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM auth_email_flows WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM auth_email_binding_support WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM auth_password_resets WHERE user_id=?').run(userId);
    });
    if (transaction.immediate) transaction.immediate(); else transaction();
  }

  function cleanup() {
    const at = now();
    db.prepare('DELETE FROM auth_email_flows WHERE absolute_expires<?').run(at - 24 * 60 * 60 * 1000);
    db.prepare('DELETE FROM auth_password_resets WHERE (used=1 OR expires<?) AND created<?')
      .run(at, at - 24 * 60 * 60 * 1000);
    db.prepare('DELETE FROM auth_rate_limits WHERE updated<?').run(at - 48 * 60 * 60 * 1000);
    db.prepare('DELETE FROM auth_email_binding_support WHERE used=1 OR expires<?').run(at - 24 * 60 * 60 * 1000);
  }

  return {
    startRegistration,
    verifyRegistration,
    resendRegistration,
    startEmailBinding,
    verifyEmailBinding,
    resendEmailBinding,
    startPasswordReset,
    inspectPasswordReset,
    completePasswordReset,
    sessionState,
    currentInvite,
    rotateInvite,
    createEmailBindingSupportCode,
    checkLoginRate,
    comparePassword,
    hashPassword,
    issueSession,
    verifySession,
    purgeUser,
    cleanup,
    emailAvailable: isEmailAvailable,
  };
}

module.exports = {
  AuthError,
  installAuthSchema,
  installVerifiedRegistrationGuard,
  createAuthManager,
  normalizeEmail,
  normalizeUsername,
  validatePassword,
  passwordLoginCandidates,
  passwordPrehash,
  formatPasswordHash,
  readCodePepperFile,
  maskEmail,
  verifiedEmailForOwner,
};

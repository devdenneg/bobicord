'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const {
  installAuthSchema,
  normalizeEmail,
  validatePassword,
  passwordPrehash,
  formatPasswordHash,
} = require('./auth');

const ADMIN_USERNAME = 'denis';
const DEFAULT_DB_FILE = '/app/data/voice.db';
const MAX_SECRET_FILE_BYTES = 4 * 1024;

class BootstrapAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BootstrapAdminError';
    this.code = code;
  }
}

function bootstrapError(code, message) {
  throw new BootstrapAdminError(code, message);
}

function requireAbsoluteFilePath(value, envName) {
  const location = String(value || '');
  if (!location || /[\r\n\u0000]/u.test(location) || !path.isAbsolute(location)) {
    bootstrapError('INVALID_SECRET_PATH', `${envName} должен содержать абсолютный путь к secret-файлу.`);
  }
  return location;
}

function readSingleLineSecret(location, label, options = {}) {
  let stat;
  try {
    const linkStat = fs.lstatSync(location);
    if (linkStat.isSymbolicLink()) {
      bootstrapError('INSECURE_SECRET_FILE', `${label}: символические ссылки запрещены.`);
    }
    stat = fs.statSync(location);
  } catch (error) {
    if (error instanceof BootstrapAdminError) throw error;
    bootstrapError('SECRET_FILE_UNAVAILABLE', `${label}: secret-файл недоступен.`);
  }
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SECRET_FILE_BYTES) {
    bootstrapError('INVALID_SECRET_FILE', `${label}: нужен непустой обычный файл размером до 4 КиБ.`);
  }
  if (options.enforcePermissions !== false && process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o400) {
      bootstrapError('INSECURE_SECRET_PERMISSIONS', `${label}: установите права 600 или 400.`);
    }
    if (options.enforceRootOwner !== false
      && ((typeof process.getuid === 'function' && process.getuid() !== 0) || stat.uid !== 0)) {
      bootstrapError('INSECURE_SECRET_OWNER', `${label}: файл должен принадлежать root.`);
    }
  }

  let value;
  try {
    value = fs.readFileSync(location, 'utf8').replace(/(?:\r\n|\n|\r)$/u, '');
  } catch {
    bootstrapError('SECRET_FILE_UNAVAILABLE', `${label}: secret-файл не удалось прочитать.`);
  }
  if (!value || /[\r\n\u0000]/u.test(value)) {
    bootstrapError('INVALID_SECRET_FILE', `${label}: файл должен содержать ровно одну непустую строку.`);
  }
  return value;
}

function ensureBootstrapSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      passhash TEXT NOT NULL,
      avatar_color INTEGER NOT NULL DEFAULT 0,
      avatar_url TEXT NOT NULL DEFAULT '',
      profile_banner_url TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      email_key TEXT NOT NULL DEFAULT '',
      email_verified_at INTEGER NOT NULL DEFAULT 0,
      session_version INTEGER NOT NULL DEFAULT 0,
      password_changed_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!columns.has('is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }
  installAuthSchema(db);
}

function findBootstrapAdmin(db) {
  return db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').get(ADMIN_USERNAME);
}

function bootstrapAdmin(options = {}) {
  const dbFile = String(options.dbFile || DEFAULT_DB_FILE);
  if (!path.isAbsolute(dbFile) || /[\r\n\u0000]/u.test(dbFile)) {
    bootstrapError('INVALID_DB_PATH', 'Путь к SQLite-базе должен быть абсолютным.');
  }

  const emailFile = requireAbsoluteFilePath(options.emailFile, 'BOOTSTRAP_ADMIN_EMAIL_FILE');
  const passwordFile = requireAbsoluteFilePath(options.passwordFile, 'BOOTSTRAP_ADMIN_PASSWORD_FILE');
  const rounds = options.bcryptRounds === undefined ? 12 : Number(options.bcryptRounds);
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
    bootstrapError('INVALID_BCRYPT_ROUNDS', 'Некорректная стоимость bcrypt.');
  }

  let db;
  try {
    db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureBootstrapSchema(db);

    if (findBootstrapAdmin(db)) {
      bootstrapError('ADMIN_EXISTS', 'Администратор denis уже существует; повторный bootstrap запрещён.');
    }

    const emailSecret = readSingleLineSecret(emailFile, 'Email администратора', options);
    const passwordSecret = readSingleLineSecret(passwordFile, 'Пароль администратора', options);
    const normalizedEmail = normalizeEmail(emailSecret);
    const password =
      validatePassword(passwordSecret, {
        username: ADMIN_USERNAME,
        email: normalizedEmail.email,
      });
    const passhash = formatPasswordHash(bcrypt.hashSync(passwordPrehash(password), rounds));
    const createdAt = Number.isSafeInteger(options.createdAt) && options.createdAt > 0
      ? options.createdAt
      : Date.now();
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const userId = `u_${randomBytes(8).toString('hex')}`;

    const insert = db.transaction(() => {
      if (findBootstrapAdmin(db)) {
        bootstrapError('ADMIN_EXISTS', 'Администратор denis уже существует; повторный bootstrap запрещён.');
      }
      db.prepare(`INSERT INTO users(
        id,username,display_name,passhash,avatar_color,bio,is_admin,created,
        email,email_key,email_verified_at,session_version,password_changed_at
      ) VALUES(?,?,?,?,0,'',1,?,?,?,?,0,?)`).run(
        userId,
        ADMIN_USERNAME,
        ADMIN_USERNAME,
        passhash,
        createdAt,
        normalizedEmail.email,
        normalizedEmail.key,
        createdAt,
        createdAt,
      );
    });
    if (insert.immediate) insert.immediate();
    else insert();

    return { username: ADMIN_USERNAME, createdAt };
  } catch (error) {
    if (error instanceof BootstrapAdminError || (error && error.name === 'AuthError')) throw error;
    bootstrapError('BOOTSTRAP_FAILED', 'Bootstrap администратора не выполнен: проверьте базу и права доступа.');
  } finally {
    if (db) db.close();
  }
}

function runCli(options = {}) {
  const argv = options.argv || process.argv;
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  if (argv.length !== 2) {
    bootstrapError('CLI_ARGUMENTS_FORBIDDEN', 'Аргументы командной строки запрещены: секреты читаются только из файлов.');
  }
  if (env.BOOTSTRAP_ADMIN_EMAIL || env.BOOTSTRAP_ADMIN_PASSWORD) {
    bootstrapError('INLINE_SECRETS_FORBIDDEN', 'Email и пароль нельзя передавать напрямую через переменные окружения.');
  }

  const result = bootstrapAdmin({
    dbFile: env.BOOTSTRAP_ADMIN_DB_FILE || DEFAULT_DB_FILE,
    emailFile: env.BOOTSTRAP_ADMIN_EMAIL_FILE,
    passwordFile: env.BOOTSTRAP_ADMIN_PASSWORD_FILE,
    ...(options.bootstrapOptions || {}),
  });
  stdout.write(`Администратор ${result.username} создан, email подтверждён. Secret-файлы bootstrap теперь нужно удалить.\n`);
  return result;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof BootstrapAdminError || (error && error.name === 'AuthError')
      ? error.message
      : 'Неизвестная ошибка bootstrap администратора.';
    process.stderr.write(`Ошибка: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ADMIN_USERNAME,
  DEFAULT_DB_FILE,
  BootstrapAdminError,
  bootstrapAdmin,
  runCli,
};

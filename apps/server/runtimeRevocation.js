'use strict';

const TRIGGER_NAME = 'trg_users_session_version_runtime_revoke';

const REQUIRED_COLUMNS = Object.freeze({
  users: ['id', 'username', 'session_version'],
  memberships: ['user_id', 'server_id'],
  push_subs: ['user_id'],
  voice_leases: ['user_id', 'epoch', 'session_id', 'server_id', 'channel_id', 'claimed_at', 'active'],
  voice_session_intents: ['user_id'],
  voice_user_intents: ['user_id'],
});

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function requireRuntimeTables(db) {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = tableColumns(db, table);
    if (present.size === 0) {
      throw new Error(`runtime revocation requires table ${table}`);
    }
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`runtime revocation requires column ${table}.${column}`);
      }
    }
  }
}

function addColumnIfMissing(db, table, column, definition) {
  if (tableColumns(db, table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * Installs the durable, transaction-coupled side effects of a session-version
 * bump. Call this after the account, membership, push and voice-lease schemas
 * have been installed, and before accepting requests.
 */
function installRuntimeRevocationSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function'
    || typeof db.transaction !== 'function') {
    throw new TypeError('db is required');
  }

  requireRuntimeTables(db);

  const install = db.transaction(() => {
    // An older trigger must not run against a partially migrated outbox.
    db.exec(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_runtime_revocations(
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        reason TEXT NOT NULL,
        revoked_before_version INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS auth_runtime_revocation_rooms(
        user_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        revoked_before_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id, server_id)
      );
    `);

    const parentCutoffAdded = addColumnIfMissing(
      db,
      'auth_runtime_revocations',
      'revoked_before_version',
      'INTEGER NOT NULL DEFAULT 0',
    );
    const roomCutoffAdded = addColumnIfMissing(
      db,
      'auth_runtime_revocation_rooms',
      'revoked_before_version',
      'INTEGER NOT NULL DEFAULT 0',
    );

    // Legacy pending work had no cutoff. Preserve it and fence every session
    // older than the account version visible at migration time.
    if (parentCutoffAdded) {
      db.exec(`
        UPDATE auth_runtime_revocations
        SET revoked_before_version=MAX(
          revoked_before_version,
          COALESCE((SELECT session_version FROM users WHERE users.id=auth_runtime_revocations.user_id), 0)
        )
      `);
    }
    if (roomCutoffAdded) {
      db.exec(`
        UPDATE auth_runtime_revocation_rooms
        SET revoked_before_version=MAX(
          revoked_before_version,
          COALESCE((
            SELECT revoked_before_version
            FROM auth_runtime_revocations
            WHERE auth_runtime_revocations.user_id=auth_runtime_revocation_rooms.user_id
          ), 0)
        )
      `);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auth_runtime_revocations_due
        ON auth_runtime_revocations(next_attempt, created);

      CREATE TRIGGER ${TRIGGER_NAME}
      AFTER UPDATE OF session_version ON users
      WHEN NEW.session_version > OLD.session_version
      BEGIN
        INSERT INTO auth_runtime_revocations(
          user_id, username, reason, revoked_before_version, created, attempts, next_attempt
        ) VALUES(
          NEW.id,
          NEW.username,
          'session-version-bump',
          NEW.session_version,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          0,
          0
        )
        ON CONFLICT(user_id) DO UPDATE SET
          username=excluded.username,
          reason=excluded.reason,
          revoked_before_version=MAX(
            auth_runtime_revocations.revoked_before_version,
            excluded.revoked_before_version
          ),
          created=MIN(auth_runtime_revocations.created, excluded.created),
          attempts=0,
          next_attempt=0;

        INSERT INTO auth_runtime_revocation_rooms(user_id, server_id, revoked_before_version)
        SELECT NEW.id, memberships.server_id, NEW.session_version
        FROM memberships
        WHERE memberships.user_id=NEW.id
        ON CONFLICT(user_id, server_id) DO UPDATE SET
          revoked_before_version=MAX(
            auth_runtime_revocation_rooms.revoked_before_version,
            excluded.revoked_before_version
          );

        DELETE FROM push_subs WHERE user_id=NEW.id;

        UPDATE voice_leases
        SET
          epoch=CASE
            WHEN epoch < 9223372036854775807 THEN epoch + 1
            ELSE epoch
          END,
          session_id='',
          server_id='',
          channel_id='',
          claimed_at=0,
          active=0
        WHERE user_id=NEW.id;

        DELETE FROM voice_session_intents WHERE user_id=NEW.id;
        DELETE FROM voice_user_intents WHERE user_id=NEW.id;
      END;
    `);
  });

  if (typeof install.immediate === 'function') install.immediate();
  else install();
}

module.exports = {
  TRIGGER_NAME,
  installRuntimeRevocationSchema,
};

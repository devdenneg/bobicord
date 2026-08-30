'use strict';

function normalizedPushEndpoint(value) {
  const endpoint = typeof value === 'string' ? value.trim() : '';
  if (!endpoint || endpoint.length > 2048) return '';
  try { return new URL(endpoint).protocol === 'https:' ? endpoint : ''; }
  catch (error) { return ''; }
}

function normalizedPushPrivacy(value) {
  return value === 'full' || value === 'sender' ? value : 'hidden';
}

function privatePushPresentation(kind, title, body, privacy) {
  if (privacy === 'full') return { title, body };
  if (privacy === 'sender') return { title, body: '' };
  const hiddenBody = kind === 'stream' ? 'Началась трансляция'
    : kind === 'update' ? 'Доступно обновление'
      : 'Новое упоминание';
  return { title: 'RelayApp', body: hiddenBody };
}

/** A missing/legacy value is private, and secrets are removed before they reach the push service. */
function pushPayloadForSubscription(payload, value) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const privacy = normalizedPushPrivacy(value);
  const presentation = privatePushPresentation(
    source.kind,
    typeof source.title === 'string' ? source.title : 'RelayApp',
    typeof source.body === 'string' ? source.body : '',
    privacy,
  );
  return { ...source, ...presentation, privacy };
}

/** Upgrade existing databases before any subscription query can assume the privacy column. */
function installPushSubscriptionPrivacySchema(db) {
  const columns = db.prepare('PRAGMA table_info(push_subs)').all();
  const addedMention = !columns.some((column) => column.name === 'mention');
  const addedStream = !columns.some((column) => column.name === 'stream');
  if (!columns.some((column) => column.name === 'privacy')) {
    db.exec("ALTER TABLE push_subs ADD COLUMN privacy TEXT NOT NULL DEFAULT 'hidden'");
  }
  if (addedMention) {
    db.exec('ALTER TABLE push_subs ADD COLUMN mention INTEGER NOT NULL DEFAULT 1');
  }
  if (addedStream) {
    db.exec('ALTER TABLE push_subs ADD COLUMN stream INTEGER NOT NULL DEFAULT 1');
  }
  if ((addedMention || addedStream) && db.prepare('PRAGMA table_info(push_prefs)').all().length) {
    // Copy each legacy column exactly once. If a prior deployment was interrupted after adding only
    // one column, restarting migration must not overwrite that already device-local preference.
    if (addedMention) db.exec(`UPDATE push_subs SET
      mention=COALESCE((SELECT mention FROM push_prefs WHERE push_prefs.user_id=push_subs.user_id),1)`);
    if (addedStream) db.exec(`UPDATE push_subs SET
      stream=COALESCE((SELECT stream FROM push_prefs WHERE push_prefs.user_id=push_subs.user_id),1)`);
  }
  db.prepare("UPDATE push_subs SET privacy='hidden' WHERE privacy IS NULL OR privacy NOT IN ('full','sender','hidden')").run();
  db.prepare('UPDATE push_subs SET mention=CASE WHEN mention=0 THEN 0 ELSE 1 END, stream=CASE WHEN stream=0 THEN 0 ELSE 1 END').run();
}

function requestedPushCleanups(body) {
  const input = body && Array.isArray(body.pushCleanups) ? body.pushCleanups.slice(0, 32) : [];
  const seen = new Set();
  const out = [];
  for (const value of input) {
    const userId = typeof value?.userId === 'string' ? value.userId.trim() : '';
    const endpoint = normalizedPushEndpoint(value?.endpoint);
    const identity = userId + '\n' + endpoint;
    if (!userId || userId.length > 128 || !endpoint || seen.has(identity)) continue;
    seen.add(identity);
    out.push({ userId, endpoint });
  }
  return out;
}

/** Claimed user ids are untrusted; deletion is always intersected with the authenticated owner. */
function clearRequestedPushEndpoints(db, body, authenticatedUserId) {
  const userId = String(authenticatedUserId || '');
  const endpoints = requestedPushCleanups(body)
    .filter((record) => record.userId === userId)
    .map((record) => record.endpoint);
  const remove = db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?');
  for (const endpoint of endpoints) remove.run(endpoint, userId);
  return { userId, endpoints };
}

/** Persistent browser subscriptions are owned by the exact durable auth session that bound them. */
function clearSessionPushEndpoints(db, authenticatedUserId, authenticatedSessionId) {
  const userId = String(authenticatedUserId || '');
  const sessionId = String(authenticatedSessionId || '');
  if (!userId || !sessionId || sessionId.length > 128) return 0;
  return db.prepare('DELETE FROM push_subs WHERE user_id=? AND session_id=?').run(userId, sessionId).changes;
}

/**
 * Return whether the browser may safely remove its origin-wide local PushSubscription. `removed`
 * alone is ambiguous: false can mean either "already absent" or "currently owned by another
 * account". Keep the ownership check and delete in one SQLite transaction.
 */
function unsubscribeOwnedPushEndpoint(db, endpointValue, authenticatedUserId) {
  const endpoint = normalizedPushEndpoint(endpointValue);
  const userId = String(authenticatedUserId || '');
  if (!endpoint || !userId) return { removed: false, safeToUnsubscribe: false };
  const operation = db.transaction(() => {
    const current = db.prepare('SELECT user_id FROM push_subs WHERE endpoint=?').get(endpoint);
    if (!current) return { removed: false, safeToUnsubscribe: true };
    if (current.user_id !== userId) return { removed: false, safeToUnsubscribe: false };
    const removed = db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(endpoint, userId).changes > 0;
    return { removed, safeToUnsubscribe: removed };
  });
  return operation.immediate ? operation.immediate() : operation();
}

module.exports = {
  clearRequestedPushEndpoints,
  clearSessionPushEndpoints,
  installPushSubscriptionPrivacySchema,
  normalizedPushEndpoint,
  normalizedPushPrivacy,
  pushPayloadForSubscription,
  requestedPushCleanups,
  unsubscribeOwnedPushEndpoint,
};

'use strict';

const MAX_VOLUME_ENTRIES = 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitizeVolumeMap(value, maximum) {
  const output = Object.create(null);
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(safeObject(value))) {
    const key = String(rawKey).trim();
    if (!key || key.length > 256 || FORBIDDEN_KEYS.has(key)) continue;
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue;
    output[key] = Math.max(0, Math.min(maximum, rawValue));
    if (++count >= MAX_VOLUME_ENTRIES) break;
  }
  return output;
}

function sanitizeServerVolumeData(value) {
  const source = safeObject(value);
  return {
    users: sanitizeVolumeMap(source.users, 2),
    streams: sanitizeVolumeMap(source.streams, 1),
  };
}

function normalizeServerVolumeMutation(value) {
  const source = safeObject(value);
  const section = source.section === 'users' || source.section === 'streams' ? source.section : '';
  const key = typeof source.key === 'string' ? source.key.trim() : '';
  if (!section || !key || key.length > 256 || FORBIDDEN_KEYS.has(key)) return null;
  if (typeof source.value !== 'number' || !Number.isFinite(source.value)) return null;
  return { section, key, value: Math.max(0, Math.min(section === 'users' ? 2 : 1, source.value)) };
}

function applyServerVolumeMutation(current, rawMutation) {
  const mutation = normalizeServerVolumeMutation(rawMutation);
  if (!mutation) return null;
  const next = sanitizeServerVolumeData(current);
  next[mutation.section][mutation.key] = mutation.value;
  return next;
}

function createServerVolumeSettingsStore(db) {
  const read = db.prepare('SELECT data FROM server_settings WHERE user_id=? AND server_id=?');
  const write = db.prepare(`INSERT INTO server_settings(user_id,server_id,data) VALUES(?,?,?)
    ON CONFLICT(user_id,server_id) DO UPDATE SET data=excluded.data`);
  const parse = (row) => {
    try { return row ? sanitizeServerVolumeData(JSON.parse(row.data)) : sanitizeServerVolumeData({}); }
    catch { return sanitizeServerVolumeData({}); }
  };
  const patchTransaction = db.transaction((userId, serverId, rawMutation) => {
    const mutation = normalizeServerVolumeMutation(rawMutation);
    if (!mutation) return null;
    const next = applyServerVolumeMutation(parse(read.get(userId, serverId)), mutation);
    write.run(userId, serverId, JSON.stringify(next));
    return next;
  });
  return {
    get(userId, serverId) { return parse(read.get(userId, serverId)); },
    replace(userId, serverId, rawData) {
      const data = sanitizeServerVolumeData(rawData);
      write.run(userId, serverId, JSON.stringify(data));
      return data;
    },
    // An IMMEDIATE SQLite transaction also protects the read-modify-write sequence if deployment
    // later adds another Node worker/process sharing the same database file.
    patch(userId, serverId, rawMutation) {
      return patchTransaction.immediate(userId, serverId, rawMutation);
    },
  };
}

// Account settings intentionally contain nested keybind arrays. Keep JSON bounded and free of
// prototype keys instead of silently dropping every nested value as the old primitive-only helper did.
function sanitizeNestedSetting(value, depth, budget) {
  if (budget.nodes-- <= 0 || depth > 4) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 512);
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value.slice(0, 64)) {
      const clean = sanitizeNestedSetting(item, depth + 1, budget);
      if (clean !== undefined) output.push(clean);
    }
    return output;
  }
  if (!value || typeof value !== 'object') return undefined;
  const output = Object.create(null);
  for (const [rawKey, item] of Object.entries(value)) {
    const key = String(rawKey).trim();
    if (!key || key.length > 128 || FORBIDDEN_KEYS.has(key)) continue;
    const clean = sanitizeNestedSetting(item, depth + 1, budget);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}

function boundedAccountSettings(value, maxBytes = 20000) {
  const root = safeObject(value);
  const output = Object.create(null);
  const budget = { nodes: 512 };
  for (const [rawKey, item] of Object.entries(root)) {
    const key = String(rawKey).trim();
    if (!key || key.length > 128 || FORBIDDEN_KEYS.has(key)) continue;
    const clean = sanitizeNestedSetting(item, 1, budget);
    if (clean === undefined) continue;
    output[key] = clean;
    const encoded = JSON.stringify(output);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) delete output[key];
  }
  return JSON.stringify(output);
}

module.exports = {
  applyServerVolumeMutation,
  boundedAccountSettings,
  createServerVolumeSettingsStore,
  normalizeServerVolumeMutation,
  sanitizeServerVolumeData,
};

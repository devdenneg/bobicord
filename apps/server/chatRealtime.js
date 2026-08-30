'use strict';

const CHAT_EVENT_VERSION = 1;
const DEFAULT_MAX_EVENT_BYTES = 32 * 1024;
const DEFAULT_HIGH_WATER_BYTES = 256 * 1024;
const DEFAULT_LOW_WATER_BYTES = 64 * 1024;
const MAX_PENDING_RESYNCS = 64;
const MAX_RESYNCS_PER_FLUSH = 8;

const DEFAULT_RATE_POLICIES = Object.freeze({
  total: Object.freeze([{ limit: 40, windowMs: 10_000 }, { limit: 240, windowMs: 60_000 }]),
  message: Object.freeze([{ limit: 12, windowMs: 5_000 }, { limit: 120, windowMs: 60_000 }]),
  reaction: Object.freeze([{ limit: 50, windowMs: 5_000 }, { limit: 300, windowMs: 60_000 }]),
  edit: Object.freeze([{ limit: 20, windowMs: 10_000 }, { limit: 90, windowMs: 60_000 }]),
  delete: Object.freeze([{ limit: 20, windowMs: 10_000 }, { limit: 90, windowMs: 60_000 }]),
  clear: Object.freeze([{ limit: 2, windowMs: 10_000 }, { limit: 6, windowMs: 60_000 }]),
  mentionAll: Object.freeze([{ limit: 1, windowMs: 10_000 }, { limit: 4, windowMs: 60_000 }]),
});

function normalizedId(value, max = 80) {
  const result = String(value || '').trim();
  return result && result.length <= max ? result : '';
}

function positiveSafeInteger(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function createChatEnvelope(serverId, revision, event, maxEventBytes = DEFAULT_MAX_EVENT_BYTES) {
  const sid = normalizedId(serverId);
  const rev = positiveSafeInteger(revision);
  if (!sid || !rev || !event || typeof event !== 'object' || Array.isArray(event)) return null;
  const envelope = { t: 'chat-event', v: CHAT_EVENT_VERSION, serverId: sid, rev, event };
  return byteLength(envelope) <= maxEventBytes ? envelope : null;
}

function sanitizeMessageEmotes(raw, maxBytes = 4000) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [name, id] of Object.entries(raw)) {
    if (count >= 64) break;
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/u.test(name)) continue;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) continue;
    const candidate = { ...out, [name]: id };
    if (byteLength(candidate) > maxBytes) continue;
    out[name] = id;
    count++;
  }
  return out;
}

function canonicalAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').slice(0, 256);
  if (!url) return null;
  const kind = raw.kind === 'file' ? 'file' : 'image';
  const numericSize = Number(raw.size);
  const item = {
    url,
    name: String(raw.name || '').slice(0, 255),
    size: Number.isFinite(numericSize)
      ? Math.round(Math.max(0, Math.min(10 * 1024 * 1024, numericSize)))
      : 0,
    mime: String(raw.mime || '').slice(0, 100),
    kind,
  };
  if (kind === 'image' && Number.isSafeInteger(raw.width) && Number.isSafeInteger(raw.height)
    && raw.width > 0 && raw.width <= 4096 && raw.height > 0 && raw.height <= 4096) {
    item.width = raw.width;
    item.height = raw.height;
  }
  return item;
}

function canonicalReply(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const author = String(raw.author || '').slice(0, 80);
  if (!author) return undefined;
  const reply = {
    author,
    text: String(raw.text || '').slice(0, 160),
    img: raw.img === true,
    hasFile: raw.hasFile === true,
  };
  const uid = normalizedId(raw.uid, 64); if (uid) reply.uid = uid;
  const sid = positiveSafeInteger(raw.sid); if (sid) reply.sid = sid;
  const thumb = String(raw.thumb || '').slice(0, 256); if (thumb) reply.thumb = thumb;
  return reply;
}

function canonicalMessageShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = positiveSafeInteger(raw.id);
  const uid = normalizedId(raw.uid, 64);
  const name = String(raw.name || '').slice(0, 80);
  const ts = Number(raw.ts);
  if (!id || !uid || !name || !Number.isSafeInteger(ts) || ts <= 0) return null;
  const color = Number(raw.color);
  const message = {
    id,
    uid,
    name,
    color: Number.isSafeInteger(color) && color >= 0 && color <= 0xffffff ? color : 0,
    text: String(raw.text || '').slice(0, 1000),
    em: sanitizeMessageEmotes(raw.em),
    img: String(raw.img || '').slice(0, 256),
    files: Array.isArray(raw.files) ? raw.files.slice(0, 5).map(canonicalAttachment).filter(Boolean) : [],
    ts,
    edited: raw.edited === true,
  };
  const reply = canonicalReply(raw.reply); if (reply) message.reply = reply;
  const mkey = String(raw.mkey || '').slice(0, 64); if (mkey) message.mkey = mkey;
  if (raw.kind === 'levelup') {
    const level = Number(raw.level);
    if (Number.isSafeInteger(level) && level > 0 && level <= 1_000_000) {
      message.kind = 'levelup';
      message.level = level;
    }
  }
  return message;
}

function messageCreatedEvent(serverId, revision, message, mkey, maxEventBytes) {
  const canonicalMessage = canonicalMessageShape(message);
  if (!canonicalMessage) return null;
  const key = String(mkey || '').slice(0, 64);
  return createChatEnvelope(serverId, revision, {
    type: 'message.created',
    message: canonicalMessage,
    ...(key ? { mkey: key } : {}),
  }, maxEventBytes);
}

function messageUpdatedEvent(serverId, revision, messageId, text, maxEventBytes) {
  const id = positiveSafeInteger(messageId);
  const canonicalText = String(text || '').slice(0, 1000);
  if (!id || !canonicalText.trim()) return null;
  return createChatEnvelope(serverId, revision, {
    type: 'message.updated', messageId: id, text: canonicalText, edited: true,
  }, maxEventBytes);
}

function messageDeletedEvent(serverId, revision, messageId, maxEventBytes) {
  const id = positiveSafeInteger(messageId);
  return id ? createChatEnvelope(serverId, revision, { type: 'message.deleted', messageId: id }, maxEventBytes) : null;
}

function canonicalReactionIdentity(rawId, rawName) {
  if (typeof rawId !== 'string' || typeof rawName !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(rawId)) return null;
  if (!rawName || rawName.length > 64 || /[\u0000-\u001f\u007f]/u.test(rawName)) return null;
  return { id: rawId, name: rawName };
}

function reactionsUpdatedEvent(serverId, revision, messageId, reactions, maxEventBytes) {
  const id = positiveSafeInteger(messageId);
  if (!id || !Array.isArray(reactions)) return null;
  const canonical = [];
  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== 'object') return null;
    const identity = canonicalReactionIdentity(reaction.id, reaction.name);
    const count = Number(reaction.count);
    if (!identity || !Number.isSafeInteger(count) || count <= 0 || count > 1000) return null;
    canonical.push({ ...identity, count, mine: reaction.mine === true });
  }
  return createChatEnvelope(serverId, revision, {
    type: 'reaction.updated', messageId: id, reactions: canonical,
  }, maxEventBytes);
}

function chatClearedEvent(serverId, revision, maxEventBytes) {
  return createChatEnvelope(serverId, revision, { type: 'chat.cleared' }, maxEventBytes);
}

function chatResyncEvent(serverId, reason = 'backpressure') {
  const sid = normalizedId(serverId);
  if (!sid) return null;
  const safeReason = reason === 'reconnect' ? 'reconnect' : 'backpressure';
  return { t: 'chat-resync', v: CHAT_EVENT_VERSION, serverId: sid, reason: safeReason };
}

function chatReadyEvent() {
  return { t: 'chat-ready', v: CHAT_EVENT_VERSION };
}

function hasAllMention(text) {
  return /@(everyone|all|все)(?![\p{L}\p{N}_])/iu.test(String(text || ''));
}

function installChatRevisionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_revisions(
    server_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    last_clear_revision INTEGER NOT NULL DEFAULT 0
  )`);
  const columns = db.prepare('PRAGMA table_info(chat_revisions)').all();
  if (!columns.some((column) => column.name === 'last_clear_revision')) {
    try {
      db.exec('ALTER TABLE chat_revisions ADD COLUMN last_clear_revision INTEGER NOT NULL DEFAULT 0');
    } catch (error) {
      // Another process sharing the SQLite volume may win the rollout migration race.
      const migrated = db.prepare('PRAGMA table_info(chat_revisions)').all()
        .some((column) => column.name === 'last_clear_revision');
      if (!migrated) throw error;
    }
  }
}

function createChatRevisionStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('database is required');
  installChatRevisionSchema(db);
  const getRevision = db.prepare('SELECT revision,last_clear_revision FROM chat_revisions WHERE server_id=?');
  const bumpRevision = db.prepare('UPDATE chat_revisions SET revision=revision+1 WHERE server_id=?');
  const insertRevision = db.prepare('INSERT OR IGNORE INTO chat_revisions(server_id,revision,last_clear_revision) VALUES(?,1,0)');
  const markClearRevision = db.prepare('UPDATE chat_revisions SET last_clear_revision=revision WHERE server_id=?');

  function snapshot(serverId) {
    const row = getRevision.get(serverId);
    const rawRevision = Number(row && row.revision);
    const revision = Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
    const rawClear = Number(row && row.last_clear_revision);
    const lastClearRevision = Number.isSafeInteger(rawClear) && rawClear >= 0
      ? Math.min(rawClear, revision)
      : 0;
    return { revision, lastClearRevision };
  }

  const persistBump = db.transaction((serverId, clear) => {
    if (bumpRevision.run(serverId).changes === 0) insertRevision.run(serverId);
    if (clear) markClearRevision.run(serverId);
    const state = snapshot(serverId);
    if (state.revision <= 0 || (clear && state.lastClearRevision !== state.revision)) {
      throw new Error('chat revision was not persisted');
    }
    return state;
  });

  return {
    current(serverId) {
      return snapshot(serverId).revision;
    },
    currentClear(serverId) {
      return snapshot(serverId).lastClearRevision;
    },
    snapshot,
    bump(serverId, options = {}) {
      const clear = options === true || (options && options.clear === true);
      return persistBump(serverId, clear).revision;
    },
  };
}

function cleanupInvalidLegacyReactions(db, revisions, { batchSize = 1000 } = {}) {
  if (!db || typeof db.prepare !== 'function' || !revisions || typeof revisions.bump !== 'function') {
    throw new TypeError('database and revision store are required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new TypeError('invalid cleanup batch');
  const selectBatch = db.prepare(`SELECT rowid rowId,server_id serverId,emote_id emoteId,emote_name emoteName
    FROM reactions WHERE rowid>? ORDER BY rowid ASC LIMIT ?`);
  const deleteRow = db.prepare('DELETE FROM reactions WHERE rowid=?');
  let cursor = 0;
  let removed = 0;
  const revisedServers = new Set();
  while (true) {
    const rows = selectBatch.all(cursor, batchSize);
    if (!rows.length) break;
    cursor = Number(rows[rows.length - 1].rowId);
    const invalid = rows.filter((row) => !canonicalReactionIdentity(row.emoteId, row.emoteName));
    if (invalid.length) {
      const cleanBatch = db.transaction(() => {
        const changedServers = new Set();
        for (const row of invalid) {
          if (deleteRow.run(row.rowId).changes > 0) {
            removed++;
            changedServers.add(row.serverId);
          }
        }
        for (const serverId of changedServers) {
          revisions.bump(serverId);
          revisedServers.add(serverId);
        }
      });
      cleanBatch();
    }
    if (rows.length < batchSize) break;
  }
  return { removed, revisedServers: [...revisedServers] };
}

function createChatRateLimiter({ policies = DEFAULT_RATE_POLICIES, maxEntries = 100_000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('invalid maxEntries');
  const entries = new Map();

  function consumeWindow(accountId, scope, policy, now) {
    const key = `${scope}:${policy.windowMs}:${accountId}`;
    let entry = entries.get(key);
    if (!entry || now - entry.startedAt >= policy.windowMs) {
      if (!entry && entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entry = { startedAt: now, count: 0 };
      entries.set(key, entry);
    }
    entry.count++;
    if (entry.count <= policy.limit) return null;
    return Math.max(1, policy.windowMs - (now - entry.startedAt));
  }

  function consume(accountId, action, now = Date.now(), { includeTotal = true } = {}) {
    const uid = normalizedId(accountId, 128) || 'unknown';
    const actionPolicies = policies[action];
    if (!Array.isArray(actionPolicies) || !actionPolicies.length) throw new TypeError(`unknown chat rate scope: ${action}`);
    let retryAfterMs = 0;
    const scopes = includeTotal ? [['total', policies.total], [action, actionPolicies]] : [[action, actionPolicies]];
    for (const [scope, scopePolicies] of scopes) {
      if (!Array.isArray(scopePolicies)) continue;
      for (const policy of scopePolicies) {
        if (!policy || !Number.isSafeInteger(policy.limit) || policy.limit < 1
          || !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1) throw new TypeError('invalid chat rate policy');
        retryAfterMs = Math.max(retryAfterMs, consumeWindow(uid, scope, policy, now) || 0);
      }
    }
    return retryAfterMs
      ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
      : { allowed: true, retryAfterSeconds: 0 };
  }

  return { consume, get size() { return entries.size; } };
}

function createChatRealtimeFanout({
  currentMemberIds,
  socketsForUser,
  isCurrentMember,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  highWaterBytes = DEFAULT_HIGH_WATER_BYTES,
  lowWaterBytes = DEFAULT_LOW_WATER_BYTES,
} = {}) {
  if (typeof currentMemberIds !== 'function' || typeof socketsForUser !== 'function' || typeof isCurrentMember !== 'function') {
    throw new TypeError('chat realtime membership adapters are required');
  }

  function pendingSet(ws) {
    if (!(ws._chatResyncServers instanceof Set)) ws._chatResyncServers = new Set();
    return ws._chatResyncServers;
  }

  function requestResync(ws, serverId, reason = 'backpressure') {
    const sid = normalizedId(serverId);
    if (!ws || !sid) return false;
    const pending = pendingSet(ws);
    if (pending.size < MAX_PENDING_RESYNCS || pending.has(sid)) pending.add(sid);
    else ws._chatResyncAll = true;
    if (!(ws._chatResyncReasons instanceof Map)) ws._chatResyncReasons = new Map();
    if (ws._chatResyncReasons.size < MAX_PENDING_RESYNCS || ws._chatResyncReasons.has(sid)) {
      ws._chatResyncReasons.set(sid, reason === 'reconnect' ? 'reconnect' : 'backpressure');
    }
    return true;
  }

  function flushSocket(ws) {
    if (!ws || ws.readyState !== 1 || Number(ws.bufferedAmount || 0) > lowWaterBytes) return 0;
    const uid = normalizedId(ws._userId, 128);
    if (!uid) return 0;
    const pending = pendingSet(ws);
    if (ws._chatResyncAll) {
      const connected = normalizedId(ws._chatServerId);
      if (connected) pending.add(connected);
      ws._chatResyncAll = false;
    }
    let sent = 0;
    for (const sid of [...pending]) {
      if (sent >= MAX_RESYNCS_PER_FLUSH || Number(ws.bufferedAmount || 0) > lowWaterBytes) break;
      if (ws._chatServerId !== sid || !isCurrentMember(uid, sid)) {
        pending.delete(sid);
        ws._chatResyncReasons?.delete(sid);
        continue;
      }
      const payload = chatResyncEvent(sid, ws._chatResyncReasons?.get(sid));
      if (!payload) {
        pending.delete(sid);
        ws._chatResyncReasons?.delete(sid);
        continue;
      }
      try {
        ws.send(JSON.stringify(payload));
        pending.delete(sid);
        ws._chatResyncReasons?.delete(sid);
        sent++;
      } catch {
        try { ws.terminate(); } catch { try { ws.close(); } catch { /**/ } }
        break;
      }
    }
    return sent;
  }

  function sendToSocket(ws, uid, serverId, envelope) {
    if (!ws || ws.readyState !== 1 || ws._userId !== uid || ws._chatServerId !== serverId
      || !isCurrentMember(uid, serverId)) return false;
    if (Number(ws.bufferedAmount || 0) > highWaterBytes) {
      // A resync frame queued behind an already congested socket is not a recovery signal: it can
      // be delayed forever together with the incrementals it is meant to replace. Force a clean
      // reconnect instead; the authenticated handshake advertises chat-ready and the client then
      // refreshes its current server over HTTP before accepting new incrementals.
      try { ws.terminate(); } catch { try { ws.close(); } catch { /**/ } }
      return false;
    }
    flushSocket(ws);
    const pending = pendingSet(ws);
    if (pending.has(serverId) || ws._chatResyncAll) return false;
    if (!envelope || byteLength(envelope) > maxEventBytes) {
      requestResync(ws, serverId, 'backpressure');
      flushSocket(ws);
      return false;
    }
    try {
      ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      try { ws.terminate(); } catch { try { ws.close(); } catch { /**/ } }
      return false;
    }
  }

  function broadcast(serverId, envelopeForUser) {
    const sid = normalizedId(serverId);
    if (!sid || typeof envelopeForUser !== 'function') return { recipients: 0, delivered: 0, resyncs: 0 };
    const uniqueMembers = new Set(currentMemberIds(sid).map((uid) => normalizedId(uid, 128)).filter(Boolean));
    let delivered = 0;
    let resyncs = 0;
    for (const uid of uniqueMembers) {
      const sockets = socketsForUser(uid);
      if (!sockets) continue;
      const eligible = [...sockets].filter((ws) => ws && ws.readyState === 1
        && ws._userId === uid && ws._chatServerId === sid && isCurrentMember(uid, sid));
      if (!eligible.length) continue;
      const envelope = envelopeForUser(uid);
      for (const ws of eligible) {
        if (sendToSocket(ws, uid, sid, envelope)) delivered++;
        else if (pendingSet(ws).has(sid) || ws._chatResyncAll) resyncs++;
      }
    }
    return { recipients: uniqueMembers.size, delivered, resyncs };
  }

  return {
    broadcast,
    flushSocket,
    requestResync,
    maxEventBytes,
  };
}

function admitBoundedNotifySocket(socketSet, socket, maxSockets = 4) {
  if (!(socketSet instanceof Set) || !socket) throw new TypeError('socket set and socket are required');
  if (!Number.isSafeInteger(maxSockets) || maxSockets < 1 || maxSockets > 32) throw new TypeError('invalid socket cap');
  if (socketSet.size >= maxSockets) {
    // Keep the existing transports stable. Evicting the oldest makes cap+1 auto-reconnecting
    // clients evict one another forever. 4008 is realtime-only capacity, never an auth failure.
    try { socket.close(4008, 'realtime connection capacity'); }
    catch { try { socket.terminate(); } catch { /**/ } }
    return false;
  }
  socketSet.add(socket);
  return true;
}

function sendBoundedNotifyFrames(socketSet, payload, {
  maxFrameBytes = 64 * 1024,
  highWaterBytes = DEFAULT_HIGH_WATER_BYTES,
} = {}) {
  if (!socketSet || typeof socketSet[Symbol.iterator] !== 'function') return { delivered: 0, terminated: 0, rejected: true };
  let data;
  try { data = JSON.stringify(payload); } catch { return { delivered: 0, terminated: 0, rejected: true }; }
  if (Buffer.byteLength(data, 'utf8') > maxFrameBytes) return { delivered: 0, terminated: 0, rejected: true };
  let delivered = 0;
  let terminated = 0;
  for (const ws of socketSet) {
    if (!ws || ws.readyState !== 1) continue;
    if (Number(ws.bufferedAmount || 0) > highWaterBytes) {
      try { ws.terminate(); } catch { try { ws.close(); } catch { /**/ } }
      terminated++;
      continue;
    }
    try { ws.send(data); delivered++; }
    catch {
      try { ws.terminate(); } catch { try { ws.close(); } catch { /**/ } }
      terminated++;
    }
  }
  return { delivered, terminated, rejected: false };
}

function createNotifyInboundGuard({
  maxFrameBytes = 4 * 1024,
  burstLimit = 30,
  burstWindowMs = 10_000,
  minuteLimit = 120,
  minuteWindowMs = 60_000,
  accountBurstLimit = 60,
  accountMinuteLimit = 240,
  maxAccounts = 50_000,
} = {}) {
  for (const value of [
    maxFrameBytes, burstLimit, burstWindowMs, minuteLimit, minuteWindowMs,
    accountBurstLimit, accountMinuteLimit, maxAccounts,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('invalid notify inbound limit');
  }
  const accounts = new Map();
  const allowedKeys = {
    ping: new Set(['t']),
    presence: new Set(['t', 'away', 'activeServerId', 'connectedServerId', 'lastReleaseSid', 'chatProtocol']),
  };

  function consumeWindow(ws, field, limit, windowMs, now) {
    let state = ws[field];
    if (!state || now - state.startedAt >= windowMs) state = ws[field] = { startedAt: now, count: 0 };
    state.count++;
    return state.count <= limit;
  }

  function reject(reason) { return { allowed: false, code: 4009, reason }; }

  function consumeAccount(accountId, now) {
    let state = accounts.get(accountId);
    if (!state) {
      if (accounts.size >= maxAccounts) accounts.delete(accounts.keys().next().value);
      state = {
        burst: { startedAt: now, count: 0 },
        minute: { startedAt: now, count: 0 },
      };
    } else {
      accounts.delete(accountId);
    }
    accounts.set(accountId, state);
    for (const [field, limit, windowMs] of [
      ['burst', accountBurstLimit, burstWindowMs],
      ['minute', accountMinuteLimit, minuteWindowMs],
    ]) {
      if (now - state[field].startedAt >= windowMs) state[field] = { startedAt: now, count: 0 };
      state[field].count++;
      if (state[field].count > limit) return false;
    }
    return true;
  }

  function inspect(ws, data, now = Date.now()) {
    if (!ws) return reject('invalid realtime frame');
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data || ''), 'utf8');
    if (size < 1 || size > maxFrameBytes) return reject('realtime frame too large');
    if (!consumeWindow(ws, '_notifyInboundBurst', burstLimit, burstWindowMs, now)
      || !consumeWindow(ws, '_notifyInboundMinute', minuteLimit, minuteWindowMs, now)) {
      return reject('realtime frame rate exceeded');
    }
    const accountId = normalizedId(ws._userId, 128);
    if (!accountId || !consumeAccount(accountId, now)) return reject('account realtime frame rate exceeded');
    let value;
    try { value = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
    catch { return reject('invalid realtime json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !allowedKeys[value.t]) return reject('invalid realtime schema');
    if (Object.keys(value).some((key) => !allowedKeys[value.t].has(key))) return reject('invalid realtime schema');
    if (value.t === 'ping') return { allowed: true, value };
    if (typeof value.away !== 'boolean') return reject('invalid presence');
    for (const field of ['activeServerId', 'connectedServerId']) {
      if (value[field] != null && (typeof value[field] !== 'string' || value[field].length > 80)) return reject('invalid presence');
    }
    if (value.chatProtocol !== undefined && value.chatProtocol !== 1) return reject('invalid presence');
    const releaseSid = value.lastReleaseSid === undefined ? 0 : Number(value.lastReleaseSid);
    if (!Number.isSafeInteger(releaseSid) || releaseSid < 0) return reject('invalid presence');
    value.lastReleaseSid = releaseSid;
    return { allowed: true, value };
  }

  return { inspect, get accountSize() { return accounts.size; } };
}

module.exports = {
  CHAT_EVENT_VERSION,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_RATE_POLICIES,
  admitBoundedNotifySocket,
  canonicalReactionIdentity,
  chatClearedEvent,
  chatReadyEvent,
  chatResyncEvent,
  createChatEnvelope,
  createChatRevisionStore,
  createChatRateLimiter,
  createChatRealtimeFanout,
  createNotifyInboundGuard,
  canonicalMessageShape,
  hasAllMention,
  installChatRevisionSchema,
  cleanupInvalidLegacyReactions,
  messageCreatedEvent,
  messageDeletedEvent,
  messageUpdatedEvent,
  reactionsUpdatedEvent,
  sanitizeMessageEmotes,
  sendBoundedNotifyFrames,
};

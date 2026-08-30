'use strict';

const CHAT_PROTOCOL_HEADER = 'x-relay-chat-protocol';
const CHAT_PROTOCOL_VALUE = 'canonical-v1';
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_MAX_PENDING_SERVERS = 256;
const DEFAULT_MAX_FLUSH_BATCH = 32;

function isCanonicalChatRequest(headers) {
  if (!headers || typeof headers !== 'object') return false;
  const value = headers[CHAT_PROTOCOL_HEADER] ?? headers['X-Relay-Chat-Protocol'];
  return typeof value === 'string' && value === CHAT_PROTOCOL_VALUE;
}

function validServerId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function legacyChatSocketEligible(socket, serverId) {
  return validServerId(serverId) && !!socket && socket.readyState === 1
    && socket._chatProtocolV1 !== true && socket._activeServerId === serverId;
}

// During the canonical rollout an already-open legacy client still learns durable mutations by
// merging HTTP history. The first mutation opens one fixed delay: the participant-authored
// compatibility packet reaches current legacy clients first, then this authoritative merge repairs
// a lost packet. Later mutations coalesce without moving the deadline, so continuous traffic cannot
// postpone recovery forever. One timer and a bounded map prevent an unbounded timer/RPC fanout.
function createLegacyChatRefreshBridge({
  notifyServer,
  delayMs = DEFAULT_DELAY_MS,
  maxPendingServers = DEFAULT_MAX_PENDING_SERVERS,
  maxFlushBatch = DEFAULT_MAX_FLUSH_BATCH,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof notifyServer !== 'function' || typeof now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('legacy chat refresh bridge adapters are required');
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0
    || !Number.isSafeInteger(maxPendingServers) || maxPendingServers < 1
    || !Number.isSafeInteger(maxFlushBatch) || maxFlushBatch < 1) {
    throw new TypeError('invalid legacy chat refresh bridge bound');
  }

  const dueByServer = new Map();
  let timer = null;

  function earliestDue() {
    let earliest = Infinity;
    for (const due of dueByServer.values()) earliest = Math.min(earliest, due);
    return earliest;
  }

  function schedule() {
    if (timer !== null || !dueByServer.size) return;
    const waitMs = Math.max(0, earliestDue() - now());
    timer = setTimer(flushDue, waitMs);
    // A rollout fallback must never keep a CLI/test process alive by itself.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function flushDue() {
    timer = null;
    const current = now();
    let flushed = 0;
    for (const [serverId, due] of dueByServer) {
      if (due > current || flushed >= maxFlushBatch) continue;
      dueByServer.delete(serverId);
      flushed++;
      try {
        notifyServer(serverId, { t: 'chat-refresh', serverId, reason: 'chat-mutation' });
      } catch { /* best-effort compatibility path must not affect canonical mutation success */ }
    }
    schedule();
  }

  function enqueue(serverId) {
    if (!validServerId(serverId)) return false;
    if (!dueByServer.has(serverId) && dueByServer.size >= maxPendingServers) return false;
    if (!dueByServer.has(serverId)) dueByServer.set(serverId, now() + delayMs);
    schedule();
    return true;
  }

  function close() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    dueByServer.clear();
  }

  return {
    enqueue,
    close,
    get pending() { return dueByServer.size; },
  };
}

module.exports = {
  CHAT_PROTOCOL_HEADER,
  CHAT_PROTOCOL_VALUE,
  createLegacyChatRefreshBridge,
  isCanonicalChatRequest,
  legacyChatSocketEligible,
};

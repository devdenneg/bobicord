'use strict';

// A persistent, per-user voice ownership fence.  The epoch is never reset by a
// release, so a delayed request from an older device cannot affect a newer
// owner (including after an API process restart).
function createVoiceLeaseStore(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
  const now = typeof options.now === 'function' ? options.now : Date.now;

  db.exec(`CREATE TABLE IF NOT EXISTS voice_leases(
    user_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL DEFAULT '',
    server_id TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS voice_session_intents(
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    intent INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY(user_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS voice_user_intents(
    user_id TEXT PRIMARY KEY,
    ticket INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    client_intent INTEGER NOT NULL,
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    lease_epoch INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL
  )`);

  const getRow = db.prepare(
    'SELECT epoch,session_id,server_id,channel_id,claimed_at,active FROM voice_leases WHERE user_id=?'
  );
  const insertRow = db.prepare(
    'INSERT INTO voice_leases(user_id,epoch,session_id,server_id,channel_id,claimed_at,active) VALUES(?,?,?,?,?,?,1)'
  );
  const replaceRow = db.prepare(
    'UPDATE voice_leases SET epoch=?,session_id=?,server_id=?,channel_id=?,claimed_at=?,active=1 WHERE user_id=?'
  );
  const clearMatching = db.prepare(
    "UPDATE voice_leases SET session_id='',server_id='',channel_id='',claimed_at=0,active=0 " +
    'WHERE user_id=? AND active=1 AND session_id=? AND epoch=?'
  );
  const getSessionIntent = db.prepare(
    'SELECT intent FROM voice_session_intents WHERE user_id=? AND session_id=?'
  );
  const putSessionIntent = db.prepare(
    `INSERT INTO voice_session_intents(user_id,session_id,intent,updated) VALUES(?,?,?,?)
     ON CONFLICT(user_id,session_id) DO UPDATE SET intent=excluded.intent,updated=excluded.updated
     WHERE excluded.intent > voice_session_intents.intent`
  );
  const pruneSessionIntents = db.prepare('DELETE FROM voice_session_intents WHERE updated<?');
  const getUserIntent = db.prepare(
    'SELECT ticket,session_id,client_intent,server_id,channel_id,consumed,lease_epoch,updated ' +
    'FROM voice_user_intents WHERE user_id=?'
  );
  const insertUserIntent = db.prepare(
    `INSERT INTO voice_user_intents(
      user_id,ticket,session_id,client_intent,server_id,channel_id,consumed,lease_epoch,updated
    ) VALUES(?,?,?,?,?,?,0,0,?)`
  );
  const replaceUserIntent = db.prepare(
    `UPDATE voice_user_intents SET
      ticket=?,session_id=?,client_intent=?,server_id=?,channel_id=?,consumed=0,lease_epoch=0,updated=?
     WHERE user_id=?`
  );
  const consumeUserIntent = db.prepare(
    'UPDATE voice_user_intents SET consumed=1,lease_epoch=?,updated=? WHERE user_id=? AND ticket=? AND consumed=0'
  );

  const publicLease = (row) => row && row.active ? {
    sessionId: row.session_id,
    serverId: row.server_id,
    channelId: row.channel_id,
    epoch: row.epoch,
    claimedAt: row.claimed_at,
  } : null;

  const snapshot = (userId) => {
    const row = getRow.get(userId);
    return { lease: publicLease(row), currentEpoch: row ? row.epoch : 0 };
  };

  const validateBinding = (input, intentField = 'clientIntent') => {
    if (!input || typeof input !== 'object') throw new TypeError('voice intent is required');
    const clientIntent = input[intentField];
    if (!Number.isSafeInteger(clientIntent) || clientIntent < 1) throw new TypeError('voice intent is required');
    for (const field of ['sessionId', 'serverId', 'channelId']) {
      if (typeof input[field] !== 'string' || input[field].length === 0) {
        throw new TypeError(`voice ${field} is required`);
      }
    }
    return clientIntent;
  };

  const sameIntentBinding = (row, input, clientIntent) => Boolean(row)
    && row.session_id === input.sessionId
    && row.client_intent === clientIntent
    && row.server_id === input.serverId
    && row.channel_id === input.channelId;

  const publicIntent = (row) => row ? {
    ticket: row.ticket,
    sessionId: row.session_id,
    clientIntent: row.client_intent,
    serverId: row.server_id,
    channelId: row.channel_id,
    consumed: Boolean(row.consumed),
    leaseEpoch: row.lease_epoch || 0,
  } : null;

  // Minting is deliberately separate from claiming. The client starts this
  // request as soon as the user expresses an intent, before media setup. It
  // advances the cross-session fence but never touches the current lease.
  const mintTx = db.transaction((userId, input) => {
    const clientIntent = validateBinding(input);
    const seen = getSessionIntent.get(userId, input.sessionId);
    const current = getUserIntent.get(userId);

    // The current tuple itself is the durable idempotency record. Session
    // history is pruned eventually, but retrying the current mint must still
    // return its original ticket after a long outage or process restart.
    if (sameIntentBinding(current, input, clientIntent)) {
      return {
        ...snapshot(userId),
        intent: publicIntent(current),
        ticket: current.ticket,
        accepted: true,
        idempotent: true,
        reason: 'idempotent',
      };
    }

    if (seen && seen.intent >= clientIntent) {
      return {
        ...snapshot(userId),
        intent: publicIntent(current),
        ticket: current ? current.ticket : 0,
        accepted: false,
        idempotent: false,
        reason: 'stale',
      };
    }

    const updated = Math.trunc(now());
    pruneSessionIntents.run(updated - 30 * 24 * 60 * 60 * 1000);
    if (current && !Number.isSafeInteger(current.ticket)) {
      throw new RangeError('voice intent ticket exhausted');
    }
    const ticket = current ? current.ticket + 1 : 1;
    if (!Number.isSafeInteger(ticket)) throw new RangeError('voice intent ticket exhausted');
    putSessionIntent.run(userId, input.sessionId, clientIntent, updated);
    if (current) {
      replaceUserIntent.run(
        ticket, input.sessionId, clientIntent, input.serverId, input.channelId, updated, userId
      );
    } else {
      insertUserIntent.run(
        userId, ticket, input.sessionId, clientIntent, input.serverId, input.channelId, updated
      );
    }
    const stored = getUserIntent.get(userId);
    return {
      ...snapshot(userId),
      intent: publicIntent(stored),
      ticket,
      accepted: true,
      idempotent: false,
      reason: 'minted',
    };
  });

  const claimTx = db.transaction((userId, input) => {
    validateBinding(input, 'intent');
    const modern = getUserIntent.get(userId);
    if (modern && modern.ticket > 0) {
      return {
        ...snapshot(userId),
        accepted: false,
        reason: 'ticket-required',
      };
    }
    const seen = getSessionIntent.get(userId, input.sessionId);
    if (seen && seen.intent >= input.intent) {
      return { ...snapshot(userId), accepted: false, reason: 'stale' };
    }
    const claimedAt = Math.trunc(now());
    // Tokens/sessions are short lived; retain a generous window for delayed packets without
    // growing one row forever for every historical LiveKit connection.
    pruneSessionIntents.run(claimedAt - 30 * 24 * 60 * 60 * 1000);
    putSessionIntent.run(userId, input.sessionId, input.intent, claimedAt);
    const previous = getRow.get(userId);
    const epoch = previous ? previous.epoch + 1 : 1;
    if (!Number.isSafeInteger(epoch)) throw new RangeError('voice lease epoch exhausted');
    if (previous) {
      replaceRow.run(epoch, input.sessionId, input.serverId, input.channelId, claimedAt, userId);
    } else {
      insertRow.run(userId, epoch, input.sessionId, input.serverId, input.channelId, claimedAt);
    }
    return {
      lease: { sessionId: input.sessionId, serverId: input.serverId, channelId: input.channelId, epoch, claimedAt },
      currentEpoch: epoch,
      accepted: true,
      reason: 'claimed',
    };
  });

  const claimTicketTx = db.transaction((userId, input) => {
    const clientIntent = validateBinding(input);
    if (!Number.isSafeInteger(input.ticket) || input.ticket < 1) {
      throw new TypeError('voice intent ticket is required');
    }
    const current = getUserIntent.get(userId);
    const state = snapshot(userId);
    if (!current || current.ticket !== input.ticket || !sameIntentBinding(current, input, clientIntent)) {
      return {
        ...state,
        ticket: input.ticket,
        currentTicket: current ? current.ticket : 0,
        accepted: false,
        idempotent: false,
        reason: 'stale-ticket',
      };
    }

    if (current.consumed) {
      const lease = state.lease;
      const isSameActiveLease = Boolean(lease)
        && current.lease_epoch > 0
        && lease.epoch === current.lease_epoch
        && lease.sessionId === input.sessionId
        && lease.serverId === input.serverId
        && lease.channelId === input.channelId;
      if (isSameActiveLease) {
        return {
          ...state,
          ticket: current.ticket,
          currentTicket: current.ticket,
          accepted: true,
          idempotent: true,
          reason: 'idempotent',
        };
      }
      return {
        ...state,
        ticket: current.ticket,
        currentTicket: current.ticket,
        accepted: false,
        idempotent: false,
        reason: 'consumed',
      };
    }

    const claimedAt = Math.trunc(now());
    const previous = getRow.get(userId);
    const epoch = previous ? previous.epoch + 1 : 1;
    if (!Number.isSafeInteger(epoch)) throw new RangeError('voice lease epoch exhausted');
    if (previous) {
      replaceRow.run(epoch, input.sessionId, input.serverId, input.channelId, claimedAt, userId);
    } else {
      insertRow.run(userId, epoch, input.sessionId, input.serverId, input.channelId, claimedAt);
    }
    const consumed = consumeUserIntent.run(epoch, claimedAt, userId, input.ticket).changes === 1;
    if (!consumed) throw new Error('voice intent consumption race');
    return {
      lease: { sessionId: input.sessionId, serverId: input.serverId, channelId: input.channelId, epoch, claimedAt },
      currentEpoch: epoch,
      ticket: input.ticket,
      currentTicket: input.ticket,
      accepted: true,
      idempotent: false,
      reason: 'claimed',
    };
  });

  const releaseTx = db.transaction((userId, sessionId, epoch) => {
    const before = getRow.get(userId);
    if (!before || !before.active || before.session_id !== sessionId || before.epoch !== epoch) {
      const state = { lease: publicLease(before), currentEpoch: before ? before.epoch : 0 };
      return { ...state, released: false, reason: 'stale' };
    }
    const changed = clearMatching.run(userId, sessionId, epoch).changes === 1;
    const state = snapshot(userId);
    return { ...state, released: changed, reason: changed ? 'released' : 'stale' };
  });

  // better-sqlite3's IMMEDIATE variant takes the write lock before the first
  // SELECT. This preserves unique epochs even if two API processes share the
  // same SQLite file. The fallback keeps the tiny test fixture compatible.
  const runClaim = (userId, input) => typeof claimTx.immediate === 'function'
    ? claimTx.immediate(userId, input) : claimTx(userId, input);
  const runMint = (userId, input) => typeof mintTx.immediate === 'function'
    ? mintTx.immediate(userId, input) : mintTx(userId, input);
  const runClaimTicket = (userId, input) => typeof claimTicketTx.immediate === 'function'
    ? claimTicketTx.immediate(userId, input) : claimTicketTx(userId, input);
  const runRelease = (userId, sessionId, epoch) => typeof releaseTx.immediate === 'function'
    ? releaseTx.immediate(userId, sessionId, epoch) : releaseTx(userId, sessionId, epoch);

  return {
    mint(userId, input) { return runMint(userId, input); },
    claimTicket(userId, input) { return runClaimTicket(userId, input); },
    claim(userId, input) { return runClaim(userId, input); },
    release(userId, sessionId, epoch) { return runRelease(userId, sessionId, epoch); },
    read(userId) { return snapshot(userId); },
  };
}

function voiceLeaseEvent(state, reason) {
  const event = {
    t: 'voice-lease',
    reason,
    lease: state.lease || null,
    currentEpoch: state.currentEpoch || 0,
  };
  if (typeof state.accepted === 'boolean') event.accepted = state.accepted;
  return event;
}

// Collapse multiple LiveKit sessions of one account for the initial presence
// response. When a user has entered the lease protocol, only the exact active
// {session, server, channel, epoch} is allowed to contribute voice presence.
// This makes an old LiveKit participant a tombstone after handoff/release rather
// than letting its stale vc attribute resurrect on the next REST poll.
function selectVoiceState(participants, baseIdentity, options = {}) {
  const leaseForUser = typeof options.leaseForUser === 'function' ? options.leaseForUser : null;
  const serverId = options.serverId == null ? '' : String(options.serverId);
  const online = new Set(), picked = new Map(), leaseStates = new Map();
  for (const participant of participants || []) {
    const identity = String(participant.identity || '');
    const user = baseIdentity(identity);
    online.add(user);
    const attrs = participant.attributes || {}, channelId = attrs.vc;
    if (!channelId) continue;
    const rawEpoch = Number(attrs.voiceEpoch);
    const hash = identity.indexOf('#');
    const identitySession = hash < 0 ? identity : identity.slice(hash + 1);
    const declaredSession = String(attrs.voiceSession || '');
    const epoch = Number.isSafeInteger(rawEpoch) && rawEpoch > 0 && declaredSession === identitySession ? rawEpoch : null;
    // Presence carrying only half of the lease tuple is malformed, not legacy.
    if (epoch === null && (attrs.voiceEpoch || attrs.voiceSession)) continue;
    if (leaseForUser) {
      if (!leaseStates.has(user)) leaseStates.set(user, leaseForUser(user) || { lease: null, currentEpoch: 0 });
      const state = leaseStates.get(user);
      if (state.currentEpoch > 0) {
        const lease = state.lease;
        if (epoch === null || !lease || lease.sessionId !== identitySession || lease.epoch !== epoch
          || lease.channelId !== String(channelId) || (serverId && lease.serverId !== serverId)) continue;
      }
    }
    const current = picked.get(user);
    if (!current || (epoch !== null && (current.epoch === null || epoch >= current.epoch)) || (epoch === null && current.epoch === null)) {
      picked.set(user, { channelId: String(channelId), epoch });
    }
  }
  const voice = {};
  for (const [user, state] of picked) voice[user] = state.channelId;
  return { online, voice };
}

module.exports = { createVoiceLeaseStore, voiceLeaseEvent, selectVoiceState };

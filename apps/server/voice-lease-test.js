'use strict';

const { createVoiceLeaseStore, voiceLeaseEvent, selectVoiceState } = require('./voiceLease');

// Tiny deterministic better-sqlite3-compatible fixture. Production uses a real
// SQLite transaction; this fixture lets the lease state-machine regression test
// run even before server dependencies are installed in a fresh checkout.
class FakeDb {
  constructor() { this.rows = new Map(); this.intents = new Map(); this.userIntents = new Map(); }
  exec() {}
  transaction(fn) { return (...args) => fn(...args); }
  prepare(sql) {
    if (sql.startsWith('SELECT epoch')) return { get: (uid) => {
      const row = this.rows.get(uid); return row ? { ...row } : undefined;
    } };
    if (sql.startsWith('SELECT intent')) return { get: (uid, sessionId) => {
      const intent = this.intents.get(`${uid}:${sessionId}`);
      return intent == null ? undefined : { intent };
    } };
    if (sql.startsWith('SELECT ticket')) return { get: (uid) => {
      const row = this.userIntents.get(uid); return row ? { ...row } : undefined;
    } };
    if (sql.startsWith('INSERT INTO voice_session_intents')) return { run: (uid, sessionId, intent) => {
      const key = `${uid}:${sessionId}`, previous = this.intents.get(key);
      if (previous != null && previous >= intent) return { changes: 0 };
      this.intents.set(key, intent); return { changes: 1 };
    } };
    if (sql.startsWith('DELETE FROM voice_session_intents')) return { run: () => ({ changes: 0 }) };
    if (sql.startsWith('INSERT INTO voice_user_intents')) return { run: (
      uid, ticket, sessionId, clientIntent, serverId, channelId, updated
    ) => {
      if (this.userIntents.has(uid)) throw new Error('UNIQUE constraint failed: voice_user_intents.user_id');
      this.userIntents.set(uid, {
        ticket, session_id: sessionId, client_intent: clientIntent, server_id: serverId,
        channel_id: channelId, consumed: 0, lease_epoch: 0, updated,
      });
      return { changes: 1 };
    } };
    if (sql.startsWith('UPDATE voice_user_intents SET\n      ticket=')) return { run: (
      ticket, sessionId, clientIntent, serverId, channelId, updated, uid
    ) => {
      if (!this.userIntents.has(uid)) return { changes: 0 };
      this.userIntents.set(uid, {
        ticket, session_id: sessionId, client_intent: clientIntent, server_id: serverId,
        channel_id: channelId, consumed: 0, lease_epoch: 0, updated,
      });
      return { changes: 1 };
    } };
    if (sql.startsWith('UPDATE voice_user_intents SET consumed=1')) return { run: (
      leaseEpoch, updated, uid, ticket
    ) => {
      const row = this.userIntents.get(uid);
      if (!row || row.ticket !== ticket || row.consumed) return { changes: 0 };
      this.userIntents.set(uid, { ...row, consumed: 1, lease_epoch: leaseEpoch, updated });
      return { changes: 1 };
    } };
    if (sql.startsWith('INSERT INTO voice_leases')) return { run: (uid, epoch, sessionId, serverId, channelId, claimedAt) => {
      this.rows.set(uid, { epoch, session_id: sessionId, server_id: serverId, channel_id: channelId, claimed_at: claimedAt, active: 1 });
      return { changes: 1 };
    } };
    if (sql.startsWith('UPDATE voice_leases SET epoch=')) return { run: (epoch, sessionId, serverId, channelId, claimedAt, uid) => {
      this.rows.set(uid, { epoch, session_id: sessionId, server_id: serverId, channel_id: channelId, claimed_at: claimedAt, active: 1 });
      return { changes: 1 };
    } };
    if (sql.startsWith("UPDATE voice_leases SET session_id=''")) return { run: (uid, sessionId, epoch) => {
      const row = this.rows.get(uid);
      if (!row || !row.active || row.session_id !== sessionId || row.epoch !== epoch) return { changes: 0 };
      this.rows.set(uid, { ...row, session_id: '', server_id: '', channel_id: '', claimed_at: 0, active: 0 });
      return { changes: 1 };
    } };
    throw new Error('Unsupported test SQL: ' + sql);
  }
  close() {}
}

let failed = 0;
function ok(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (!condition) failed++;
}

const db = new FakeDb();
let clock = 1_000;
const leases = createVoiceLeaseStore(db, { now: () => ++clock });
const a = { sessionId: 'pc-a', serverId: 'srv-a', channelId: 'voice-a', intent: 1 };
const b = { sessionId: 'phone-b', serverId: 'srv-a', channelId: 'voice-a', intent: 1 };

// Two claims that arrive together are serialized by the SQLite transaction:
// epochs are unique and the last linearized claim is the sole owner.
const claimA = leases.claim('user-1', a);
const claimB = leases.claim('user-1', b);
const afterRace = leases.read('user-1');
ok('simultaneous claims receive strictly increasing epochs', claimA.currentEpoch === 1 && claimB.currentEpoch === 2);
ok('simultaneous claims leave exactly the last session as owner', afterRace.lease.sessionId === b.sessionId && afterRace.currentEpoch === 2);

// A delayed leave from PC must not clear the newer phone lease.
const staleRelease = leases.release('user-1', a.sessionId, claimA.currentEpoch);
const afterStaleRelease = leases.read('user-1');
ok('stale release is rejected', staleRelease.released === false && staleRelease.reason === 'stale');
ok('stale release cannot clear a newer owner', afterStaleRelease.lease.sessionId === b.sessionId && afterStaleRelease.currentEpoch === 2);

// Going offline/reconnecting is a read/snapshot only.  Recreating the store
// simulates an API process restart and proves ownership/epoch are persistent.
const reconnectSnapshot = leases.read('user-1');
const afterRestart = createVoiceLeaseStore(db, { now: () => ++clock });
const restartSnapshot = afterRestart.read('user-1');
ok('offline reconnect read does not acquire or increment a lease', reconnectSnapshot.currentEpoch === 2 && reconnectSnapshot.lease.sessionId === b.sessionId);
ok('lease survives process restart without being re-acquired', restartSnapshot.currentEpoch === 2 && restartSnapshot.lease.sessionId === b.sessionId);
const wsSnapshot = voiceLeaseEvent(restartSnapshot, 'snapshot');
ok('reconnect WS snapshot is observational only', wsSnapshot.reason === 'snapshot' && wsSnapshot.lease.sessionId === b.sessionId && afterRestart.read('user-1').currentEpoch === 2);

// Only the current {sessionId, epoch} pair can release.  Epoch remains as a
// fence after release, and duplicate packets are harmless.
const releaseB = afterRestart.release('user-1', b.sessionId, claimB.currentEpoch);
const duplicateReleaseB = afterRestart.release('user-1', b.sessionId, claimB.currentEpoch);
const afterRelease = afterRestart.read('user-1');
ok('matching owner release clears the active lease', releaseB.released === true && releaseB.lease === null);
ok('release preserves the monotonic epoch fence', afterRelease.lease === null && afterRelease.currentEpoch === 2);
ok('duplicate release is harmless', duplicateReleaseB.released === false && afterRestart.read('user-1').lease === null);

// Epochs continue after a released lease rather than restarting at one.
const claimC = afterRestart.claim('user-1', { sessionId: 'pc-c', serverId: 'srv-b', channelId: 'voice-b', intent: 1 });
ok('claim after release continues the epoch sequence', claimC.currentEpoch === 3);

// Same LiveKit session can issue A→B quickly. Network inversion must not let the
// older A request arrive last and overwrite the user's newer B intent.
const newestFirst = afterRestart.claim('user-2', { sessionId: 'same', serverId: 'srv-a', channelId: 'voice-b', intent: 2 });
const staleAfter = afterRestart.claim('user-2', { sessionId: 'same', serverId: 'srv-a', channelId: 'voice-a', intent: 1 });
const newerAgain = afterRestart.claim('user-2', { sessionId: 'same', serverId: 'srv-a', channelId: 'voice-c', intent: 3 });
ok('same-session out-of-order claim is rejected by client intent sequence', newestFirst.accepted === true && staleAfter.accepted === false);
ok('stale same-session claim returns the current owner without incrementing epoch', staleAfter.lease.channelId === 'voice-b' && staleAfter.currentEpoch === 1);
ok('a later same-session intent still advances ownership normally', newerAgain.accepted === true && newerAgain.currentEpoch === 2 && newerAgain.lease.channelId === 'voice-c');

// Modern handoff is split in two phases. Minting records the user's latest
// cross-device intent without interrupting media that is still playing on the
// current owner; claim atomically consumes that ticket and advances the lease.
const legacyPc = afterRestart.claim('handoff-user', {
  sessionId: 'pc', serverId: 'srv-a', channelId: 'voice-a', intent: 1,
});
const phoneIntent = {
  sessionId: 'phone', serverId: 'srv-a', channelId: 'voice-a', clientIntent: 1,
};
const phoneMint = afterRestart.mint('handoff-user', phoneIntent);
const afterPhoneMint = afterRestart.read('handoff-user');
ok('first modern intent receives the first persistent user ticket', phoneMint.accepted === true && phoneMint.ticket === 1);
ok('minting a ticket never revokes or replaces the active lease', afterPhoneMint.lease.sessionId === 'pc' && afterPhoneMint.currentEpoch === legacyPc.currentEpoch);

const duplicatePhoneMint = afterRestart.mint('handoff-user', phoneIntent);
const ticketStoreRestart = createVoiceLeaseStore(db, { now: () => ++clock });
const restartPhoneMint = ticketStoreRestart.mint('handoff-user', phoneIntent);
ok('exact duplicate mint is idempotent and keeps its ticket', duplicatePhoneMint.idempotent === true && duplicatePhoneMint.ticket === phoneMint.ticket);
ok('mint idempotency survives a process restart', restartPhoneMint.idempotent === true && restartPhoneMint.ticket === phoneMint.ticket);

const wrongBindingClaim = ticketStoreRestart.claimTicket('handoff-user', {
  ...phoneIntent, channelId: 'voice-b', ticket: phoneMint.ticket,
});
ok('ticket is bound to the exact session, intent, server and channel', wrongBindingClaim.accepted === false && wrongBindingClaim.reason === 'stale-ticket');
ok('a binding mismatch leaves the old active lease untouched', ticketStoreRestart.read('handoff-user').lease.sessionId === 'pc');

const phoneClaim = ticketStoreRestart.claimTicket('handoff-user', { ...phoneIntent, ticket: phoneMint.ticket });
const duplicatePhoneClaim = ticketStoreRestart.claimTicket('handoff-user', { ...phoneIntent, ticket: phoneMint.ticket });
ok('current unconsumed ticket claims the lease with the next epoch', phoneClaim.accepted === true && phoneClaim.currentEpoch === legacyPc.currentEpoch + 1 && phoneClaim.lease.sessionId === 'phone');
ok('duplicate claim of the exact active lease is idempotent', duplicatePhoneClaim.accepted === true && duplicatePhoneClaim.idempotent === true && duplicatePhoneClaim.currentEpoch === phoneClaim.currentEpoch);

const forbiddenLegacy = ticketStoreRestart.claim('handoff-user', {
  sessionId: 'old-client', serverId: 'srv-a', channelId: 'voice-a', intent: 1,
});
ok('legacy claim is permanently fenced after the first modern ticket', forbiddenLegacy.accepted === false && forbiddenLegacy.reason === 'ticket-required' && forbiddenLegacy.currentEpoch === phoneClaim.currentEpoch);

ticketStoreRestart.release('handoff-user', phoneIntent.sessionId, phoneClaim.currentEpoch);
const resurrectPhone = ticketStoreRestart.claimTicket('handoff-user', { ...phoneIntent, ticket: phoneMint.ticket });
ok('released consumed ticket cannot resurrect its lease', resurrectPhone.accepted === false && resurrectPhone.reason === 'consumed' && ticketStoreRestart.read('handoff-user').lease === null);

const newestSameSession = ticketStoreRestart.mint('handoff-user', {
  ...phoneIntent, channelId: 'voice-c', clientIntent: 3,
});
const delayedSameSession = ticketStoreRestart.mint('handoff-user', {
  ...phoneIntent, channelId: 'voice-b', clientIntent: 2,
});
ok('new same-session intent advances the user ticket', newestSameSession.accepted === true && newestSameSession.ticket === phoneMint.ticket + 1);
ok('delayed lower same-session intent cannot mint over a newer one', delayedSameSession.accepted === false && delayedSameSession.reason === 'stale' && delayedSameSession.ticket === newestSameSession.ticket);

const tabletIntent = {
  sessionId: 'tablet', serverId: 'srv-b', channelId: 'voice-z', clientIntent: 1,
};
const tabletMint = ticketStoreRestart.mint('handoff-user', tabletIntent);
const stalePhoneClaim = ticketStoreRestart.claimTicket('handoff-user', {
  ...phoneIntent, channelId: 'voice-c', clientIntent: 3, ticket: newestSameSession.ticket,
});
ok('a newer device receives the next per-user ticket', tabletMint.accepted === true && tabletMint.ticket === newestSameSession.ticket + 1);
ok('older device ticket cannot claim after a newer device intent', stalePhoneClaim.accepted === false && stalePhoneClaim.reason === 'stale-ticket');
const tabletClaim = ticketStoreRestart.claimTicket('handoff-user', { ...tabletIntent, ticket: tabletMint.ticket });
ok('latest cross-device ticket claims normally', tabletClaim.accepted === true && tabletClaim.lease.sessionId === 'tablet' && tabletClaim.currentEpoch === phoneClaim.currentEpoch + 1);

db.userIntents.set('overflow-user', {
  ticket: Number.MAX_SAFE_INTEGER, session_id: 'old', client_intent: 1,
  server_id: 'srv-a', channel_id: 'voice-a', consumed: 1, lease_epoch: 0, updated: clock,
});
let overflowRejected = false;
try {
  ticketStoreRestart.mint('overflow-user', {
    sessionId: 'new', serverId: 'srv-a', channelId: 'voice-a', clientIntent: 1,
  });
} catch (error) {
  overflowRejected = error instanceof RangeError;
}
ok('ticket counter refuses to exceed JavaScript safe integers', overflowRejected);

const base = (identity) => identity.split('#')[0];
const presence = selectVoiceState([
  { identity: 'alice#phone', attributes: { vc: 'new-channel', voiceEpoch: '9', voiceSession: 'phone' } },
  { identity: 'alice#pc', attributes: { vc: 'old-channel', voiceEpoch: '4', voiceSession: 'pc' } },
  { identity: 'bob#one', attributes: { vc: 'legacy-one' } },
  { identity: 'bob#two', attributes: { vc: 'legacy-two' } },
  { identity: 'carol#new', attributes: { vc: 'aware', voiceEpoch: '2', voiceSession: 'new' } },
  { identity: 'carol#old', attributes: { vc: 'legacy' } },
], base);
ok('presence bootstrap selects the greatest voiceEpoch', presence.voice.alice === 'new-channel');
ok('presence bootstrap preserves last-one-wins for legacy clients', presence.voice.bob === 'legacy-two');
ok('presence bootstrap prefers a lease-aware session over legacy', presence.voice.carol === 'aware');

const authoritative = selectVoiceState([
  { identity: 'alice#phone', attributes: { vc: 'new-channel', voiceEpoch: '9', voiceSession: 'phone' } },
  { identity: 'alice#pc', attributes: { vc: 'old-channel', voiceEpoch: '4', voiceSession: 'pc' } },
  { identity: 'released#old', attributes: { vc: 'ghost-channel', voiceEpoch: '7', voiceSession: 'old' } },
  { identity: 'legacy#old', attributes: { vc: 'legacy-ghost' } },
  { identity: 'malformed#real', attributes: { vc: 'spoofed', voiceEpoch: '99', voiceSession: 'other' } },
], base, {
  serverId: 'srv-a',
  leaseForUser: (uid) => ({
    alice: { currentEpoch: 9, lease: { sessionId: 'phone', serverId: 'srv-a', channelId: 'new-channel', epoch: 9 } },
    released: { currentEpoch: 7, lease: null },
    legacy: { currentEpoch: 3, lease: null },
    malformed: { currentEpoch: 0, lease: null },
  }[uid] || { currentEpoch: 0, lease: null }),
});
ok('authoritative presence keeps only the exact active lease tuple', authoritative.voice.alice === 'new-channel');
ok('released lease suppresses stale participant voice attributes', authoritative.voice.released === undefined);
ok('users that entered lease protocol cannot fall back to legacy ghosts', authoritative.voice.legacy === undefined);
ok('mismatched voiceSession is rejected instead of treated as legacy', authoritative.voice.malformed === undefined);

db.close();
console.log(`\n${failed ? `${failed} FAIL` : 'ALL VOICE LEASE TESTS PASSED'}`);
process.exitCode = failed ? 1 : 0;

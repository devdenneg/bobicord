import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chatRealtime.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  MAX_CHAT_REALTIME_FRAME_BYTES,
  canReconcileUnchangedChatSnapshot,
  chatProtocolPresence,
  chatRealtimeTargetsServer,
  claimBoundedMessageId,
  parseChatRealtimeFrame,
  planChatEventReplay,
  preserveOptimisticAtSnapshot,
  validChatSnapshotRevisions,
} = await import('data:text/javascript,' + encodeURIComponent(js));

const message = {
  id: 41,
  uid: 'u_0123456789abcdef',
  name: 'Денис',
  color: 0xffffff,
  text: 'Привет',
  em: { wave: 'abc_123' },
  img: '',
  files: [],
  ts: 1_700_000_000_000,
  edited: false,
  mkey: 'client-1',
};
const created = {
  t: 'chat-event',
  v: 1,
  serverId: 's_0123456789abcdef',
  rev: 7,
  event: { type: 'message.created', message, mkey: 'client-1' },
};

const parsedCreated = parseChatRealtimeFrame(JSON.stringify(created));
assert.deepEqual(parsedCreated, created, 'exact canonical created envelope must parse');
assert.equal(chatRealtimeTargetsServer(parsedCreated, created.serverId), true);
assert.equal(chatRealtimeTargetsServer(parsedCreated, 's_other'), false,
  'an authenticated event still must match the Engine logical server');

assert.deepEqual(parseChatRealtimeFrame(JSON.stringify({ t: 'chat-ready', v: 1 })), { t: 'chat-ready', v: 1 });
assert.deepEqual(parseChatRealtimeFrame(JSON.stringify({
  t: 'chat-resync', v: 1, serverId: created.serverId, reason: 'reconnect',
})), { t: 'chat-resync', v: 1, serverId: created.serverId, reason: 'reconnect' });
const { mkey: _removedMkey, ...unkeyedMessage } = message;
const unkeyedCreated = {
  ...created,
  event: { type: 'message.created', message: unkeyedMessage },
};
assert.deepEqual(parseChatRealtimeFrame(JSON.stringify(unkeyedCreated)), unkeyedCreated,
  'a legacy POST without client key still produces a canonical created event');

assert.equal(parseChatRealtimeFrame(JSON.stringify({ ...created, v: 2 })), null, 'future versions fail closed');
assert.equal(parseChatRealtimeFrame(JSON.stringify({ ...created, extra: true })), null, 'unknown envelope fields fail closed');
assert.equal(parseChatRealtimeFrame(JSON.stringify({ ...created, rev: 0 })), null, 'revision must be positive');
assert.equal(parseChatRealtimeFrame(JSON.stringify({
  ...created, event: { ...created.event, mkey: 'different-key' },
})), null, 'redundant message/event keys may not disagree');
assert.equal(parseChatRealtimeFrame(JSON.stringify({
  ...created, event: { type: 'message.created', message: unkeyedMessage, mkey: '' },
})), null, 'an optional client key is omitted rather than represented by an empty identity');
assert.equal(parseChatRealtimeFrame(JSON.stringify({
  ...created, event: { ...created.event, message: { ...message, color: 0x1000000 } },
})), null, 'profile color above the shared wire maximum is rejected');
assert.equal(parseChatRealtimeFrame(JSON.stringify({
  ...created, event: { type: 'message.created', message: { ...message, em: { wave: 'bad id' } }, mkey: 'client-1' },
})), null, 'emote ids use the strict shared alphabet');
assert.equal(parseChatRealtimeFrame('x'.repeat(MAX_CHAT_REALTIME_FRAME_BYTES + 1)), null,
  'oversized raw frames are rejected before JSON parsing');

const reaction = parseChatRealtimeFrame(JSON.stringify({
  t: 'chat-event', v: 1, serverId: created.serverId, rev: 8,
  event: { type: 'reaction.updated', messageId: 41, reactions: [{ id: 'e1', name: 'Wave', count: 1000, mine: true }] },
}));
assert.equal(reaction?.event.type, 'reaction.updated');

const clearThenCreate = planChatEventReplay(10, [
  { rev: 12, event: 'new-message' },
  { rev: 11, event: 'clear' },
]);
assert.deepEqual(clearThenCreate, {
  events: [{ rev: 11, event: 'clear' }, { rev: 12, event: 'new-message' }],
  revision: 12,
  gap: false,
}, 'events buffered during snapshot fetch replay in revision order');
assert.deepEqual(planChatEventReplay(12, [
  { rev: 12, event: 'duplicate-old' },
  { rev: 13, event: 'one' },
  { rev: 13, event: 'duplicate' },
]), {
  events: [{ rev: 13, event: 'one' }], revision: 13, gap: false,
}, 'old and duplicate revisions are idempotent');
assert.deepEqual(planChatEventReplay(20, [{ rev: 22, event: 'gap' }]), {
  events: [], revision: 20, gap: true,
}, 'a missing revision requires another full snapshot');

assert.equal(validChatSnapshotRevisions(12, 9), true);
assert.equal(validChatSnapshotRevisions(12, 13), false, 'clear watermark cannot be newer than its snapshot');
assert.equal(validChatSnapshotRevisions('12', 9), false, 'revision metadata is never coerced from strings');
assert.deepEqual(chatProtocolPresence(false), {}, 'initial presence does not claim canonical capability');
assert.deepEqual(chatProtocolPresence(true), { chatProtocol: 1 }, 'exact parsed v1 readiness adds the presence ACK');
assert.equal(preserveOptimisticAtSnapshot(true, 3, 9), true,
  'an exact uid+mkey snapshot match always wins even across a clear watermark');
assert.equal(preserveOptimisticAtSnapshot(false, null, 9), true,
  'an unknown optimistic base remains retryable');
assert.equal(preserveOptimisticAtSnapshot(false, 9, 9), true,
  'a GET started before a newer POST cannot drop that post when no later clear exists');
assert.equal(preserveOptimisticAtSnapshot(false, 8, 9), false,
  'only a transactionally newer clear proves an unmatched optimistic row stale');

let mentionClaims = new Set();
assert.equal(claimBoundedMessageId(mentionClaims, 41), true,
  'a fresh canonical event wins the exact mention claim');
assert.equal(claimBoundedMessageId(mentionClaims, 41), false,
  'the following raw notify is suppressed by the same exact claim');
mentionClaims = new Set();
assert.equal(claimBoundedMessageId(mentionClaims, 42), true,
  'a raw notify can win when it arrives before the canonical event');
assert.equal(claimBoundedMessageId(mentionClaims, 42), false,
  'the later canonical event cannot notify twice');
const snapshotSeen = new Set();
mentionClaims = new Set();
assert.equal(claimBoundedMessageId(snapshotSeen, 43), true,
  'an initial snapshot seeds only the bounded seen-sid fence');
assert.equal(mentionClaims.size, 0, 'initial history is not falsely marked as delivered');
assert.equal(claimBoundedMessageId(mentionClaims, 43), true,
  'a raw notify following the initial snapshot still wins delivery');
assert.equal(claimBoundedMessageId(snapshotSeen, 44), true,
  'a later recovery snapshot detects a newly missed row');
assert.equal(claimBoundedMessageId(mentionClaims, 44), true,
  'that recovery snapshot can claim and batch its mention');
assert.equal(claimBoundedMessageId(mentionClaims, 44), false,
  'the raw frame after that recovery batch is suppressed');
mentionClaims = new Set();
assert.equal(claimBoundedMessageId(mentionClaims, 1, 2), true);
assert.equal(claimBoundedMessageId(mentionClaims, 2, 2), true);
assert.equal(claimBoundedMessageId(mentionClaims, 3, 2), true);
assert.deepEqual([...mentionClaims], [2, 3], 'the exact-id claim cache stays FIFO bounded');
assert.equal(canReconcileUnchangedChatSnapshot(true, true, 12, 9, 12, 9, [11, 12]), true,
  'an unchanged poll with only duplicate buffered revisions preserves paginated history');
assert.equal(canReconcileUnchangedChatSnapshot(false, true, 12, 9, 12, 9, []), false,
  'the first snapshot after legacy-to-canonical transition must replace participant ghosts');
assert.equal(canReconcileUnchangedChatSnapshot(true, true, 12, 9, 12, 9, [13]), false,
  'a newer buffered event requires authoritative replacement/replay');
assert.equal(canReconcileUnchangedChatSnapshot(true, true, 12, 9, 13, 9, []), false,
  'a changed snapshot revision cannot take the pagination-preserving fast path');
assert.equal(canReconcileUnchangedChatSnapshot(true, true, 12, 9, 12, 9, [], true), false,
  'buffer overflow always forces authoritative replacement');

const engineSource = readFileSync(join(here, 'engine.ts'), 'utf8');
const notifySource = readFileSync(join(here, 'notifyws.ts'), 'utf8');
const storeSource = readFileSync(join(here, 'store.ts'), 'utf8');
const apiSource = readFileSync(join(here, 'api.ts'), 'utf8');
const serverViewSource = readFileSync(join(here, 'components', 'ServerView.tsx'), 'utf8');

assert.match(engineSource, /liveByMkey\.get\(`\$\{m\.uid\}\\u0000\$\{m\.mkey\}`\)/,
  'optimistic adoption is keyed by exact uid plus mkey');
assert.match(engineSource, /this\.pendingSend\.delete\(live\.id\)/,
  'canonical creation proves persistence and clears pending HTTP state');
assert.match(engineSource, /canonical[\s\S]*this\.pendingSend\.delete\(localId\)/,
  'a lost HTTP response cannot mark a canonically adopted message failed');
assert.match(engineSource, /this\.pendingSend\.clear\(\);[\s\S]*this\.replaceChatSnapshot\(\[\], false, serverId\)/,
  'canonical clear removes pre-clear optimistic ghosts before later revisions replay');
assert.match(engineSource, /baseRevision: number \| null[\s\S]*preserveOptimisticAtSnapshot\(false, pending\?\.baseRevision, lastClearRevision\)[\s\S]*this\.pendingSend\.delete\(local\.id\)/,
  'canonical snapshots use the clear watermark instead of dropping truly in-flight optimistic rows');
assert.match(engineSource, /if \(!rowStillExists\) \{[\s\S]*resynchronizeChat\(this\.chatStateServerId\)/,
  'a successful POST whose optimistic/canonical row is absent resyncs for both older and newer clear races');
assert.match(engineSource, /validChatSnapshotRevisions\(revision, lastClearRevision\)[\s\S]*replaceChatSnapshot\(snapshot\.messages, snapshot\.hasMore, serverId, lastClearRevision\)/,
  'resync validates one authoritative revision/clear watermark snapshot before replacing state');
assert.match(engineSource, /this\.serverChatReady[\s\S]*d\.t === 'chat'[\s\S]*d\.t === 'clear'\)\) return;/,
  'all LiveKit durable packets, including packets without a resolved sender, are ignored after authenticated capability');
assert.doesNotMatch(engineSource, /sender\??\.name/,
  'participant display data never overrides the authenticated server member model');
assert.match(engineSource, /if \(this\.serverChatReady[\s\S]*obj\.t === 'chat'[\s\S]*obj\.t === 'clear'\)\) return;/,
  'canonical clients do not publish durable chat state through LiveKit');
assert.match(engineSource, /connectedChatServerId\(\)[\s\S]*return this\.chatStateServerId \|\| null/,
  'canonical subscription follows logical chat even before or after LiveKit transport');
assert.match(engineSource, /const previousWrite = this\.chatMutationWrites\.get\(key\)[\s\S]*previousWrite\.catch\(\(\) => \{\}\)\.then\(\(\) => persist/,
  'rapid edit and delete mutations for one message are serialized in user intent order');

assert.match(notifySource, /chatRealtimeTargetsServer\(chatFrame, logicalServerId\)/,
  'notify consumer filters against Engine logical scope rather than the LiveKit store marker');
assert.match(notifySource, /connectedServerId, lastReleaseSid/,
  'presence carries the one membership-scoped canonical chat subscription');
assert.match(notifySource, /chatProtocolPresence\(notifyChatProtocolV1\)[\s\S]*chatFrame\.t === 'chat-ready'[\s\S]*notifyChatProtocolV1 = true[\s\S]*sendPresenceFrame\(\)/,
  'presence advertises protocol 1 only after the exact ready frame on this connection');
assert.match(notifySource, /chatFrame\.t === 'chat-ready'[\s\S]*announceCanonicalCapability\(true\)[\s\S]*sendPresenceFrame\(\)/,
  'authenticated capability immediately subscribes and fences with server resync ACK');
assert.match(notifySource, /CHAT_CAPABILITY_NEGOTIATION_MS[\s\S]*current\.readyState !== WebSocket\.OPEN[\s\S]*setServerChatReady\(false\)[\s\S]*resynchronizeChat\(serverId\)/,
  'a live authenticated old-server connection can downgrade sticky canonical mode and replace its snapshot');
assert.match(notifySource, /d\.t === 'pong'[\s\S]*d\.t === 'voice-lease'[\s\S]*downgradeToLegacy\(\)/,
  'ordered authenticated non-chat evidence settles old-server capability before the conservative timeout');
assert.match(notifySource, /d\.t === 'chat-ready'[\s\S]*d\.t === 'chat-event'[\s\S]*announceCanonicalCapability\(false\)/,
  'even a future or malformed canonical marker settles modern mode fail-closed instead of timing out to legacy');
assert.match(notifySource, /claimChatMentionNotification\(notifyServerId, exactMessageId\)/,
  'raw notify participates in the same exact mention claim as canonical delivery');
assert.match(notifySource, /!currentEngine\?\.canonicalChatEnabled\(\)[\s\S]{0,120}currentEngine\?\.realtimeServes/,
  'LiveKit readiness cannot suppress a mention once participant durable chat is disabled');
assert.match(notifySource, /d\.reason === 'chat-mutation'[\s\S]*if \(canonicalV1Ready\) return;[\s\S]*resynchronizeChat\(d\.serverId\)/,
  'trailing rollout refresh is ignored after exact v1 readiness and fully replaces legacy/compat state');
assert.match(notifySource, /ev\.code === 4008 \|\| ev\.code === 4009/,
  'realtime-only capacity/policy closes use bounded recovery rather than account logout');
assert.doesNotMatch(notifySource, /(?:4008|4009)[\s\S]{0,500}setServerChatReady\(false\)/,
  'modern capacity signals never re-enable untrusted participant durable state');
assert.match(notifySource, /function requestMalformedChatRecovery[\s\S]*malformedChatResyncTimer[\s\S]*window\.setTimeout\(run, delay\)/,
  'malformed canonical recovery keeps a trailing coalesced resync instead of dropping a second bad revision');
assert.match(notifySource, /bounded && d\.v === 1[\s\S]*requestMalformedChatRecovery\(logicalServerId\)/,
  'a bounded malformed current v1 event requests authoritative recovery');
const disconnectedSnapshotScheduler = notifySource.match(
  /function scheduleDisconnectedChatSnapshots[\s\S]*?\n}\n\nfunction socketLooksDead/,
)?.[0] || '';
assert.match(disconnectedSnapshotScheduler, /connectedChatServerId\(\)[\s\S]*resynchronizeChat\(serverId\)[\s\S]*30_000/,
  'ordinary notify-WS loss keeps the logical chat fresh through bounded HTTP snapshots');
assert.doesNotMatch(disconnectedSnapshotScheduler, /canonicalChatEnabled\(\)/,
  'fresh-start WS failure polls before the first capability frame instead of waiting forever');
assert.match(notifySource, /new WebSocket\(url\)[\s\S]*catch \{[\s\S]*scheduleDisconnectedChatSnapshots\(true\)[\s\S]*scheduleReconnect\(\)/,
  'constructor failure before chat-ready starts immediate and recurring snapshot recovery');
assert.match(notifySource, /function sendConnectedChatPresence[\s\S]*ws\.readyState !== WebSocket\.OPEN[\s\S]*scheduleDisconnectedChatSnapshots\(true\)/,
  'entering a logical chat re-arms recovery even while the first socket is stuck connecting');
assert.match(notifySource, /current\.onclose[\s\S]*ws = null[\s\S]*scheduleDisconnectedChatSnapshots\(true\)[\s\S]*scheduleReconnect/,
  'a normal close starts fallback synchronization without downgrading durable authority');

assert.match(storeSource, /fetchChatSnapshot: \(serverId\) => api\.getMessages/,
  'full snapshots remain available while the app is on home and LiveKit is down');
assert.match(storeSource, /markSendResult\(localId, true, r\?\.id, r\?\.revision\)/,
  'POST result carries its revision into the optimistic race guard');
assert.match(storeSource, /editMessage: \(serverId, sid, text[\s\S]*api\.editMessage[\s\S]*deleteMessage: \(serverId, sid[\s\S]*api\.deleteMessage/,
  'edit/delete hooks return rejecting promises so Engine can recover failures');
assert.match(apiSource, /'X-Relay-Chat-Protocol': 'canonical-v1'/,
  'canonical mutations carry the exact strict rolling-deploy protocol marker');
assert.match(apiSource, /clearChat:[\s\S]*chatMutationOptions\(canonicalTransport\)[\s\S]*postMessage:[\s\S]*chatMutationOptions\(canonicalTransport\)[\s\S]*reactMessage:[\s\S]*chatMutationOptions\(canonicalTransport\)[\s\S]*editMessage:[\s\S]*chatMutationOptions\(canonicalTransport\)[\s\S]*deleteMessage:[\s\S]*chatMutationOptions\(canonicalTransport\)/,
  'all five chat mutation APIs mark only the per-action canonical transport');
assert.match(engineSource, /const canonicalTransport = this\.serverChatReady[\s\S]*pendingSend\.set\([^\n]*canonicalTransport[\s\S]*persistMessage\([^\n]*canonicalTransport\)/,
  'message retry retains the capability mode captured before its first publish');
assert.match(engineSource, /publishLegacyConfirmed\(serverId[\s\S]*this\.chatStateServerId !== serverId \|\| this\.viewServerId !== serverId[\s\S]*obj\.t === 'react'[\s\S]*obj\.t === 'clear'/,
  'the post-success legacy bridge is limited to four strict mutations in the exact matching room');
assert.match(engineSource, /if \(result\.changed\) \{[\s\S]*publishLegacyConfirmed\(serverId, \{ t: 'react'[\s\S]*else \{[\s\S]*resynchronizeChat\(serverId\)/,
  'a successful no-op reaction reconciles state without publishing a drifting legacy delta');
assert.match(serverViewSource, /const canonicalTransport = E\.canonicalChatEnabled\(\)[\s\S]*api\.clearChat\(active\.id, canonicalTransport\)[\s\S]*publishLegacyConfirmed[\s\S]*if \(canonicalTransport\)/,
  'clear keeps its action-start mode through HTTP completion and never re-reads a flipped capability');
assert.match(engineSource, /d\.t === 'clear'[\s\S]*clearMessages\([^\n]*false\)[\s\S]*resynchronizeChat\(this\.chatStateServerId\)/,
  'a legacy clear drops pre-clear optimistic rows and follows with a full authoritative replacement');
assert.match(engineSource, /const notifyRecovered = this\.chatMentionFenceEstablished[\s\S]*claimBoundedMessageId\(this\.chatSnapshotSeenSids, message\.sid\)[\s\S]*notifyRecovered && newlySeen[\s\S]*claimChatMentionNotification\(this\.chatStateServerId, message\.sid\)[\s\S]*this\.chatMentionFenceEstablished = true/,
  'initial snapshots seed seen ids without claiming delivery; recovery batches only newly seen mentions');
assert.match(engineSource, /if \(notifyMappedMentions\)[\s\S]*claimBoundedMessageId\(this\.chatSnapshotSeenSids, message\.sid\)[\s\S]*claimChatMentionNotification\(this\.chatStateServerId, message\.sid\)[\s\S]*deliverMentionBatch\(mentioned\)/,
  'fresh canonical-created rows claim before emitting their mention notification');
assert.match(engineSource, /canReconcileUnchangedChatSnapshot\([\s\S]*if \(unchangedAuthoritativeState\) \{[\s\S]*mergeRecent\(snapshot\.messages, true, false\)[\s\S]*\} else \{[\s\S]*replaceChatSnapshot/,
  'an unchanged polling snapshot reconciles exact latest rows without resetting pagination/generation');
assert.match(engineSource, /setServerChatReady\(ready = true\)[\s\S]*this\.canonicalSnapshotEstablished = false[\s\S]*canReconcileUnchangedChatSnapshot\([\s\S]*this\.canonicalSnapshotEstablished[\s\S]*replaceChatSnapshot[\s\S]*this\.canonicalSnapshotEstablished = true/,
  'the first canonical capability snapshot always replaces legacy participant state before fast polling');

console.log('canonical chat realtime: ok');

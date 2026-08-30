'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CHAT_PROTOCOL_HEADER,
  CHAT_PROTOCOL_VALUE,
  createLegacyChatRefreshBridge,
  isCanonicalChatRequest,
  legacyChatSocketEligible,
} = require('./legacyChatBridge');

function fakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();
  let peakTimers = 0;

  function setTimer(fn, delay) {
    const handle = { id: nextId++, at: current + Math.max(0, delay), fn, unref() {} };
    timers.set(handle.id, handle);
    peakTimers = Math.max(peakTimers, timers.size);
    return handle;
  }

  function clearTimer(handle) {
    if (handle) timers.delete(handle.id);
  }

  function advance(ms) {
    const target = current + ms;
    for (;;) {
      const due = [...timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers.delete(due.id);
      current = due.at;
      due.fn();
    }
    current = target;
  }

  return {
    now: () => current,
    setTimer,
    clearTimer,
    advance,
    get timerCount() { return timers.size; },
    get peakTimers() { return peakTimers; },
  };
}

test('canonical mutation marker is exact and per-request', () => {
  assert.equal(CHAT_PROTOCOL_HEADER, 'x-relay-chat-protocol');
  assert.equal(CHAT_PROTOCOL_VALUE, 'canonical-v1');
  assert.equal(isCanonicalChatRequest({ 'x-relay-chat-protocol': 'canonical-v1' }), true);
  assert.equal(isCanonicalChatRequest({ 'X-Relay-Chat-Protocol': 'canonical-v1' }), true);
  assert.equal(isCanonicalChatRequest({ 'x-relay-chat-protocol': ' canonical-v1' }), false);
  assert.equal(isCanonicalChatRequest({ 'x-relay-chat-protocol': 'canonical-v2' }), false);
  assert.equal(isCanonicalChatRequest({ 'x-relay-chat-protocol': ['canonical-v1'] }), false);
  assert.equal(isCanonicalChatRequest({}), false);
});

test('legacy refresh targets one visible old member socket only', () => {
  const legacyVisible = { readyState: 1, _chatProtocolV1: false, _activeServerId: 'srv-one' };
  const canonicalVisible = { readyState: 1, _chatProtocolV1: true, _activeServerId: 'srv-one' };
  const legacyOther = { readyState: 1, _chatProtocolV1: false, _activeServerId: 'srv-two' };
  const legacyBackground = { readyState: 1, _chatProtocolV1: false, _activeServerId: '' };
  const kickedVisible = { readyState: 1, _chatProtocolV1: false, _activeServerId: 'srv-one' };
  const sockets = new Map([
    ['member', [legacyVisible, canonicalVisible, legacyOther, legacyBackground]],
    ['kicked', [kickedVisible]],
  ]);
  const currentMembers = ['member'];
  const selected = currentMembers.flatMap((userId) => sockets.get(userId) || [])
    .filter((socket) => legacyChatSocketEligible(socket, 'srv-one'));
  assert.deepEqual(selected, [legacyVisible]);
  assert.equal(legacyChatSocketEligible(canonicalVisible, 'srv-one'), false);
  assert.equal(legacyChatSocketEligible(legacyOther, 'srv-one'), false);
  assert.equal(legacyChatSocketEligible(legacyBackground, 'srv-one'), false);
  assert.equal(selected.includes(kickedVisible), false);
});

test('refresh has a fixed deadline, coalesces per server and uses one bounded timer', () => {
  const clock = fakeClock();
  const sent = [];
  const bridge = createLegacyChatRefreshBridge({
    notifyServer: (serverId, frame) => sent.push({ serverId, frame }),
    delayMs: 1500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(bridge.enqueue('srv-one'), true);
  clock.advance(1000);
  assert.deepEqual(sent, []);
  assert.equal(bridge.enqueue('srv-one'), true);
  assert.equal(bridge.pending, 1);
  clock.advance(499);
  assert.deepEqual(sent, []);
  clock.advance(1);

  assert.deepEqual(sent, [{
    serverId: 'srv-one',
    frame: { t: 'chat-refresh', serverId: 'srv-one', reason: 'chat-mutation' },
  }]);
  assert.equal(bridge.pending, 0);
  assert.equal(clock.timerCount, 0);
  assert.equal(clock.peakTimers, 1);
});

test('continuous mutations cannot postpone the compatibility refresh indefinitely', () => {
  const clock = fakeClock();
  const sent = [];
  const bridge = createLegacyChatRefreshBridge({
    notifyServer: (serverId) => sent.push({ serverId, at: clock.now() }),
    delayMs: 100,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  bridge.enqueue('busy');
  for (let elapsed = 20; elapsed < 100; elapsed += 20) {
    clock.advance(20);
    bridge.enqueue('busy');
  }
  assert.deepEqual(sent, []);
  clock.advance(20);
  assert.deepEqual(sent, [{ serverId: 'busy', at: 100 }]);

  bridge.enqueue('busy');
  clock.advance(99);
  assert.equal(sent.length, 1);
  clock.advance(1);
  assert.deepEqual(sent[1], { serverId: 'busy', at: 200 });
});

test('pending servers, flush batches and notifier errors remain bounded', () => {
  const clock = fakeClock();
  const sent = [];
  const bridge = createLegacyChatRefreshBridge({
    notifyServer: (serverId) => {
      sent.push(serverId);
      if (serverId === 'a') throw new Error('offline');
    },
    delayMs: 10,
    maxPendingServers: 3,
    maxFlushBatch: 1,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(bridge.enqueue('a'), true);
  assert.equal(bridge.enqueue('b'), true);
  assert.equal(bridge.enqueue('c'), true);
  assert.equal(bridge.enqueue('d'), false);
  assert.equal(bridge.enqueue('a'), true);
  assert.equal(bridge.enqueue(' bad'), false);
  assert.equal(bridge.enqueue('x'.repeat(81)), false);
  assert.equal(bridge.pending, 3);

  clock.advance(10);
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.equal(bridge.pending, 0);
  assert.equal(clock.peakTimers, 1);
});

test('close clears the one timer and pending compatibility work', () => {
  const clock = fakeClock();
  const sent = [];
  const bridge = createLegacyChatRefreshBridge({
    notifyServer: (serverId) => sent.push(serverId),
    delayMs: 100,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  bridge.enqueue('one');
  bridge.close();
  clock.advance(1000);
  assert.deepEqual(sent, []);
  assert.equal(bridge.pending, 0);
  assert.equal(clock.timerCount, 0);
});

test('server wires the marker only to five successful canonical mutation paths', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  assert.match(source, /Access-Control-Allow-Headers[^\n]+X-Relay-Chat-Protocol/u);
  assert.equal((source.match(/scheduleLegacyChatRefresh\(req, sid\);/gu) || []).length, 5);
  assert.match(source, /if \(!persisted\.created\) return res\.json[\s\S]+scheduleLegacyChatRefresh\(req, sid\);/u);
  assert.match(source, /createLegacyChatRefreshBridge\([\s\S]+notifyServerMembers\(serverId, payload, \{ legacyChatOnly: true \}\)/u);
  assert.match(source, /d\.chatProtocol === 1[^\n]+ws\._chatProtocolV1 = true/u);
  assert.match(source, /activeChanged && activeServerId[\s\S]+!ws\._chatProtocolV1[\s\S]+reason: 'chat-mutation'/u);
  assert.match(dockerfile, /\blegacyChatBridge\.js\b/u);
});

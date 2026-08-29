'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { AccessToken } = require('livekit-server-sdk');
const {
  TrackSource,
  voiceMediaRoomName,
  voiceHubIdentity,
  voiceMediaIdentity,
  exactVoiceLease,
  initialVoiceMediaGrant,
  activeVoiceMediaPermission,
  activateVoiceMediaParticipant,
  removeVoiceMediaParticipant,
} = require('./voiceMedia');

test('media room and identity are exact and deterministic', () => {
  assert.equal(voiceMediaRoomName('s1', 'vc1'), 'voice:s1:vc1');
  assert.equal(voiceHubIdentity('alice', 'v2.nonce'), 'alice#v2.nonce');
  assert.equal(voiceMediaIdentity('alice', 'v2.nonce', 7), 'alice#v2.nonce~7');
  assert.notEqual(voiceMediaIdentity('alice', 'v2.nonce', 7), voiceMediaIdentity('alice', 'v2.nonce', 8));
});

test('media token starts without audio, data or metadata permissions', () => {
  assert.deepEqual(initialVoiceMediaGrant('voice:s1:vc1'), {
    roomJoin: true,
    room: 'voice:s1:vc1',
    canPublish: false,
    canSubscribe: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
});

test('serialized LiveKit token preserves the exact initial-deny grant', async () => {
  const token = new AccessToken('test-key', 'test-secret', {
    identity: voiceMediaIdentity('alice', 'v2.nonce', 7),
    ttl: '2m',
  });
  token.addGrant(initialVoiceMediaGrant('voice:s1:vc1'));
  const payload = jwt.decode(await token.toJwt());
  assert.deepEqual(payload.video, {
    roomJoin: true,
    room: 'voice:s1:vc1',
    canPublish: false,
    canSubscribe: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  assert.equal(payload.sub, 'alice#v2.nonce~7');
});

test('activation grants only microphone publication', () => {
  const permission = activeVoiceMediaPermission();
  assert.equal(permission.canPublish, true);
  assert.equal(permission.canSubscribe, true);
  assert.equal(permission.canPublishData, false);
  assert.equal(permission.canUpdateMetadata, false);
  assert.deepEqual(permission.canPublishSources, [TrackSource.MICROPHONE]);
  assert.equal(permission.canPublishSources.includes(TrackSource.SCREEN_SHARE), false);
});

test('lease matching includes session, server, channel and epoch', () => {
  const lease = { sessionId: 'sess', serverId: 'srv', channelId: 'vc', epoch: 7 };
  assert.equal(exactVoiceLease(lease, lease), true);
  for (const patch of [{ sessionId: 'old' }, { serverId: 'other' }, { channelId: 'other' }, { epoch: 8 }]) {
    assert.equal(exactVoiceLease(lease, { ...lease, ...patch }), false);
  }
  assert.equal(exactVoiceLease(null, lease), false);
});

test('activation verifies participant before applying atomic permissions', async () => {
  const calls = [];
  const service = {
    getParticipant: async (...args) => { calls.push(['get', ...args]); return { identity: args[1] }; },
    updateParticipant: async (...args) => { calls.push(['update', ...args]); return { identity: args[1] }; },
  };
  await activateVoiceMediaParticipant(service, 'voice:s:v', 'alice#sess~4');
  assert.equal(calls[0][0], 'get');
  assert.equal(calls[1][0], 'update');
  assert.deepEqual(calls[1][3].permission.canPublishSources, [TrackSource.MICROPHONE]);
});

test('removal revokes previously issued media tokens without touching account auth', async () => {
  const calls = [];
  const service = { removeParticipant: async (...args) => { calls.push(args); } };
  await removeVoiceMediaParticipant(service, 'voice:s:v', 'alice#sess~4', 1_700_000_000_123);
  assert.deepEqual(calls, [[
    'voice:s:v',
    'alice#sess~4',
    { revokeTokenTs: 1_700_000_000n },
  ]]);
});

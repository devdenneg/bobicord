'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { AccessToken } = require('livekit-server-sdk');
const {
  DEFAULT_TOKEN_MINT_LIMIT,
  DEFAULT_TOKEN_MINT_WINDOW_MS,
  DEFAULT_TOKEN_MINT_MAX_ACCOUNTS,
  hubTokenGrant,
  createVoiceTokenMintLimiter,
  noStoreVoiceTokenResponse,
} = require('./voiceTokenPolicy');

test('default limiter leaves headroom for rapid reconnect while bounding memory', () => {
  assert.equal(DEFAULT_TOKEN_MINT_LIMIT, 120);
  assert.equal(DEFAULT_TOKEN_MINT_WINDOW_MS, 60_000);
  assert.equal(DEFAULT_TOKEN_MINT_MAX_ACCOUNTS, 50_000);
});

test('serialized hub grant excludes microphone and keeps collaboration capabilities', async () => {
  const token = new AccessToken('test-key', 'test-secret', {
    identity: 'alice#v2.session',
    ttl: '10m',
  });
  token.addGrant(hubTokenGrant('srv:s1'));
  const payload = jwt.decode(await token.toJwt());

  assert.deepEqual(payload.video, {
    roomJoin: true,
    room: 'srv:s1',
    canPublish: true,
    canPublishSources: ['screen_share', 'screen_share_audio'],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  assert.equal(payload.video.canPublishSources.includes('microphone'), false);
  assert.equal(payload.video.canPublishSources.includes('camera'), false);
});

test('token mint limiter is isolated per account and resets after its bounded window', () => {
  const limiter = createVoiceTokenMintLimiter({ limit: 3, windowMs: 1_000, maxAccounts: 2 });
  assert.equal(limiter.consume('alice', 0).allowed, true);
  assert.equal(limiter.consume('alice', 1).allowed, true);
  assert.equal(limiter.consume('alice', 2).allowed, true);
  assert.deepEqual(limiter.consume('alice', 3), { allowed: false, retryAfterSeconds: 1 });
  assert.equal(limiter.consume('bob', 3).allowed, true);
  assert.equal(limiter.consume('alice', 1_000).allowed, true);
});

test('token response middleware marks success and errors as non-cacheable', () => {
  const headers = new Map();
  let continued = false;
  noStoreVoiceTokenResponse({}, {
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
  }, () => { continued = true; });
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.equal(continued, true);
});

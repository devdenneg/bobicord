'use strict';

const { TrackSource } = require('livekit-server-sdk');
const { createFixedWindowLimiter } = require('./seventvProxy');

const DEFAULT_TOKEN_MINT_LIMIT = 120;
const DEFAULT_TOKEN_MINT_WINDOW_MS = 60_000;
const DEFAULT_TOKEN_MINT_MAX_ACCOUNTS = 50_000;

function hubTokenGrant(room) {
  return {
    roomJoin: true,
    room,
    canPublish: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  };
}

function createVoiceTokenMintLimiter(options = {}) {
  const limit = options.limit ?? DEFAULT_TOKEN_MINT_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_TOKEN_MINT_WINDOW_MS;
  const maxAccounts = options.maxAccounts ?? DEFAULT_TOKEN_MINT_MAX_ACCOUNTS;
  const allow = createFixedWindowLimiter({ limit, windowMs, maxKeys: maxAccounts });
  return Object.freeze({
    consume(accountId, now = Date.now()) {
      const allowed = allow(accountId, now);
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(windowMs / 1000)),
      };
    },
  });
}

function noStoreVoiceTokenResponse(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = {
  TrackSource,
  DEFAULT_TOKEN_MINT_LIMIT,
  DEFAULT_TOKEN_MINT_WINDOW_MS,
  DEFAULT_TOKEN_MINT_MAX_ACCOUNTS,
  hubTokenGrant,
  createVoiceTokenMintLimiter,
  noStoreVoiceTokenResponse,
};

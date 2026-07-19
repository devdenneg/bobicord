const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const {
  VRELAY_UID,
  VRELAY_TOKEN_TYPE,
  VRELAY_TOKEN_AUDIENCE,
  VRELAY_TOKEN_TTL_SEC,
  isStrongVrelaySecret,
  isVrelayShapedToken,
  verifyVrelayToken,
} = require('./vrelayAuth');

// Deterministic unit-test fixtures only; they are not used by any runtime configuration.
const AUTH_SECRET = '8f9e0d1c2b3a495867768594a3b2c1d0';
const SESSION_SECRET = 'test-session-secret-not-runtime-value';

function strictToken(overrides = {}, algorithm = 'HS256') {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    id: VRELAY_UID,
    sub: VRELAY_UID,
    typ: VRELAY_TOKEN_TYPE,
    aud: VRELAY_TOKEN_AUDIENCE,
    iat: now,
    exp: now + VRELAY_TOKEN_TTL_SEC,
    ...overrides,
  }, AUTH_SECRET, { algorithm });
}

test('accepts only the dedicated strict service token', () => {
  const encoded = strictToken();
  assert.equal(isVrelayShapedToken(encoded), true);
  assert.deepEqual(verifyVrelayToken(encoded, {
    authSecret: AUTH_SECRET,
    sessionSecret: SESSION_SECRET,
  }), { id: VRELAY_UID });
});

test('rejects wrong algorithm, audience, identity, type and lifetime', () => {
  const options = { authSecret: AUTH_SECRET, sessionSecret: SESSION_SECRET };
  assert.throws(() => verifyVrelayToken(strictToken({}, 'HS384'), options));
  assert.throws(() => verifyVrelayToken(strictToken({ aud: 'other-service' }), options));
  assert.throws(() => verifyVrelayToken(strictToken({ sub: 'someone-else' }), options));
  assert.throws(() => verifyVrelayToken(strictToken({ id: 'someone-else' }), options));
  assert.throws(() => verifyVrelayToken(strictToken({ typ: 'user' }), options));
  assert.throws(() => verifyVrelayToken(strictToken({ role: 'admin' }), options));
  const now = Math.floor(Date.now() / 1000);
  assert.throws(() => verifyVrelayToken(strictToken({ iat: now, exp: now + 3600 }), options));
});

test('legacy SESSION_SECRET token is opt-in and auditable', () => {
  const oldToken = jwt.sign({ id: VRELAY_UID, exp: Math.floor(Date.now() / 1000) + 300 }, SESSION_SECRET, {
    algorithm: 'HS256',
    noTimestamp: true,
  });
  const options = { authSecret: AUTH_SECRET, sessionSecret: SESSION_SECRET };
  assert.throws(() => verifyVrelayToken(oldToken, options));
  let accepted = 0;
  assert.deepEqual(verifyVrelayToken(oldToken, {
    ...options,
    allowLegacy: true,
    onLegacy: () => { accepted += 1; },
  }), { id: VRELAY_UID });
  assert.equal(accepted, 1);
});

test('legacy bridge does not accept normal user-shaped or enriched tokens', () => {
  const now = Math.floor(Date.now() / 1000);
  const options = {
    authSecret: AUTH_SECRET,
    sessionSecret: SESSION_SECRET,
    allowLegacy: true,
  };
  const userToken = jwt.sign({ id: 'user-1', iat: now, exp: now + 300 }, SESSION_SECRET);
  const enriched = jwt.sign({ id: VRELAY_UID, iat: now, exp: now + 300 }, SESSION_SECRET);
  const extraClaim = jwt.sign({ id: VRELAY_UID, exp: now + 300, role: 'admin' }, SESSION_SECRET, { noTimestamp: true });
  assert.equal(isVrelayShapedToken(userToken), false);
  assert.throws(() => verifyVrelayToken(userToken, options));
  assert.throws(() => verifyVrelayToken(enriched, options));
  assert.throws(() => verifyVrelayToken(extraClaim, options));
});

test('rejects weak, placeholder, whitespace and shared secrets', () => {
  assert.equal(isStrongVrelaySecret('short', SESSION_SECRET), false);
  assert.equal(isStrongVrelaySecret('change_me_to_a_secret_long_enough', SESSION_SECRET), false);
  assert.equal(isStrongVrelaySecret('a'.repeat(64), SESSION_SECRET), false);
  assert.equal(isStrongVrelaySecret(` ${AUTH_SECRET}`, SESSION_SECRET), false);
  assert.equal(isStrongVrelaySecret(SESSION_SECRET, SESSION_SECRET), false);
  assert.equal(isStrongVrelaySecret(AUTH_SECRET, SESSION_SECRET), true);
});

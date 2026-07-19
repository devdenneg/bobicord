const jwt = require('jsonwebtoken');

const VRELAY_UID = 'virtual-relay';
const VRELAY_TOKEN_TYPE = 'vrelay';
const VRELAY_TOKEN_AUDIENCE = 'relay-tree';
const VRELAY_TOKEN_TTL_SEC = 5 * 60;

function isStrongVrelaySecret(secret, sessionSecret) {
  const value = String(secret || '');
  return Buffer.byteLength(value, 'utf8') >= 32
    && value.trim() === value
    && !/\s/.test(value)
    && !/(change[_-]?me|placeholder|example|dev-secret)/i.test(value)
    && !value.split('').every((char) => char === value[0])
    && value !== String(sessionSecret || '');
}

function isVrelayShapedToken(encoded) {
  const decoded = jwt.decode(String(encoded || ''));
  return !!(decoded && typeof decoded === 'object'
    && (decoded.typ === VRELAY_TOKEN_TYPE
      || decoded.sub === VRELAY_UID
      || decoded.id === VRELAY_UID));
}

function verifyStrictVrelayToken(encoded, authSecret) {
  const raw = jwt.verify(String(encoded || ''), authSecret, {
    algorithms: ['HS256'],
    audience: VRELAY_TOKEN_AUDIENCE,
    subject: VRELAY_UID,
    maxAge: `${VRELAY_TOKEN_TTL_SEC}s`,
    clockTolerance: 30,
  });
  const now = Math.floor(Date.now() / 1000);
  const allowedClaims = new Set(['id', 'sub', 'typ', 'aud', 'iat', 'exp']);
  const validTimes = Number.isInteger(raw.iat) && Number.isInteger(raw.exp)
    && raw.exp > raw.iat && raw.exp - raw.iat === VRELAY_TOKEN_TTL_SEC
    && raw.iat <= now + 30;
  if (raw.id !== VRELAY_UID || raw.sub !== VRELAY_UID || raw.typ !== VRELAY_TOKEN_TYPE
    || raw.aud !== VRELAY_TOKEN_AUDIENCE || !validTimes
    || !Object.keys(raw).every((claim) => allowedClaims.has(claim))) {
    throw new Error('invalid vrelay service claims');
  }
  return { id: VRELAY_UID };
}

function verifyLegacyVrelayToken(encoded, sessionSecret) {
  const legacy = jwt.verify(String(encoded || ''), sessionSecret, { algorithms: ['HS256'] });
  if (legacy.id !== VRELAY_UID || legacy.sub != null || legacy.typ != null || legacy.aud != null
    || legacy.iat != null || !Number.isInteger(legacy.exp)
    || Object.keys(legacy).some((claim) => claim !== 'id' && claim !== 'exp')) {
    throw new Error('invalid legacy vrelay claims');
  }
  return { id: VRELAY_UID };
}

function verifyVrelayToken(encoded, options) {
  const {
    authSecret,
    sessionSecret,
    allowLegacy = false,
    onLegacy = () => {},
  } = options || {};
  if (!isStrongVrelaySecret(authSecret, sessionSecret)) {
    throw new Error('vrelay authentication is not configured');
  }
  try {
    return verifyStrictVrelayToken(encoded, authSecret);
  } catch (serviceError) {
    if (!allowLegacy) throw serviceError;
    const result = verifyLegacyVrelayToken(encoded, sessionSecret);
    onLegacy();
    return result;
  }
}

module.exports = {
  VRELAY_UID,
  VRELAY_TOKEN_TYPE,
  VRELAY_TOKEN_AUDIENCE,
  VRELAY_TOKEN_TTL_SEC,
  isStrongVrelaySecret,
  isVrelayShapedToken,
  verifyVrelayToken,
};

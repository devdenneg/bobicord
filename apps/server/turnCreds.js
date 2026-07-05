// Evolution-TZ Э3 — временные TURN-креды (coturn REST API / use-auth-secret).
// username = "<unix-expiry>:<userId>", credential = base64(HMAC-SHA1(secret, username)).
// Короткий TTL (см. TURN_TTL_SEC) ограничивает, сколько времени украденный креденшл живой.
const crypto = require('crypto');

function turnCredentials(secret, userId, ttlSec) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

module.exports = { turnCredentials };

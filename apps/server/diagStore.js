const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIAG_LIMITS = Object.freeze({
  maxPayloadBytes: 1_500_000,
  maxLines: 20_000,
  maxLineBytes: 2_000,
  maxLinesBytes: 900_000,
  maxSamples: 2_000,
  maxSampleBytes: 8_192,
  maxSamplesBytes: 450_000,
});

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/** Обрезает строку по байтам, не оставляя в конце половину UTF-8 символа. */
function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (byteLength(text) <= maxBytes) return text;
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

/** Сохраняет непрерывный хвост лога и одновременно ограничивает реальный размер JSON. */
function sanitizeDiagLines(raw, limits = DEFAULT_DIAG_LIMITS) {
  if (!Array.isArray(raw)) return [];
  const source = raw.slice(-limits.maxLines);
  const reversed = [];
  let usedBytes = 2; // []
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const line = truncateUtf8(source[index], limits.maxLineBytes);
    const encoded = JSON.stringify(line);
    const nextBytes = byteLength(encoded) + (reversed.length ? 1 : 0);
    if (usedBytes + nextBytes > limits.maxLinesBytes) break;
    reversed.push(line);
    usedBytes += nextBytes;
  }
  return reversed.reverse();
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Семпл приходит от клиента. Принимаем только JSON-объект ограниченного размера:
 * это не даёт одному элементу поглотить весь файл и убирает неожиданные типы.
 */
function sanitizeDiagSamples(raw, limits = DEFAULT_DIAG_LIMITS) {
  if (!Array.isArray(raw)) return [];
  const source = raw.slice(-limits.maxSamples);
  const reversed = [];
  let usedBytes = 2; // []
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const sample = source[index];
    if (!isPlainRecord(sample)) continue;
    let encoded;
    try { encoded = JSON.stringify(sample); } catch { continue; }
    if (!encoded || byteLength(encoded) > limits.maxSampleBytes) continue;
    const nextBytes = byteLength(encoded) + (reversed.length ? 1 : 0);
    if (usedBytes + nextBytes > limits.maxSamplesBytes) break;
    try { reversed.push(JSON.parse(encoded)); } catch { /* JSON.stringify уже проверен */ }
    usedBytes += nextBytes;
  }
  return reversed.reverse();
}

/** Финальный жёсткий кап файла — защита на случай роста env/метаданных в будущем. */
function serializeDiagPayload(payload, maxBytes = DEFAULT_DIAG_LIMITS.maxPayloadBytes) {
  const bounded = {
    ...payload,
    lines: Array.isArray(payload.lines) ? payload.lines.slice() : [],
    samples: Array.isArray(payload.samples) ? payload.samples.slice() : [],
  };
  let encoded = JSON.stringify(bounded);
  while (byteLength(encoded) > maxBytes && (bounded.lines.length || bounded.samples.length)) {
    const collection = bounded.lines.length >= bounded.samples.length ? bounded.lines : bounded.samples;
    collection.splice(0, Math.max(1, Math.ceil(collection.length / 4)));
    bounded.truncated = true;
    encoded = JSON.stringify(bounded);
  }
  if (byteLength(encoded) > maxBytes) {
    bounded.lines = [];
    bounded.samples = [];
    bounded.env = null;
    bounded.truncated = true;
    encoded = JSON.stringify(bounded);
  }
  if (byteLength(encoded) > maxBytes) throw new Error('diagnostic payload exceeds storage limit');
  return encoded;
}

/**
 * Два окна на пользователя: короткое гасит burst, длинное ограничивает постоянную
 * запись на диск. Состояние намеренно процессное — диагностике нельзя синхронно писать
 * rate-limit в SQLite на каждый запрос.
 */
function createDiagRateLimiter({
  burstLimit = 8,
  burstWindowMs = 60_000,
  hourlyLimit = 24,
  hourlyWindowMs = 60 * 60_000,
  maxUsers = 10_000,
  now = () => Date.now(),
} = {}) {
  const users = new Map();

  function consume(userId) {
    const key = String(userId || '');
    const at = now();
    let state = users.get(key);
    if (!state) {
      state = { burstStarted: at, burstCount: 0, hourlyStarted: at, hourlyCount: 0, seenAt: at };
      users.set(key, state);
    }
    if (at - state.burstStarted >= burstWindowMs) {
      state.burstStarted = at;
      state.burstCount = 0;
    }
    if (at - state.hourlyStarted >= hourlyWindowMs) {
      state.hourlyStarted = at;
      state.hourlyCount = 0;
    }
    state.seenAt = at;

    let retryAfterMs = 0;
    if (state.burstCount >= burstLimit) retryAfterMs = Math.max(retryAfterMs, burstWindowMs - (at - state.burstStarted));
    if (state.hourlyCount >= hourlyLimit) retryAfterMs = Math.max(retryAfterMs, hourlyWindowMs - (at - state.hourlyStarted));
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs };

    state.burstCount += 1;
    state.hourlyCount += 1;
    if (users.size > maxUsers) {
      const oldest = [...users.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt).slice(0, users.size - maxUsers);
      for (const [oldKey] of oldest) if (oldKey !== key) users.delete(oldKey);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  return { consume };
}

function ownerKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 20);
}

function safeSegment(value, maxLength = 64) {
  return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, maxLength);
}

function ownerFromName(name) {
  const match = /^diag-([a-f0-9]{20})-/u.exec(name);
  return match ? match[1] : null;
}

/** Async-хранилище с сериализованными write+prune: параллельные POST не спорят за квоты. */
function createDiagStore({
  dir,
  maxFiles = 400,
  maxTotalBytes = 100 * 1024 * 1024,
  maxUserFiles = 32,
  maxUserBytes = 12 * 1024 * 1024,
  maxPayloadBytes = DEFAULT_DIAG_LIMITS.maxPayloadBytes,
  fsApi = fs.promises,
  randomToken = () => crypto.randomBytes(6).toString('hex'),
  logger = console,
} = {}) {
  if (!dir) throw new Error('diagnostic directory is required');
  let queue = Promise.resolve();

  function enqueue(task) {
    const current = queue.then(task, task);
    queue = current.catch(() => undefined);
    return current;
  }

  async function listFiles() {
    const entries = await fsApi.readdir(dir, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
    const files = [];
    // Не запускаем тысячи stat одновременно, если каталог достался от старой версии переполненным.
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = names.slice(offset, offset + 32);
      const stats = await Promise.all(batch.map(async (name) => {
        try {
          const stat = await fsApi.stat(path.join(dir, name));
          return { name, path: path.join(dir, name), size: stat.size, mtime: stat.mtimeMs, owner: ownerFromName(name) };
        } catch { return null; }
      }));
      for (const stat of stats) if (stat) files.push(stat);
    }
    return files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  }

  async function prune() {
    const files = await listFiles();
    const removed = new Set();
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);

    async function remove(file) {
      if (removed.has(file.path)) return;
      try { await fsApi.unlink(file.path); }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      removed.add(file.path);
      totalBytes -= file.size;
    }

    const byOwner = new Map();
    for (const file of files) {
      if (!file.owner) continue; // старый формат всё равно участвует в глобальной квоте
      const group = byOwner.get(file.owner) || [];
      group.push(file);
      byOwner.set(file.owner, group);
    }
    for (const group of byOwner.values()) {
      let bytes = group.reduce((sum, file) => sum + file.size, 0);
      let count = group.length;
      for (const file of group) {
        if (count <= maxUserFiles && bytes <= maxUserBytes) break;
        await remove(file);
        bytes -= file.size;
        count -= 1;
      }
    }

    let count = files.length - removed.size;
    for (const file of files) {
      if (count <= maxFiles && totalBytes <= maxTotalBytes) break;
      if (removed.has(file.path)) continue;
      await remove(file);
      count -= 1;
    }
  }

  function save({ userId, username, streamId, role, endedAt, payload }) {
    const encoded = serializeDiagPayload(payload, maxPayloadBytes);
    const key = ownerKey(userId);
    const timestamp = Number.isSafeInteger(endedAt) && endedAt > 0 ? endedAt : Date.now();
    const name = `diag-${key}-${timestamp}-${safeSegment(streamId)}-${safeSegment(role, 16)}-${safeSegment(username)}-${randomToken()}.json`;
    return enqueue(async () => {
      await fsApi.mkdir(dir, { recursive: true });
      await fsApi.writeFile(path.join(dir, name), encoded, { flag: 'wx' });
      try { await prune(); }
      catch (error) { logger.warn?.('[diag] async prune failed:', error && error.message); }
      return { name, bytes: byteLength(encoded) };
    });
  }

  return { save, prune };
}

module.exports = {
  DEFAULT_DIAG_LIMITS,
  createDiagRateLimiter,
  createDiagStore,
  sanitizeDiagLines,
  sanitizeDiagSamples,
  serializeDiagPayload,
  truncateUtf8,
};

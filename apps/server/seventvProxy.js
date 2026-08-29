'use strict';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CDN_HOST = 'cdn.7tv.app';
const CDN_PATH_RE = /^\/emote\/[a-zA-Z0-9]{1,40}\/[12]x\.webp$/;

class ResponseTooLargeError extends Error {
  constructor(limit) {
    super(`upstream response exceeds ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

function isAllowedCdnUrl(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value)); }
  catch { return false; }
  return url.protocol === 'https:' && url.hostname === CDN_HOST && url.port === ''
    && !url.username && !url.password && CDN_PATH_RE.test(url.pathname) && !url.search && !url.hash;
}

async function fetchSeventvCdn(url, options = {}, fetchImpl = globalThis.fetch, maxRedirects = 3) {
  let current = url instanceof URL ? url : new URL(String(url));
  if (!isAllowedCdnUrl(current)) throw new Error('disallowed 7TV CDN URL');
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchImpl(current, { ...options, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects === maxRedirects) {
      try { await response.body?.cancel(); } catch { /**/ }
      throw new Error('too many 7TV redirects');
    }
    const location = response.headers.get('location');
    let next;
    try { next = location ? new URL(location, current) : null; } catch { next = null; }
    try { await response.body?.cancel(); } catch { /**/ }
    if (!next || !isAllowedCdnUrl(next)) throw new Error('disallowed 7TV redirect');
    current = next;
  }
  throw new Error('unreachable redirect state');
}

async function readResponseLimited(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid response limit');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /**/ }
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /**/ }
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /**/ }
  }
  return Buffer.concat(chunks, total);
}

function normalizeEmote(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!/^[a-zA-Z0-9]{1,40}$/.test(id) || !name || name.length > 100) return null;
  return { id, name };
}

function normalizeEmotes(items, limit) {
  if (!Array.isArray(items)) return [];
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const emote = normalizeEmote(item);
    if (!emote || seen.has(emote.id)) continue;
    seen.add(emote.id);
    result.push(emote);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeGlobalPayload(payload, limit = 5000) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const emotes = normalizeEmotes(payload.emotes, limit);
  return emotes.length ? { emotes } : null;
}

function normalizeSearchPayload(payload, limit = 100) {
  const items = payload?.data?.emotes?.items;
  return Array.isArray(items) ? normalizeEmotes(items, limit) : null;
}

class BoundedTtlCache {
  constructor(maxEntries, ttlMs) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs < 1) throw new TypeError('invalid cache bounds');
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }
  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, ttlMs = this.ttlMs, now = Date.now()) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + Math.max(1, ttlMs) });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  get size() { return this.entries.size; }
}

function createFixedWindowLimiter({ limit, windowMs, maxKeys }) {
  if (![limit, windowMs, maxKeys].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError('invalid rate limit');
  const entries = new Map();
  return (key, now = Date.now()) => {
    const normalized = String(key || 'unknown').slice(0, 200);
    let entry = entries.get(normalized);
    if (!entry || now - entry.startedAt >= windowMs) {
      if (!entry && entries.size >= maxKeys) entries.delete(entries.keys().next().value);
      entry = { startedAt: now, count: 0 };
      entries.set(normalized, entry);
    }
    entry.count++;
    return entry.count <= limit;
  };
}

module.exports = {
  BoundedTtlCache,
  ResponseTooLargeError,
  createFixedWindowLimiter,
  fetchSeventvCdn,
  isAllowedCdnUrl,
  normalizeGlobalPayload,
  normalizeSearchPayload,
  readResponseLimited,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BoundedTtlCache,
  ResponseTooLargeError,
  createFixedWindowLimiter,
  fetchSeventvCdn,
  isAllowedCdnUrl,
  normalizeGlobalPayload,
  normalizeSearchPayload,
  readResponseLimited,
} = require('./seventvProxy');

test('CDN URL and every redirect stay on the fixed HTTPS emote path', async () => {
  assert.equal(isAllowedCdnUrl('https://cdn.7tv.app/emote/01ABC/2x.webp'), true);
  assert.equal(isAllowedCdnUrl('https://127.0.0.1/emote/01ABC/2x.webp'), false);
  assert.equal(isAllowedCdnUrl('https://cdn.7tv.app@127.0.0.1/emote/01ABC/2x.webp'), false);

  const seen = [];
  const ok = await fetchSeventvCdn('https://cdn.7tv.app/emote/legacy/1x.webp', {}, async (url, options) => {
    seen.push([String(url), options.redirect]);
    if (seen.length === 1) return new Response(null, { status: 308, headers: { location: '/emote/NEWID/1x.webp' } });
    return new Response('ok', { status: 200 });
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, [
    ['https://cdn.7tv.app/emote/legacy/1x.webp', 'manual'],
    ['https://cdn.7tv.app/emote/NEWID/1x.webp', 'manual'],
  ]);

  await assert.rejects(
    fetchSeventvCdn('https://cdn.7tv.app/emote/legacy/1x.webp', {}, async () => new Response(null, {
      status: 302, headers: { location: 'http://127.0.0.1/internal' },
    })),
    /disallowed 7TV redirect/,
  );
});

test('response body is cancelled as soon as the byte cap is crossed', async () => {
  const response = new Response(new Uint8Array(9));
  await assert.rejects(readResponseLimited(response, 8), ResponseTooLargeError);
  await assert.rejects(
    readResponseLimited(new Response('x', { headers: { 'content-length': '999' } }), 8),
    ResponseTooLargeError,
  );
  assert.deepEqual(await readResponseLimited(new Response('1234'), 4), Buffer.from('1234'));
});

test('upstream JSON is normalized, deduplicated and bounded', () => {
  assert.deepEqual(normalizeGlobalPayload({ emotes: [
    { id: 'A1', name: 'One', extra: 'drop' },
    { id: 'A1', name: 'Duplicate' },
    { id: '../bad', name: 'Bad' },
    { id: 'B2', name: 'Two' },
  ]}, 2), { emotes: [{ id: 'A1', name: 'One' }, { id: 'B2', name: 'Two' }] });
  assert.equal(normalizeGlobalPayload({ emotes: [] }), null);
  assert.deepEqual(normalizeSearchPayload({ data: { emotes: { items: [{ id: 'C3', name: 'Three' }] } } }), [{ id: 'C3', name: 'Three' }]);
  assert.equal(normalizeSearchPayload({ data: { emotes: {} } }), null);
});

test('TTL cache and limiter keep attacker-controlled key cardinality bounded', () => {
  const cache = new BoundedTtlCache(2, 100);
  cache.set('a', 1, 100, 0); cache.set('b', 2, 100, 0); cache.set('c', 3, 100, 0);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a', 1), undefined);
  assert.equal(cache.get('b', 101), undefined);

  const allowed = createFixedWindowLimiter({ limit: 2, windowMs: 100, maxKeys: 2 });
  assert.equal(allowed('ip', 0), true);
  assert.equal(allowed('ip', 1), true);
  assert.equal(allowed('ip', 2), false);
  assert.equal(allowed('ip', 100), true);
  allowed('a', 100); allowed('b', 100); allowed('c', 100);
});

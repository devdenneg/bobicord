const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const {
  DEFAULT_DIAG_LIMITS,
  createDiagRateLimiter,
  createDiagStore,
  sanitizeDiagLines,
  sanitizeDiagSamples,
  serializeDiagPayload,
  truncateUtf8,
} = require('./diagStore');

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test('rate limit изолирован по пользователям и ограничивает burst и часовой объём', () => {
  let now = 1_000;
  const limiter = createDiagRateLimiter({
    burstLimit: 2,
    burstWindowMs: 1_000,
    hourlyLimit: 3,
    hourlyWindowMs: 5_000,
    now: () => now,
  });

  assert.equal(limiter.consume('alice').allowed, true);
  assert.equal(limiter.consume('alice').allowed, true);
  assert.deepEqual(limiter.consume('alice'), { allowed: false, retryAfterMs: 1_000 });
  assert.equal(limiter.consume('bob').allowed, true, 'лимит одного пользователя не влияет на другого');

  now += 1_000;
  assert.equal(limiter.consume('alice').allowed, true, 'короткое окно сбросилось');
  assert.deepEqual(limiter.consume('alice'), { allowed: false, retryAfterMs: 4_000 });

  now += 4_000;
  assert.equal(limiter.consume('alice').allowed, true, 'длинное окно сбросилось');
});

test('строки и samples ограничиваются по UTF-8, числу и сериализованным байтам', () => {
  assert.equal(Buffer.byteLength(truncateUtf8('😀😀😀', 8)), 8);
  assert.equal(truncateUtf8('😀😀😀', 7), '😀');

  const lineLimits = {
    ...DEFAULT_DIAG_LIMITS,
    maxLines: 3,
    maxLineBytes: 8,
    maxLinesBytes: 12,
  };
  assert.deepEqual(sanitizeDiagLines(['старое', 'aaaa', 'bb'], lineLimits), ['bb']);

  const sampleLimits = {
    ...DEFAULT_DIAG_LIMITS,
    maxSamples: 4,
    maxSampleBytes: 40,
    maxSamplesBytes: 70,
  };
  const samples = sanitizeDiagSamples([
    { t: 1 },
    ['не объект'],
    { huge: 'x'.repeat(100) },
    { t: 2, fps: 60 },
  ], sampleLimits);
  assert.deepEqual(samples, [{ t: 1 }, { t: 2, fps: 60 }]);
  assert.ok(Buffer.byteLength(JSON.stringify(samples)) <= sampleLimits.maxSamplesBytes);
});

test('финальный diagnostic JSON никогда не превышает жёсткий cap', () => {
  const encoded = serializeDiagPayload({
    streamId: 'stream',
    env: { platform: 'test' },
    lines: Array.from({ length: 40 }, (_, index) => `${index}:${'x'.repeat(30)}`),
    samples: Array.from({ length: 20 }, (_, t) => ({ t, value: 'y'.repeat(20) })),
  }, 400);
  assert.ok(Buffer.byteLength(encoded) <= 400);
  const payload = JSON.parse(encoded);
  assert.equal(payload.truncated, true);
  assert.ok(payload.lines.length < 40 || payload.samples.length < 20);
});

test('async store сериализует запись и соблюдает per-user и глобальную квоты', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-diag-test-'));
  tempDirs.push(dir);
  let nonce = 0;
  const store = createDiagStore({
    dir,
    maxFiles: 3,
    maxTotalBytes: 10_000,
    maxUserFiles: 2,
    maxUserBytes: 10_000,
    maxPayloadBytes: 1_000,
    randomToken: () => String(++nonce).padStart(12, '0'),
    logger: { warn() {} },
  });
  const save = (userId, endedAt) => store.save({
    userId,
    username: userId,
    streamId: 'stream',
    role: 'viewer',
    endedAt,
    payload: { userId, endedAt, lines: ['line'], samples: [{ t: endedAt }] },
  });

  await Promise.all([save('alice', 1), save('alice', 2), save('alice', 3)]);
  await save('bob', 4);

  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 3);
  const payloads = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))));
  assert.equal(payloads.filter((payload) => payload.userId === 'alice').length, 2);
  assert.equal(payloads.filter((payload) => payload.userId === 'bob').length, 1);
  assert.ok(payloads.some((payload) => payload.endedAt === 3), 'новейший файл пользователя сохранён');
});

test('per-user byte quota удаляет старейшие крупные отчёты', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-diag-bytes-test-'));
  tempDirs.push(dir);
  let nonce = 0;
  const store = createDiagStore({
    dir,
    maxFiles: 20,
    maxTotalBytes: 20_000,
    maxUserFiles: 20,
    maxUserBytes: 360,
    maxPayloadBytes: 1_000,
    randomToken: () => String(++nonce).padStart(12, '0'),
    logger: { warn() {} },
  });
  for (let endedAt = 1; endedAt <= 3; endedAt += 1) {
    await store.save({
      userId: 'alice', username: 'alice', streamId: 'stream', role: 'viewer', endedAt,
      payload: { userId: 'alice', endedAt, lines: ['x'.repeat(120)], samples: [] },
    });
  }

  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
  const stats = await Promise.all(names.map((name) => fs.stat(path.join(dir, name))));
  assert.ok(stats.reduce((sum, stat) => sum + stat.size, 0) <= 360);
  const payloads = await Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))));
  assert.ok(payloads.some((payload) => payload.endedAt === 3), 'квота оставляет свежий отчёт');
});

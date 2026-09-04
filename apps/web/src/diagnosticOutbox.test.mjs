import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
let source = readFileSync(join(here, 'diagnosticOutbox.ts'), 'utf8');
source = source
  .replace("import { isApiError } from './api';", 'const isApiError = (error) => !!error && error.api === true;')
  .replace(/import type \{ VoiceDiagnosticReport \} from '\.\/types';\n/u, '')
  .replace("import { VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES } from './voiceDiagnostics';", 'const VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES = 24 * 1024;');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DiagnosticReportOutbox } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const report = (id, incident = 'stream_watch_failed') => ({
  schemaVersion: 1,
  clientReportId: id,
  incident,
  client: { kind: 'native', platform: 'macos', installMode: 'native', networkType: 'wifi' },
  durationMs: 20_000,
  events: [{ atMs: 0, kind: 'stream_watch_started', stage: 'watch_intent', outcome: 'started' }],
});

class MemoryStorage {
  values = new Map();
  dropIndexWrites = false;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.dropIndexWrites && key.includes('.diagnostic.index.')) return;
    this.values.set(key, value);
  }
  removeItem(key) { this.values.delete(key); }
}

const storedReports = (storage) => [...storage.values.values()].flatMap((raw) => {
  try {
    const value = JSON.parse(raw);
    return value && !Array.isArray(value) && value.report ? [value] : [];
  } catch {
    return [];
  }
});

const settle = async () => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
};

// Access to the default localStorage property itself may be forbidden.
{
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }); },
  });
  try {
    assert.doesNotThrow(() => {
      const outbox = new DiagnosticReportOutbox('ilya', async () => {}, { online: () => false });
      outbox.start();
      assert.equal(outbox.enqueue(report('aaaaaaaaaaaaaaaaaaaaaaaa')), true);
      outbox.dispose();
    }, 'a blocked localStorage getter cannot prevent Engine construction');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

{
  const storage = new MemoryStorage();
  const sent = [];
  const first = new DiagnosticReportOutbox('ilya', async (value) => { sent.push(value.clientReportId); }, {
    storage, online: () => true, visible: () => true,
  });
  first.start();
  assert.equal(first.enqueue(report('111111111111111111111111')), true);
  await settle();
  assert.deepEqual(sent, ['111111111111111111111111']);
  assert.equal(storedReports(storage).length, 0, 'acknowledged report is removed');
  first.dispose();
}

// Logout can dispose the queue between selecting a report and starting the deferred upload.
{
  const storage = new MemoryStorage();
  const sent = [];
  const outbox = new DiagnosticReportOutbox('before-logout', async (value) => { sent.push(value.clientReportId); }, {
    storage, online: () => true, visible: () => true,
  });
  outbox.start();
  outbox.enqueue(report('abababababababababababab'));
  outbox.dispose();
  await settle();
  assert.deepEqual(sent, [], 'a selected upload must not start after disposal under a replacement account token');
  assert.equal(storedReports(storage).length, 1, 'a skipped upload is not mistaken for a server acknowledgment');
  outbox.start();
  await settle();
  assert.deepEqual(sent, ['abababababababababababab']);
  outbox.dispose();
}

// Independent entry keys retain simultaneous reports even if every shared-index write is lost.
{
  const storage = new MemoryStorage();
  storage.dropIndexWrites = true;
  const first = new DiagnosticReportOutbox('ilya', async () => {}, {
    storage, online: () => false, visible: () => true,
  });
  const second = new DiagnosticReportOutbox('ilya', async () => {}, {
    storage, online: () => false, visible: () => true,
  });
  first.start();
  second.start();
  first.enqueue(report('121212121212121212121212'));
  second.enqueue(report('343434343434343434343434'));
  assert.equal(storedReports(storage).length, 2, 'two tabs cannot replace each other\'s reports');
  assert.ok([...storage.values.keys()].every((key) => !key.includes('ilya')
    && !key.includes('121212121212121212121212') && !key.includes('343434343434343434343434')),
  'storage key names do not expose owner/report identifiers');
  first.dispose();
  second.dispose();

  storage.dropIndexWrites = false;
  const sent = [];
  const restarted = new DiagnosticReportOutbox('ilya', async (value) => { sent.push(value.clientReportId); }, {
    storage, online: () => true, visible: () => true,
  });
  restarted.start();
  await settle();
  assert.deepEqual(new Set(sent), new Set(['121212121212121212121212', '343434343434343434343434']),
    'enumeration recovers both reports without a shared index');
  restarted.dispose();
}

// dispose(false) is a pause: the same instance can be started and drain its durable queue again.
{
  const storage = new MemoryStorage();
  let online = false;
  const sent = [];
  const outbox = new DiagnosticReportOutbox('ilya', async (value) => { sent.push(value.clientReportId); }, {
    storage, online: () => online, visible: () => true,
  });
  outbox.start();
  outbox.enqueue(report('222222222222222222222222'));
  outbox.dispose(false);
  online = true;
  outbox.start();
  await settle();
  assert.deepEqual(sent, ['222222222222222222222222']);
  outbox.dispose();
}

{
  const storage = new MemoryStorage();
  let now = 10_000;
  let timerCallback = null;
  let calls = 0;
  const outbox = new DiagnosticReportOutbox('ilya', async () => {
    calls += 1;
    if (calls === 1) throw { api: true, status: 429, code: 'HTTP_ERROR', retryAfter: 3_600 };
  }, {
    storage, now: () => now, online: () => true, visible: () => true,
    setTimer: (callback) => { timerCallback = callback; return 1; },
    clearTimer: () => { timerCallback = null; },
  });
  outbox.start();
  outbox.enqueue(report('333333333333333333333333'));
  await settle();
  assert.equal(calls, 1);
  assert.ok(timerCallback, 'a rejected report remains scheduled');
  now += 3_600_000;
  const retry = timerCallback;
  timerCallback = null;
  retry();
  await settle();
  assert.equal(calls, 2, 'the full hourly Retry-After is honoured');
  assert.equal(storedReports(storage).length, 0);
  outbox.dispose();
}

for (const status of [404, 405]) {
  const storage = new MemoryStorage();
  let now = 20_000;
  let timerCallback = null;
  let calls = 0;
  const outbox = new DiagnosticReportOutbox('ilya', async () => {
    calls += 1;
    if (calls === 1) throw { api: true, status, code: 'HTTP_ERROR' };
  }, {
    storage, now: () => now, online: () => true, visible: () => true,
    setTimer: (callback) => { timerCallback = callback; return status; },
    clearTimer: () => { timerCallback = null; },
  });
  outbox.start();
  outbox.enqueue(report(`${status}`.padStart(24, '0')));
  await settle();
  assert.equal(calls, 1);
  assert.equal(storedReports(storage).length, 1, `${status} must survive a staggered server rollout`);
  assert.ok(timerCallback);
  now += 10_000;
  const retry = timerCallback;
  timerCallback = null;
  retry();
  await settle();
  assert.equal(calls, 2);
  assert.equal(storedReports(storage).length, 0);
  outbox.dispose();
}

for (const status of [400, 403]) {
  const storage = new MemoryStorage();
  let calls = 0;
  const outbox = new DiagnosticReportOutbox('ilya', async () => {
    calls += 1;
    throw { api: true, status, code: 'HTTP_ERROR' };
  }, { storage, online: () => true, visible: () => true });
  outbox.start();
  outbox.enqueue(report(`${status + 1_000}`.padStart(24, '0')));
  await settle();
  assert.equal(calls, 1);
  assert.equal(storedReports(storage).length, 0, `${status} is permanent and must be dropped`);
  outbox.dispose();
}

{
  const storage = new MemoryStorage();
  let online = false;
  const first = new DiagnosticReportOutbox('ilya', async () => {}, { storage, online: () => online });
  first.start();
  first.enqueue(report('444444444444444444444444'));
  first.dispose(true);
  online = true;
  let sent = false;
  const replacement = new DiagnosticReportOutbox('ilya', async () => { sent = true; }, {
    storage, online: () => online,
  });
  replacement.start();
  await settle();
  assert.equal(sent, false, 'explicit logout removes reports owned by that account');
  replacement.dispose();
}

// A request which rejects after explicit logout cannot resurrect that account's purged report.
{
  const storage = new MemoryStorage();
  let rejectUpload;
  const upload = new Promise((_, reject) => { rejectUpload = reject; });
  const outbox = new DiagnosticReportOutbox('ilya', () => upload, {
    storage, online: () => true, visible: () => true,
  });
  outbox.start();
  outbox.enqueue(report('454545454545454545454545'));
  await Promise.resolve();
  outbox.dispose(true);
  rejectUpload({ api: true, status: 500, code: 'HTTP_ERROR' });
  await settle();
  assert.equal(storedReports(storage).length, 0,
    'a late retryable failure after logout does not recreate a purged report');
  assert.equal(outbox.enqueue(report('464646464646464646464646')), false,
    'a discarded account owner cannot enqueue new reports');
}

// Failure > recovered > success for both delivery and bounded eviction.
{
  const storage = new MemoryStorage();
  let online = false;
  let now = 30_000;
  const sent = [];
  const outbox = new DiagnosticReportOutbox('ilya', async (value) => { sent.push(value.incident); }, {
    storage, now: () => now, online: () => online, visible: () => true,
  });
  outbox.start();
  outbox.enqueue(report('010101010101010101010101', 'stream_watch_succeeded'));
  now += 1;
  outbox.enqueue(report('040404040404040404040404', 'join_succeeded'));
  now += 1;
  outbox.enqueue(report('050505050505050505050505', 'session_ended'));
  now += 1;
  outbox.enqueue(report('020202020202020202020202', 'stream_watch_recovered'));
  now += 1;
  outbox.enqueue(report('030303030303030303030303', 'stream_watch_failed'));
  online = true;
  outbox.flush();
  await settle();
  assert.deepEqual(sent, ['stream_watch_failed', 'stream_watch_recovered', 'stream_watch_succeeded', 'join_succeeded', 'session_ended']);
  outbox.dispose();
}

{
  const storage = new MemoryStorage();
  let now = 40_000;
  const outbox = new DiagnosticReportOutbox('ilya', async () => {}, {
    storage, now: () => now, online: () => false, visible: () => true,
  });
  outbox.start();
  for (let index = 1; index <= 24; index += 1) {
    outbox.enqueue(report(index.toString(16).padStart(24, '0'), index % 2 ? 'join_succeeded' : 'stream_watch_succeeded'));
    now += 1;
  }
  const recoveredId = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const failureId = 'ffffffffffffffffffffffff';
  outbox.enqueue(report(recoveredId, 'stream_watch_recovered'));
  now += 1;
  outbox.enqueue(report(failureId, 'stream_watch_failed'));
  const stored = storedReports(storage);
  assert.equal(stored.length, 24, 'the offline outbox remains bounded');
  assert.ok(stored.some((entry) => entry.report.clientReportId === recoveredId),
    'recovery evidence outranks success controls');
  assert.ok(stored.some((entry) => entry.report.clientReportId === failureId),
    'failure evidence has the highest retention priority');
  outbox.dispose();
}

console.log('diagnostic outbox: ok');

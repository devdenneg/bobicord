import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const moduleUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const recorderUrl = moduleUrl(readFileSync(join(here, 'voiceDiagnostics.ts'), 'utf8'));
const outboxUrl = moduleUrl(readFileSync(join(here, 'diagnosticOutbox.ts'), 'utf8')
  .replace("import { isApiError } from './api';", 'const isApiError = (error) => error?.name === "ApiError";')
  .replace("from './voiceDiagnostics'", `from '${recorderUrl}'`));
const authUrl = moduleUrl(readFileSync(join(here, 'authDiagnostics.ts'), 'utf8')
  .replaceAll("from './voiceDiagnostics'", `from '${recorderUrl}'`)
  .replaceAll("from './diagnosticOutbox'", `from '${outboxUrl}'`));
const { AuthDiagnostics } = await import(authUrl);
const { DiagnosticReportOutbox } = await import(outboxUrl);

const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
class Storage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
const networkFailure = () => Object.assign(new Error('PRIVATE_RESPONSE'), {
  name: 'ApiError', code: 'NETWORK_ERROR', status: 0,
  username: 'PRIVATE_USERNAME', password: 'test_PRIVATE_PASSWORD', token: 'PRIVATE_TOKEN',
  headers: { Authorization: 'PRIVATE_AUTHORIZATION' }, body: 'PRIVATE_BODY', url: 'PRIVATE_URL',
});

function harness() {
  let now = 0, online = true, sequence = 0;
  const storage = new Storage(), timers = new Map(), listeners = new Set(), sent = [];
  const setTimer = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const outbox = { storage, now: () => now, online: () => online, visible: () => true, setTimer, clearTimer,
    addLifecycleListeners: (flush) => { listeners.add(flush); return () => listeners.delete(flush); } };
  const manager = new AuthDiagnostics({ now: () => now, setTimer, clearTimer, outbox,
    createReportId: () => (++sequence).toString(16).padStart(24, '0'),
    client: { kind: 'web', platform: 'ios', installMode: 'browser', networkType: 'wifi' } });
  return { manager, storage, timers, listeners, sent, outbox,
    upload: async (report) => { sent.push(report); },
    online: (value) => { online = value; },
    advance: (ms) => { now += ms; },
    flush: () => { for (const flush of listeners) flush(); },
    fireTimers: () => {
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

// No constructor/storage/API activity; same-subject evidence survives offline login and cancellation.
{
  const h = harness();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  h.online(false);
  const first = h.manager.startAttempt('  PRIVATE_USERNAME  ');
  const fail = first.request('auth_login');
  h.advance(1_200);
  fail(networkFailure());
  first.cancel();
  assert.equal(h.storage.length, 0, 'no pre-auth report or login subject is persisted');
  const second = h.manager.startAttempt('private_username');
  second.request('auth_login')(undefined, 200);
  assert.equal(second.accept({ id: 'owner-a', username: 'PRIVATE_USERNAME' }, h.upload), true);
  assert.equal(h.manager.accepted, true);
  const persisted = [...h.storage.values.values()].join('');
  assert.doesNotMatch(persisted, /PRIVATE_|private_username/);
  assert.match(persisted, /auth_recovered/);
  assert.equal(h.sent.length, 0, 'outbox respects offline status');
  h.online(true); h.flush(); await settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].incident, 'auth_recovered');
  assert.equal(h.sent[0].events.length, 4);
  assert.equal(h.sent[0].events[1].requestElapsedMs, 1_200);
  assert.equal(h.sent[0].events[1].httpStatus, 0);
  assert.equal(h.sent[0].events[1].code, 'network');
  h.manager.request('auth_profile')(undefined, 200);
  h.manager.accept({ id: 'owner-a', username: 'PRIVATE_USERNAME' }, h.upload);
  await settle();
  assert.equal(h.sent.length, 1, 'healthy profile polls and repeated accept do not report');
  h.manager.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
}

// Neither a different typed subject nor a different server-confirmed account inherits a failure.
for (const changedInput of [true, false]) {
  const h = harness();
  h.manager.startAttempt('first').request('auth_login')(networkFailure());
  const next = h.manager.startAttempt(changedInput ? 'second' : 'first');
  next.request('auth_login')(undefined, 200);
  next.accept({ id: 'owner-b', username: 'second' }, h.upload);
  await settle();
  assert.equal(h.sent.length, 0);
  next.request('auth_profile')(networkFailure());
  await settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].events.some((event) => event.code === 'network' && event.stage === 'auth_login'), false);
  h.manager.dispose();
}

// Late, duplicated, cancelled and superseded completions cannot mutate the active trace.
{
  const h = harness();
  const first = h.manager.startAttempt('owner');
  const late = first.request('auth_login');
  const second = h.manager.startAttempt('owner');
  late(networkFailure());
  assert.equal(first.accept({ id: 'owner', username: 'owner' }, h.upload), false);
  const finish = second.request('auth_login');
  finish(undefined, 200); finish(networkFailure());
  second.accept({ id: 'owner', username: 'owner' }, h.upload);
  await settle();
  assert.equal(h.sent.length, 0);
  second.request('auth_profile')(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await settle();
  assert.equal(h.sent.length, 0, 'explicit cancellation is not an authentication failure');
  const afterCancel = second.request('auth_profile');
  second.cancel(); afterCancel(networkFailure());
  assert.equal(h.manager.active, false);
  h.manager.request('auth_profile')(networkFailure());
  await settle();
  assert.equal(h.sent.length, 0);
  h.manager.dispose();
}

// Disposal or account replacement between enqueue and its microtask never uploads with new credentials.
for (const replace of [false, true]) {
  const h = harness();
  h.manager.startAttempt('a').request('auth_login')(networkFailure());
  h.manager.accept({ id: 'a', username: 'a' }, h.upload);
  if (replace) {
    h.manager.startAttempt('b');
    h.manager.accept({ id: 'b', username: 'b' }, h.upload);
  } else h.manager.dispose();
  await settle();
  assert.equal(h.sent.length, 0);
  h.manager.dispose();
}

// Authenticated failures are bounded by a cooldown and redact all unstructured error properties.
{
  const h = harness();
  h.manager.accept({ id: 'owner', username: 'owner' }, h.upload);
  h.manager.request('auth_profile')(networkFailure());
  await settle();
  h.advance(29_999);
  h.manager.request('auth_profile')(networkFailure());
  await settle();
  assert.equal(h.sent.length, 1);
  h.advance(1);
  h.manager.request('auth_session')(Object.assign(new Error('PRIVATE_RESPONSE'), { status: 503 }));
  await settle();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].incident, 'auth_failed');
  assert.equal(h.sent[1].events.at(-1).code, 'server');
  assert.doesNotMatch(JSON.stringify(h.sent), /PRIVATE_/);
  h.manager.dispose();
}

// Categorization uses only fixed codes/statuses and tolerates hostile error accessors.
{
  const h = harness();
  h.manager.accept({ id: 'owner', username: 'owner' }, h.upload);
  const cases = [
    [{ code: 'REQUEST_TIMEOUT' }, undefined, 'timeout', 'timed_out'],
    [{ code: 'INVALID_RESPONSE', status: 200 }, undefined, 'invalid_response', 'failed'],
    [undefined, 429, 'rate_limited', 'failed'],
    [undefined, 401, 'auth', 'failed'],
    [new Proxy({}, { get() { throw new Error('PRIVATE_GETTER'); } }), undefined, 'unknown', 'failed'],
  ];
  for (const [error, status, code, outcome] of cases) {
    h.advance(30_000);
    assert.doesNotThrow(() => h.manager.request('auth_profile')(error, status));
    await settle();
    assert.equal(h.sent.at(-1).events.at(-1).code, code);
    assert.equal(h.sent.at(-1).events.at(-1).outcome, outcome);
  }
  h.manager.dispose();
}

// Both an actual timer and lazy age checks discard pre-login evidence after five minutes.
for (const fire of [false, true]) {
  const h = harness();
  h.manager.startAttempt('owner').request('auth_login')(networkFailure());
  h.advance(5 * 60_000);
  if (fire) h.fireTimers();
  h.manager.startAttempt('owner').request('auth_login')(undefined, 200);
  h.manager.accept({ id: 'owner', username: 'owner' }, h.upload);
  await settle();
  assert.equal(h.sent.length, 0);
  h.manager.dispose();
}

// The recorder caps hostile/repeated failures, and unknown subjects never cross attempts.
{
  const h = harness();
  h.manager.startAttempt('owner');
  for (let index = 0; index < 200; index++) h.manager.request('auth_login')(networkFailure());
  h.manager.accept({ id: 'owner', username: 'owner' }, h.upload);
  await settle();
  assert.equal(h.sent[0].events.length, 128);
  assert.equal(h.sent[0].truncated, true);
  h.manager.dispose();
  h.sent.length = 0;
  h.manager.startAttempt().request('auth_session')(networkFailure());
  h.manager.startAttempt().request('auth_session')(undefined, 200);
  h.manager.accept({ id: 'owner', username: 'owner' }, h.upload);
  await settle();
  assert.equal(h.sent.length, 0);
  h.manager.dispose();
}

// A recovery control cannot evict queued errors in the shared outbox.
{
  const h = harness();
  h.online(false);
  const queue = new DiagnosticReportOutbox('owner', h.upload, h.outbox);
  const report = (index, incident) => ({ schemaVersion: 1, clientReportId: index.toString(16).padStart(24, '0'),
    incident, client: { kind: 'web', platform: 'ios', installMode: 'browser', networkType: 'wifi' },
    durationMs: 0, events: [{ atMs: 0, kind: 'auth_request_finished', stage: 'auth_login', outcome: 'failed' }] });
  for (let index = 1; index <= 24; index++) queue.enqueue(report(index, 'auth_failed'));
  queue.enqueue(report(25, 'auth_recovered'));
  assert.doesNotMatch([...h.storage.values.values()].join(''), /auth_recovered/);
  queue.dispose();
  h.manager.dispose();
}

console.log('auth diagnostics: ok');

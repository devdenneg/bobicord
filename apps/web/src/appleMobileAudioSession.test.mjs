import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('appleMobileAudioSession.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(navigator, appleMobile = true) {
  const exports = {};
  vm.runInNewContext(js, {
    exports, navigator,
    require: (id) => {
      assert.equal(id, './audioDevices');
      return { currentAppleMobilePlatform: () => appleMobile };
    },
  });
  return exports.acquireAppleMobileAudioSession;
}

function session(initial = 'auto') {
  let type = initial;
  const writes = [];
  const value = {
    get type() { return type; },
    set type(next) { writes.push(next); type = next; },
  };
  return { value, writes, changeExternally(next) { type = next; } };
}

// Acquisition is synchronous, ahead of any subsequent capture, and preserves all enum defaults.
for (const previous of ['auto', 'playback', 'transient', 'transient-solo', 'ambient', 'play-and-record']) {
  const s = session(previous), acquire = load({ audioSession: s.value });
  const release = acquire();
  assert.equal(s.value.type, 'play-and-record');
  release(); assert.equal(s.value.type, previous);
  const completedWrites = s.writes.length;
  release(); assert.equal(s.writes.length, completedWrites, 'double release has no effect');
  assert.deepEqual(s.writes, previous === 'play-and-record' ? [] : ['play-and-record', previous]);
}

// Overlapping voice/preview and restart owners share one category write and original snapshot.
for (const firstOwnerEndsFirst of [true, false]) {
  const s = session(), acquire = load({ audioSession: s.value });
  const voice = acquire(), preview = acquire();
  assert.deepEqual(s.writes, ['play-and-record']);
  (firstOwnerEndsFirst ? voice : preview)();
  assert.equal(s.value.type, 'play-and-record');
  (firstOwnerEndsFirst ? preview : voice)();
  assert.equal(s.value.type, 'auto');
  assert.deepEqual(s.writes, ['play-and-record', 'auto']);
}

// Registry ownership is by AudioSession object, not by navigator/global instance.
{
  const first = session('ambient'), second = session('playback');
  const nav = { audioSession: first.value }, acquire = load(nav);
  const releaseFirst = acquire();
  nav.audioSession = second.value; const releaseSecond = acquire();
  releaseFirst(); assert.equal(first.value.type, 'ambient'); assert.equal(second.value.type, 'play-and-record');
  releaseSecond(); assert.equal(second.value.type, 'playback');
}

// A late duplicate release cannot undo a newer generation of leases on the same session.
{
  const s = session(), acquire = load({ audioSession: s.value });
  const old = acquire(); old();
  const current = acquire(); old();
  assert.equal(s.value.type, 'play-and-record'); current(); assert.equal(s.value.type, 'auto');
}

// Respect another component's category override, including while another local owner acquires.
{
  const s = session(), acquire = load({ audioSession: s.value });
  const voice = acquire(); s.changeExternally('playback'); const preview = acquire();
  assert.equal(s.value.type, 'playback', 'nested acquire does not fight an external override');
  voice(); preview(); assert.equal(s.value.type, 'playback');
  assert.deepEqual(s.writes, ['play-and-record']);
  const next = acquire(); next(); assert.equal(s.value.type, 'playback', 'a new lease snapshots the new owner category');
}

// Optional/desktop environments are completely untouched, even if accessing the API would throw.
{
  let reads = 0;
  const nav = { get audioSession() { reads++; throw new Error('Do not access on desktop'); } };
  const release = load(nav, false)(); release(); assert.equal(reads, 0);
}
for (const value of [undefined, null, {}, { type: undefined }, { type: 'future-category' }, { type: 42 }]) {
  const nav = value === undefined ? undefined : { audioSession: value };
  assert.doesNotThrow(() => { const release = load(nav)(); release(); release(); });
}
{
  const s = session('auto'); const release = load({ audioSession: s.value }, false)();
  release(); assert.equal(s.value.type, 'auto'); assert.deepEqual(s.writes, []);
}

// Getter/setter failure or a setter silently ignoring the request is a safe no-op.
{
  const acquire = load({ get audioSession() { throw new Error('Unavailable'); } });
  assert.doesNotThrow(() => acquire()());
}
{
  const acquire = load({ audioSession: { get type() { throw new Error('Unavailable'); } } });
  assert.doesNotThrow(() => acquire()());
}
{
  let failures = 0;
  const acquire = load({ audioSession: { get type() { return 'auto'; }, set type(_) { failures++; throw new Error('Blocked'); } } });
  assert.doesNotThrow(() => acquire()()); assert.equal(failures, 1);
}
{
  let writes = 0;
  const acquire = load({ audioSession: { get type() { return 'auto'; }, set type(_) { writes++; } } });
  const first = acquire(), second = acquire(); first(); second();
  assert.equal(writes, 2, 'ignored assignment never leaves a live lease in the registry');
}

// Restoration failures are contained and do not retain a stale reference-count generation.
for (const failure of ['readback', 'write-after-apply']) {
  let type = 'auto', reads = 0;
  const value = {
    get type() { if (++reads === 2 && failure === 'readback') throw new Error('Readback failed'); return type; },
    set type(next) { type = next; if (next === 'play-and-record' && failure === 'write-after-apply') throw new Error('Applied before failure'); },
  };
  const release = load({ audioSession: value })();
  assert.equal(type, 'auto', 'partially applied category is rolled back after acquisition failure');
  release(); assert.equal(type, 'auto');
}

// Restoration failures are contained and do not retain a stale reference-count generation.
for (const failure of ['get', 'set']) {
  let type = 'auto', broken = false;
  const value = {
    get type() { if (broken && failure === 'get') throw new Error('Read failed'); return type; },
    set type(next) { if (broken && failure === 'set') throw new Error('Write failed'); type = next; },
  };
  const acquire = load({ audioSession: value });
  const release = acquire(); broken = true; assert.doesNotThrow(release);
  broken = false; type = 'ambient';
  const newer = acquire(); release(); assert.equal(type, 'play-and-record');
  newer(); assert.equal(type, 'ambient');
}

console.log('Apple mobile AudioSession scoped category leases: ok');

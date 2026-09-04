import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadModule(name, globals = {}, dependencies = {}) {
  const source = readFileSync(new URL(name, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, {
    exports, WebAssembly, ...globals,
    require: (id) => {
      assert.ok(id in dependencies, `unexpected dependency ${id}`);
      return dependencies[id];
    },
  }, { filename: name });
  return exports;
}

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0).buffer;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function denoiseFixture(load = async () => wasm) {
  let loads = 0, nodes = 0;
  class Node {
    constructor(context, options) { this.context = context; this.options = options; nodes++; }
  }
  const api = loadModule('denoise.ts', {}, {
    '@sapphi-red/web-noise-suppressor': { RnnoiseWorkletNode: Node, loadRnnoise: () => { loads++; return load(); } },
    './microphoneAudioContext': { MICROPHONE_SAMPLE_RATE: 48_000 },
  });
  return { ...api, get loads() { return loads; }, get nodes() { return nodes; } };
}
function context(sampleRate = 48_000, addModule = async () => {}) {
  let modules = 0;
  return {
    sampleRate, state: 'running',
    audioWorklet: { addModule: () => { modules++; return addModule(); } },
    get modules() { return modules; },
  };
}

{
  const options = [];
  class AudioContext { constructor(value) { options.push(value); this.sampleRate = value.sampleRate; } }
  const { createMicrophoneAudioContext } = loadModule('microphoneAudioContext.ts', { AudioContext });
  assert.equal(createMicrophoneAudioContext().sampleRate, 48_000);
  assert.equal(options.length, 1);
  assert.equal(options[0].sampleRate, 48_000);
}
{
  const options = [];
  class AudioContext {
    constructor(value) {
      options.push(value);
      if (value) throw Object.assign(new Error('Unsupported rate'), { name: 'NotSupportedError' });
      this.sampleRate = 44_100;
    }
  }
  const { createMicrophoneAudioContext } = loadModule('microphoneAudioContext.ts', { AudioContext });
  assert.equal(createMicrophoneAudioContext().sampleRate, 44_100);
  assert.equal(options.length, 2);
  assert.equal(options[1], undefined);
}
{
  let calls = 0;
  const error = Object.assign(new Error('Blocked'), { name: 'SecurityError' });
  class AudioContext { constructor() { calls++; throw error; } }
  const { createMicrophoneAudioContext } = loadModule('microphoneAudioContext.ts', { AudioContext });
  assert.throws(createMicrophoneAudioContext, (value) => value === error);
  assert.equal(calls, 1);
}
{
  const fixture = denoiseFixture();
  for (const rate of [44_100, 96_000]) {
    const ctx = context(rate);
    assert.equal(await fixture.createDenoiseNode(ctx), null);
    assert.equal(ctx.modules, 0);
  }
  const closed = context(); closed.state = 'closed';
  assert.equal(await fixture.createDenoiseNode(closed), null);
  assert.equal(fixture.loads, 0);
  assert.equal(fixture.nodes, 0);
}
{
  const pending = deferred();
  const fixture = denoiseFixture(() => pending.promise);
  const ctx = context();
  const first = fixture.createDenoiseNode(ctx);
  const second = fixture.createDenoiseNode(ctx);
  pending.resolve(wasm);
  const nodes = await Promise.all([first, second]);
  assert.ok(nodes.every(Boolean));
  assert.equal(fixture.loads, 1);
  assert.equal(ctx.modules, 1);
  assert.equal(fixture.nodes, 2);
  assert.equal(nodes[0].options.maxChannels, 1);
}
{
  let attempts = 0;
  const fixture = denoiseFixture(async () => ++attempts === 1 ? new TextEncoder().encode('<html>Unavailable</html>').buffer : wasm);
  const ctx = context();
  assert.equal(await fixture.createDenoiseNode(ctx), null);
  assert.equal(fixture.nodes, 0, 'an error response must not create a silent worklet');
  assert.ok(await fixture.createDenoiseNode(ctx), 'next mic start retries corrupted WASM');
  assert.equal(fixture.loads, 2);
  assert.equal(ctx.modules, 1);
}
{
  let attempts = 0;
  const fixture = denoiseFixture(async () => { if (++attempts === 1) throw new Error('Offline'); return wasm; });
  const ctx = context();
  assert.equal(await fixture.createDenoiseNode(ctx), null);
  assert.ok(await fixture.createDenoiseNode(ctx));
  assert.equal(fixture.loads, 2);
}
{
  let attempts = 0;
  const fixture = denoiseFixture();
  const ctx = context(48_000, async () => { if (++attempts === 1) throw new Error('Offline'); });
  assert.equal(await fixture.createDenoiseNode(ctx), null);
  assert.ok(await fixture.createDenoiseNode(ctx));
  assert.equal(ctx.modules, 2, 'failed addModule must be retried');
  assert.equal(fixture.loads, 1, 'valid cached WASM need not be downloaded again');
}
{
  const pending = deferred();
  const fixture = denoiseFixture(() => pending.promise);
  const ctx = context();
  const result = fixture.createDenoiseNode(ctx);
  ctx.state = 'closed';
  pending.resolve(wasm);
  assert.equal(await result, null);
  assert.equal(fixture.nodes, 0, 'cancelled capture must not start a new processor');
}
{
  const fixture = denoiseFixture();
  const calls = [];
  fixture.destroyDenoiseNode({ disconnect() { calls.push('disconnect'); throw new Error('Disconnected'); }, destroy() { calls.push('destroy'); } });
  assert.deepEqual(calls, ['disconnect', 'destroy']);
}

console.log('microphone context and denoise: ok');

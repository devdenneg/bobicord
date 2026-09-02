import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./nativeWatchGeneration.ts', import.meta.url), 'utf8');
const treeSource = readFileSync(new URL('./transport/treeVideo.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
};

const loadFreshRenderer = async (salt) => import(
  'data:text/javascript,' + encodeURIComponent(js + `\n// renderer ${salt}`)
);

const firstRenderer = await loadFreshRenderer('one');
const first = firstRenderer.nextNativeWatchGeneration(1_000);
const second = firstRenderer.nextNativeWatchGeneration(1_000);
assert.equal(second, first + 1, 'same-renderer starts have strictly increasing owners');

const reloadedRenderer = await loadFreshRenderer('two');
const afterReload = reloadedRenderer.nextNativeWatchGeneration(1_000);
assert.equal(afterReload, second + 1,
  'a WebView reload resumes above the Rust process high-water generation');

const afterClockRollback = reloadedRenderer.nextNativeWatchGeneration(10);
assert.equal(afterClockRollback, afterReload + 1,
  'a system clock rollback cannot reuse an old native watch owner');

assert.match(treeSource,
  /const ownsStream = this\.nativeWatches\.get\(streamId\) === st;[\s\S]*stopNativeWatch\(streamId, st\.generation\)[\s\S]*if \(!ownsStream\) return;/,
  'a stale owner stops only its exact Rust generation and cannot tear down replacement state');
assert.match(treeSource,
  /if \(!ownsStream\) \{[\s\S]*this\.nativeUnwatch\(streamId, st, true\);[\s\S]*return;[\s\S]*const terminal/,
  'a delayed failed start exits before scheduling a retry owned by its replacement');
assert.match(treeSource,
  /const ownsOffer = \(\) => !st\.closed && this\.nativeWatches\.get\(streamId\) === st && st\.pc === pc[\s\S]*pc\.ontrack = \(e\) => \{[\s\S]*if \(!ownsOffer\(\)\) return;[\s\S]*nativeWatchAnswer\(streamId, st\.generation/,
  'late media and SDP callbacks are fenced to the exact current WebView peer connection');

console.log('native watch generation: ok');

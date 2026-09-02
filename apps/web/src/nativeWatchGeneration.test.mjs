import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./nativeWatchGeneration.ts', import.meta.url), 'utf8');
const treeSource = readFileSync(new URL('./transport/treeVideo.ts', import.meta.url), 'utf8');
const nativeSource = readFileSync(new URL('./native.ts', import.meta.url), 'utf8');
const nativeLibSource = readFileSync(new URL('../../native/src-tauri/src/lib.rs', import.meta.url), 'utf8');
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

const statusStart = nativeSource.indexOf('const NATIVE_WATCH_STATUS_STAGES');
const statusEnd = nativeSource.indexOf('/** Structured native watch telemetry', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'native status normalizer is present');
const statusJs = ts.transpileModule(nativeSource.slice(statusStart, statusEnd), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { normalizeNativeWatchStatusPayload } = await import(
  'data:text/javascript,' + encodeURIComponent(statusJs)
);
const validStatus = normalizeNativeWatchStatusPayload({
  streamId: 'streamer', generation: 7, stage: 'watch_signaling', outcome: 'failed',
  code: 'signaling_forbidden', reconnectCount: 2,
  rawError: 'must not cross', sdp: 'must not cross', candidate: 'must not cross', peerId: 'must not cross',
});
assert.deepEqual(validStatus, {
  streamId: 'streamer', generation: 7, stage: 'watch_signaling', outcome: 'failed',
  code: 'signaling_forbidden', reconnectCount: 2,
}, 'the bridge rebuilds a status from allow-listed fields only');
assert.equal(normalizeNativeWatchStatusPayload({
  streamId: 'streamer', generation: 7, stage: 'watch_signaling', outcome: 'failed', code: 'server supplied raw error',
}), null, 'a non-allow-listed code is rejected');
assert.equal(normalizeNativeWatchStatusPayload({
  streamId: 'streamer', generation: 7, stage: 'watch_signaling', outcome: 'failed',
  code: 'signaling_closed', reconnectCount: -1,
}), null, 'an invalid reconnect counter is rejected');
assert.match(treeSource,
  /const statusCb = \(status:[\s\S]*status\.streamId !== streamId \|\| status\.generation !== st\.generation \|\| !ownsStream\(\)[\s\S]*this\.emitWatchDiagnostic\(streamId/,
  'native statuses are accepted only by the exact current stream generation');
assert.match(treeSource, /retainListener\(onNativeWatchStatus\(statusCb\)\)/,
  'the sanitized status bridge is installed before native watch startup');
assert.match(nativeLibSource,
  /object\.insert\("generation"\.into\(\), serde_json::Value::from\(generation\)\);[\s\S]*let _ = ui_app\.emit\(evt, payload\);/,
  'every relay status acquires the exact local native-watch generation before its fire-and-forget Tauri emit');
assert.match(nativeLibSource,
  /app\.emit\("relay-watch-status", serde_json::json!\(\{[\s\S]*"generation": generation,[\s\S]*"stage": "watch_native_start",/,
  'the pre-relay async-auth status also carries its exact native-watch generation');

console.log('native watch generation: ok');

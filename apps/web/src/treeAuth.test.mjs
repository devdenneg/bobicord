import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./treeAuth.ts', import.meta.url), 'utf8');
const nativeSource = readFileSync(new URL('./native.ts', import.meta.url), 'utf8');
const treeSource = readFileSync(new URL('./transport/treeVideo.ts', import.meta.url), 'utf8');
const probeSource = readFileSync(new URL('./transport/probe.ts', import.meta.url), 'utf8');
const nativeLibSource = readFileSync(new URL('../../native/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const relaySource = readFileSync(new URL('../../relay-core/src/relay.rs', import.meta.url), 'utf8');

globalThis.window = {};
globalThis.location = { protocol: 'https:', host: 'web.example' };
globalThis.__treeAuthState = {
  token: 'old-access', persistent: true, needsRefresh: true, usable: true,
  refresh: async () => { globalThis.__treeAuthState.token = 'fresh-access'; },
};

const apiModule = 'data:text/javascript,' + encodeURIComponent(`
  export const getToken = () => globalThis.__treeAuthState.token;
  export const refreshAccessSession = () => globalThis.__treeAuthState.refresh();
  export const isTerminalSessionError = (error) => !!error?.terminal;
`);
const sessionModule = 'data:text/javascript,' + encodeURIComponent(`
  export const persistentSessionActive = () => globalThis.__treeAuthState.persistent;
  export const accessTokenNeedsRefresh = () => globalThis.__treeAuthState.needsRefresh;
  export const accessTokenStillUsable = () => globalThis.__treeAuthState.usable;
`);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace("from './api'", `from ${JSON.stringify(apiModule)}`)
  .replace("from './authSession'", `from ${JSON.stringify(sessionModule)}`);
const auth = await import('data:text/javascript,' + encodeURIComponent(js));

assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=fresh-access',
  'an expiring persistent JWT is refreshed before a browser tree handshake');

globalThis.__treeAuthState = {
  token: 'still-valid', persistent: true, needsRefresh: true, usable: true,
  refresh: async () => { throw new Error('offline'); },
};
assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=still-valid',
  'a transient refresh failure may use an access JWT that has not expired yet');

globalThis.__treeAuthState.usable = false;
await assert.rejects(auth.freshTreeWsUrl(), /offline/,
  'an expired JWT fails before opening an authentication retry loop');

let clock = 1_000;
const realNow = Date.now;
Date.now = () => clock;
let refreshCalls = 0;
const sharedOutage = Object.assign(new Error('auth upstream unavailable'), { retryAfter: 1 });
globalThis.__treeAuthState = {
  token: 'cooldown-access', persistent: true, needsRefresh: true, usable: false,
  refresh: async () => { refreshCalls += 1; throw sharedOutage; },
};
const concurrent = await Promise.allSettled(Array.from({ length: 8 }, () => auth.freshTreeWsUrl()));
assert.equal(refreshCalls, 1,
  'concurrent tree callers share the exact refresh promise during an auth outage');
assert.ok(concurrent.every((result) => result.status === 'rejected' && result.reason === sharedOutage));
for (let index = 0; index < 8; index++) {
  await assert.rejects(auth.freshTreeWsUrl(), (error) => error === sharedOutage);
}
assert.equal(refreshCalls, 1,
  'settled transient refresh failures are reused during the shared negative cooldown');
clock += 10_000;
await assert.rejects(auth.freshTreeWsUrl(), (error) => error === sharedOutage);
assert.equal(refreshCalls, 2, 'one new refresh is allowed when the bounded cooldown expires');

let rejectedRefreshes = 0;
globalThis.__treeAuthState = {
  token: 'rejected-access', persistent: true, needsRefresh: false, usable: true,
  refresh: async () => {
    rejectedRefreshes += 1;
    globalThis.__treeAuthState.token = 'replacement-access';
  },
};
auth.markTreeAccessRejected('wss://web.example/tree?token=rejected-access');
assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=replacement-access');
assert.equal(rejectedRefreshes, 1,
  'close 4001 forces a protected refresh even while the rejected JWT is not near expiry');
auth.markTreeAccessRejected('wss://web.example/tree?token=rejected-access');
assert.equal(await auth.freshTreeWsUrl(), 'wss://web.example/tree?token=replacement-access');
assert.equal(rejectedRefreshes, 1,
  'a delayed close from the old generation cannot invalidate the replacement access token');
Date.now = realNow;

globalThis.window.__TAURI_INTERNALS__ = {};
globalThis.__treeAuthState = {
  token: 'native-fresh', persistent: false, needsRefresh: false, usable: true,
  refresh: async () => { throw new Error('must not refresh legacy'); },
};
assert.equal(await auth.freshTreeWsUrl(), 'wss://reelay.online/tree?token=native-fresh');
assert.equal(await auth.freshTreeWsUrl('wss://media.example/tree'), 'wss://media.example/tree?token=native-fresh');

assert.doesNotMatch(nativeSource, /function treeWsUrl\(/,
  'native broadcast/watch must share the authenticated tree URL builder');
assert.match(nativeSource, /startNativeBroadcast[\s\S]*await freshTreeWsUrl\(\)/);
assert.match(nativeSource, /startNativeWatch[\s\S]*await freshTreeWsUrl\(\)/);
assert.match(treeSource, /openDiscovery[\s\S]*await freshTreeWsUrl\(\)/,
  'discovery refreshes access before reconnecting');
assert.match(treeSource, /openBrowserWatch[\s\S]*await freshTreeWsUrl\(\)/,
  'a browser viewer refreshes access before its dedicated watch socket');
assert.match(treeSource, /ev\.code === 4001[\s\S]*markTreeAccessRejected\(wsUrl\)/,
  'an established browser tree socket invalidates only its exact rejected access generation');
assert.match(treeSource, /scheduleBrowserWatchStartRetry\([\s\S]*webReconnectAttempts/,
  'transient auth or constructor failures retry through the existing bounded watch backoff');
assert.match(treeSource, /\[\.\.\.this\.browserWatchStarts\.keys\(\)\][\s\S]*this\.unwatch\(streamId\)/,
  'detach finishes diagnostic sessions which are still waiting behind the auth gate');
assert.match(treeSource,
  /catch \(error\) \{[\s\S]*const ownsStream = this\.nativeWatches\.get\(streamId\) === st;[\s\S]*if \(!ownsStream\) \{[\s\S]*this\.nativeUnwatch\(streamId, st, true\);[\s\S]*return;/,
  'an out-of-order failure from native owner A cleans only A and cannot retry over owner B');
assert.match(treeSource,
  /private nativeUnwatch[\s\S]*const ownsStream = this\.nativeWatches\.get\(streamId\) === st;[\s\S]*stopNativeWatch\(streamId, st\.generation\)[\s\S]*if \(!ownsStream\) return;[\s\S]*endViewerSession\(streamId\)/,
  'a stale native owner cannot delete diagnostics, topology, or video owned by its replacement');
assert.match(treeSource,
  /private async onNativeOffer[\s\S]*st\.closed \|\| this\.nativeWatches\.get\(streamId\) !== st[\s\S]*st\.pc !== pc[\s\S]*nativeWatchAnswer\(streamId, st\.generation/,
  'late offer callbacks and answers are fenced to the exact current native owner and peer connection');
assert.match(nativeLibSource,
  /latest_generation:[\s\S]*claim_native_watch_generation[\s\S]*stop\/newer start won while protected refresh was in flight/,
  'Rust retains a per-stream generation tombstone across an async native auth start');
assert.match(relaySource,
  /Some\(TreeEvent::Closed\) \| None => \{ watch_ended = true; break; \}/,
  'an unexpected terminal signalling close notifies the webview instead of leaving a stale tile');
assert.match(probeSource, /new WebSocket\(await freshTreeWsUrl\(\)\)/,
  'the upload probe uses the same canonical authenticated tree origin');

console.log('tree auth lifecycle: ok');

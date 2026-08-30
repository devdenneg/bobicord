import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./nativeAuthBroker.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../../native/src-tauri/src/native_auth.rs', import.meta.url), 'utf8');
const nativeLibSource = readFileSync(new URL('../../native/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const cargoSource = readFileSync(new URL('../../native/src-tauri/Cargo.toml', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');

const calls = [];
let invokeHandler = async (command, args) => {
  calls.push({ command, args });
  return { state: 'anonymous' };
};
globalThis.__relayNativeAuthInvoke = (command, args) => invokeHandler(command, args);
const fakeTauriUrl = 'data:text/javascript,' + encodeURIComponent(`
  export function invoke(command, args) { return globalThis.__relayNativeAuthInvoke(command, args); }
`);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("import('@tauri-apps/api/core')", `import(${JSON.stringify(fakeTauriUrl)})`);
const broker = await import('data:text/javascript,' + encodeURIComponent(js));

assert.deepEqual(await broker.resumeNativeAuth(null), { state: 'anonymous' });
assert.deepEqual(calls.pop(), { command: 'native_auth_resume', args: { legacyToken: null } });

invokeHandler = async (command, args) => {
  calls.push({ command, args });
  return { protocol: 'persistent-v1', token: 'access', accessToken: 'access' };
};
await broker.loginNativeAuth('alice', 'password');
assert.deepEqual(calls.pop(), {
  command: 'native_auth_login', args: { username: 'alice', password: 'password' },
});
await broker.changeNativePassword('short-access', 'old', 'new');
assert.deepEqual(calls.pop(), {
  command: 'native_auth_password_change',
  args: { accessToken: 'short-access', currentPassword: 'old', newPassword: 'new' },
});
await broker.drainNativeLogout([{ userId: 'u1', endpoint: 'https://push.example/one' }]);
assert.equal(calls.pop().command, 'native_auth_drain_logout');

invokeHandler = async () => { throw {
  code: 'SESSION_REVOKED', status: 401, message: 'Сессия завершена', attemptsRemaining: 2,
}; };
await assert.rejects(broker.refreshNativeAuth(), (error) => (
  error instanceof broker.NativeAuthBrokerError
  && error.code === 'SESSION_REVOKED'
  && error.status === 401
  && error.attemptsRemaining === 2
));

assert.doesNotMatch(source, /localStorage|sessionStorage/,
  'the renderer broker never persists any authentication secret');
assert.match(rustSource, /PROD_CREDENTIAL_TARGET: &str = "RelayApp\/auth\/session\/v1"/);
assert.match(rustSource, /DEBUG_CREDENTIAL_TARGET: &str = "RelayApp\/auth\/session\/debug\/v1"/,
  'debug builds cannot read or overwrite the production Windows credential');
assert.match(rustSource, /StoredState::Active[\s\S]*StoredState::LogoutPending/);
assert.match(rustSource, /CredReadW[\s\S]*CredWriteW[\s\S]*CredDeleteW/);
assert.match(rustSource, /trait CredentialStore[\s\S]*trait AuthTransport/,
  'credential and HTTP effects stay injectable for deterministic Rust state-machine tests');
assert.match(rustSource, /offline_logout_remains_pending_until_a_later_success/);
assert.match(rustSource, /failed_rotation_write_keeps_recoverable_previous_generation/);
assert.match(rustSource, /object\.remove\("refreshToken"\)[\s\S]*object\.remove\("csrfToken"\)/,
  'refresh and CSRF values are removed before the response crosses IPC');
assert.match(rustSource, /if serde_json::to_string\(&value\)[\s\S]*contains\(&refresh_token\)/,
  'a nested server echo cannot smuggle the refresh value through IPC');
assert.doesNotMatch(rustSource, /pub async fn native_auth_[^(]+\([^)]*(url|path): String/,
  'no renderer command accepts a generic URL or route');
assert.equal((rustSource.match(/authorize_invoker\(&window\)\?;/g) || []).length, 8,
  'every native auth command rejects non-main or navigated webviews before reading credentials');
assert.match(rustSource, /window\.label\(\) != "main"[\s\S]*url\.host_str\(\)/);
assert.match(rustSource, /"\/auth\/session\/upgrade" \| "\/auth\/session\/refresh" \| "\/auth\/session\/logout"/,
  'the native HTTP boundary has a literal route allow-list');
assert.match(rustSource, /while let Some\(chunk\) = response\.chunk\(\)[\s\S]*MAX_AUTH_RESPONSE_BYTES/,
  'a chunked upstream response is bounded before it can consume unbounded native memory');
assert.match(nativeLibSource, /manage\(native_auth::NativeAuthState::new\(\)/);
assert.match(nativeLibSource, /native_auth::native_auth_resume[\s\S]*native_auth::native_auth_drain_logout/);
assert.match(cargoSource, /rust-version = "1\.85"/);
assert.match(cargoSource, /reqwest = \{ version = "0\.13\.4", default-features = false, features = \["json", "rustls"\] \}/);
assert.match(cargoSource, /"Win32_Security_Credentials"/);
assert.match(apiSource, /IS_TAURI[\s\S]*resumeNativeAuth\(legacyMigrationToken\(\)\)/);
assert.match(apiSource, /IS_TAURI[\s\S]*refreshNativeAuth\(\)/);
assert.match(apiSource, /if \(IS_TAURI\) return 'omit'/,
  'native authenticated requests never use a WebView cookie jar');
assert.match(storeSource, /await api\.beginLogout\(\)/,
  'the UI waits for the Credential Manager logout fence before destroying the live view');

console.log('native auth broker tests: OK');

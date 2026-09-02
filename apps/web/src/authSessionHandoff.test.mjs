import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'store.ts'), 'utf8');
const bootstrapSource = readFileSync(join(here, 'authBootstrap.ts'), 'utf8');
const bootstrapJs = ts.transpileModule(bootstrapSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const bootstrap = await import('data:text/javascript,' + encodeURIComponent(bootstrapJs));
const file = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node)
  && node.name?.text === 'completeAuthSessionHandoff');

assert.ok(declaration && ts.isFunctionDeclaration(declaration), 'completeAuthSessionHandoff must exist');

const calls = [];
const visit = (node) => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    calls.push({ name: node.expression.name.text, args: node.arguments.map((arg) => arg.getText(file)) });
  }
  ts.forEachChild(node, visit);
};
visit(declaration);

for (const mutatingVoiceCall of ['joinVoice', 'mintVoiceIntent', 'claimVoiceLease']) {
  assert.equal(calls.some((call) => call.name === mutatingVoiceCall), false,
    `auth handoff must not call ${mutatingVoiceCall} without a new user gesture`);
}

const reconnects = calls.filter((call) => call.name === 'connectServer');
assert.deepEqual(reconnects.map((call) => call.args), [['plan.viewedServerId']],
  'auth handoff may reconnect only the previously viewed room');
assert.match(declaration.getText(file), /Голосовая связь отключена — подключись к каналу снова/,
  'a previously active voice session must get a manual reconnect prompt');

assert.equal(bootstrap.isRecoverableAcceptedSessionBootstrapError({ code: 'NETWORK_ERROR', status: 0 }), true);
assert.equal(bootstrap.isRecoverableAcceptedSessionBootstrapError({ code: 'REQUEST_TIMEOUT', status: 0 }), true);
assert.equal(bootstrap.isRecoverableAcceptedSessionBootstrapError({ code: 'HTTP_ERROR', status: 503 }), true);
assert.equal(bootstrap.isRecoverableAcceptedSessionBootstrapError({ code: 'SESSION_REVOKED', status: 503 }), false,
  'an authoritative revocation must never be hidden by its HTTP status');
assert.equal(bootstrap.isRecoverableAcceptedSessionBootstrapError({ code: 'REFRESH_INVALID', status: 401 }), false);
assert.equal(bootstrap.isRecoverableAcceptedSessionBootstrapError({ code: 'UNAUTHORIZED', status: 401 }), false);
assert.deepEqual([...bootstrap.AUTH_BOOTSTRAP_RETRY_DELAYS_MS], [1000, 3000, 10000],
  'accepted-session snapshot recovery must remain bounded');
assert.match(source, /catch \(error\) \{[\s\S]*isRecoverableAcceptedSessionBootstrapError\(error\)[\s\S]*retryBootstrap = true;[\s\S]*set\(\{ view: 'home' \}\)/,
  'a transient second /me failure must enter the authenticated home shell');
assert.match(source, /if \(retryBootstrap\)[\s\S]*scheduleAuthBootstrapRetry\(user\.id\)/,
  'a degraded authenticated shell must retry its snapshot without another login');

console.log('auth session handoff: ok');

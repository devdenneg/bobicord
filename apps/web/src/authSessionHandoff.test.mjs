import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'store.ts'), 'utf8');
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

console.log('auth session handoff: ok');

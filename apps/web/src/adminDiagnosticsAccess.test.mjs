import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const accessSource = readFileSync(join(here, 'adminDiagnosticsAccess.ts'), 'utf8');
const accessJs = ts.transpileModule(accessSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { canViewVoiceDiagnostics } = await import('data:text/javascript,' + encodeURIComponent(accessJs));

assert.equal(canViewVoiceDiagnostics({ username: 'denis', isAdmin: false }), true);
assert.equal(canViewVoiceDiagnostics({ username: 'another-admin', isAdmin: true }), false,
  'ordinary isAdmin must not expose detailed voice diagnostics');
assert.equal(canViewVoiceDiagnostics({ username: 'denis-copy', isAdmin: true }), false);
assert.equal(canViewVoiceDiagnostics(null), false);

const adminPage = readFileSync(join(here, 'components', 'AdminPage.tsx'), 'utf8');
assert.match(adminPage, /const isBootstrapAdmin = canViewVoiceDiagnostics\(me\)/,
  'AdminPage derives the diagnostics gate from the bootstrap-only policy');
assert.match(adminPage, /isBootstrapAdmin \? <button[^>]+tab === 'diagnostics'[\s\S]*?>Диагностика<\/button> : null/,
  'the diagnostics tab is rendered only inside the bootstrap-only gate');

const apiSource = readFileSync(join(here, 'api.ts'), 'utf8');
assert.match(apiSource, /query\.set\('beforeCreated', String\(options\.cursor\.createdAt\)\)/,
  'the admin API sends the timestamp half of the compound cursor');
assert.match(apiSource, /query\.set\('beforeId', options\.cursor\.id\)/,
  'the admin API sends the id half of the compound cursor');

const diagnosticsPage = readFileSync(join(here, 'components', 'AdminVoiceDiagnostics.tsx'), 'utf8');
assert.match(diagnosticsPage, /setNextCursor\(response\.nextCursor\)/,
  'the diagnostics page retains the server-issued cursor');
assert.match(diagnosticsPage, /onClick=\{\(\) => loadPage\(nextCursor, true\)\}/,
  'the diagnostics page can append the next stored page');
assert.match(diagnosticsPage, />\s*\{loading \? 'Загрузка…' : 'Загрузить ещё'\}\s*<\/button>/,
  'the diagnostics page exposes a bounded load-more control');

console.log('admin diagnostics access: ok');

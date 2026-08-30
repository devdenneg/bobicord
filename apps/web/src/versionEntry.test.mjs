import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'versionEntry.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { appEntryFromHtml, appEntryFromSources } = await import('data:text/javascript,' + encodeURIComponent(js));

assert.equal(appEntryFromSources(['/assets/index-Old123.js']), '/assets/index-Old123.js');
assert.equal(appEntryFromSources(['/assets/main-Current456.js']), '/assets/main-Current456.js');
assert.equal(appEntryFromSources(['https://reelay.online/assets/client-Future789.js?v=1']), '/assets/client-Future789.js');
assert.equal(appEntryFromSources(['/src/main.tsx']), null);
assert.equal(appEntryFromSources(['https://www.youtube.com/iframe_api']), null);

assert.equal(appEntryFromHtml(`
  <!doctype html>
  <link rel="modulepreload" href="/assets/vendor-Abc.js">
  <script type="module" crossorigin src="/assets/main-NewHash.js"></script>
`), '/assets/main-NewHash.js');
assert.equal(appEntryFromHtml(`
  <script crossorigin src='/assets/index-LegacyHash.js' type='module'></script>
`), '/assets/index-LegacyHash.js');
assert.equal(appEntryFromHtml('<script type="module" src="/src/main.tsx"></script>'), null);
assert.equal(appEntryFromHtml('<script src="/assets/not-the-module-entry.js"></script>'), null);
assert.equal(appEntryFromHtml('<script type="module" data-src="/assets/not-a-real-source.js"></script>'), null);
assert.equal(appEntryFromHtml('<link rel="modulepreload" href="/assets/main-FalsePositive.js">'), null);

const watcher = readFileSync(join(here, 'version.ts'), 'utf8');
assert.match(watcher, /let checking: Promise<void> \| null = null/,
  'foreground and interval update checks share one in-flight request');
assert.match(watcher, /AbortController[\s\S]*UPDATE_CHECK_TIMEOUT_MS[\s\S]*signal: controller\.signal/,
  'a stalled mobile network cannot accumulate update fetches forever');
assert.match(watcher, /addEventListener\('pageshow',[\s\S]*void check\(\)/,
  'Safari tab and standalone PWA BFCache restores both trigger a bounded update check');

console.log('version entry: ok');

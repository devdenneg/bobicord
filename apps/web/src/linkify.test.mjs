import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'linkify.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { linkifyHttpUrls, normalizeExternalHttpUrl } = await import('data:text/javascript,' + encodeURIComponent(js));

const links = (text) => linkifyHttpUrls(text).filter((part) => typeof part !== 'string');

assert.deepEqual(linkifyHttpUrls('Смотри (https://example.com/a).'), [
  'Смотри (',
  { kind: 'link', href: 'https://example.com/a', label: 'https://example.com/a' },
  ').',
]);
assert.equal(links('https://example.com/wiki/Foo_(bar)').at(0).label, 'https://example.com/wiki/Foo_(bar)');
assert.equal(links('https://youtu.be/nfLLaqraI8A, потом').at(0).href, 'https://youtu.be/nfLLaqraI8A');
assert.deepEqual(links('https://one.example,https://two.example').map((part) => part.href), [
  'https://one.example/',
  'https://two.example/',
]);
assert.deepEqual(links('https://one.example;HTTPS://two.example').map((part) => part.href), [
  'https://one.example/',
  'https://two.example/',
]);
assert.equal(links('`https://example.com/docs`').at(0).href, 'https://example.com/docs');
assert.equal(links('abcHTTP://example.com').length, 0);
assert.equal(normalizeExternalHttpUrl('javascript:alert(1)'), null);
assert.equal(normalizeExternalHttpUrl('https://user:pass@example.com/'), null);
assert.equal(normalizeExternalHttpUrl('HTTPS://Example.com/a b'), 'https://example.com/a%20b');

console.log('linkify: ok');

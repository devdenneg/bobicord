import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'micLifecycle.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  MIC_MUTED_RESTART_MS,
  mutedTrackNeedsRestart,
  readStoredFlag,
  selectedInputUnavailable,
} = await import('data:text/javascript,' + encodeURIComponent(js));

assert.equal(readStoredFlag({ getItem: () => '1' }, 'voiceMute'), true);
assert.equal(readStoredFlag({ getItem: () => '0' }, 'voiceMute'), false);
assert.equal(readStoredFlag({ getItem: () => { throw new Error('blocked'); } }, 'voiceMute'), false);

assert.equal(selectedInputUnavailable({ name: 'NotFoundError' }), true);
assert.equal(selectedInputUnavailable({ name: 'OverconstrainedError' }), true);
assert.equal(selectedInputUnavailable({ name: 'NotAllowedError' }), false);
assert.equal(selectedInputUnavailable(new Error('busy')), false);

assert.equal(mutedTrackNeedsRestart(1000, 1000 + MIC_MUTED_RESTART_MS - 1), false);
assert.equal(mutedTrackNeedsRestart(1000, 1000 + MIC_MUTED_RESTART_MS), true);
assert.equal(mutedTrackNeedsRestart(0, 999_999), false);

console.log('mic lifecycle: ok');

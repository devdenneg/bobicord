import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'volumeCurve.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { userVolumeToGain } = await import('data:text/javascript,' + encodeURIComponent(js));

const closeTo = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-10,
  `expected ${actual} to be close to ${expected}`,
);

closeTo(userVolumeToGain(0), 0);
closeTo(userVolumeToGain(0.5), 0.125);
closeTo(userVolumeToGain(0.88), 0.88 ** 3);
closeTo(userVolumeToGain(1), 1);
closeTo(userVolumeToGain(1.5), 1.5);
closeTo(userVolumeToGain(2), 2);
closeTo(userVolumeToGain(-1), 0);
closeTo(userVolumeToGain(3), 2);
closeTo(userVolumeToGain(Number.NaN), 1);

assert.ok(userVolumeToGain(0.75) < userVolumeToGain(0.88));
assert.ok(userVolumeToGain(0.88) < userVolumeToGain(1));

console.log('volume curve: ok');

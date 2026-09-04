import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chatWallpaper.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  CAT_WALLPAPER_STORAGE_KEY,
  readCatWallpaper,
  writeCatWallpaper,
} = await import('data:text/javascript,' + encodeURIComponent(js));

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

assert.equal(readCatWallpaper(storage), false);
values.set(CAT_WALLPAPER_STORAGE_KEY, '1');
assert.equal(readCatWallpaper(storage), true);
values.set(CAT_WALLPAPER_STORAGE_KEY, 'true');
assert.equal(readCatWallpaper(storage), false);

writeCatWallpaper(true, storage);
assert.equal(values.get(CAT_WALLPAPER_STORAGE_KEY), '1');
writeCatWallpaper(false, storage);
assert.equal(values.has(CAT_WALLPAPER_STORAGE_KEY), false);

const unavailableStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};
assert.equal(readCatWallpaper(unavailableStorage), false);
assert.doesNotThrow(() => writeCatWallpaper(true, unavailableStorage));
assert.doesNotThrow(() => writeCatWallpaper(false, unavailableStorage));

console.log('chat wallpaper: ok');

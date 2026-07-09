// Roadmap-flow-стриминга Д5: юнит-тест pickPreset (нет vitest в apps/web — node+esbuild ad-hoc).
// Запуск: node apps/web/src/presets.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'presets.ts'), 'utf8');
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code;
const mod = await import('data:text/javascript,' + encodeURIComponent(js));
const { pickPreset } = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (ожидалось ${want})`}`);
  ok ? pass++ : fail++;
}

// AC роадмапа: канал ~8 Мбит → useful = 0.75×8000 = 6000.
eq('8Мбит smooth → 1080p60', pickPreset(6000, 'smooth').label, '1080p60');
eq('8Мбит quality → 1080p30', pickPreset(6000, 'quality', 1080).label, '1080p30');

// Развилка на одном битрейте: smooth держит 60fps, quality роняет fps ради разрешения.
eq('6000 smooth (нет sourceH) → 1080p60', pickPreset(6000, 'smooth').label, '1080p60');
eq('6000 quality (source≥1080) → 1080p30', pickPreset(6000, 'quality', 1080).label, '1080p30');

// 5 Мбит: smooth опускает разрешение, но держит 60fps (720p60/4500 влезает).
eq('5000 smooth → 720p60', pickPreset(5000, 'smooth').label, '720p60');
eq('5000 quality → 1080p30', pickPreset(5000, 'quality', 1080).label, '1080p30');

// 4 Мбит: 60fps не влезает (min 720p60=4500) → smooth падает на 30fps-лестницу.
eq('4000 smooth → 720p30', pickPreset(4000, 'smooth').label, '720p30');
eq('4000 quality → 720p30', pickPreset(4000, 'quality', 1080).label, '720p30');

// Без апскейла: source 720 — 1080-пресеты не предлагаем.
eq('6000 quality source=720 → 720p30', pickPreset(6000, 'quality', 720).label, '720p30');
eq('6000 smooth source=720 → 720p60', pickPreset(6000, 'smooth', 720).label, '720p60');

// Флор: очень узкий канал → 360p30 (ничего выше не влезает).
eq('500 smooth → 360p30 (флор)', pickPreset(500, 'smooth').label, '360p30');
eq('900 quality → 360p30', pickPreset(900, 'quality').label, '360p30');

// Ровно на границе 480p30/1500.
eq('1500 quality → 480p30', pickPreset(1500, 'quality').label, '480p30');

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);

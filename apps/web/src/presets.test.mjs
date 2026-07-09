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

// 4 Мбит (наблюдалось живьём: probe 5.3 → useful 4.0). РЕГРЕССИЯ: раньше самым дешёвым
// 60fps-пресетом был 720p60/4500 — он не влезал, smooth молча падал на 30fps и СОВПАДАЛ с
// quality (оба 720p30). Юзер это и заметил. Теперь 480p60/2500 держит 60 fps.
eq('4000 smooth → 480p60 (60fps держим)', pickPreset(4000, 'smooth').label, '480p60');
eq('4000 quality → 720p30 (разрешение держим)', pickPreset(4000, 'quality', 1080).label, '720p30');
if (pickPreset(4000, 'smooth').label === pickPreset(4000, 'quality', 1080).label) {
  console.log('FAIL 4000: режимы совпали — развилка бессмысленна'); fail++;
} else { console.log('PASS 4000: режимы РАЗОШЛИСЬ'); pass++; }

// 3 Мбит: smooth всё ещё 60fps (480p60/2500), quality берёт 720p30/3000 ровно в потолок.
eq('3000 smooth → 480p60', pickPreset(3000, 'smooth').label, '480p60');
eq('3000 quality → 720p30', pickPreset(3000, 'quality', 1080).label, '720p30');

// 2 Мбит: 480p60 не влезает → smooth опускается на 360p60/1200, НЕ на 30fps.
eq('2000 smooth → 360p60', pickPreset(2000, 'smooth').label, '360p60');
eq('2000 quality → 480p30', pickPreset(2000, 'quality').label, '480p30');

// Без апскейла: source 720 — 1080-пресеты не предлагаем.
eq('6000 quality source=720 → 720p30', pickPreset(6000, 'quality', 720).label, '720p30');
eq('6000 smooth source=720 → 720p60', pickPreset(6000, 'smooth', 720).label, '720p60');
// Без апскейла + тонкий канал: source 480 не даёт 720p60.
eq('4000 smooth source=480 → 480p60', pickPreset(4000, 'smooth', 480).label, '480p60');

// Флор: очень узкий канал → 360p30 (ничего выше не влезает, включая 360p60/1200).
eq('500 smooth → 360p30 (флор)', pickPreset(500, 'smooth').label, '360p30');
eq('900 quality → 360p30', pickPreset(900, 'quality').label, '360p30');
// 1200 ровно = 360p60: smooth обязан взять его, а не 360p30.
eq('1200 smooth → 360p60 (граница)', pickPreset(1200, 'smooth').label, '360p60');

// Ровно на границе 480p30/1500 (quality игнорит 60fps-ступени).
eq('1500 quality → 480p30', pickPreset(1500, 'quality').label, '480p30');
// 2500 ровно = 480p60.
eq('2500 smooth → 480p60 (граница)', pickPreset(2500, 'smooth').label, '480p60');

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);

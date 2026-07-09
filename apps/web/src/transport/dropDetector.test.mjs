// Roadmap-flow-стриминга Д7: юнит-тест детектора дропов кадров (нет vitest в apps/web —
// node+esbuild ad-hoc, как presets.test.mjs). Запуск: node apps/web/src/transport/dropDetector.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'dropDetector.ts'), 'utf8');
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code;
const mod = await import('data:text/javascript,' + encodeURIComponent(js));
const { shouldReparentOnDrops, DropWindow, DROP_WINDOW_MS } = mod;

let pass = 0, fail = 0;
function ok(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); cond ? pass++ : fail++; }

// Хелпер: дельты «как из окна» (span 3000 по умолчанию — полное окно).
const D = (dropped, decoded, lost, spanMs = 3000) => ({ droppedDelta: dropped, decodedDelta: decoded, packetsLostDelta: lost, spanMs });
const base = { hidden: false, now: 100000, cooldownUntil: 0 };

// (a) dropRate 6% + packetsLost>0 → true
ok('(a) 6% дропов + потери>0 → миграция', shouldReparentOnDrops({ ...base, deltas: D(6, 94, 3) }) === true);

// (b) dropRate 6% + packetsLost==0 → false (рендерные дропы слабого ПК — не вина родителя)
ok('(b) 6% дропов + потери==0 → НЕТ (рендерные дропы)', shouldReparentOnDrops({ ...base, deltas: D(6, 94, 0) }) === false);

// (c) dropRate 3% + packetsLost>0 → false (ниже порога 5%)
ok('(c) 3% дропов + потери>0 → НЕТ (ниже порога)', shouldReparentOnDrops({ ...base, deltas: D(3, 97, 5) }) === false);

// (d) hidden → false (скрытая вкладка дропает легитимно)
ok('(d) скрытая вкладка → НЕТ', shouldReparentOnDrops({ ...base, hidden: true, deltas: D(50, 50, 100) }) === false);

// (e) cooldown 10с блокирует повторный триггер
ok('(e) cooldown блокирует', shouldReparentOnDrops({ ...base, now: 100000, cooldownUntil: 105000, deltas: D(20, 80, 50) }) === false);
ok('(e) после cooldown — срабатывает', shouldReparentOnDrops({ ...base, now: 106000, cooldownUntil: 105000, deltas: D(20, 80, 50) }) === true);

// Неполное окно (span < 2400) → false, даже при высоких дропах (мало сэмплов).
ok('неполное окно (span 1000) → НЕТ', shouldReparentOnDrops({ ...base, deltas: D(20, 80, 50, 1000) }) === false);

// (f) окно 3с корректно скользит: старые сэмплы вытесняются.
{
  const w = new DropWindow();
  // t=0 — старый ВСПЛЕСК дропов (dropped 0→100), дальше кадры декодятся чисто без потерь.
  w.push({ t: 0, framesDropped: 100, framesDecoded: 0, packetsLost: 50 });
  ok('(f) 1 сэмпл → deltas null', w.deltas() === null);
  w.push({ t: 1000, framesDropped: 100, framesDecoded: 100, packetsLost: 50 });
  w.push({ t: 2000, framesDropped: 100, framesDecoded: 200, packetsLost: 50 });
  w.push({ t: 3000, framesDropped: 100, framesDecoded: 300, packetsLost: 50 });
  // t=0..3000: cutoff=0, t=0 остаётся (не <0). span=3000.
  ok('(f) до слайда: старейший=0, span=3000', w.oldestTs() === 0 && w.deltas().spanMs === 3000);
  w.push({ t: 4000, framesDropped: 100, framesDecoded: 400, packetsLost: 50 });
  // t=4000: cutoff=1000 → t=0 (всплеск) вытеснен. Окно [1000..4000], span=3000, size=4.
  ok('(f) после слайда: всплеск t=0 вытеснен (старейший=1000, size=4)', w.oldestTs() === 1000 && w.size() === 4);
  const d = w.deltas();
  // Всплеск ушёл: dropped 0, decoded 300, lost 0 → миграции НЕТ (окно чистое).
  ok('(f) слайд убрал старый всплеск → миграции нет', shouldReparentOnDrops({ ...base, deltas: d }) === false && d.droppedDelta === 0);
  void DROP_WINDOW_MS;
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);

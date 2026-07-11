// Self-heal зрителя (диаг фризов): юнит-тест чистой логики (node+esbuild, образец
// dropDetector.test.mjs). Запуск: node apps/web/src/transport/stallDetector.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'stallDetector.ts'), 'utf8');
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code;
const mod = await import('data:text/javascript,' + encodeURIComponent(js));
const { newStallState, shouldSelfHeal, STALL_MS, STALL_COOLDOWN_MS } = mod;

let pass = 0, fail = 0;
function ok(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); cond ? pass++ : fail++; }

const noCd = { hidden: false, cooldownUntil: 0 };

// (a) framesDecoded растёт → не хилим, прогресс двигается.
{
  const st = newStallState(0);
  ok('(a) рост кадров → НЕТ', shouldSelfHeal(st, 10, 1000, noCd) === false);
  ok('(a) прогресс обновлён', st.lastProgressAt === 1000 && st.everDecoded === true);
  ok('(a) ещё рост через 9с → НЕТ', shouldSelfHeal(st, 20, 10000, noCd) === false);
}

// (b) кадры были, потом замерли ≥ STALL_MS → хилим.
{
  const st = newStallState(0);
  shouldSelfHeal(st, 10, 1000, noCd); // everDecoded=true, progress@1000
  ok('(b) замер <8с → НЕТ', shouldSelfHeal(st, 10, 1000 + STALL_MS - 1, noCd) === false);
  ok('(b) замер ≥8с → ХИЛИМ', shouldSelfHeal(st, 10, 1000 + STALL_MS, noCd) === true);
}

// (c) первый коннект без единого кадра (everDecoded=false) → НЕ хилим (прикрывает failsafe).
{
  const st = newStallState(0);
  ok('(c) 0 кадров, замер 20с → НЕТ (не было декода)', shouldSelfHeal(st, 0, 20000, noCd) === false);
}

// (d) hidden → сброс прогресса, никогда не хилим.
{
  const st = newStallState(0);
  shouldSelfHeal(st, 10, 1000, noCd); // progress@1000
  ok('(d) hidden → НЕТ', shouldSelfHeal(st, 10, 20000, { hidden: true, cooldownUntil: 0 }) === false);
  ok('(d) hidden сдвинул прогресс', st.lastProgressAt === 20000);
  // после возврата в visible замер отсчитывается от момента visible, не копит фоновое время
  ok('(d) сразу после hidden замер <8с → НЕТ', shouldSelfHeal(st, 10, 20000 + STALL_MS - 1, noCd) === false);
}

// (e) кулдаун блокирует повторный self-heal.
{
  const st = newStallState(0);
  shouldSelfHeal(st, 10, 1000, noCd);
  const now = 1000 + STALL_MS;
  ok('(e) в кулдауне → НЕТ', shouldSelfHeal(st, 10, now, { hidden: false, cooldownUntil: now + STALL_COOLDOWN_MS }) === false);
  ok('(e) после кулдауна → ХИЛИМ', shouldSelfHeal(st, 10, now + STALL_COOLDOWN_MS, { hidden: false, cooldownUntil: now + STALL_COOLDOWN_MS }) === true);
}

// (f) re-watch обнулил framesDecoded (смена PC) → трактуется как прогресс, не как замер.
{
  const st = newStallState(0);
  shouldSelfHeal(st, 100, 1000, noCd); // прогресс до 100
  ok('(f) обнуление счётчика → прогресс, НЕТ', shouldSelfHeal(st, 0, 2000, noCd) === false);
  ok('(f) прогресс обновлён на обнулении', st.lastProgressAt === 2000);
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);

// Диаг фризов 2026-07-10/11: self-heal зрителя. Стрим live, доставка идёт (packetsReceived
// растёт), а декодер webview/Chromium заклинил — framesDecoded замер, PLI впустую (bug: reparent
// в webview / клин декодера на битом потоке). Единственное лекарство — пересоздать подписку.
// Чистая логика без DOM (юнит-тест stallDetector.test.mjs, образец dropDetector.ts); treeVideo.ts
// кормит framesDecoded с 1с-таймера и по true зовёт бесшовный re-watch.

export const STALL_MS = 8_000;            // framesDecoded не растёт столько → декодер заклинил
export const STALL_COOLDOWN_MS = 20_000;  // не заболтать дерево авто-re-watch'ами

export interface StallState {
  lastFrames: number;     // последний виденный framesDecoded
  lastProgressAt: number; // когда framesDecoded в последний раз вырос (ms)
  everDecoded: boolean;   // был ли хоть один кадр (не душим медленный первый коннект — его прикрывает failsafe)
}

export function newStallState(now: number): StallState {
  return { lastFrames: 0, lastProgressAt: now, everDecoded: false };
}

/**
 * Обновляет состояние по свежему framesDecoded и решает, пора ли self-heal.
 * Мутирует st (прогресс/everDecoded/сброс на hidden). Возвращает true ровно когда:
 *   декодер замер ≥ STALL_MS при live-стриме, кулдаун прошёл, хоть один кадр УЖЕ был.
 *
 * Гейты:
 *  - hidden: фоновая вкладка легитимно троттлит декод → сбрасываем прогресс (не считаем
 *    заморозкой момент возврата в visible) и никогда не хилим.
 *  - everDecoded: первый коннект, где кадров ещё не было, — не наш случай (его закрывает
 *    failsafe бесшовного переключения), иначе задушили бы медленный старт бесконечным re-watch.
 */
export function shouldSelfHeal(st: StallState, framesDecoded: number, now: number, opts: {
  hidden: boolean;
  cooldownUntil: number;
}): boolean {
  if (opts.hidden) { st.lastProgressAt = now; return false; }
  // Смена трека/PC (сам re-watch) обнуляет кумулятивный счётчик — рост ИЛИ обнуление = прогресс.
  if (framesDecoded !== st.lastFrames) {
    if (framesDecoded > st.lastFrames) st.everDecoded = true;
    st.lastFrames = framesDecoded;
    st.lastProgressAt = now;
    return false;
  }
  if (!st.everDecoded) return false;              // кадров ещё не было — не наш случай
  if (now < opts.cooldownUntil) return false;
  return now - st.lastProgressAt >= STALL_MS;
}

// Roadmap-flow-стриминга Д7: детектор дропов кадров у зрителя (отбраковка плохого родителя).
// Чистая логика без DOM — юнит-тестируется node+esbuild (dropDetector.test.mjs). treeVideo.ts
// кормит её сэмплами inbound-rtp с 1с-таймера и по результату зовёт requestReparent.

export const DROP_RATE_THRESHOLD = 0.05;   // >5% дропнутых кадров за окно
export const DROP_WINDOW_MS = 3000;        // скользящее окно 3с (роадмап)
export const DROP_COOLDOWN_MS = 10_000;    // клиентский cooldown между миграциями (серверный подстрахует)
export const DROP_MIN_SPAN_MS = 2400;      // требуем ~полное окно (0.8×3с) до решения — не судим по 1 сэмплу

export interface DropSample {
  t: number;            // метка времени, ms
  framesDropped: number; // кумулятивный inbound-rtp.framesDropped
  framesDecoded: number; // кумулятивный inbound-rtp.framesDecoded
  packetsLost: number;   // кумулятивный inbound-rtp.packetsLost
}

export interface DropDeltas {
  droppedDelta: number;
  decodedDelta: number;
  packetsLostDelta: number;
  spanMs: number;
}

/** Скользящее окно кумулятивных счётчиков inbound-rtp. Держит сэмплы за DROP_WINDOW_MS. */
export class DropWindow {
  private samples: DropSample[] = [];
  push(s: DropSample) {
    this.samples.push(s);
    // Выбрасываем всё старше окна относительно новейшего сэмпла (оставляем ≥1 для дельты).
    const cutoff = s.t - DROP_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) this.samples.shift();
  }
  reset() { this.samples.length = 0; }
  size() { return this.samples.length; }
  oldestTs(): number | null { return this.samples.length ? this.samples[0].t : null; }
  /** Дельты между старейшим-в-окне и новейшим сэмплом; null если <2 сэмплов. */
  deltas(): DropDeltas | null {
    if (this.samples.length < 2) return null;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    return {
      // Клэмп в 0: смена трека/PC могла обнулить кумулятивные счётчики (отрицательная дельта = не потери).
      droppedDelta: Math.max(0, b.framesDropped - a.framesDropped),
      decodedDelta: Math.max(0, b.framesDecoded - a.framesDecoded),
      packetsLostDelta: Math.max(0, b.packetsLost - a.packetsLost),
      spanMs: b.t - a.t,
    };
  }
}

/**
 * Чистое решение: мигрировать ли от текущего родителя по дропам кадров.
 *
 * Второй сигнал packetsLost ОБЯЗАТЕЛЕН (риск роадмапа): `framesDropped` в Chromium включает
 * РЕНДЕРНЫЕ дропы слабого ПК зрителя — без дельты packetsLost слабый ПК вызывал бы вечные
 * ложные миграции. Гейты: скрытая вкладка (браузер легитимно троттлит декод/рендер), клиентский
 * cooldown, неполное окно (мало сэмплов).
 */
export function shouldReparentOnDrops(input: {
  deltas: DropDeltas | null;
  hidden: boolean;
  now: number;
  cooldownUntil: number;
}): boolean {
  if (input.hidden) return false;                 // скрытая вкладка дропает кадры легитимно
  if (input.now < input.cooldownUntil) return false;
  const d = input.deltas;
  if (!d) return false;
  if (d.spanMs < DROP_MIN_SPAN_MS) return false;  // окно ещё не набралось
  const total = d.droppedDelta + d.decodedDelta;
  if (total <= 0) return false;                   // нет кадров за окно — судить не о чем
  const dropRate = d.droppedDelta / total;
  return dropRate > DROP_RATE_THRESHOLD && d.packetsLostDelta > 0;
}

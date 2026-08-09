import vadWorkletUrl from './vad-worklet.js?url';

// Единственная точка контакта с VAD-ворклетом (детектор уровня на аудио-потоке). Нужен, чтобы гейт
// «активации голосом» обновлялся и в фоновой вкладке, где requestAnimationFrame заморожен, а прежний
// rAF-анализатор (spLoop) переставал двигать vadOpen → микрофон молча гейтился в тишину. addModule —
// per-AudioContext (воркет-глобалка живёт с контекстом; повторный addModule на том же контексте кинул
// бы "already registered"), дедуп через WeakMap — как в denoise.ts. Любая ошибка (нет AudioWorklet /
// не догрузился модуль) → null; вызывающий обязан фолбэкнуться на rAF-анализатор (голос не должен
// падать из-за детектора речи). Имя процессора 'vad-rms' отлично от RNNoise — коллизии addModule нет.
const moduleLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureVadModule(ctx: AudioContext): Promise<void> {
  let p = moduleLoaded.get(ctx);
  if (!p) { p = ctx.audioWorklet.addModule(vadWorkletUrl); moduleLoaded.set(ctx, p); }
  return p;
}

export async function createVadNode(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  try {
    if (!ctx.audioWorklet) return null;
    await ensureVadModule(ctx);
    // 0 выходов — лист вне тракта публикации: не примешивается к звуку, читает только уровень.
    return new AudioWorkletNode(ctx, 'vad-rms', { numberOfInputs: 1, numberOfOutputs: 0 });
  } catch {
    return null;
  }
}

export function destroyVadNode(node: AudioWorkletNode | null | undefined): void {
  if (!node) return;
  try { node.port.onmessage = null; } catch { /**/ }
  try { node.port.close?.(); } catch { /**/ }
  try { node.disconnect(); } catch { /**/ }
}

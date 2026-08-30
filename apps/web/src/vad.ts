// Единственная точка контакта с VAD-ворклетом (детектор уровня на аудио-потоке). Нужен, чтобы гейт
// «активации голосом» обновлялся и в фоновой вкладке, где requestAnimationFrame заморожен, а прежний
// rAF-анализатор (spLoop) переставал двигать vadOpen → микрофон молча гейтился в тишину. addModule —
// per-AudioContext (воркет-глобалка живёт с контекстом; повторный addModule на том же контексте кинул
// бы "already registered"), дедуп через WeakMap — как в denoise.ts. Любая ошибка (нет AudioWorklet /
// не догрузился модуль) → null; вызывающий обязан фолбэкнуться на rAF-анализатор И на фейл-опен гейта
// (голос не должен падать из-за детектора речи). Имя процессора 'vad-rms' отлично от RNNoise —
// коллизии addModule нет.
//
// Exact content hash is injected by Vite and retained in the owning Service Worker cache. This
// avoids both old-tab 404s and a new host accidentally loading an old cached worklet protocol.
const WORKLET_URL = __VAD_WORKLET_URL__;
const moduleLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureVadModule(ctx: AudioContext): Promise<void> {
  let p = moduleLoaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(WORKLET_URL);
    moduleLoaded.set(ctx, p);
    // Неудачную попытку из кэша убираем: иначе один сетевой сбой на старте навсегда лишал бы
    // этот контекст ворклета, хотя следующий вызов мог бы догрузиться.
    p.catch(() => { if (moduleLoaded.get(ctx) === p) moduleLoaded.delete(ctx); });
  }
  return p;
}

// Возвращает ноду детектора и «якорь» — путь до destination через gain=0. Якорь обязателен: часть
// движков обрабатывает только ноды, достижимые от destination, и лист без выходов у них не пуллится
// (сообщения не приходят → гейт залипает). Тишина в destination не слышна и ничего не примешивает.
export type VadNode = { node: AudioWorkletNode; sink: GainNode };

export async function createVadNode(ctx: AudioContext): Promise<VadNode | null> {
  try {
    if (!ctx.audioWorklet) return null;
    await ensureVadModule(ctx);
    const node = new AudioWorkletNode(ctx, 'vad-rms', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    return { node, sink };
  } catch {
    return null;
  }
}

export function destroyVadNode(vad: VadNode | null | undefined): void {
  if (!vad) return;
  try { vad.node.port.onmessage = null; } catch { /**/ }
  try { vad.node.port.close?.(); } catch { /**/ }
  try { vad.node.disconnect(); } catch { /**/ }
  try { vad.sink.disconnect(); } catch { /**/ }
}

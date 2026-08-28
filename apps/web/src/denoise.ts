import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';

// Стабильные имена вместо `?url` (хешированный ассет). Файлы кладёт плагин rnnoiseStableAssets
// в vite.config.ts — и в dev, и в сборку. Причина та же, что у /vad-worklet.js: догрузка ленивая,
// а деплой меняет хеш, поэтому вкладка, открытая до выкатки, получала 404 и теряла шумодав.
const rnnoiseWorkletPath = '/rnnoise-worklet.js';
const rnnoiseWasmPath = '/rnnoise.wasm';
const rnnoiseSimdWasmPath = '/rnnoise_simd.wasm';

// Единственная точка контакта с RNNoise (изоляция third-party). WASM-бинарь общий на процесс
// (фетчится/подбирает SIMD-вариант один раз); addModule — per-AudioContext, т.к. воркет-глобалка
// живёт с контекстом, а повторный addModule на ТОМ ЖЕ контексте кидает "already registered"
// (дедуп на случай повторного вызова до пересоздания контекста в engine.ts).
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
const moduleLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  let p = moduleLoaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(rnnoiseWorkletPath);
    moduleLoaded.set(ctx, p);
    // Реджекнутый промис — валидное закешированное значение, и следующая попытка мгновенно падала бы
    // в тот же отказ. Одна сетевая осечка иначе выключала шумодав на всю сессию (сутки). Как в vad.ts.
    p.catch(() => { if (moduleLoaded.get(ctx) === p) moduleLoaded.delete(ctx); });
  }
  return p;
}

// RNNoise-нода шумоподавления (48кГц, предполагается сэмплрейт контекста). Любая ошибка (нет
// AudioWorklet, WASM не догрузился и т.п.) — null; вызывающий обязан фолбэкнуться на прямое
// соединение графа. Шумодав — усиление тракта, не обязательное звено: голос не должен падать.
export async function createDenoiseNode(ctx: AudioContext, maxChannels = 1): Promise<RnnoiseWorkletNode | null> {
  try {
    if (!wasmBinaryPromise) {
      const pending = loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
      wasmBinaryPromise = pending;
      // `??=` не перезаписал бы отклонённый промис: блип сети на единственном фетче wasm убивал
      // шумодав до перезапуска приложения. Сбрасываем кэш, чтобы следующий startMic попробовал снова.
      pending.catch(() => { if (wasmBinaryPromise === pending) wasmBinaryPromise = null; });
    }
    const [binary] = await Promise.all([wasmBinaryPromise, ensureWorkletModule(ctx)]);
    return new RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels });
  } catch {
    return null;
  }
}

export function destroyDenoiseNode(node: RnnoiseWorkletNode | null | undefined): void {
  if (!node) return;
  try { node.disconnect(); } catch { /**/ }
  try { node.destroy(); } catch { /**/ }
}

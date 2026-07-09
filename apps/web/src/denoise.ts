import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// Единственная точка контакта с RNNoise (изоляция third-party). WASM-бинарь общий на процесс
// (фетчится/подбирает SIMD-вариант один раз); addModule — per-AudioContext, т.к. воркет-глобалка
// живёт с контекстом, а повторный addModule на ТОМ ЖЕ контексте кидает "already registered"
// (дедуп на случай повторного вызова до пересоздания контекста в engine.ts).
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
const moduleLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  let p = moduleLoaded.get(ctx);
  if (!p) { p = ctx.audioWorklet.addModule(rnnoiseWorkletPath); moduleLoaded.set(ctx, p); }
  return p;
}

// RNNoise-нода шумоподавления (48кГц, предполагается сэмплрейт контекста). Любая ошибка (нет
// AudioWorklet, WASM не догрузился и т.п.) — null; вызывающий обязан фолбэкнуться на прямое
// соединение графа. Шумодав — усиление тракта, не обязательное звено: голос не должен падать.
export async function createDenoiseNode(ctx: AudioContext, maxChannels = 1): Promise<RnnoiseWorkletNode | null> {
  try {
    wasmBinaryPromise ??= loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
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

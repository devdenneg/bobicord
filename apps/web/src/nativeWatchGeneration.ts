const STORAGE_KEY = 'relayNativeWatchGenerationV1';
const GENERATIONS_PER_MILLISECOND = 1024;

let processGeneration = 0;

function storedGeneration(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

/**
 * Monotonic across both async owners and WebView reloads. Rust keeps its generation tombstones for
 * the native process lifetime, so restarting this counter at one after a renderer reload would
 * make otherwise valid starts look stale until the old high-water mark was reached again.
 */
export function nextNativeWatchGeneration(now = Date.now()): number {
  const epochFloor = Math.max(1, Math.floor(Math.max(0, now)) * GENERATIONS_PER_MILLISECOND);
  const next = Math.max(epochFloor, processGeneration + 1, storedGeneration() + 1);
  if (!Number.isSafeInteger(next)) throw new Error('Native watch generation exhausted');
  processGeneration = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, String(next)); } catch { /**/ }
  return next;
}

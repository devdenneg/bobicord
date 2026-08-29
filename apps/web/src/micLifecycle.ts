export const MIC_MUTED_RESTART_MS = 4000;

export interface StorageReader {
  getItem(key: string): string | null;
}

export function readStoredFlag(storage: StorageReader, key: string): boolean {
  try { return storage.getItem(key) === '1'; }
  catch { return false; }
}

export function selectedInputUnavailable(error: unknown): boolean {
  const name = String((error as { name?: unknown } | null)?.name || '');
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

export function mutedTrackNeedsRestart(mutedAt: number, now: number): boolean {
  return mutedAt > 0 && Number.isFinite(now) && now - mutedAt >= MIC_MUTED_RESTART_MS;
}

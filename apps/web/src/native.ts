// IPC bridge to Tauri native shell (apps/native). No-op in browser.
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function pingNative(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('ping');
}

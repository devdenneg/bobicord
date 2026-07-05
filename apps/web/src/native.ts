// IPC bridge to Tauri native shell (apps/native). No-op in browser.
import { getToken } from './api';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function pingNative(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('ping');
}

export interface MonitorInfo { index: number; name: string }

export async function listMonitors(): Promise<MonitorInfo[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<MonitorInfo[]>('list_monitors');
}

/// Тот же ws-адрес дерева, что и `treeVideo.ts` (Evolution-TZ Э2/Э3): базовый
/// URL из VITE_TREE_WS_URL (в native-сборке — реальный сервер, т.к. локальный
/// bundle грузится без reverse-proxy), плюс session-JWT в query.
function treeWsUrl(): string {
  const override = (import.meta as any).env?.VITE_TREE_WS_URL as string | undefined;
  const base = override || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
  const token = getToken() || '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

export async function startNativeBroadcast(streamId: string, identity: string, monitorIndex: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('start_broadcast', { streamId, wsUrl: treeWsUrl(), identity, monitorIndex });
}

export async function stopNativeBroadcast(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('stop_broadcast');
}

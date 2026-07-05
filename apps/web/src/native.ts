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

export interface WindowInfo { hwnd: number; title: string; process: string; pid: number }

export async function listWindows(): Promise<WindowInfo[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<WindowInfo[]>('list_windows');
}

export type CaptureSource = { kind: 'monitor'; index: number } | { kind: 'window'; hwnd: number };

export interface StreamConfig {
  source: CaptureSource;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrateBps: number;
  /** Э5.2: PID процесса для WASAPI INCLUDE (только его звук в стрим) — надёжнее,
   *  чем EXCLUDE себя (см. CLAUDE.md инвариант 6). `undefined` = EXCLUDE-режим по умолчанию. */
  audioTargetPid?: number;
}

export interface BroadcastStats {
  streamId: string;
  source: string;
  width: number;
  height: number;
  targetFps: number;
  captureFps: number;
  encoderFps: number;
  droppedFrames: number;
  bitrateTargetBps: number;
  bitrateActualBps: number;
  children: number;
}

export async function onBroadcastStats(cb: (stats: BroadcastStats) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<BroadcastStats>('relay-broadcast-stats', (e) => cb(e.payload));
  return unlisten;
}

export async function onBroadcastStopped(cb: (streamId: string) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<string>('relay-broadcast-stopped', (e) => cb(e.payload));
  return unlisten;
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

export async function startNativeBroadcast(streamId: string, identity: string, serverId: string, config: StreamConfig): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('start_broadcast', {
    streamId, wsUrl: treeWsUrl(), identity, serverId,
    source: config.source, maxWidth: config.maxWidth, maxHeight: config.maxHeight, fps: config.fps, bitrateBps: config.bitrateBps,
    audioTargetPid: config.audioTargetPid ?? null,
  });
}

export async function stopNativeBroadcast(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('stop_broadcast');
}

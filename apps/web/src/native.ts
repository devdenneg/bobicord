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
  /** Э8: при autoBitrate — потолок ABR; иначе фиксированный битрейт. */
  bitrateBps: number;
  /** Э8 ABR: авто-адаптация битрейта под сеть дерева (по умолчанию вкл). */
  autoBitrate?: boolean;
  /** PID процесса для ручного WASAPI INCLUDE (только его звук в стрим). `undefined` =
   *  авто-режим «всё кроме RelayApp» (INCLUDE-клиент на каждый не-наш процесс + микс,
   *  см. audio.rs / CLAUDE.md инвариант 6). */
  audioTargetPid?: number;
  /** Э8: лимит прямых детей корня в дереве (overflow-зрители уходят глубже через relay). */
  maxDirectChildren?: number;
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

export interface BroadcastStopInfo {
  streamId: string;
  /** `null` — штатный стоп по кнопке; строка — трансляция умерла сама (см. mod.rs). */
  reason: string | null;
}

export async function onBroadcastStopped(cb: (info: BroadcastStopInfo) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<BroadcastStopInfo>('relay-broadcast-stopped', (e) => cb(e.payload));
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
    autoBitrate: config.autoBitrate ?? true,
    audioTargetPid: config.audioTargetPid ?? null,
    maxDirectChildren: config.maxDirectChildren ?? null,
  });
}

export async function stopNativeBroadcast(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('stop_broadcast');
}

/* ---------- Э8: нативный relay-viewer (Rust держит видео, webview рендерит через IPC) ---------- */

/** Стартует нативный relay-watch: Rust джойнится в дерево (viewer, native), ретранслирует
 *  детям и шлёт локальный offer в webview (событие relay-watch-offer). */
export async function startNativeWatch(streamId: string, identity: string, serverId: string, maxChildren: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('start_watch', { streamId, wsUrl: treeWsUrl(), identity, serverId, maxChildren });
}
export async function stopNativeWatch(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('stop_watch');
}
/** Ответ webview на локальный offer relay-показа. */
export async function nativeWatchAnswer(sdp: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('watch_answer', { sdp });
}
export async function nativeWatchIce(candidate: any): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('watch_ice', { candidate });
}
/** Ручной выбор пира (target) или авто-миграция (null). */
export async function nativeWatchReparent(target: string | null): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('watch_reparent', { target });
}

export async function onNativeWatchOffer(cb: (streamId: string, sdp: string) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ streamId: string; sdp: string }>('relay-watch-offer', (e) => cb(e.payload.streamId, e.payload.sdp));
  return un;
}
export async function onNativeWatchIce(cb: (streamId: string, candidate: any) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ streamId: string; candidate: any }>('relay-watch-ice', (e) => cb(e.payload.streamId, e.payload.candidate));
  return un;
}
export async function onNativeTopology(cb: (payload: any) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<any>('relay-topology', (e) => cb(e.payload));
  return un;
}

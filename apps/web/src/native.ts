// IPC bridge to Tauri native shell (apps/native). No-op in browser.
import { getToken } from './api';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function pingNative(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('ping');
}

export interface GameInfo { name: string; icon: string | null }
// Детект игры на переднем плане (Discord-style «играет в X»). null в браузере / если не игра.
export async function detectGame(): Promise<GameInfo | null> {
  if (!isTauri) return null;
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<GameInfo | null>('detect_game'); }
  catch { return null; }
}
// Передаёт в Rust аллоулист игр Discord (веб фетчит /api/detectable-games) — главный сигнал детекта.
export async function setDetectableGames(games: { name: string; exes: string[] }[]): Promise<void> {
  if (!isTauri) return;
  try { const { invoke } = await import('@tauri-apps/api/core'); await invoke('set_detectable_games', { games }); }
  catch { /**/ }
}

export interface MonitorInfo { index: number; name: string }

export async function listMonitors(): Promise<MonitorInfo[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<MonitorInfo[]>('list_monitors');
}

/** `icon` — PNG 32×32 в base64 (без data-URI-префикса) или null, если не извлеклась. */
export interface WindowInfo { hwnd: number; title: string; process: string; pid: number; icon: string | null }

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
  /** Д5: режим пресета ('smooth'|'quality'|'manual'). Пресеты гасят клиентскую QualityLadder. */
  presetMode?: 'smooth' | 'quality' | 'manual';
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
  // В нативе location.host = tauri://localhost (нет reverse-proxy) — тот же дефолт на
  // прод-сервер, что и API_BASE в api.ts (см. там). Явный VITE_TREE_WS_URL переопределяет.
  const nativeDefault = isTauri ? 'wss://reelay.online/tree' : null;
  const base = override || nativeDefault || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
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
    presetMode: config.presetMode ?? 'manual',
  });
}

/** Э5.3: смена источника (и звука) на лету — без остановки трансляции, дерево зрителей
 *  и WebRTC-треки живут дальше. `audioTargetPid` undefined = WASAPI EXCLUDE-режим. */
export async function setNativeBroadcastSource(source: CaptureSource, audioTargetPid?: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_broadcast_source', { source, audioTargetPid: audioTargetPid ?? null });
}

export async function stopNativeBroadcast(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('stop_broadcast');
}

/* ---------- Э8: нативный relay-viewer (Rust держит видео, webview рендерит через IPC) ---------- */

/** Стартует нативный relay-watch: Rust джойнится в дерево (viewer, native), ретранслирует
 *  детям и шлёт локальный offer в webview (событие relay-watch-offer). */
export async function startNativeWatch(streamId: string, identity: string, serverId: string, maxChildren: number, quality: string = 'source', pinned: boolean = false, availableOutgoing: number = 0): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  // Roadmap-flow-стриминга Д6: реальный upload зрителя (из Д5-probe-кэша) — сервер по нему
  // решает ёмкость (ветвление 1→2). 0 = не измерен, сервер даёт консервативную ёмкость 1.
  await invoke('start_watch', { streamId, wsUrl: treeWsUrl(), identity, serverId, maxChildren, quality, pinned, availableOutgoing });
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
/** Rust-relay сам определил конец стрима (сирота без родителя >20с, см. relay.rs) —
 *  webview должен снести watch (nativeUnwatch), иначе повисший кадр. Страховка на случай,
 *  когда discovery-сокет webview пропустил stream-end. */
export async function onNativeWatchEnded(cb: (streamId: string) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ streamId: string }>('relay-watch-ended', (e) => cb(e.payload.streamId));
  return un;
}

/* ---------- диагностика: лог сессии из Rust (diag.rs) ---------- */

/** Забирает и очищает кольцевой буфер лога текущей сессии (включая строки webrtc-rs:
 *  ICE/TURN-ошибки). Пусто в браузере. HTTP-отправку делает веб-сторона — там уже есть
 *  session-JWT. */
export async function diagTakeLog(): Promise<string[]> {
  if (!isTauri) return [];
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<string[]>('diag_take_log'); }
  catch { return []; }
}

/* ---------- глобальные хоткеи мута (низкоуровневый WH_KEYBOARD_LL хук, только Windows) ---------- */

import type { Keybinds } from './types';

/** Синхронизирует хук с текущими биндами. `enabled=false` (чекбокс «отключить вне приложения») —
 *  хук снимает все комбинации, дальше хоткеи работают только через in-app-слушатель (App.tsx). No-op в браузере. */
export async function setGlobalHotkeys(binds: Keybinds, enabled: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_global_hotkeys', { muteMic: binds.muteMic, deafen: binds.deafen, enabled });
}

/** Событие от хука: комбинация зажата целиком (вне зависимости от фокуса окна). No-op в браузере. */
export async function onGlobalHotkey(cb: (action: 'muteMic' | 'deafen') => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ action: 'muteMic' | 'deafen' }>('global-hotkey', (e) => cb(e.payload.action));
  return un;
}

/* ---------- сохранение файла-вложения (нативный Save As, см. плагины dialog/fs) ---------- */

/** Системный диалог «Сохранить как» + запись байт на диск. `null` — юзер отменил диалог
 *  (не ошибка, тихо пропускаем) или мы не в нативе (вызывающий код фолбэчится на
 *  браузерное скачивание через blob-ссылку). */
export async function saveFileDialog(bytes: Uint8Array, defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ defaultPath: defaultName });
  if (!path) return null;
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, bytes);
  return path;
}

/* ---------- журнал "Загрузки" (натив): открыть/показать в папке/проверить наличие ---------- */

/** Открывает файл в ассоциированной программе (Rust ShellExecuteW). No-op в браузере. */
export async function openFile(path: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_file', { path });
}

/** Открывает проводник с выделенным файлом (explorer /select). No-op в браузере. */
export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('reveal_in_folder', { path });
}

/** Батч-проверка наличия файлов на диске (по индексам, как paths). [] в браузере. */
export async function pathsExist(paths: string[]): Promise<boolean[]> {
  if (!isTauri || !paths.length) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean[]>('paths_exist', { paths });
}

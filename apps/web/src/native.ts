// IPC bridge to Tauri native shell (apps/native). No-op in browser.
import { normalizeExternalHttpUrl } from './linkify';
import { BoundedKeyedOperations } from './boundedAsync';
import { freshTreeWsUrl } from './treeAuth';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const NATIVE_TREE_AUTH_TERMINAL = 'TREE_AUTH_TERMINAL';
const NATIVE_TREE_AUTH_TRANSIENT = 'TREE_AUTH_TRANSIENT';

class NativeTreeStartError extends Error {
  constructor(readonly terminal: boolean) {
    super(terminal
      ? 'Сессия завершена — войдите снова'
      : 'Не удалось обновить доступ к трансляции');
    this.name = 'NativeTreeStartError';
  }
}

function normalizeNativeTreeStartError(error: unknown): never {
  const code = typeof error === 'string'
    ? error
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message : '');
  if (code === NATIVE_TREE_AUTH_TERMINAL) throw new NativeTreeStartError(true);
  if (code === NATIVE_TREE_AUTH_TRANSIENT) throw new NativeTreeStartError(false);
  throw error;
}

export function isTerminalNativeTreeStartError(error: unknown): boolean {
  return error instanceof NativeTreeStartError && error.terminal;
}

export async function pingNative(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('ping');
}

/** Opens an HTTP(S) URL in the user's default browser, never inside the app webview. */
export async function openExternalUrl(url: string): Promise<void> {
  const safeUrl = normalizeExternalHttpUrl(url);
  if (!safeUrl) throw new Error('Unsupported external URL');
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url: safeUrl });
    return;
  }
  const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error('External URL was blocked');
  opened.opener = null;
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
// Фуллскрин-приложение (игра) на переднем плане? Окно-карточка уведомления свернуло бы exclusive-fullscreen
// игру → notify это чекает и не создаёт окно (звук всё равно играет). false в браузере / при ошибке.
export async function foregroundFullscreen(): Promise<boolean> {
  if (!isTauri) return false;
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<boolean>('foreground_fullscreen'); }
  catch { return false; }
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
  /** CPU-latch: fps поджат до 30 из-за перегруза захвата (бейдж «(CPU)» в статах). */
  cpuCapped: boolean;
  /** Загрузка CPU всей системы, 0..100 (null на первом тике). Захват вытесняет игра —
   *  «наш процесс на 12%» ничего не значит, пока не видно машину целиком. */
  cpuSystemPercent: number | null;
  /** Максимум за окно, байты: любой кадр и отдельно keyframe. Размер IDR = размер бёрста
   *  (1080p на 4.5 Мбит ≈ 200-300 КБ, ~170 пакетов залпом), в среднем битрейте не виден. */
  frameBytesMax: number;
  keyBytesMax: number;
}

/** Профиль машины (hwinfo.rs). Пусто в браузере — там свой env-блок в diag.ts. */
export interface NativeHwInfo {
  cpu: string;
  cores: number;
  ramMb: number;
  gpus: string[];
  os: string;
  appVersion: string;
}

/** Снимок железа для диага. Кэшируется в Rust, звать можно свободно. */
export async function diagHwInfo(): Promise<NativeHwInfo | null> {
  if (!isTauri) return null;
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<NativeHwInfo>('diag_hw'); }
  catch { return null; }
}

export async function onBroadcastStats(cb: (stats: BroadcastStats) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<BroadcastStats>('relay-broadcast-stats', (e) => cb(e.payload));
  return unlisten;
}

/** Превью-тумбнейл кадра вещателя (виджет). `png` — base64 без data-URI-префикса. */
export interface BroadcastPreview { streamId: string; w: number; h: number; png: string }

export async function onBroadcastPreview(cb: (p: BroadcastPreview) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<BroadcastPreview>('relay-broadcast-preview', (e) => cb(e.payload));
  return unlisten;
}

/** Интервал эмита превью-тумбнейла (мс, 0 = выкл). Виджет: 3000 (развёрнут), 1000 (hover),
 *  0 (свёрнут/размонтирован). No-op в браузере / если не вещаем. */
export async function setPreviewInterval(ms: number): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_preview_interval', { ms });
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

export async function startNativeBroadcast(streamId: string, identity: string, serverId: string, config: StreamConfig): Promise<void> {
  // Access JWTs live for 15 minutes. Refresh before handing the initial URL to Rust; Rust owns
  // secure refreshes for every later signalling reconnect (see native_tree_ws_url in lib.rs).
  const wsUrl = await freshTreeWsUrl();
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('start_broadcast', {
      streamId, wsUrl, identity, serverId,
      source: config.source, maxWidth: config.maxWidth, maxHeight: config.maxHeight, fps: config.fps, bitrateBps: config.bitrateBps,
      autoBitrate: config.autoBitrate ?? true,
      audioTargetPid: config.audioTargetPid ?? null,
      maxDirectChildren: config.maxDirectChildren ?? null,
      presetMode: config.presetMode ?? 'manual',
    });
  } catch (error) { normalizeNativeTreeStartError(error); }
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

// Logout/stale-start cleanup must not hang page teardown, and repeated owners must not stack native
// stop invokes behind the same stuck Rust command. Capacity is released only when the physical IPC
// really settles; logical callers are released after the deadline.
let nativeBroadcastStopFlight: { actual: Promise<void>; bounded: Promise<void> } | null = null;
export function stopNativeBroadcastBounded(timeoutMs = 2_000): Promise<void> {
  if (!isTauri) return Promise.resolve();
  if (nativeBroadcastStopFlight) return nativeBroadcastStopFlight.bounded;
  const actual = Promise.resolve().then(stopNativeBroadcast);
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let settled = false;
  const bounded = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      resolve();
    };
    timer = globalThis.setTimeout(finish, timeoutMs);
    actual.then(finish, finish);
  });
  const flight = { actual, bounded };
  nativeBroadcastStopFlight = flight;
  void actual.then(
    () => { if (nativeBroadcastStopFlight === flight) nativeBroadcastStopFlight = null; },
    () => { if (nativeBroadcastStopFlight === flight) nativeBroadcastStopFlight = null; },
  );
  return bounded;
}

/* ---------- Э8: нативный relay-viewer (Rust держит видео, webview рендерит через IPC) ---------- */

/** Стартует нативный relay-watch: Rust джойнится в дерево (viewer, native), ретранслирует
 *  детям и шлёт локальный offer в webview (событие relay-watch-offer). */
export async function startNativeWatch(streamId: string, generation: number, identity: string, serverId: string, maxChildren: number, quality: string = 'source', pinned: boolean = false, availableOutgoing: number = 0): Promise<void> {
  const wsUrl = await freshTreeWsUrl();
  const { invoke } = await import('@tauri-apps/api/core');
  // Roadmap-flow-стриминга Д6: реальный upload зрителя (из Д5-probe-кэша) — сервер по нему
  // решает ёмкость (ветвление 1→2). 0 = не измерен, сервер даёт консервативную ёмкость 1.
  try {
    await invoke('start_watch', { streamId, generation, wsUrl, identity, serverId, maxChildren, quality, pinned, availableOutgoing });
  } catch (error) { normalizeNativeTreeStartError(error); }
}
export async function stopNativeWatch(streamId: string, generation: number): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('stop_watch', { streamId, generation });
}
/** Ответ webview на локальный offer relay-показа. streamId — какой слот грида (Rust держит HashMap). */
export async function nativeWatchAnswer(streamId: string, generation: number, sdp: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('watch_answer', { streamId, generation, sdp });
}
export async function nativeWatchIce(streamId: string, generation: number, candidate: any): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('watch_ice', { streamId, generation, candidate });
}
/** Ручной выбор пира (target) или авто-миграция (null). */
export async function nativeWatchReparent(streamId: string, generation: number, target: string | null): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('watch_reparent', { streamId, generation, target });
}

export async function onNativeWatchOffer(cb: (streamId: string, generation: number, sdp: string) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ streamId: string; generation: number; sdp: string }>('relay-watch-offer', (e) => cb(e.payload.streamId, e.payload.generation, e.payload.sdp));
  return un;
}
export async function onNativeWatchIce(cb: (streamId: string, generation: number, candidate: any) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ streamId: string; generation: number; candidate: any }>('relay-watch-ice', (e) => cb(e.payload.streamId, e.payload.generation, e.payload.candidate));
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
export async function onNativeWatchEnded(cb: (streamId: string, generation: number) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ streamId: string; generation: number }>('relay-watch-ended', (e) => cb(e.payload.streamId, e.payload.generation));
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
const pathExistChecks = new BoundedKeyedOperations<boolean[]>({ timeoutMs: 4_000, maxInFlight: 3 });
export async function pathsExist(paths: string[]): Promise<boolean[]> {
  if (!isTauri || !paths.length) return [];
  const key = JSON.stringify(paths);
  return pathExistChecks.run(key, async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean[]>('paths_exist', { paths });
  });
}

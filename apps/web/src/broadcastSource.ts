// Общая конфиг-схема источника трансляции (натив, Tauri). Вынесена из BroadcastModal,
// чтобы виджет вещателя (StreamerWidget) переиспользовал buildSource/deriveAudioPid/
// loadConfig без дублирования схемы SavedConfig.
import type { CaptureSource, WindowInfo } from './native';
import { PRESETS } from './presets';

// Дискорд-стиль: маленький выбор качества, битрейт ВСЕГДА авто (сервер-ABR адаптирует под сеть,
// слабых зрителей жмут серверные рендишны). Ручной битрейт-слайдер убран — им легко убить стрим
// (наблюдалось: 10 Мбит на 1080p60 → фризы у всех). 'auto' подбирает пресет по замеру аплинка.
// 30fps-пресеты добавлены после диага 2026-07-10: CPU-путь захвата на 60fps (бюджет кадра
// 16.7мс) не успевал у части вещателей (cb до 72мс) — фризы у всех зрителей.
export const FIXED_LABELS = ['1440p60', '1440p30', '1080p60', '720p60', '1080p30', '720p30'] as const;
export type FixedQuality = (typeof FIXED_LABELS)[number];
export type StreamQuality = 'auto' | FixedQuality;
// Фикс-пресеты (потолок; autoBitrate снижает под сеть) — значения из PRESETS, не дублируем.
export const QUALITY_FIXED = Object.fromEntries(FIXED_LABELS.map((l) => {
  const p = PRESETS.find((x) => x.label === l)!;
  return [l, { w: p.width, h: p.height, fps: p.fps, bitrateKbps: p.bitrateKbps, label: p.label }];
})) as Record<FixedQuality, { w: number; h: number; fps: 30 | 60; bitrateKbps: number; label: string }>;

export interface SavedConfig {
  sourceKind: 'monitor' | 'window';
  monitorIndex: number;
  windowHwnd: number | null;
  /** Дискорд-стиль выбор качества. 'auto' — пресет по замеру аплинка; фикс — потолок под auto-битрейт. */
  quality: StreamQuality;
  /** auto — звук следует за источником: окно → его процесс (INCLUDE, надёжно против
   *  эха голоса войса), монитор → всё кроме RelayApp (EXCLUDE себя). Ничего выбирать руками.
   *  exclude/include — ручной override под «Дополнительно» (см. CLAUDE.md инвариант 6, audio.rs). */
  audioMode: 'auto' | 'exclude' | 'include';
  audioPid: number | null;
  /** Э8: лимит прямых зрителей корня; остальные уходят глубже через relay-узлы. */
  maxDirectChildren: number;
  /** Д8: opt-in прямых подключений к стримеру. Выкл (дефолт) — server-first: единственный
   *  слот корня отдан vrelay (maxChildren=1). Вкл — maxChildren = 1 (vrelay) + maxDirectChildren. */
  allowDirectPeers: boolean;
}
// audioMode дефолтом 'auto': звук выбирается сам по источнику (окно → PID окна, монитор →
// EXCLUDE себя), пользователю не нужно вручную указывать процесс. Ручной выбор остаётся
// под «Дополнительно» на случай, когда нужен звук строго одного приложения.
export const DEF_CONFIG: SavedConfig = { sourceKind: 'monitor', monitorIndex: 0, windowHwnd: null, quality: 'auto', audioMode: 'auto', audioPid: null, maxDirectChildren: 2, allowDirectPeers: false };
export const DIRECT_MIN = 1, DIRECT_MAX = 10;

export function loadConfig(): SavedConfig {
  try {
    const raw = JSON.parse(localStorage.getItem('bcastConfig') || '{}');
    const c: SavedConfig = { ...DEF_CONFIG, ...raw };
    // Миграция со старой схемы (presetMode/resolution/fps/bitrate/autoBitrate) — всё это заменено
    // одним `quality`. Старый конфиг → 'auto' (как у нового юзера), если валидного quality нет.
    if (c.quality !== 'auto' && !FIXED_LABELS.includes(c.quality as FixedQuality)) c.quality = 'auto';
    c.maxDirectChildren = Math.min(DIRECT_MAX, Math.max(DIRECT_MIN, Math.round(c.maxDirectChildren)));
    c.allowDirectPeers = !!c.allowDirectPeers;
    return c;
  } catch { return DEF_CONFIG; }
}
export function saveConfig(c: SavedConfig) { localStorage.setItem('bcastConfig', JSON.stringify(c)); }

// Источник видео из текущего конфига (окно, если выбрано валидное; иначе монитор).
export function buildSource(cfg: SavedConfig): CaptureSource {
  return cfg.sourceKind === 'window' && cfg.windowHwnd != null
    ? { kind: 'window', hwnd: cfg.windowHwnd }
    : { kind: 'monitor', index: cfg.monitorIndex };
}

// PID для WASAPI INCLUDE, либо undefined = EXCLUDE-режим. auto: окно → PID окна,
// монитор → EXCLUDE себя. Ручные режимы — как выбрано.
export function deriveAudioPid(cfg: SavedConfig, windows: WindowInfo[]): number | undefined {
  if (cfg.audioMode === 'include') return cfg.audioPid ?? undefined;
  if (cfg.audioMode === 'exclude') return undefined;
  // auto:
  if (cfg.sourceKind === 'window' && cfg.windowHwnd != null)
    return windows.find((x) => x.hwnd === cfg.windowHwnd)?.pid;
  return undefined; // монитор в auto = EXCLUDE себя
}

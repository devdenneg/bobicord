// Roadmap-flow-стриминга Д5: таблица пресетов вещателя (H.264/CBR) — ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ.
// ⚠ ДУБЛИРУЕТСЯ в apps/server/tree.js (PRESET_TABLE) для валидации битрейтов рендишнов.
// При ЛЮБОМ изменении значений синхронизируй ОБЕ копии.
//
// Дефолтный flow вещателя: замер upload (probe) → полезный битрейт = 0.75×BWE → развилка
// «Плавность»/«Качество» → pickPreset подбирает самый высокий влезающий пресет.

export type PresetFps = 30 | 60;
export type PresetMode = 'smooth' | 'quality';

export interface Preset {
  width: number;
  height: number;
  fps: PresetFps;
  /** Целевой CBR-битрейт в кбит/с. */
  bitrateKbps: number;
  label: string;
}

// Порядок = убывание «стоимости» (сверху — самый требовательный). Значения совпадают с
// RENDITION_BITRATE в tree.js для 30fps-рунгов (рендишны = 30fps-пресеты той же высоты).
//
// Нижние 60fps-ступени (480p60/360p60) обязательны: без них самый дешёвый 60fps — 720p60
// (4500 кбит/с), и на тонком канале режим «Плавность» физически не мог дать 60 fps —
// молча падал на 30fps-лестницу и совпадал с «Качеством» (наблюдалось живьём при
// useful=4000: оба режима давали 720p30). 60 fps стоит ~1.6× от 30 fps той же высоты.
export const PRESETS: Preset[] = [
  { width: 2560, height: 1440, fps: 60, bitrateKbps: 11000, label: '1440p60' },
  { width: 2560, height: 1440, fps: 30, bitrateKbps: 8000,  label: '1440p30' },
  { width: 1920, height: 1080, fps: 60, bitrateKbps: 6000, label: '1080p60' },
  { width: 1280, height: 720,  fps: 60, bitrateKbps: 4500, label: '720p60' },
  { width: 1920, height: 1080, fps: 30, bitrateKbps: 4500, label: '1080p30' },
  { width: 1280, height: 720,  fps: 30, bitrateKbps: 3000, label: '720p30' },
  { width: 854,  height: 480,  fps: 60, bitrateKbps: 2500, label: '480p60' },
  { width: 854,  height: 480,  fps: 30, bitrateKbps: 1500, label: '480p30' },
  { width: 640,  height: 360,  fps: 60, bitrateKbps: 1200, label: '360p60' },
  { width: 640,  height: 360,  fps: 30, bitrateKbps: 800,  label: '360p30' },
];

/** Самый нижний пресет — флор, если ни один не влезает в полосу. */
const FLOOR = PRESETS[PRESETS.length - 1];

// Метка пресета («1440p»/«1080p»/…) задаёт ВЫСОТУ; ширина следует аспекту источника.
// Ширина в PRESETS — 16:9-компаньон (для битрейт-бюджета), но как ЖЁСТКИЙ кап ширины
// в scaled_dims (натив) она резала ultrawide по вертикали: 21:9 3440×1440, вписанный
// в 2560×1440, упирался шириной 2560 → 2560×1070, ниже родной высоты 1440. Кап ширины,
// переданный нативу, держим по самому широкому потребительскому аспекту (32:9) — тогда на
// любом мониторе ≤32:9 связывающим пределом становится ВЫСОТА (21:9 → 3440×1440), а
// scaled_dims всё равно не апскейлит (16:9 → 2560×1440 без изменений).
export const MAX_STREAM_ASPECT = 32 / 9;
export function widthCapForHeight(height: number): number {
  return Math.round((height * MAX_STREAM_ASPECT) / 2) * 2;
}

/**
 * Подбор пресета под доступную полосу и режим.
 *  - `smooth` предпочитает 60 fps (роняет разрешение): среди 60fps-пресетов, влезающих в
 *    `usefulKbps` и не выше source-разрешения, берёт самый высокий; если 60fps не влезает —
 *    падает на 30fps-лестницу.
 *  - `quality` предпочитает разрешение (роняет fps до 30): только 30fps-пресеты, самый
 *    высокий влезающий.
 * `sourceHeight` (опц.) — высота источника: пресеты выше не предлагаем (без апскейла).
 * Ничего не влезло по полосе → нижний пресет с учётом source-разрешения (флор).
 */
export function pickPreset(usefulKbps: number, mode: PresetMode, sourceHeight?: number): Preset {
  const fitsSource = (p: Preset) => !sourceHeight || p.height <= sourceHeight;
  const fitsBw = (p: Preset) => p.bitrateKbps <= usefulKbps;
  // Кандидаты нужного fps, влезающие и по полосе, и по source-разрешению; сортировка —
  // самый высокий (по высоте, затем битрейту) первым.
  const at = (fps: PresetFps) => PRESETS
    .filter((p) => p.fps === fps && fitsSource(p) && fitsBw(p))
    .sort((a, b) => b.height - a.height || b.bitrateKbps - a.bitrateKbps);

  if (mode === 'smooth') {
    const p60 = at(60);
    if (p60.length) return p60[0];
    const p30 = at(30);
    if (p30.length) return p30[0];
  } else {
    const p30 = at(30);
    if (p30.length) return p30[0];
  }
  // Ничего не влезло по полосе — самый дешёвый пресет, не выше source-разрешения.
  const floorPool = PRESETS.filter(fitsSource).sort((a, b) => a.bitrateKbps - b.bitrateKbps);
  return floorPool[0] || FLOOR;
}

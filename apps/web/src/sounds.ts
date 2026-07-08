// Звуки приложения. Играем через Web Audio с РАНТАЙМ-НОРМАЛИЗАЦИЕЙ громкости: декодируем буфер,
// меряем RMS и подгоняем усиление под общий референс — так все звуки звучат ОДИНАКОВО громко,
// независимо от исходной громкости файла (без внешних тулов вроде ffmpeg). Пользовательская
// громкость («Громкость уведомлений») умножается сверху.
import { getSettings } from './settings';

const FILES = {
  entry: '/entry.wav',        // зашёл в голосовой (слышат все в канале + сам зашедший)
  exit: '/exit.wav',          // вышел из голосового (слышат все в канале + сам вышедший)
  mute: '/mute.wav',          // выключил микрофон (только сам)
  unmute: '/unmute.wav',      // включил микрофон (только сам)
  fullMute: '/fullMute.wav',  // оглох — кнопка наушников (только сам); повторное = unmute
  streamOn: '/streamOn.wav',  // кто-то (вкл. себя) включил трансляцию (слышат все на сервере)
  streamOff: '/streamOff.wav',// кто-то (вкл. себя) выключил трансляцию (слышат все на сервере)
  tag: '/tag.wav',            // тебя тегнули/реплайнули (@ник, @all, ответ) — уведомление (C-пентатоника, music-box)
  system: '/system.wav',      // старый звук уведомления (апдейт приложения / превью громкости) — оставлен как был
} as const;

export type SoundName = keyof typeof FILES;

// Референс громкости: к нему подтягивается RMS каждого звука. Подобран так, чтобы типовой звук
// не клиппился при усилении userVolume=1.
const TARGET_RMS = 0.14;
const MAX_GAIN = 6; // потолок усиления тихого файла (чтобы шум/тишина не «взрывались»)

let actx: AudioContext | null = null;
const buffers: Partial<Record<SoundName, AudioBuffer>> = {};
const norm: Partial<Record<SoundName, number>> = {}; // нормировочный множитель громкости на звук
const loading: Partial<Record<SoundName, Promise<void>>> = {};

function ctx(): AudioContext {
  if (!actx) actx = new AudioContext();
  return actx;
}

async function load(name: SoundName): Promise<void> {
  if (buffers[name]) return;
  if (loading[name]) return loading[name];
  const p = (async () => {
    const resp = await fetch(FILES[name]);
    const arr = await resp.arrayBuffer();
    const buf = await ctx().decodeAudioData(arr);
    buffers[name] = buf;
    // RMS по всем каналам → множитель, приводящий звук к TARGET_RMS (клампим, чтобы тихий не взорвался)
    let sum = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) { sum += data[i] * data[i]; }
      n += data.length;
    }
    const rms = Math.sqrt(sum / Math.max(1, n));
    norm[name] = rms > 0.0005 ? Math.min(MAX_GAIN, TARGET_RMS / rms) : 1;
  })();
  loading[name] = p;
  try { await p; } finally { delete loading[name]; }
}

// Прогреть все звуки (fetch+decode) заранее — первый проигрыш без задержки. Вызывать после логина.
export function preloadSounds(): void {
  (Object.keys(FILES) as SoundName[]).forEach((n) => { load(n).catch(() => {}); });
}

export function playSound(name: SoundName): void {
  try {
    const vol = Math.max(0, Math.min(1, (getSettings().notifyVolume ?? 60) / 100));
    if (vol <= 0) return;
    const buf = buffers[name];
    if (!buf) { load(name).then(() => playSound(name)).catch(() => {}); return; } // ленивая загрузка, затем играем
    const c = ctx();
    c.resume?.().catch(() => {}); // контекст мог родиться suspended (без жеста) — будим
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = vol * (norm[name] ?? 1);
    src.connect(g); g.connect(c.destination);
    src.start();
  } catch { /* ignore */ }
}

// Звуки приложения. Играем через Web Audio с РАНТАЙМ-НОРМАЛИЗАЦИЕЙ громкости: декодируем буфер,
// меряем RMS и подгоняем усиление под общий референс — так все звуки звучат ОДИНАКОВО громко,
// независимо от исходной громкости файла (без внешних тулов вроде ffmpeg). Пользовательская
// громкость («Громкость уведомлений») умножается сверху.
import { getSettings, subscribeSettings } from './settings';
import {
  AudioUnlockGestureDeduper,
  acquireExactAudioContextResume,
  forgetExactAudioContextResume,
} from './micLifecycle';
import { routeAudioSinkTarget, seedAudioSinkTargetRoute } from './streamPlayback';

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
const SOUND_FETCH_TIMEOUT_MS = 8_000;
const SOUND_DECODE_TIMEOUT_MS = 5_000;

let actx: AudioContext | null = null;
let lastSink: string | null = null; // последний применённый deviceId вывода (антиспам setSinkId)
let sinkGeneration = 0;
let sinkSwitch: Promise<void> = Promise.resolve();
let sinkRefreshPending = false;
const buffers: Partial<Record<SoundName, AudioBuffer>> = {};
const norm: Partial<Record<SoundName, number>> = {}; // нормировочный множитель громкости на звук
const loading: Partial<Record<SoundName, Promise<void>>> = {};
let pendingResumeSound: { name: SoundName; vol: number; at: number } | null = null;
let soundResumeObserver: { context: AudioContext; outcome: Promise<boolean> } | null = null;

// Разрешение «по умолчанию» ('') в конкретный deviceId по groupId — как engine.normalizedContextSink:
// сырой setSinkId('default'/'') на этом проекте вёл себя ненадёжно (для голоса ради этого и заведён
// normalizedContextSink), поэтому default резолвим в реальное устройство. Конкретный id — как есть.
async function resolveSink(want: string): Promise<string> {
  if (want && want !== 'default') return want;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const def = devices.find((d) => d.deviceId === 'default');
    return devices.find((d) => d.deviceId !== 'default' && !!def?.groupId && d.groupId === def.groupId)?.deviceId || '';
  } catch { return ''; }
}

// Звуки должны идти в ТО ЖЕ устройство вывода, что и голос (иначе «иногда не слышно вход/выход» —
// звук уходил в системный дефолт мимо выбранных наушников). AudioContext.setSinkId есть только на
// десктоп-Chromium; на мобилках/Firefox его нет — там вывод и так выбирает система (no-op).
async function applySink(force = false): Promise<void> {
  const a = actx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (!a || typeof a.setSinkId !== 'function') return;
  const want = getSettings().output || '';
  if (!force && want === lastSink) return;
  lastSink = want;
  const generation = ++sinkGeneration;
  const run = sinkSwitch.catch(() => {}).then(async () => {
    if (generation !== sinkGeneration || actx !== a) return;
    const outcome = await routeAudioSinkTarget(a, want || 'default', { normalize: resolveSink, force });
    if (generation !== sinkGeneration || actx !== a
      || outcome === 'applied' || outcome === 'unsupported' || outcome === 'superseded') return;
    lastSink = null;
    // A rejected or never-settled hardware promise cannot poison every later notification sound.
    // The shared router also repairs this system fallback if the stale browser promise succeeds late.
    await routeAudioSinkTarget(a, 'default', { normalize: resolveSink });
  });
  sinkSwitch = run.catch(() => {});
  await run;
}

function flushPendingResumeSound(): void {
  const pending = pendingResumeSound;
  if (!pending || !actx || actx.state !== 'running') return;
  pendingResumeSound = null;
  if (Date.now() - pending.at < SOUND_STALE_MS) emitSound(pending.name, pending.vol);
}

function observeSoundContextResume(context: AudioContext | null, explicitGesture = false): void {
  const attempt = acquireExactAudioContextResume(context, explicitGesture, flushPendingResumeSound);
  if (!context || !attempt) return;
  if (soundResumeObserver?.context === context && soundResumeObserver.outcome === attempt.outcome) return;
  const observer = { context, outcome: attempt.outcome };
  soundResumeObserver = observer;
  // Keep only one continuation for the currently useful lane. A hung ordinary resume may be
  // superseded by one bounded gesture lane without retaining one callback per notification.
  void attempt.outcome.then((ok) => {
    if (soundResumeObserver !== observer || actx !== context) return;
    soundResumeObserver = null;
    if (ok) flushPendingResumeSound();
  });
}

const soundUnlockGestures = new AudioUnlockGestureDeduper();
function wake(): void { observeSoundContextResume(actx); }
function wakeAndRefreshOutput(): void {
  if (document.hidden) return;
  if (sinkRefreshPending) {
    sinkRefreshPending = false;
    lastSink = null;
    void applySink(true);
  }
  wake();
}
function wakeFromGesture(event: Event): void {
  if (soundUnlockGestures.accept(event)) observeSoundContextResume(actx, true);
}

function ctx(): AudioContext {
  if (!actx || actx.state === 'closed') {
    forgetExactAudioContextResume(actx);
    actx = new AudioContext();
    seedAudioSinkTargetRoute(actx);
    lastSink = null; applySink();
  }
  observeSoundContextResume(actx);
  // A transient Bluetooth/setSinkId failure falls back to system output and clears lastSink.
  // The very next real sound is a natural bounded retry point even if settings/devicechange never fires.
  if ((getSettings().output || '') !== lastSink) void applySink();
  return actx;
}

// Контекст звуков (как micActx/outputCtx в engine) держим ЖИВЫМ. Родившийся 'suspended' до жеста —
// либо уснувший — глушит ВСЕ звуки (вход/выход, мут, уведомления) молча, без ошибки. Резюмим на первом
// жесте и при возврате на вкладку; звуки нужны и в фоне (слышно вход/выход, пока сидишь в другой
// вкладке) — running-контекст в фоне не усыпляется, пока страница «живая» (WebRTC-звонок её держит).
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', wakeAndRefreshOutput);
  // iOS может вернуть PWA из back-forward cache без нового visibilitychange.
  window.addEventListener('pageshow', wakeAndRefreshOutput);
  (['pointerdown', 'keydown', 'touchstart', 'click'] as const)
    .forEach((ev) => window.addEventListener(ev, wakeFromGesture, { passive: true }));
  subscribeSettings(applySink); // вывод звуков следует за выбранным устройством вывода
  // Переподключение наушников меняет РЕАЛЬНОЕ устройство за тем же '' (системное по умолчанию):
  // resolveSink отдаст уже другой deviceId, но applySink без этого хука не позвался бы — звуки
  // остались бы в прежнем (отключённом) устройстве, и «вход/выход» переставало быть слышно.
  try {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (document.hidden) {
        sinkRefreshPending = true;
        return;
      }
      lastSink = null;
      void applySink(true);
    });
  } catch { /** устройство вывода выберет система */ }
}

function boundedSoundOperation<T>(promise: PromiseLike<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch { /**/ }
      reject(new Error('sound operation timed out'));
    }, timeoutMs);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(error);
    });
  });
}

async function load(name: SoundName): Promise<void> {
  if (buffers[name]) return;
  if (loading[name]) return loading[name];
  const p = (async () => {
    const controller = new AbortController();
    const arr = await boundedSoundOperation((async () => {
      const resp = await fetch(FILES[name], { signal: controller.signal });
      if (!resp.ok) throw new Error(`sound fetch failed: ${resp.status}`);
      return await resp.arrayBuffer();
    })(), SOUND_FETCH_TIMEOUT_MS, () => controller.abort());
    // WebKit decodeAudioData has occasionally remained pending after a route/background change.
    // A late decode result owns no state; deleting loading[name] below lets the next event retry.
    const buf = await boundedSoundOperation(ctx().decodeAudioData(arr), SOUND_DECODE_TIMEOUT_MS);
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

// Насколько звук события ещё актуален. Suspended-контекст НЕ отбрасывает start() — он копит источники
// и вываливает их залпом при первом резюме: пользователь, кликнувший через минуту, слышал очередь из
// десятка «зашёл/вышел» разом. Просроченное событие лучше молча потерять, чем сыграть не вовремя.
const SOUND_STALE_MS = 1500;

function emitSound(name: SoundName, vol: number): void {
  const buf = buffers[name];
  const c = actx;
  if (!buf || !c) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = vol * (norm[name] ?? 1);
  src.connect(g); g.connect(c.destination);
  src.start();
}

export function playSound(name: SoundName): void {
  try {
    const vol = Math.max(0, Math.min(1, (getSettings().notifyVolume ?? 60) / 100));
    if (vol <= 0) return;
    const at = Date.now();
    if (!buffers[name]) { load(name).then(() => { if (Date.now() - at < SOUND_STALE_MS) playSound(name); }).catch(() => {}); return; }
    const c = ctx();
    if (c.state === 'running') { emitSound(name, vol); return; }
    // контекст мог родиться suspended (без жеста) или уснуть — будим и играем ТОЛЬКО если успели
    // и не держим по callback на каждое событие, если WebKit оставил native resume() pending.
    pendingResumeSound = { name, vol, at };
    observeSoundContextResume(c);
  } catch { /* ignore */ }
}

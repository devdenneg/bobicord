import type { AudioSettings } from './types';

// keybinds пустые по умолчанию (пользователь сам назначает) + глобальный хук вне приложения
// выключен по умолчанию (disableGlobalHotkeys=true) — см. HK_RESET_V в App.tsx для форс-сброса
// уже настроивших аккаунтов.
const DEF: AudioSettings = { input: '', output: '', nsMode: 'rnnoise', ec: true, agc: true, mode: 'voice', pttKey: 'KeyV', master: 100, sensitivity: 10, sensitivityAuto: true, notifyVolume: 60, notif: false, notifMention: true, notifStream: true, notifUpdate: true, notifPrivacy: 'full', shareGame: true, keybinds: { muteMic: [], deafen: [] }, disableGlobalHotkeys: true };
let stored: Partial<AudioSettings> = {};
try {
  const raw = localStorage.getItem('audioSettings');
  const parsed = raw ? JSON.parse(raw) : {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
} catch { /* повреждённый или недоступный mobile storage — используем безопасные defaults */ }
// keybinds/disableGlobalHotkeys — сознательно НЕ читаем из локального кэша при старте (в
// отличие от остальных полей). Это привязано к аккаунту (см. App.tsx: GET/PUT /api/me/settings),
// а localStorage — только write-through кэш для мгновенной отрисовки/офлайна. Раньше кэш на
// старте перебивал свежий код-дефолт (кто угодно, открывавший апп до смены дефолта на Shift+M/D,
// так и оставался на старом M/D навсегда — синхронизация с сервером это не лечила, потому что
// у пустого/нового аккаунта на сервере просто нечем было перезаписать локальное значение).
// Теперь единственный источник — код-дефолт ниже, а сервер переопределяет его после логина.
let s: AudioSettings = { ...DEF, ...stored, keybinds: DEF.keybinds, disableGlobalHotkeys: DEF.disableGlobalHotkeys };
// Старые/повреждённые мобильные значения не должны попадать в WebRTC constraints.
if (typeof s.input !== 'string') s.input = '';
if (typeof s.output !== 'string') s.output = '';
if (!['rnnoise', 'basic', 'off'].includes(s.nsMode)) s.nsMode = DEF.nsMode;
if (!['voice', 'ptt'].includes(s.mode)) s.mode = DEF.mode;
for (const key of ['master', 'sensitivity', 'notifyVolume'] as const) {
  const value = Number(s[key]);
  s[key] = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : DEF[key];
}
if (typeof s.ec !== 'boolean') s.ec = DEF.ec;
if (typeof s.agc !== 'boolean') s.agc = DEF.agc;
if (typeof s.sensitivityAuto !== 'boolean') s.sensitivityAuto = DEF.sensitivityAuto;
if (!['full', 'sender', 'hidden'].includes(s.notifPrivacy)) s.notifPrivacy = 'full';
// Миграция: раньше можно было выбрать enumerated-алиас 'default'/'communications' (Chrome-псевдо-
// устройства) — теперь пикер их прячет (см. audioDevices.audioDeviceChoices). Эти значения эквивалентны
// системному по умолчанию, нормализуем в '' — иначе после дедупа пикер покажет «ничего не выбрано».
// Поведение звука не меняется ('' и 'default' одинаково следуют за системным устройством).
if (s.input === 'default' || s.input === 'communications') s.input = '';
if (s.output === 'default' || s.output === 'communications') s.output = '';
const subs = new Set<() => void>();

function syncNotificationPrivacyToWorker(): void {
  try {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.ready.then((registration) => {
      registration.active?.postMessage({ type: 'set-notification-privacy', privacy: s.notifPrivacy });
    }).catch(() => {});
  } catch { /** service worker is optional */ }
}

syncNotificationPrivacyToWorker();
try {
  navigator.serviceWorker?.addEventListener('controllerchange', syncNotificationPrivacyToWorker);
} catch { /** service worker is optional */ }

export const getSettings = (): AudioSettings => s;
export function setSettings(patch: Partial<AudioSettings>): void {
  s = { ...s, ...patch };
  try { localStorage.setItem('audioSettings', JSON.stringify(s)); } catch { /* приватный режим/переполненное хранилище не ломает голос */ }
  if (patch.notifPrivacy !== undefined) syncNotificationPrivacyToWorker();
  subs.forEach((f) => f());
}
export function subscribeSettings(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

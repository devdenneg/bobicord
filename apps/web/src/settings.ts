import type { AudioSettings } from './types';

// keybinds пустые по умолчанию (пользователь сам назначает) + глобальный хук вне приложения
// выключен по умолчанию (disableGlobalHotkeys=true) — см. HK_RESET_V в App.tsx для форс-сброса
// уже настроивших аккаунтов.
const DEF: AudioSettings = { input: '', output: '', nsMode: 'rnnoise', ec: true, agc: true, mode: 'voice', pttKey: 'KeyV', master: 100, sensitivity: 10, sensitivityAuto: true, notifyVolume: 60, notif: false, notifMention: true, notifStream: true, notifUpdate: true, notifPrivacy: 'full', shareGame: true, keybinds: { muteMic: [], deafen: [] }, disableGlobalHotkeys: true };
const stored = JSON.parse(localStorage.getItem('audioSettings') || '{}');
// keybinds/disableGlobalHotkeys — сознательно НЕ читаем из локального кэша при старте (в
// отличие от остальных полей). Это привязано к аккаунту (см. App.tsx: GET/PUT /api/me/settings),
// а localStorage — только write-through кэш для мгновенной отрисовки/офлайна. Раньше кэш на
// старте перебивал свежий код-дефолт (кто угодно, открывавший апп до смены дефолта на Shift+M/D,
// так и оставался на старом M/D навсегда — синхронизация с сервером это не лечила, потому что
// у пустого/нового аккаунта на сервере просто нечем было перезаписать локальное значение).
// Теперь единственный источник — код-дефолт ниже, а сервер переопределяет его после логина.
let s: AudioSettings = { ...DEF, ...stored, keybinds: DEF.keybinds, disableGlobalHotkeys: DEF.disableGlobalHotkeys };
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
  localStorage.setItem('audioSettings', JSON.stringify(s));
  if (patch.notifPrivacy !== undefined) syncNotificationPrivacyToWorker();
  subs.forEach((f) => f());
}
export function subscribeSettings(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

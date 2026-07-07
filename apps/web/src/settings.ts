import type { AudioSettings } from './types';

const DEF: AudioSettings = { input: '', output: '', ns: true, ec: true, agc: true, mode: 'voice', pttKey: 'KeyV', master: 100, sensitivity: 10, sensitivityAuto: true, notifyVolume: 60, notif: false, notifMention: true, notifStream: true, notifUpdate: true, shareGame: true, keybinds: { muteMic: ['ShiftLeft', 'KeyM'], deafen: ['ShiftLeft', 'KeyD'] }, disableGlobalHotkeys: false };
const stored = JSON.parse(localStorage.getItem('audioSettings') || '{}');
// keybinds/disableGlobalHotkeys — сознательно НЕ читаем из локального кэша при старте (в
// отличие от остальных полей). Это привязано к аккаунту (см. App.tsx: GET/PUT /api/me/settings),
// а localStorage — только write-through кэш для мгновенной отрисовки/офлайна. Раньше кэш на
// старте перебивал свежий код-дефолт (кто угодно, открывавший апп до смены дефолта на Shift+M/D,
// так и оставался на старом M/D навсегда — синхронизация с сервером это не лечила, потому что
// у пустого/нового аккаунта на сервере просто нечем было перезаписать локальное значение).
// Теперь единственный источник — код-дефолт ниже, а сервер переопределяет его после логина.
let s: AudioSettings = { ...DEF, ...stored, keybinds: DEF.keybinds, disableGlobalHotkeys: DEF.disableGlobalHotkeys };
const subs = new Set<() => void>();

export const getSettings = (): AudioSettings => s;
export function setSettings(patch: Partial<AudioSettings>): void {
  s = { ...s, ...patch };
  localStorage.setItem('audioSettings', JSON.stringify(s));
  subs.forEach((f) => f());
}
export function subscribeSettings(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

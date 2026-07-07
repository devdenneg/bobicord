// Системные (локальные) уведомления: натив (Tauri plugin-notification) + PWA/веб (Notifications API
// через service worker). Фоновый push (приложение закрыто / iOS PWA в фоне) — отдельная инфра
// (Web Push/VAPID), тут не реализован: на iOS свёрнутая PWA JS не исполняет, локальные уведомления
// там не сработают вообще.
import { isTauri } from './native';
import { getSettings, setSettings } from './settings';
import type { AudioSettings } from './types';

export type NotifKind = 'mention' | 'stream' | 'update';
const KIND_PREF: Record<NotifKind, keyof AudioSettings> = { mention: 'notifMention', stream: 'notifStream', update: 'notifUpdate' };
// Гейт фокуса. mention/ответ — только когда окно НЕ в фокусе (в фокусе видно чат, хватает
// внутриигрового тоста — так делают Discord/Slack). Трансляции и обновления — ВСЕГДА, даже
// в фокусе (по решению пользователя: важное событие, легко пропустить в открытом окне).
const FOCUS_GATED: Record<NotifKind, boolean> = { mention: true, stream: false, update: false };

export function notifSupported(): boolean {
  return isTauri || (typeof window !== 'undefined' && 'Notification' in window);
}
export function notifPermission(): 'default' | 'granted' | 'denied' {
  if (typeof Notification === 'undefined') return 'default';
  return Notification.permission;
}

// запрос разрешения + включение мастера (вызывать по клику пользователя в настройках)
export async function enableNotifications(): Promise<boolean> {
  const granted = await requestPermission();
  setSettings({ notif: granted });
  return granted;
}
async function requestPermission(): Promise<boolean> {
  if (isTauri) {
    try {
      const m = await import('@tauri-apps/plugin-notification');
      let ok = await m.isPermissionGranted();
      if (!ok) ok = (await m.requestPermission()) === 'granted';
      return ok;
    } catch { return false; }
  }
  if (typeof Notification === 'undefined') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

// Стартовый запрос при запуске приложения (App.tsx). Уважает опт-аут (юзер выключил в
// настройках). Возвращает true ровно один раз — при первом успешном включении — чтобы UI
// показал приветственный тост «включены, отключить можно в настройках».
export async function initNotifications(): Promise<boolean> {
  if (!notifSupported()) return false;
  if (localStorage.getItem('notifOptOut') === '1') return false; // юзер сам выключил — не пристаём
  if (!isTauri && notifPermission() === 'denied') return false;  // веб: заблокировано в браузере — повторный запрос игнорится
  const granted = notifPermission() === 'granted' ? true : await requestPermission();
  if (!granted) return false;
  setSettings({ notif: true });
  if (localStorage.getItem('notifWelcomed') === '1') return false;
  localStorage.setItem('notifWelcomed', '1');
  return true;
}

function focused(): boolean {
  try { return document.visibilityState === 'visible' && document.hasFocus(); } catch { return false; }
}

/** Показать уведомление типа kind (если включено и разрешено; фокус гейтит только mention). Не бросает. */
export async function notify(kind: NotifKind, opts: { title: string; body: string; tag?: string }): Promise<void> {
  try {
    const s = getSettings();
    if (!s.notif || !s[KIND_PREF[kind]]) return; // мастер или тип выключены
    if (FOCUS_GATED[kind] && focused()) return;  // упоминание в фокусе — не спамим системным (виден чат)
    if (isTauri) {
      const m = await import('@tauri-apps/plugin-notification');
      if (!(await m.isPermissionGranted())) return;
      await m.sendNotification({ title: opts.title, body: opts.body });
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const data: NotificationOptions = { body: opts.body, icon: '/icon-256.png', badge: '/icon-128.png', tag: opts.tag, ...( { renotify: !!opts.tag } as any) };
    // предпочитаем показ через service worker (переживает бэкграунд вкладки, кликабелен → фокус окна)
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && reg.showNotification) { await reg.showNotification(opts.title, data); return; }
    new Notification(opts.title, data);
  } catch { /* тихо: уведомления не должны ронять поток событий */ }
}

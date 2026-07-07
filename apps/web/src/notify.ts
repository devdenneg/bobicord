// Системные (локальные) уведомления: натив (Tauri plugin-notification) + PWA/веб (Notifications API
// через service worker). Показываем ТОЛЬКО когда окно не в фокусе — иначе хватает внутриигрового
// тоста. Фоновый push (приложение закрыто) — отдельная инфра (Web Push/VAPID), тут не реализован.
import { isTauri } from './native';
import { getSettings, setSettings } from './settings';
import type { AudioSettings } from './types';

export type NotifKind = 'mention' | 'stream' | 'update';
const KIND_PREF: Record<NotifKind, keyof AudioSettings> = { mention: 'notifMention', stream: 'notifStream', update: 'notifUpdate' };

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

function focused(): boolean {
  try { return document.visibilityState === 'visible' && document.hasFocus(); } catch { return false; }
}

/** Показать уведомление типа kind (если включено, разрешено и окно не в фокусе). Никогда не бросает. */
export async function notify(kind: NotifKind, opts: { title: string; body: string; tag?: string }): Promise<void> {
  try {
    const s = getSettings();
    if (!s.notif || !s[KIND_PREF[kind]]) return; // мастер или тип выключены
    if (focused()) return;                        // окно активно — не спамим системным (есть тост)
    if (isTauri) {
      const m = await import('@tauri-apps/plugin-notification');
      if (!(await m.isPermissionGranted())) return;
      m.sendNotification({ title: opts.title, body: opts.body });
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

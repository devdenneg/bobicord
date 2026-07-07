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
    if (!s.notif || !s[KIND_PREF[kind]]) { console.debug('[notify] пропуск: выключено', { kind, notif: s.notif, type: s[KIND_PREF[kind]] }); return; }
    if (focused()) { console.debug('[notify] пропуск: окно в фокусе'); return; } // окно активно — не спамим системным (есть тост)
    if (isTauri) {
      const m = await import('@tauri-apps/plugin-notification');
      if (!(await m.isPermissionGranted())) { console.debug('[notify] пропуск: натив-разрешение не выдано'); return; }
      await m.sendNotification({ title: opts.title, body: opts.body });
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') { console.debug('[notify] пропуск: веб-разрешение', typeof Notification !== 'undefined' ? Notification.permission : 'нет API'); return; }
    const data: NotificationOptions = { body: opts.body, icon: '/icon-256.png', badge: '/icon-128.png', tag: opts.tag, ...( { renotify: !!opts.tag } as any) };
    // предпочитаем показ через service worker (переживает бэкграунд вкладки, кликабелен → фокус окна)
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && reg.showNotification) { await reg.showNotification(opts.title, data); return; }
    new Notification(opts.title, data);
  } catch (e) { console.debug('[notify] ошибка', e); /* тихо: уведомления не должны ронять поток событий */ }
}

// Диагностический тест из настроек: запрашивает разрешение и шлёт уведомление,
// ИГНОРИРУЯ мастер-переключатель и гейт фокуса. Возвращает человекочитаемый статус,
// чтобы UI показал тостом, почему уведомление не появилось (без открытия devtools).
export async function notifyTest(): Promise<{ ok: boolean; msg: string }> {
  const plat = isTauri ? 'натив' : 'веб';
  try {
    if (!notifSupported()) return { ok: false, msg: `Уведомления не поддерживаются (${plat})` };
    const granted = await requestPermission();
    console.debug('[notifyTest]', { plat, granted, perm: notifPermission() });
    if (!granted) {
      return { ok: false, msg: notifPermission() === 'denied'
        ? `Разрешение заблокировано в ОС/браузере (${plat}) — включи уведомления для RelayApp в настройках системы`
        : `Система не выдала разрешение (${plat})` };
    }
    const title = 'RelayApp';
    const body = 'Проверка уведомлений — работает ✓';
    if (isTauri) {
      const m = await import('@tauri-apps/plugin-notification');
      await m.sendNotification({ title, body });
      return { ok: true, msg: 'Тест отправлен (натив) — если тоста нет, проверь «Не беспокоить»/Фокусировку внимания в Windows' };
    }
    const data: NotificationOptions = { body, icon: '/icon-256.png', badge: '/icon-128.png', tag: 'test', ...( { renotify: true } as any) };
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && reg.showNotification) { await reg.showNotification(title, data); return { ok: true, msg: 'Тест отправлен (веб, через SW)' }; }
    new Notification(title, data);
    return { ok: true, msg: 'Тест отправлен (веб)' };
  } catch (e) {
    return { ok: false, msg: `Ошибка (${plat}): ` + (e instanceof Error ? e.message : String(e)) };
  }
}

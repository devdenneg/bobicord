// Системные (локальные) уведомления: натив (Tauri plugin-notification) + PWA/веб (Notifications API
// через service worker). Фоновый push (приложение закрыто / iOS PWA в фоне) — отдельная инфра
// (Web Push/VAPID), тут не реализован: на iOS свёрнутая PWA JS не исполняет, локальные уведомления
// там не сработают вообще.
import { isTauri } from './native';
import { getSettings, setSettings } from './settings';
import { ensurePushSubscribed } from './push';
import { playSound } from './sounds';
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
  if (granted) ensurePushSubscribed(); // подписка на фоновый web-push (PWA/браузер)
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
  ensurePushSubscribed(); // фоновый web-push: подписываем при каждом старте (подписка могла ротироваться)
  if (localStorage.getItem('notifWelcomed') === '1') return false;
  localStorage.setItem('notifWelcomed', '1');
  return true;
}

function focused(): boolean {
  try { return document.visibilityState === 'visible' && document.hasFocus(); } catch { return false; }
}

// Кастомное нативное уведомление: своя карточка в стиле приложения (окно Tauri notif.html),
// вместо системного toast. Возвращает true, если окно создалось (иначе вызывающий даёт фолбэк).
async function showNativeCard(kind: NotifKind, title: string, body: string): Promise<boolean> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    // одно окно за раз: закрываем прежнее, иначе конфликт по label
    try { const ex = await WebviewWindow.getByLabel('notif'); if (ex) await ex.close(); } catch { /**/ }
    const W = 380, H = 108, MARGIN = 16;
    // Позиция — правый нижний угол РАБОЧЕЙ ОБЛАСТИ текущего монитора (без таскбара), в ГЛОБАЛЬНЫХ
    // логических px. screen.availWidth не учитывает офсет монитора → на мультимониторе/DPI x/y
    // уводили за пределы → Tauri ЦЕНТРИРОВАЛ окно («у некоторых по середине»). currentMonitor даёт
    // и офсет, и workArea, и scaleFactor. Фолбэк на screen, если монитор не отдался.
    let x: number, y: number;
    try {
      const { currentMonitor } = await import('@tauri-apps/api/window');
      const mon = await currentMonitor();
      if (mon) {
        const pos = mon.workArea.position.toLogical(mon.scaleFactor);
        const size = mon.workArea.size.toLogical(mon.scaleFactor);
        x = Math.round(pos.x + size.width - W - MARGIN);
        y = Math.round(pos.y + size.height - H - MARGIN);
      } else { throw new Error('no monitor'); }
    } catch {
      const sw = (typeof screen !== 'undefined' && screen.availWidth) || 1280;
      const sh = (typeof screen !== 'undefined' && screen.availHeight) || 800;
      x = Math.max(8, sw - W - MARGIN); y = Math.max(8, sh - H - MARGIN);
    }
    const url = `notif.html?k=${encodeURIComponent(kind)}&t=${encodeURIComponent(title)}&b=${encodeURIComponent(body)}`;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        const win = new WebviewWindow('notif', {
          url, width: W, height: H, x, y,
          decorations: false, transparent: true, alwaysOnTop: true,
          skipTaskbar: true, focus: false, focusable: false, resizable: false, shadow: false, title: 'RelayApp',
        });
        win.once('tauri://created', () => done(true));
        win.once('tauri://error', () => done(false)); // нет прав / ошибка → фолбэк на OS-toast
      } catch { done(false); }
      // события не пришли — считаем показанным (лучше пропустить фолбэк, чем задвоить уведомление)
      setTimeout(() => done(true), 2000);
    });
  } catch { return false; }
}

/**
 * Показать уведомление типа kind (если включено и разрешено; фокус гейтит только mention, кроме force).
 * Возвращает true, если уведомление реально ПОКАЗАНО. Звук mention-«тега» (как в Discord) — от самого
 * уведомления: беззвучную нативную карточку озвучиваем tag ЗДЕСЬ; когда уведомления нет (нет прав/не
 * поддерживается) — тоже tag (пинг из приложения); системный toast/веб-уведомление звучат сами (ОС).
 * Не пингуем, когда пользователь выключил уведомления или смотрит чат (фокус-гейт) — как в Discord.
 * Не бросает.
 */
export async function notify(kind: NotifKind, opts: { title: string; body: string; tag?: string; force?: boolean }): Promise<boolean> {
  try {
    const s = getSettings();
    if (!s.notif || !s[KIND_PREF[kind]]) return false; // мастер или тип выключены — тихо
    // Фокус-гейт mention («виден чат») применим ТОЛЬКО к текущему просматриваемому серверу. Для
    // упоминания в ДРУГОМ сервере (notify-WS, force:true) чат не виден — уведомляем даже в фокусе.
    if (FOCUS_GATED[kind] && focused() && !opts.force) return false; // смотришь чат — Discord канал в фокусе не пингует
    if (isTauri) {
      // кастомная карточка в стиле приложения; если окно не создалось (нет прав/ошибка) — системный toast
      const shown = await showNativeCard(kind, opts.title, opts.body);
      if (shown) { if (kind === 'mention') playSound('tag'); } // карточка беззвучна → звук тега из приложения (один пинг)
      else {
        try { const m = await import('@tauri-apps/plugin-notification'); if (await m.isPermissionGranted()) await m.sendNotification({ title: opts.title, body: opts.body }); } catch { /**/ } // toast звучит сам (ОС)
      }
      return shown;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      if (kind === 'mention') playSound('tag'); // нет веб-уведомлений (нет прав/не поддерживается) → пинг из приложения
      return false;
    }
    const data: NotificationOptions = { body: opts.body, icon: '/icon-256.png', badge: '/icon-128.png', tag: opts.tag, ...( { renotify: !!opts.tag } as any) };
    // предпочитаем показ через service worker (переживает бэкграунд вкладки, кликабелен → фокус окна)
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && reg.showNotification) { await reg.showNotification(opts.title, data); return true; } // веб-уведомление звучит само (ОС)
    new Notification(opts.title, data);
    return true;
  } catch { return false; /* тихо: уведомления не должны ронять поток событий */ }
}

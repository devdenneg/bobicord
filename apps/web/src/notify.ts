// Системные (локальные) уведомления: натив (Tauri plugin-notification) + PWA/веб (Notifications API
// через service worker). Фоновый push (приложение закрыто / iOS PWA в фоне) — отдельная инфра
// (Web Push/VAPID), тут не реализован: на iOS свёрнутая PWA JS не исполняет, локальные уведомления
// там не сработают вообще.
import { isTauri, foregroundFullscreen } from './native';
import { getSettings, setSettings } from './settings';
import { ensurePushSubscribed } from './push';
import { playSound } from './sounds';
import { visibleChatServer } from './chatVisibility';
import {
  notificationDestinationFromTag,
  notificationDestinationUrl,
  queueNotificationDestination,
  rememberNotificationDestination,
  resolveNotificationDestination,
  type NotificationDestination,
} from './notificationDestination';
import type { AudioSettings, NotificationPrivacy } from './types';

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
  const granted = await requestNotificationPermission();
  setSettings({ notif: granted });
  if (granted) ensurePushSubscribed(); // подписка на фоновый web-push (PWA/браузер)
  return granted;
}
export async function requestNotificationPermission(): Promise<boolean> {
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

/** Проверка уже выданного разрешения без показа системного prompt. */
export async function notificationPermissionGranted(): Promise<boolean> {
  if (isTauri) {
    try {
      const m = await import('@tauri-apps/plugin-notification');
      return await m.isPermissionGranted();
    } catch { return false; }
  }
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

// Стартовая активация при запуске приложения (App.tsx) НИКОГДА не показывает permission prompt:
// запрос допустим только из enableNotifications() после явного клика. Возвращает true ровно
// один раз — при первом успешном включении — чтобы UI
// показал приветственный тост «включены, отключить можно в настройках».
export async function initNotifications(): Promise<boolean> {
  if (!notifSupported()) return false;
  if (localStorage.getItem('notifOptOut') === '1') return false; // юзер сам выключил — не пристаём
  if (!isTauri && notifPermission() === 'denied') {
    if (getSettings().notif) setSettings({ notif: false });
    return false;
  }
  const granted = await notificationPermissionGranted();
  if (!granted) {
    if (getSettings().notif) setSettings({ notif: false });
    return false;
  }
  setSettings({ notif: true });
  ensurePushSubscribed(); // фоновый web-push: подписываем при каждом старте (подписка могла ротироваться)
  if (localStorage.getItem('notifWelcomed') === '1') return false;
  localStorage.setItem('notifWelcomed', '1');
  return true;
}

function focused(): boolean {
  try { return document.visibilityState === 'visible' && document.hasFocus(); } catch { return false; }
}

function notificationPresentation(kind: NotifKind, title: string, body: string, privacy: NotificationPrivacy, sender?: string): { title: string; body: string } {
  if (privacy === 'full') return { title, body };
  if (privacy === 'sender') {
    return { title: String(sender || title.split(' · ')[0] || 'RelayApp'), body: '' };
  }
  const bodyByKind: Record<NotifKind, string> = {
    mention: 'Новое упоминание',
    stream: 'Началась трансляция',
    update: 'Доступно обновление',
  };
  return { title: 'RelayApp', body: bodyByKind[kind] };
}

// Кастомное нативное уведомление: своя карточка в стиле приложения (окно Tauri notif.html),
// вместо системного toast. Возвращает true, если окно создалось (иначе вызывающий даёт фолбэк).
// Создание карточек строго по очереди. Метка окна одна ('notif'), а notify() зовут параллельно
// (упоминание + старт трансляции, два упоминания подряд): оба успевали пройти проверку getByLabel
// до того, как соперник создал окно, второй получал конфликт метки → 'tauri://error' → фолбэк на
// системный toast, который срабатывает только при выданном разрешении. То есть одно из двух
// уведомлений просто пропадало. Очередь как voiceAttrWrites в engine.
let nativeCardQueue: Promise<unknown> = Promise.resolve();

async function showNativeCard(kind: NotifKind, title: string, body: string, tag?: string, destination?: NotificationDestination | null): Promise<boolean> {
  const run = nativeCardQueue.catch(() => {}).then(() => showNativeCardNow(kind, title, body, tag, destination));
  nativeCardQueue = run.catch(() => {});
  return run;
}

async function showNativeCardNow(kind: NotifKind, title: string, body: string, tag?: string, destination?: NotificationDestination | null): Promise<boolean> {
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
    const query = new URLSearchParams({ k: kind, t: title, b: body });
    if (tag) query.set('tag', tag);
    if (destination?.serverId) query.set('server', destination.serverId);
    if (destination?.messageId) query.set('message', String(destination.messageId));
    const url = `notif.html?${query.toString()}`;
    const create = () => new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        const win = new WebviewWindow('notif', {
          url, width: W, height: H, x, y,
          decorations: false, transparent: true, alwaysOnTop: true,
          skipTaskbar: true, focus: false, focusable: false, resizable: false, shadow: false, title: 'RelayApp',
        });
        win.once('tauri://created', () => done(true));
        win.once('tauri://error', () => done(false)); // нет прав / конфликт метки → решаем ниже
      } catch { done(false); }
      // события не пришли — считаем показанным (лучше пропустить фолбэк, чем задвоить уведомление)
      setTimeout(() => done(true), 2000);
    });
    if (await create()) return true;
    // Предыдущая карточка закрывается с анимацией (~330мс в notif-window.ts), поэтому метка могла быть
    // ещё занята. Даём ей уйти и пробуем ещё раз, прежде чем падать в системный toast.
    await new Promise((r) => setTimeout(r, 400));
    try { const ex = await WebviewWindow.getByLabel('notif'); if (ex) await ex.close(); } catch { /**/ }
    return await create();
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
export interface RelayNotificationOptions {
  title: string;
  body: string;
  sender?: string;
  tag?: string;
  force?: boolean;
  destination?: NotificationDestination;
}

export async function notify(kind: NotifKind, opts: RelayNotificationOptions): Promise<boolean> {
  try {
    const s = getSettings();
    const destination = rememberNotificationDestination(
      opts.tag,
      opts.destination || notificationDestinationFromTag(opts.tag),
    );
    const shownContent = notificationPresentation(kind, opts.title, opts.body, s.notifPrivacy, opts.sender);
    if (!s.notif || !s[KIND_PREF[kind]]) return false; // мастер или тип выключены — тихо
    // Mention/@all — звук-пинг ВСЕГДА (даже когда смотришь чат): быть @упомянутым/в @all важно (как Discord).
    // Визуальную карточку ниже фокус-гейтим и не показываем поверх фуллскрин-игры — но звук уже дан.
    if (kind === 'mention') playSound('tag');
    // Фокус-гейт — только для ВИЗУАЛЬНОЙ карточки mention. Гасим её, лишь когда человек РЕАЛЬНО видит
    // тот чат, где его упомянули: «окно в фокусе» этого не означает — можно сидеть на главной, в другом
    // сервере или в раскладке со скрытой чат-панелью, и тогда карточка исчезала, а упоминание пропадало.
    // force:true (notify-WS) — путь заведомо не обслуживается живым чатом, показываем всегда.
    const mentionServerId = opts.destination?.serverId || notificationDestinationFromTag(opts.tag)?.serverId || null;
    const chatOnScreen = !!mentionServerId && visibleChatServer() === mentionServerId;
    if (FOCUS_GATED[kind] && focused() && chatOnScreen && !opts.force) return false;
    if (isTauri) {
      // Фуллскрин-приложение (игра) на переднем плане → окно-карточка свернёт его (Windows выкидывает
      // exclusive-fullscreen из полного экрана). Окно НЕ создаём; звук уже сыгран, toast-фолбэк тоже не шлём.
      if (await foregroundFullscreen()) return false;
      // кастомная карточка в стиле приложения; если окно не создалось (нет прав/ошибка) — системный toast
      const shown = await showNativeCard(kind, shownContent.title, shownContent.body, opts.tag, destination);
      let delivered = shown;
      if (!shown) {
        try {
          const m = await import('@tauri-apps/plugin-notification');
          if (await m.isPermissionGranted()) {
            await m.sendNotification({ title: shownContent.title, body: shownContent.body });
            delivered = true;
          }
        } catch { /**/ } // toast звучит сам (ОС)
      }
      return delivered;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const clickData = destination ? {
      serverId: destination.serverId,
      messageId: destination.messageId,
      url: notificationDestinationUrl(destination),
    } : undefined;
    const data: NotificationOptions = {
      body: shownContent.body,
      icon: '/icon-256.png',
      badge: '/icon-128.png',
      tag: opts.tag,
      data: clickData,
      ...( { renotify: !!opts.tag } as any),
    };
    // предпочитаем показ через service worker (переживает бэкграунд вкладки, кликабелен → фокус окна)
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && reg.showNotification) { await reg.showNotification(shownContent.title, data); return true; } // веб-уведомление звучит само (ОС)
    const notification = new Notification(shownContent.title, data);
    notification.onclick = () => {
      const target = resolveNotificationDestination(opts.tag, destination);
      if (target) queueNotificationDestination(target);
      try { window.focus(); } catch { /**/ }
      notification.close();
    };
    return true;
  } catch { return false; /* тихо: уведомления не должны ронять поток событий */ }
}

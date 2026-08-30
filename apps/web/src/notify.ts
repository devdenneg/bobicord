// Системные уведомления: Tauri plugin-notification либо Notifications API через service worker.
// Web Push/VAPID подключается здесь только после подтверждённой сервером подписки; на iOS фоновые
// уведомления доступны установленной Home Screen PWA, но фоновый микрофон Safari всё равно замораживает.
import { isTauri, foregroundFullscreen } from './native';
import {
  getNotificationPushPrefs, getSettings, NOTIFICATION_PUSH_PREFS_CHANGED_EVENT, setSettings,
} from './settings';
import { ensurePushSubscribed, pushSetupErrorMessage, pushSupported, unsubscribePush } from './push';
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
  return isTauri || (typeof window !== 'undefined' && 'Notification' in window && pushSupported());
}
export function notifPermission(): 'default' | 'granted' | 'denied' {
  if (typeof Notification === 'undefined') return 'default';
  return Notification.permission;
}

export interface NotificationEnableResult {
  enabled: boolean;
  error?: string;
  permissionDenied?: boolean;
}

let pushRecoveryUserId = '';
let pushRecoveryInstalled = false;
let pushRecoveryIntentEpoch = 0;
let pushRecoveryLastAttemptAt = 0;
let pushRecoveryConfirmed = false;
let pushRecoveryRun: Promise<void> | null = null;
let pushRecoveryTimer: number | null = null;
let pushPreferencesGeneration = 0;
const PUSH_MAINTENANCE_INTERVAL_MS = 60_000;
const PUSH_RECOVERY_RETRY_INTERVAL_MS = 3_000;
let notificationOptOutMemory = false;
let notificationOptOutMemoryDirty = false;
let notificationIntentEpoch = 0;
let notificationIntentUserId = '';

function invalidateNotificationIntent(clearUser = false): void {
  notificationIntentEpoch += 1;
  if (clearUser) notificationIntentUserId = '';
}

function beginNotificationIntent(userId: string): number {
  notificationIntentUserId = userId;
  notificationIntentEpoch += 1;
  return notificationIntentEpoch;
}

function notificationIntentCurrent(epoch: number, userId: string): boolean {
  if (notificationOptedOut()) return false;
  return epoch === notificationIntentEpoch && userId === notificationIntentUserId;
}

export function notificationOptedOut(): boolean {
  if (notificationOptOutMemoryDirty) {
    // A failed disable remains authoritative in memory, while a failed enable must not overrule a
    // restrictive durable value (possibly written by another tab while this one was frozen).
    try { return notificationOptOutMemory || localStorage.getItem('notifOptOut') === '1'; }
    catch { return notificationOptOutMemory; }
  }
  try {
    const next = localStorage.getItem('notifOptOut') === '1';
    if (next !== notificationOptOutMemory) {
      notificationOptOutMemory = next;
      invalidateNotificationIntent(next);
      if (next) { pushRecoveryUserId = ''; pushRecoveryIntentEpoch = 0; }
    }
    return notificationOptOutMemory;
  } catch { return notificationOptOutMemory; }
}

export function setNotificationOptOut(optedOut: boolean): void {
  notificationOptOutMemory = optedOut;
  invalidateNotificationIntent(optedOut);
  if (optedOut) {
    pushRecoveryUserId = '';
    pushRecoveryIntentEpoch = 0;
    cancelPushRecoveryTimer();
    setSettings({ notif: false });
  }
  try {
    if (optedOut) localStorage.setItem('notifOptOut', '1');
    else localStorage.removeItem('notifOptOut');
    notificationOptOutMemoryDirty = false;
  } catch {
    // A readable-but-unwritable storage area must not immediately overwrite this exact in-process
    // choice with its stale value on the next recovery/read.
    notificationOptOutMemoryDirty = true;
  }
}

export function suspendNotificationPushRecovery(userId: string): void {
  if (pushRecoveryUserId === userId) {
    pushRecoveryUserId = '';
    pushRecoveryIntentEpoch = 0;
    cancelPushRecoveryTimer();
  }
  invalidateNotificationIntent(true);
}

function reconcileNotificationOptOut(): void {
  if (notificationOptedOut()) {
    pushRecoveryUserId = '';
    pushRecoveryIntentEpoch = 0;
    cancelPushRecoveryTimer();
    if (getSettings().notif) setSettings({ notif: false });
  }
}

if (typeof window !== 'undefined') {
  // Install before the first subscription request: settings can change while init/permission flows
  // are awaiting the backend, and that request must never confirm an older preference generation.
  window.addEventListener(NOTIFICATION_PUSH_PREFS_CHANGED_EVENT, resyncPushPreferences);
  window.addEventListener('storage', (event) => {
    if (event.key !== 'notifOptOut') return;
    const externalOptOut = event.newValue === '1';
    if (notificationOptOutMemoryDirty) {
      notificationOptOutMemory = notificationOptOutMemory || externalOptOut;
      // Retain only an unpersisted restrictive local choice; every state matching durable storage
      // can safely return to ordinary cross-tab reconciliation.
      notificationOptOutMemoryDirty = notificationOptOutMemory && !externalOptOut;
    } else notificationOptOutMemory = externalOptOut;
    invalidateNotificationIntent(notificationOptOutMemory);
    if (notificationOptOutMemory) {
      pushRecoveryUserId = '';
      pushRecoveryIntentEpoch = 0;
      cancelPushRecoveryTimer();
    }
    if (notificationOptOutMemory) reconcileNotificationOptOut();
  });
  // A frozen iOS/BFCache page can miss `storage`; reconcile before it resumes local notifications.
  window.addEventListener('pageshow', reconcileNotificationOptOut);
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reconcileNotificationOptOut();
    });
  } catch { /** document can be absent in unit/worker-like environments */ }
}

function cancelPushRecoveryTimer(): void {
  if (pushRecoveryTimer === null || typeof window === 'undefined') return;
  try { window.clearTimeout(pushRecoveryTimer); } catch { /**/ }
  pushRecoveryTimer = null;
}

function schedulePushRecovery(): void {
  if (pushRecoveryTimer !== null || isTauri || typeof window === 'undefined'
    || typeof window.setTimeout !== 'function') return;
  const userId = pushRecoveryUserId;
  const intentEpoch = pushRecoveryIntentEpoch;
  if (!userId || !notificationIntentCurrent(intentEpoch, userId)) return;
  const cadence = pushRecoveryConfirmed ? PUSH_MAINTENANCE_INTERVAL_MS : PUSH_RECOVERY_RETRY_INTERVAL_MS;
  const delay = Math.max(0, cadence - Math.max(0, Date.now() - pushRecoveryLastAttemptAt));
  pushRecoveryTimer = window.setTimeout(() => {
    pushRecoveryTimer = null;
    retryPushRecovery();
  }, delay);
}

function retryPushRecovery(): void {
  const currentUserId = pushRecoveryUserId;
  const currentIntentEpoch = pushRecoveryIntentEpoch;
  const currentPreferencesGeneration = pushPreferencesGeneration;
  if (!currentUserId || notificationOptedOut()
    || typeof Notification === 'undefined' || Notification.permission !== 'granted'
    || !notificationIntentCurrent(currentIntentEpoch, currentUserId)) return;
  const now = Date.now();
  const cadence = pushRecoveryConfirmed ? PUSH_MAINTENANCE_INTERVAL_MS : PUSH_RECOVERY_RETRY_INTERVAL_MS;
  if (pushRecoveryRun || now - pushRecoveryLastAttemptAt < cadence) {
    schedulePushRecovery();
    return;
  }
  cancelPushRecoveryTimer();
  pushRecoveryLastAttemptAt = now;
  let run: Promise<void>;
  run = ensurePushSubscribed(currentUserId).then(() => {
    if (pushRecoveryUserId !== currentUserId || pushRecoveryIntentEpoch !== currentIntentEpoch
      || !notificationIntentCurrent(currentIntentEpoch, currentUserId)) return;
    if (pushPreferencesGeneration !== currentPreferencesGeneration) return;
    pushRecoveryConfirmed = true;
    pushRecoveryLastAttemptAt = Date.now();
    setSettings({ notif: true });
  }).catch(() => {
    if (pushRecoveryUserId === currentUserId && pushRecoveryIntentEpoch === currentIntentEpoch)
      pushRecoveryConfirmed = false;
  }).finally(() => {
    if (pushRecoveryRun === run) pushRecoveryRun = null;
    if (pushPreferencesGeneration !== currentPreferencesGeneration
      && pushRecoveryUserId === currentUserId && pushRecoveryIntentEpoch === currentIntentEpoch
      && notificationIntentCurrent(currentIntentEpoch, currentUserId)) {
      pushRecoveryConfirmed = false;
      pushRecoveryLastAttemptAt = 0;
      cancelPushRecoveryTimer();
      retryPushRecovery();
      return;
    }
    schedulePushRecovery();
  });
  pushRecoveryRun = run;
}

function retryPushRecoveryAfterControllerChange(): void {
  // A rolling legacy worker intentionally has no session-state ACK. As soon as the staged current
  // worker takes control, bypass maintenance cadence and confirm its durable state immediately.
  // The generation also fences a legacy request already in flight: its late success cannot mark
  // the replacement controller confirmed and the existing finally path starts a fresh run.
  pushPreferencesGeneration += 1;
  pushRecoveryConfirmed = false;
  pushRecoveryLastAttemptAt = 0;
  cancelPushRecoveryTimer();
  retryPushRecovery();
}

function resyncPushPreferences(): void {
  pushPreferencesGeneration += 1;
  if (!pushRecoveryUserId || notificationOptedOut()) return;
  // Privacy and per-kind preferences are stored on the exact endpoint. Do not wait for the normal
  // maintenance cadence after a settings change, otherwise a lock-screen banner could use stale
  // server policy for up to a minute.
  pushRecoveryConfirmed = false;
  pushRecoveryLastAttemptAt = 0;
  cancelPushRecoveryTimer();
  retryPushRecovery();
}

async function confirmCurrentPushPreferences(userId: string, intentEpoch: number): Promise<boolean> {
  // A settings event can race the backend response after push.ts captured its payload. Reconfirm a
  // bounded number of generations synchronously; continuous UI churn falls back to recovery.
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = pushPreferencesGeneration;
    await ensurePushSubscribed(userId);
    if (!notificationIntentCurrent(intentEpoch, userId)) return false;
    if (generation === pushPreferencesGeneration) return true;
  }
  return false;
}

function armPushRecovery(userId: string, intentEpoch: number, confirmed = false): void {
  if (!notificationIntentCurrent(intentEpoch, userId)) return;
  pushRecoveryUserId = userId;
  pushRecoveryIntentEpoch = intentEpoch;
  pushRecoveryConfirmed = confirmed;
  pushRecoveryLastAttemptAt = confirmed ? Date.now() : 0;
  cancelPushRecoveryTimer();
  schedulePushRecovery();
  if (!pushRecoveryInstalled && !isTauri && typeof window !== 'undefined') {
    pushRecoveryInstalled = true;
    window.addEventListener('online', retryPushRecovery);
    window.addEventListener('pageshow', retryPushRecovery);
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') retryPushRecovery();
      });
    } catch { /** document can be absent in unit/worker-like environments */ }
    try { navigator.serviceWorker?.addEventListener('controllerchange', retryPushRecoveryAfterControllerChange); } catch { /**/ }
  }
}

// запрос разрешения + включение мастера (вызывать по клику пользователя в настройках)
export async function enableNotifications(userId: string): Promise<NotificationEnableResult> {
  setNotificationOptOut(false);
  const intentEpoch = beginNotificationIntent(userId);
  const granted = await requestNotificationPermission();
  if (!notificationIntentCurrent(intentEpoch, userId)) return { enabled: false };
  if (!granted) {
    setSettings({ notif: false });
    return { enabled: false, permissionDenied: notifPermission() === 'denied' };
  }
  if (isTauri) {
    setSettings({ notif: true });
    return { enabled: true };
  }
  try {
    const preferencesCurrent = await confirmCurrentPushPreferences(userId, intentEpoch);
    if (!notificationIntentCurrent(intentEpoch, userId)) return { enabled: false };
    if (!preferencesCurrent) {
      setSettings({ notif: false });
      armPushRecovery(userId, intentEpoch);
      retryPushRecovery();
      return { enabled: false, error: 'Настройки уведомлений ещё синхронизируются' };
    }
    setSettings({ notif: true });
    armPushRecovery(userId, intentEpoch, true);
    return { enabled: true };
  } catch (error) {
    if (!notificationIntentCurrent(intentEpoch, userId)) return { enabled: false };
    setSettings({ notif: false });
    armPushRecovery(userId, intentEpoch);
    return { enabled: false, error: pushSetupErrorMessage(error) };
  }
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
export interface NotificationInitResult {
  welcomed: boolean;
  ready: boolean;
  error?: string;
}

export async function initNotifications(userId: string): Promise<NotificationInitResult> {
  const intentEpoch = beginNotificationIntent(userId);
  if (!notifSupported()) return { welcomed: false, ready: false };
  if (notificationOptedOut()) {
    setSettings({ notif: false });
    void unsubscribePush(userId); // retry any offline backend/local cleanup without blocking app boot
    return { welcomed: false, ready: false };
  }
  if (!isTauri && notifPermission() === 'denied') {
    if (getSettings().notif) setSettings({ notif: false });
    return { welcomed: false, ready: false };
  }
  const granted = await notificationPermissionGranted();
  if (!notificationIntentCurrent(intentEpoch, userId)) return { welcomed: false, ready: false };
  if (!granted) {
    if (getSettings().notif) setSettings({ notif: false });
    return { welcomed: false, ready: false };
  }
  if (!isTauri) {
    try {
      const preferencesCurrent = await confirmCurrentPushPreferences(userId, intentEpoch);
      if (!notificationIntentCurrent(intentEpoch, userId)) return { welcomed: false, ready: false };
      if (!preferencesCurrent) {
        setSettings({ notif: false });
        armPushRecovery(userId, intentEpoch);
        retryPushRecovery();
        return { welcomed: false, ready: false, error: 'Настройки уведомлений ещё синхронизируются' };
      }
    }
    catch (error) {
      if (!notificationIntentCurrent(intentEpoch, userId)) return { welcomed: false, ready: false };
      setSettings({ notif: false });
      armPushRecovery(userId, intentEpoch);
      return { welcomed: false, ready: false, error: pushSetupErrorMessage(error) };
    }
  }
  if (!notificationIntentCurrent(intentEpoch, userId)) return { welcomed: false, ready: false };
  setSettings({ notif: true });
  if (!isTauri) {
    armPushRecovery(userId, intentEpoch, true);
  }
  try {
    if (localStorage.getItem('notifWelcomed') === '1') return { welcomed: false, ready: true };
    localStorage.setItem('notifWelcomed', '1');
  } catch { /** unavailable storage may show the harmless one-time toast again after reload */ }
  return { welcomed: true, ready: true };
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
    // Point-of-use opt-out check: a frozen tab may receive queued realtime work before pageshow or
    // its missed storage event. Do this before remembering a destination, playing sound or showing
    // any banner, and reconcile the stale master switch for the rest of the UI.
    if (notificationOptedOut()) {
      if (getSettings().notif) setSettings({ notif: false });
      return false;
    }
    // A frozen/BFCache tab can receive queued realtime work before its lifecycle events are
    // delivered. Re-read the restrictive durable intersection at the point of presentation so a
    // missed storage event cannot expose content or revive a disabled device-local kind.
    const pushPrefs = getNotificationPushPrefs();
    const s = getSettings();
    const destination = rememberNotificationDestination(
      opts.tag,
      opts.destination || notificationDestinationFromTag(opts.tag),
    );
    const shownContent = notificationPresentation(kind, opts.title, opts.body, pushPrefs.notifPrivacy, opts.sender);
    const kindEnabled = kind === 'mention' ? pushPrefs.notifMention
      : kind === 'stream' ? pushPrefs.notifStream
        : !!s[KIND_PREF[kind]];
    if (!s.notif || !kindEnabled) return false; // мастер или тип выключены — тихо
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

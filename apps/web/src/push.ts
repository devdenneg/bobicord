// Web Push (VAPID) — ФОНОВЫЕ уведомления PWA/браузера: приложение свёрнуто/закрыто, включая
// iOS (где локальные уведомления в фоне не работают вообще — JS заморожен, будит только push).
// Только веб: натив (Tauri) web-push не использует — в webview нет push-сервиса.
import { isTauri } from './native';
import { api } from './api';
import { getSettings } from './settings';

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function pushSupported(): boolean {
  return !isTauri && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;
}

let vapidKey: string | null | undefined; // undefined = ещё не спрашивали, null = push выключен на сервере
async function getVapid(): Promise<string | null> {
  if (vapidKey !== undefined) return vapidKey ?? null;
  try { const r = await api.pushVapid(); vapidKey = r.enabled && r.key ? r.key : null; }
  catch { vapidKey = null; }
  return vapidKey;
}

/** Подписать (или обновить подписку + пер-типовые prefs) на web-push. Требует уже выданного
 *  разрешения на уведомления. Идемпотентно — можно звать после каждого включения/смены типа. */
export async function ensurePushSubscribed(): Promise<void> {
  if (!pushSupported()) return;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const key = await getVapid();
    if (!key) return; // сервер не отдал VAPID → push отключён на бэкенде
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) as unknown as BufferSource });
    const s = getSettings();
    await api.pushSubscribe(sub.toJSON(), { mention: !!s.notifMention, stream: !!s.notifStream });
  } catch { /* тихо: push не должен ронять поток */ }
}

/** Обновить только prefs на сервере (юзер переключил тип уведомления). */
export async function syncPushPrefs(): Promise<void> { await ensurePushSubscribed(); }

/** Отписаться от web-push (юзер выключил уведомления) — снимаем подписку и на клиенте, и на сервере. */
export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const ep = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await api.pushUnsubscribe(ep).catch(() => {});
  } catch { /* тихо */ }
}

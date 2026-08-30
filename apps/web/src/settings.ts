import type { AudioSettings, NotificationPrivacy } from './types';

export const NOTIFICATION_PUSH_PREFS_CHANGED_EVENT = 'relay-notification-push-prefs-changed';
const NOTIFICATION_PRIVACY_VALUES = new Set<NotificationPrivacy>(['full', 'sender', 'hidden']);

function normalizedNotificationPrivacy(value: unknown, missing: NotificationPrivacy = 'hidden'): NotificationPrivacy {
  if (value === undefined) return missing;
  return typeof value === 'string' && NOTIFICATION_PRIVACY_VALUES.has(value as NotificationPrivacy)
    ? value as NotificationPrivacy
    : 'hidden';
}

function mostRestrictiveNotificationPrivacy(a: NotificationPrivacy, b: NotificationPrivacy): NotificationPrivacy {
  const rank: Record<NotificationPrivacy, number> = { full: 0, sender: 1, hidden: 2 };
  return rank[a] >= rank[b] ? a : b;
}

// keybinds пустые по умолчанию (пользователь сам назначает) + глобальный хук вне приложения
// выключен по умолчанию (disableGlobalHotkeys=true) — см. HK_RESET_V в App.tsx для форс-сброса
// уже настроивших аккаунтов.
const DEF: AudioSettings = { input: '', output: '', nsMode: 'rnnoise', ec: true, agc: true, mode: 'voice', pttKey: 'KeyV', master: 100, sensitivity: 10, sensitivityAuto: true, notifyVolume: 60, notif: false, notifMention: true, notifStream: true, notifUpdate: true, notifPrivacy: 'full', shareGame: true, keybinds: { muteMic: [], deafen: [] }, disableGlobalHotkeys: true };
let stored: Partial<AudioSettings> = {};
let storedSettingsCorruptOrUnreadable = false;
const storedPushPrefsPresent = { notifPrivacy: false, notifMention: false, notifStream: false };
try {
  const raw = localStorage.getItem('audioSettings');
  if (raw !== null) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stored = parsed;
      for (const key of Object.keys(storedPushPrefsPresent) as Array<keyof typeof storedPushPrefsPresent>) {
        storedPushPrefsPresent[key] = Object.prototype.hasOwnProperty.call(parsed, key);
      }
    } else storedSettingsCorruptOrUnreadable = true;
  }
} catch { storedSettingsCorruptOrUnreadable = true; }
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
if (storedSettingsCorruptOrUnreadable) {
  s.notifPrivacy = 'hidden';
  s.notifMention = false;
  s.notifStream = false;
} else {
  s.notifPrivacy = storedPushPrefsPresent.notifPrivacy
    ? normalizedNotificationPrivacy(s.notifPrivacy)
    : DEF.notifPrivacy;
  s.notifMention = storedPushPrefsPresent.notifMention
    ? (typeof s.notifMention === 'boolean' ? s.notifMention : false)
    : DEF.notifMention;
  s.notifStream = storedPushPrefsPresent.notifStream
    ? (typeof s.notifStream === 'boolean' ? s.notifStream : false)
    : DEF.notifStream;
}
// Миграция: раньше можно было выбрать enumerated-алиас 'default'/'communications' (Chrome-псевдо-
// устройства) — теперь пикер их прячет (см. audioDevices.audioDeviceChoices). Эти значения эквивалентны
// системному по умолчанию, нормализуем в '' — иначе после дедупа пикер покажет «ничего не выбрано».
// Поведение звука не меняется ('' и 'default' одинаково следуют за системным устройством).
if (s.input === 'default' || s.input === 'communications') s.input = '';
if (s.output === 'default' || s.output === 'communications') s.output = '';
const subs = new Set<() => void>();
let notificationPrivacySyncAuthorized = false;
export interface NotificationPushPrefs {
  notifPrivacy: NotificationPrivacy;
  notifMention: boolean;
  notifStream: boolean;
}
const notificationPushPrefsDirty: Record<keyof NotificationPushPrefs, boolean> = {
  notifPrivacy: false,
  notifMention: false,
  notifStream: false,
};

function notificationPushPrefsFromStorageValue(raw: string | null): NotificationPushPrefs {
  if (raw === null) return {
    notifPrivacy: DEF.notifPrivacy,
    notifMention: DEF.notifMention,
    notifStream: DEF.notifStream,
  };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid settings');
    const booleanPref = (key: 'notifMention' | 'notifStream', fallback: boolean): boolean => {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) return fallback;
      return typeof parsed[key] === 'boolean' ? parsed[key] : false;
    };
    return {
      notifPrivacy: normalizedNotificationPrivacy(
        Object.prototype.hasOwnProperty.call(parsed, 'notifPrivacy') ? parsed.notifPrivacy : undefined,
        DEF.notifPrivacy,
      ),
      notifMention: booleanPref('notifMention', DEF.notifMention),
      notifStream: booleanPref('notifStream', DEF.notifStream),
    };
  } catch {
    return { notifPrivacy: 'hidden', notifMention: false, notifStream: false };
  }
}

function durableNotificationPushPrefs(): NotificationPushPrefs {
  try { return notificationPushPrefsFromStorageValue(localStorage.getItem('audioSettings')); }
  catch { return { notifPrivacy: 'hidden', notifMention: false, notifStream: false }; }
}

function dispatchNotificationPushPrefsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_PUSH_PREFS_CHANGED_EVENT, {
      detail: { privacy: s.notifPrivacy, mention: s.notifMention, stream: s.notifStream },
    }));
  } catch { /** window can be absent during tests/server rendering */ }
}

function syncNotificationPrivacyToWorker(): void {
  try {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.controller?.postMessage({
      type: 'set-notification-privacy',
      privacy: notificationPrivacySyncAuthorized ? s.notifPrivacy : 'hidden',
    });
  } catch { /** service worker is optional */ }
}

/** Called only after the exact account endpoint/preferences have been confirmed by the backend. */
export function authorizeNotificationPrivacySync(): void {
  notificationPrivacySyncAuthorized = true;
  syncNotificationPrivacyToWorker();
}

/** Keeps both current and rolling legacy workers fail-closed through logout/anonymous boot. */
export function revokeNotificationPrivacySync(): void {
  notificationPrivacySyncAuthorized = false;
  syncNotificationPrivacyToWorker();
}

function applyNotificationPushPrefs(next: NotificationPushPrefs, announce = true): void {
  const privacyChanged = next.notifPrivacy !== s.notifPrivacy;
  const changed = privacyChanged || next.notifMention !== s.notifMention || next.notifStream !== s.notifStream;
  if (!changed) return;
  s = { ...s, ...next };
  if (privacyChanged) syncNotificationPrivacyToWorker();
  if (announce) dispatchNotificationPushPrefsChanged();
  subs.forEach((f) => f());
}

function effectiveNotificationPushPrefs(): NotificationPushPrefs {
  const durable = durableNotificationPushPrefs();
  return {
    // A failed local write owns only a more restrictive floor. A frozen tab may have missed a
    // later durable choice from another tab, so an unpersisted `full`/enabled value must never
    // overrule durable hidden/disabled preferences when the page resumes.
    notifPrivacy: notificationPushPrefsDirty.notifPrivacy
      ? mostRestrictiveNotificationPrivacy(s.notifPrivacy, durable.notifPrivacy)
      : durable.notifPrivacy,
    notifMention: notificationPushPrefsDirty.notifMention
      ? s.notifMention && durable.notifMention
      : durable.notifMention,
    notifStream: notificationPushPrefsDirty.notifStream
      ? s.notifStream && durable.notifStream
      : durable.notifStream,
  };
}

function reconcileNotificationPushPrefsFromStorage(): void {
  applyNotificationPushPrefs(effectiveNotificationPushPrefs());
}

function notificationPrivacyControllerChanged(): void {
  // A frozen/BFCache tab can miss `storage`. Re-read the durable value before it tells a new worker
  // anything, unless this tab owns an explicit choice that storage refused to persist.
  reconcileNotificationPushPrefsFromStorage();
  syncNotificationPrivacyToWorker();
}

function notificationPrivacyStorageChanged(event: StorageEvent): void {
  if (event.key !== 'audioSettings') return;
  const external = notificationPushPrefsFromStorageValue(event.newValue);
  applyNotificationPushPrefs({
    notifPrivacy: notificationPushPrefsDirty.notifPrivacy
      ? mostRestrictiveNotificationPrivacy(s.notifPrivacy, external.notifPrivacy)
      : external.notifPrivacy,
    notifMention: notificationPushPrefsDirty.notifMention
      ? s.notifMention && external.notifMention
      : external.notifMention,
    notifStream: notificationPushPrefsDirty.notifStream
      ? s.notifStream && external.notifStream
      : external.notifStream,
  });
}

syncNotificationPrivacyToWorker();
try {
  navigator.serviceWorker?.addEventListener('controllerchange', notificationPrivacyControllerChanged);
} catch { /** service worker is optional */ }
try {
  window.addEventListener('storage', notificationPrivacyStorageChanged);
  window.addEventListener('pageshow', reconcileNotificationPushPrefsFromStorage);
} catch { /** window is optional */ }
try {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileNotificationPushPrefsFromStorage();
  });
} catch { /** document is optional */ }

export const getSettings = (): AudioSettings => s;
/** Exact prefs for backend persistence, including storage changes missed by a frozen tab. */
export function getNotificationPushPrefs(): NotificationPushPrefs {
  const next = effectiveNotificationPushPrefs();
  applyNotificationPushPrefs(next, false);
  return next;
}
export function setSettings(patch: Partial<AudioSettings>): void {
  const previous = s;
  const writes = {
    notifPrivacy: Object.prototype.hasOwnProperty.call(patch, 'notifPrivacy'),
    notifMention: Object.prototype.hasOwnProperty.call(patch, 'notifMention'),
    notifStream: Object.prototype.hasOwnProperty.call(patch, 'notifStream'),
  };
  const effective = effectiveNotificationPushPrefs();
  const base = {
    ...s,
    notifPrivacy: writes.notifPrivacy ? s.notifPrivacy : effective.notifPrivacy,
    notifMention: writes.notifMention ? s.notifMention : effective.notifMention,
    notifStream: writes.notifStream ? s.notifStream : effective.notifStream,
  };
  const nextPatch = {
    ...patch,
    ...(writes.notifPrivacy ? { notifPrivacy: normalizedNotificationPrivacy(patch.notifPrivacy) } : {}),
    ...(writes.notifMention ? { notifMention: typeof patch.notifMention === 'boolean' ? patch.notifMention : false } : {}),
    ...(writes.notifStream ? { notifStream: typeof patch.notifStream === 'boolean' ? patch.notifStream : false } : {}),
  };
  s = { ...base, ...nextPatch };
  let persisted = false;
  try { localStorage.setItem('audioSettings', JSON.stringify(s)); persisted = true; } catch { /** in-memory state remains authoritative */ }
  if (persisted) {
    notificationPushPrefsDirty.notifPrivacy = false;
    notificationPushPrefsDirty.notifMention = false;
    notificationPushPrefsDirty.notifStream = false;
  } else {
    if (writes.notifPrivacy) notificationPushPrefsDirty.notifPrivacy = true;
    if (writes.notifMention) notificationPushPrefsDirty.notifMention = true;
    if (writes.notifStream) notificationPushPrefsDirty.notifStream = true;
    // Re-apply the durable floor after a rejected write. This retains failed restrictive choices,
    // while a failed attempt to expose content cannot escape a stricter cross-tab value.
    s = { ...s, ...effectiveNotificationPushPrefs() };
  }
  const privacyChanged = previous.notifPrivacy !== s.notifPrivacy;
  const pushPrefsChanged = privacyChanged
    || previous.notifMention !== s.notifMention
    || previous.notifStream !== s.notifStream;
  if (privacyChanged) syncNotificationPrivacyToWorker();
  if (pushPrefsChanged) dispatchNotificationPushPrefsChanged();
  subs.forEach((f) => f());
}
export function subscribeSettings(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

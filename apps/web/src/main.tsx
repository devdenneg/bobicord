import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { PASSWORD_RESET_STORAGE_KEY, rememberPendingInvite, rememberPendingOpenServer, useStore } from './store';
import { api, getToken, hasSessionCandidate, isApiError } from './api';
import { subscribeAccessTokenChanges } from './authSession';
import { loadGlobalEmotes } from './emotes';
import { isTauri, pingNative } from './native';
import { watchForUpdates } from './version';
import { checkNativeUpdate, startNativeUpdatePolling } from './nativeUpdate';
import { applyStoredTheme } from './theme';
import { startWindowIdleWatch } from './windowIdle';
import {
  NOTIFICATION_DESTINATION_EVENT,
  TAURI_NOTIFICATION_DESTINATION_EVENT,
  forgetNotificationDestination,
  normalizeNotificationDestination,
  queueNotificationDestination,
  resolveNotificationDestination,
  type NotificationDestination,
} from './notificationDestination';
import { closeShownPushNotifications } from './notificationBanners';

applyStoredTheme(); // применить сохранённую тему до первого рендера
loadGlobalEmotes();

// localStorage is shared by tabs but persistent access tokens are intentionally memory-only.
// When another tab begins explicit logout, reload this stale UI into the fenced boot path instead
// of leaving a server/chat screen visible with an already removed credential.
subscribeAccessTokenChanges((change) => {
  if (change.reason === 'remote-logout' || change.reason === 'terminal-revocation') location.reload();
});

function openQueuedNotificationDestination(destination: NotificationDestination): void {
  const state = useStore.getState();
  if (state.me) {
    void state.openServer(destination.serverId, undefined, 'main');
  } else {
    // acceptSession consumes this legacy key after authentication; the exact message remains in
    // notificationDestination storage until the matching ServerView is ready.
    rememberPendingOpenServer(destination.serverId);
  }
}

window.addEventListener(NOTIFICATION_DESTINATION_EVENT, (event) => {
  const destination = normalizeNotificationDestination((event as CustomEvent).detail);
  if (destination) openQueuedNotificationDestination(destination);
});

function receiveNotificationDestination(value: unknown): void {
  const raw = value && typeof value === 'object' ? value as { tag?: unknown } : {};
  const tag = typeof raw.tag === 'string' ? raw.tag : '';
  const destination = resolveNotificationDestination(tag, value);
  if (destination) queueNotificationDestination(destination);
  if (tag) forgetNotificationDestination(tag);
}

// Shell PWA версионирован прямо внутри собранного worker; cache bypass дополнительно
// не даёт iOS/Chrome смешать index и хешированные файлы разных релизов.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  // клик по push → SW передаёт точное назначение; legacy open-server тоже поддерживается.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = (e.data || {}) as { type?: string; serverId?: string; messageId?: number; tag?: string };
    let destinationAccepted = false;
    if ((d.type === 'open-destination' || d.type === 'open-server') && d.serverId) {
      receiveNotificationDestination(d);
      destinationAccepted = true;
    } else if (d.type === 'forget-notification-destination' && d.tag) {
      forgetNotificationDestination(d.tag, false);
    }
    if (destinationAccepted) {
      try { e.ports?.[0]?.postMessage({ ok: true }); } catch { /** worker falls back to navigation */ }
    }
  });
  // Видимый boot тоже обязан убрать баннеры прошлого аккаунта/предыдущего запуска; ждать первого
  // visibilitychange нельзя, потому что на уже открытой странице его может никогда не быть.
  const closeVisiblePushBanners = () => {
    if (document.visibilityState !== 'visible') return;
    void closeShownPushNotifications();
  };
  document.addEventListener('visibilitychange', closeVisiblePushBanners);
  closeVisiblePushBanners();
}
if (isTauri) {
  void import('@tauri-apps/api/event').then(({ listen }) => (
    listen(TAURI_NOTIFICATION_DESTINATION_EVENT, (event) => receiveNotificationDestination(event.payload))
  )).catch(() => {});
}
if (isTauri) pingNative().then((r) => console.log('[native] ipc bridge:', r)).catch(() => {});

startWindowIdleWatch(); // до первой отрисовки: если окно открыто в фоне, анимации не должны стартовать вовсе
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
watchForUpdates();
checkNativeUpdate(); // разовая проверка на старте
startNativeUpdatePolling(); // + периодическая проверка (5 мин), баннер всегда показывает актуальную версию

function passwordResetTokenFromHash(): string {
  const fragment = location.hash.replace(/^#/, '');
  if (!fragment) return '';
  const query = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
  const params = new URLSearchParams(query);
  return params.get('reset') || params.get('resetToken') || params.get('token') || '';
}

const PASSWORD_RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function storedPasswordResetToken(): string {
  try {
    const token = sessionStorage.getItem(PASSWORD_RESET_STORAGE_KEY) || '';
    if (PASSWORD_RESET_TOKEN_RE.test(token)) return token;
    if (token) sessionStorage.removeItem(PASSWORD_RESET_STORAGE_KEY);
  } catch { /* storage can be disabled */ }
  return '';
}

function cleanEntryUrl(removeHash = false) {
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  url.searchParams.delete('server');
  url.searchParams.delete('message');
  if (removeHash) url.hash = '';
  history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + (url.hash || ''));
}

// boot: resume session + handle invite/reset deep-links
(async function boot() {
  // Explicit offline logout leaves a non-secret local fence. Finish cookie
  // revocation opportunistically, but never wait for network before showing auth.
  void api.drainPendingLogout();
  const resetFragment = passwordResetTokenFromHash();
  const resetToken = PASSWORD_RESET_TOKEN_RE.test(resetFragment) ? resetFragment : storedPasswordResetToken();
  if (resetFragment) cleanEntryUrl(true);
  if (resetToken) {
    // Reset endpoints are explicitly public, so keep any existing session until the link is
    // validated and the password really changes. A random syntactically valid fragment must not
    // be able to log out the person who clicked it.
    useStore.getState().setPasswordResetToken(resetToken);
    useStore.setState({ view: 'auth', accountGate: null, pendingUser: null, sessionError: '' });
    return;
  }
  const invite = new URLSearchParams(location.search).get('invite');
  const openSrv = new URLSearchParams(location.search).get('server'); // клик по push открыл /?server=<id>
  const openMessage = Number(new URLSearchParams(location.search).get('message'));
  if (invite) rememberPendingInvite(invite);
  else if (openSrv) {
    receiveNotificationDestination({
      serverId: openSrv,
      ...(Number.isSafeInteger(openMessage) && openMessage > 0 ? { messageId: openMessage } : {}),
    });
  }
  if (invite || openSrv) cleanEntryUrl();
  if (hasSessionCandidate()) {
    try {
      const persistent = await api.resumePersistentSession();
      if (persistent) {
        await useStore.getState().acceptSession(persistent.user, persistent.account);
        return;
      }
      if (!getToken()) {
        useStore.setState({ view: 'auth', sessionError: '' });
        return;
      }
      const session = await api.authSession();
      await useStore.getState().acceptSession(session.user, session.account);
    } catch (error) {
      if (isApiError(error) && (error.status === 404 || error.status === 410)) {
        // Desktop/web releases can briefly lead the API rollout. The pre-email server has no
        // /auth/session yet, but /me still validates the same saved bearer token.
        try {
          const legacy = await api.me();
          await useStore.getState().acceptSession(legacy.user, { state: 'ready' });
          return;
        } catch (legacyError) {
          if (isApiError(legacyError) && legacyError.status === 401) {
            // Migration never destroys a saved bearer on an ambiguous/failed
            // upgrade. The user can retry or explicitly choose another account.
            useStore.setState({
              view: 'auth', accountGate: null, pendingUser: null,
              sessionError: 'Сохранённый вход не подтверждён. Повторите проверку или войдите в другой аккаунт.',
            });
            return;
          }
          useStore.setState({
            view: 'auth', accountGate: null, pendingUser: null,
            sessionError: legacyError instanceof Error ? legacyError.message : 'Не удалось проверить сессию',
          });
          return;
        }
      }
      if (isApiError(error) && error.status === 401) {
        if (getToken()) {
          // A rejected legacy upgrade is not proof that a rolling old instance
          // would reject the same bearer; preserve it until user action.
          useStore.setState({
            view: 'auth', accountGate: null, pendingUser: null,
            sessionError: 'Не удалось подтвердить сохранённый вход. Повторите попытку.',
          });
        } else {
          useStore.setState({ view: 'auth', sessionError: '', accountGate: null, pendingUser: null });
        }
      } else {
        // A network outage is not proof that the session expired. Keep the token and offer an explicit retry.
        useStore.setState({
          view: 'auth', accountGate: null, pendingUser: null,
          sessionError: error instanceof Error ? error.message : 'Не удалось проверить сессию',
        });
      }
    }
  } else {
    useStore.setState({ view: 'auth', sessionError: '' });
  }
})();

window.addEventListener('online', () => { void api.drainPendingLogout(); });

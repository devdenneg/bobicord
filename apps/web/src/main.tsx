import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { PASSWORD_RESET_STORAGE_KEY, useStore } from './store';
import { api, getToken, isApiError, setToken } from './api';
import { loadGlobalEmotes } from './emotes';
import { isTauri, pingNative } from './native';
import { watchForUpdates } from './version';
import { checkNativeUpdate, startNativeUpdatePolling } from './nativeUpdate';
import { applyStoredTheme } from './theme';
import {
  NOTIFICATION_DESTINATION_EVENT,
  TAURI_NOTIFICATION_DESTINATION_EVENT,
  normalizeNotificationDestination,
  queueNotificationDestination,
  resolveNotificationDestination,
  type NotificationDestination,
} from './notificationDestination';

applyStoredTheme(); // применить сохранённую тему до первого рендера
loadGlobalEmotes();

function openQueuedNotificationDestination(destination: NotificationDestination): void {
  const state = useStore.getState();
  if (state.me) {
    void state.openServer(destination.serverId, undefined, 'main');
  } else {
    // acceptSession consumes this legacy key after authentication; the exact message remains in
    // notificationDestination storage until the matching ServerView is ready.
    try { sessionStorage.setItem('pendingOpenServer', destination.serverId); } catch { /**/ }
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
}

// SW для установки PWA. НЕ кэширует (кэш ранее ронял прод); старые кэши чистятся внутри sw.js.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // клик по push → SW передаёт точное назначение; legacy open-server тоже поддерживается.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = (e.data || {}) as { type?: string; serverId?: string; messageId?: number; tag?: string };
    if ((d.type === 'open-destination' || d.type === 'open-server') && d.serverId) receiveNotificationDestination(d);
  });
  // вернулись в фокус → чистим показанные push-баннеры (юзер уже в приложении, непрочитанное видно в чате)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    navigator.serviceWorker.ready.then((reg) => reg.getNotifications().then((ns) => ns.forEach((n) => n.close()))).catch(() => {});
  });
}
if (isTauri) {
  void import('@tauri-apps/api/event').then(({ listen }) => (
    listen(TAURI_NOTIFICATION_DESTINATION_EVENT, (event) => receiveNotificationDestination(event.payload))
  )).catch(() => {});
}
if (isTauri) pingNative().then((r) => console.log('[native] ipc bridge:', r)).catch(() => {});

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
watchForUpdates();
checkNativeUpdate(); // разовая проверка на старте
startNativeUpdatePolling(30_000); // + поллинг раз в 30с, стоп после первой находки

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
  if (invite) sessionStorage.setItem('pendingInvite', invite);
  else if (openSrv) {
    receiveNotificationDestination({
      serverId: openSrv,
      ...(Number.isSafeInteger(openMessage) && openMessage > 0 ? { messageId: openMessage } : {}),
    });
  }
  if (invite || openSrv) cleanEntryUrl();
  if (getToken()) {
    try {
      const d = await api.authSession();
      await useStore.getState().acceptSession(d.user, d.account);
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
            setToken(null);
            useStore.setState({ view: 'auth', sessionError: '', accountGate: null, pendingUser: null });
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
        setToken(null);
        useStore.setState({ view: 'auth', sessionError: '', accountGate: null, pendingUser: null });
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

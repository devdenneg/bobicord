import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { useStore } from './store';
import { api, getToken, setToken } from './api';
import { loadGlobalEmotes } from './emotes';
import { isTauri, pingNative } from './native';
import { watchForUpdates } from './version';
import { checkNativeUpdate, startNativeUpdatePolling } from './nativeUpdate';
import { applyStoredTheme } from './theme';

applyStoredTheme(); // применить сохранённую тему до первого рендера
loadGlobalEmotes();
// SW для установки PWA. НЕ кэширует (кэш ранее ронял прод); старые кэши чистятся внутри sw.js.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // клик по push → SW шлёт open-server → открываем нужный сервер
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = (e.data || {}) as { type?: string; serverId?: string };
    if (d.type === 'open-server' && d.serverId) { try { useStore.getState().openServer(d.serverId); } catch { /**/ } }
  });
  // вернулись в фокус → чистим показанные push-баннеры (юзер уже в приложении, непрочитанное видно в чате)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    navigator.serviceWorker.ready.then((reg) => reg.getNotifications().then((ns) => ns.forEach((n) => n.close()))).catch(() => {});
  });
}
if (isTauri) pingNative().then((r) => console.log('[native] ipc bridge:', r)).catch(() => {});

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
watchForUpdates();
checkNativeUpdate(); // разовая проверка на старте
startNativeUpdatePolling(30_000); // + поллинг раз в 30с, стоп после первой находки

// boot: resume session + handle invite deep-link
(async function boot() {
  const invite = new URLSearchParams(location.search).get('invite');
  const openSrv = new URLSearchParams(location.search).get('server'); // клик по push открыл /?server=<id>
  if (getToken()) {
    try {
      const d = await api.me();
      await useStore.getState().afterAuth(d.user);
      if (invite) { history.replaceState({}, '', location.pathname); useStore.getState().setModal('join', invite); }
      else if (openSrv) { history.replaceState({}, '', location.pathname); useStore.getState().openServer(openSrv); }
    } catch {
      setToken(null);
      if (invite) sessionStorage.setItem('pendingInvite', invite);
      useStore.setState({ view: 'auth' });
    }
  } else {
    if (invite) sessionStorage.setItem('pendingInvite', invite);
    useStore.setState({ view: 'auth' });
  }
})();

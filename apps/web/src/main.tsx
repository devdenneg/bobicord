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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (isTauri) pingNative().then((r) => console.log('[native] ipc bridge:', r)).catch(() => {});

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
watchForUpdates();
checkNativeUpdate(); // разовая проверка на старте
startNativeUpdatePolling(30_000); // + поллинг раз в 30с, стоп после первой находки

// boot: resume session + handle invite deep-link
(async function boot() {
  const invite = new URLSearchParams(location.search).get('invite');
  if (getToken()) {
    try {
      const d = await api.me();
      await useStore.getState().afterAuth(d.user);
      if (invite) { history.replaceState({}, '', location.pathname); useStore.getState().setModal('join', invite); }
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

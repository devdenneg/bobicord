import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { useStore } from './store';
import { api, getToken, setToken } from './api';
import { loadGlobalEmotes } from './emotes';

loadGlobalEmotes();
// SW отключён: залипший service worker/кэш ронял Chrome на проде. Разрегистрируем всё и чистим кэши.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
}
if ('caches' in window) { caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {}); }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

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

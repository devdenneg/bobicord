import { useStore } from './store';
import { playSound } from './sounds';

// Детект нового деплоя: сравниваем хэш JS-бандла в index.html с текущим загруженным.
// index.html отдаётся с no-store, при деплое хэш ассета меняется.
export function watchForUpdates() {
  const cur = Array.from(document.querySelectorAll('script[src]'))
    .map((s) => s.getAttribute('src') || '')
    .find((s) => s.includes('/assets/index-'));
  if (!cur) return; // dev-режим — хэшированных ассетов нет, нечего сравнивать

  const check = async () => {
    if (useStore.getState().updateReady) return;
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const m = html.match(/\/assets\/index-[\w-]+\.js/);
      if (m && m[0] !== cur) { useStore.setState({ updateReady: true }); playSound('system'); }
    } catch { /* оффлайн — пропускаем */ }
  };

  window.setInterval(check, 45000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

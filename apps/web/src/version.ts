import { useStore } from './store';
import { playSound } from './sounds';
import { notify } from './notify';
import { appEntryFromHtml, appEntryFromSources } from './versionEntry';

// Детект нового деплоя: сравниваем хэш JS-бандла в index.html с текущим загруженным.
// index.html отдаётся с no-store, при деплое хэш ассета меняется.
export function watchForUpdates() {
  const cur = appEntryFromSources(Array.from(document.querySelectorAll('script[type="module"][src]'))
    .map((s) => s.getAttribute('src') || ''));
  if (!cur) return; // dev-режим — хэшированных ассетов нет, нечего сравнивать

  const check = async () => {
    if (useStore.getState().updateReady) return;
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const next = appEntryFromHtml(html);
      if (next && next !== cur) { useStore.setState({ updateReady: true }); playSound('system'); notify('update', { title: 'Вышло обновление', body: 'Обнови страницу, чтобы применить', tag: 'update' }); }
    } catch { /* оффлайн — пропускаем */ }
  };

  window.setInterval(check, 45000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

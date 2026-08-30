import { useStore } from './store';
import { playSound } from './sounds';
import { notify } from './notify';
import { appEntryFromHtml, appEntryFromSources } from './versionEntry';

const UPDATE_CHECK_TIMEOUT_MS = 10_000;

// Детект нового деплоя: сравниваем хэш JS-бандла в index.html с текущим загруженным.
// index.html отдаётся с no-store, при деплое хэш ассета меняется.
export function watchForUpdates() {
  const cur = appEntryFromSources(Array.from(document.querySelectorAll('script[type="module"][src]'))
    .map((s) => s.getAttribute('src') || ''));
  if (!cur) return; // dev-режим — хэшированных ассетов нет, нечего сравнивать

  let checking: Promise<void> | null = null;
  const check = (): Promise<void> => {
    if (useStore.getState().updateReady) return Promise.resolve();
    if (checking) return checking;
    const run = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? window.setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS) : null;
      try {
        const response = await fetch('/', { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
        const html = await response.text();
        const next = appEntryFromHtml(html);
        if (next && next !== cur) { useStore.setState({ updateReady: true }); playSound('system'); notify('update', { title: 'Вышло обновление', body: 'Обнови страницу, чтобы применить', tag: 'update' }); }
      } catch { /* оффлайн/таймаут — следующий foreground или интервал повторит */ }
      finally { if (timer !== null) window.clearTimeout(timer); }
    })();
    checking = run;
    void run.finally(() => { if (checking === run) checking = null; });
    return run;
  };

  window.setInterval(() => { void check(); }, 45000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
  // iOS can restore a browser tab or standalone PWA through BFCache without a new visibility event.
  window.addEventListener('pageshow', () => { if (!document.hidden) void check(); });
}

// Кастомное нативное уведомление (окно Tauri) — своя карточка в стиле приложения вместо
// системного toast. Окно создаётся из главного (см. notify.ts): прозрачное, без рамки, поверх
// всех, non-focus, в правом нижнем углу. Здесь — рендер + самоуправление (авто-скрытие с
// прогресс-баром, пауза на hover, клик → фокус главного). Лёгкая точка входа, без бандла приложения.
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import '@fontsource-variable/onest';

type Kind = 'mention' | 'stream' | 'update';
const p = new URLSearchParams(location.search);
const kind = (p.get('k') as Kind) || 'mention';
const title = p.get('t') || 'RelayApp';
const body = p.get('b') || '';
const tag = p.get('tag') || '';
const serverId = p.get('server') || '';
const parsedMessageId = Number(p.get('message'));
const messageId = Number.isSafeInteger(parsedMessageId) && parsedMessageId > 0 ? parsedMessageId : undefined;
const DURATION = kind === 'update' ? 9000 : 6000;

// Тема окна — та же, что у главного (общий localStorage одного origin): тёмная/светлая + акцент.
const theme = (() => {
  let mode = 'dark', accent = 'sage';
  try { mode = localStorage.getItem('theme') || 'dark'; accent = localStorage.getItem('accent') || 'sage'; } catch { /* приватный режим */ }
  if (mode === 'system') mode = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return { light: mode === 'light', accent };
})();
const ACCENT: Record<string, [string, string]> = {
  sage: ['#8cc2ae', '#2e7461'], lavender: ['#b4a7e0', '#5e4fa8'], sky: ['#92b4e3', '#2f649f'], peach: ['#e8b08f', '#9a5530'],
};
const C = theme.light
  ? { bg: '#ffffff', line: '#dfe2dd', txt: '#1b1e1c', muted: '#5e675f', raised: '#eceeea', live: '#b04a35', liveSoft: '#f8e6e1', accent: (ACCENT[theme.accent] || ACCENT.sage)[1], soft: '#e3efea', shadow: '0 18px 44px rgba(27,30,28,.16)' }
  : { bg: '#171a19', line: '#2a2f2d', txt: '#f4f5f1', muted: '#959c96', raised: '#1f2321', live: '#ee9a86', liveSoft: '#33231f', accent: (ACCENT[theme.accent] || ACCENT.sage)[0], soft: '#22302b', shadow: '0 18px 44px rgba(0,0,0,.5)' };

// Глифы — из набора иконок приложения (линия currentColor).
const GLYPH = {
  chat: '<svg viewBox="20.03 20.97 47.92 47.92" fill="none" stroke="currentColor" stroke-width="3.69" stroke-linecap="round" stroke-linejoin="round"><path d="m54.95 29.47h-22.23c-3.75 0-6.7 2.94-6.7 6.77v12.65c0 2.83 1.85 5.2 4.34 5.97 0.16 0.06 0.24 0.19 0.24 0.35v4.5c0 0.66 0.86 0.9 1.43 0.43l4.68-4.16c0.51-0.46 1.17-0.74 1.88-0.74h17.7c3.14 0 5.67-2.52 5.67-5.73v-13.2c0-3.79-3.14-6.84-7.01-6.84z"/></svg>',
  screen: '<svg viewBox="14.14 15.17 51.71 51.71" fill="none" stroke="currentColor" stroke-width="3.99" stroke-linecap="round" stroke-linejoin="round"><path d="m56.83 22.73h-33.75c-1.39 0-2.48 1.06-2.48 2.39v22.32c0 1.34 1.13 2.41 2.48 2.41h33.75c1.37 0 2.55-1.05 2.55-2.41v-22.32c0-1.33-1.16-2.39-2.55-2.39z"/><path d="m36.22 49.98v6.38"/><path d="m43.81 49.98v6.38"/><path d="m47.53 56.37h-15.12c-0.88 0-1.53 0.6-1.53 1.44s0.69 1.51 1.53 1.51h15.12c0.89 0 1.58-0.63 1.58-1.51 0-0.84-0.71-1.44-1.58-1.44z"/><path d="m40.03 43.27v-12.88"/><path d="m34.58 35.67 5.4-5.35h0.07l5.37 5.35"/></svg>',
  update: '<svg viewBox="13.74 13.17 53.67 53.67" fill="none" stroke="currentColor" stroke-width="4.14" stroke-linecap="round" stroke-linejoin="round"><path d="m50.7 39.07c-6.48-0.93-10.14-5.62-10.41-11.54-0.02-0.51-0.67-0.51-0.69 0-0.31 6.08-4.19 10.66-9.99 11.49-0.48 0.07-0.45 0.72 0 0.79 6.11 0.95 9.68 5.22 10.12 11.17 0.04 0.51 0.7 0.51 0.73 0 0.41-6.21 4.44-10.5 10.23-11.21 0.5-0.06 0.47-0.64 0.01-0.7z"/><path d="m59.17 26.58c-3.6-0.46-5.53-2.94-5.75-6.39-0.02-0.41-0.53-0.41-0.56 0-0.25 3.63-2.39 6.01-5.67 6.38-0.37 0.04-0.35 0.4 0 0.44 3.49 0.4 5.5 2.62 5.8 6.15 0.04 0.41 0.53 0.4 0.55 0 0.25-3.6 2.42-5.9 5.63-6.17 0.39-0.03 0.35-0.37 0-0.41z"/><path d="m34.94 53.11c-3.79-0.52-5.79-2.92-6.12-6.39-0.04-0.44-0.55-0.42-0.58 0-0.34 3.71-2.71 6.06-6.31 6.39-0.33 0.03-0.28 0.41 0 0.43 3.71 0.31 5.98 2.62 6.34 6.27 0.05 0.44 0.56 0.42 0.59 0 0.33-3.76 2.6-6.06 6.04-6.27 0.34-0.02 0.31-0.39 0.04-0.43z"/></svg>',
  close: '<svg viewBox="11.14 13.46 57.49 57.49" fill="none" stroke="currentColor" stroke-width="4.43" stroke-linecap="round"><path d="m24.31 26.64 31.14 31.13"/><path d="m55.45 26.64-31.14 31.13"/></svg>',
};

// Пресеты типа: подпись, цвет, глиф. Сразу видно, ЧТО за событие.
const KIND: Record<Kind, { label: string; accent: string; soft: string; glyph: string }> = {
  mention: { label: 'Упоминание', accent: C.accent, soft: C.soft, glyph: GLYPH.chat },
  stream: { label: 'Трансляция', accent: C.live, soft: C.liveSoft, glyph: GLYPH.screen },
  update: { label: 'Обновление', accent: C.accent, soft: C.soft, glyph: GLYPH.update },
};
const cfg = KIND[kind] || KIND.mention;

// пастельные аватары — те же 8 оттенков, что в приложении (util.ts AV_COLORS)
const AV = ['#afb8e6', '#a8d5b5', '#e9cf8f', '#e8b7c4', '#c8b8e8', '#9ed3d3', '#edb4a3', '#e3d89a'];
function hueOf(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
const isMention = kind === 'mention';
const avBg = isMention ? AV[hueOf(title) % AV.length] : cfg.soft;
const initial = (title.trim()[0] || '•').toUpperCase();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const avContent = isMention ? esc(initial) : cfg.glyph;

document.head.insertAdjacentHTML('beforeend', `<style>
  :root { color-scheme: ${theme.light ? 'light' : 'dark'}; }
  * { margin: 0; box-sizing: border-box; }
  html, body { height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; user-select: none;
    font-family: 'Onest Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif; cursor: default; }
  @keyframes in  { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }
  @keyframes bar { from { transform: scaleX(1) } to { transform: scaleX(0) } }
  #card {
    position: fixed; inset: 8px; display: flex; align-items: center; gap: 12px;
    padding: 12px 14px; border-radius: 16px; overflow: hidden; cursor: pointer;
    background: ${C.bg}; border: 1px solid ${C.line}; box-shadow: ${C.shadow};
    animation: in .24s cubic-bezier(.16, 1, .3, 1) both;
    transition: transform .16s ease, opacity .16s ease;
  }
  #card.out { transform: translateX(24px); opacity: 0; }
  .av { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-weight: 600; font-size: 17px; color: #1d211f; background: ${avBg}; }
  .av svg { width: 22px; height: 22px; color: ${cfg.accent}; }
  .mid { flex: 1; min-width: 0; }
  .kind { font-size: 11.5px; font-weight: 600; color: ${cfg.accent}; margin-bottom: 2px; }
  .ttl { font-size: 14px; font-weight: 600; color: ${C.txt}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bdy { font-size: 12.5px; line-height: 1.38; color: ${C.muted}; margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cls { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; border-radius: 7px; border: 0; padding: 4px;
    background: ${C.raised}; color: ${C.muted}; cursor: pointer; display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .16s ease; }
  .cls svg { width: 12px; height: 12px; }
  #card:hover .cls { opacity: 1; }
  .cls:hover { color: ${C.txt}; }
  .prog { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; transform-origin: left; background: ${cfg.accent};
    opacity: .7; animation: bar ${DURATION}ms linear both; }
  #card:hover .prog { animation-play-state: paused; }
</style>`);

document.getElementById('notif-root')!.innerHTML = `
  <div id="card">
    <div class="av">${avContent}</div>
    <div class="mid">
      <div class="kind">${cfg.label}</div>
      <div class="ttl">${esc(title)}</div>
      ${body ? `<div class="bdy">${esc(body)}</div>` : ''}
    </div>
    <button class="cls" aria-label="Закрыть">${GLYPH.close}</button>
    <div class="prog"></div>
  </div>`;

const card = document.getElementById('card')!;

let closed = false;
function dismiss() {
  if (closed) return; closed = true;
  card.classList.add('out');
  setTimeout(() => { getCurrentWindow().close().catch(() => {}); }, 330);
}

// авто-скрытие; на hover прогресс-бар паузится, но таймер — простой: перезапускаем «хвост»,
// пока курсор над карточкой (иначе уедет, хотя бар на паузе).
let timer = window.setTimeout(dismiss, DURATION);
card.addEventListener('mouseenter', () => { clearTimeout(timer); });
card.addEventListener('mouseleave', () => { timer = window.setTimeout(dismiss, 1600); });

// клик по крестику — просто закрыть
card.querySelector('.cls')!.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });

// клик по карточке — развернуть/сфокусировать главное окно и закрыть уведомление
card.addEventListener('click', async () => {
  try {
    if (tag || serverId) {
      const { emitTo } = await import('@tauri-apps/api/event');
      await emitTo('main', 'relay-notification-destination', {
        tag,
        ...(serverId ? { serverId } : {}),
        ...(messageId ? { messageId } : {}),
      }).catch(() => {});
    }
    const main = await Window.getByLabel('main');
    if (main) { await main.unminimize().catch(() => {}); await main.show().catch(() => {}); await main.setFocus().catch(() => {}); }
  } catch { /**/ }
  dismiss();
});

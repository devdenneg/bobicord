// Кастомное нативное уведомление (окно Tauri) — своя карточка в стиле приложения вместо
// системного toast. Окно создаётся из главного (см. notify.ts): прозрачное, без рамки, поверх
// всех, non-focus, в правом нижнем углу. Здесь — рендер + самоуправление (авто-скрытие с
// прогресс-баром, пауза на hover, клик → фокус главного). Лёгкая точка входа, без бандла приложения.
import { getCurrentWindow, Window } from '@tauri-apps/api/window';

type Kind = 'mention' | 'stream' | 'update';
const p = new URLSearchParams(location.search);
const kind = (p.get('k') as Kind) || 'mention';
const title = p.get('t') || 'RelayApp';
const body = p.get('b') || '';
const DURATION = kind === 'update' ? 9000 : 6000;

// Пресеты типа: подпись, акцент, глиф. Сразу видно, ЧТО за событие.
const KIND: Record<Kind, { label: string; accent: string; glyph: string }> = {
  mention: { label: 'Упоминание', accent: '#6d84ff', glyph: '💬' },
  stream: { label: 'Трансляция', accent: '#ff5a6a', glyph: '📺' },
  update: { label: 'Обновление', accent: '#34d67f', glyph: '⬆️' },
};
const cfg = KIND[kind] || KIND.mention;

function hueOf(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
const avBg = kind === 'update' ? cfg.accent : `hsl(${hueOf(title)} 58% 52%)`;
const initial = (title.trim()[0] || '•').toUpperCase();
const avContent = kind === 'stream' ? '📺' : kind === 'update' ? '⬆️' : initial;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

document.head.insertAdjacentHTML('beforeend', `<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  html, body { height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; user-select: none;
    font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif; cursor: default; }
  @keyframes in  { from { transform: translateX(112%) scale(.96); opacity: 0 } to { transform: none; opacity: 1 } }
  @keyframes bar { from { transform: scaleX(1) } to { transform: scaleX(0) } }
  #card {
    position: fixed; inset: 8px; display: flex; align-items: center; gap: 13px;
    padding: 13px 15px 13px 17px; border-radius: 17px; overflow: hidden; cursor: pointer;
    /* стекло: полупрозрачный тёмный слой + блюр десктопа за прозрачным окном (2026-glassmorphism) */
    background: rgba(20, 24, 33, .74);
    backdrop-filter: blur(24px) saturate(1.5); -webkit-backdrop-filter: blur(24px) saturate(1.5);
    border: 1px solid rgba(255, 255, 255, .10);
    box-shadow: 0 18px 44px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06);
    animation: in .42s cubic-bezier(.16, 1, .3, 1) both;
    transition: transform .2s ease, box-shadow .2s ease, opacity .32s ease;
  }
  #card.out { transform: translateX(112%) scale(.96); opacity: 0; }
  #card:hover { transform: translateY(-2px); box-shadow: 0 24px 54px rgba(0, 0, 0, .6), inset 0 1px 0 rgba(255, 255, 255, .08); }
  #card::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3.5px; border-radius: 0 3px 3px 0;
    background: ${cfg.accent}; box-shadow: 0 0 14px ${cfg.accent}88; }
  .av { position: relative; flex: 0 0 auto; width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-weight: 700; font-size: 19px; color: #fff; background: ${avBg};
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .16), 0 3px 10px rgba(0, 0, 0, .3); }
  .av::after { content: ''; position: absolute; inset: -3px; border-radius: 50%; border: 1.5px solid ${cfg.accent}66; }
  .mid { flex: 1; min-width: 0; }
  .kind { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 800; letter-spacing: .6px;
    text-transform: uppercase; color: ${cfg.accent}; margin-bottom: 3px; }
  .ttl { font-size: 14.5px; font-weight: 700; color: #f4f6fb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bdy { font-size: 12.5px; line-height: 1.36; color: #a9b2c4; margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .cls { position: absolute; top: 8px; right: 10px; width: 20px; height: 20px; border-radius: 50%; border: 0;
    background: rgba(255, 255, 255, .08); color: #c6cdda; font-size: 13px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .18s ease, background .18s ease; }
  #card:hover .cls { opacity: 1; }
  .cls:hover { background: rgba(255, 255, 255, .16); color: #fff; }
  .prog { position: absolute; left: 0; right: 0; bottom: 0; height: 2.5px; transform-origin: left; background: ${cfg.accent};
    opacity: .85; animation: bar ${DURATION}ms linear both; }
  #card:hover .prog { animation-play-state: paused; }
</style>`);

document.getElementById('notif-root')!.innerHTML = `
  <div id="card">
    <div class="av">${avContent}</div>
    <div class="mid">
      <div class="kind">${cfg.glyph} ${cfg.label}</div>
      <div class="ttl">${esc(title)}</div>
      ${body ? `<div class="bdy">${esc(body)}</div>` : ''}
    </div>
    <button class="cls" aria-label="Закрыть">✕</button>
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
    const main = await Window.getByLabel('main');
    if (main) { await main.unminimize().catch(() => {}); await main.show().catch(() => {}); await main.setFocus().catch(() => {}); }
  } catch { /**/ }
  dismiss();
});

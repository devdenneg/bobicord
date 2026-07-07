// Кастомное нативное уведомление (окно Tauri) — рисуем СВОЮ карточку в стиле приложения,
// вместо системного toast. Окно создаётся из главного (см. notify.ts): прозрачное, без рамки,
// поверх всех, non-focus, в углу экрана. Здесь — только рендер + самоуправление (авто-скрытие,
// клик → фокус главного окна). Лёгкая точка входа: без React/бандла приложения.
import { getCurrentWindow, Window } from '@tauri-apps/api/window';

type Kind = 'mention' | 'stream' | 'update';
const p = new URLSearchParams(location.search);
const kind = (p.get('k') as Kind) || 'mention';
const title = p.get('t') || 'RelayApp';
const body = p.get('b') || '';

// Пресеты типов: подпись, акцент, глиф. Информативность — сразу видно, ЧТО за событие.
const KIND: Record<Kind, { label: string; accent: string; glyph: string }> = {
  mention: { label: 'Упоминание', accent: '#5b6ef5', glyph: '💬' },
  stream: { label: 'Трансляция', accent: '#ef4444', glyph: '📺' },
  update: { label: 'Обновление', accent: '#22c55e', glyph: '⬆️' },
};
const cfg = KIND[kind] || KIND.mention;

// Цвет аватара — детерминированный из имени (как в приложении: у каждого свой оттенок).
function hueOf(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
const avBg = kind === 'update' ? cfg.accent : `hsl(${hueOf(title)} 52% 46%)`;
const initial = (title.trim()[0] || '•').toUpperCase();
const avContent = kind === 'stream' ? '📺' : kind === 'update' ? '⬆️' : initial;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

document.head.insertAdjacentHTML('beforeend', `<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  html, body { height: 100%; background: transparent; overflow: hidden; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; -webkit-user-select: none; user-select: none; cursor: pointer; }
  #card {
    position: fixed; inset: 6px; display: flex; align-items: center; gap: 12px;
    padding: 12px 14px 12px 16px; border-radius: 14px;
    background: linear-gradient(180deg, #1a1f2b 0%, #12151d 100%);
    border: 1px solid rgba(255,255,255,.09);
    box-shadow: 0 12px 34px rgba(0,0,0,.5), 0 0 0 1px rgba(0,0,0,.35);
    overflow: hidden;
    transform: translateX(120%); opacity: 0;
    transition: transform .34s cubic-bezier(.2,.9,.3,1), opacity .34s ease;
  }
  #card.in { transform: translateX(0); opacity: 1; }
  #card.out { transform: translateX(120%); opacity: 0; }
  #card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: ${cfg.accent}; }
  .av { flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 18px; color: #fff; background: ${avBg}; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
  .mid { flex: 1; min-width: 0; }
  .kind { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 700; letter-spacing: .3px;
          text-transform: uppercase; color: ${cfg.accent}; margin-bottom: 2px; }
  .ttl { font-size: 14px; font-weight: 700; color: #f2f4f8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bdy { font-size: 12.5px; line-height: 1.35; color: #aab2c0; margin-top: 2px;
         display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .app { flex: 0 0 auto; align-self: flex-start; font-size: 10px; font-weight: 700; color: #6b7484; letter-spacing: .4px; }
</style>`);

document.getElementById('notif-root')!.innerHTML = `
  <div id="card">
    <div class="av">${avContent}</div>
    <div class="mid">
      <div class="kind">${cfg.glyph} ${cfg.label}</div>
      <div class="ttl">${esc(title)}</div>
      ${body ? `<div class="bdy">${esc(body)}</div>` : ''}
    </div>
    <div class="app">РИЛЭЙ</div>
  </div>`;

const card = document.getElementById('card')!;
requestAnimationFrame(() => card.classList.add('in')); // вход-анимация

let closed = false;
function dismiss() {
  if (closed) return; closed = true;
  card.classList.remove('in'); card.classList.add('out');
  setTimeout(() => { getCurrentWindow().close().catch(() => {}); }, 340); // после fade-out
}

// клик по карточке → развернуть/сфокусировать главное окно и закрыть уведомление
document.body.addEventListener('click', async () => {
  try {
    const main = await Window.getByLabel('main');
    if (main) { await main.unminimize().catch(() => {}); await main.show().catch(() => {}); await main.setFocus().catch(() => {}); }
  } catch { /**/ }
  dismiss();
});

// авто-скрытие через 6с (обновления держим дольше — важнее не пропустить)
setTimeout(dismiss, kind === 'update' ? 9000 : 6000);

// Признак «на окно сейчас не смотрят»: свёрнуто, скрыто или потеряло фокус.
//
// Зачем отдельный модуль: главный сценарий — человек играет в полноэкранную игру, а RelayApp открыт
// позади. Окно при этом НЕ свёрнуто, поэтому `document.hidden` остаётся false и `visibilitychange`
// не приходит вовсе: приложение продолжает рисовать 60 кадров/с (бесконечные CSS-анимации, canvas
// логотипа, rAF-циклы индикаторов речи) и отбирает кадры у игры — ровно та жалоба, ради которой это
// написано. Единственный сигнал, который в этой ситуации реально приходит, — потеря фокуса окна.
//
// Ставит на <html> атрибут `data-idle`, по которому CSS глушит все бесконечные анимации, и уведомляет
// подписчиков, чтобы они останавливали свои rAF-циклы и сбавляли частоту поллингов.
import { isTauri } from './native';

type IdleListener = (idle: boolean) => void;

const listeners = new Set<IdleListener>();
let idle = false;
let started = false;

function sync(): void {
  const next = compute();
  if (next === idle) return;
  idle = next;
  document.documentElement.toggleAttribute('data-idle', idle);
  listeners.forEach((cb) => { try { cb(idle); } catch { /* подписчик не должен ломать остальных */ } });
}

// Натив сообщает о фокусе окна явно (lib.rs, on_window_event → relay-window-focus): внутри WebView2
// событие window.blur приходит не во всех случаях, а именно оно единственное срабатывает, когда окно
// перекрыто полноэкранной игрой. Значение натива приоритетнее document.hasFocus().
let nativeFocus: boolean | null = null;

function compute(): boolean {
  try {
    if (document.hidden) return true;
    if (nativeFocus !== null) return !nativeFocus;
    return !document.hasFocus();
  } catch { return false; }
}

export function startWindowIdleWatch(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('blur', sync);
  window.addEventListener('focus', sync);
  if (isTauri) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<boolean>('relay-window-focus', (e) => { nativeFocus = !!e.payload; sync(); }))
      .catch(() => { /* нет натива — остаёмся на браузерных событиях */ });
  }
  sync(); // стартовое состояние: приложение могли запустить свёрнутым/в фоне
}

export function isWindowIdle(): boolean { return idle; }

/** Подписка на смену состояния. Возвращает функцию отписки. */
export function onWindowIdle(cb: IdleListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

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
type IdleListener = (idle: boolean) => void;

const listeners = new Set<IdleListener>();
let idle = false;
let started = false;

function compute(): boolean {
  // hasFocus() у неактивного окна возвращает false и под полноэкранной игрой, и при alt-tab в браузер.
  // Оба случая нам подходят одинаково: на окно не смотрят — рисовать анимации незачем.
  try { return document.hidden || !document.hasFocus(); } catch { return false; }
}

function sync(): void {
  const next = compute();
  if (next === idle) return;
  idle = next;
  document.documentElement.toggleAttribute('data-idle', idle);
  listeners.forEach((cb) => { try { cb(idle); } catch { /* подписчик не должен ломать остальных */ } });
}

export function startWindowIdleWatch(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('blur', sync);
  window.addEventListener('focus', sync);
  sync(); // стартовое состояние: приложение могли запустить свёрнутым/в фоне
}

export function isWindowIdle(): boolean { return idle; }

/** Подписка на смену состояния. Возвращает функцию отписки. */
export function onWindowIdle(cb: IdleListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

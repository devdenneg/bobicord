// Away-детект («нет на месте», жёлтый статус). Нет взаимодействия с окном приложения дольше
// IDLE_MS → away:true; любая активность (мышь/клавиша/тач/колесо/фокус/возврат вкладки) → снова
// online. Состояние шлём по глобальному notify-WS (sendPresence) — сервер отдаёт его в presence,
// другие клиенты рисуют жёлтый. Проверка интервалом (30с) вместо пере-таймера на каждое событие.
import { sendPresence } from './notifyws';

const IDLE_MS = 5 * 60 * 1000; // 5 минут без активности → away
let lastActive = Date.now();
let away = false;
let started = false;

function bump(): void {
  lastActive = Date.now();
  if (away) { away = false; sendPresence(false); } // мгновенно снимаем away при активности
}

export function startIdleWatch(): void {
  if (started) return;
  started = true;
  for (const e of ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(e, bump, { passive: true });
  window.addEventListener('focus', bump);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) bump(); });
  window.setInterval(() => {
    const idle = Date.now() - lastActive > IDLE_MS;
    if (idle !== away) { away = idle; sendPresence(idle); }
  }, 30000);
}

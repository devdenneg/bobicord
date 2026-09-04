// Глобальный notify-WS: держим одно соединение к серверу (/ws), пока залогинены. Через него
// приходят уведомления об упоминании/трансляции в ЛЮБОМ нашем сервере — даже в НЕ подключённом
// (LiveKit-комната поднята только для текущего сервера; web-push бьёт лишь по свёрнутому/закрытому,
// а натив web-push вообще не получает). Так «понимаешь, куда зайти».
import { getToken, webOrigin } from './api';
import { notify, type NotifKind } from './notify';
import { rememberNotificationDestination } from './notificationDestination';
import { setVisibleChatServer } from './chatVisibility';
import { useStore, getEngine } from './store';

let ws: WebSocket | null = null;
let socketToken: string | null = null;
let connectTimer: number | null = null;
let pongTimer: number | null = null;
let reconnectTimer: number | null = null;
let closed = false;
let reconnectPaused = false;
let reconnectAttempt = 0; // экспоненциальный бэкофф: фиксированные 4с всей аудиторией лупили сервер синхронно после рестарта
let revokedToken: string | null = null; // токен, по которому сервер вернул 4001 (сессия отозвана) — им сокет уже не откроется
let presenceAway = false; // последнее заявленное idle-состояние (шлём серверу для away/жёлтого статуса)
let activeChatServerId: string | null = null; // сервер, чей чат реально открыт в UI (не просто живая LiveKit-комната)
// Живость сокета. Полуоткрытый TCP (сон ноутбука, ребайнд NAT, Wi-Fi→LTE) держит readyState === OPEN
// сколько угодно: FIN/RST по мёртвому пути не доходит, onclose не срабатывает, и kickReconnect на
// visibilitychange/online/focus молча выходил по «уже OPEN». Уведомления по НЕ подключённым серверам
// ходят только этим сокетом, значит клиент оставался без них до перезапуска приложения.
// Транспортный ws.ping() сервера в JS не виден (движок отвечает pong сам), поэтому живость меряем
// СВОИМ ping-фреймом: сервер отвечает {t:'pong'}, любой входящий фрейм обновляет lastRxAt.
const HEARTBEAT_MS = 30000;
const DEAD_AFTER_MS = 90000; // три пропущенных ответа подряд
const CONNECT_TIMEOUT_MS = 10000;
const PONG_TIMEOUT_MS = 8000;
let lastRxAt = 0;
let heartbeatTimer: number | null = null;

function socketLooksDead(): boolean {
  return !!lastRxAt && Date.now() - lastRxAt > DEAD_AFTER_MS;
}

// Рвём сокет принудительно: close() по мёртвому пути тоже не долетит до сервера, но локально
// переводит объект в CLOSING/CLOSED и освобождает kickReconnect/scheduleReconnect.
function dropDeadSocket(): void {
  const current = ws;
  ws = null;
  socketToken = null;
  lastRxAt = 0;
  stopHeartbeat();
  if (current) { try { current.close(); } catch { /**/ } }
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
  if (pongTimer !== null) { clearTimeout(pongTimer); pongTimer = null; }
}

function probeSocket(): void {
  const current = ws;
  if (!current || current.readyState !== WebSocket.OPEN || pongTimer !== null) return;
  pongTimer = window.setTimeout(() => {
    pongTimer = null;
    if (ws !== current) return;
    dropDeadSocket();
    scheduleReconnect();
  }, PONG_TIMEOUT_MS);
  try { current.send(JSON.stringify({ t: 'ping' })); }
  catch { dropDeadSocket(); scheduleReconnect(); }
}

// setTimeout-цепочка вместо setInterval: в фоне таймер троттлится, и накопленные тики setInterval
// выстрелили бы пачкой при возврате на вкладку. Троттлинг здесь безвреден — проверка просто реже,
// а мгновенную проверку по возвращении делает kickReconnect.
function scheduleHeartbeat(): void {
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
  heartbeatTimer = window.setTimeout(() => {
    heartbeatTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (socketLooksDead()) { dropDeadSocket(); scheduleReconnect(); return; }
    probeSocket();
    scheduleHeartbeat();
  }, HEARTBEAT_MS);
}

function sendPresenceFrame(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Свёрнутое/фоновое окно не считается человеком, который «сейчас в чате».
  const visibleActiveServerId = document.visibilityState === 'visible' ? activeChatServerId : null;
  const lastReleaseSid = getEngine()?.getSnapshot().messages.reduce((latest, message) => (
    message.kind === 'release' && Number.isSafeInteger(message.sid) ? Math.max(latest, message.sid || 0) : latest
  ), 0) || 0;
  try { ws.send(JSON.stringify({ t: 'presence', away: presenceAway, activeServerId: visibleActiveServerId, lastReleaseSid })); } catch { /**/ }
}

function onVisibilityChange(): void {
  sendPresenceFrame();
  if (document.visibilityState === 'visible') kickReconnect(); // вернулись на вкладку — не ждём троттлящийся таймер
}

document.addEventListener('visibilitychange', onVisibilityChange);
// Сеть вернулась/окно снова в фокусе — пробуем сразу, а не через бэкофф: уведомления по НЕ подключённым
// серверам ходят только этим сокетом, и лишняя минута молчания = молча пропущенное упоминание.
window.addEventListener('online', () => kickReconnect(true));
window.addEventListener('focus', () => kickReconnect());

// Сессия отозвана ИМЕННО этим токеном. Свежий логин выдаёт другой — тогда запрет снимается сам.
function revoked(): boolean { return !!revokedToken && revokedToken === getToken(); }

// Немедленная попытка вне расписания бэкоффа (счётчик при этом не сбрасываем — успех сбросит его сам).
function kickReconnect(networkChanged = false): void {
  if (closed || reconnectPaused || revoked()) return;
  // Вернулись на вкладку/в сеть — это ровно тот момент, когда сокет мог протухнуть незаметно.
  if (ws && (networkChanged || socketToken !== getToken() || (ws.readyState === WebSocket.OPEN && socketLooksDead()))) dropDeadSocket();
  if (ws && ws.readyState === WebSocket.OPEN) { probeSocket(); return; }
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectNotifyWs();
}

// Бэкофф 1→30с с джиттером ±25%: без него весь онлайн ломился обратно ровно через 4с после каждого
// рестарта сервера (thundering herd), а «вечный» цикл с мёртвым токеном крутился бесконечно.
function scheduleReconnect() {
  if (reconnectTimer || closed || reconnectPaused || revoked()) return;
  const base = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));
  reconnectAttempt++;
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectNotifyWs(); }, delay);
}

// Away-статус (см. idle.ts): апп давно не трогали → away:true (жёлтый). Шлём по глобальному notify-WS,
// сервер помечает сессию idle и отдаёт away в presence. На реконнекте переотправляем в onopen.
export function sendPresence(away: boolean): void {
  presenceAway = away;
  sendPresenceFrame();
}

// LiveKit viewRoom намеренно переживает уход на главную, поэтому по ней нельзя понять, открыт ли
// чат прямо сейчас. ServerView сообщает точную видимость панели; null явно снимает аудиторию.
export function sendActiveChat(serverId: string | null): void {
  const next = typeof serverId === 'string' && serverId.trim() ? serverId.trim() : null;
  setVisibleChatServer(next); // тем же значением пользуется локальный фокус-гейт уведомлений
  if (next === activeChatServerId) return;
  activeChatServerId = next;
  sendPresenceFrame();
}

// Вызывается только после успешного HTTP merge истории: до этого ws.send не считается ACK.
export function acknowledgeReleaseMerge(): void {
  sendPresenceFrame();
}

export function connectNotifyWs() {
  closed = false;
  if (reconnectPaused) return;
  const token = getToken();
  if (!token || revoked()) return;
  if (ws && socketToken !== token) dropDeadSocket();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const url = webOrigin().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  let current: WebSocket;
  try { current = new WebSocket(url); ws = current; socketToken = token; } catch { scheduleReconnect(); return; }
  connectTimer = window.setTimeout(() => {
    connectTimer = null;
    if (ws !== current) return;
    dropDeadSocket();
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);
  current.onopen = () => {
    if (ws !== current) { try { current.close(); } catch { /**/ } return; }
    if (getToken() !== token) { dropDeadSocket(); connectNotifyWs(); return; }
    if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
    reconnectAttempt = 0;
    lastRxAt = Date.now();
    scheduleHeartbeat();
    sendPresenceFrame();
  }; // переотправляем idle + реально открытый чат
  current.onmessage = (ev) => {
    if (ws !== current) return;
    lastRxAt = Date.now(); // любой входящий фрейм = сокет жив
    if (pongTimer !== null) { clearTimeout(pongTimer); pongTimer = null; }
    let d: any; try { d = JSON.parse(ev.data); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d && d.t === 'pong') return; // ответ на наш heartbeat, больше ничего не значит
    // кросс-девайс: прочитано на другом устройстве этого юзера → сбрасываем unread локально (и для
    // ПОДКЛЮЧЁННОГО сервера — тут дедуп по viewServerId НЕ применяем, чтение общее по БД).
    if (d.t === 'read') { if (d.serverId) useStore.getState().applyRemoteRead(d.serverId, d.lastRead || 0); return; }
    // Достижение уровня (веха ×5): сервер пушит виновнику → его клиент раз объявляет карточку в чат.
    if (d.t === 'levelup') { try { getEngine()?.onLevelUp(d.serverId, d.level); } catch { /**/ } return; }
    // Release-сообщение сначала сохраняется в БД. После рестарта API LiveKit data-пакет мог не
    // застать переподключившийся клиент, поэтому сервер просит открытый чат сверить свежий хвост.
    if (d.t === 'chat-refresh') {
      const st = useStore.getState();
      // Release was committed to history together with the chat card. Active clients can
      // update the rail badge immediately; background polling remains the fallback.
      void st.refreshReleaseHistoryUnread().catch(() => {});
      const visibleServerId = st.view === 'server' ? (st.loadingServerId || st.active?.id || st.viewServerId) : null;
      const targetSid = Number(d.lastReleaseSid);
      if (d.serverId && visibleServerId === d.serverId) {
        try { getEngine()?.refreshChat(Number.isSafeInteger(targetSid) && targetSid > 0 ? targetSid : undefined, d.serverId); } catch { /**/ }
      }
      return;
    }
    if (d.t === 'server-refresh') {
      const st = useStore.getState();
      if (d.serverId && st.viewServerId === d.serverId) void st.refreshServer().catch(() => {});
      return;
    }
    // Серверный owner голосовой сессии. При reconnect приходит только snapshot; явный claim другого
    // устройства мгновенно гасит старое, даже если оно было offline во время переключения.
    if (d.t === 'voice-lease') { try { getEngine()?.onVoiceLease(d); } catch { /**/ } return; }
    if (d.t !== 'notify') return;
    const st = useStore.getState();
    const tag = String(d.tag || ((d.kind || 'mention') + ':' + (d.serverId || '')));
    const destination = d.serverId ? {
      serverId: String(d.serverId),
      ...(Number.isSafeInteger(Number(d.msgId)) && Number(d.msgId) > 0 ? { messageId: Number(d.msgId) } : {}),
    } : null;
    // Realtime chat can show the banner before POST returns its DB id. Preserve the exact target
    // under the same replaceable tag even when the visual notification came through LiveKit.
    rememberNotificationDestination(tag, destination);
    // Текущий сервер гасим ТОЛЬКО если его realtime-путь реально жив: viewServerId выставляется
    // оптимистично (до подъёма комнаты) и переживает терминальный обрыв с реконнектом, поэтому
    // прежний дедуп «по id сервера» выбрасывал упоминание в окне, когда LiveKit его и не доставил.
    if (d.serverId && d.serverId === st.viewServerId && getEngine()?.realtimeServes(d.serverId)) return;
    // force: сюда доходят серверы, чей чат сейчас НЕ обслуживается живым LiveKit-путём, поэтому
    // упоминание уведомляем даже в фокусе (обходим FOCUS_GATED).
    notify((d.kind as NotifKind) || 'mention', {
      title: `${d.title || 'Рилэй'}${d.serverName ? ' · ' + d.serverName : ''}`,
      body: d.body || '',
      sender: d.title || undefined,
      tag,
      destination: destination || undefined,
      force: true,
    });
    if (d.serverId) st.bumpUnread(d.serverId);
  };
  current.onclose = (ev) => {
    if (ws !== current) return;
    ws = null;
    socketToken = null;
    lastRxAt = 0;
    stopHeartbeat();
    // 4001 = сервер отозвал сессию (смена пароля, подтверждение почты, удаление аккаунта на другом
    // устройстве). Этим токеном сокет уже никогда не откроется — раньше клиент бесконечно долбился
    // мёртвым JWT и молча оставался без уведомлений, ничего не сказав пользователю.
    if (ev && ev.code === 4001) {
      if (getToken() !== token) { if (!closed) connectNotifyWs(); return; }
      revokedToken = token;
      try { useStore.getState().toast('Сеанс завершён на другом устройстве — войди заново', 'warn'); } catch { /**/ }
      return;
    }
    if (!closed) scheduleReconnect();
  };
  current.onerror = () => { try { current.close(); } catch { /**/ } };
}

// Смена пароля отзывает старую сессию до того, как HTTP-ответ с новым JWT дойдёт до клиента.
// На этом коротком промежутке нельзя позволять notify-каналу автоматически открыть сокет со
// старым JWT. Текущий сокет закрываем, но activeChatServerId сохраняем: после handoff сервер
// сразу снова получит точный presence открытого чата.
export function pauseNotifyWsReconnect() {
  reconnectPaused = true;
  stopHeartbeat();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  dropDeadSocket();
}

export function resumeNotifyWsReconnect() {
  reconnectPaused = false;
  connectNotifyWs();
}

export function disconnectNotifyWs() {
  closed = true;
  reconnectPaused = false;
  stopHeartbeat();
  activeChatServerId = null;
  sendPresenceFrame();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  dropDeadSocket();
}

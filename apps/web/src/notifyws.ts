// Глобальный notify-WS: держим одно соединение к серверу (/ws), пока залогинены. Через него
// приходят уведомления об упоминании/трансляции в ЛЮБОМ нашем сервере — даже в НЕ подключённом
// (LiveKit-комната поднята только для текущего сервера; web-push бьёт лишь по свёрнутому/закрытому,
// а натив web-push вообще не получает). Так «понимаешь, куда зайти».
import { getToken, isTerminalSessionError, refreshAccessSession, webOrigin } from './api';
import { accessTokenNeedsRefresh, persistentSessionActive, subscribeAccessTokenChanges } from './authSession';
import { notify, type NotifKind } from './notify';
import { rememberNotificationDestination } from './notificationDestination';
import { setVisibleChatServer } from './chatVisibility';
import { useStore, getEngine } from './store';
import {
  MAX_CHAT_REALTIME_FRAME_BYTES,
  chatProtocolPresence,
  chatRealtimeTargetsServer,
  parseChatRealtimeFrame,
} from './chatRealtime';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let closed = false;
let started = false;
let reconnectPaused = false;
let reconnectAttempt = 0; // экспоненциальный бэкофф: фиксированные 4с всей аудиторией лупили сервер синхронно после рестарта
let capacityRetryAt = 0; // отдельный долгий backoff: лишняя вкладка не должна устраивать eviction-loop
let authRefreshRetryAt = 0; // network/5xx refresh не рвёт аккаунт и не превращается в handshake-loop старым JWT
let connectGateInFlight: Promise<void> | null = null; // refresh + handshake допускают только одного владельца
let connectingStartedAt = 0;
let revokedToken: string | null = null; // токен, по которому сервер вернул 4001 (сессия отозвана) — им сокет уже не откроется
let presenceAway = false; // последнее заявленное idle-состояние (шлём серверу для away/жёлтого статуса)
let activeChatServerId: string | null = null; // сервер, чей чат реально открыт в UI (не просто живая LiveKit-комната)
let notifyChatProtocolV1 = false; // ACK only for exact chat-ready v1 on the current notify connection
// Живость сокета. Полуоткрытый TCP (сон ноутбука, ребайнд NAT, Wi-Fi→LTE) держит readyState === OPEN
// сколько угодно: FIN/RST по мёртвому пути не доходит, onclose не срабатывает, и kickReconnect на
// visibilitychange/online/focus молча выходил по «уже OPEN». Уведомления по НЕ подключённым серверам
// ходят только этим сокетом, значит клиент оставался без них до перезапуска приложения.
// Транспортный ws.ping() сервера в JS не виден (движок отвечает pong сам), поэтому живость меряем
// СВОИМ ping-фреймом: сервер отвечает {t:'pong'}, любой входящий фрейм обновляет lastRxAt.
const HEARTBEAT_MS = 30000;
const DEAD_AFTER_MS = 90000; // три пропущенных ответа подряд
const CONNECT_TIMEOUT_MS = 15000;
// A successful old-server socket never sends chat-ready. Keep canonical mode
// sticky through network failures, but let an authenticated, still-open old WS
// prove a rollback/rolling-deploy connection and restore the legacy path.
const CHAT_CAPABILITY_NEGOTIATION_MS = 8000;
let lastRxAt = 0;
let heartbeatTimer: number | null = null;
let disconnectedChatSnapshotTimer: number | null = null;
let lastDisconnectedChatSnapshotAt = 0;
let malformedChatResyncAt = 0;
let malformedChatResyncTimer: number | null = null;
let malformedChatResyncServerId: string | null = null;

function replaceNotifyAccessToken(): void {
  revokedToken = null;
  capacityRetryAt = 0;
  authRefreshRetryAt = 0;
  notifyChatProtocolV1 = false;
  connectingStartedAt = 0;
  lastRxAt = 0;
  stopHeartbeat();
  stopDisconnectedChatSnapshots();
  stopMalformedChatRecovery();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const current = ws; ws = null; try { current.close(); } catch { /**/ } }
  if (started && getToken() && !closed && !reconnectPaused) connectNotifyWs();
}

subscribeAccessTokenChanges((change) => {
  if (change.reason === 'refresh' || change.reason === 'persistent') {
    replaceNotifyAccessToken();
  } else if (!change.token && started) {
    replaceNotifyAccessToken();
  }
});

function reconnectBlockedUntil(): number {
  return Math.max(capacityRetryAt, authRefreshRetryAt);
}

function stopMalformedChatRecovery(): void {
  if (malformedChatResyncTimer !== null) clearTimeout(malformedChatResyncTimer);
  malformedChatResyncTimer = null;
  malformedChatResyncServerId = null;
}

// Keep the leading request bounded under a malformed-frame flood, but never
// lose the last recovery intent: a trailing sync runs after the throttle window.
function requestMalformedChatRecovery(serverId: string): void {
  if (malformedChatResyncServerId && malformedChatResyncServerId !== serverId) stopMalformedChatRecovery();
  malformedChatResyncServerId = serverId;
  const run = () => {
    const target = malformedChatResyncServerId;
    malformedChatResyncTimer = null;
    malformedChatResyncServerId = null;
    malformedChatResyncAt = Date.now();
    const engine = getEngine();
    if (target && engine?.connectedChatServerId() === target) void engine.resynchronizeChat(target);
  };
  const delay = Math.max(0, malformedChatResyncAt + 1200 - Date.now());
  if (delay === 0 && malformedChatResyncTimer === null) { run(); return; }
  if (malformedChatResyncTimer === null) malformedChatResyncTimer = window.setTimeout(run, delay);
}

function stopDisconnectedChatSnapshots(): void {
  if (disconnectedChatSnapshotTimer !== null) clearTimeout(disconnectedChatSnapshotTimer);
  disconnectedChatSnapshotTimer = null;
  lastDisconnectedChatSnapshotAt = 0;
}

// Authenticated canonical state remains fail-closed during any notify-WS loss,
// but HTTP is often still healthy (mobile network transition, proxy idle close,
// socket-capacity rejection). Keep the current logical chat fresh until WS is
// OPEN again without shortening or revoking the account session.
function scheduleDisconnectedChatSnapshots(immediate = false): void {
  if (closed || reconnectPaused || !getToken() || ws?.readyState === WebSocket.OPEN) {
    stopDisconnectedChatSnapshots();
    return;
  }
  const synchronize = () => {
    const engine = getEngine();
    // Before the first successful notify handshake we deliberately do not know whether the
    // server is canonical or legacy.  That uncertainty must not disable the only recovery path:
    // a fresh install can lose /ws, enter a server afterwards and still keep its authoritative
    // HTTP history current.  Old servers expose the same GET snapshot, so polling is safe in
    // either rollout direction and never grants participant data-channel authority.
    const serverId = engine?.connectedChatServerId();
    if (serverId) {
      lastDisconnectedChatSnapshotAt = Date.now();
      void engine?.resynchronizeChat(serverId);
    }
  };
  if (immediate && Date.now() - lastDisconnectedChatSnapshotAt >= 30_000) synchronize();
  if (disconnectedChatSnapshotTimer !== null) return;
  disconnectedChatSnapshotTimer = window.setTimeout(() => {
    disconnectedChatSnapshotTimer = null;
    if (ws?.readyState === WebSocket.OPEN || closed || reconnectPaused) return;
    synchronize();
    scheduleDisconnectedChatSnapshots();
  }, 30_000);
}

function socketLooksDead(): boolean {
  return !!lastRxAt && Date.now() - lastRxAt > DEAD_AFTER_MS;
}

// Рвём сокет принудительно: close() по мёртвому пути тоже не долетит до сервера, но локально
// переводит объект в CLOSING/CLOSED и освобождает kickReconnect/scheduleReconnect.
function dropDeadSocket(): void {
  const current = ws;
  ws = null;
  notifyChatProtocolV1 = false;
  connectingStartedAt = 0;
  lastRxAt = 0;
  stopHeartbeat();
  if (current) { try { current.close(); } catch { /**/ } }
  scheduleDisconnectedChatSnapshots(true);
}

// CONNECTING может навсегда пережить captive portal / смену Wi-Fi→LTE и не вызвать ни open,
// ни close. Снимаем только тот объект, для которого был поставлен дедлайн: таймер старого сокета
// не имеет права закрыть уже открытый новым токеном.
function dropStuckConnectingSocket(current: WebSocket): boolean {
  if (ws !== current || current.readyState !== WebSocket.CONNECTING) return false;
  ws = null;
  connectingStartedAt = 0;
  notifyChatProtocolV1 = false;
  lastRxAt = 0;
  stopHeartbeat();
  try { current.close(); } catch { /**/ }
  scheduleDisconnectedChatSnapshots(true);
  return true;
}

function stopHeartbeat(): void {
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
}

// setTimeout-цепочка вместо setInterval: в фоне таймер троттлится, и накопленные тики setInterval
// выстрелили бы пачкой при возврате на вкладку. Троттлинг здесь безвреден — проверка просто реже,
// а мгновенную проверку по возвращении делает kickReconnect.
function scheduleHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = window.setTimeout(() => {
    heartbeatTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (socketLooksDead()) { dropDeadSocket(); scheduleReconnect(); return; }
    try { ws.send(JSON.stringify({ t: 'ping' })); } catch { /**/ }
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
  const connectedServerId = getEngine()?.connectedChatServerId() || null;
  try {
    ws.send(JSON.stringify({
      t: 'presence', away: presenceAway, activeServerId: visibleActiveServerId, connectedServerId, lastReleaseSid,
      ...chatProtocolPresence(notifyChatProtocolV1),
    }));
  } catch { /**/ }
}

function onVisibilityChange(): void {
  sendPresenceFrame();
  if (document.visibilityState === 'visible') kickReconnect(); // вернулись на вкладку — не ждём троттлящийся таймер
}

document.addEventListener('visibilitychange', onVisibilityChange);
// Сеть вернулась/окно снова в фокусе — пробуем сразу, а не через бэкофф: уведомления по НЕ подключённым
// серверам ходят только этим сокетом, и лишняя минута молчания = молча пропущенное упоминание.
window.addEventListener('online', () => kickReconnect());
window.addEventListener('focus', () => kickReconnect());
window.addEventListener('pageshow', () => kickReconnect());

// Сессия отозвана ИМЕННО этим токеном. Свежий логин выдаёт другой — тогда запрет снимается сам.
function revoked(): boolean { return !!revokedToken && revokedToken === getToken(); }

// Немедленная попытка вне расписания бэкоффа (счётчик при этом не сбрасываем — успех сбросит его сам).
function kickReconnect(): void {
  if (closed || reconnectPaused || revoked()) return;
  if (Date.now() < reconnectBlockedUntil()) return;
  // Вернулись на вкладку/в сеть — это ровно тот момент, когда сокет мог протухнуть незаметно.
  if (ws && ws.readyState === WebSocket.OPEN && socketLooksDead()) dropDeadSocket();
  if (ws && ws.readyState === WebSocket.CONNECTING && connectingStartedAt
    && Date.now() - connectingStartedAt >= CONNECT_TIMEOUT_MS) {
    dropStuckConnectingSocket(ws);
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  notifyChatProtocolV1 = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectNotifyWs();
}

// Бэкофф 1→30с с джиттером ±25%: без него весь онлайн ломился обратно ровно через 4с после каждого
// рестарта сервера (thundering herd), а «вечный» цикл с мёртвым токеном крутился бесконечно.
function scheduleReconnect() {
  if (reconnectTimer || closed || reconnectPaused || revoked()) return;
  const base = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
  const delay = Math.max(Math.round(base * (0.75 + Math.random() * 0.5)), reconnectBlockedUntil() - Date.now());
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

export function sendConnectedChatPresence(): void {
  sendPresenceFrame();
  // The logical chat can be entered while the first WebSocket is still stuck in CONNECTING
  // (a common mobile captive-portal/proxy failure).  The earlier loss callback then ran before
  // an Engine/server id existed.  Re-arm the immediate+periodic HTTP fence at the moment the
  // target becomes known; the scheduler stays alive even when no capability frame ever arrived.
  if (!ws || ws.readyState !== WebSocket.OPEN) scheduleDisconnectedChatSnapshots(true);
}

// Вызывается только после успешного HTTP merge истории: до этого ws.send не считается ACK.
export function acknowledgeReleaseMerge(): void {
  sendPresenceFrame();
}

async function prepareNotifyConnection(): Promise<void> {
  if (reconnectPaused || closed || revoked()) return;
  if (Date.now() < reconnectBlockedUntil()) {
    scheduleDisconnectedChatSnapshots(true);
    scheduleReconnect();
    return;
  }
  if (!getToken()) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (persistentSessionActive() && accessTokenNeedsRefresh()) {
    try {
      // refreshAccessSession уже single-flight для HTTP; этот gate дополнительно не даёт двум
      // lifecycle-событиям открыть два WS после одного и того же результата ротации.
      await refreshAccessSession();
      authRefreshRetryAt = 0;
    } catch (error) {
      if (isTerminalSessionError(error)) {
        // refreshAccessSession авторитетно очистил только отозванную/завершённую сессию.
        // Старым JWT больше не стучимся: новый логин сам разбудит transport token-listener'ом.
        authRefreshRetryAt = 0;
        return;
      }
      authRefreshRetryAt = Date.now() + 30_000;
      reconnectAttempt = Math.max(reconnectAttempt, 5);
      scheduleDisconnectedChatSnapshots(true);
      scheduleReconnect();
      return;
    }
  }
  if (reconnectPaused || closed || revoked() || !getToken()) return;
  connectNotifyWsNow();
}

export function connectNotifyWs() {
  started = true;
  closed = false;
  if (connectGateInFlight) return;
  const run = prepareNotifyConnection();
  const tracked = run.finally(() => {
    if (connectGateInFlight === tracked) connectGateInFlight = null;
  });
  connectGateInFlight = tracked;
}

function connectNotifyWsNow() {
  if (reconnectPaused) return;
  if (Date.now() < reconnectBlockedUntil()) { scheduleDisconnectedChatSnapshots(true); scheduleReconnect(); return; }
  const token = getToken();
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = webOrigin().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  let current: WebSocket;
  try { current = new WebSocket(url); ws = current; } catch {
    scheduleDisconnectedChatSnapshots(true);
    scheduleReconnect();
    return;
  }
  connectingStartedAt = Date.now();
  let connectTimer: number | null = window.setTimeout(() => {
    connectTimer = null;
    if (!dropStuckConnectingSocket(current)) return;
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);
  const clearConnectTimer = () => {
    if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
  };
  let capabilitySettled = false;
  let canonicalV1Ready = false;
  let capabilityTimer: number | null = null;
  let compatibilitySnapshotTimer: number | null = null;
  const clearCapabilityTimer = () => {
    if (capabilityTimer !== null) { clearTimeout(capabilityTimer); capabilityTimer = null; }
  };
  const clearCompatibilitySnapshots = () => {
    if (compatibilitySnapshotTimer !== null) clearTimeout(compatibilitySnapshotTimer);
    compatibilitySnapshotTimer = null;
  };
  const scheduleCompatibilitySnapshot = () => {
    if (canonicalV1Ready || compatibilitySnapshotTimer !== null || ws !== current || current.readyState !== WebSocket.OPEN) return;
    compatibilitySnapshotTimer = window.setTimeout(() => {
      compatibilitySnapshotTimer = null;
      if (ws !== current || current.readyState !== WebSocket.OPEN) return;
      const engine = getEngine();
      const serverId = engine?.connectedChatServerId();
      if (serverId) void engine?.resynchronizeChat(serverId);
      scheduleCompatibilitySnapshot();
    }, 30_000);
  };
  const announceCanonicalCapability = (v1Ready: boolean) => {
    const firstMarker = !capabilitySettled;
    const becameV1Ready = v1Ready && !canonicalV1Ready;
    capabilitySettled = true;
    clearCapabilityTimer();
    canonicalV1Ready = canonicalV1Ready || v1Ready;
    const engine = getEngine();
    if (firstMarker || becameV1Ready) engine?.setServerChatReady();
    if (canonicalV1Ready) clearCompatibilitySnapshots();
    else {
      const serverId = engine?.connectedChatServerId();
      if (firstMarker && serverId) void engine?.resynchronizeChat(serverId);
      scheduleCompatibilitySnapshot();
    }
  };
  const downgradeToLegacy = () => {
    if (capabilitySettled || ws !== current || current.readyState !== WebSocket.OPEN) return;
    capabilitySettled = true;
    clearCapabilityTimer();
    const engine = getEngine();
    engine?.setServerChatReady(false);
    const serverId = engine?.connectedChatServerId();
    if (serverId) void engine?.resynchronizeChat(serverId);
  };
  current.onopen = () => {
    clearConnectTimer();
    if (ws !== current) { try { current.close(); } catch { /**/ } return; }
    connectingStartedAt = 0;
    reconnectAttempt = 0;
    capacityRetryAt = 0;
    authRefreshRetryAt = 0;
    stopDisconnectedChatSnapshots();
    lastRxAt = Date.now();
    scheduleHeartbeat();
    capabilityTimer = window.setTimeout(downgradeToLegacy, CHAT_CAPABILITY_NEGOTIATION_MS);
    sendPresenceFrame();
    const connectedServerId = getEngine()?.connectedChatServerId();
    if (connectedServerId) void getEngine()?.resynchronizeChat(connectedServerId);
  }; // переотправляем idle + реально подключённый чат
  current.onmessage = (ev) => {
    if (ws !== current) return;
    lastRxAt = Date.now(); // любой входящий фрейм = сокет жив
    if (typeof ev.data !== 'string') return;
    const chatFrame = parseChatRealtimeFrame(ev.data);
    if (chatFrame) {
      if (chatFrame.t === 'chat-ready') {
        notifyChatProtocolV1 = true;
        announceCanonicalCapability(true);
        // chat-ready is the capability boundary. Presence subscribes this exact
        // socket; the server answers with chat-resync(reconnect) as the ACK/fence.
        sendPresenceFrame();
        return;
      }
      // An exact v1 event before ready still proves a modern connection, but
      // keep snapshot polling until the ordered ready/subscription fence arrives.
      if (!canonicalV1Ready) announceCanonicalCapability(false);
      const logicalServerId = getEngine()?.connectedChatServerId();
      if (!chatRealtimeTargetsServer(chatFrame, logicalServerId)) return;
      if (chatFrame.t === 'chat-resync') {
        void getEngine()?.resynchronizeChat(chatFrame.serverId);
      } else {
        getEngine()?.onServerChatEvent(chatFrame.serverId, chatFrame.rev, chatFrame.event);
      }
      return;
    }
    let d: any; try { d = JSON.parse(ev.data); } catch { return; }
    // A malformed or future-version canonical frame is never allowed to fall
    // through into legacy notification/data handling.
    if (d && (d.t === 'chat-ready' || d.t === 'chat-event' || d.t === 'chat-resync')) {
      // Unknown versions and malformed canonical frames are still authenticated
      // modern-server markers. They must settle fail-closed so the negotiation
      // timeout can never re-enable participant-authored durable packets.
      announceCanonicalCapability(false);
      const logicalServerId = getEngine()?.connectedChatServerId();
      const bounded = ev.data.length <= MAX_CHAT_REALTIME_FRAME_BYTES
        && new TextEncoder().encode(ev.data).byteLength <= MAX_CHAT_REALTIME_FRAME_BYTES;
      if (logicalServerId && bounded && d.v === 1 && (d.t === 'chat-event' || d.t === 'chat-resync')
        && typeof d.serverId === 'string' && d.serverId === logicalServerId
      ) requestMalformedChatRecovery(logicalServerId);
      return;
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return;
    // These frames can only arrive from the authenticated notify endpoint. The
    // modern server orders chat-ready before them, so seeing one first proves
    // that this live connection belongs to an older/rolled-back server. The
    // timeout above covers a quiet old connection without downgrading on errors.
    if (d && (d.t === 'pong' || d.t === 'read' || d.t === 'levelup' || d.t === 'chat-refresh'
      || d.t === 'server-refresh' || d.t === 'voice-lease' || d.t === 'notify')) downgradeToLegacy();
    if (d && d.t === 'pong') return; // ответ на наш heartbeat, больше ничего не значит
    // кросс-девайс: прочитано на другом устройстве этого юзера → сбрасываем unread локально (и для
    // ПОДКЛЮЧЁННОГО сервера — тут дедуп по viewServerId НЕ применяем, чтение общее по БД).
    if (d.t === 'read') { if (d.serverId) useStore.getState().applyRemoteRead(d.serverId, d.lastRead || 0); return; }
    // Достижение уровня (веха ×5): сервер пушит виновнику → его клиент раз объявляет карточку в чат.
    if (d.t === 'levelup') { try { getEngine()?.onLevelUp(d.serverId, d.level); } catch { /**/ } return; }
    // Release-сообщение сначала сохраняется в БД. После рестарта API LiveKit data-пакет мог не
    // застать переподключившийся клиент, поэтому сервер просит открытый чат сверить свежий хвост.
    if (d.t === 'chat-refresh') {
      const currentEngine = getEngine();
      if (d.reason === 'chat-mutation') {
        // Delayed rollout repair may race a newer canonical delete/clear. Modern
        // clients already receive revisioned events and must never merge this
        // stale legacy GET; a negotiated old-server connection instead performs
        // a full replacement so deletes and clears cannot become no-ops.
        if (canonicalV1Ready) return;
        if (d.serverId && currentEngine?.connectedChatServerId() === d.serverId) {
          void currentEngine?.resynchronizeChat(d.serverId);
        }
        return;
      }
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
      if (d.serverId && st.viewServerId === d.serverId) void st.refreshServer();
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
    const exactMessageId = Number(d.msgId);
    const notifyServerId = typeof d.serverId === 'string' ? d.serverId : '';
    const currentEngine = getEngine();
    const logicalChatServerId = currentEngine?.connectedChatServerId();
    const exactCurrentMessage = !!notifyServerId && notifyServerId === logicalChatServerId
      && Number.isSafeInteger(exactMessageId) && exactMessageId > 0;
    if (exactCurrentMessage && currentEngine?.canonicalChatEnabled()) {
      // Claim before showing: event, recovery snapshot and raw notify all race
      // through the same bounded exact-sid gate, so precisely one path wins.
      if (!currentEngine.claimChatMentionNotification(notifyServerId, exactMessageId)) return;
    } else if (d.serverId === st.viewServerId && !currentEngine?.canonicalChatEnabled()
      && currentEngine?.realtimeServes(d.serverId)) {
      return;
    } else if (exactCurrentMessage && currentEngine
      && !currentEngine.claimChatMentionNotification(notifyServerId, exactMessageId)) {
      return;
    }
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
    clearConnectTimer();
    clearCapabilityTimer();
    clearCompatibilitySnapshots();
    if (ws !== current) return;
    stopMalformedChatRecovery();
    ws = null;
    notifyChatProtocolV1 = false;
    connectingStartedAt = 0;
    lastRxAt = 0;
    stopHeartbeat();
    // 4001 = сервер отозвал сессию (смена пароля, подтверждение почты, удаление аккаунта на другом
    // устройстве). Этим токеном сокет уже никогда не откроется — раньше клиент бесконечно долбился
    // мёртвым JWT и молча оставался без уведомлений, ничего не сказав пользователю.
    if (ev && ev.code === 4001) {
      const rejectedToken = getToken() || null;
      if (!persistentSessionActive()) {
        revokedToken = rejectedToken;
        try { useStore.getState().toast('Сеанс завершён на другом устройстве — войди заново', 'warn'); } catch { /**/ }
        return;
      }
      // An expired short access closes only this transport. Refresh the durable
      // device session first; network/5xx keeps the account and retries later.
      scheduleDisconnectedChatSnapshots(true);
      void refreshAccessSession().then(() => {
        revokedToken = null;
        if (!closed && !reconnectPaused) connectNotifyWs();
      }).catch((error) => {
        if (isTerminalSessionError(error)) {
          revokedToken = rejectedToken;
          try { useStore.getState().toast('Сеанс отозван — войди заново', 'warn'); } catch { /**/ }
          return;
        }
        revokedToken = null;
        capacityRetryAt = Date.now() + 30_000;
        reconnectAttempt = Math.max(reconnectAttempt, 5);
        try { useStore.getState().toast('Realtime временно недоступен — аккаунт остаётся подключён', 'warn'); } catch { /**/ }
        scheduleDisconnectedChatSnapshots(true);
        if (!closed) scheduleReconnect();
      });
      return;
    }
    if (ev && (ev.code === 4008 || ev.code === 4009)) {
      // Capacity only affects this realtime transport. The account JWT and every
      // ordinary API request remain live; retry after a bounded delay instead
      // of making open tabs evict each other.
      // 4008 itself is a modern-server capability signal. Canonical mode stays
      // fail-closed; bounded HTTP snapshots cover this tab until a WS slot frees.
      getEngine()?.setServerChatReady();
      const capacityLimited = ev.code === 4008;
      capacityRetryAt = Date.now() + (capacityLimited ? 5 * 60_000 : 60_000);
      reconnectAttempt = Math.max(reconnectAttempt, 5);
      scheduleDisconnectedChatSnapshots(true);
      try {
        useStore.getState().toast(capacityLimited
          ? 'Слишком много открытых окон — realtime в этом окне временно приостановлен'
          : 'Realtime временно ограничен — аккаунт остаётся подключён', 'warn');
      } catch { /**/ }
      if (!closed) scheduleReconnect();
      return;
    }
    scheduleDisconnectedChatSnapshots(true);
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
  connectingStartedAt = 0;
  stopHeartbeat();
  stopDisconnectedChatSnapshots();
  stopMalformedChatRecovery();
  notifyChatProtocolV1 = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const current = ws; ws = null; try { current.close(); } catch { /**/ } }
}

export function resumeNotifyWsReconnect() {
  reconnectPaused = false;
  connectNotifyWs();
}

export function disconnectNotifyWs() {
  started = false;
  closed = true;
  reconnectPaused = false;
  stopHeartbeat();
  stopDisconnectedChatSnapshots();
  stopMalformedChatRecovery();
  capacityRetryAt = 0;
  authRefreshRetryAt = 0;
  connectingStartedAt = 0;
  activeChatServerId = null;
  sendPresenceFrame();
  notifyChatProtocolV1 = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const w = ws; ws = null; try { w.close(); } catch { /**/ } }
}

// Глобальный notify-WS: держим одно соединение к серверу (/ws), пока залогинены. Через него
// приходят уведомления об упоминании/трансляции в ЛЮБОМ нашем сервере — даже в НЕ подключённом
// (LiveKit-комната поднята только для текущего сервера; web-push бьёт лишь по свёрнутому/закрытому,
// а натив web-push вообще не получает). Так «понимаешь, куда зайти».
import { getToken, webOrigin } from './api';
import { notify, type NotifKind } from './notify';
import { useStore, getEngine } from './store';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let closed = false;
let presenceAway = false; // последнее заявленное idle-состояние (шлём серверу для away/жёлтого статуса)
let activeChatServerId: string | null = null; // сервер, чей чат реально открыт в UI (не просто живая LiveKit-комната)

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
}

document.addEventListener('visibilitychange', onVisibilityChange);

function scheduleReconnect() {
  if (reconnectTimer || closed) return;
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectNotifyWs(); }, 4000);
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
  const token = getToken();
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = webOrigin().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  let current: WebSocket;
  try { current = new WebSocket(url); ws = current; } catch { scheduleReconnect(); return; }
  current.onopen = () => { if (ws !== current) { try { current.close(); } catch { /**/ } return; } sendPresenceFrame(); }; // переотправляем idle + реально открытый чат
  current.onmessage = (ev) => {
    if (ws !== current) return;
    let d: any; try { d = JSON.parse(ev.data); } catch { return; }
    // кросс-девайс: прочитано на другом устройстве этого юзера → сбрасываем unread локально (и для
    // ПОДКЛЮЧЁННОГО сервера — тут дедуп по viewServerId НЕ применяем, чтение общее по БД).
    if (d.t === 'read') { if (d.serverId) useStore.getState().applyRemoteRead(d.serverId, d.lastRead || 0); return; }
    // Достижение уровня (веха ×5): сервер пушит виновнику → его клиент раз объявляет карточку в чат.
    if (d.t === 'levelup') { try { getEngine()?.onLevelUp(d.serverId, d.level); } catch { /**/ } return; }
    // Release-сообщение сначала сохраняется в БД. После рестарта API LiveKit data-пакет мог не
    // застать переподключившийся клиент, поэтому сервер просит открытый чат сверить свежий хвост.
    if (d.t === 'chat-refresh') {
      const st = useStore.getState();
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
    // текущий (подключённый) сервер обслуживает живой LiveKit-путь — тут не дублируем
    if (d.serverId && d.serverId === st.viewServerId) return;
    // force: сюда доходят ТОЛЬКО не-текущие серверы (текущий отсеян выше по viewServerId) —
    // их чат не виден, поэтому упоминание уведомляем даже в фокусе (обходим FOCUS_GATED).
    notify((d.kind as NotifKind) || 'mention', {
      title: `${d.title || 'Рилэй'}${d.serverName ? ' · ' + d.serverName : ''}`,
      body: d.body || '',
      tag: (d.kind || 'mention') + ':' + (d.serverId || ''),
      force: true,
    });
    if (d.serverId) st.bumpUnread(d.serverId);
  };
  current.onclose = () => { if (ws !== current) return; ws = null; if (!closed) scheduleReconnect(); };
  current.onerror = () => { try { current.close(); } catch { /**/ } };
}

export function disconnectNotifyWs() {
  closed = true;
  activeChatServerId = null;
  sendPresenceFrame();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const w = ws; ws = null; try { w.close(); } catch { /**/ } }
}

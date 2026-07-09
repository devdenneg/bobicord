// Глобальный notify-WS: держим одно соединение к серверу (/ws), пока залогинены. Через него
// приходят уведомления об упоминании/трансляции в ЛЮБОМ нашем сервере — даже в НЕ подключённом
// (LiveKit-комната поднята только для текущего сервера; web-push бьёт лишь по свёрнутому/закрытому,
// а натив web-push вообще не получает). Так «понимаешь, куда зайти».
import { getToken, webOrigin } from './api';
import { notify, type NotifKind } from './notify';
import { useStore } from './store';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let closed = false;
let presenceAway = false; // последнее заявленное idle-состояние (шлём серверу для away/жёлтого статуса)

function scheduleReconnect() {
  if (reconnectTimer || closed) return;
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectNotifyWs(); }, 4000);
}

// Away-статус (см. idle.ts): апп давно не трогали → away:true (жёлтый). Шлём по глобальному notify-WS,
// сервер помечает сессию idle и отдаёт away в presence. На реконнекте переотправляем в onopen.
export function sendPresence(away: boolean): void {
  presenceAway = away;
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ t: 'presence', away })); } catch { /**/ } }
}

export function connectNotifyWs() {
  closed = false;
  const token = getToken();
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = webOrigin().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  ws.onopen = () => { try { ws!.send(JSON.stringify({ t: 'presence', away: presenceAway })); } catch { /**/ } }; // переотправляем текущий idle-статус
  ws.onmessage = (ev) => {
    let d: any; try { d = JSON.parse(ev.data); } catch { return; }
    // кросс-девайс: прочитано на другом устройстве этого юзера → сбрасываем unread локально (и для
    // ПОДКЛЮЧЁННОГО сервера — тут дедуп по viewServerId НЕ применяем, чтение общее по БД).
    if (d.t === 'read') { if (d.serverId) useStore.getState().applyRemoteRead(d.serverId, d.lastRead || 0); return; }
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
  ws.onclose = () => { if (ws === null) return; ws = null; if (!closed) scheduleReconnect(); };
  ws.onerror = () => { try { ws?.close(); } catch { /**/ } };
}

export function disconnectNotifyWs() {
  closed = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { const w = ws; ws = null; try { w.close(); } catch { /**/ } }
}

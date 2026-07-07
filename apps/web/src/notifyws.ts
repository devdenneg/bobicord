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

function scheduleReconnect() {
  if (reconnectTimer || closed) return;
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectNotifyWs(); }, 4000);
}

export function connectNotifyWs() {
  closed = false;
  const token = getToken();
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = webOrigin().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  ws.onmessage = (ev) => {
    let d: any; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.t !== 'notify') return;
    const st = useStore.getState();
    // текущий (подключённый) сервер обслуживает живой LiveKit-путь — тут не дублируем
    if (d.serverId && d.serverId === st.connectedServerId) return;
    notify((d.kind as NotifKind) || 'mention', {
      title: `${d.title || 'Рилэй'}${d.serverName ? ' · ' + d.serverName : ''}`,
      body: d.body || '',
      tag: (d.kind || 'mention') + ':' + (d.serverId || ''),
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

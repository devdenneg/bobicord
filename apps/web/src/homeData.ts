// Чистые хелперы главной («пультовая»): агрегируем ЖИВОЙ эфир и ранжируем серверы из уже забранных
// данных /me (store.servers[].online[]). Никакой сети — только derive из presence. См. Home() в App.tsx.
import type { ServerSummary, OnlineMember } from './types';

// ОДИН эфир-item на сервер: агрегирует стримеров И голосовых (раньше были 2 отдельные карточки).
export type LiveItem = { key: string; server: ServerSummary; streamers: OnlineMember[]; voice: OnlineMember[] };

export type Dominant =
  | { kind: 'live'; n: number }
  | { kind: 'voice'; n: number }
  | { kind: 'unread'; n: number }
  | { kind: 'online'; n: number }
  | { kind: 'quiet'; n: 0 };

type Unread = Record<string, number>;

// «Насколько мне это близко» — прокси из имеющихся данных (нет timestamp/affinity на клиенте).
function interest(s: ServerSummary, unread: Unread, connectedId: string | null): number {
  return (connectedId === s.id ? 3 : 0)
    + ((unread[s.id] || 0) > 0 ? 2 : 0)
    + Math.min((s.onlineCount || 0) / 50, 1);
}

// Живой эфир: ОДНА карточка на сервер, агрегирует стримеров + голосовых. Серверы со стримом выше
// (перишейбл-хедлайн), потом по числу активных / интересу. Стабильный тайбрейк по id — без тряски.
export function deriveLiveItems(servers: ServerSummary[], unread: Unread, connectedId: string | null): LiveItem[] {
  const items: LiveItem[] = [];
  for (const s of servers) {
    const on = s.online || [];
    const streamers = on.filter((m) => m.streaming);
    const voice = on.filter((m) => m.inVoice && !m.streaming);
    if (streamers.length || voice.length) items.push({ key: s.id, server: s, streamers, voice });
  }
  items.sort((a, b) =>
    (b.streamers.length ? 1 : 0) - (a.streamers.length ? 1 : 0)                    // со стримом — выше
    || (b.streamers.length + b.voice.length) - (a.streamers.length + a.voice.length) // больше активных
    || interest(b.server, unread, connectedId) - interest(a.server, unread, connectedId)
    || a.server.id.localeCompare(b.server.id));
  return items.slice(0, 8);
}

// Тир сервера для сортировки сетки (live-first). live>voice>unread>online>quiet.
export function serverTier(s: ServerSummary, unread: Unread): number {
  const on = s.online || [];
  if (on.some((m) => m.streaming)) return 4;
  if (on.some((m) => m.inVoice)) return 3;
  if ((unread[s.id] || 0) > 0) return 2;
  if (s.onlineCount) return 1;
  return 0;
}

// Порядок карточек серверов: тир → непрочитано → онлайн → СТАБИЛЬНЫЙ id (иначе карточки тасуются на тик).
export function rankServers(servers: ServerSummary[], unread: Unread): ServerSummary[] {
  return servers.slice().sort((a, b) =>
    serverTier(b, unread) - serverTier(a, unread)
    || (unread[b.id] || 0) - (unread[a.id] || 0)
    || (b.onlineCount || 0) - (a.onlineCount || 0)
    || a.id.localeCompare(b.id));
}

// Ровно ОДИН доминирующий сигнал карточки (инвертированная пирамида, §4).
export function dominant(s: ServerSummary, unread: Unread): Dominant {
  const on = s.online || [];
  const str = on.filter((m) => m.streaming).length;
  const vc = on.filter((m) => m.inVoice && !m.streaming).length;
  const un = unread[s.id] || 0;
  if (str) return { kind: 'live', n: str };
  if (vc) return { kind: 'voice', n: vc };
  if (un) return { kind: 'unread', n: un };
  if (s.onlineCount) return { kind: 'online', n: s.onlineCount };
  return { kind: 'quiet', n: 0 };
}

// «Играют сейчас»: группируем игроков по ИГРЕ через все серверы (дедуп по username — один человек
// в неск. серверах = один игрок). Иконка — первая непустая. Сортировка по числу игроков.
export type GameGroup = { name: string; icon?: string; players: OnlineMember[] };
export function deriveGames(servers: ServerSummary[]): GameGroup[] {
  const byGame = new Map<string, GameGroup>();
  for (const s of servers) for (const m of s.online || []) {
    if (!m.game) continue;
    const key = m.game.toLowerCase();
    let g = byGame.get(key);
    if (!g) { g = { name: m.game, icon: m.gicon, players: [] }; byGame.set(key, g); }
    if (!g.icon && m.gicon) g.icon = m.gicon;
    if (!g.players.some((p) => p.username === m.username)) g.players.push(m);
  }
  return [...byGame.values()].sort((a, b) => b.players.length - a.players.length || a.name.localeCompare(b.name));
}

// Живой кластер: порядок стрим→голос→онлайн, стабильно по username (лица не прыгают).
export function clusterOrder(members: OnlineMember[]): OnlineMember[] {
  const rank = (m: OnlineMember) => (m.streaming ? 0 : m.inVoice ? 1 : 2);
  return members.slice().sort((a, b) => rank(a) - rank(b) || a.username.localeCompare(b.username));
}

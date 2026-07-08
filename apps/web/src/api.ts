import type { User, ServerSummary, Member, ServerDetail, InvitePreview, HistoryMessage, Role, VoiceChannel, Attachment } from './types';

let token: string | null = localStorage.getItem('sess');
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('sess', t);
  else localStorage.removeItem('sess');
}

// Прод-бэкенд по умолчанию для НАТИВНОЙ сборки: вебвью Tauri грузит локальный bundle
// с origin tauri://localhost, поэтому относительный `/api` резолвится в сам bundle
// (Tauri отдаёт index.html на любой не-ассетный путь → 200 HTML → JSON.parse падает →
// пустой ответ → me/servers undefined → краш на home). В вебе origin тот же, что и бэк
// (Caddy), поэтому база пустая. Явный VITE_API_BASE_URL переопределяет оба случая.
// Тот же приём, что и treeWsUrl() в native.ts для ws-дерева.
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const PROD_API = 'https://138-16-170-21.sslip.io';
const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || (IS_TAURI ? PROD_API : '');

// Сервер отдаёт относительные пути (`/api/uploads/<name>`, см. index.js) — в вебе это
// корректно (Caddy проксирует тот же origin), но в Tauri вебвью грузит локальный bundle
// со своим origin (tauri://localhost), относительный путь резолвится ТУДА, не на бэкенд.
// Оставляем хранимое значение (avatarUrl/img) относительным (сервер валидирует именно
// такой формат при записи, UPLOAD_RE) — префиксуем только для <img src> на рендере.
export function resolveUploadUrl(u: string): string;
export function resolveUploadUrl(u: string | undefined): string | undefined;
export function resolveUploadUrl(u?: string): string | undefined {
  if (!u || !API_BASE || /^https?:\/\//i.test(u)) return u;
  return API_BASE + u;
}

// Origin веб-приложения для внешних ссылок (инвайты). В нативе location.origin =
// tauri.localhost, поэтому берём прод-хост (Caddy отдаёт и веб, и API на одном origin).
// В вебе API_BASE пуст → location.origin. Инвайт всегда должен открываться в браузере.
export function webOrigin(): string {
  return API_BASE || location.origin;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opt: RequestInit = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  // таймаут: мёртвый TCP иначе оставляет промис висеть вечно → «отправляется» без failed/повтора
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
  if (ctrl) opt.signal = ctrl.signal;
  let r: Response;
  try { r = await fetch(API_BASE + '/api' + path, opt); }
  catch (e) { throw new Error(ctrl?.signal.aborted ? 'Таймаут запроса' : (e instanceof Error ? e.message : 'Сеть недоступна')); }
  finally { if (timer) clearTimeout(timer); }
  let d: any = {};
  let parsed = false;
  try { d = await r.json(); parsed = true; } catch { /* ignore */ }
  if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
  // 200, но тело не JSON (напр. index.html при неверном API_BASE в нативе) — падаем
  // громко, а не отдаём {} наверх (иначе me/servers undefined → белый экран на home).
  if (!parsed) throw new Error('Некорректный ответ сервера (' + path + ')');
  return d as T;
}

export const api = {
  register: (username: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/register', { username, password }),
  login: (username: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/login', { username, password }),
  me: () => req<{ user: User; servers: ServerSummary[] }>('GET', '/me'),
  updateMe: (patch: { displayName?: string; bio?: string; avatarColor?: number; avatarUrl?: string }) =>
    req<{ user: User }>('PATCH', '/me', patch),
  uploadImage: async (file: Blob): Promise<{ url: string }> => {
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API_BASE + '/api/upload', { method: 'POST', headers, body: file });
    let d: any = {};
    try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
    return d as { url: string };
  },
  // произвольный файл-вложение (любое расширение, <=10MB) — раздаётся форс-скачиванием, не инлайн.
  // Имя передаём отдельным заголовком (raw body = сами байты файла, без multipart).
  uploadFile: async (file: File): Promise<{ url: string; name: string; size: number }> => {
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream', 'X-Attachment-Name': encodeURIComponent(file.name) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API_BASE + '/api/upload-file', { method: 'POST', headers, body: file });
    let d: any = {};
    try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
    return d as { url: string; name: string; size: number };
  },
  createServer: (name: string) =>
    req<{ server: ServerSummary; invite: string; inviteExpires: number }>('POST', '/servers', { name }),
  getServer: (id: string) =>
    req<{ server: ServerDetail; members: Member[]; myRole: string; myPerms: number }>('GET', '/servers/' + id),
  patchServer: (id: string, patch: { name?: string; description?: string; iconColor?: number; iconUrl?: string }) =>
    req<{ server: ServerDetail }>('PATCH', '/servers/' + id, patch),
  leaveServer: (id: string) => req<{ ok: boolean }>('POST', `/servers/${id}/leave`),
  kickMember: (id: string, userId: string) => req<{ ok: boolean }>('POST', `/servers/${id}/kick`, { userId }),
  deleteServer: (id: string) => req<{ ok: boolean }>('DELETE', '/servers/' + id),
  createInvite: (id: string) =>
    req<{ code: string; expires: number }>('POST', `/servers/${id}/invites`),
  invitePreview: (code: string) => req<InvitePreview>('GET', '/invites/' + encodeURIComponent(code)),
  joinInvite: (code: string) =>
    req<{ server: ServerSummary }>('POST', `/invites/${encodeURIComponent(code)}/join`),
  getRoles: (id: string) => req<{ roles: Role[] }>('GET', `/servers/${id}/roles`),
  createRole: (id: string, r: { name: string; color: string; permissions: number }) => req<{ role: Role }>('POST', `/servers/${id}/roles`, r),
  updateRole: (id: string, rid: string, patch: Partial<{ name: string; color: string; permissions: number; position: number }>) => req<{ role: Role }>('PATCH', `/servers/${id}/roles/${rid}`, patch),
  deleteRole: (id: string, rid: string) => req<{ ok: boolean }>('DELETE', `/servers/${id}/roles/${rid}`),
  setMemberRoles: (id: string, userId: string, roleIds: string[]) => req<{ roles: Role[] }>('PUT', `/servers/${id}/members/${userId}/roles`, { roleIds }),
  getChannels: (id: string) => req<{ channels: VoiceChannel[] }>('GET', `/servers/${id}/channels`),
  createChannel: (id: string, name: string) => req<{ channel: VoiceChannel; channels: VoiceChannel[] }>('POST', `/servers/${id}/channels`, { name }),
  renameChannel: (id: string, cid: string, name: string) => req<{ channels: VoiceChannel[] }>('PATCH', `/servers/${id}/channels/${cid}`, { name }),
  deleteChannel: (id: string, cid: string) => req<{ channels: VoiceChannel[] }>('DELETE', `/servers/${id}/channels/${cid}`),
  clearChat: (id: string) => req<{ ok: boolean }>('POST', `/servers/${id}/clear`),
  serverToken: (id: string) => req<{ token: string; url: string; room: string }>('GET', `/servers/${id}/token`),
  getSettings: (id: string) => req<{ data: any }>('GET', `/servers/${id}/settings`),
  putSettings: (id: string, data: any) => req<{ ok: boolean }>('PUT', `/servers/${id}/settings`, { data }),
  // аккаунтные настройки (хоткеи и т.п.) — следуют за юзером на любом устройстве, не за localStorage
  getMySettings: () => req<{ data: any }>('GET', '/me/settings'),
  putMySettings: (data: any) => req<{ ok: boolean }>('PUT', '/me/settings', { data }),
  presence: (id: string) => req<{ online: string[]; voice?: Record<string, string> }>('GET', `/servers/${id}/presence`),
  // all:true — «прочитать всё» (сервер выставит last_read=MAX id, покрывая живые сообщения без sid). Возвращает актуальный lastRead.
  markRead: (id: string, lastId: number, all?: boolean) => req<{ ok: boolean; lastRead: number }>('POST', `/servers/${id}/read`, { lastId, all }),
  getUnread: () => req<Record<string, number>>('GET', '/unread'),
  // курсорная пагинация: before = id строки, старше которой грузить (undefined = последняя страница)
  getMessages: (id: string, before?: number, limit?: number) => {
    const qs = new URLSearchParams();
    if (before) qs.set('before', String(before));
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    return req<{ messages: HistoryMessage[]; hasMore: boolean }>('GET', `/servers/${id}/messages${q ? '?' + q : ''}`);
  },
  postMessage: (id: string, text: string, em: Record<string, string>, image?: string, reply?: import('./types').ReplyRef, key?: string, files?: Attachment[]) => req<{ ok: boolean }>('POST', `/servers/${id}/messages`, { text, em, image, reply, key, files }),
  // Web Push (фоновые уведомления PWA/браузера)
  pushVapid: () => req<{ enabled: boolean; key: string }>('GET', '/push/vapid'),
  pushSubscribe: (sub: unknown, prefs: { mention: boolean; stream: boolean }) => req<{ ok: boolean }>('POST', '/push/subscribe', { sub, prefs }),
  pushUnsubscribe: (endpoint: string) => req<{ ok: boolean }>('POST', '/push/unsubscribe', { endpoint }),
  // вещатель сообщает серверу о старте трансляции → фоновый push участникам не в комнате
  streamStart: (id: string) => req<{ ok: boolean }>('POST', `/servers/${id}/stream-start`),
  // публичный (без auth) — свежий билд натива для кнопки скачивания в вебе; 404 если билда нет
  appLatest: async (): Promise<{ version: string; url: string } | null> => {
    try {
      const r = await fetch(API_BASE + '/api/app/latest');
      if (!r.ok) return null;
      const d = await r.json();
      const url = d?.platforms?.['windows-x86_64']?.url;
      return url ? { version: d.version, url } : null;
    } catch { return null; }
  },
  // аллоулист игр Discord (дистиллят с сервера) — натив матчит запущенные процессы для детекта игры
  detectableGames: () => req<{ games: { name: string; exes: string[] }[] }>('GET', '/detectable-games'),
};

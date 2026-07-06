import type { User, ServerSummary, Member, ServerDetail, InvitePreview, HistoryMessage, Role } from './types';

let token: string | null = localStorage.getItem('sess');
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('sess', t);
  else localStorage.removeItem('sess');
}

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || '';

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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opt: RequestInit = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(API_BASE + '/api' + path, opt);
  let d: any = {};
  try { d = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
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
    const r = await fetch('/api/upload', { method: 'POST', headers, body: file });
    let d: any = {};
    try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
    return d as { url: string };
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
  clearChat: (id: string) => req<{ ok: boolean }>('POST', `/servers/${id}/clear`),
  serverToken: (id: string) => req<{ token: string; url: string; room: string }>('GET', `/servers/${id}/token`),
  getSettings: (id: string) => req<{ data: any }>('GET', `/servers/${id}/settings`),
  putSettings: (id: string, data: any) => req<{ ok: boolean }>('PUT', `/servers/${id}/settings`, { data }),
  presence: (id: string) => req<{ online: string[] }>('GET', `/servers/${id}/presence`),
  getMessages: (id: string) => req<{ messages: HistoryMessage[] }>('GET', `/servers/${id}/messages`),
  postMessage: (id: string, text: string, em: Record<string, string>, image?: string) => req<{ ok: boolean }>('POST', `/servers/${id}/messages`, { text, em, image }),
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
};

import type {
  User, ServerSummary, Member, ServerDetail, InvitePreview, HistoryMessage, Role, VoiceChannel,
  Attachment, AdminOverview, Emote, AuthResponse, ChallengeResponse,
  RegistrationInvite, ReleaseHistoryResponse, SessionResponse,
} from './types';

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
const PROD_API = 'https://reelay.online'; // прод-бэкенд для НАТИВНОЙ сборки (веб — относит. пути); легаси sslip.io Caddy тоже отдаёт
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

export interface VoiceLease {
  sessionId: string;
  serverId: string;
  channelId: string;
  epoch: number;
  claimedAt: number;
}
export interface VoiceLeaseEvent {
  ok?: boolean;
  t: 'voice-lease';
  reason: 'snapshot' | 'minted' | 'claimed' | 'idempotent' | 'released' | 'stale' | 'stale-ticket' | 'consumed' | 'ticket-required' | 'revoked' | 'request-aborted' | 'session-gone' | 'membership-revoked' | 'channel-deleted' | 'server-revoked' | 'server-deleted' | 'account-deleted';
  lease: VoiceLease | null;
  currentEpoch: number;
  accepted?: boolean;
  released?: boolean;
}
export interface VoiceIntentTicket extends VoiceLeaseEvent {
  ticket: number;
  clientIntent: number;
  idempotent?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryAfter?: number;
  readonly details?: Record<string, unknown>;
  readonly attemptsRemaining?: number;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    field?: string;
    retryAfter?: number;
    details?: Record<string, unknown>;
    attemptsRemaining?: number;
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status || 0;
    this.code = options.code || 'UNKNOWN_ERROR';
    this.field = options.field;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
    this.attemptsRemaining = options.attemptsRemaining;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

interface RequestOptions {
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

function retryAfterSeconds(response: Response, data: any): number | undefined {
  const raw = data?.error?.retryAfter ?? data?.error?.details?.retryAfter ?? data?.retryAfter;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

async function req<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.auth !== false && token) headers['Authorization'] = 'Bearer ' + token;
  Object.assign(headers, options.headers || {});
  const opt: RequestInit = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  // таймаут: мёртвый TCP иначе оставляет промис висеть вечно → «отправляется» без failed/повтора
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const relayAbort = () => ctrl?.abort();
  if (options.signal?.aborted) ctrl?.abort();
  else options.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = ctrl ? setTimeout(() => ctrl.abort(), options.timeoutMs ?? 15000) : null;
  if (ctrl) opt.signal = ctrl.signal;
  let r: Response;
  let d: any = {};
  let parsed = false;
  try {
    r = await fetch(API_BASE + '/api' + path, opt);
    try { d = await r.json(); parsed = true; }
    catch (e) { if (ctrl?.signal.aborted) throw e; }
  }
  catch (e) {
    const externallyAborted = Boolean(options.signal?.aborted);
    throw new ApiError(
      externallyAborted ? 'Запрос отменён' : ctrl?.signal.aborted ? 'Сервер не ответил вовремя' : 'Не удалось связаться с сервером',
      { code: externallyAborted ? 'REQUEST_ABORTED' : ctrl?.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR' },
    );
  }
  finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
  }
  if (!r.ok) {
    const raw = d?.error;
    const detail = raw && typeof raw === 'object' ? raw : d;
    const message = typeof raw === 'string' ? raw : detail?.message || 'Ошибка ' + r.status;
    const details = detail?.details && typeof detail.details === 'object' ? detail.details as Record<string, unknown> : undefined;
    const attemptsRemaining = Number(detail?.attemptsRemaining ?? details?.attemptsRemaining);
    throw new ApiError(message, {
      status: r.status,
      code: detail?.code || (r.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR'),
      field: detail?.field || details?.field as string | undefined,
      retryAfter: retryAfterSeconds(r, d),
      details,
      attemptsRemaining: Number.isFinite(attemptsRemaining) && attemptsRemaining >= 0 ? Math.floor(attemptsRemaining) : undefined,
    });
  }
  if (r.status === 204) return undefined as T;
  // 200, но тело не JSON (напр. index.html при неверном API_BASE в нативе) — падаем
  // громко, а не отдаём {} наверх (иначе me/servers undefined → белый экран на home).
  if (!parsed) throw new ApiError('Некорректный ответ сервера (' + path + ')', { status: r.status, code: 'INVALID_RESPONSE' });
  return d as T;
}

export const api = {
  authSession: () => req<SessionResponse>('GET', '/auth/session'),
  login: (username: string, password: string) =>
    req<AuthResponse>('POST', '/login', { username, password }, { auth: false }),
  registerStart: (payload: { username: string; email: string; password: string; inviteCode: string; requestId: string }) =>
    req<ChallengeResponse>('POST', '/auth/register/start', payload, { auth: false }),
  registerVerify: (flowId: string, code: string) =>
    req<AuthResponse>('POST', '/auth/register/verify', { flowId, code }, { auth: false }),
  registerResend: (flowId: string) =>
    req<ChallengeResponse>('POST', '/auth/register/resend', { flowId }, { auth: false }),
  emailStart: (email: string, currentPassword: string, requestId: string, supportCode?: string) =>
    req<ChallengeResponse>('POST', '/auth/email/start', { email, currentPassword, requestId, supportCode }),
  emailVerify: (flowId: string, code: string) =>
    req<SessionResponse & { token?: string }>('POST', '/auth/email/verify', { flowId, code }),
  emailResend: (flowId: string) =>
    req<ChallengeResponse>('POST', '/auth/email/resend', { flowId }),
  forgotPassword: (email: string) =>
    req<{ ok?: boolean; resendAt?: number }>('POST', '/auth/password/forgot', { email }, { auth: false }),
  inspectPasswordReset: (token: string) =>
    req<{ valid?: boolean; username?: string; expiresAt?: number }>('POST', '/auth/password/reset/inspect', { token }, { auth: false }),
  resetPassword: (token: string, password: string) =>
    req<{ ok?: boolean; username?: string }>('POST', '/auth/password/reset', { token, password }, { auth: false }),
  me: () => req<{ user: User; servers: ServerSummary[] }>('GET', '/me'),
  releaseHistory: (signal?: AbortSignal) => req<ReleaseHistoryResponse>('GET', '/releases/history', undefined, { signal }),
  updateMe: (patch: { displayName?: string; bio?: string; avatarColor?: number; avatarUrl?: string; profileBannerUrl?: string }) =>
    req<{ user: User }>('PATCH', '/me', patch),
  uploadImage: async (file: Blob): Promise<{ url: string; width: number; height: number }> => {
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API_BASE + '/api/upload', { method: 'POST', headers, body: file });
    let d: any = {};
    try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
    return d as { url: string; width: number; height: number };
  },
  uploadProfileBanner: async (file: Blob, signal?: AbortSignal): Promise<{ url: string }> => {
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API_BASE + '/api/upload/profile-banner', { method: 'POST', headers, body: file, signal });
    let d: any = {};
    try { d = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(d?.error || 'Ошибка ' + r.status);
    return d as { url: string };
  },
  deleteProfileBannerUpload: (url: string) => req<{ ok: boolean; removed: boolean }>('DELETE', '/upload/profile-banner', { url }),
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
  patchServer: (id: string, patch: { name?: string; description?: string; iconColor?: number; iconUrl?: string; musicEnabled?: boolean; statsEnabled?: boolean }) =>
    req<{ server: ServerDetail }>('PATCH', '/servers/' + id, patch),
  getLeaderboard: (id: string) => req<import('./types').Leaderboard>('GET', `/servers/${id}/leaderboard`),
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
  serverToken: (id: string) => req<{ token: string; url: string; room: string; sessionId: string }>('GET', `/servers/${id}/token`),
  getVoiceLease: () => req<VoiceLeaseEvent>('GET', '/voice/lease'),
  mintVoiceIntent: (sessionId: string, serverId: string, channelId: string, clientIntent: number) =>
    req<VoiceIntentTicket>('POST', '/voice/lease/intent', { sessionId, serverId, channelId, clientIntent }),
  claimVoiceLease: (sessionId: string, serverId: string, channelId: string, clientIntent: number, ticket: number) =>
    req<VoiceLeaseEvent>('POST', '/voice/lease/claim', { sessionId, serverId, channelId, clientIntent, ticket }),
  releaseVoiceLease: (sessionId: string, epoch: number) =>
    req<VoiceLeaseEvent>('POST', '/voice/lease/release', { sessionId, epoch }),
  getSettings: (id: string) => req<{ data: any }>('GET', `/servers/${id}/settings`),
  putSettings: (id: string, data: any) => req<{ ok: boolean }>('PUT', `/servers/${id}/settings`, { data }),
  // аккаунтные настройки (хоткеи и т.п.) — следуют за юзером на любом устройстве, не за localStorage
  getMySettings: () => req<{ data: any }>('GET', '/me/settings'),
  putMySettings: (data: any) => req<{ ok: boolean }>('PUT', '/me/settings', { data }),
  presence: (id: string) => req<{ online: string[]; voice?: Record<string, string>; away?: string[] }>('GET', `/servers/${id}/presence`),
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
  postMessage: (id: string, text: string, em: Record<string, string>, image?: string, reply?: import('./types').ReplyRef, key?: string, files?: Attachment[], kind?: string, level?: number) => req<{ ok: boolean; id?: number }>('POST', `/servers/${id}/messages`, { text, em, image, reply, key, files, kind, level }),
  reactMessage: (id: string, mid: number, emoteId: string, emoteName: string, add: boolean) => req<{ ok: boolean }>('POST', `/servers/${id}/messages/${mid}/react`, { emoteId, emoteName, add }),
  editMessage: (id: string, mid: number, text: string) => req<{ ok: boolean }>('PATCH', `/servers/${id}/messages/${mid}`, { text }),
  deleteMessage: (id: string, mid: number) => req<{ ok: boolean }>('DELETE', `/servers/${id}/messages/${mid}`),
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
  // --- Админка (denis + кому выдали) ---
  adminOverview: () => req<AdminOverview>('GET', '/admin/overview'),
  adminDeleteServer: (id: string) => req<{ ok: boolean }>('DELETE', `/admin/servers/${id}`),
  adminRemoveMember: (serverId: string, userId: string) => req<{ ok: boolean }>('DELETE', `/admin/servers/${serverId}/members/${userId}`),
  adminDeleteUser: (id: string) => req<{ ok: boolean }>('DELETE', `/admin/users/${id}`),
  adminSetAdmin: (id: string, admin: boolean) => req<{ ok: boolean; isAdmin: boolean }>('POST', `/admin/users/${id}/admin`, { admin }),
  adminEmailBindingSupportCode: (id: string) => req<{ ok: boolean; userId: string; code: string; expiresAt: number }>(
    'POST', `/admin/users/${id}/email-binding-support-code`, {},
  ),
  adminRegistrationInvite: async () => {
    const response = await req<RegistrationInvite & { validUntil?: number }>('GET', '/admin/registration-invite');
    const rawExpiry = response.expiresAt || response.validUntil || 0;
    return { ...response, expiresAt: rawExpiry && rawExpiry < 1_000_000_000_000 ? rawExpiry * 1000 : rawExpiry };
  },
  adminRotateRegistrationInvite: async () => {
    const response = await req<RegistrationInvite & { validUntil?: number }>('POST', '/admin/registration-invite/rotate', {});
    const rawExpiry = response.expiresAt || response.validUntil || 0;
    return { ...response, expiresAt: rawExpiry && rawExpiry < 1_000_000_000_000 ? rawExpiry * 1000 : rawExpiry };
  },
  // Диагностика стрима: клиент сдаёт сессию по её окончании (см. diag.ts). Тело крупнее
  // обычного (лог + семплы) — сервер парсит этот путь отдельным express.json({limit:'2mb'}).
  diagSession: (payload: unknown) => req<{ ok: boolean; name: string }>('POST', '/diag/session', payload),
  // 7TV-прокси (обход блокировки 7tv.io у части провайдеров) — фолбэк, когда direct недоступен.
  // req() даёт префикс API_BASE (натив → прод-хост, иначе относит.) + таймаут; search шлёт Authorization.
  sevenGlobal: () => req<{ emotes?: { name: string; id: string }[] }>('GET', '/7tv/global'),
  sevenSearch: async (q: string, p: number): Promise<Emote[]> => {
    const qs = new URLSearchParams({ q, p: String(p) }).toString();
    const d = await req<{ items: Emote[] }>('GET', `/7tv/search?${qs}`);
    return d.items || [];
  },
  // Резолв аудио-URL совместного прослушивания через медиа-релей (обход блокировки YouTube).
  // Возвращает готовый URL для <audio> (аудио идёт браузер↔релей, мимо основного VPS). 503 = релей выкл.
  musicResolve: (id: string) => req<{ url: string; title?: string; duration?: number }>('GET', `/music/resolve/${id}`),
};

/** Отправка на выгрузке страницы (`pagehide`): обычный fetch браузер убьёт вместе с
 *  документом, `keepalive` — доживёт. Цена: суммарный лимит тела keepalive-запросов
 *  64 КБ, поэтому вызывающий обязан прислать усечённый payload (см. diag.ts).
 *  sendBeacon не подходит — он не умеет ставить заголовок Authorization. */
export function diagSessionKeepalive(payload: unknown): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  try {
    void fetch(API_BASE + '/api/diag/session', { method: 'POST', headers, body: JSON.stringify(payload), keepalive: true });
  } catch { /* страница уже уходит — жаловаться некому */ }
}

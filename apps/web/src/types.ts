export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  avatarUrl?: string;
  bio: string;
}

// права роли (битовая маска, синхронно с server/index.js PERM)
export const PERM = { MANAGE_SERVER: 1, MANAGE_ROLES: 2, MANAGE_MEMBERS: 4, MANAGE_MESSAGES: 8, CREATE_INVITE: 16, MANAGE_CHANNELS: 32 } as const;
export const PERM_LIST: { key: keyof typeof PERM; label: string; hint: string }[] = [
  { key: 'MANAGE_SERVER', label: 'Управление сервером', hint: 'Менять название, описание, обложку' },
  { key: 'MANAGE_CHANNELS', label: 'Управление каналами', hint: 'Создавать и удалять голосовые каналы' },
  { key: 'MANAGE_ROLES', label: 'Управление ролями', hint: 'Создавать роли и назначать их' },
  { key: 'MANAGE_MEMBERS', label: 'Выгонять участников', hint: 'Кикать с сервера' },
  { key: 'MANAGE_MESSAGES', label: 'Модерация чата', hint: 'Чистить чат, команды' },
];

export interface VoiceChannel {
  id: string;
  name: string;
  position: number;
}
export const hasPerm = (perms: number, flag: number) => (perms & flag) === flag;

export interface Role {
  id: string;
  name: string;
  color: string; // '#rrggbb' или '' (наследует)
  permissions: number;
  position: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  ownerId: string;
  iconColor: number;
  iconUrl?: string;
  description?: string;
  role: string;
  memberCount: number;
  online?: string[];
  onlineCount?: number;
}

export interface Member {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  avatarUrl?: string;
  bio?: string;
  role: string;
  roles?: Role[];
}

export interface ServerDetail {
  id: string;
  name: string;
  ownerId: string;
  iconColor: number;
  iconUrl?: string;
  description?: string;
  memberCount: number;
  myRole: string;
  myPerms?: number;
  roles?: Role[];
  channels?: VoiceChannel[];
}

export interface InvitePreview {
  server: { id: string; name: string; iconColor: number; memberCount: number };
  requiresPassword: boolean;
}

export type ToastKind = 'ok' | 'warn' | 'err' | 'info';
export interface Toast { id: number; text: string; kind: ToastKind }

// ссылка на исходное сообщение при ответе (reply)
export interface ReplyRef {
  author: string;  // displayName автора исходного сообщения
  text: string;    // короткий сниппет исходного текста ('' если только картинка)
  uid?: string;    // user id автора — для адресного уведомления (ответ = как тег)
  sid?: number;    // id строки в БД исходного — для перехода к оригиналу
  img?: boolean;   // в исходном была картинка
}

export interface ChatMessage {
  id: number; // локальный монотонный ключ (React key), НЕ id строки в БД
  sid?: number; // id строки в БД (курсор пагинации) — есть только у сообщений из истории
  uid?: string; // user id автора (для reply-таргетинга/подсветки), null у системных
  who: string | null; // null = system
  text: string;
  mine: boolean;
  sys: boolean;
  color?: number; // avatar color index of author
  img?: string; // attached image URL
  ts?: number; // timestamp (ms)
  mention?: boolean; // упоминает меня (@ник) ИЛИ ответ на моё сообщение
  reply?: ReplyRef; // это ответ на другое сообщение
  status?: 'failed'; // не удалось сохранить на сервере (показываем «не отправлено · повторить»)
}

export interface HistoryMessage {
  id?: number; // id строки в БД — курсор пагинации (before=<id>)
  uid: string;
  name: string;
  color: number;
  text: string;
  em: Record<string, string>;
  img?: string;
  ts: number;
  reply?: ReplyRef;
}

export interface Emote { id: string; name: string }

export type Presence = 'voice' | 'online' | 'offline';

export interface AudioSettings {
  input: string;
  output: string;
  ns: boolean;
  ec: boolean;
  agc: boolean;
  mode: 'voice' | 'ptt';
  pttKey: string;
  master: number;
  sensitivity: number; // порог чувствительности ввода, 0..100 (нормализованная dB-шкала)
  sensitivityAuto: boolean; // авто-подбор порога по шумовому фону
  notifyVolume: number; // громкость звуков-уведомлений в %
  keybinds: Keybinds; // хоткеи мута (коды KeyboardEvent.code, 1..3 клавиши)
  disableGlobalHotkeys: boolean; // чекбокс «отключить комбинацию вне приложения» (только натив)
}

// Каждый бинд — массив KeyboardEvent.code (напр. ['KeyM'] или ['ControlLeft','ShiftLeft','KeyM']).
export interface Keybinds {
  muteMic: string[]; // «Заглушить микрофон» (свой мик)
  deafen: string[]; // «Заглушить звук» (все звуки, deafen)
}
export type KeybindAction = keyof Keybinds;

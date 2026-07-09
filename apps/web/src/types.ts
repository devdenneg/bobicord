export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  avatarUrl?: string;
  bio: string;
  isAdmin?: boolean;
}

// Админ-панель (/admin) — обзор всех серверов/юзеров
export interface AdminMember { id: string; username: string; displayName: string; role: string }
export interface AdminServer {
  id: string; name: string; iconUrl?: string; iconColor: number; created: number;
  owner: { id: string; username: string; displayName: string } | null;
  memberCount: number; members: AdminMember[];
}
export interface AdminUser {
  id: string; username: string; displayName: string; avatarColor: number; avatarUrl?: string;
  isAdmin: boolean; created: number; serverCount: number; ownedCount: number;
}
export interface AdminOverview { stats: { servers: number; users: number }; servers: AdminServer[]; users: AdminUser[] }

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

// online-участник для превью на главной: аватар/имя + чем занят (стрим/голос)
export interface OnlineMember {
  username: string;
  displayName: string;
  avatarColor: number;
  avatarUrl?: string;
  streaming: boolean;
  inVoice: boolean;
  game?: string;   // игровой статус (натив) — для блока «Играют сейчас» на главной
  gicon?: string;  // base64 PNG иконки игры
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
  online?: OnlineMember[];
  onlineCount?: number;
  unread?: number;
  lastRead?: number; // id последнего прочитанного сообщения (для дивайдера «новые» в чате)
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
  text: string;    // короткий сниппет исходного текста ('' если только картинка/файл)
  uid?: string;    // user id автора — для адресного уведомления (ответ = как тег)
  sid?: number;    // id строки в БД исходного — для перехода к оригиналу
  img?: boolean;   // в исходном была картинка (legacy-поле img ИЛИ files с kind:'image')
  hasFile?: boolean; // в исходном был файл-вложение (kind:'file')
}

// вложение к сообщению — картинка (инлайн-превью, /api/uploads/*) или произвольный файл
// (форс-скачивание, /api/files/*). До 5 штук на сообщение (см. sanitizeAttachments на сервере).
export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'file';
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
  img?: string; // attached image URL (legacy, сообщения до введения files)
  files?: Attachment[]; // вложения (картинки + файлы), новый путь
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
  files?: Attachment[];
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
  notif: boolean; // мастер системных уведомлений (opt-in; включение запрашивает разрешение ОС)
  notifMention: boolean; // уведомлять при упоминании/ответе
  notifStream: boolean; // уведомлять о старте трансляции
  notifUpdate: boolean; // уведомлять о доступном обновлении
  shareGame: boolean; // показывать другим, в какую игру играю (натив; foreground-фуллскрин детект)
  keybinds: Keybinds; // хоткеи мута (коды KeyboardEvent.code, 1..3 клавиши)
  disableGlobalHotkeys: boolean; // чекбокс «отключить комбинацию вне приложения» (только натив)
}

// Каждый бинд — массив KeyboardEvent.code (напр. ['KeyM'] или ['ControlLeft','ShiftLeft','KeyM']).
export interface Keybinds {
  muteMic: string[]; // «Заглушить микрофон» (свой мик)
  deafen: string[]; // «Заглушить звук» (все звуки, deafen)
}
export type KeybindAction = keyof Keybinds;

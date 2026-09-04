export type VoiceDiagnosticIncident =
  | 'manual' | 'join_succeeded' | 'join_stuck' | 'connection_failed' | 'reconnect_loop' | 'uplink_silent'
  | 'inbound_silent' | 'mute_divergence' | 'mic_failed' | 'playback_blocked'
  | 'output_route_failed' | 'ui_stall' | 'session_ended'
  | 'stream_watch_succeeded' | 'stream_watch_failed' | 'stream_watch_recovered'
  | 'auth_failed' | 'auth_recovered';
export type VoiceDiagnosticClientKind = 'web' | 'native';
export type VoiceDiagnosticWatchEndReason =
  | 'user_close' | 'view_switch' | 'server_exit' | 'auth_handoff' | 'session_terminal'
  | 'logout' | 'engine_dispose' | 'connection_loss' | 'stream_ended' | 'quality_change'
  | 'recovery_failed' | 'playback_timeout' | 'superseded' | 'unknown';
export interface VoiceDiagnosticClient {
  kind: VoiceDiagnosticClientKind;
  platform: 'ios' | 'ipados' | 'android' | 'macos' | 'windows' | 'linux' | 'other' | 'unknown';
  installMode: 'browser' | 'standalone' | 'native' | 'unknown';
  networkType: 'slow-2g' | '2g' | '3g' | '4g' | 'wifi' | 'ethernet' | 'cellular' | 'other' | 'unknown';
  appVersion?: string;
}
export interface VoiceDiagnosticEvent {
  atMs: number;
  kind: 'join_started' | 'intent_finished' | 'hub_connected' | 'lease_claimed'
    | 'media_token_received' | 'media_connected' | 'media_activated' | 'join_completed'
    | 'join_failed' | 'mic_capture_finished' | 'mic_published' | 'mic_recovery_started'
    | 'mic_recovery_finished' | 'mute_changed' | 'deafen_changed' | 'background'
    | 'foreground' | 'network_changed' | 'reconnecting' | 'reconnected' | 'disconnected'
    | 'playback_blocked' | 'output_route_failed' | 'ui_stall' | 'rtc_sample'
    | 'uplink_stalled' | 'inbound_stalled' | 'left'
    | 'stream_watch_started' | 'stream_watch_step' | 'stream_watch_retry' | 'stream_watch_finished'
    | 'auth_request_started' | 'auth_request_finished';
  stage?: 'intent' | 'hub' | 'claim' | 'media_token' | 'media_connect' | 'activation'
    | 'mic_capture' | 'mic_publish' | 'mic_recovery' | 'playback' | 'output_route' | 'rtc' | 'ui'
    | 'watch_intent' | 'watch_auth' | 'watch_listeners' | 'watch_native_start'
    | 'watch_signaling' | 'watch_join' | 'watch_parent' | 'watch_negotiation'
    | 'watch_track' | 'watch_playback' | 'watch_recovery'
    | 'auth_login' | 'auth_session' | 'auth_profile';
  outcome?: 'started' | 'ok' | 'failed' | 'timed_out' | 'blocked' | 'unsupported'
    | 'cancelled' | 'superseded' | 'stalled' | 'recovered';
  code?: 'none' | 'timeout' | 'network' | 'offline' | 'auth' | 'permission' | 'device_lost'
    | 'media_blocked' | 'disconnected' | 'sdk' | 'unsupported' | 'aborted' | 'invalid_state' | 'unknown'
    | 'session_closing' | 'rate_limited' | 'server' | 'invalid_response'
    | 'signaling_unauthorized' | 'signaling_forbidden' | 'listener_failed'
    | 'native_start_failed' | 'signaling_closed' | 'no_parent' | 'negotiation_failed'
    | 'ice_failed' | 'track_missing' | 'decode_timeout' | 'playback_waiting';
  httpStatus?: number;
  requestElapsedMs?: number;
  connectionState?: 'new' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed' | 'unknown';
  iceState?: 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed' | 'unknown';
  trackState?: 'live' | 'ended' | 'missing' | 'unknown';
  audioContextState?: 'running' | 'suspended' | 'interrupted' | 'closed' | 'missing' | 'unknown';
  outputRoute?: 'default' | 'custom' | 'system' | 'unsupported' | 'unknown';
  outputTarget?: 'voice_mixer' | 'media_element' | 'stream_mixer' | 'context_recovery';
  outputOperation?: 'enumerate' | 'set_sink' | 'create_context' | 'rebind' | 'resume' | 'start_audio';
  micMode?: 'voice' | 'ptt' | 'unknown';
  micCapturePath?: 'direct' | 'webaudio';
  streamTransport?: 'livekit' | 'tree_web' | 'tree_native';
  watchEndReason?: VoiceDiagnosticWatchEndReason;
  networkType?: VoiceDiagnosticClient['networkType'];
  documentHidden?: boolean;
  online?: boolean;
  micEnabled?: boolean;
  publicationMuted?: boolean;
  upstreamPaused?: boolean;
  deafened?: boolean;
  pushToTalk?: boolean;
  speechDetected?: boolean;
  canPlaybackAudio?: boolean;
  rttMs?: number;
  jitterMs?: number;
  packetsLostDelta?: number;
  packetsReceivedDelta?: number;
  packetsSentDelta?: number;
  bytesReceivedDelta?: number;
  bytesSentDelta?: number;
  concealedSamplesDelta?: number;
  audioLevel?: number;
  eventLoopLagMs?: number;
  joinElapsedMs?: number;
  reconnectCount?: number;
  participantCount?: number;
}
export interface VoiceDiagnosticReport {
  schemaVersion: 1;
  /** Random, non-secret idempotency key. Older deployed clients may omit it. */
  clientReportId?: string;
  incident: VoiceDiagnosticIncident;
  client: VoiceDiagnosticClient;
  durationMs: number;
  events: VoiceDiagnosticEvent[];
  truncated?: boolean;
}
export interface AdminVoiceDiagnosticSummary {
  id: string;
  userId: string;
  username: string;
  incident: VoiceDiagnosticIncident;
  client: VoiceDiagnosticClientKind;
  platform: VoiceDiagnosticClient['platform'];
  createdAt: number;
  eventCount: number;
  durationMs: number;
  truncated: boolean;
}
export interface AdminVoiceDiagnosticCursor {
  createdAt: number;
  id: string;
}
export interface AdminVoiceDiagnosticsPage {
  items: AdminVoiceDiagnosticSummary[];
  nextCursor: AdminVoiceDiagnosticCursor | null;
}
export interface AdminVoiceDiagnosticDetail {
  id: string;
  userId: string;
  username: string;
  createdAt: number;
  report: VoiceDiagnosticReport;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  avatarUrl?: string;
  profileBannerUrl?: string;
  bio: string;
  isAdmin?: boolean;
  /** Full verified address is present only in authenticated owner responses. */
  email?: string;
  emailVerified?: boolean;
}

export interface EmailChallenge {
  /** Opaque server-issued identifier. `challengeId` is accepted during rollout for compatibility. */
  id?: string;
  flowId?: string;
  challengeId?: string;
  emailMasked?: string;
  maskedEmail?: string;
  expiresAt: number;
  resendAt: number;
  attemptsRemaining?: number;
  delivered?: boolean;
}

export type AccountStatus =
  | { state: 'ready'; challenge?: never }
  | { state: 'email_required'; challenge?: never }
  | { state: 'email_verification'; challenge?: EmailChallenge };

export interface SessionResponse {
  user: User;
  account: AccountStatus;
}

export interface AuthResponse extends SessionResponse {
  token: string;
}

export interface ChallengeResponse {
  challenge?: EmailChallenge;
  flowId?: string;
  challengeId?: string;
  emailMasked?: string;
  maskedEmail?: string;
  expiresAt?: number;
  resendAt?: number;
  attemptsRemaining?: number;
  delivered?: boolean;
  account?: AccountStatus;
}

export interface RegistrationInvite {
  code: string;
  createdAt?: number;
  expiresAt: number;
  uses?: number;
  maxUses?: number;
  emailSends?: number;
  maxEmailSends?: number;
}

export interface ReleaseHistoryItem {
  sha: string;
  title: string;
  notes: string[];
  version: string;
  publishedAt: number;
}

export interface ReleaseHistoryResponse {
  releases: ReleaseHistoryItem[];
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
  isAdmin: boolean; emailVerified?: boolean; created: number; serverCount: number; ownedCount: number;
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
  away?: boolean;  // «нет на месте» (idle) — жёлтый статус
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
  statsEnabled?: boolean; // рейтинг+уровни включены (эксперимент, по умолчанию нет)
  role: string;
  memberCount: number;
  online?: OnlineMember[];
  onlineCount?: number;
  unread?: number;
  lastRead?: number; // id последнего прочитанного сообщения (для дивайдера «новые» в чате)
}

export interface MemberStats {
  voiceSec: number;
  streamSec: number;
  messages: number;
  xp: number;
  level: number;
  progress: { level: number; xp: number; into: number; span: number; next: number };
}

export interface Member {
  id: string;
  username: string;
  displayName: string;
  avatarColor: number;
  avatarUrl?: string;
  profileBannerUrl?: string;
  bio?: string;
  role: string;
  roles?: Role[];
  stats?: MemberStats;
}

export interface ServerDetail {
  id: string;
  name: string;
  ownerId: string;
  iconColor: number;
  iconUrl?: string;
  description?: string;
  statsEnabled?: boolean;
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
  thumb?: string;  // R3: URL превью-картинки оригинала (тумбнейл в цитате)
}

// Реакция 7TV на сообщение (агрегат): эмоут + счётчик + реагировал ли я.
export interface Reaction { id: string; name: string; count: number; mine: boolean }

// вложение к сообщению — картинка (инлайн-превью, /api/uploads/*) или произвольный файл
// (форс-скачивание, /api/files/*). До 5 штук на сообщение (см. sanitizeAttachments на сервере).
export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'file';
  // Сервер возвращает реальные размеры загруженной картинки. Они позволяют
  // зарезервировать место до decode и не менять высоту строки Virtuoso на onLoad.
  width?: number;
  height?: number;
}

// Подготовленное для пользователей описание обновления. Оно приходит из
// выделенного Patch-Note блока, а не из произвольного текста коммита.
export interface ReleaseNote {
  sha: string;
  title: string;
  notes: string[];
  version?: string;
  publishedAt?: number | string;
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
  edited?: boolean; // сообщение было отредактировано (метка «(изменено)»)
  mkey?: string; // клиентский ключ сообщения — по нему ВСЕ клиенты усыновляют серверный sid (для реакций/edit на чужих live-сообщениях)
  kind?: string; // '' обычное | 'levelup' карточка достижения уровня
  level?: number; // для kind='levelup' — достигнутый уровень
  release?: ReleaseNote; // для kind='release' — системная карточка обновления
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
  edited?: boolean;
  reactions?: Reaction[]; // агрегат реакций из истории
  kind?: string; // 'levelup' — карточка достижения
  level?: number; // достигнутый уровень (для kind='levelup')
  release?: ReleaseNote; // metadata системного kind='release'
}

// Рейтинг сервера (экспериментальная фича, off по умолчанию). Категории: уровень (overall), голос, эфир.
export interface LeaderRow { uid: string; username: string; displayName: string; avatarColor: number; avatarUrl?: string; level: number; value: number }
export interface LeaderMe {
  voiceSec: number; streamSec: number; xp: number;
  progress: { level: number; xp: number; into: number; span: number; next: number };
  ranks: { level: number; voice: number; stream: number };
  total: number;
}
export interface Leaderboard {
  enabled: boolean;
  categories?: { level: LeaderRow[]; voice: LeaderRow[]; stream: LeaderRow[] };
  me?: LeaderMe;
}

export interface Emote { id: string; name: string }

export type Presence = 'voice' | 'online' | 'offline';

export type NotificationPrivacy = 'full' | 'sender' | 'hidden';

export interface AudioSettings {
  input: string;
  output: string;
  nsMode: 'off' | 'basic' | 'rnnoise'; // шумоподавление: без обработки / встроенный браузерный NS / RNNoise-нейросеть
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
  notifPrivacy: NotificationPrivacy; // полный текст / только отправитель / скрытое содержимое
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

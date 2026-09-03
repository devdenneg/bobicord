import {
  Room, RoomEvent, Track, LocalAudioTrack, RemoteAudioTrack, AudioPresets, ConnectionQuality,
  type RemoteParticipant, type Participant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import { isWindowIdle, onWindowIdle } from './windowIdle';
import type {
  User, Member, ChatMessage, Emote, HistoryMessage, ReplyRef, Attachment, Reaction, ReleaseNote,
  VoiceDiagnosticEvent, VoiceDiagnosticIncident, VoiceDiagnosticReport,
} from './types';
import { baseUid } from './util';
import { notify } from './notify';
import { api, isApiError, type VoiceLeaseEvent } from './api';
import { isTauri, detectGame } from './native';
import { getSettings, setSettings, subscribeSettings } from './settings';
import { emoteUrl } from './emotes';
import { playSound } from './sounds';
import type { StreamWatchTransportDiagnostic, VideoTransport } from './transport/videoTransport';
import { LiveKitVideoTransport } from './transport/livekitVideo';
import { TreeVideoTransport } from './transport/treeVideo';
import { createDenoiseNode, destroyDenoiseNode } from './denoise';
import { createVadNode, destroyVadNode, type VadNode } from './vad';
import {
  MIC_MUTED_RESTART_MS,
  VOICE_ATTRIBUTE_TIMEOUT_MS,
  VOICE_CLEANUP_TIMEOUT_MS,
  VOICE_JOIN_TIMEOUT_MS,
  VOICE_MEDIA_CONNECT_TIMEOUT_MS,
  VOICE_MIC_START_TIMEOUT_MS,
  VOICE_OPERATION_TIMEOUT_MS,
  VOICE_RECONNECT_VERIFY_TIMEOUT_MS,
  AudioUnlockGestureDeduper,
  VoiceMicStartOwnership,
  automaticMicRecoveryAllowed,
  confirmedMicrophoneUnavailable,
  currentAudioUnlockGestureToken,
  foregroundMicNeedsImmediateRecovery,
  forgetExactAudioContextResume,
  initialMicrophoneResultIsDeferred,
  isVoiceOperationTimeout,
  manualMuteIntentIsCurrent,
  microphoneCaptureBusy,
  microphoneTransportHealth,
  mutedTrackNeedsRestart,
  readStoredFlag,
  requestExactAudioContextResume,
  retainMicAvailabilityDuringRecovery,
  reusableMicrophoneAudioContextState,
  resumeGestureAudioContext,
  resumeSharedGestureAudioContext,
  selectedInputUnavailable,
  unavailableMicrophoneButtonAction,
  voiceActivationAllowsAudio,
  withVoiceDeadline,
  withVoiceTimeout,
  voiceWriteCommittedForCurrentIntent,
} from './micLifecycle';
import { userVolumeToGain } from './volumeCurve';
import { installLiveKitAudioGainStability } from './livekitAudioStability';
import type { ServerVolumeMutation } from './volumePreferences';
import {
  type AudioSinkRouteFailure,
  type AudioSinkRouteOutcome,
  ExactAsyncActionCoordinator,
  ExactMediaOutputRouteGate,
  ExactMediaPlayCoordinator,
  StreamWatchPlaybackGate,
  applyExactScreenAudioGain,
  audioSinkRoutesConfirmed,
  exactWebAudioMixContext,
  effectiveStreamGain,
  rebindExactWebAudioMixContexts,
  routeAudioSinkTarget,
  seedAudioSinkTargetRoute,
  setTreeStreamOutputSink,
} from './streamPlayback';
import { automaticMicrophoneCaptureAllowed, beginMicrophoneCapture } from './audioDevices';
import {
  canReconcileUnchangedChatSnapshot,
  claimBoundedMessageId,
  planChatEventReplay,
  preserveOptimisticAtSnapshot,
  validChatSnapshotRevisions,
  type ChatCanonicalEvent,
} from './chatRealtime';
import {
  CHAT_SESSION_MESSAGE_LIMIT,
  chatAppendFrontTrim,
  chatRetentionLimitAfterProtectedInsert,
  chatRetentionHardCap,
} from './chatScroll';
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import { safeLocalStorageGet, safeLocalStorageSet } from './safeStorage';
import { LatestGamePresence } from './latestGamePresence';
import {
  VoiceDiagnosticsRecorder,
  VoiceEventLoopStallMonitor,
  detectVoiceDiagnosticNetworkType,
  type VoiceDiagnosticEventInput,
} from './voiceDiagnostics';
import {
  boundedVoiceActivationRetryDelayMs,
  shouldReportSlowVoiceJoin,
  voiceActivationHttpFailureDisposition,
} from './voiceActivation';
import {
  advanceVoiceDiagnosticSilence,
  emptyVoiceDiagnosticSilenceState,
  voiceDiagnosticInboundExpected,
  type VoiceDiagnosticSilenceState,
} from './voiceDiagnosticRtc';
import { DiagnosticReportOutbox } from './diagnosticOutbox';

installLiveKitAudioGainStability(RemoteAudioTrack as unknown as Parameters<typeof installLiveKitAudioGainStability>[0]);

export interface GameStatus { name: string; icon?: string }
export interface PeerState { online: boolean; inVoice: boolean; micMuted: boolean; streaming: boolean; deafened: boolean; away: boolean; game?: GameStatus | null }
export interface StreamInfo { key: string; identity: string; isLocal: boolean; appName?: string; appIcon?: string }
export type VoiceQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export type VoiceConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
export type PttInputOwner = 'keyboard' | 'pointer';
type VoiceMediaConnectFailure = 'server-updating' | 'token' | 'transport' | 'activation';
export interface Snapshot {
  connected: boolean;
  roomReady: boolean; // комната реально поднялась (после await connect), а не просто создан объект Room
  reconnecting: boolean;
  voiceQuality: VoiceQuality; // качество связи в голосовом (LiveKit ConnectionQuality)
  voicePing: number | null;   // RTT до сервера, мс (из WebRTC-статистики)
  // Optional keeps the static pre-auth snapshot backward-compatible; a live Engine always fills these fields.
  voiceConnection?: VoiceConnectionState;
  lostVoiceServerId?: string | null;
  lostVoiceChannel?: string | null;
  inVoice: boolean;
  voiceConnecting: boolean;                    // оптимистичный intent до подтверждения lease + exact media + hub attributes
  myVoiceChannel: string | null;              // id голосового канала, в котором я сейчас (null = не в голосовом)
  voiceServerId: string | null;               // сервер, на котором я в голосовом (для персистентного VoiceDock + гарда auto-leave); null = не в голосе
  voiceChannels: Record<string, string>;      // username -> channelId (кто в каком голосовом канале)
  channelActiveSince: Record<string, number>; // channelId -> epoch ms первого захода в ПУСТОЙ канал (таймер в списке каналов, как в Discord)
  deafened: boolean;
  localMicMuted: boolean;
  manualMicMuted: boolean; // latest explicit user intent, independent from temporary fail-closed capture state
  micUnavailable: boolean; // зашёл в голосовой без микрофона (нет доступа) — listen-only
  micRecovering?: boolean; // временная пересборка capture после фона/смены аудиомаршрута
  pttDown: boolean;
  presence: Record<string, PeerState>;
  speaking: Record<string, boolean>;
  streams: StreamInfo[];
  watching: Record<string, true>;
  pending: Record<string, true>;
  watchers: Record<string, { name: string; color: number; avatarUrl?: string }[]>;
  messages: ChatMessage[];
  chatHasMore: boolean; // есть ли ещё более старые сообщения для догрузки вверх
  chatTrimmed: number; // накопленное число срезанных с начала сообщений (для коррекции якоря virtuoso)
  chatPrepended: number; // накопленное число догруженных пагинацией старых сообщений (якорь virtuoso)
  typing: string[];
}

type EmoteListener = (streamerId: string, emoteId: string, by: string, x: number, size?: string) => void;
export type LevelListener = (level: number, open: boolean, threshold: number) => void;
type StreamSource = 'livekit' | 'tree';
type SinkableAudioContext = AudioContext & {
  setSinkId?: (deviceId: string) => Promise<void>;
};
type OutputContextRecovery = {
  generation: number;
  context: SinkableAudioContext;
  rooms: Set<Room>;
  completedRooms: Set<Room>;
  ordinaryStartedRooms: Set<Room>;
  ordinaryContextStarted: boolean;
  remainingMs: number;
  voiceEpoch: number;
  voiceRoom: Room | null;
  voiceChannel: string | null;
};

// шкала чувствительности ввода: rms(0..1) -> dB(-80..0) -> норм.уровень(0..1), сравнимый с порогом
const VAD_HOLD_MS = 400; // «хвост» гейта активации голосом после падения ниже порога (совпадает с прежним hold=8 spLoop при 60fps)
// Насколько может «протухнуть» замер уровня своего мика, прежде чем гейт активации голосом сдастся и
// откроется. Оба драйвера (ворклет и spLoop) тикают ~48мс, так что 1с — 20-кратный запас: обычная
// загрузка главного потока сюда не попадает. Смысл фейл-опена: неизмеренный уровень НЕ равен «молчит»,
// а цена ошибки несимметрична — лишний фоновый шум против «человека вообще никто не слышит».
const VAD_STALE_MS = 1000;
const VAD_WATCHDOG_MS = 700; // как часто перепроверяем протухание (в фоне таймер троттлится — страхуемся ещё и visibilitychange)
const OUTPUT_CONTEXT_RECOVERY_TIMEOUT_MS = 8_000;
const WATCH_MAX = 4; // грид: сколько чужих стримов зритель смотрит разом (веб — tree-WS/PC на стрим, натив — Rust relay-слот на стрим)
const WATCH_VIDEO_DEADLINE_MS = 20_000; // cellular signaling + TURN may be slow, but an attempt must never spin forever
const STREAM_EDGE_GRACE_MS = 500;
const STREAM_MESSAGE_AGGREGATE_MS = 30_000;
const VOICE_DIAGNOSTIC_REPORT_COOLDOWN_MS = 15_000;
const VOICE_DIAGNOSTIC_MAX_REPORTS_PER_SESSION = 4;
const VOICE_DIAGNOSTIC_RECONNECT_WINDOW_MS = 30_000;
const VOICE_DIAGNOSTIC_RECONNECT_LOOP_COUNT = 3;
const VOICE_DIAGNOSTIC_PLAYBACK_EVENT_COOLDOWN_MS = 5_000;
const VOICE_DIAGNOSTIC_MUTE_DIVERGENCE_MS = 4_000;
const VOICE_DIAGNOSTIC_HEALTHY_SESSION_SAMPLE_RATE = 0.02;
const VOICE_DIAGNOSTIC_INCIDENT_PRIORITY: Record<VoiceDiagnosticIncident, number> = {
  session_ended: 0,
  stream_watch_succeeded: 1,
  stream_watch_recovered: 2,
  manual: 10,
  ui_stall: 20,
  reconnect_loop: 30,
  playback_blocked: 40,
  output_route_failed: 45,
  mute_divergence: 50,
  join_stuck: 60,
  uplink_silent: 70,
  inbound_silent: 70,
  mic_failed: 80,
  stream_watch_failed: 85,
  connection_failed: 90,
};
const MIN_DB = -50; // шкала подогнана под уже обработанный браузером сигнал (AGC/NS), а не под теоретический динамический диапазон
function rmsToDb(rms: number): number { if (rms <= 0) return MIN_DB; return Math.max(MIN_DB, Math.min(0, 20 * Math.log10(rms))); }
function dbToNorm(db: number): number { return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB)); }

function storedFlag(key: string): boolean {
  try { return readStoredFlag(window.localStorage, key); }
  catch { return false; } // iOS private mode / storage policy must not prevent Engine construction
}

type VoiceDiagnosticErrorFields = Pick<VoiceDiagnosticEvent, 'code' | 'httpStatus'>;

interface VoiceDiagnosticRtcTotals {
  track: object;
  sampledAt: number;
  packetsLost: number;
  packetsReceived: number;
  packetsSent: number;
  bytesReceived: number;
  bytesSent: number;
  concealedSamples: number;
  outboundPackets: number;
  outboundBytes: number;
  inboundPackets: number;
  inboundBytes: number;
  hasOutboundAudio: boolean;
  hasInboundAudio: boolean;
}

interface StreamWatchDiagnosticAttempt {
  recorder: VoiceDiagnosticsRecorder;
  playbackGeneration: number;
  reconnectCount: number;
  streamTransport: NonNullable<VoiceDiagnosticEvent['streamTransport']>;
}

// Error objects never enter a report. Only an allowlisted category and, for API responses, a
// numeric status survive classification; names/messages/stacks and request details stay local.
function classifyVoiceDiagnosticError(error: unknown): VoiceDiagnosticErrorFields {
  if (typeof navigator === 'object' && navigator.onLine === false) return { code: 'offline' };
  if (isVoiceOperationTimeout(error)) return { code: 'timeout' };
  if (isApiError(error)) {
    const httpStatus = error.status >= 100 && error.status <= 599 ? error.status : undefined;
    if (error.status === 401 || error.status === 403) return { code: 'auth', ...(httpStatus ? { httpStatus } : {}) };
    if (error.code === 'NETWORK_ERROR' || error.status === 408 || error.status === 429 || error.status >= 500)
      return { code: 'network', ...(httpStatus ? { httpStatus } : {}) };
    return { code: 'sdk', ...(httpStatus ? { httpStatus } : {}) };
  }
  const name = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
    ? error.name
    : '';
  if (name === 'TimeoutError') return { code: 'timeout' };
  if (name === 'NotAllowedError' || name === 'SecurityError') return { code: 'permission' };
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'NotReadableError'
    || name === 'TrackStartError' || name === 'OverconstrainedError') return { code: 'device_lost' };
  if (name === 'NotSupportedError') return { code: 'unsupported' };
  if (name === 'AbortError') return { code: 'aborted' };
  return { code: 'unknown' };
}

function voiceDiagnosticRetryDelayMs(error: unknown): number | null {
  if (!isApiError(error)) return null;
  const transient = error.code === 'NETWORK_ERROR' || error.code === 'REQUEST_TIMEOUT'
    || error.code === 'INVALID_RESPONSE' || error.status === 408 || error.status === 429
    || error.status >= 500;
  if (!transient) return null;
  const serverDelay = Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter! * 1_000) : 0;
  return Math.max(VOICE_DIAGNOSTIC_REPORT_COOLDOWN_MS, Math.min(5 * 60_000, serverDelay));
}

function voiceMediaIdentityParts(identity: string): { session: string; epoch: number } | null {
  const hash = identity.indexOf('#');
  const tilde = identity.lastIndexOf('~');
  if (hash < 0 || tilde <= hash + 1) return null;
  const epoch = Number(identity.slice(tilde + 1));
  if (!Number.isSafeInteger(epoch) || epoch < 1) return null;
  return { session: identity.slice(hash + 1, tilde), epoch };
}

interface EngineHooks {
  toast: (text: string, kind?: 'ok' | 'warn' | 'err' | 'info') => void;
  saveSettings: (
    serverId: string,
    vols: { users: Record<string, number>; streams: Record<string, number> },
    mutation?: ServerVolumeMutation,
  ) => void;
  peerJoined: (identity: string) => void;
  persistMessage: (text: string, em: Record<string, string>, image: string | undefined, reply: ReplyRef | undefined, localId: number, key: string, files?: Attachment[], kind?: string, level?: number, canonicalTransport?: boolean) => void;
  fetchChatSnapshot: (serverId: string) => Promise<{ messages: HistoryMessage[]; hasMore: boolean; revision: number; lastClearRevision: number }>;
  // sid адресно сверяет строку; serverId отделяет history recovery от готовности LiveKit.
  // awaitRelease=true — ждём ИМЕННО release-запись (её могло ещё не быть в БД), значит допустимы ретраи;
  // для любого другого sid ретраи бессмысленны: сообщение уже существует, а ожидание kind==='release'
  // никогда не выполнится и превращается в 15-минутный поллинг с потерянным merge.
  refetchChat?: (sid?: number, serverId?: string, awaitRelease?: boolean) => void;
  endBroadcast?: () => void; // остановить нативную трансляцию (Rust) при выходе из голосового — browser-share гасит stopShare
  reactMessage?: (serverId: string, sid: number, emoteId: string, emoteName: string, add: boolean, canonicalTransport: boolean) => Promise<{ changed: boolean }>; // персист реакции
  editMessage?: (serverId: string, sid: number, text: string, canonicalTransport: boolean) => Promise<void>;   // персист редактирования
  deleteMessage?: (serverId: string, sid: number, canonicalTransport: boolean) => Promise<void>;               // персист удаления
  chatConnectionChanged?: () => void;
  connectionLost?: (serverId: string, voiceChannel: string | null, wasViewing: boolean) => void;
  connectionLossExpected?: () => boolean;
}

let msgSeq = 1;

// стабильный dedup-ключ сообщения (переживает retry) — сервер по нему игнорит дубль,
// если первый POST дошёл, а ответ потерялся
function newClientKey(): string {
  try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

function normalizeReleaseTimestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.length <= 64 ? Date.parse(value) : Number.NaN);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_DATE_TIMESTAMP ? parsed : undefined;
}

// Release metadata crosses both HTTP history and the LiveKit data channel. Keep the
// renderer insulated from malformed/oversized payloads even though the server also
// validates the generated Patch-Note.
function normalizeReleaseNote(value: unknown): ReleaseNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const sha = typeof source.sha === 'string' ? source.sha.trim() : '';
  const title = typeof source.title === 'string' ? source.title.trim().slice(0, 80) : '';
  if (!/^[0-9a-f]{7,64}$/i.test(sha) || !title) return null;
  const notes = Array.isArray(source.notes)
    ? source.notes
      .filter((note): note is string => typeof note === 'string')
      .map((note) => note.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 30)
    : [];
  if (!notes.length) return null;
  const release: ReleaseNote = { sha, title, notes };
  if (typeof source.version === 'string' && source.version.trim()) release.version = source.version.trim().slice(0, 48);
  const publishedAt = normalizeReleaseTimestamp(source.publishedAt);
  if (publishedAt != null) release.publishedAt = publishedAt;
  return release;
}

function mapQuality(q: ConnectionQuality): VoiceQuality {
  switch (q) {
    case ConnectionQuality.Excellent: return 'excellent';
    case ConnectionQuality.Good: return 'good';
    case ConnectionQuality.Poor: return 'poor';
    case ConnectionQuality.Lost: return 'lost';
    default: return 'unknown';
  }
}
// Худшее из двух оценок качества. Нужно, чтобы метка учитывала И потери (LiveKit connectionQuality),
// И задержку (RTT): LiveKit-качество про потери/джиттер и НЕ видит латентности — при 447мс без потерь
// показывало бы «отличное». unknown уступает любой определённой оценке.
const VQ_RANK: Record<VoiceQuality, number> = { excellent: 0, good: 1, poor: 2, lost: 3, unknown: -1 };
function worseVoiceQuality(a: VoiceQuality, b: VoiceQuality): VoiceQuality {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return VQ_RANK[a] >= VQ_RANK[b] ? a : b;
}

export class Engine {
  // Две комнаты (two-room-decouple S4): viewRoom — комната сервера, который смотрю; voiceRoom — комната
  // сервера, где я в голосовом. СОВПАДАЮТ (ОДИН объект Room) когда voiceServer===viewServer (частый
  // случай) → оба указателя на один Room, хендлеры ветвятся `if(r===voiceRoom)`/`if(r===viewRoom)` и обе
  // ветви истинны. Расходятся, когда я в голосе на A и ушёл смотреть B: voiceRoom=srv:A держится,
  // viewRoom=srv:B — новый коннект. Пока (4a) держатся равными → поведение идентично.
  private viewRoom: Room | null = null;
  // Server-wide control plane. Presence, voice ownership attributes/data and browser
  // screen share stay here even though microphone media lives in an exact channel room.
  private voiceRoom: Room | null = null;
  private voiceMediaRoom: Room | null = null;
  private pendingVoiceMediaRoom: Room | null = null;
  private voiceMediaChannelId: string | null = null;
  private voiceMediaActivated = new WeakSet<Room>();
  private voiceMediaConnectFailure: { voiceEpoch: number; reason: VoiceMediaConnectFailure } | null = null;
  private me: User;
  private members: Member[] = [];
  private hooks: EngineHooks;

  inVoice = false;
  private voiceConnecting = false; // optimistic channel intent until lease + exact media + hub attrs are confirmed
  private voiceEpoch = 0; // поколение пользовательского voice-intent; инвалидирует старые async join/leave/switch
  private micEpoch = 0;   // поколение mic pipeline; старый gUM/RNNoise/publish не имеет права ожить после stop/restart
  private micStartOwnership = new VoiceMicStartOwnership(); // exact micEpoch owning gesture context/gUM before pipeline commit
  private micReapplyEpoch = 0; // последнее ручное переключение input/мобильного аудиомаршрута
  private connectEpoch = 0; // поколение view-connect; протухший r.connect не помечает новую комнату готовой
  private voiceLeaseEpoch = 0; // серверный ownership fence текущей локальной voice-сессии
  private voiceLeaseSession = '';
  private voiceLeaseChannel = '';
  private voiceClientIntent = 0;
  private voiceClaimPending = 0; // voiceEpoch явного claim; входящие lease события до ответа откладываем
  private deferredVoiceLease: VoiceLeaseEvent | null = null;
  private matchedVoiceLease: VoiceLeaseEvent | null = null; // own notify может быть единственным ack при потере HTTP response
  private voiceLeaseVerifying = false; // reconnect fence: пока snapshot не подтвердил owner, uplink всегда 0
  private voiceLeaseVerifySeq = 0;
  // Any hub/media reconnect or permission loss advances this generation. A join/switch captures it
  // and, if it changes before commit, performs one exact-room bounded verification itself instead
  // of racing an event-handler verifier against its own lease/attribute transaction.
  private voiceTransportDisruptionSeq = 0;
  private voiceReconnectRecovery: { hub: Room; voiceEpoch: number; deadline: number; timer: number } | null = null;
  private voicePermissionRecovery: { room: Room; voiceEpoch: number; deadline: number; timer: number } | null = null;
  private voiceLeaseAuditRunning = false;
  private voiceLeaseAuditTick = 0;
  private readyRooms = new WeakSet<Room>();
  private roomSessions = new WeakMap<Room, string>();
  private intentionalDisconnects = new WeakSet<Room>();
  private voiceAttrDesired = new WeakMap<Room, Record<string, string>>();
  private voiceAttrWrites = new WeakMap<Room, Promise<void>>();
  private lastVclaim = 0; // когда мы сами заявили голос (для tie-break гонки claim'ов между своими сессиями)
  private currentVc: string | null = null; // id голосового канала, в котором я сейчас (несколько каналов на сервер)
  private pendingVoiceJoin: {
    serverId: string;
    channelId: string;
    replacementMicContext: AudioContext | null;
    initialMicContext: AudioContext | null;
    timer: number;
  } | null = null;
  private myVcAt: number | null = null;    // epoch ms момента, когда занятость МОЕГО канала началась (унаследован от тех, кто уже там был, либо now() если я первый)
  // Optimistic channel membership is rendered immediately, but its local timer must not start
  // until exact media activation and authoritative hub attributes have both committed.
  private voicePresenceConfirmed = false;
  private myChannelPeers = new Set<string>(); // кто в моём голосовом канале (диф → entry/exit при входе/выходе/смене канала)
  private roomReady = false; // true только после успешного await r.connect() (не просто наличие объекта Room)
  private reconnecting = false;
  private reconnectingRooms = new Set<Room>();
  private voiceReconnecting = false;
  // Terminal disconnect clears the voice lease, but the dock keeps the failed target visible
  // until the user reconnects or dismisses it instead of silently disappearing.
  private lostVoiceServerId: string | null = null;
  private lostVoiceChannel: string | null = null;
  private connQuality: VoiceQuality = 'unknown'; // качество связи (обновляется по событию LiveKit)
  private pingMs: number | null = null;          // RTT до сервера, мс (опрос статистики в голосовом)
  private connTimer: number | null = null;       // таймер опроса пинга (только в голосовом)
  private voiceDiagnostics = new VoiceDiagnosticsRecorder();
  private voiceDiagnosticReportsSent = 0;
  private voiceDiagnosticReportInFlight: Promise<void> | null = null;
  private voiceDiagnosticReportTimes = new Map<VoiceDiagnosticIncident, number>();
  private voiceDiagnosticSessionGeneration = 0;
  private voiceDiagnosticAccountActive = true;
  private voiceDiagnosticRetryHandler: (() => void) | null = null;
  private voiceDiagnosticPendingReport: {
    report: VoiceDiagnosticReport;
    userId: string;
    retryAt: number;
    timer: number | null;
  } | null = null;
  private voiceDiagnosticQueuedReport: {
    report: VoiceDiagnosticReport;
    userId: string;
    priority: number;
    reservedAt: number;
  } | null = null;
  private voiceDiagnosticJoinStartedAt = 0;
  private voiceDiagnosticJoinStage: NonNullable<VoiceDiagnosticEvent['stage']> = 'intent';
  private voiceDiagnosticJoinTimer: number | null = null;
  private voiceDiagnosticJoinFailureRecorded = false;
  private voiceDiagnosticReconnectTimes: number[] = [];
  private voiceDiagnosticLastReconnectAt = 0;
  private voiceDiagnosticPlaybackBlockedSince = 0;
  private voiceDiagnosticLastPlaybackBlockedAt = 0;
  private voiceDiagnosticMuteDivergenceAt = 0;
  private voiceDiagnosticRtcTotals: VoiceDiagnosticRtcTotals | null = null;
  private voiceDiagnosticUplinkSilence = emptyVoiceDiagnosticSilenceState();
  private voiceDiagnosticInboundSilence = emptyVoiceDiagnosticSilenceState();
  private voiceDiagnosticStallMonitor = new VoiceEventLoopStallMonitor((eventLoopLagMs) => {
    if (!this.inVoice || !this.voiceDiagnostics.active) return;
    this.recordVoiceDiagnostic({
      kind: 'ui_stall', stage: 'ui', outcome: 'stalled', eventLoopLagMs,
      ...this.voiceDiagnosticState(),
    });
    this.submitVoiceDiagnostic('ui_stall');
  });
  // Some WebKit/Chromium builds can leave getRTCStatsReport() pending forever after a radio,
  // page-lifecycle or device transition. Keep the actual native request single-flight: a
  // cosmetic ping must never accumulate promises every 2.5s or write an old room's result into
  // a newer voice session. We intentionally do not clear this owner on stop; only the native
  // promise settling may release it, otherwise a succession of joins could create one hung
  // browser request per session.
  private voiceStatsInFlight: { room: Room; track: object; voiceEpoch: number; generation: number } | null = null;
  private voiceStatsGeneration = 0;
  private deafened = storedFlag('voiceDeaf'); // персист: пред-установка «оглох» до входа (Discord-стиль)
  private noMic = false; // зашёл в голосовой без микрофона (нет доступа) — listen-only, НЕ персист
  private pttDown = false;
  private pttKeyboardDown = false;
  private pttPointerDown = false;
  private watchTimers = new Map<string, number>();
  private watchPlaybackGate = new StreamWatchPlaybackGate();
  private streamWatchDiagnostics = new Map<string, StreamWatchDiagnosticAttempt>();
  private streamDiagnosticOutbox: DiagnosticReportOutbox;

  // mic pipeline: raw device -> [denoise?] -> gain (громкость/мут) -> published track
  //                                        \-> vadDest (отвод для VAD/метра, ДО гейта)
  private micRaw: MediaStream | null = null;
  private micActx: AudioContext | null = null;
  private micGain: GainNode | null = null;
  private micDenoise: RnnoiseWorkletNode | null = null;
  private micVadDest: MediaStreamAudioDestinationNode | null = null;
  // Keep ownership independent of a Room publication. During A -> B channel handoff the
  // same processed track is unpublished without stopping and published into the new room,
  // avoiding a second getUserMedia call after the original user gesture.
  private micLocalTrack: LocalAudioTrack | null = null;
  private micTrackCleanup: (() => void) | null = null;
  private micRecoveryTimer: number | null = null;
  private voiceHiddenAt = 0;
  private micForegroundRecoveryPending = false;
  private hiddenMicStartOwner = 0;
  private hiddenMicRecoveryOwner = 0;
  private micForegroundGeneration = 0;
  private micHadCapture = false;
  // Remains true across a rapid channel switch while the first permission prompt
  // is pending. A terminal initial denial clears it, so the watchdog cannot turn
  // an intentional listen-only join into repeated permission requests.
  private micBootstrapWanted = false;
  private manualMute = storedFlag('voiceMute'); // персист: пред-установка «мут мика» до входа (Discord-стиль)
  private manualMuteIntentRevision = 0; // async capture retries cannot roll back a newer explicit click/hotkey
  // LiveKit mute/unmute is asynchronous. Keep an explicit unmute separate from the capture
  // watchdog so a still-paused sender cannot race the user's click into an unnecessary gUM rebuild.
  private micMuteWriteSeq = 0;
  private micUnmuteWriteOwner = 0;
  private saveVoicePrefs() { try { localStorage.setItem('voiceMute', this.manualMute ? '1' : '0'); localStorage.setItem('voiceDeaf', this.deafened ? '1' : '0'); } catch { /**/ } }

  // Оба транспорта живут одновременно (не выбор build-флагом): нативный вещатель
  // публикует только в дерево, браузер — только в LiveKit (старый путь, инвариант 2
  // CLAUDE.md); зритель матчит транспорт по тому, откуда объявлен конкретный стрим
  // (см. transportFor).
  private liveKitT: VideoTransport = new LiveKitVideoTransport();
  private treeT: VideoTransport = new TreeVideoTransport();
  // One logical stream can briefly be announced by both transports (or flap on reconnect).
  // Keep source edges separate and publish UI/chat/sound only after the union settles.
  private streamSources = new Map<string, Set<string>>();
  private stableStreams = new Set<string>();
  private streamEdgeTimers = new Map<string, number>();
  private streamEdgeGeneration = 0;
  private streamStateMessages = new Map<string, { messageId: number; lastAt: number; changes: number }>();
  private screenAudioEls = new Map<string, { identity: string; track: RemoteTrack; el: HTMLMediaElement }>();
  private voiceAudioEls = new Map<string, { room: Room; identity: string; track: RemoteTrack; el: HTMLMediaElement }>();
  private watching = new Set<string>();
  // Транспорт, которым РЕАЛЬНО открыт watch. transportFor смотрит на «кто сейчас объявлен
  // вещающим» — это состояние меняется под активным watch (напр. stream-end уже удалил
  // запись из liveStreams) и роутинг уезжает не в тот транспорт. Пин снимает весь класс.
  private watchT = new Map<string, VideoTransport>();
  private pendingWatch = new Set<string>();
  private streamWatchers = new Map<string, Map<string, { name: string; color: number; avatarUrl?: string; ts: number }>>();
  private messages: ChatMessage[] = [];
  // Rollout capability arrives only on the authenticated notify websocket. Until
  // it is observed, legacy clients/servers still exchange durable chat over the
  // LiveKit data channel; afterwards participant packets are never authoritative.
  private serverChatReady = false;
  private chatRevision = 0;
  private chatLastClearRevision = 0;
  private chatStateServerId = '';
  private chatRevisionKnown = false;
  private canonicalSnapshotEstablished = false;
  private chatSyncGeneration = 0;
  private chatSyncPromise: Promise<number> | null = null;
  private chatSyncAgain = false;
  private chatSyncFailures = 0;
  private chatEventBuffer: Array<{ rev: number; event: ChatCanonicalEvent }> = [];
  private chatEventBufferOverflow = false;
  private chatSnapshotSeenSids = new Set<number>();
  private canonicalMentionDeliveries = new Set<number>();
  private chatMentionFenceEstablished = false;
  // Реакции 7TV по сообщению (ключ — серверный sid): emoteId -> {name, count, mine}. Источник правды —
  // история (getReactions читает UI); realtime-события (t:'react') мутируют, refetch корректирует дрейф.
  private reactions = new Map<number, Map<string, { name: string; count: number; mine: boolean }>>();
  private reactionWrites = new Map<string, Promise<void>>();
  private reactionWriteSeq = new Map<string, number>();
  private reactionWriteDesired = new Map<string, { serverId: string; sid: number; emoteId: string; name: string; mine: boolean }>();
  private chatMutationSeq = new Map<string, number>();
  private chatMutationWrites = new Map<string, Promise<void>>();
  private chatEditDesired = new Map<string, { seq: number; text: string }>();
  private chatGeneration = 0;
  private chatMore = false; // есть ли ещё более старые сообщения на сервере (пагинация вверх)
  private oldestSid: number | null = null; // DB-id самого старого загруженного сообщения = курсор для before
  private trimmedFront = 0; // сколько сообщений суммарно срезано с НАЧАЛА (для якоря virtuoso: срез спереди → firstItemIndex += N)
  private chatPrepended = 0; // сколько старых сообщений догружено пагинацией (для якоря: prepend → firstItemIndex -= N). Меняется ВМЕСТЕ с messages (один emit) → нет прыжка.
  private chatRetentionLimit = CHAT_SESSION_MESSAGE_LIMIT; // после явной пагинации защищает загруженную страницу от следующего live append
  private typingUsers = new Map<string, number>(); // displayName -> expiry ts
  private lastTypingSent = 0;

  private analysers = new Map<string, { an: AnalyserNode; buf: Uint8Array; hold: number; src: MediaStreamAudioSourceNode; track: MediaStreamTrack }>();
  private spCtx: AudioContext | null = null;
  private spRAF: number | null = null;
  private stopIdleWatch: (() => void) | null = null; // отписка от признака «на окно не смотрят»
  private audioUnlock: (() => void) | null = null; // снятие разового gesture-анлока micActx (см. ensureVoiceAudioRunning)
  private remoteAudioUnlock: (() => void) | null = null;
  private remoteAudioResumeHandler: (() => void) | null = null;
  private lastForegroundOutputRetryAt = 0;
  private remoteAudioStarts = new ExactAsyncActionCoordinator<Room>();
  private remoteAudioPlays = new ExactMediaPlayCoordinator<HTMLMediaElement>();
  private audioRepairRetiredRooms = new Set<Room>();
  private audioRepairScheduled = false;
  private spTick = 0;
  private spIdleTimer: number | null = null; // индикаторы речи вне фокуса: редкий таймер вместо rAF
  private speakingSet = new Set<string>();

  private keepCtx: AudioContext | null = null;
  private keepOsc: OscillatorNode | null = null;
  private screenStream: MediaStream | null = null;
  private presenceTimer: number | null = null;
  private viewServerId = '';                   // сервер, который смотрю (viewRoom) — теги notify чата/стримов
  private voiceServerId: string | null = null; // сервер, где я в голосовом (voiceRoom) — broadcast + снапшот; null вне войса
  private gameTimer: number | null = null;
  private myGame: GameStatus | null = null; // игра на переднем плане (натив, если включено в настройках)
  private gameShareEnabled = getSettings().shareGame;
  private stopGameSettingsWatch: (() => void) | null = null;
  private readonly gamePresence = new LatestGamePresence<Room, GameStatus>({
    currentRoom: () => this.viewRoom,
    enabled: () => this.engineLifecycleActive && isTauri && getSettings().shareGame,
    detect: async () => {
      const detected = await detectGame();
      return detected?.name ? { name: detected.name.slice(0, 48), icon: detected.icon || undefined } : null;
    },
    apply: (room, game) => this.applyGamePresence(room, game),
    clearLocal: () => {
      if (!this.myGame) return;
      this.myGame = null;
      this.emit();
    },
  });

  private volsByServer = new Map<string, { users: Record<string, number>; streams: Record<string, number> }>();
  private perMuteByServer = new Map<string, Set<string>>();
  private onlineHint = new Set<string>();
  private awayHint = new Set<string>();  // серверный хинт: члены «нет на месте» (idle, из /presence.away)
  private voiceHint: Record<string, string> = {}; // серверный хинт {username: channelId}: состав голосовых до подъёма локальной комнаты
  private activeVoiceSessions = new Map<string, { identity: string; epoch: number }>(); // monotonic vclaim per base user
  private subscriptionRetries = new Map<string, { attempts: number; nextAt: number }>();
  private voiceMediaRoomKeys = new WeakMap<Room, number>();
  private voiceMediaRoomKeySeq = 0;
  private voiceOutputRoom: Room | null = null;
  private voiceOutputSink = '';
  // LiveKit 2.20 does not await WebAudio AudioContext.setSinkId inside
  // Room.switchActiveDevice(). Own the mixer context so a rejected device
  // switch can never be mistaken for a successful one.
  private outputCtx: SinkableAudioContext | null = null;
  private outputSwitch: Promise<void> = Promise.resolve();
  private outputGeneration = 0;
  private outputRecoveryGeneration = 0;
  private outputRecovery: OutputContextRecovery | null = null;
  private outputRecoveryRejectedFor: SinkableAudioContext | null = null;
  private elementOutputGenerations = new WeakMap<HTMLMediaElement, number>();
  private elementOutputSwitches = new WeakMap<HTMLMediaElement, Promise<void>>();
  private elementOutputRoutes = new ExactMediaOutputRouteGate<HTMLMediaElement>();
  private voiceOutputPending: { room: Room; sink: string } | null = null;
  private outputDeviceTimer: number | null = null;
  private deviceChangeHandler: (() => void) | null = null;
  private outputDeviceRefreshPending = false;

  private emoteListeners = new Set<EmoteListener>();
  private subs = new Set<() => void>();
  private snap: Snapshot;

  // VAD-гейт микрофона (режим "активация голосом"): передаём звук только выше порога чувствительности
  private vadOpen = false;
  // Детектор уровня своего мика на аудио-потоке (не на rAF) — работает и в фоновой вкладке. Владеет
  // vadOpen, пока жив; иначе фолбэк на rAF-анализатор spLoop (см. setupVadWorklet/applyLocalLevel).
  private micVadNode: VadNode | null = null;
  private selfSpeakUntil = 0; // время (performance.now), до которого держим гейт открытым после речи
  // Когда в последний раз приходил замер уровня своего мика (ворклет ИЛИ spLoop). Замер устарел =
  // мы БОЛЬШЕ НЕ ЗНАЕМ, говорит человек или нет → гейт обязан открыться (см. applyGate/vadStale).
  private micLevelAt = 0;
  private vadWatchdog: number | null = null;
  private noiseFloorDb = MIN_DB + 20; // адаптивная оценка шумового фона для авто-режима

  // живой индикатор уровня для настроек (работает и вне звонка — временный захват микрофона)
  private levelListeners = new Set<LevelListener>();
  private levelCtx: AudioContext | null = null;
  private levelAnalyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array | null = null;
  private levelSrc: MediaStreamAudioSourceNode | null = null;
  private levelStream: MediaStream | null = null;
  private levelRAF: number | null = null;
  private levelHold = 0;
  private levelDenoise: RnnoiseWorkletNode | null = null;
  private levelEpoch = 0; // поколение запуска превью-метра: гасит ресурсы копии, проигравшей гонку
  private levelStartOwner = 0;
  private levelForegroundRecoveryPending = false;
  private levelTrackCleanup: (() => void) | null = null;
  private levelRecoveryTimer: number | null = null;
  private inputResumeHandler: (() => void) | null = null;
  private inputPageHideHandler: (() => void) | null = null;
  private engineLifecycleActive = true;

  constructor(me: User, hooks: EngineHooks) {
    this.me = me;
    this.hooks = hooks;
    this.streamDiagnosticOutbox = new DiagnosticReportOutbox(
      me.id,
      (report) => api.submitVoiceDiagnostic(report),
    );
    this.streamDiagnosticOutbox.start();
    this.ensureIdleWatch();
    this.ensureGameSettingsWatch();
    const onVideoTrack = (key: string, _track: unknown, identity: string, isLocal: boolean) => {
      // Track arrival is progress, not success: an audio-first/dead MediaStream
      // can still render no frame. StreamTile confirms actual playable media.
      if (!isLocal) {
        this.watchPlaybackGate.acceptTrack(identity, key);
        const attempt = this.streamWatchDiagnostics.get(identity);
        attempt?.recorder.record({
          kind: 'stream_watch_step', stage: 'watch_track', outcome: 'ok', code: 'none',
          streamTransport: attempt.streamTransport, trackState: 'live', ...this.streamWatchDiagnosticPageState(),
        });
      }
      this.emit();
    };
    const onStreamStart = (source: StreamSource, identity: string, silent: boolean) => this.onStreamSourceStart(source, identity, silent);
    const onStreamStop = (source: StreamSource, identity: string) => this.onStreamSourceStop(source, identity);
    const transports: Array<[StreamSource, VideoTransport]> = [['livekit', this.liveKitT], ['tree', this.treeT]];
    for (const [source, t] of transports) {
      t.onVideoTrack(onVideoTrack as any);
      t.onVideoTrackRemoved(() => this.emit());
      t.onStreamStart((identity, silent) => onStreamStart(source, identity, silent));
      t.onStreamStop((identity) => onStreamStop(source, identity));
      t.onWatchDiagnostic?.((event) => this.recordStreamWatchTransportDiagnostic(event));
    }
    // Э8: топология дерева меняется (join/leave/reparent) — перерисовать UI пикера пиров.
    this.treeT.onTopology?.(() => this.emit());
    // Ручной выбор источника («взять»/«через сервер») отклонён сервером — фидбэк зрителю (иначе кнопка «молчит»).
    this.treeT.onReparentDenied?.((_sid, reason) => {
      const msg = reason === 'no-vrelay' ? 'Ретрансляция через сервер сейчас недоступна'
        : reason === 'full' ? 'У выбранного узла нет свободных слотов'
        : reason === 'too-deep' ? 'Слишком глубоко в дереве — выбери узел ближе к источнику'
        : reason === 'cycle' ? 'Нельзя подключиться через собственного зрителя'
        : 'Не удалось переключить источник';
      this.hooks.toast(msg, 'warn');
    });
    // Д4: рендишн недоступен (агент отказал / кап транскодов / апскейл) — тост + фолбэк на source.
    // Д-фикс: возвращаем ЯВНО на 'source' (пин), а не 'auto': 'auto' = «сервер решает», и ABR мог
    // бы снова попробовать недоступный рендишн (петля чёрного экрана). Пин на source детерминированен.
    this.treeT.onRenditionUnavailable?.((sid, rendition, reason) => {
      this.hooks.toast(reason === 'no-upscale'
        ? `Качество ${rendition}p недоступно (выше исходного)`
        : `Качество ${rendition}p недоступно (сервер без транскода) — вернул на исходное`, 'warn');
      this.treeT.setQuality?.(sid, 'source');
      this.emit();
    });
    // Бесшовное переключение (смена качества/reparent/reconnect) не доехало за failsafe —
    // плитка закрыта, чтобы не морозить последний кадр. Тост + рефреш стримов.
    this.treeT.onSeamlessSwitchFailed?.((sid) => {
      // emitWatchDiagnostic has already appended the transport timeout synchronously. Seal that
      // attempt before closeWatch performs the ordinary user-cancel cleanup, otherwise the most
      // useful failed recovery trace would be discarded together with the frozen tile.
      this.finishStreamWatchDiagnostic(sid, 'stream_watch_failed', {
        stage: 'watch_recovery', outcome: 'timed_out', code: 'decode_timeout', trackState: 'missing',
      });
      // The transport already removed its failed tile. Clear the matching Engine ownership too;
      // otherwise watching.has(sid) makes every explicit retry a permanent no-op.
      this.closeWatch(sid);
      this.hooks.toast('Не удалось переключить качество — стрим прервался, можно подключиться снова', 'warn');
    });
    this.ensureOutputLifecycleListeners();
    this.ensureInputLifecycleListener();
    this.snap = this.build();
  }

  /* ---------- bounded, privacy-safe stream watch diagnostics ---------- */
  private streamWatchDiagnosticPageState() {
    return {
      documentHidden: typeof document === 'object' && document.hidden,
      online: typeof navigator !== 'object' || navigator.onLine !== false,
      networkType: detectVoiceDiagnosticNetworkType(),
    };
  }

  private streamWatchTransportFor(transport: VideoTransport): NonNullable<VoiceDiagnosticEvent['streamTransport']> {
    if (transport === this.liveKitT) return 'livekit';
    return isTauri ? 'tree_native' : 'tree_web';
  }

  private beginStreamWatchDiagnostic(
    identity: string,
    transport: VideoTransport,
    playbackGeneration: number,
  ): void {
    const recorder = new VoiceDiagnosticsRecorder();
    recorder.start();
    const streamTransport = this.streamWatchTransportFor(transport);
    recorder.record({
      kind: 'stream_watch_started', stage: 'watch_intent', outcome: 'started', code: 'none',
      streamTransport, ...this.streamWatchDiagnosticPageState(),
    });
    this.streamWatchDiagnostics.set(identity, {
      recorder, playbackGeneration, reconnectCount: 0, streamTransport,
    });
  }

  private recordStreamWatchTransportDiagnostic(event: StreamWatchTransportDiagnostic): void {
    // streamId is deliberately consumed only as a local map key. It is never spread into the
    // recorder, so broadcaster identity cannot leave this device in the structured report.
    const attempt = this.streamWatchDiagnostics.get(event.streamId);
    if (!attempt || event.streamTransport !== attempt.streamTransport) return;
    if (event.reconnectCount !== undefined) {
      attempt.reconnectCount = Math.max(attempt.reconnectCount, event.reconnectCount);
    }
    attempt.recorder.record({
      kind: event.stage === 'watch_recovery' && event.outcome === 'started'
        ? 'stream_watch_retry'
        : 'stream_watch_step',
      stage: event.stage,
      outcome: event.outcome,
      code: event.code,
      streamTransport: event.streamTransport,
      ...(event.connectionState === undefined ? {} : { connectionState: event.connectionState }),
      ...(event.iceState === undefined ? {} : { iceState: event.iceState }),
      ...(event.trackState === undefined ? {} : { trackState: event.trackState }),
      ...(event.reconnectCount === undefined ? {} : { reconnectCount: event.reconnectCount }),
      ...this.streamWatchDiagnosticPageState(),
    });
  }

  private finishStreamWatchDiagnostic(
    identity: string,
    incident: Extract<VoiceDiagnosticIncident,
      'stream_watch_succeeded' | 'stream_watch_failed' | 'stream_watch_recovered'>,
    event: Pick<VoiceDiagnosticEvent, 'stage' | 'outcome' | 'code' | 'trackState' | 'canPlaybackAudio'>,
  ): void {
    const attempt = this.streamWatchDiagnostics.get(identity);
    if (!attempt) return;
    this.streamWatchDiagnostics.delete(identity);
    attempt.recorder.record({
      kind: 'stream_watch_finished',
      streamTransport: attempt.streamTransport,
      reconnectCount: attempt.reconnectCount,
      ...event,
      ...this.streamWatchDiagnosticPageState(),
    });
    // Persist before the HTTP request. A WebView/process termination after this point is retried
    // by the next authenticated Engine, with clientReportId making the server write idempotent.
    this.streamDiagnosticOutbox.enqueue(attempt.recorder.buildReport(incident));
  }

  recordWatchPlaybackOutcome(
    identity: string,
    streamKey: string,
    playbackGeneration: number,
    outcome: 'playing' | 'blocked' | 'waiting' | 'failed',
    audioReady?: boolean,
  ): void {
    const attempt = this.streamWatchDiagnostics.get(identity);
    if (!attempt || attempt.playbackGeneration !== playbackGeneration
      || !this.watchPlaybackGate.confirms(identity, streamKey, playbackGeneration)) return;
    attempt.recorder.record({
      kind: 'stream_watch_step', stage: 'watch_playback',
      outcome: outcome === 'playing' ? 'ok' : outcome === 'blocked' ? 'blocked' : 'stalled',
      code: outcome === 'playing' ? 'none' : outcome === 'blocked' ? 'media_blocked'
        : outcome === 'failed' ? 'sdk' : 'playback_waiting',
      streamTransport: attempt.streamTransport,
      trackState: 'live',
      ...(audioReady === undefined ? {} : { canPlaybackAudio: audioReady }),
      ...this.streamWatchDiagnosticPageState(),
    });
  }

  /* ---------- bounded, privacy-safe voice diagnostics ---------- */
  private voiceDiagnosticConnectionState(): NonNullable<VoiceDiagnosticEvent['connectionState']> {
    if (this.voiceReconnecting || this.reconnectingRooms.has(this.voiceMediaRoom as Room)) return 'reconnecting';
    if (this.voiceMediaRoom && this.readyRooms.has(this.voiceMediaRoom)) return 'connected';
    if (this.inVoice || this.voiceConnecting) return 'connecting';
    return 'disconnected';
  }

  private voiceDiagnosticAudioContextState(): NonNullable<VoiceDiagnosticEvent['audioContextState']> {
    const state = this.micActx?.state as string | undefined;
    if (!state) return 'missing';
    if (state === 'running' || state === 'suspended' || state === 'interrupted' || state === 'closed') return state;
    return 'unknown';
  }

  private voiceDiagnosticState() {
    const rawTrack = this.micRaw?.getAudioTracks()[0];
    const publication = this.voiceMediaRoom?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const mode = getSettings().mode;
    const output = getSettings().output || 'default';
    return {
      documentHidden: typeof document === 'object' && document.hidden,
      online: typeof navigator !== 'object' || navigator.onLine !== false,
      micEnabled: !!rawTrack && rawTrack.readyState === 'live' && rawTrack.enabled
        && !this.manualMute && !this.deafened,
      publicationMuted: publication?.isMuted === true,
      upstreamPaused: publication?.isUpstreamPaused === true,
      deafened: this.deafened,
      pushToTalk: mode === 'ptt',
      speechDetected: this.vadOpen,
      canPlaybackAudio: this.voiceMediaRoom?.canPlaybackAudio !== false,
      connectionState: this.voiceDiagnosticConnectionState(),
      trackState: rawTrack ? (rawTrack.readyState === 'ended' ? 'ended' as const : 'live' as const) : 'missing' as const,
      audioContextState: this.voiceDiagnosticAudioContextState(),
      outputRoute: output === 'default' ? 'default' as const : 'custom' as const,
      micMode: mode === 'ptt' ? 'ptt' as const : 'voice' as const,
      networkType: detectVoiceDiagnosticNetworkType(),
      participantCount: this.voiceMediaRoom?.remoteParticipants.size || 0,
    };
  }

  private recordVoiceDiagnostic(event: VoiceDiagnosticEventInput): void {
    this.voiceDiagnostics.record(event);
  }

  private clearVoiceDiagnosticJoinTimer(): void {
    if (this.voiceDiagnosticJoinTimer != null) window.clearTimeout(this.voiceDiagnosticJoinTimer);
    this.voiceDiagnosticJoinTimer = null;
  }

  private beginVoiceDiagnostics(stage: NonNullable<VoiceDiagnosticEvent['stage']>): void {
    if (this.voiceDiagnostics.active) {
      this.voiceDiagnosticJoinStage = stage;
      return;
    }
    this.voiceDiagnostics.start();
    this.voiceDiagnosticSessionGeneration++;
    this.voiceDiagnosticReportsSent = 0;
    this.voiceDiagnosticReportTimes.clear();
    this.voiceDiagnosticJoinStartedAt = Date.now();
    this.voiceDiagnosticJoinStage = stage;
    this.voiceDiagnosticJoinFailureRecorded = false;
    this.voiceDiagnosticReconnectTimes = [];
    this.voiceDiagnosticLastReconnectAt = 0;
    this.voiceDiagnosticPlaybackBlockedSince = 0;
    this.voiceDiagnosticLastPlaybackBlockedAt = 0;
    this.voiceDiagnosticMuteDivergenceAt = 0;
    this.voiceDiagnosticRtcTotals = null;
    this.voiceDiagnosticUplinkSilence = emptyVoiceDiagnosticSilenceState();
    this.voiceDiagnosticInboundSilence = emptyVoiceDiagnosticSilenceState();
    this.recordVoiceDiagnostic({
      kind: 'join_started', stage, outcome: 'started', joinElapsedMs: 0,
      ...this.voiceDiagnosticState(),
    });
    this.clearVoiceDiagnosticJoinTimer();
    this.voiceDiagnosticJoinTimer = window.setTimeout(() => {
      this.voiceDiagnosticJoinTimer = null;
      if (!this.voiceDiagnostics.active || (!this.voiceConnecting && !this.pendingVoiceJoin)) return;
      this.recordVoiceJoinFailure(this.voiceDiagnosticJoinStage, undefined, 'timed_out');
    }, VOICE_JOIN_TIMEOUT_MS);
  }

  private setVoiceDiagnosticJoinStage(stage: NonNullable<VoiceDiagnosticEvent['stage']>): void {
    if (this.voiceDiagnostics.active) this.voiceDiagnosticJoinStage = stage;
  }

  private voiceDiagnosticJoinElapsed(): number {
    return this.voiceDiagnosticJoinStartedAt
      ? Math.max(0, Math.min(600_000, Date.now() - this.voiceDiagnosticJoinStartedAt))
      : 0;
  }

  private recordVoiceJoinFailure(
    stage: NonNullable<VoiceDiagnosticEvent['stage']>,
    error?: unknown,
    outcome?: 'failed' | 'timed_out' | 'cancelled',
  ): void {
    if (!this.voiceDiagnostics.active) return;
    const classified = classifyVoiceDiagnosticError(error);
    const actualOutcome = outcome ?? (classified.code === 'timeout' ? 'timed_out' : 'failed');
    if (actualOutcome === 'timed_out' && this.voiceDiagnosticJoinFailureRecorded) return;
    this.voiceDiagnosticJoinFailureRecorded = true;
    const code = actualOutcome === 'timed_out' ? 'timeout' : classified.code;
    this.recordVoiceDiagnostic({
      kind: 'join_failed', stage, outcome: actualOutcome, code,
      ...(classified.httpStatus ? { httpStatus: classified.httpStatus } : {}),
      joinElapsedMs: this.voiceDiagnosticJoinElapsed(),
      ...this.voiceDiagnosticState(),
    });
    this.submitVoiceDiagnostic(code === 'timeout' ? 'join_stuck' : 'connection_failed');
  }

  private completeVoiceDiagnosticJoin(): void {
    this.clearVoiceDiagnosticJoinTimer();
    const joinElapsedMs = this.voiceDiagnosticJoinElapsed();
    this.recordVoiceDiagnostic({
      kind: 'join_completed', outcome: 'ok', joinElapsedMs,
      ...this.voiceDiagnosticState(),
    });
    // Keep ordinary successful joins local. A genuinely slow success is useful precisely because
    // its fixed-schema timeline shows which activation/connect step consumed the delay. Reuse the
    // existing bounded join incident so this remains compatible with an older server during rollout.
    if (shouldReportSlowVoiceJoin(joinElapsedMs)) this.submitVoiceDiagnostic('join_stuck');
  }

  private clearVoiceDiagnosticPendingReport(): void {
    const pending = this.voiceDiagnosticPendingReport;
    if (pending?.timer != null) window.clearTimeout(pending.timer);
    this.voiceDiagnosticPendingReport = null;
  }

  private clearVoiceDiagnosticQueuedReport(): void {
    this.voiceDiagnosticQueuedReport = null;
  }

  private retainPendingVoiceDiagnostic(report: VoiceDiagnosticReport, userId: string, retryDelay: number): void {
    const existing = this.voiceDiagnosticPendingReport;
    if (existing && VOICE_DIAGNOSTIC_INCIDENT_PRIORITY[existing.report.incident]
      > VOICE_DIAGNOSTIC_INCIDENT_PRIORITY[report.incident]) return;
    this.clearVoiceDiagnosticPendingReport();
    this.voiceDiagnosticPendingReport = {
      report, userId, retryAt: Date.now() + retryDelay, timer: null,
    };
  }

  private beginVoiceDiagnosticUpload(
    report: VoiceDiagnosticReport,
    allowPendingRetry: boolean,
  ): boolean {
    // Report admission/budget is decided before the immutable snapshot enters this method. A
    // queued terminal snapshot may legitimately outlive recorder reset after leaveVoice().
    if (!this.voiceDiagnosticAccountActive || this.voiceDiagnosticReportInFlight) return false;
    const uploadUserId = this.me.id;
    const upload = Promise.resolve()
      .then(() => api.submitVoiceDiagnostic(report))
      .then(
        () => undefined,
        (error) => {
          // Keep at most one already-sanitized payload in memory. It is tied to this immutable
          // Engine account and survives call/server transitions. Explicit logout discards it.
          const retryDelay = voiceDiagnosticRetryDelayMs(error);
          if (allowPendingRetry && retryDelay != null && this.voiceDiagnosticAccountActive
            && uploadUserId === this.me.id)
            this.retainPendingVoiceDiagnostic(report, uploadUserId, retryDelay);
        },
      );
    this.voiceDiagnosticReportInFlight = upload;
    void upload.finally(() => {
      if (this.voiceDiagnosticReportInFlight === upload) this.voiceDiagnosticReportInFlight = null;
      this.retryPendingVoiceDiagnostic();
    });
    return true;
  }

  private drainQueuedVoiceDiagnostic(): boolean {
    const queued = this.voiceDiagnosticQueuedReport;
    if (!queued || this.voiceDiagnosticReportInFlight) return false;
    if (!this.voiceDiagnosticAccountActive || queued.userId !== this.me.id) {
      this.clearVoiceDiagnosticQueuedReport();
      return false;
    }
    if ((typeof navigator === 'object' && navigator.onLine === false)
      || (typeof document === 'object' && document.hidden)) return false;
    this.clearVoiceDiagnosticQueuedReport();
    return this.beginVoiceDiagnosticUpload(queued.report, true);
  }

  private retryPendingVoiceDiagnostic(): void {
    // A never-attempted terminal snapshot owns the next upload before an older retry. If the page
    // is still offline/hidden it remains queued until the account-scoped lifecycle listener fires.
    if (this.drainQueuedVoiceDiagnostic() || this.voiceDiagnosticQueuedReport) return;
    const pending = this.voiceDiagnosticPendingReport;
    if (!pending) return;
    if (!this.voiceDiagnosticAccountActive || pending.userId !== this.me.id) {
      this.clearVoiceDiagnosticPendingReport();
      return;
    }
    if (this.voiceDiagnosticReportInFlight || (typeof navigator === 'object' && navigator.onLine === false)
      || (typeof document === 'object' && document.hidden)) return;
    const cooldownUntil = Math.max(
      pending.retryAt,
      (this.voiceDiagnosticReportTimes.get(pending.report.incident) || 0) + VOICE_DIAGNOSTIC_REPORT_COOLDOWN_MS,
    );
    const waitMs = cooldownUntil - Date.now();
    if (waitMs > 0) {
      if (pending.timer == null) pending.timer = window.setTimeout(() => {
        if (this.voiceDiagnosticPendingReport !== pending) return;
        pending.timer = null;
        this.retryPendingVoiceDiagnostic();
      }, waitMs);
      return;
    }
    const { report } = pending;
    this.clearVoiceDiagnosticPendingReport();
    // A retry failure is deliberately terminal: this is the only bounded pending retry.
    this.beginVoiceDiagnosticUpload(report, false);
  }

  private submitVoiceDiagnostic(incident: VoiceDiagnosticIncident, terminalSnapshot = false): void {
    if (!this.voiceDiagnostics.active) return;
    const now = Date.now();
    const previous = this.voiceDiagnosticReportTimes.get(incident) || 0;
    if (!terminalSnapshot && now - previous < VOICE_DIAGNOSTIC_REPORT_COOLDOWN_MS) return;
    const priority = VOICE_DIAGNOSTIC_INCIDENT_PRIORITY[incident];
    const queued = this.voiceDiagnosticQueuedReport;
    if (this.voiceDiagnosticReportInFlight && queued && queued.priority > priority) return;
    // Reserve the fourth slot for the final `left` snapshot. It contains the outcome which an
    // earlier incident report cannot know yet, while ordinary watchdog samples remain capped at 3.
    const reportLimit = terminalSnapshot
      ? VOICE_DIAGNOSTIC_MAX_REPORTS_PER_SESSION
      : VOICE_DIAGNOSTIC_MAX_REPORTS_PER_SESSION - 1;
    if ((!this.voiceDiagnosticReportInFlight || !queued)
      && this.voiceDiagnosticReportsSent >= reportLimit) return;
    const report = this.voiceDiagnostics.buildReport(incident);
    if (this.voiceDiagnosticReportInFlight) {
      if (queued) {
        if (this.voiceDiagnosticReportTimes.get(queued.report.incident) === queued.reservedAt)
          this.voiceDiagnosticReportTimes.delete(queued.report.incident);
      } else {
        this.voiceDiagnosticReportsSent++;
      }
      this.voiceDiagnosticReportTimes.set(incident, now);
      this.voiceDiagnosticQueuedReport = { report, userId: this.me.id, priority, reservedAt: now };
      return;
    }
    this.voiceDiagnosticReportsSent++;
    this.voiceDiagnosticReportTimes.set(incident, now);
    this.beginVoiceDiagnosticUpload(report, true);
  }

  private resetVoiceDiagnostics(): void {
    this.clearVoiceDiagnosticJoinTimer();
    this.voiceDiagnosticStallMonitor.stop();
    this.voiceDiagnostics.reset();
    this.voiceDiagnosticJoinStartedAt = 0;
    this.voiceDiagnosticJoinFailureRecorded = false;
    this.voiceDiagnosticReconnectTimes = [];
    this.voiceDiagnosticLastReconnectAt = 0;
    this.voiceDiagnosticPlaybackBlockedSince = 0;
    this.voiceDiagnosticLastPlaybackBlockedAt = 0;
    this.voiceDiagnosticMuteDivergenceAt = 0;
    this.voiceDiagnosticRtcTotals = null;
    this.voiceDiagnosticUplinkSilence = emptyVoiceDiagnosticSilenceState();
    this.voiceDiagnosticInboundSilence = emptyVoiceDiagnosticSilenceState();
  }

  private finishVoiceDiagnostics(incident: VoiceDiagnosticIncident = 'session_ended'): void {
    if (!this.voiceDiagnostics.active) return;
    this.clearVoiceDiagnosticJoinTimer();
    this.recordVoiceDiagnostic({
      kind: 'left', outcome: incident === 'session_ended' ? 'ok' : 'failed',
      ...this.voiceDiagnosticState(),
    });
    // Healthy exits are useful as a small control sample, but must never dominate the bounded
    // server retention window and evict the incidents this facility exists to diagnose.
    if (incident !== 'session_ended' || Math.random() < VOICE_DIAGNOSTIC_HEALTHY_SESSION_SAMPLE_RATE)
      this.submitVoiceDiagnostic(incident, true);
    this.resetVoiceDiagnostics();
  }

  private recordVoiceReconnecting(): void {
    if (!this.voiceDiagnostics.active || !this.inVoice) return;
    this.resetVoiceDiagnosticTransportWindow();
    const now = Date.now();
    // Hub and exact media rooms normally emit the same outage edge. Keep one logical reconnect
    // without exposing either room identity in the report.
    if (now - this.voiceDiagnosticLastReconnectAt < 750) return;
    this.voiceDiagnosticLastReconnectAt = now;
    this.voiceDiagnosticReconnectTimes.push(now);
    this.voiceDiagnosticReconnectTimes = this.voiceDiagnosticReconnectTimes
      .filter((at) => now - at <= VOICE_DIAGNOSTIC_RECONNECT_WINDOW_MS);
    this.recordVoiceDiagnostic({
      kind: 'reconnecting', outcome: 'started', reconnectCount: this.voiceDiagnosticReconnectTimes.length,
      ...this.voiceDiagnosticState(),
    });
    if (this.voiceDiagnosticReconnectTimes.length >= VOICE_DIAGNOSTIC_RECONNECT_LOOP_COUNT)
      this.submitVoiceDiagnostic('reconnect_loop');
  }

  private recordVoiceReconnected(): void {
    if (!this.voiceDiagnostics.active || !this.inVoice) return;
    this.recordVoiceDiagnostic({
      kind: 'reconnected', outcome: 'recovered', reconnectCount: this.voiceDiagnosticReconnectTimes.length,
      ...this.voiceDiagnosticState(),
    });
  }

  private onVoiceNetworkChanged = () => {
    if (!this.voiceDiagnostics.active || !this.inVoice) return;
    this.resetVoiceDiagnosticTransportWindow();
    this.recordVoiceDiagnostic({ kind: 'network_changed', outcome: 'ok', ...this.voiceDiagnosticState() });
    if (typeof navigator !== 'object' || navigator.onLine !== false) this.retryPendingVoiceDiagnostic();
  };

  private recordVoicePlaybackBlocked(): void {
    if (!this.voiceDiagnostics.active || !this.inVoice) return;
    const now = Date.now();
    if (!this.voiceDiagnosticPlaybackBlockedSince) this.voiceDiagnosticPlaybackBlockedSince = now;
    if (now - this.voiceDiagnosticLastPlaybackBlockedAt >= VOICE_DIAGNOSTIC_PLAYBACK_EVENT_COOLDOWN_MS) {
      this.voiceDiagnosticLastPlaybackBlockedAt = now;
      this.recordVoiceDiagnostic({
        kind: 'playback_blocked', stage: 'playback', outcome: 'blocked', code: 'media_blocked',
        ...this.voiceDiagnosticState(),
      });
    }
    if (now - this.voiceDiagnosticPlaybackBlockedSince >= 3_000)
      this.submitVoiceDiagnostic('playback_blocked');
  }

  private clearVoicePlaybackBlocked(): void {
    this.voiceDiagnosticPlaybackBlockedSince = 0;
  }

  private recordVoiceOutputFailure(
    outputRoute: NonNullable<VoiceDiagnosticEvent['outputRoute']>,
    outcome: 'failed' | 'timed_out' | 'unsupported' = 'failed',
    outputTarget: NonNullable<VoiceDiagnosticEvent['outputTarget']> = 'voice_mixer',
    outputOperation: NonNullable<VoiceDiagnosticEvent['outputOperation']> = 'set_sink',
    code?: NonNullable<VoiceDiagnosticEvent['code']>,
    submitIncident = true,
  ): void {
    if (!this.voiceDiagnostics.active) return;
    this.recordVoiceDiagnostic({
      kind: 'output_route_failed', stage: 'output_route', outcome,
      code: code ?? (outcome === 'timed_out' ? 'timeout' : outcome === 'unsupported' ? 'unsupported' : 'unknown'),
      ...this.voiceDiagnosticState(), outputRoute, outputTarget, outputOperation,
    });
    if (submitIncident) this.submitVoiceDiagnostic('output_route_failed');
  }

  private recordVoiceMicFailure(
    stage: 'mic_capture' | 'mic_publish' | 'mic_recovery',
    error?: unknown,
  ): void {
    if (!this.voiceDiagnostics.active) return;
    const classified = classifyVoiceDiagnosticError(error);
    this.recordVoiceDiagnostic({
      kind: stage === 'mic_capture' ? 'mic_capture_finished'
        : stage === 'mic_publish' ? 'mic_published' : 'mic_recovery_finished',
      stage, outcome: classified.code === 'timeout' ? 'timed_out' : 'failed',
      ...classified, ...this.voiceDiagnosticState(),
    });
    this.submitVoiceDiagnostic('mic_failed');
  }

  private observeVoiceDiagnosticMuteState(): void {
    if (!this.voiceDiagnostics.active || !this.inVoice || !this.micLocalTrack || !this.voiceMediaRoom) {
      this.voiceDiagnosticMuteDivergenceAt = 0;
      return;
    }
    const publication = this.voiceMediaRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!publication || publication.track !== this.micLocalTrack) {
      this.voiceDiagnosticMuteDivergenceAt = 0;
      return;
    }
    const expectedMuted = this.manualMute || this.deafened;
    if (publication.isMuted === expectedMuted) {
      this.voiceDiagnosticMuteDivergenceAt = 0;
      return;
    }
    const now = Date.now();
    if (!this.voiceDiagnosticMuteDivergenceAt) this.voiceDiagnosticMuteDivergenceAt = now;
    if (now - this.voiceDiagnosticMuteDivergenceAt < VOICE_DIAGNOSTIC_MUTE_DIVERGENCE_MS) return;
    this.recordVoiceDiagnostic({
      kind: 'mute_changed', outcome: 'failed', code: 'sdk', ...this.voiceDiagnosticState(),
      micEnabled: !expectedMuted, publicationMuted: publication.isMuted,
    });
    this.submitVoiceDiagnostic('mute_divergence');
  }

  private resetVoiceDiagnosticTransportWindow(): void {
    this.voiceDiagnosticRtcTotals = null;
    this.voiceDiagnosticUplinkSilence = emptyVoiceDiagnosticSilenceState();
    this.voiceDiagnosticInboundSilence = emptyVoiceDiagnosticSilenceState();
  }

  private voiceDiagnosticTransportObservable(room: Room): boolean {
    return this.inVoice && this.voiceMediaRoom === room && this.readyRooms.has(room)
      && this.voiceMediaActivated.has(room) && !this.voiceConnecting && !this.voiceReconnecting
      && !this.reconnectingRooms.has(room) && (typeof navigator !== 'object' || navigator.onLine !== false)
      && (typeof document !== 'object' || !document.hidden);
  }

  private voiceDiagnosticExpectsUplink(room: Room): boolean {
    if (!this.voiceDiagnosticTransportObservable(room) || this.manualMute || this.deafened || this.noMic
      || this.micRecoveryOwner !== 0 || this.voiceLeaseVerifying || this.voiceClaimPending !== 0) return false;
    const rawTrack = this.micRaw?.getAudioTracks()[0];
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!rawTrack || rawTrack.readyState !== 'live' || !rawTrack.enabled || !this.micLocalTrack
      || this.micLocalTrack.mediaStreamTrack.readyState !== 'live' || publication?.track !== this.micLocalTrack
      || publication.isMuted || publication.isUpstreamPaused) return false;
    const settings = getSettings();
    // A zero-rate interval is intentional unless the exact PTT/VAD gate is open.
    return settings.mode === 'ptt'
      ? this.pttDown
      : this.vadOpen || this.vadStale();
  }

  private voiceDiagnosticExpectsInbound(room: Room): boolean {
    const outputAudible = getSettings().master > 0;
    let speakingRemote = false;
    if (outputAudible) {
      for (const participant of room.remoteParticipants.values()) {
        const username = baseUid(participant.identity);
        if (username === this.me.username || participant !== this.mediaPartOf(username, room)
          || this.muteSet(this.voiceServerId).has(username) || this.voiceUserVolOf(username) <= 0) continue;
        const publication = participant.getTrackPublication(Track.Source.Microphone);
        const mediaTrack = (publication?.track as RemoteTrack | undefined)?.mediaStreamTrack;
        // isSpeaking is an SFU-side expectation signal; the local analyser is corroborating
        // evidence when media still arrives. An unmuted but quiet publication alone is not enough.
        if (publication && !publication.isMuted && !(publication as any).isUpstreamPaused
          && mediaTrack?.readyState !== 'ended'
          && (participant.isSpeaking || this.speakingSet.has(username))) {
          speakingRemote = true;
          break;
        }
      }
    }
    return voiceDiagnosticInboundExpected({
      transportObservable: this.voiceDiagnosticTransportObservable(room),
      deafened: this.deafened,
      canPlaybackAudio: room.canPlaybackAudio !== false,
      outputAudible,
      speakingRemote,
    });
  }

  private observeVoiceDiagnosticSilence(
    direction: 'uplink' | 'inbound',
    expected: boolean,
    comparable: boolean,
    progressed: boolean,
    intervalStartedAt: number,
    now: number,
    deltas: Pick<VoiceDiagnosticEvent,
      'packetsReceivedDelta' | 'packetsSentDelta' | 'bytesReceivedDelta' | 'bytesSentDelta'>,
  ): void {
    const current = direction === 'uplink'
      ? this.voiceDiagnosticUplinkSilence
      : this.voiceDiagnosticInboundSilence;
    const result = advanceVoiceDiagnosticSilence(
      current, expected, comparable, progressed, intervalStartedAt, now,
    );
    if (direction === 'uplink') this.voiceDiagnosticUplinkSilence = result.state;
    else this.voiceDiagnosticInboundSilence = result.state;
    if (!result.started && !result.recovered) return;
    const transition = {
      stage: 'rtc' as const,
      outcome: result.started ? 'stalled' as const : 'recovered' as const,
      code: result.started ? 'network' as const : 'none' as const,
      ...deltas, ...this.voiceDiagnosticState(),
    };
    if (direction === 'uplink') this.recordVoiceDiagnostic({ kind: 'uplink_stalled', ...transition });
    else this.recordVoiceDiagnostic({ kind: 'inbound_stalled', ...transition });
    if (result.started) this.submitVoiceDiagnostic(direction === 'uplink' ? 'uplink_silent' : 'inbound_silent');
  }

  private recordVoiceRtcSample(report: RTCStatsReport, rttMs: number | null, track: object): void {
    if (!this.voiceDiagnostics.active || !this.inVoice) return;
    const sampledAt = Date.now();
    const totals: VoiceDiagnosticRtcTotals = {
      track,
      sampledAt,
      packetsLost: 0, packetsReceived: 0, packetsSent: 0,
      bytesReceived: 0, bytesSent: 0, concealedSamples: 0,
      outboundPackets: 0, outboundBytes: 0,
      inboundPackets: 0, inboundBytes: 0,
      hasOutboundAudio: false, hasInboundAudio: false,
    };
    let jitterMs: number | undefined;
    let audioLevel: number | undefined;
    report.forEach((stat: any) => {
      const mediaType = stat.kind || stat.mediaType;
      const rtp = stat.type === 'outbound-rtp' || stat.type === 'inbound-rtp' || stat.type === 'remote-inbound-rtp';
      if (!rtp || (mediaType && mediaType !== 'audio')) return;
      if (stat.type === 'outbound-rtp') {
        totals.hasOutboundAudio = true;
        if (Number.isFinite(stat.packetsSent)) totals.outboundPackets += Math.max(0, stat.packetsSent);
        if (Number.isFinite(stat.bytesSent)) totals.outboundBytes += Math.max(0, stat.bytesSent);
      } else if (stat.type === 'inbound-rtp') {
        totals.hasInboundAudio = true;
        if (Number.isFinite(stat.packetsReceived)) totals.inboundPackets += Math.max(0, stat.packetsReceived);
        if (Number.isFinite(stat.bytesReceived)) totals.inboundBytes += Math.max(0, stat.bytesReceived);
      }
      if (Number.isFinite(stat.packetsLost)) totals.packetsLost += Math.max(0, stat.packetsLost);
      if (Number.isFinite(stat.packetsReceived)) totals.packetsReceived += Math.max(0, stat.packetsReceived);
      if (Number.isFinite(stat.packetsSent)) totals.packetsSent += Math.max(0, stat.packetsSent);
      if (Number.isFinite(stat.bytesReceived)) totals.bytesReceived += Math.max(0, stat.bytesReceived);
      if (Number.isFinite(stat.bytesSent)) totals.bytesSent += Math.max(0, stat.bytesSent);
      if (Number.isFinite(stat.concealedSamples)) totals.concealedSamples += Math.max(0, stat.concealedSamples);
      if (Number.isFinite(stat.jitter)) jitterMs = Math.max(jitterMs || 0, stat.jitter * 1_000);
      if (Number.isFinite(stat.audioLevel)) audioLevel = Math.max(audioLevel || 0, stat.audioLevel);
    });
    // Publisher and subscriber transports can expose unrelated monotonic counters. Only compare
    // two reports produced by the exact same Local/RemoteTrack owner.
    const previousTotals = this.voiceDiagnosticRtcTotals;
    const trackChanged = !!previousTotals && previousTotals.track !== track;
    if (trackChanged) {
      // A new sender/receiver owns an unrelated monotonic counter sequence. Its first sample is a
      // fresh baseline and must not inherit a nearly-stalled window from the retired exact track.
      this.voiceDiagnosticUplinkSilence = emptyVoiceDiagnosticSilenceState();
      this.voiceDiagnosticInboundSilence = emptyVoiceDiagnosticSilenceState();
    }
    const previous = previousTotals?.track === track ? previousTotals : null;
    const delta = (current: number, old: number) => Math.max(0, current - old);
    const deltas = previous ? {
      packetsLostDelta: delta(totals.packetsLost, previous.packetsLost),
      packetsReceivedDelta: delta(totals.packetsReceived, previous.packetsReceived),
      packetsSentDelta: delta(totals.packetsSent, previous.packetsSent),
      bytesReceivedDelta: delta(totals.bytesReceived, previous.bytesReceived),
      bytesSentDelta: delta(totals.bytesSent, previous.bytesSent),
      concealedSamplesDelta: delta(totals.concealedSamples, previous.concealedSamples),
    } : null;
    this.recordVoiceDiagnostic({
      kind: 'rtc_sample', stage: 'rtc', outcome: 'ok',
      ...(rttMs == null ? {} : { rttMs }),
      ...(jitterMs == null ? {} : { jitterMs }),
      ...(audioLevel == null ? {} : { audioLevel }),
      ...(deltas || {}),
      ...this.voiceDiagnosticState(),
    });
    if (previous && deltas) {
      const uplinkComparable = previous.hasOutboundAudio && totals.hasOutboundAudio;
      const uplinkProgressed = delta(totals.outboundPackets, previous.outboundPackets) > 0
        || delta(totals.outboundBytes, previous.outboundBytes) > 0;
      const inboundComparable = previous.hasInboundAudio && totals.hasInboundAudio;
      // Generic candidate-pair bytes on the publisher PeerConnection do not prove that remote
      // speech arrived. Inbound silence is armed only by exact receiver RTP counters.
      const inboundProgressed = delta(totals.inboundPackets, previous.inboundPackets) > 0
        || delta(totals.inboundBytes, previous.inboundBytes) > 0;
      const safeDeltas = {
        packetsReceivedDelta: deltas.packetsReceivedDelta,
        packetsSentDelta: deltas.packetsSentDelta,
        bytesReceivedDelta: deltas.bytesReceivedDelta,
        bytesSentDelta: deltas.bytesSentDelta,
      };
      this.observeVoiceDiagnosticSilence(
        'uplink', this.voiceDiagnosticExpectsUplink(this.voiceMediaRoom!), uplinkComparable,
        uplinkProgressed, previous.sampledAt, sampledAt, safeDeltas,
      );
      this.observeVoiceDiagnosticSilence(
        'inbound', this.voiceDiagnosticExpectsInbound(this.voiceMediaRoom!), inboundComparable,
        inboundProgressed, previous.sampledAt, sampledAt, safeDeltas,
      );
    }
    this.voiceDiagnosticRtcTotals = totals;
  }

  private ensureIdleWatch() {
    if (this.stopIdleWatch) return;
    // Индикаторы «говорит» считаются только когда на окно смотрят: под полноэкранной игрой этот
    // rAF-цикл крутился 60 раз в секунду впустую и не давал заснуть кадровому конвейеру целиком.
    this.stopIdleWatch = onWindowIdle((idle) => {
      if (idle) {
        // Полностью гасить индикаторы «говорит» нельзя: окно без фокуса ещё не значит, что его не
        // видно — типовой случай это приложение на втором мониторе, пока человек играет. Уходим с
        // rAF (живой кадровый цикл заставляет движок планировать кадр каждый vsync и не даёт заснуть
        // соседним анимациям) на редкий таймер: вчетверо реже и без участия в отрисовке кадра.
        if (this.spRAF) { cancelAnimationFrame(this.spRAF); this.spRAF = null; }
        if (!this.spIdleTimer) this.spIdleTimer = window.setInterval(() => { if (this.analysers.size) this.spLoop(true); }, 150);
        return;
      }
      if (this.spIdleTimer) { clearInterval(this.spIdleTimer); this.spIdleTimer = null; }
      if (!this.spRAF && this.analysers.size) this.spRAF = requestAnimationFrame(() => this.spLoop());
    });
  }

  private ensureOutputLifecycleListeners() {
    // Unlike the active-call network observer, this owner survives a terminal/offline voice exit
    // so the single sanitized report retained in memory can be delivered when the account session
    // is still alive. Only explicit account logout removes it and invalidates report ownership.
    if (!this.voiceDiagnosticRetryHandler) {
      this.voiceDiagnosticRetryHandler = () => this.retryPendingVoiceDiagnostic();
      window.addEventListener('online', this.voiceDiagnosticRetryHandler);
      document.addEventListener('visibilitychange', this.voiceDiagnosticRetryHandler);
      window.addEventListener('pageshow', this.voiceDiagnosticRetryHandler);
    }
    // Headsets/Bluetooth outputs may disappear without touching the settings UI. Re-verify both
    // output routing and capture; the polling watchdog remains the fallback without devicechange.
    if (!this.deviceChangeHandler) {
      this.deviceChangeHandler = () => {
        if (this.outputDeviceTimer) clearTimeout(this.outputDeviceTimer);
        this.outputDeviceTimer = window.setTimeout(() => {
          this.outputDeviceTimer = null;
          if (this.viewRoom || this.voiceRoom) {
            // Chromium/CoreAudio can reject setSinkId while a PWA is hidden. Keep the current
            // audible route untouched and re-enumerate once on the next real foreground edge.
            if (document.hidden) this.outputDeviceRefreshPending = true;
            else {
              this.outputDeviceRefreshPending = false;
              void this.applyOutput(true);
            }
          }
          if (this.inVoice) void this.checkMicAlive(true);
          else if (this.levelListeners.size > 0) this.restartLevelMeter();
        }, 200);
      };
      navigator.mediaDevices?.addEventListener?.('devicechange', this.deviceChangeHandler);
    }
    // iOS/Android can pause already-authorized elements in background or during a system route
    // swap. This listener also covers stream-only viewing outside a voice channel.
    if (!this.remoteAudioResumeHandler) {
      this.remoteAudioResumeHandler = () => {
        if (!document.hidden) {
          this.retryPendingVoiceDiagnostic();
          const freshForegroundEdge = this.retryAttachedOutputRoutesAfterForeground();
          this.ensureRemoteAudioPlayback(freshForegroundEdge);
        }
      };
      document.addEventListener('visibilitychange', this.remoteAudioResumeHandler);
      window.addEventListener('pageshow', this.remoteAudioResumeHandler);
    }
  }

  private retryAttachedOutputRoutesAfterForeground(): boolean {
    // A failed/hung setSinkId attempt is deliberately coalesced during steady-state watchdog
    // reconciliation. A real foreground edge is the bounded retry boundary: CoreAudio/Bluetooth
    // may have recovered while the PWA was hidden, and paired visibilitychange/pageshow events
    // must still spend only one physical retry per attached element.
    const now = Date.now();
    if (now - this.lastForegroundOutputRetryAt < 1_000) return false;
    this.lastForegroundOutputRetryAt = now;
    const forceRefresh = this.outputDeviceRefreshPending;
    this.outputDeviceRefreshPending = false;
    const requested = getSettings().output || 'default';
    // LiveKit WebAudio tracks are intentionally muted at the element layer: outputCtx is their
    // actual audible sink. Retry that shared context and the independent tree path once on the
    // same physical foreground edge; the timestamp above coalesces visibilitychange + pageshow.
    if (this.outputCtx || this.exactOutputRooms().length)
      void this.switchContextOutput(requested, false, forceRefresh);
    [...this.voiceAudioEls.values(), ...this.screenAudioEls.values()].forEach(({ el }) => {
      void this.switchElementOutput(el, requested, true, forceRefresh);
    });
    return true;
  }

  private ensureInputLifecycleListener() {
    if (this.inputResumeHandler) return;
    this.inputResumeHandler = () => {
      if (document.hidden) {
        this.suspendLevelMeterForBackground();
        this.markVoiceHidden();
        return;
      }
      if (!this.engineLifecycleActive) return;
      if (this.inVoice) { this.onVisible(); return; }
      if (this.levelListeners.size === 0) return;
      if (this.levelForegroundRecoveryPending) {
        // Consume synchronously: visibilitychange + pageshow are commonly delivered as a pair on
        // iOS. levelStartOwner keeps the second event from stacking another permission request.
        this.levelForegroundRecoveryPending = false;
        if (!this.levelStartOwner && !this.levelStream) void this.startLevelMeter();
        return;
      }
      if (this.levelStartOwner) return;
      const track = this.levelStream?.getAudioTracks()[0];
      if (!track || track.readyState === 'ended' || track.muted) this.restartLevelMeter();
      else requestExactAudioContextResume(this.levelCtx);
    };
    // pagehide can precede document.hidden (notably BFCache/standalone iOS). It must synchronously
    // retire settings-only capture even when no visibilitychange is delivered.
    this.inputPageHideHandler = () => {
      this.suspendLevelMeterForBackground();
      this.markVoiceHidden();
    };
    document.addEventListener('visibilitychange', this.inputResumeHandler);
    window.addEventListener('pageshow', this.inputResumeHandler);
    window.addEventListener('pagehide', this.inputPageHideHandler);
  }

  setMe(me: User) { this.me = me; }
  setMembers(m: Member[]) {
    this.members = m;
    const byId = new Map(m.map((member) => [member.id, member]));
    this.messages = this.messages.map((message) => {
      const member = message.uid ? byId.get(message.uid) : undefined;
      return member && !message.sys ? { ...message, who: member.displayName, color: member.avatarColor } : message;
    });
    this.emit();
  }
  beginChatView(serverId: string) {
    if (!serverId || this.chatStateServerId === serverId) return;
    this.viewServerId = serverId;
    this.chatStateServerId = serverId;
    this.chatRevision = 0;
    this.chatLastClearRevision = 0;
    this.chatRevisionKnown = false;
    this.canonicalSnapshotEstablished = false;
    this.chatEventBuffer = [];
    this.chatEventBufferOverflow = false;
    this.chatSnapshotSeenSids.clear();
    this.canonicalMentionDeliveries.clear();
    this.chatMentionFenceEstablished = false;
    this.chatSyncAgain = false;
    this.chatSyncFailures = 0;
    this.chatSyncPromise = null;
    ++this.chatSyncGeneration;
    this.hooks.chatConnectionChanged?.();
  }
  setServerChatReady(ready = true) {
    if (this.serverChatReady === ready) return;
    this.serverChatReady = ready;
    this.canonicalSnapshotEstablished = false;
    if (!ready) {
      this.chatRevision = 0;
      this.chatLastClearRevision = 0;
      this.chatRevisionKnown = false;
      this.chatEventBuffer = [];
      this.chatEventBufferOverflow = false;
      this.chatSyncAgain = false;
      this.chatSyncFailures = 0;
      this.chatSyncPromise = null;
      ++this.chatSyncGeneration;
    }
    if (ready && this.chatStateServerId) void this.synchronizeChat(this.chatStateServerId);
  }
  setOnlineHint(ids: string[]) { this.onlineHint = new Set(ids); this.emit(); }
  setAwayHint(ids: string[]) { this.awayHint = new Set(ids); this.emit(); }
  // Обслуживает ли живой LiveKit-путь чат ИМЕННО этого сервера. Нужен notify-WS: он гасит свою копию
  // уведомления для «текущего» сервера, а «текущий» в сторе выставляется оптимистично (до подъёма
  // комнаты) и переживает обрыв с реконнектом — в этих окнах LiveKit ничего не доставляет.
  realtimeServes(serverId: string): boolean {
    const room = this.viewRoom;
    return !!room && this.viewServerId === serverId && this.roomReady && this.readyRooms.has(room) && !this.reconnectingRooms.has(room);
  }
  connectedChatServerId(): string | null {
    // Canonical notify-WS is also the fallback while LiveKit is connecting or
    // failed. The logical Engine scope, not UI visibility or room readiness,
    // determines the one chat this socket subscribes to.
    return this.chatStateServerId || null;
  }
  claimChatMentionNotification(serverId: string, messageId: number): boolean {
    return this.chatStateServerId === serverId
      && claimBoundedMessageId(this.canonicalMentionDeliveries, messageId);
  }
  canonicalChatEnabled(): boolean { return this.serverChatReady; }
  setVoiceHint(v: Record<string, string>) { this.voiceHint = v || {}; this.emit(); }
  setVols(serverId: string, v: { users?: Record<string, number>; streams?: Record<string, number> }) {
    if (!serverId) return;
    this.volsByServer.set(serverId, { users: { ...(v.users || {}) }, streams: { ...(v.streams || {}) } });
    if (serverId === this.voiceServerId) this.applyAllVolumes();
    if (serverId === this.viewServerId) this.applyAllStreamVolumes();
    this.emit();
  }
  // состояние пагинации чата (для UI/догрузки старых сообщений)
  get chatHasMore() { return this.chatMore; }
  get chatOldestCursor() { return this.oldestSid; }
  get chatHistoryGeneration() { return this.chatGeneration; }

  /* ---------- subscription (useSyncExternalStore) ---------- */
  subscribe = (cb: () => void) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; };
  getSnapshot = () => this.snap;
  private emit() { this.snap = this.build(); this.subs.forEach((f) => f()); }

  private build(): Snapshot {
    const presence: Record<string, PeerState> = {};
    // Кто в каком голосовом канале. Главный источник — vc-АТРИБУТ участника: LiveKit доставляет
    // его даже для пиров, сидевших в комнате ДО нашего коннекта. mic-ПУБЛИКАЦИЯ для таких
    // «уже присутствовавших» при autoSubscribe:false нам не приезжает, поэтому isInVoice давал
    // false и пир пропадал из канала — хотя и сервер, и он сам видели его в голосовом (ровно
    // баг «не вижу друга, а он меня видит»: меня он видел, т.к. я подключился ПОЗЖЕ и ему
    // прилетел живой TrackPublished). Серверный хинт /presence — fallback, когда пир не виден
    // локально или атрибут ещё в полёте.
    const voiceChannels: Record<string, string> = {};
    const channelActiveSince: Record<string, number> = {};
    for (const m of this.members) {
      const p = this.partOf(m.username);
      const online = !!p || this.onlineHint.has(m.username);
      let vc = '';
      // После успешного LiveKit-connect realtime — единственный источник истины. Пустой/исчезнувший
      // participant является tombstone: старый REST voiceHint нельзя возвращать в UI, иначе после выхода
      // строка исчезает, тут же «воскресает» и пропадает лишь со следующим 5с presence-poll.
      if (this.roomReady) {
        if (m.username === this.me.username) vc = this.inVoice && this.voiceServerId === this.viewServerId ? (this.currentVc || '') : '';
        else vc = p ? (this.voiceChannelOf(m.username) || '') : '';
      }
      else vc = this.voiceHint[m.username] || ''; // bootstrap только ДО готовности комнаты
      if (vc) {
        voiceChannels[m.username] = vc;
        const at = m.username === this.me.username
          ? (this.voicePresenceConfirmed ? this.myVcAt : null)
          : Number((p as any)?.attributes?.vcAt) || null;
        if (at && (!(vc in channelActiveSince) || at < channelActiveSince[vc])) channelActiveSince[vc] = at;
      }
      const inV = !!vc; // членство канала задаёт vc-атрибут, mic publication не является presence
      // Hub deliberately has no microphone publications after media isolation. Presence and
      // durable mute intent therefore come from its participant attributes.
      // «оглох» (deafen) транслируется пирам participant-атрибутом deaf (как vc для голосового
      // канала) — иначе другие видят для оглохшего то же «мик выключен», что и для просто мута.
      const deaf = m.username === this.me.username ? this.deafened : !!(p as any)?.attributes?.deaf;
      // LiveKit publication mute is a transport signal too: iOS sets it when a hidden PWA loses
      // capture, even though the user never pressed mute. Durable hub attributes are authoritative
      // for the user's intent; an unavailable microphone also writes mic=0 after a real failure.
      // «играет в X»: для себя — локальный детект, для пира — participant-атрибуты game/gicon
      let game: GameStatus | null = null;
      if (m.username === this.me.username) game = this.myGame;
      else { const gn = (p as any)?.attributes?.game; if (gn) game = { name: gn, icon: (p as any)?.attributes?.gicon || undefined }; }
      const streaming = this.isStreaming(m.username);
      // Игра показывается ТОЛЬКО из detect_game (атрибут/локальный myGame), НЕ из меты стрима: захваченное
      // окно ≠ «во что играет» (по решению пользователя). Стример без игры — просто LIVE, без «играет в X».
      const away = !inV && !streaming && this.awayHint.has(m.username); // idle-онлайн («нет на месте», жёлтый)
      // Свой бейдж берём из локального интента; чужой — из того же durable hub-атрибута. Отсутствие
      // media publication или её системный mute во время восстановления не подменяют ручной mute.
      const micMuted = m.username === this.me.username
        ? (this.localMicMuted() || deaf)
        : ((p as any)?.attributes?.mic === '0' || deaf);
      presence[m.username] = { online, inVoice: inV, micMuted, streaming, deafened: deaf, away, game };
    }
    const speaking: Record<string, boolean> = {};
    this.speakingSet.forEach((u) => (speaking[u] = true));
    // стримы (screenshare) смотрятся server-wide, независимо от голосового канала: по каналам
    // изолирован только звук микрофона. Иначе нельзя было бы смотреть трансляцию не заходя в её канал.
    const streams: StreamInfo[] = [...this.liveKitT.getStreams(), ...this.treeT.getStreams()];
    const watching: Record<string, true> = {}; this.watching.forEach((u) => (watching[u] = true));
    const pending: Record<string, true> = {}; this.pendingWatch.forEach((u) => (pending[u] = true));
    const watchers: Record<string, { name: string; color: number; avatarUrl?: string }[]> = {};
    this.streamWatchers.forEach((m, sid) => (watchers[sid] = [...m.values()].map((v) => ({ name: v.name, color: v.color, avatarUrl: v.avatarUrl }))));
    const voiceConnection: VoiceConnectionState = this.lostVoiceServerId
      ? 'disconnected'
      : (!this.inVoice
          ? 'disconnected'
          : (this.voiceReconnecting
              ? 'reconnecting'
              : ((this.voiceConnecting || this.voiceLeaseVerifying || !this.voiceRoom || !this.readyRooms.has(this.voiceRoom)
                  || !this.voiceMediaRoom || !this.readyRooms.has(this.voiceMediaRoom)
                  || !this.voiceMediaActivated.has(this.voiceMediaRoom) || this.voiceMediaChannelId !== this.currentVc)
                  ? 'connecting'
                  : 'connected')));
    return {
      connected: !!this.viewRoom, roomReady: this.roomReady, reconnecting: this.reconnecting,
      voiceQuality: this.inVoice ? this.connQuality : 'unknown', voicePing: this.inVoice ? this.pingMs : null,
      voiceConnection, lostVoiceServerId: this.lostVoiceServerId, lostVoiceChannel: this.lostVoiceChannel,
      inVoice: this.inVoice, voiceConnecting: this.inVoice && (this.voiceConnecting || this.voiceLeaseVerifying || this.voiceClaimPending !== 0), myVoiceChannel: this.currentVc, voiceServerId: this.voiceServerId, voiceChannels, channelActiveSince, deafened: this.deafened,
      localMicMuted: this.localMicMuted(), manualMicMuted: this.manualMute,
      micUnavailable: confirmedMicrophoneUnavailable(this.noMic, this.micBootstrapWanted),
      micRecovering: this.micRecoveryOwner !== 0 || this.micStartOwnership.active
        || (this.inVoice && this.noMic && this.micBootstrapWanted), pttDown: this.pttDown,
      presence, speaking, streams, watching, pending, watchers, messages: this.messages, chatHasMore: this.chatMore, chatTrimmed: this.trimmedFront, chatPrepended: this.chatPrepended,
      typing: [...this.typingUsers].filter(([n, exp]) => exp > Date.now() && n !== this.me.displayName).map(([n]) => n),
    };
  }

  private exactOutputRooms(): Room[] {
    return [...new Set([this.viewRoom, this.voiceRoom, this.voiceMediaRoom, this.pendingVoiceMediaRoom]
      .filter(Boolean) as Room[])];
  }
  private createOutputContext(): SinkableAudioContext | null {
    try {
      const context = new AudioContext() as SinkableAudioContext;
      seedAudioSinkTargetRoute(context);
      return context;
    }
    catch { return null; }
  }
  private outputMixerNeedsRecovery(): boolean {
    const context = this.outputCtx;
    if (!context) return false; // boolean webAudioMix lets LiveKit own its fallback context
    if (context.state === 'closed') return this.exactOutputRooms().length > 0;
    return this.exactOutputRooms().some((room) => exactWebAudioMixContext(room) !== context);
  }
  private failOutputContextRecovery(
    voiceEpoch: number,
    voiceRoom: Room | null,
    voiceChannel: string | null,
    outputOperation: NonNullable<VoiceDiagnosticEvent['outputOperation']>,
    code: NonNullable<VoiceDiagnosticEvent['code']>,
  ) {
    if (!voiceRoom || !voiceChannel || !this.voiceIntentCurrent(voiceEpoch, voiceRoom, voiceChannel)) return;
    this.recordVoiceOutputFailure(
      (getSettings().output || 'default') === 'default' ? 'default' : 'custom',
      code === 'timeout' ? 'timed_out' : code === 'unsupported' ? 'unsupported' : 'failed',
      'context_recovery', outputOperation, code,
    );
    this.hooks.toast('Не удалось восстановить вывод звука — голосовой канал отключён', 'err');
    void this.leaveVoice();
  }
  private triggerOutputContextRecovery(
    recovery: OutputContextRecovery,
    explicitGesture = false,
    gestureToken = 0,
  ) {
    if (document.hidden || this.outputRecovery !== recovery || this.outputCtx !== recovery.context) return;
    if (recovery.context.state !== 'running' && (explicitGesture || !recovery.ordinaryContextStarted)) {
      if (!explicitGesture) recovery.ordinaryContextStarted = true;
      requestExactAudioContextResume(recovery.context, explicitGesture);
    }
    for (const room of this.exactOutputRooms()) {
      // A room created during recovery must already inherit the exact fresh context. A different
      // live mixer is an SDK/runtime ownership change and cannot be overwritten opportunistically.
      if (exactWebAudioMixContext(room) !== recovery.context) continue;
      recovery.rooms.add(room);
      if (recovery.completedRooms.has(room)) continue;
      if (!explicitGesture) {
        if (recovery.ordinaryStartedRooms.has(room)) continue;
        recovery.ordinaryStartedRooms.add(room);
      }
      const outcome = this.startRoomAudio(room, explicitGesture, gestureToken);
      void outcome.then((ok) => {
        if (ok && this.outputRecovery === recovery && this.outputCtx === recovery.context)
          recovery.completedRooms.add(room);
      });
    }
  }
  private async finishOutputContextRecovery(recovery: OutputContextRecovery) {
    let lastVisibleAt = Date.now();
    while (this.outputRecovery === recovery && this.outputCtx === recovery.context
      && recovery.generation === this.outputRecoveryGeneration) {
      const now = Date.now();
      if (document.hidden) {
        lastVisibleAt = now;
      } else {
        recovery.remainingMs -= Math.max(0, now - lastVisibleAt);
        lastVisibleAt = now;
        // A pending exact media Room can be constructed just after recovery started. Enrol it in
        // the same owner instead of timing out because it was absent from the initial room set.
        this.triggerOutputContextRecovery(recovery);
        const liveRooms = this.exactOutputRooms();
        const allBound = liveRooms.every((room) => exactWebAudioMixContext(room) === recovery.context);
        const allStarted = liveRooms.every((room) => recovery.completedRooms.has(room));
        if (recovery.context.state === 'running' && allBound && allStarted) {
          this.outputRecovery = null;
          this.outputRecoveryRejectedFor = null;
          this.applyAllVolumes();
          this.applyAllStreamVolumes();
          this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
          void this.switchContextOutput(getSettings().output || 'default', false);
          return;
        }
        if (recovery.remainingMs <= 0) break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (this.outputRecovery !== recovery || this.outputCtx !== recovery.context
      || recovery.generation !== this.outputRecoveryGeneration) return;
    this.outputRecovery = null;
    // Rebind shape was valid; only playback missed its visible deadline. Do not permanently mark
    // the fresh context incompatible — a later explicit session may resume it, or replace it if it
    // subsequently reaches the terminal `closed` state.
    this.outputRecoveryRejectedFor = null;
    this.failOutputContextRecovery(
      recovery.voiceEpoch,
      recovery.voiceRoom,
      recovery.voiceChannel,
      recovery.context.state === 'running' ? 'start_audio' : 'resume',
      'timeout',
    );
  }
  private beginOutputContextRecovery(explicitGesture = false, gestureToken = 0): boolean {
    if (document.hidden) return false;
    const existing = this.outputRecovery;
    if (existing) {
      this.triggerOutputContextRecovery(existing, explicitGesture, gestureToken);
      return true;
    }
    const rooms = this.exactOutputRooms();
    const previous = this.outputCtx;
    if (!previous || !rooms.length || this.outputRecoveryRejectedFor === previous) return false;
    const replacement = previous.state === 'closed' ? this.createOutputContext() : previous;
    if (!replacement) {
      this.outputRecoveryRejectedFor = previous;
      this.failOutputContextRecovery(
        this.voiceEpoch, this.voiceRoom, this.currentVc, 'create_context', 'unsupported',
      );
      return false;
    }
    if (!rebindExactWebAudioMixContexts(rooms, replacement)) {
      if (replacement !== previous) {
        forgetExactAudioContextResume(replacement);
        try { void replacement.close(); } catch { /**/ }
      }
      this.outputRecoveryRejectedFor = previous;
      this.failOutputContextRecovery(this.voiceEpoch, this.voiceRoom, this.currentVc, 'rebind', 'sdk');
      return false;
    }
    if (replacement !== previous) {
      forgetExactAudioContextResume(previous);
      this.outputCtx = replacement;
      this.outputSwitch = Promise.resolve();
      this.outputGeneration++;
    }
    this.outputRecoveryRejectedFor = null;
    const recovery: OutputContextRecovery = {
      generation: ++this.outputRecoveryGeneration,
      context: replacement,
      rooms: new Set(rooms),
      completedRooms: new Set(),
      ordinaryStartedRooms: new Set(),
      ordinaryContextStarted: false,
      remainingMs: OUTPUT_CONTEXT_RECOVERY_TIMEOUT_MS,
      voiceEpoch: this.voiceEpoch,
      voiceRoom: this.voiceRoom,
      voiceChannel: this.currentVc,
    };
    this.outputRecovery = recovery;
    for (const room of rooms) this.remoteAudioStarts.forget(room);
    [...this.voiceAudioEls.values(), ...this.screenAudioEls.values()].forEach(({ el }) => this.remoteAudioPlays.forget(el));
    this.triggerOutputContextRecovery(recovery, explicitGesture, gestureToken);
    void this.finishOutputContextRecovery(recovery);
    return true;
  }
  private getOutputContext(): SinkableAudioContext | null {
    if (this.outputCtx && this.outputCtx.state !== 'closed') return this.outputCtx;
    if (this.outputCtx && this.exactOutputRooms().length) {
      this.beginOutputContextRecovery();
      return this.outputCtx.state === 'closed' ? null : this.outputCtx;
    }
    // A Room created while the shared AudioContext constructor failed owns LiveKit's private
    // fallback (`webAudioMix: true`). Creating a different shared context beside it would split
    // playback ownership and cannot be rebound safely. Keep the audible SDK fallback until those
    // Rooms drain; the next connection may retry shared context construction from a user gesture.
    if (!this.outputCtx && this.exactOutputRooms().some((room) => room.options.webAudioMix === true)) return null;
    forgetExactAudioContextResume(this.outputCtx);
    this.outputCtx = this.createOutputContext();
    this.outputRecoveryRejectedFor = null;
    return this.outputCtx;
  }
  private async normalizedContextSink(requested: string): Promise<string> {
    if (requested !== 'default') return requested;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      const defaultDevice = devices.find((d) => d.deviceId === 'default');
      return devices.find((d) => d.deviceId !== 'default' && !!defaultDevice?.groupId && d.groupId === defaultDevice.groupId)?.deviceId || '';
    } catch { return ''; }
  }
  private queueContextOutput(
    requested: string,
    force = false,
    onFailure?: (failure: AudioSinkRouteFailure) => void,
  ): Promise<AudioSinkRouteOutcome> {
    const ctx = this.getOutputContext();
    const run = this.outputSwitch.catch(() => {}).then(async (): Promise<AudioSinkRouteOutcome> => {
      if (!ctx) {
        if (requested !== 'default') onFailure?.({ operation: 'set_sink', outcome: 'unsupported', code: 'unsupported' });
        return 'unsupported';
      }
      return routeAudioSinkTarget(ctx, requested, {
        normalize: (sink) => this.normalizedContextSink(sink),
        force,
        onFailure,
      });
    });
    // Keep the queue usable after a rejected hardware switch while returning its fixed outcome to
    // the caller. Browser exceptions are reduced inside routeAudioSinkTarget and never escape.
    this.outputSwitch = run.then(() => {}, () => {});
    return run;
  }
  private async switchContextOutput(
    requested: string,
    notifyOnFallback = true,
    force = false,
  ): Promise<string | null> {
    const generation = ++this.outputGeneration;
    let contextFailure: AudioSinkRouteFailure | undefined;
    let treeFailure: AudioSinkRouteFailure | undefined;
    // Tree playback owns a separate exact element/shared-context route. Both routes are bounded,
    // and Settings is committed only when every currently audible path reached the same device.
    const [treeResult, contextResult] = await Promise.allSettled([
      setTreeStreamOutputSink(requested, {
        force,
        onFailure: (failure) => { treeFailure ??= failure; },
      }),
      this.queueContextOutput(requested, force, (failure) => { contextFailure ??= failure; }),
    ]);
    if (generation !== this.outputGeneration || (getSettings().output || 'default') !== requested) return null;
    const contextOutcome: AudioSinkRouteOutcome = contextResult.status === 'fulfilled'
      ? contextResult.value
      : 'failed';
    const treeOutcome: AudioSinkRouteOutcome = treeResult.status === 'fulfilled'
      ? treeResult.value
      : 'failed';
    const contextFailed = contextOutcome === 'failed' || contextOutcome === 'timed-out'
      || (contextOutcome === 'unsupported' && requested !== 'default');
    const treeFailed = treeOutcome === 'failed' || treeOutcome === 'timed-out'
      || (treeOutcome === 'unsupported' && requested !== 'default');
    if (audioSinkRoutesConfirmed(requested, [contextOutcome, treeOutcome])) return requested;
    // A nested router may already belong to a newer exact target operation. It is neither a
    // confirmed route nor a hardware failure attributable to this request; leave the cache empty
    // so ordinary reconciliation can retry without emitting a false incident.
    if (contextOutcome === 'superseded' || treeOutcome === 'superseded') return null;

    // Never let a failed A overwrite a newer B. This check occurs before enqueueing the fallback;
    // if B starts just afterwards, its exact generation is queued after default and still wins.
    const failedOutcome = contextFailed ? contextOutcome : treeOutcome;
    const failure = contextFailed ? contextFailure : treeFailure;
    this.recordVoiceOutputFailure(
      requested === 'default' ? 'default' : 'custom',
      failedOutcome === 'timed-out' ? 'timed_out'
        : failedOutcome === 'unsupported' ? 'unsupported' : 'failed',
      contextFailed ? 'voice_mixer' : 'stream_mixer',
      failure?.operation ?? 'set_sink',
      failure?.code ?? (failedOutcome === 'timed-out' ? 'timeout'
        : failedOutcome === 'unsupported' ? 'unsupported' : 'unknown'),
      requested === 'default',
    );
    if (requested === 'default') return null;
    let fallbackContextFailure: AudioSinkRouteFailure | undefined;
    let fallbackTreeFailure: AudioSinkRouteFailure | undefined;
    const [fallbackContextResult, fallbackTreeResult] = await Promise.allSettled([
      this.queueContextOutput('default', false, (current) => { fallbackContextFailure ??= current; }),
      setTreeStreamOutputSink('default', {
        onFailure: (current) => { fallbackTreeFailure ??= current; },
      }),
    ]);
    if (generation !== this.outputGeneration || (getSettings().output || 'default') !== requested) {
      this.submitVoiceDiagnostic('output_route_failed');
      return null;
    }
    const fallbackContextOutcome: AudioSinkRouteOutcome = fallbackContextResult.status === 'fulfilled'
      ? fallbackContextResult.value
      : 'failed';
    const fallbackTreeOutcome: AudioSinkRouteOutcome = fallbackTreeResult.status === 'fulfilled'
      ? fallbackTreeResult.value
      : 'failed';
    if (fallbackContextOutcome === 'superseded' || fallbackTreeOutcome === 'superseded') {
      this.submitVoiceDiagnostic('output_route_failed');
      return null;
    }
    if (!audioSinkRoutesConfirmed('default', [fallbackContextOutcome, fallbackTreeOutcome])) {
      const contextFallbackFailed = fallbackContextOutcome !== 'applied'
        && fallbackContextOutcome !== 'unsupported';
      const fallbackOutcome = contextFallbackFailed ? fallbackContextOutcome : fallbackTreeOutcome;
      const fallbackFailure = contextFallbackFailed ? fallbackContextFailure : fallbackTreeFailure;
      this.recordVoiceOutputFailure(
        'default',
        fallbackOutcome === 'timed-out' ? 'timed_out'
          : fallbackOutcome === 'unsupported' ? 'unsupported' : 'failed',
        contextFallbackFailed ? 'voice_mixer' : 'stream_mixer',
        fallbackFailure?.operation ?? 'set_sink',
        fallbackFailure?.code ?? (fallbackOutcome === 'timed-out' ? 'timeout' : 'unknown'),
      );
      return null;
    }
    // A newer A -> B selection may already be queued. Only the still-current failed selection is
    // allowed to rewrite settings or show a warning.
    this.submitVoiceDiagnostic('output_route_failed');
    setSettings({ output: '' });
    if (notifyOnFallback) this.hooks.toast('Устройство вывода недоступно — включено системное', 'warn');
    return 'default';
  }
  private async switchElementOutput(
    el: HTMLMediaElement,
    requested: string,
    retry = false,
    force = false,
  ): Promise<void> {
    // Two watchdogs reconcile voice concurrently. Coalesce their identical route request before it
    // reaches the promise queue; a slow/hung CoreAudio setSinkId must never accumulate per peer.
    if (!this.elementOutputRoutes.claim(el, requested, retry || force)) return;
    const generation = (this.elementOutputGenerations.get(el) || 0) + 1;
    this.elementOutputGenerations.set(el, generation);
    const previous = this.elementOutputSwitches.get(el) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (this.elementOutputGenerations.get(el) !== generation) return;
      let failure: AudioSinkRouteFailure | undefined;
      const outcome = await routeAudioSinkTarget(el, requested, {
        force,
        onFailure: (current) => { failure ??= current; },
      });
      // A newer Settings selection is queued behind this exact element owner, so the shared sink
      // router cannot observe that successor until this run releases the outer queue. Fence the
      // stale result here before it can create a false incident for the already-abandoned route.
      if (this.elementOutputGenerations.get(el) !== generation) return;
      if (audioSinkRoutesConfirmed(requested, [outcome]) || outcome === 'superseded') return;
      this.recordVoiceOutputFailure(
        requested === 'default' ? 'default' : 'custom',
        outcome === 'timed-out' ? 'timed_out' : outcome === 'unsupported' ? 'unsupported' : 'failed',
        'media_element', failure?.operation ?? 'set_sink', failure?.code
          ?? (outcome === 'timed-out' ? 'timeout' : outcome === 'unsupported' ? 'unsupported' : 'unknown'),
        requested === 'default',
      );
      // Per-element serialization makes the fallback finish before any newer selection; a
      // superseded request skips fallback entirely. Thus an old Bluetooth failure cannot win.
      if (this.elementOutputGenerations.get(el) !== generation || requested === 'default') {
        if (requested !== 'default') this.submitVoiceDiagnostic('output_route_failed');
        return;
      }
      let fallbackFailure: AudioSinkRouteFailure | undefined;
      const fallbackOutcome = await routeAudioSinkTarget(el, 'default', {
        onFailure: (current) => { fallbackFailure ??= current; },
      });
      if (this.elementOutputGenerations.get(el) !== generation
        || audioSinkRoutesConfirmed('default', [fallbackOutcome])
        || fallbackOutcome === 'superseded') {
        this.submitVoiceDiagnostic('output_route_failed');
        return;
      }
      this.recordVoiceOutputFailure(
        'default',
        fallbackOutcome === 'timed-out' ? 'timed_out' : 'failed',
        'media_element', fallbackFailure?.operation ?? 'set_sink', fallbackFailure?.code
          ?? (fallbackOutcome === 'timed-out' ? 'timeout' : 'unknown'),
      );
    });
    this.elementOutputSwitches.set(el, run.catch(() => {}));
    await run;
  }
  private forgetElementOutput(el: HTMLMediaElement) {
    this.elementOutputRoutes.forget(el);
    this.elementOutputGenerations.set(el, (this.elementOutputGenerations.get(el) || 0) + 1);
    this.elementOutputSwitches.delete(el);
  }

  /* ---------- connection ---------- */
  async connect(url: string, token: string, serverId: string, sessionId: string) {
    // exitServer() performs a full disconnect but intentionally keeps this Engine instance for
    // the next server. Restore mobile route/playback listeners before creating the new room.
    this.engineLifecycleActive = true;
    this.streamDiagnosticOutbox.start();
    this.ensureOutputLifecycleListeners();
    this.retryPendingVoiceDiagnostic();
    this.ensureInputLifecycleListener();
    this.ensureIdleWatch();
    this.ensureGameSettingsWatch();
    const connectEpoch = ++this.connectEpoch;
    this.resetStreamEdges();
    const outputCtx = this.getOutputContext();
    const r = new Room({
      adaptiveStream: true, dynacast: true,
      // LiveKit defaults this to true and treats pagehide/freeze as a terminal leave. Installed
      // iOS PWAs emit those events on ordinary backgrounding, so the SDK disconnected both hub and
      // voice before our foreground microphone recovery could run. Engine owns explicit logout,
      // server-exit and teardown; the browser still closes sockets naturally on a genuine unload.
      disconnectOnPageLeave: false,
      // UI разрешает индивидуальное усиление до 200%. Без WebAudio mixer LiveKit пишет это
      // в HTMLMediaElement.volume (диапазон только 0..1), получает IndexSizeError и может оставить 0.
      webAudioMix: outputCtx ? { audioContext: outputCtx } : true,
      publishDefaults: { dtx: true, red: true, forceStereo: false, simulcast: true, audioPreset: AudioPresets.music },
    });
    if (sessionId) this.roomSessions.set(r, sessionId);
    void this.switchContextOutput(getSettings().output || 'default');
    // connect поднимает ТОЛЬКО viewRoom (смотрю сервер). voiceRoom НЕ трогаем — им владеют join/leaveVoice:
    // при входе в голос voiceRoom:=viewRoom (реюз), при уходе на другой сервер голосовая комната остаётся.
    this.viewRoom = r;
    this.viewServerId = serverId;
    this.hooks.chatConnectionChanged?.();
    this.roomReady = false;
    this.liveKitT.attach(r, { me: this.me.username, serverId });
    this.treeT.attach(r, { me: this.me.username, serverId });
    // Хендлеры ветвятся по РОЛИ комнаты r: voice-работа при r===voiceRoom, view-работа при r===viewRoom.
    // Пока комнаты равны (4a) — обе ветви истинны, как раньше. При расцепе (4c) событие voice-only комнаты
    // A не запустит view-логику (чат/presence), а view-only комнаты B — voice-логику (mic/vc/vclaim).
    r.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSub(track, pub, p, r))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.onUnsub(track, pub, p, r))
      // reconcileChannelSounds на подключении участника: пир, приехавший УЖЕ с vc-атрибутом (зашёл в
      // голосовой на другом сервере/вкладке и только потом подключился к комнате), не даёт события
      // ParticipantAttributesChanged — его вход раньше озвучивался только 3-секундным таймером, а в
      // фоновой вкладке таймер троттлится, и «кто-то зашёл» было слышно с большой задержкой или никогда.
      .on(RoomEvent.ParticipantConnected, (p) => { const u = baseUid(p.identity); if (r === this.voiceRoom) { this.observeVoiceSession(p); this.reconcileUserAudio(u); this.reconcileChannelSounds(); } if (r === this.viewRoom) { if (u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.hooks.toast((p.name || u) + ' в сети', 'ok'); this.hooks.peerJoined(u); } this.emit(); })
      // u !== this.me.username — иначе отключение СВОЕЙ же зомби-сессии (неудачный первый коннект,
      // сеть/деплой) чистит АНАЛИЗАТОР ТЕКУЩЕЙ живой сессии (detachAnalyser(me) внутри cleanupPeer):
      // полоска чувствительности замирает, гейт «активация голосом» может замереть закрытым — мик
      // «пропадает» без видимой причины, лечится только перезаходом в канал. См. ParticipantConnected
      // строкой выше — та же защита у него уже была, тут её не хватало.
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        const u = baseUid(p.identity);
        // Monotonic tombstone сохраняем: если после handoff новая сессия ушла, старая с меньшим
        // epoch не должна снова стать активной только потому, что всё ещё висит participant'ом.
        if (r === this.viewRoom && u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.cleanupPeer(u);
        if (r === this.voiceRoom) { this.reconcileUserAudio(u); this.reconcileChannelSounds(); }
        this.emit();
      })
      .on(RoomEvent.Reconnecting, () => {
        if (r !== this.viewRoom && r !== this.voiceRoom) return;
        this.reconnectingRooms.add(r);
        this.reconnecting = this.reconnectingRooms.size > 0;
        // До серверной проверки lease держим uplink в тишине: старый ПК не должен успеть заговорить
        // после reconnect, если во время offline телефон уже стал owner.
        if (r === this.voiceRoom && this.inVoice) {
          this.beginVoiceReconnectRecovery(r, this.voiceEpoch);
          ++this.voiceTransportDisruptionSeq;
          this.voiceReconnecting = true;
          this.recordVoiceReconnecting();
          // Reconnect always requires a fresh PTT press; a held key must not resume after a gap.
          this.clearPttOwnership();
          // join/switch owns lease + media + attributes as one transaction. Starting a second
          // verifier here can consume/rewrite that transaction's state; its final boundary observes
          // voiceTransportDisruptionSeq and performs the exact bounded verification itself.
          ++this.voiceLeaseVerifySeq;
          if (!this.voiceConnecting && this.voiceClaimPending === 0) this.voiceLeaseVerifying = true;
          this.applyGate();
        }
        this.hooks.toast('Связь потеряна — переподключаюсь…', 'warn'); this.emit();
      })
      .on(RoomEvent.Reconnected, () => {
        if (r !== this.viewRoom && r !== this.voiceRoom) return;
        this.reconnectingRooms.delete(r);
        this.reconnecting = this.reconnectingRooms.size > 0;
        if (r === this.voiceRoom) this.voiceReconnecting = !!this.voiceMediaRoom && this.reconnectingRooms.has(this.voiceMediaRoom);
        // Reconnect восстанавливает ТЕКУЩИЙ intent, но не делает новый vclaim: старый ПК, который был
        // offline во время handoff на телефон, не имеет права самовольно отобрать голос обратно.
        if (r === this.voiceRoom && this.inVoice && this.currentVc) {
          this.recordVoiceReconnected();
          const reconnectDeadline = this.beginVoiceReconnectRecovery(r, this.voiceEpoch);
          if (!this.voiceConnecting && this.voiceClaimPending === 0) {
            this.voiceLeaseVerifying = true;
            const verifySeq = ++this.voiceLeaseVerifySeq;
            this.applyGate();
            void this.verifyVoiceLeaseAfterReconnect(r, this.voiceEpoch, verifySeq, undefined, reconnectDeadline);
          }
        }
        // viewRoom-реконнект: ре-энумерация чужих стримов (появившийся во время обрыва не прошёл бы через
        // onStreamStart — нет живого TrackPublished) + догрузка чата, пришедшего во время обрыва.
        if (r === this.viewRoom) {
          this.liveKitT.onRoomConnected(); this.hooks.refetchChat?.();
          // A channel tap made while the mobile radio was reconnecting remains an explicit user
          // intent. Consume it only after this exact transport has left the reconnecting set.
          this.flushPendingVoiceJoin(r, serverId);
        }
        this.hooks.toast('Связь восстановлена', 'ok'); this.emit();
      })
      .on(RoomEvent.Disconnected, () => this.handleRoomDisconnected(r, serverId))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (r === this.viewRoom || r === this.voiceRoom) this.ensureRemoteAudioPlayback();
      })
      // пир сменил vc → пере-подписка на его микрофон, только в voiceRoom (в viewRoom чужого сервера
      // микрофоны не слушаю). Дисплей ростера обновляет emit() (build читает vc из соответствующей комнаты).
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => { if (p !== r.localParticipant && r === this.voiceRoom) { this.observeVoiceSession(p); this.reconcileUserAudio(baseUid(p.identity)); this.reconcileChannelSounds(); } this.emit(); })
      .on(RoomEvent.DataReceived, (payload, participant) => this.onData(payload, r, participant));
    try { await r.connect(url, token, { autoSubscribe: false }); }
    catch (error) {
      if (this.viewRoom === r) this.roomReady = false;
      if (this.voiceRoom !== r) this.disconnectRoom(r);
      throw error;
    }
    this.readyRooms.add(r);
    const isVoice = this.voiceRoom === r;
    const isView = this.viewRoom === r && this.viewServerId === serverId && (connectEpoch === this.connectEpoch || isVoice);
    if (!isView && !isVoice) { this.disconnectRoom(r); return; }
    if (isView) this.roomReady = true; // только ТЕКУЩАЯ смотримая комната снимает skeleton
    // Hub bootstraps ownership/roster only. Microphone publications live in voiceMediaRoom.
    if (isVoice) r.remoteParticipants.forEach((p) => this.observeVoiceSession(p));
    if (isView) { this.liveKitT.onRoomConnected(); this.treeT.onRoomConnected(); }
    if (isView) this.flushPendingVoiceJoin(r, serverId);
    // ОДИН engine-таймер на оба соединения (методы внутри бьют в нужную комнату: announceWatch/reconcile/
    // selfHeal сами выбирают view/voice). connect зовётся на каждую смену смотримого сервера → чистим
    // прежний, чтобы не плодить таймеры при браузинге в голосе. self-heal vc/подписок — см. selfHealVc.
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = window.setInterval(() => { this.announceWatch(); this.cleanupWatchers(); if (this.inVoice) { this.reconcileAllAudio(); this.reconcileChannelSounds(); } this.selfHealVc(); }, 3000);
    // Детект игры (натив): один физический IPC + один latest rerun, даже если invoke завис.
    if (isTauri) this.startGamePolling();
    this.emit();
  }
  private createVoiceMediaRoom(): Room {
    const outputCtx = this.getOutputContext();
    return new Room({
      adaptiveStream: true,
      dynacast: false,
      // Keep the exact channel transport through iOS PWA pagehide/freeze. Capture itself may be
      // suspended by WebKit and is fail-closed/reacquired on foreground by Engine lifecycle guards.
      disconnectOnPageLeave: false,
      webAudioMix: outputCtx ? { audioContext: outputCtx } : true,
      // Engine owns the processed microphone pipeline. Server-side lease eviction during a
      // channel handoff must not stop its MediaStreamTrack before it can be republished.
      stopLocalTrackOnUnpublish: false,
      publishDefaults: { dtx: true, red: true, forceStereo: false, simulcast: false, audioPreset: AudioPresets.music },
    });
  }
  private mediaPermissionsActive(room: Room): boolean {
    const permissions = room.localParticipant.permissions;
    return permissions?.canPublish === true && permissions?.canSubscribe === true;
  }
  private waitVoiceMediaPermissions(room: Room, current: () => boolean, timeoutMs = 5000): Promise<boolean> {
    if (this.mediaPermissionsActive(room)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearInterval(poll);
        window.clearTimeout(timeout);
        room.off(RoomEvent.ParticipantPermissionsChanged, changed);
        resolve(ok);
      };
      const changed = () => {
        if (!current()) finish(false);
        else if (this.mediaPermissionsActive(room)) finish(true);
      };
      room.on(RoomEvent.ParticipantPermissionsChanged, changed);
      const poll = window.setInterval(changed, 50);
      const timeout = window.setTimeout(() => finish(false), timeoutMs);
      changed();
    });
  }
  private beginVoicePermissionRecovery(room: Room, voiceEpoch: number, deadline = Date.now() + 20_000): number {
    const existing = this.voicePermissionRecovery;
    if (existing && existing.room === room && existing.voiceEpoch === voiceEpoch) return existing.deadline;
    this.clearVoicePermissionRecovery();
    const recovery = { room, voiceEpoch, deadline, timer: 0 };
    this.voicePermissionRecovery = recovery;
    recovery.timer = window.setTimeout(() => {
      if (this.voicePermissionRecovery !== recovery) return;
      this.voicePermissionRecovery = null;
      // The timer is independent from LiveKit reconnect events and verifier generations. Even if
      // either room reconnects and replaces verifySeq, revoked permissions cannot stay pending.
      if ((this.voiceMediaRoom === room || this.pendingVoiceMediaRoom === room)
        && this.voiceEpoch === voiceEpoch && this.inVoice) {
        this.recordVoiceDiagnostic({
          kind: 'disconnected', stage: 'activation', outcome: 'timed_out', code: 'auth',
          ...this.voiceDiagnosticState(),
        });
        this.submitVoiceDiagnostic('connection_failed');
        void this.leaveVoice();
      }
    }, Math.max(0, recovery.deadline - Date.now()));
    return recovery.deadline;
  }
  private clearVoicePermissionRecovery(room?: Room, voiceEpoch?: number) {
    const recovery = this.voicePermissionRecovery;
    if (!recovery || (room && recovery.room !== room) || (voiceEpoch != null && recovery.voiceEpoch !== voiceEpoch)) return;
    window.clearTimeout(recovery.timer);
    this.voicePermissionRecovery = null;
  }
  private beginVoiceReconnectRecovery(
    hub: Room,
    voiceEpoch: number,
    deadline = Date.now() + VOICE_RECONNECT_VERIFY_TIMEOUT_MS,
  ): number {
    const existing = this.voiceReconnectRecovery;
    if (existing && existing.hub === hub && existing.voiceEpoch === voiceEpoch) return existing.deadline;
    this.clearVoiceReconnectRecovery();
    const recovery = { hub, voiceEpoch, deadline, timer: 0 };
    this.voiceReconnectRecovery = recovery;
    recovery.timer = window.setTimeout(() => {
      if (this.voiceReconnectRecovery !== recovery) return;
      this.voiceReconnectRecovery = null;
      if (this.voiceIntentCurrent(voiceEpoch, hub)) {
        this.recordVoiceDiagnostic({
          kind: 'disconnected', outcome: 'timed_out', code: 'timeout',
          reconnectCount: this.voiceDiagnosticReconnectTimes.length, ...this.voiceDiagnosticState(),
        });
        this.submitVoiceDiagnostic('connection_failed');
        void this.leaveVoice();
      }
    }, Math.max(0, deadline - Date.now()));
    return deadline;
  }
  private clearVoiceReconnectRecovery(hub?: Room, voiceEpoch?: number) {
    const recovery = this.voiceReconnectRecovery;
    if (!recovery || (hub && recovery.hub !== hub) || (voiceEpoch != null && recovery.voiceEpoch !== voiceEpoch)) return;
    window.clearTimeout(recovery.timer);
    this.voiceReconnectRecovery = null;
  }
  private wireVoiceMediaRoom(room: Room, serverId: string, channelId: string) {
    room.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSub(track, pub, p, room))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.onUnsub(track, pub, p, room))
      .on(RoomEvent.ParticipantConnected, (p) => {
        if (room === this.voiceMediaRoom && this.voiceMediaChannelId === channelId) this.reconcileUserAudio(baseUid(p.identity));
        this.emit();
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.clearSubscriptionRetries(p.identity, undefined, room);
        this.removeVoiceAudio(baseUid(p.identity), p.identity, undefined, room);
        if (room === this.voiceMediaRoom && this.voiceMediaChannelId === channelId) this.reconcileUserAudio(baseUid(p.identity));
        this.emit();
      })
      // Transport mute/unmute is not necessarily a user action: iOS emits it when a PWA is
      // backgrounded and LiveKit may emit it again while pausing/resuming the sender. Sounds are
      // owned by toggleMic/toggleDeaf so an OS interruption cannot impersonate a manual click.
      .on(RoomEvent.TrackMuted, () => this.emit())
      .on(RoomEvent.TrackUnmuted, () => this.emit())
      .on(RoomEvent.Reconnecting, () => {
        const rollbackBaseline = room === this.voiceMediaRoom && this.voiceMediaChannelId === channelId
          && this.voiceConnecting && this.inVoice;
        const ownsCurrentIntent = rollbackBaseline || ((room === this.voiceMediaRoom || room === this.pendingVoiceMediaRoom)
          && this.currentVc === channelId && this.inVoice);
        if (!ownsCurrentIntent) return;
        if (this.voiceRoom) this.beginVoiceReconnectRecovery(this.voiceRoom, this.voiceEpoch);
        ++this.voiceTransportDisruptionSeq;
        this.voiceMediaActivated.delete(room);
        this.reconnectingRooms.add(room); this.reconnecting = true;
        this.voiceReconnecting = true; this.clearPttOwnership();
        this.recordVoiceReconnecting();
        ++this.voiceLeaseVerifySeq;
        if (!this.voiceConnecting && this.voiceClaimPending === 0) this.voiceLeaseVerifying = true;
        this.applyGate();
        this.hooks.toast('Голосовая связь потеряна — переподключаюсь…', 'warn'); this.emit();
      })
      .on(RoomEvent.Reconnected, () => {
        this.reconnectingRooms.delete(room); this.reconnecting = this.reconnectingRooms.size > 0;
        const rollbackBaseline = room === this.voiceMediaRoom && this.voiceMediaChannelId === channelId
          && this.voiceConnecting && this.inVoice;
        const ownsCurrentIntent = rollbackBaseline || ((room === this.voiceMediaRoom || room === this.pendingVoiceMediaRoom)
          && this.currentVc === channelId && this.inVoice);
        if (!ownsCurrentIntent || !this.voiceRoom) return;
        const reconnectDeadline = this.beginVoiceReconnectRecovery(this.voiceRoom, this.voiceEpoch);
        this.clearPttOwnership();
        this.voiceReconnecting = !!this.voiceRoom && this.reconnectingRooms.has(this.voiceRoom);
        this.recordVoiceReconnected();
        if (!this.voiceConnecting && this.voiceClaimPending === 0 && room === this.voiceMediaRoom) {
          this.voiceLeaseVerifying = true;
          const verifySeq = ++this.voiceLeaseVerifySeq;
          this.applyGate();
          void this.verifyVoiceLeaseAfterReconnect(this.voiceRoom, this.voiceEpoch, verifySeq, room, reconnectDeadline);
        }
        this.emit();
      })
      .on(RoomEvent.Disconnected, () => this.handleVoiceMediaDisconnected(room, serverId, channelId))
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
        if (room === this.voiceMediaRoom && p === room.localParticipant) { this.connQuality = mapQuality(q); this.emit(); }
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (room === this.voiceMediaRoom) { this.ensureRemoteAudioPlayback(); this.ensureVoiceAudioRunning(); }
      })
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (room === this.voiceMediaRoom) this.onRemotePub(pub, p, room);
      })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        this.clearSubscriptionRetries(p.identity, (pub as any).trackSid || (pub as any).sid, room);
        if (room === this.voiceMediaRoom) this.onRemoteUnpub(pub, p, room);
      })
      .on(RoomEvent.TrackSubscriptionFailed, (trackSid, p) => {
        if (room !== this.voiceMediaRoom) return;
        const key = `${this.voiceMediaRoomKey(room)}\n${p.identity}:${trackSid}`;
        const retry = this.subscriptionRetries.get(key) || { attempts: 0, nextAt: 0 };
        retry.nextAt = 0; this.subscriptionRetries.set(key, retry);
        this.reconcilePeerAudio(p, room);
      })
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
        if (room === this.voiceMediaRoom && p !== room.localParticipant) this.reconcileUserAudio(baseUid(p.identity));
        this.emit();
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_previous, p) => {
        const rollbackBaseline = room === this.voiceMediaRoom && this.voiceMediaChannelId === channelId
          && this.voiceConnecting && this.inVoice;
        const ownsCurrentIntent = rollbackBaseline || ((room === this.voiceMediaRoom || room === this.pendingVoiceMediaRoom)
          && this.currentVc === channelId && this.inVoice);
        if (p !== room.localParticipant || !ownsCurrentIntent || this.mediaPermissionsActive(room)) return;
        const exactCurrentChannel = this.currentVc === channelId;
        const hub = this.voiceRoom;
        ++this.voiceTransportDisruptionSeq;
        this.voiceMediaActivated.delete(room);
        this.clearPttOwnership();
        ++this.voiceLeaseVerifySeq;
        const deadline = this.beginVoicePermissionRecovery(room, this.voiceEpoch);
        // Permission revocation is authoritative and must fail closed before any HTTP recovery:
        // stop receiving immediately and discard already attached audio from the revoked room.
        this.subscriptionRetries.clear();
        this.reconcileAllAudio();
        this.clearVoiceAudio();
        this.applyGate();
        this.emit();
        // During A -> B the active pointer still references room A while currentVc already carries
        // B. Keep A fail-closed and retain its absolute deadline, but do not run an A verifier against
        // B intent. Ticket rollback below will resume exact-A verification; successful switch clears it.
        if (!exactCurrentChannel) return;
        if (!hub) { void this.leaveVoice(); return; }
        if (this.voiceConnecting || this.voiceClaimPending !== 0 || room === this.pendingVoiceMediaRoom) return;
        // A current lease is re-activated; a stale lease exits. Unlike ordinary network reconnect,
        // permission recovery is bounded so a revoked participant cannot remain verifying forever.
        this.voiceLeaseVerifying = true;
        const verifySeq = ++this.voiceLeaseVerifySeq;
        void this.verifyVoiceLeaseAfterReconnect(hub, this.voiceEpoch, verifySeq, room, deadline);
      });
  }
  private async activateVoiceMediaRoom(
    room: Room,
    hub: Room,
    voiceEpoch: number,
    serverId: string,
    channelId: string,
    operationDeadline = Date.now() + VOICE_JOIN_TIMEOUT_MS,
    onTerminalFailure?: (reason: VoiceMediaConnectFailure) => void,
  ): Promise<boolean> {
    const session = this.sessionId(hub);
    const leaseEpoch = this.voiceLeaseEpoch;
    if (!session || leaseEpoch < 1 || !this.voiceIntentCurrent(voiceEpoch, hub, channelId)) return false;
    const current = () => this.voiceIntentCurrent(voiceEpoch, hub, channelId)
      && (this.pendingVoiceMediaRoom === room || this.voiceMediaRoom === room);
    // The transaction already owns one absolute join/reconnect deadline. A previous exact media
    // identity can be in durable revocation backoff, so a second, shorter activation ceiling would
    // deterministically expire before the server's due retry. Individual HTTP calls and permission
    // propagation remain bounded below; this loop may use only the transaction's remaining budget.
    const deadline = operationDeadline;
    let attempt = 0;
    // A previous lease participant is removed durably. During a rapid switch/takeover the server
    // can reject activation while that removal is still closing; the join-only grant keeps this
    // room fail-closed, so bounded retry is safe and avoids forcing an unnecessary leave.
    while (current() && Date.now() < deadline) {
      let serverRetryAfterSeconds: number | undefined;
      try {
        const activated = await withVoiceDeadline(
          api.activateVoiceMedia(session, serverId, channelId, leaseEpoch),
          Math.min(deadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
          'voice media activation',
        );
        if (!current()) return false;
        if (activated.room !== room.name || activated.epoch !== leaseEpoch) {
          this.recordVoiceDiagnostic({
            kind: 'media_activated', stage: 'activation', outcome: 'failed', code: 'sdk',
            joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
          });
          return false;
        }
        const permissionBudget = Math.min(2_000, Math.max(0, deadline - Date.now()));
        if (permissionBudget > 0 && await this.waitVoiceMediaPermissions(room, current, permissionBudget)) {
          if (!current()) return false;
          this.voiceMediaActivated.add(room);
          return true;
        }
        if (!current()) return false;
        this.recordVoiceDiagnostic({
          kind: 'media_activated', stage: 'activation', outcome: 'timed_out', code: 'timeout',
          joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
        });
      } catch (error) {
        if (!current()) return false;
        const sessionClosing = isApiError(error) && error.status === 409
          && Number.isFinite(error.retryAfter);
        const failureDisposition = isApiError(error)
          ? voiceActivationHttpFailureDisposition(error.status)
          : 'retry';
        // A finite server retry hint is the protocol-level proof that an exact previous media
        // identity is still closing. Keep ordinary 409 responses generic: neither raw error text
        // nor message matching is safe enough to promote them to this diagnostic category.
        const classified = sessionClosing
          ? { code: 'session_closing' as const, httpStatus: 409 }
          : classifyVoiceDiagnosticError(error);
        this.recordVoiceDiagnostic({
          kind: 'media_activated', stage: 'activation', outcome: 'failed', ...classified,
          joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
        });
        // req() already performed its single access-session refresh before exposing a 401 here.
        // Retrying malformed/unauthorized/forbidden requests only extends a guaranteed failure to
        // the full join deadline. A missing route/method is likewise fixed for this server version,
        // but preserves the rollout-specific user explanation without matching response text.
        if (failureDisposition === 'server-updating') {
          onTerminalFailure?.('server-updating');
          return false;
        }
        if (failureDisposition === 'terminal') {
          onTerminalFailure?.('activation');
          return false;
        }
        if (sessionClosing)
          serverRetryAfterSeconds = Math.max(0, error.retryAfter!);
      }
      if (!current()) return false;
      const normalBackoff = Math.min(1_500, 200 * (2 ** Math.min(attempt++, 3)));
      const delay = boundedVoiceActivationRetryDelayMs(
        normalBackoff,
        deadline - Date.now(),
        serverRetryAfterSeconds,
      );
      if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    return false;
  }
  private async connectVoiceMediaRoom(
    hub: Room,
    voiceEpoch: number,
    serverId: string,
    channelId: string,
    operationDeadline = Date.now() + VOICE_JOIN_TIMEOUT_MS,
  ): Promise<Room | null> {
    const session = this.sessionId(hub);
    const leaseEpoch = this.voiceLeaseEpoch;
    if (!session || leaseEpoch < 1 || !this.voiceIntentCurrent(voiceEpoch, hub, channelId)) return null;
    this.voiceMediaConnectFailure = null;
    const rememberFailure = (reason: VoiceMediaConnectFailure) => {
      if (this.voiceIntentCurrent(voiceEpoch, hub, channelId))
        this.voiceMediaConnectFailure = { voiceEpoch, reason };
    };
    let activationFailureRemembered = false;
    let token;
    this.setVoiceDiagnosticJoinStage('media_token');
    try {
      token = await withVoiceDeadline(
        api.getVoiceMediaToken(session, serverId, channelId, leaseEpoch),
        Math.min(operationDeadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
        'voice media token',
      );
    }
    catch (error) {
      // A new client pointed at a not-yet-updated API must fail closed, but explain the rollout
      // mismatch instead of suggesting that the user's device or channel is broken.
      rememberFailure(isApiError(error) && (error.status === 404 || error.status === 405)
        ? 'server-updating'
        : 'token');
      this.recordVoiceDiagnostic({
        kind: 'media_token_received', stage: 'media_token', outcome: 'failed',
        ...classifyVoiceDiagnosticError(error), joinElapsedMs: this.voiceDiagnosticJoinElapsed(),
        ...this.voiceDiagnosticState(),
      });
      this.recordVoiceJoinFailure('media_token', error);
      return null;
    }
    if (!this.voiceIntentCurrent(voiceEpoch, hub, channelId) || token.epoch !== leaseEpoch
      || token.identity !== `${hub.localParticipant.identity}~${leaseEpoch}` || !token.token || !token.url || !token.room) {
      rememberFailure('token');
      this.recordVoiceJoinFailure('media_token');
      return null;
    }
    this.recordVoiceDiagnostic({
      kind: 'media_token_received', stage: 'media_token', outcome: 'ok', code: 'none',
      joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
    });
    const room = this.createVoiceMediaRoom();
    const previousPending = this.pendingVoiceMediaRoom;
    if (previousPending && previousPending !== room) this.disconnectRoom(previousPending);
    this.pendingVoiceMediaRoom = room;
    this.wireVoiceMediaRoom(room, serverId, channelId);
    let failure: VoiceMediaConnectFailure = 'transport';
    this.setVoiceDiagnosticJoinStage('media_connect');
    this.recordVoiceDiagnostic({
      kind: 'media_connected', stage: 'media_connect', outcome: 'started',
      joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
    });
    try {
      await withVoiceDeadline(
        room.connect(token.url, token.token, { autoSubscribe: false }),
        Math.min(operationDeadline, Date.now() + VOICE_MEDIA_CONNECT_TIMEOUT_MS),
        'voice media connect',
      );
      this.readyRooms.add(room);
      if (this.pendingVoiceMediaRoom !== room || !this.voiceIntentCurrent(voiceEpoch, hub, channelId)) throw new Error('stale voice media connect');
      this.recordVoiceDiagnostic({
        kind: 'media_connected', stage: 'media_connect', outcome: 'ok', code: 'none',
        joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
      });
      failure = 'activation';
      this.setVoiceDiagnosticJoinStage('activation');
      this.recordVoiceDiagnostic({
        kind: 'media_activated', stage: 'activation', outcome: 'started',
        joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
      });
      if (!await this.activateVoiceMediaRoom(
        room,
        hub,
        voiceEpoch,
        serverId,
        channelId,
        operationDeadline,
        (reason) => {
          activationFailureRemembered = true;
          rememberFailure(reason);
        },
      ))
        throw new Error('voice media activation failed');
      this.recordVoiceDiagnostic({
        kind: 'media_activated', stage: 'activation', outcome: 'ok', code: 'none',
        joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
      });
      return room;
    } catch (error) {
      // activateVoiceMediaRoom may already have identified a route/method rollout mismatch. Keep
      // that fixed reason instead of replacing it with the generic activation failure below.
      if (!activationFailureRemembered) rememberFailure(failure);
      if (this.voiceIntentCurrent(voiceEpoch, hub, channelId)) {
        const stage = failure === 'activation' ? 'activation' : 'media_connect';
        const timedOut = Date.now() >= operationDeadline || classifyVoiceDiagnosticError(error).code === 'timeout';
        this.recordVoiceJoinFailure(stage, error, timedOut ? 'timed_out' : 'failed');
      }
      this.readyRooms.delete(room); this.voiceMediaActivated.delete(room);
      if (this.pendingVoiceMediaRoom === room) this.pendingVoiceMediaRoom = null;
      this.disconnectRoom(room);
      return null;
    }
  }
  private voiceMediaFailureText(voiceEpoch: number, fallback: string): string {
    return this.voiceMediaConnectFailure?.voiceEpoch === voiceEpoch
      && this.voiceMediaConnectFailure.reason === 'server-updating'
      ? 'Сервер ещё обновляется — голос станет доступен после завершения обновления'
      : fallback;
  }
  private async verifyVoiceLeaseAfterReconnect(
    room: Room,
    voiceEpoch: number,
    verifySeq: number,
    mediaRoom?: Room,
    failClosedDeadline?: number,
  ): Promise<boolean> {
    let failures = 0;
    const recovery = this.voicePermissionRecovery;
    const inheritedDeadline = recovery && recovery.voiceEpoch === voiceEpoch
      && recovery.room === (mediaRoom || this.voiceMediaRoom) ? recovery.deadline : undefined;
    const reconnectRecovery = this.voiceReconnectRecovery;
    const reconnectDeadline = reconnectRecovery && reconnectRecovery.voiceEpoch === voiceEpoch
      && reconnectRecovery.hub === room ? reconnectRecovery.deadline : undefined;
    const deadline = Math.min(
      Date.now() + VOICE_RECONNECT_VERIFY_TIMEOUT_MS,
      inheritedDeadline ?? Number.POSITIVE_INFINITY,
      reconnectDeadline ?? Number.POSITIVE_INFINITY,
      failClosedDeadline ?? Number.POSITIVE_INFINITY,
    );
    const expire = async (): Promise<boolean> => {
      if (Date.now() < deadline) return false;
      if (this.voiceLeaseVerifySeq === verifySeq && this.voiceIntentCurrent(voiceEpoch, room)) await this.leaveVoice();
      return true;
    };
    const retry = async (delay: number): Promise<boolean> => {
      if (await expire()) return false;
      const boundedDelay = Math.min(delay, Math.max(0, deadline - Date.now()));
      await new Promise((resolve) => window.setTimeout(resolve, boundedDelay));
      return !await expire();
    };
    while (this.voiceLeaseVerifySeq === verifySeq && this.voiceIntentCurrent(voiceEpoch, room)) {
      if (await expire()) return false;
      let event: VoiceLeaseEvent;
      try {
        event = await withVoiceDeadline(
          api.getVoiceLease(),
          Math.min(deadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
          'voice reconnect lease snapshot',
        );
      }
      catch {
        failures++;
        if (failures === 3) this.hooks.toast('Проверяю голосовую сессию — микрофон пока в тишине', 'warn');
        if (!await retry(Math.min(5000, 500 * (2 ** Math.min(failures, 4))))) return false;
        continue;
      }
      if (this.voiceLeaseVerifySeq !== verifySeq || !this.voiceIntentCurrent(voiceEpoch, room)) return false;
      if (await expire()) return false;
      this.onVoiceLease(event);
      if (!this.voiceIntentCurrent(voiceEpoch, room)) return false; // другой owner/release уже запустил leave
      const serverId = this.voiceServerId, channelId = this.currentVc;
      if (!serverId || !channelId || !this.acceptVoiceLease(event, serverId, channelId)) {
        await this.leaveVoice();
        return false;
      }
      const activeMedia = this.voiceMediaRoom;
      if (!activeMedia || this.voiceMediaChannelId !== channelId || !this.readyRooms.has(activeMedia)
        || (mediaRoom && mediaRoom !== activeMedia)) {
        await this.leaveVoice();
        return false;
      }
      if (this.reconnectingRooms.has(room) || this.reconnectingRooms.has(activeMedia)) {
        failures++;
        if (!await retry(Math.min(1500, 250 * (2 ** Math.min(failures, 3))))) return false;
        continue;
      }
      let terminalActivationFailure: VoiceMediaConnectFailure | null = null;
      if ((!this.voiceMediaActivated.has(activeMedia) || !this.mediaPermissionsActive(activeMedia))
        && !await this.activateVoiceMediaRoom(
          activeMedia,
          room,
          voiceEpoch,
          serverId,
          channelId,
          deadline,
          (reason) => { terminalActivationFailure = reason; },
        )) {
        // Invalid/revoked authorization and a rolling-old activation route cannot recover inside
        // this exact lease verifier. Keep media fail-closed and retire it immediately; retryable
        // network/timeout/conflict responses leave this marker empty and retain the bounded loop.
        if (terminalActivationFailure) {
          await this.leaveVoice();
          return false;
        }
        failures++;
        if (!await retry(Math.min(5000, 400 * (2 ** Math.min(failures, 4))))) return false;
        continue;
      }
      if (!this.myVcAt) this.myVcAt = this.channelStartFor(channelId);
      // Не открываем uplink раньше, чем сервер комнаты подтвердил актуальные voice-атрибуты.
      if (!await this.commitVoiceAttributes(room, voiceEpoch, channelId, deadline)) {
        failures++;
        if (!await retry(Math.min(5000, 400 * (2 ** Math.min(failures, 4))))) return false;
        continue;
      }
      if (this.voiceLeaseVerifySeq !== verifySeq || !this.voiceIntentCurrent(voiceEpoch, room, channelId)) return false;
      if (this.micLocalTrack && !activeMedia.localParticipant.getTrackPublication(Track.Source.Microphone)?.track) {
        let republished = false;
        try {
          const publishDeadline = Math.min(deadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS);
          republished = await withVoiceDeadline(
            this.publishExistingMic(activeMedia, voiceEpoch, room, channelId),
            publishDeadline,
            'voice reconnect microphone publish',
          );
        } catch (error) {
          // A timed-out SDK publication cannot be cancelled safely or retried in parallel with the
          // same LocalAudioTrack. Retire the exact voice intent; its late continuation is epoch-fenced
          // and cleans up against the disconnected room instead of holding verification forever.
          if (isVoiceOperationTimeout(error)) {
            if (this.voiceLeaseVerifySeq === verifySeq && this.voiceIntentCurrent(voiceEpoch, room, channelId))
              await this.leaveVoice();
            return false;
          }
        }
        if (!republished) {
          failures++;
          if (!await retry(Math.min(3000, 300 * (2 ** Math.min(failures, 3))))) return false;
          continue;
        }
      }
      if (await expire()) return false;
      this.clearVoicePermissionRecovery(activeMedia, voiceEpoch);
      this.clearVoiceReconnectRecovery(room, voiceEpoch);
      this.voiceLeaseVerifying = false;
      this.reconcileAllAudio();
      this.applyGate();
      void this.checkMicAlive(false);
      this.emit();
      return true;
    }
    return false;
  }
  private async verifyVoiceTransactionBoundary(
    hub: Room,
    media: Room,
    voiceEpoch: number,
    channelId: string,
    disruptionAtStart: number,
    deadline: number,
  ): Promise<boolean> {
    const exactBoundary = () => this.voiceMediaIntentCurrent(voiceEpoch, hub, media, channelId)
      && this.readyRooms.has(hub) && this.readyRooms.has(media)
      && !this.reconnectingRooms.has(hub) && !this.reconnectingRooms.has(media)
      && this.voiceMediaActivated.has(media) && this.mediaPermissionsActive(media);
    if (this.voiceTransportDisruptionSeq === disruptionAtStart && exactBoundary()) return true;
    if (!this.voiceMediaIntentCurrent(voiceEpoch, hub, media, channelId)) return false;
    this.voiceLeaseVerifying = true;
    this.clearPttOwnership();
    const verifySeq = ++this.voiceLeaseVerifySeq;
    this.applyGate();
    this.emit();
    const verified = await this.verifyVoiceLeaseAfterReconnect(hub, voiceEpoch, verifySeq, media, deadline);
    return verified && exactBoundary() && this.voiceLeaseVerifySeq === verifySeq;
  }
  private async handleVoiceMediaDisconnected(room: Room, serverId: string, channelId: string) {
    this.remoteAudioStarts.forget(room);
    this.repairSurvivingRoomAudioAfterDisconnect(room);
    this.readyRooms.delete(room); this.voiceMediaActivated.delete(room);
    this.reconnectingRooms.delete(room); this.reconnecting = this.reconnectingRooms.size > 0;
    if (this.intentionalDisconnects.has(room)) { this.intentionalDisconnects.delete(room); return; }
    if (this.pendingVoiceMediaRoom === room) this.pendingVoiceMediaRoom = null;
    if (room !== this.voiceMediaRoom || this.voiceMediaChannelId !== channelId || this.currentVc !== channelId) return;
    this.recordVoiceDiagnostic({
      kind: 'disconnected', outcome: 'failed', code: 'disconnected',
      ...this.voiceDiagnosticState(),
    });
    this.finishVoiceDiagnostics('connection_failed');
    const hub = this.voiceRoom;
    const lostServer = this.voiceServerId || serverId;
    const epoch = ++this.voiceEpoch;
    this.invalidateMicRecoveryOwner();
    this.clearVoiceReconnectRecovery();
    const leaseSession = this.voiceLeaseSession, leaseEpoch = this.voiceLeaseEpoch;
    this.voiceMediaRoom = null; this.voiceMediaChannelId = null;
    this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    this.clearVoicePermissionRecovery();
    this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
    this.voiceReconnecting = false; this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.clearPttOwnership();
    this.myVcAt = null; this.voicePresenceConfirmed = false; this.noMic = false; this.micHadCapture = false; this.micBootstrapWanted = false; this.myChannelPeers.clear();
    this.lostVoiceServerId = lostServer; this.lostVoiceChannel = channelId;
    this.stopConnPoll(); this.subscriptionRetries.clear();
    this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
    this.clearVoiceAudio();
    const micStop = this.stopMic(room);
    const attrStop = hub ? this.commitVoiceTombstone(hub, epoch) : Promise.resolve();
    // Keep the account and viewed hub alive. Broadcast still follows the existing product
    // contract (voice loss ends it), but is stopped explicitly in the hub rather than by
    // disconnecting an otherwise healthy view room.
    const shareStop = this.stopShare().catch(() => {});
    this.hooks.endBroadcast?.();
    if (leaseSession && leaseEpoch > 0) void api.releaseVoiceLease(leaseSession, leaseEpoch).catch(() => {});
    this.hooks.toast('Голосовая связь оборвалась — подключись снова', 'warn'); this.emit();
    this.hooks.connectionLost?.(lostServer, channelId, false);
    try {
      await withVoiceTimeout(Promise.allSettled([micStop, attrStop, shareStop]), VOICE_CLEANUP_TIMEOUT_MS, 'lost voice cleanup');
    } catch { /** terminal state was published before cleanup */ }
    // A new join can start while the captured hub teardown is awaiting attributes/share. Always
    // retire an old hub that no longer owns either role, but never clear or disconnect new pointers.
    if (hub && hub !== this.viewRoom && hub !== this.voiceRoom) this.disconnectRoom(hub);
    if (this.voiceEpoch !== epoch || this.inVoice || this.voiceRoom !== hub) return;
    if (hub && hub !== this.viewRoom) this.disconnectRoom(hub);
    this.voiceRoom = null; this.voiceServerId = null;
    this.liveKitT.setBroadcastRoom?.(null);
    this.emit();
    this.scheduleLevelMeterAfterVoiceExit(epoch);
  }
  private handleRoomDisconnected(room: Room, serverId: string) {
    this.remoteAudioStarts.forget(room);
    this.repairSurvivingRoomAudioAfterDisconnect(room);
    if (this.intentionalDisconnects.has(room)) { this.intentionalDisconnects.delete(room); return; }
    const wasViewing = room === this.viewRoom;
    const wasVoice = room === this.voiceRoom;
    if (!wasViewing && !wasVoice) return;
    const lostChannel = wasVoice ? this.currentVc : null;
    if (wasVoice) {
      this.recordVoiceDiagnostic({
        kind: 'disconnected', outcome: 'failed', code: 'disconnected',
        ...this.voiceDiagnosticState(),
      });
      this.finishVoiceDiagnostics('connection_failed');
    }
    this.readyRooms.delete(room);
    this.reconnectingRooms.delete(room);
    this.reconnecting = this.reconnectingRooms.size > 0;
    if (wasVoice) {
      const media = this.voiceMediaRoom;
      const pendingMedia = this.pendingVoiceMediaRoom;
      this.voiceMediaRoom = null; this.pendingVoiceMediaRoom = null; this.voiceMediaChannelId = null;
      if (media) { this.voiceMediaActivated.delete(media); this.disconnectRoom(media); }
      if (pendingMedia && pendingMedia !== media) this.disconnectRoom(pendingMedia);
      this.voiceReconnecting = false;
      this.lostVoiceServerId = lostChannel ? (this.voiceServerId || serverId) : null;
      this.lostVoiceChannel = lostChannel;
      ++this.voiceEpoch;
      this.invalidateMicRecoveryOwner();
      this.clearVoiceReconnectRecovery();
      this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
      this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
      this.clearVoicePermissionRecovery();
      this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.clearPttOwnership();
      this.myVcAt = null; this.voicePresenceConfirmed = false; this.noMic = false; this.micHadCapture = false; this.micBootstrapWanted = false; this.myChannelPeers.clear();
      // Terminal network loss не release'ит серверный lease (reconnect = observation only), но
      // локально больше не считаем себя owner. Следующий явный join получит новый epoch.
      this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
      this.stopConnPoll();
      this.subscriptionRetries.clear();
      this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
      const voiceExitEpoch = this.voiceEpoch;
      const micStop = this.stopMic(media);
      void micStop.finally(() => this.scheduleLevelMeterAfterVoiceExit(voiceExitEpoch)).catch(() => {});
      // Терминальный обрыв LiveKit не проходит через leaveVoice(), поэтому нативный
      // broadcaster иначе продолжал бы жить после потери голосовой комнаты.
      // Остановка локальной трансляции не отзывает аккаунтную сессию и не влияет на
      // просмотр других серверов.
      this.hooks.endBroadcast?.();
      document.querySelectorAll('#audioSink audio[data-origin="voice"]').forEach((a) => a.remove());
      this.clearVoiceAudio();
      this.voiceRoom = null; this.voiceServerId = null;
      this.liveKitT.setBroadcastRoom?.(null);
    }
    if (wasViewing) {
      this.stopGamePolling();
      this.resetStreamEdges();
      this.clearAllWatches({
        stage: 'watch_signaling', outcome: 'failed',
        code: typeof navigator === 'object' && navigator.onLine === false ? 'offline' : 'signaling_closed',
        trackState: 'missing',
      });
      ++this.connectEpoch;
      this.roomReady = false;
      this.viewRoom = null; this.viewServerId = '';
      this.liveKitT.detach(); this.treeT.detach();
      this.clearScreenAudio();
    }
    if (!this.hooks.connectionLossExpected?.()) {
      this.hooks.toast(wasVoice ? 'Голосовая связь оборвалась — подключись снова' : 'Realtime-связь оборвалась — переподключаюсь…', 'warn');
    }
    this.emit();
    this.hooks.connectionLost?.(serverId, lostChannel, wasViewing);
  }
  private applyGamePresence(room: Room, game: GameStatus | null) {
    this.myGame = game;
    const wantName = game?.name || '';
    const wantIcon = (game?.icon && game.icon.length < 4000) ? game.icon : '';
    const attrs = room.localParticipant.attributes || {};
    if ((attrs.game || '') !== wantName || (attrs.gicon || '') !== wantIcon) {
      // setAttributes merges: voice ownership attributes are not replaced by the game tombstone.
      try { void room.localParticipant.setAttributes({ game: wantName, gicon: wantIcon }).catch(() => {}); }
      catch { /** disconnected/displaced room is already effectively cleared */ }
    }
    this.emit();
  }
  private ensureGameSettingsWatch() {
    if (!isTauri || this.stopGameSettingsWatch) return;
    this.gameShareEnabled = getSettings().shareGame;
    this.stopGameSettingsWatch = subscribeSettings(() => {
      const enabled = getSettings().shareGame;
      if (enabled === this.gameShareEnabled) return;
      this.gameShareEnabled = enabled;
      if (enabled) this.gamePresence.request();
      else this.gamePresence.invalidate();
    });
  }
  private startGamePolling() {
    if (!isTauri) return;
    if (this.gameTimer) clearInterval(this.gameTimer);
    // The view room may have changed while an uncancellable detect_game invoke was pending.
    this.gamePresence.invalidate();
    this.gamePresence.request();
    this.gameTimer = window.setInterval(() => this.gamePresence.request(), 10_000);
  }
  private stopGamePolling() {
    if (this.gameTimer) { clearInterval(this.gameTimer); this.gameTimer = null; }
    this.gamePresence.invalidate();
  }

  // Полный teardown (logout / выход с сервера, где я в голосе): рвём ОБЕ комнаты + всё состояние.
  disconnect(discardVoiceDiagnostics = false) {
    // Fences every deferred voice-exit/settings-preview continuation before any asynchronous room
    // teardown. Logout/full disconnect must never resurrect microphone capture afterwards.
    this.engineLifecycleActive = false;
    if (this.inVoice) this.finishVoiceDiagnostics();
    // Full transport teardown is also used by server exit and auth handoff, where the account is
    // still valid. Only the explicit logout caller revokes retained diagnostic ownership.
    this.voiceDiagnosticSessionGeneration++;
    if (discardVoiceDiagnostics) {
      this.voiceDiagnosticAccountActive = false;
      this.clearVoiceDiagnosticPendingReport();
      this.clearVoiceDiagnosticQueuedReport();
    }
    this.streamDiagnosticOutbox.dispose(discardVoiceDiagnostics);
    this.cancelPendingVoiceJoin();
    if (this.deviceChangeHandler) {
      navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceChangeHandler);
      this.deviceChangeHandler = null;
    }
    if (this.remoteAudioResumeHandler) {
      document.removeEventListener('visibilitychange', this.remoteAudioResumeHandler);
      window.removeEventListener('pageshow', this.remoteAudioResumeHandler);
      this.remoteAudioResumeHandler = null;
    }
    if (discardVoiceDiagnostics && this.voiceDiagnosticRetryHandler) {
      window.removeEventListener('online', this.voiceDiagnosticRetryHandler);
      document.removeEventListener('visibilitychange', this.voiceDiagnosticRetryHandler);
      window.removeEventListener('pageshow', this.voiceDiagnosticRetryHandler);
      this.voiceDiagnosticRetryHandler = null;
    }
    if (this.inputResumeHandler) {
      document.removeEventListener('visibilitychange', this.inputResumeHandler);
      window.removeEventListener('pageshow', this.inputResumeHandler);
      this.inputResumeHandler = null;
    }
    if (this.inputPageHideHandler) {
      window.removeEventListener('pagehide', this.inputPageHideHandler);
      this.inputPageHideHandler = null;
    }
    this.clearRemoteAudioUnlock();
    this.stopIdleWatch?.(); this.stopIdleWatch = null; // движок выбрасывается — подписка не должна его удерживать
    if (this.spIdleTimer) { clearInterval(this.spIdleTimer); this.spIdleTimer = null; }
    ++this.voiceEpoch; ++this.connectEpoch;
    this.invalidateMicRecoveryOwner();
    this.clearVoiceReconnectRecovery();
    this.resetStreamEdges();
    this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    this.clearVoicePermissionRecovery();
    const oldVoiceRoom = this.voiceRoom;
    const oldVoiceMediaRoom = this.voiceMediaRoom;
    const oldPendingVoiceMediaRoom = this.pendingVoiceMediaRoom;
    const leaseSession = this.voiceLeaseSession, leaseEpoch = this.voiceLeaseEpoch;
    this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
    if (leaseSession && leaseEpoch > 0) void api.releaseVoiceLease(leaseSession, leaseEpoch).catch(() => {});
    if (this.inVoice) this.hooks.endBroadcast?.(); // гасим нативную трансляцию (browser-share упадёт с room.disconnect)
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.stopGamePolling();
    this.stopGameSettingsWatch?.(); this.stopGameSettingsWatch = null;
    this.stopConnPoll();
    this.analysers.forEach((o) => { try { o.src.disconnect(); } catch { /**/ } });
    this.analysers.clear(); this.speakingSet.clear();
    if (this.spRAF) cancelAnimationFrame(this.spRAF); this.spRAF = null;
    this.vadOpen = false;
    this.stopLevelMeter();
    this.keepAliveOff();
    document.querySelectorAll('#audioSink audio').forEach((a) => a.remove());
    this.clearVoiceAudio();
    this.clearScreenAudio();
    this.clearAllWatches();
    this.liveKitT.detach(); this.treeT.detach();
    this.streamWatchers.clear();
    this.perMuteByServer.clear(); this.volsByServer.clear(); this.messages = []; this.reactions.clear(); this.reactionWrites.clear(); this.reactionWriteSeq.clear(); this.reactionWriteDesired.clear(); this.pendingSend.clear(); this.chatMore = false; this.oldestSid = null; this.trimmedFront = 0; this.chatPrepended = 0; this.chatRetentionLimit = CHAT_SESSION_MESSAGE_LIMIT; ++this.chatGeneration;
    this.chatStateServerId = ''; this.chatRevision = 0; this.chatLastClearRevision = 0; this.chatRevisionKnown = false; this.canonicalSnapshotEstablished = false; this.chatEventBuffer = []; this.chatEventBufferOverflow = false; this.chatSnapshotSeenSids.clear(); this.canonicalMentionDeliveries.clear(); this.chatMentionFenceEstablished = false; this.chatSyncAgain = false; this.chatSyncFailures = 0; this.chatSyncPromise = null; this.chatMutationSeq.clear(); this.chatMutationWrites.clear(); this.chatEditDesired.clear(); ++this.chatSyncGeneration;
    this.onlineHint.clear(); this.awayHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    this.activeVoiceSessions.clear();
    this.subscriptionRetries.clear();
    this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
    if (this.outputDeviceTimer) { clearTimeout(this.outputDeviceTimer); this.outputDeviceTimer = null; }
    this.outputDeviceRefreshPending = false;
    void this.stopMic(oldVoiceMediaRoom);
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.voiceReconnecting = false; this.lostVoiceServerId = null; this.lostVoiceChannel = null; this.roomReady = false; this.screenStream = null; this.voicePresenceConfirmed = false; this.noMic = false; this.micHadCapture = false; this.micBootstrapWanted = false; // deafened/manualMute НЕ трогаем — персист-интент
    // Hub/view and active/pending media can all be distinct during a channel handoff.
    new Set([this.viewRoom, this.voiceRoom, oldVoiceMediaRoom, oldPendingVoiceMediaRoom].filter(Boolean)).forEach((rm) => this.disconnectRoom(rm as Room));
    // These contexts are supplied by Engine (not owned by LiveKit), so room.disconnect() does not
    // close them. Mobile Safari has a low AudioContext limit: leaking one set per logout eventually
    // makes microphone/output creation fail until the whole PWA is killed.
    ++this.outputRecoveryGeneration; this.outputRecovery = null; this.outputRecoveryRejectedFor = null;
    const contexts = [this.spCtx, this.outputCtx, this.keepCtx].filter(Boolean) as AudioContext[];
    this.spCtx = null; this.outputCtx = null; this.keepCtx = null; this.outputGeneration++;
    contexts.forEach((ctx) => {
      forgetExactAudioContextResume(ctx);
      if (ctx.state !== 'closed') void ctx.close().catch(() => {});
    });
    this.viewRoom = null; this.voiceRoom = null; this.voiceMediaRoom = null; this.pendingVoiceMediaRoom = null; this.voiceMediaChannelId = null;
    this.liveKitT.setBroadcastRoom?.(null);
    this.viewServerId = ''; this.voiceServerId = null; this.hooks.chatConnectionChanged?.(); this.emit();
  }

  // Уйти со СМОТРИМОГО сервера (браузинг на другой / на главную-с-выходом), НЕ трогая голос: чистим
  // view-состояние (чат/стримы/presence-хинты/typing) и рвём viewRoom, ТОЛЬКО если она не голосовая.
  detachView(nextServerId?: string) {
    // A terminal reconnect replaces viewRoom before the store asks for a fresh token. Preserve an
    // explicit queued channel tap only when that retry targets the same server; ordinary browsing,
    // exit and a switch to another server still cancel it and release its gesture-owned context.
    const preservePending = !!nextServerId && this.pendingVoiceJoin?.serverId === nextServerId
      && (!this.viewRoom || !this.readyRooms.has(this.viewRoom) || this.reconnectingRooms.has(this.viewRoom));
    if (!preservePending) this.cancelPendingVoiceJoin(this.viewServerId || undefined);
    this.stopGamePolling();
    ++this.connectEpoch;
    this.resetStreamEdges();
    this.messages = []; this.reactions.clear(); this.reactionWrites.clear(); this.reactionWriteSeq.clear(); this.reactionWriteDesired.clear(); this.pendingSend.clear(); this.chatMore = false; this.oldestSid = null; this.trimmedFront = 0; this.chatPrepended = 0; this.chatRetentionLimit = CHAT_SESSION_MESSAGE_LIMIT; ++this.chatGeneration;
    this.chatStateServerId = ''; this.chatRevision = 0; this.chatLastClearRevision = 0; this.chatRevisionKnown = false; this.canonicalSnapshotEstablished = false; this.chatEventBuffer = []; this.chatEventBufferOverflow = false; this.chatSnapshotSeenSids.clear(); this.canonicalMentionDeliveries.clear(); this.chatMentionFenceEstablished = false; this.chatSyncAgain = false; this.chatSyncFailures = 0; this.chatSyncPromise = null; this.chatMutationSeq.clear(); this.chatMutationWrites.clear(); this.chatEditDesired.clear(); ++this.chatSyncGeneration;
    this.clearAllWatches(); this.streamWatchers.clear();
    // presence-хинты и typing принадлежат ПРЕДЫДУЩЕМУ смотримому серверу
    this.onlineHint.clear(); this.awayHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    this.liveKitT.detach(); this.treeT.detach();
    this.clearScreenAudio(); // только стрим-аудио, не мик
    this.roomReady = false;
    const vw = this.viewRoom;
    this.viewRoom = null; this.viewServerId = '';
    this.hooks.chatConnectionChanged?.();
    if (vw && vw !== this.voiceRoom) this.disconnectRoom(vw); // не рвём, если это голосовая комната (голос продолжается)
    this.emit();
  }

  // Вернуться на просмотр СВОЕГО голосового сервера: смотримой становится живая голосовая комната (без
  // второго коннекта к тому же srv → без само-дубля/эха). Отцепляем прежнюю смотримую, переносим
  // video-транспорты на голосовую, ре-энум стримов. Чат/presence грузит стор (как обычный вход).
  reuseVoiceAsView() {
    this.detachView();
    if (!this.voiceRoom) return; // голос успел уйти
    this.viewRoom = this.voiceRoom;
    this.viewServerId = this.voiceServerId || '';
    this.hooks.chatConnectionChanged?.();
    this.roomReady = this.readyRooms.has(this.viewRoom); // voice join мог ещё ждать незавершённый connect
    this.liveKitT.attach(this.viewRoom, { me: this.me.username, serverId: this.viewServerId });
    this.treeT.attach(this.viewRoom, { me: this.me.username, serverId: this.viewServerId });
    this.liveKitT.onRoomConnected(); this.treeT.onRoomConnected();
    if (isTauri) this.startGamePolling();
    this.emit();
  }

  /* ---------- presence helpers ---------- */
  // Участник по БАЗОВОМУ username (identity = username#session). При handoff ПК↔телефон в комнате
  // кратко живут две сессии. Предпочитаем последнюю явную vclaim-сессию, затем vc-атрибут, затем mic;
  // простой «первый mic в Map» делал roster/mute зависимыми от порядка сетевых событий у каждого пира.
  private partOf(username: string, room: Room | null = this.viewRoom): Participant | null {
    if (!room) return null;
    if (username === this.me.username) return room.localParticipant;
    const claimed = room === this.voiceRoom ? this.activeVoiceSessions.get(username) : undefined;
    let best: Participant | null = null;
    let bestRank: { epoch: number; claimed: number; vc: number; mic: number; joined: number; identity: string } | null = null;
    for (const p of room.remoteParticipants.values()) {
      if (baseUid(p.identity) !== username) continue;
      const hasVc = !!(p as any).attributes?.vc;
      const hasMic = !!p.getTrackPublication(Track.Source.Microphone);
      const identitySession = p.identity.includes('#') ? p.identity.slice(p.identity.indexOf('#') + 1) : p.identity;
      const declaredSession = String((p as any).attributes?.voiceSession || '');
      const declaredEpoch = Number((p as any).attributes?.voiceEpoch);
      const serverEpoch = (hasVc || hasMic) && declaredSession === identitySession && Number.isSafeInteger(declaredEpoch) && declaredEpoch > 0 ? declaredEpoch : 0;
      const claimMatch = claimed?.identity === p.identity;
      if (claimed && !claimMatch && serverEpoch <= claimed.epoch) continue;
      const joined = p.joinedAt?.getTime?.() || 0;
      // Лексикографический ранг, а не сумма: timestamp joinedAt не должен случайно перевесить vc.
      // Надёжный vclaim может доехать на один realtime-такт раньше participant attributes. Его
      // подтверждённый monotonic epoch уже должен заглушить старую сессию, иначе listeners кратко
      // продолжали подписываться на старый мик во время handoff.
      const rank = { epoch: Math.max(serverEpoch, claimMatch ? claimed.epoch : 0), claimed: claimMatch ? 1 : 0, vc: hasVc ? 1 : 0, mic: hasMic ? 1 : 0, joined, identity: p.identity };
      const better = !bestRank
        || rank.epoch > bestRank.epoch
        || (rank.epoch === bestRank.epoch && rank.claimed > bestRank.claimed)
        || (rank.epoch === bestRank.epoch && rank.claimed === bestRank.claimed && rank.vc > bestRank.vc)
        || (rank.epoch === bestRank.epoch && rank.claimed === bestRank.claimed && rank.vc === bestRank.vc && rank.mic > bestRank.mic)
        || (rank.epoch === bestRank.epoch && rank.claimed === bestRank.claimed && rank.vc === bestRank.vc && rank.mic === bestRank.mic && rank.joined > bestRank.joined)
        || (rank.epoch === bestRank.epoch && rank.claimed === bestRank.claimed && rank.vc === bestRank.vc && rank.mic === bestRank.mic && rank.joined === bestRank.joined && rank.identity > bestRank.identity);
      if (better) { best = p; bestRank = rank; }
    }
    return best;
  }
  // Media rooms are server-authorized and contain one voice channel only. Do not reuse `partOf`:
  // its ranking intentionally consumes hub vc/mic attributes, while media participants carry
  // immutable token attributes and can overlap briefly during a multi-device handoff.
  private mediaPartOf(username: string, room: Room | null = this.voiceMediaRoom): Participant | null {
    if (!room || room !== this.voiceMediaRoom || this.voiceMediaChannelId !== this.currentVc) return null;
    if (username === this.me.username) return room.localParticipant;
    let best: Participant | null = null;
    let bestEpoch = 0;
    for (const p of room.remoteParticipants.values()) {
      if (baseUid(p.identity) !== username) continue;
      const attrs = (p as any).attributes || {};
      const identity = voiceMediaIdentityParts(p.identity);
      if (!identity) continue;
      const epoch = Number(attrs.voiceEpoch);
      if (String(attrs.voiceServer || '') !== this.voiceServerId || String(attrs.voiceChannel || '') !== this.currentVc
        || String(attrs.voiceSession || '') !== identity.session || !Number.isSafeInteger(epoch) || epoch < 1
        || epoch !== identity.epoch) continue;
      // This exact media room is already server-authorized by the current lease and immutable
      // token attributes. A listener-local hub vclaim may be stale after reconnect/server restart
      // and must not make different listeners reject the same valid microphone indefinitely.
      if (!best || epoch > bestEpoch || (epoch === bestEpoch && p.identity > best.identity)) {
        best = p; bestEpoch = epoch;
      }
    }
    return best;
  }
  private observeVoiceSession(p: Participant) {
    const attrs = (p as any).attributes || {};
    const identitySession = p.identity.includes('#') ? p.identity.slice(p.identity.indexOf('#') + 1) : p.identity;
    const declaredSession = String(attrs.voiceSession || '');
    const epoch = Number(attrs.voiceEpoch);
    if (declaredSession !== identitySession || !Number.isSafeInteger(epoch) || epoch < 1) return;
    const username = baseUid(p.identity);
    const current = this.activeVoiceSessions.get(username);
    if (!current || epoch > current.epoch || (epoch === current.epoch && p.identity > current.identity)) {
      this.activeVoiceSessions.set(username, { identity: p.identity, epoch });
    }
  }
  // id этой сессии = суффикс после # в моём LiveKit-identity (для tie-break гонки vclaim)
  private sessionId(room: Room | null = this.voiceRoom): string {
    if (!room) return '';
    const known = this.roomSessions.get(room);
    if (known) return known;
    const id = room.localParticipant.identity || '';
    const i = id.indexOf('#');
    return i < 0 ? id : id.slice(i + 1);
  }
  private acceptVoiceLease(event: VoiceLeaseEvent, serverId: string, channelId: string): boolean {
    const lease = event.lease;
    const session = this.sessionId();
    if (event.accepted === false || !lease || !session || lease.sessionId !== session || lease.serverId !== serverId || lease.channelId !== channelId
      || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1 || event.currentEpoch !== lease.epoch) return false;
    this.voiceLeaseSession = session;
    this.voiceLeaseChannel = channelId;
    this.voiceLeaseEpoch = lease.epoch;
    return true;
  }
  private finishVoiceClaim(intentEpoch: number, response: VoiceLeaseEvent | null): { response: VoiceLeaseEvent | null; deferred: VoiceLeaseEvent | null } {
    if (this.voiceClaimPending !== intentEpoch) return { response, deferred: null };
    this.voiceClaimPending = 0;
    const deferred = this.deferredVoiceLease;
    this.deferredVoiceLease = null;
    const matched = this.matchedVoiceLease;
    this.matchedVoiceLease = null;
    if (matched && (!response || matched.currentEpoch > response.currentEpoch
      || (matched.currentEpoch === response.currentEpoch && response.accepted === false && matched.accepted !== false))) response = matched;
    return { response, deferred: deferred && (!response || deferred.currentEpoch >= response.currentEpoch) ? deferred : null };
  }
  // Глобальный notify-WS доставляет ownership даже устройству, которое было offline во время handoff.
  // Snapshot только наблюдает; claimed от другой session немедленно гасит старый локальный voice.
  onVoiceLease(event: VoiceLeaseEvent) {
    if (!event || event.t !== 'voice-lease') return;
    const lease = event.lease;
    const localSession = this.sessionId();
    const matchesPendingIntent = !!lease && !!localSession && lease.sessionId === localSession
      && lease.serverId === this.voiceServerId && lease.channelId === this.currentVc;
    if (this.voiceClaimPending === this.voiceEpoch && matchesPendingIntent && event.currentEpoch === lease!.epoch) {
      if (!this.matchedVoiceLease || event.currentEpoch >= this.matchedVoiceLease.currentEpoch) this.matchedVoiceLease = event;
    }
    if (this.voiceClaimPending === this.voiceEpoch && !matchesPendingIntent) {
      if (!this.deferredVoiceLease || event.currentEpoch >= this.deferredVoiceLease.currentEpoch) this.deferredVoiceLease = event;
      return;
    }
    if (lease && localSession && lease.sessionId === localSession) {
      if (this.inVoice && lease.serverId === this.voiceServerId && lease.channelId === this.currentVc && lease.epoch >= this.voiceLeaseEpoch) {
        this.voiceLeaseSession = localSession;
        this.voiceLeaseChannel = lease.channelId;
        this.voiceLeaseEpoch = lease.epoch;
        // Во время собственного HTTP claim событие notify может приехать раньше ответа. Оно ещё не
        // завершает арбитраж: параллельное устройство способно получить следующий epoch. До finishVoiceClaim
        // держим атрибуты пустыми, а микрофон — в тишине.
        if (this.voiceClaimPending !== this.voiceEpoch) {
          if (this.voiceRoom && this.voiceMediaRoom && this.voiceMediaChannelId === this.currentVc
            && this.voiceMediaActivated.has(this.voiceMediaRoom)) {
            void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
          }
          this.applyGate();
        }
      } else if (this.inVoice && lease.epoch >= this.voiceLeaseEpoch) {
        void this.leaveVoice();
      }
      return;
    }
    if (!this.inVoice) return;
    const superseded = !!lease && (this.voiceLeaseEpoch > 0 || event.reason === 'claimed') && lease.epoch >= this.voiceLeaseEpoch;
    const released = !lease && this.voiceLeaseEpoch > 0 && event.currentEpoch >= this.voiceLeaseEpoch;
    if (superseded) {
      this.hooks.toast('Голос перенесён в другую вкладку или на другое устройство', 'info');
      void this.leaveVoice();
    } else if (released) {
      this.hooks.toast('Голосовая сессия завершена сервером', 'warn');
      void this.leaveVoice();
    }
  }
  // есть ли у юзера ещё живые сессии, кроме указанной (для presence/cleanup при отключении одной)
  private hasOtherSession(username: string, exceptIdentity: string): boolean {
    if (!this.viewRoom) return false;
    for (const p of this.viewRoom.remoteParticipants.values()) {
      if (p.identity !== exceptIdentity && baseUid(p.identity) === username) return true;
    }
    return false;
  }
  private isInVoice(username: string): boolean {
    if (username === this.me.username) return this.inVoice;
    return !!this.voiceChannelOf(username);
  }
  // голосовой канал участника: для себя — currentVc, для пира — participant-атрибут vc
  private voiceChannelOf(username: string): string | null {
    if (username === this.me.username) return this.currentVc;
    const p = this.partOf(username);
    const vc = (p as any)?.attributes?.vc;
    return vc || null;
  }
  // Момент начала занятости канала channelId — унаследован от уже сидящих там (мин. их vcAt), либо
  // now(), если я в него первый. Так «время звонка» переживает перестановки участников (не сбрасывается,
  // пока канал не опустеет целиком) и одинаково для всех, кто его позже увидит — каждый вошедший копирует
  // ЧУЖОЙ vcAt, а не пишет свой момент входа.
  private channelStartFor(channelId: string): number {
    if (!this.voiceRoom) return Date.now();
    let min = Infinity;
    this.voiceRoom.remoteParticipants.forEach((p) => {
      const a = (p as any).attributes || {};
      if (a.vc !== channelId) return;
      const t = Number(a.vcAt);
      if (t > 0 && t < min) min = t;
    });
    return Number.isFinite(min) ? min : Date.now();
  }
  // The media room itself is the authorization boundary. Client filtering remains only for
  // deafen, own-account echo suppression and monotonic multi-device session selection.
  private reconcilePeerAudio(p: Participant, room: Room | null = this.voiceMediaRoom) {
    if (!room || room !== this.voiceMediaRoom || p === room.localParticipant) return;
    const username = baseUid(p.identity);
    if (username === this.me.username) return; // своя же другая сессия — не подписываемся (эхо)
    const mp = p.getTrackPublication(Track.Source.Microphone);
    if (!mp) { this.removeVoiceAudio(username, p.identity, undefined, room); return; }
    // ОГЛОХ (deafened) → НЕ подписываемся: нет трека = гарантированная тишина, независимо от громкости.
    // Иначе оглохший оставался подписан, а глушение по громкости могло не примениться (пир размутился →
    // resubscribe без re-apply громкости → слышно, хотя фулл-мут).
    const active = this.mediaPartOf(username, room);
    const want = p === active && this.inVoice && !this.deafened && !!this.currentVc
      && this.voiceMediaChannelId === this.currentVc && this.voiceMediaActivated.has(room);
    const remotePub = mp as any;
    const retryKey = `${this.voiceMediaRoomKey(room)}\n${p.identity}:${remotePub.trackSid || remotePub.sid || 'mic'}`;
    try {
      // setSubscribed всегда шлёт сигналинг update; прежний 3с reconcile флудил одинаковым true
      // по каждому mic. Меняем desired только при реальном переходе состояния.
      if (remotePub.isDesired !== want) {
        remotePub.setSubscribed(want);
        if (want) this.subscriptionRetries.set(retryKey, { attempts: 0, nextAt: Date.now() + 4000 });
        else this.subscriptionRetries.delete(retryKey);
      } else if (want && !remotePub.isSubscribed) {
        // Desired=true, но track не доехал: bounded retry с backoff, а не бесконечный broadcast.
        const retry = this.subscriptionRetries.get(retryKey) || { attempts: 0, nextAt: Date.now() + 4000 };
        // После короткого burst не сдаёмся навсегда: один новый bounded-цикл через 30с лечит
        // долгий ICE/visibility провал без постоянного signaling-флуда.
        if (retry.attempts >= 3 && Date.now() >= retry.nextAt) { retry.attempts = 0; retry.nextAt = 0; }
        if (retry.attempts < 3 && Date.now() >= retry.nextAt) {
          remotePub.setSubscribed(true);
          retry.attempts++;
          retry.nextAt = Date.now() + (retry.attempts >= 3 ? 30000 : 3000 * (retry.attempts + 1));
        }
        this.subscriptionRetries.set(retryKey, retry);
      } else if (want && remotePub.isSubscribed) this.subscriptionRetries.delete(retryKey);
    } catch { /** TrackSubscriptionFailed/watchdog повторит ограниченно */ }
    if (!want) {
      const currentAudio = this.voiceAudioEls.get(username);
      // Обход inactive старой session не должен снести element/analyser активной новой session.
      if (!currentAudio || (currentAudio.room === room && currentAudio.identity === p.identity))
        this.removeVoiceAudio(username, p.identity, undefined, room);
    }
    else if ((mp as any).track) this.ensureRemoteVoicePlayback(username);
  }
  private clearSubscriptionRetries(identity?: string, trackSid?: string, room?: Room) {
    if (!identity) { this.subscriptionRetries.clear(); return; }
    const roomPrefix = room ? `${this.voiceMediaRoomKey(room)}\n` : '';
    const exact = trackSid ? `${roomPrefix}${identity}:${trackSid}` : '';
    const prefix = `${roomPrefix}${identity}:`;
    for (const key of this.subscriptionRetries.keys()) {
      if ((exact && key === exact) || (!exact && key.startsWith(prefix))) this.subscriptionRetries.delete(key);
    }
  }
  private voiceMediaRoomKey(room: Room): number {
    const existing = this.voiceMediaRoomKeys.get(room);
    if (existing) return existing;
    const next = ++this.voiceMediaRoomKeySeq;
    this.voiceMediaRoomKeys.set(room, next);
    return next;
  }
  private reconcileAllAudio() { this.voiceMediaRoom?.remoteParticipants.forEach((p) => this.reconcilePeerAudio(p, this.voiceMediaRoom)); }
  private reconcileUserAudio(username: string) {
    const room = this.voiceMediaRoom;
    room?.remoteParticipants.forEach((p) => { if (baseUid(p.identity) === username) this.reconcilePeerAudio(p, room); });
  }
  // Кто СЕЙЧАС в МОЁМ голосовом канале (base username). Для entry/exit при их входе/выходе — в т.ч. при
  // СМЕНЕ канала: там мик не пере-публикуется (нет TrackPublished/Unpublished), меняется только vc-атрибут.
  private currentChannelPeers(): Set<string> {
    const s = new Set<string>();
    if (!this.inVoice || !this.currentVc || !this.voiceRoom) return s;
    const users = new Set<string>();
    this.voiceRoom.remoteParticipants.forEach((p) => {
      const u = baseUid(p.identity);
      if (u !== this.me.username) users.add(u);
    });
    users.forEach((u) => { const p = this.partOf(u, this.voiceRoom); if ((p as any)?.attributes?.vc === this.currentVc) s.add(u); });
    return s;
  }
  // Диф членства моего канала → entry для вошедших, exit для вышедших (работает и на смену канала другими,
  // и когда я сам переключаюсь — у тех, в чьём канале это отражается). seedOnly — заполнить БЕЗ звука
  // (первичный вход / смена своего канала: не проигрывать entry по всем, кто уже был там).
  private reconcileChannelSounds(seedOnly = false) {
    const cur = this.currentChannelPeers();
    // Реконнект LiveKit «отключает» всех участников и подключает заново: без этого гейта канал получал
    // залп exit по всем, а следом залп entry, хотя никто никуда не выходил. Состав пере-сеиваем молча.
    if (this.reconnecting || this.voiceReconnecting || this.voiceLeaseVerifying) seedOnly = true;
    if (!seedOnly) {
      cur.forEach((u) => { if (!this.myChannelPeers.has(u)) playSound('entry'); });
      this.myChannelPeers.forEach((u) => { if (!cur.has(u)) playSound('exit'); });
    }
    this.myChannelPeers = cur;
  }
  private voiceIntentCurrent(epoch: number, room: Room, channel?: string): boolean {
    return this.voiceEpoch === epoch && this.inVoice && this.voiceRoom === room && (!channel || this.currentVc === channel);
  }
  private voiceMediaIntentCurrent(epoch: number, hub: Room, media: Room, channel: string): boolean {
    return this.voiceIntentCurrent(epoch, hub, channel)
      && this.voiceMediaRoom === media && this.voiceMediaChannelId === channel;
  }
  private watchLateVoiceClaim(
    claim: Promise<VoiceLeaseEvent>,
    hub: Room,
    voiceEpoch: number,
    clientIntent: number,
    session: string,
    serverId: string,
    channelId: string,
    deadline: number,
  ) {
    void claim.then((event) => {
      const lease = event.lease;
      if ((event.reason !== 'claimed' && event.reason !== 'idempotent') || event.accepted === false || !lease
        || lease.sessionId !== session || lease.serverId !== serverId || lease.channelId !== channelId) return;
      const currentIntent = this.voiceClientIntent === clientIntent
        && this.voiceIntentCurrent(voiceEpoch, hub, channelId);
      const adoptedNow = currentIntent && this.voiceLeaseSession === session && this.voiceLeaseEpoch === lease.epoch;
      if (adoptedNow) return;
      if (!currentIntent) {
        void api.releaseVoiceLease(session, lease.epoch).catch(() => {});
        return;
      }
      // Wait until every bounded recovery path has finished. Keep only the exact lease that the
      // still-current intent adopted; an HTTP response arriving after timeout is otherwise released
      // by epoch and cannot silently move the account after the UI already rolled back.
      window.setTimeout(() => {
        const adopted = this.voiceClientIntent === clientIntent
          && this.voiceIntentCurrent(voiceEpoch, hub, channelId)
          && this.voiceLeaseSession === session && this.voiceLeaseEpoch === lease.epoch;
        if (!adopted) void api.releaseVoiceLease(session, lease.epoch).catch(() => {});
      }, Math.max(0, deadline - Date.now()) + 50);
    }).catch(() => {});
  }
  // Все writers vc/deaf проходят через одну очередь на комнату. Поэтому запоздалый setAttributes(vc=old)
  // физически не может завершиться ПОСЛЕ более нового leave/switch и воскресить старое состояние.
  private setVoiceAttributes(room: Room, attrs: Record<string, string>, strict = false): Promise<void> {
    const next = { ...attrs };
    const same = (a: Record<string, string> | undefined, b: Record<string, string>) => !!a
      && JSON.stringify(a) === JSON.stringify(b);
    const active = this.voiceAttrWrites.get(room);
    const queued = this.voiceAttrDesired.get(room);
    if (!strict && active && same(queued, next)) return active;
    this.voiceAttrDesired.set(room, next);
    // Каждый новый intent цепляется ПОСЛЕ предыдущего. Promise, возвращённый leave/switch, включает
    // именно его запись — нет окна, где caller уже продолжил teardown, а tombstone ещё ждёт в фоне.
    const tracked = (active || Promise.resolve()).catch(() => {}).then(async () => {
      const write = room.localParticipant.setAttributes(next);
      // SDK transports cannot be cancelled, so a timed-out old write may still settle. Reassert
      // the latest desired value after that settlement instead of letting an old vc resurrect.
      void Promise.resolve(write).finally(() => {
        const desired = this.voiceAttrDesired.get(room);
        if (desired && !same(desired, next)) void this.setVoiceAttributes(room, desired);
      }).catch(() => {});
      if (strict) await withVoiceTimeout(write, VOICE_ATTRIBUTE_TIMEOUT_MS, 'voice attributes');
      else {
        try { await withVoiceTimeout(write, VOICE_ATTRIBUTE_TIMEOUT_MS, 'voice attributes'); }
        catch { /** self-heal or a later desired write will repeat */ }
      }
    });
    this.voiceAttrWrites.set(room, tracked);
    const cleanup = () => { if (this.voiceAttrWrites.get(room) === tracked) this.voiceAttrWrites.delete(room); };
    void tracked.then(cleanup, cleanup);
    return tracked;
  }
  private async commitVoiceAttributes(
    room: Room,
    voiceEpoch: number,
    channelId: string,
    deadline = Date.now() + VOICE_JOIN_TIMEOUT_MS,
  ): Promise<boolean> {
    const expected = this.wantedVoiceAttributes(room);
    const expectedLeaseSession = this.voiceLeaseSession;
    const expectedLeaseEpoch = this.voiceLeaseEpoch;
    const matches = () => {
      const actual = room.localParticipant.attributes || {};
      return Object.entries(expected).every(([key, value]) => (actual[key] || '') === value);
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const intentCurrent = () => this.voiceIntentCurrent(voiceEpoch, room, channelId) && this.voiceClaimPending === 0
        && this.voiceLeaseSession === expectedLeaseSession && this.voiceLeaseEpoch === expectedLeaseEpoch;
      if (Date.now() >= deadline || !intentCurrent()) return false;
      try {
        const committed = await voiceWriteCommittedForCurrentIntent(
          this.setVoiceAttributes(room, expected, true),
          deadline,
          'voice attribute commit',
          intentCurrent,
          matches,
        );
        if (!intentCurrent()) return false;
        if (committed) return true;
      } catch { /** retry below while the intent is still current */ }
      if (!intentCurrent()) return false;
      const delay = Math.min(120 * (attempt + 1), Math.max(0, deadline - Date.now()));
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    return false;
  }
  private async commitVoiceTombstone(room: Room, voiceEpoch: number): Promise<void> {
    const expected = { vc: '', deaf: '', vcAt: '', voiceSession: '', voiceEpoch: '' };
    const matches = () => {
      const actual = room.localParticipant.attributes || {};
      return Object.entries(expected).every(([key, value]) => (actual[key] || '') === value);
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      // Новый join/switch уже поставил более свежий intent в ту же очередь: старый leave не имеет
      // права записать tombstone поверх него.
      if (this.voiceEpoch !== voiceEpoch || (this.inVoice && this.voiceRoom === room)) return;
      try {
        await this.setVoiceAttributes(room, expected, true);
        if (matches()) return;
      } catch { /** bounded retry below */ }
      await new Promise((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  private wantedVoiceAttributes(room: Room): Record<string, string> {
    const active = room === this.voiceRoom && this.inVoice && !!this.currentVc && this.voiceClaimPending === 0
      && this.voiceLeaseEpoch > 0 && this.voiceLeaseSession === this.sessionId() && this.voiceLeaseChannel === this.currentVc;
    return {
      vc: active ? this.currentVc! : '',
      deaf: active && this.deafened ? '1' : '',
      // Ручной mute и подтверждённую недоступность транслируем отдельным durable-атрибутом. Временный
      // системный mute публикации при сворачивании iOS PWA не меняет пользовательский интент.
      mic: active && this.localMicMuted() ? '0' : '',
      vcAt: active && this.myVcAt ? String(this.myVcAt) : '',
      voiceSession: active ? this.voiceLeaseSession : '',
      voiceEpoch: active && this.voiceLeaseEpoch > 0 ? String(this.voiceLeaseEpoch) : '',
    };
  }
  private repairSurvivingRoomAudioAfterDisconnect(retiredRoom: Room): void {
    // LiveKit shares one hidden iOS playback element between Room instances, but assigns cleanup
    // ownership to the Room that created it. That owner may disconnect while a view/voice Room is
    // still healthy. Run after the complete Disconnected listener stack (the SDK removes its old
    // element there), then force every exact surviving Room to recreate/rebind playback. Re-read
    // pointers in the microtask: a channel handoff may replace a Room during disconnect cleanup.
    this.audioRepairRetiredRooms.add(retiredRoom);
    if (this.audioRepairScheduled) return;
    this.audioRepairScheduled = true;
    void Promise.resolve().then(() => {
      const retiredRooms = this.audioRepairRetiredRooms;
      this.audioRepairRetiredRooms = new Set();
      this.audioRepairScheduled = false;
      if (!this.engineLifecycleActive) return;
      // The patched LiveKit singleton is ref-counted. If it is still present, a surviving Room
      // already owns its visibility callback and starting audio again would only spend another
      // autoplay attempt. This fallback is for an absent/older singleton implementation.
      if (document.getElementById('livekit-dummy-audio-el')) return;
      for (const room of this.exactOutputRooms()) {
        if (retiredRooms.has(room) || !this.readyRooms.has(room)) continue;
        // A pre-existing ordinary startAudio promise may be the very WebKit operation stranded by
        // the deleted singleton. Fence it once at this physical ownership handoff so repair cannot
        // merely join a promise that can no longer recreate the hidden element.
        this.remoteAudioStarts.forget(room);
        void this.startRoomAudio(room);
      }
    });
  }
  private disconnectRoom(room: Room) {
    this.remoteAudioStarts.forget(room);
    this.reconnectingRooms.delete(room);
    this.reconnecting = this.reconnectingRooms.size > 0;
    this.intentionalDisconnects.add(room);
    try { void room.disconnect(); } catch { /**/ }
  }
  // Self-heal публикации своего vc/deaf. Если опубликованный participant-атрибут не совпадает с
  // текущим состоянием — пере-заявляем. Симптом без этого: initial setAttributes({vc}) в joinVoice
  // мог не долететь до сервера (гонка при оптимистичном входе до готовности комнаты / rate-limit
  // LiveKit на частых апдейтах). Тогда сам юзер видит СЕБЯ в канале (self берётся из currentVc
  // локально), но ВСЕ остальные — нет: они читают participant-атрибут vc (или серверный voiceHint,
  // который тоже строится из атрибута), а он пуст. Ретрай был только на Reconnected — теперь и в 3с-self-heal.
  private selfHealVc() {
    // voiceRoom: держим мой vc=currentVc + deaf, пока в войсе (гонка/rate-limit могли не долить setAttributes).
    if (this.voiceRoom && this.inVoice && this.voiceMediaRoom && this.voiceMediaChannelId === this.currentVc
      && this.voiceMediaActivated.has(this.voiceMediaRoom)) {
      const wantDeaf = this.deafened ? '1' : '';
      const wantMic = this.localMicMuted() ? '0' : '';
      const a = this.voiceRoom.localParticipant.attributes || {};
      if ((a.vc || '') !== (this.currentVc || '') || (a.deaf || '') !== wantDeaf || (a.mic || '') !== wantMic
        || (a.voiceSession || '') !== this.voiceLeaseSession || (a.voiceEpoch || '') !== (this.voiceLeaseEpoch > 0 ? String(this.voiceLeaseEpoch) : '')) {
        if (this.currentVc && !this.myVcAt) this.myVcAt = this.channelStartFor(this.currentVc); // не долетел исходный setAttributes — досчитываем сейчас
        void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
      }
    }
    // viewRoom, ЕСЛИ она НЕ голосовая (смотрю сервер, где не в войсе): моего голоса тут нет → vc/deaf ''
    // (иначе после leaveVoice/браузинга «залипну» в канале у других на этом сервере — vc:'' мог не долететь).
    if (this.viewRoom && this.viewRoom !== this.voiceRoom) {
      const a = this.viewRoom.localParticipant.attributes || {};
      if ((a.vc || '') !== '' || (a.deaf || '') !== '' || (a.mic || '') !== '' || (a.voiceSession || '') !== '' || (a.voiceEpoch || '') !== '')
        void this.setVoiceAttributes(this.viewRoom, this.wantedVoiceAttributes(this.viewRoom));
    }
  }
  private cancelStreamEdge(username: string) {
    const pending = this.streamEdgeTimers.get(username);
    if (pending) window.clearTimeout(pending);
    this.streamEdgeTimers.delete(username);
  }
  private resetStreamEdges() {
    this.streamEdgeGeneration += 1;
    this.streamEdgeTimers.forEach((pending) => window.clearTimeout(pending));
    this.streamEdgeTimers.clear();
    this.streamSources.clear();
    this.stableStreams.clear();
    this.streamStateMessages.clear();
  }
  private publishStreamState(username: string, who: string, live: boolean) {
    const now = Date.now();
    const current = this.streamStateMessages.get(username);
    const baseText = `${who} ${live ? 'начал трансляцию' : 'закончил трансляцию'}`;
    const messageIndex = current
      ? this.messages.findIndex((message) => message.id === current.messageId && message.kind === 'stream-state')
      : -1;
    const hasUserMessageAfter = messageIndex >= 0 && this.messages.slice(messageIndex + 1).some((message) => !message.sys);
    if (current && messageIndex >= 0 && !hasUserMessageAfter && now - current.lastAt <= STREAM_MESSAGE_AGGREGATE_MS) {
      const changes = current.changes + 1;
      const messages = [...this.messages];
      const updated = { ...messages[messageIndex], text: `${baseText} · статус менялся ${changes}×`, ts: now };
      // Keep the aggregate at the same virtual index. Moving an existing key from the middle
      // to the tail without a matching firstItemIndex delta invalidates Virtuoso's size anchor
      // and used to make the viewport jump during noisy stream reconnects.
      messages[messageIndex] = updated;
      this.messages = messages;
      this.streamStateMessages.set(username, { messageId: current.messageId, lastAt: now, changes });
      this.emit();
      return;
    }
    const messageId = this.pushMsg(null, baseText, true, undefined, undefined, undefined, now, undefined, undefined, undefined, undefined, 'stream-state');
    this.streamStateMessages.set(username, { messageId, lastAt: now, changes: 1 });
  }
  private scheduleStreamEdge(username: string, who: string) {
    const current = this.streamEdgeTimers.get(username);
    if (current) window.clearTimeout(current);
    const generation = this.streamEdgeGeneration;
    const serverId = this.viewServerId;
    const id = window.setTimeout(() => {
      this.streamEdgeTimers.delete(username);
      if (generation !== this.streamEdgeGeneration || serverId !== this.viewServerId) return;
      const live = this.isStreaming(username);
      const wasLive = this.stableStreams.has(username);
      if (!live) {
        // Teardown only after the union of LiveKit + tree stayed down through the grace window.
        this.clearWatch(username);
      }
      if (live === wasLive) { this.emit(); return; }
      if (live) {
        this.stableStreams.add(username);
        this.publishStreamState(username, who, true);
        playSound('streamOn');
        this.hooks.toast(who + ' начал трансляцию', 'info');
        notify('stream', { title: who, body: 'начал(а) трансляцию', tag: 'stream:' + this.viewServerId });
      } else {
        this.stableStreams.delete(username);
        this.publishStreamState(username, who, false);
        if (username !== this.me.username) playSound('streamOff');
      }
    }, STREAM_EDGE_GRACE_MS);
    this.streamEdgeTimers.set(username, id);
  }
  private onStreamSourceStart(source: StreamSource, identity: string, silent: boolean) {
    const username = baseUid(identity);
    let sources = this.streamSources.get(username);
    if (!sources) { sources = new Set<string>(); this.streamSources.set(username, sources); }
    const sourceIdentity = `${source}:${identity}`;
    const sourceWasLive = sources.has(sourceIdentity);
    sources.add(sourceIdentity);
    this.emit();
    if (silent) {
      this.cancelStreamEdge(username);
      if (this.isStreaming(username)) this.stableStreams.add(username);
      return;
    }
    if (sourceWasLive) return;
    this.scheduleStreamEdge(username, this.nameOf(username));
  }
  private onStreamSourceStop(source: StreamSource, identity: string) {
    const username = baseUid(identity);
    const sources = this.streamSources.get(username);
    const sourceWasLive = sources?.delete(`${source}:${identity}`) ?? false;
    if (sources && sources.size === 0) this.streamSources.delete(username);
    this.emit();
    if (!sourceWasLive) return;
    // Even if another source is recorded, reconcile against the transports after a short grace;
    // this heals missed/asymmetric reconnect events without emitting false stop/start pairs.
    this.scheduleStreamEdge(username, this.nameOf(username));
  }
  private isStreaming(username: string): boolean {
    if (username === this.me.username) {
      // web self-share (LiveKit) ИЛИ НАТИВНЫЙ self-стрим: его поднимает Rust, web-treeT в дерево НЕ
      // вещает (treeT.isBroadcasting всегда false) — берём из discovery liveStreams (isRemoteBroadcasting),
      // куда сервер шлёт stream-live И самому вещателю. Иначе стример не видел свой LIVE (другие — видели).
      return this.liveKitT.isBroadcasting(username) || this.liveKitT.isRemoteBroadcasting(username) || this.treeT.isRemoteBroadcasting(username);
    }
    return this.liveKitT.isRemoteBroadcasting(username) || this.treeT.isRemoteBroadcasting(username);
  }
  // Публичный предикат «X сейчас вещает» (авто-watch с главной): true ровно когда транспорт,
  // который отдаёт этот стрим, уже объявлен в discovery — тогда watch() выберет ВЕРНЫЙ транспорт.
  isStreamLive(username: string): boolean { return this.isStreaming(username); }
  // Один стрим — один транспорт (не dual-publish): смотрим, откуда реально вещает
  // identity, дерево или LiveKit-комната, и подключаемся тем же транспортом.
  // Для уже открытого watch приоритет у пина (watchT) — объявление могло уже пропасть.
  private transportFor(identity: string): VideoTransport {
    return this.watchT.get(identity) ?? (this.treeT.isRemoteBroadcasting(identity) ? this.treeT : this.liveKitT);
  }
  private nameOf(identity: string): string { const p = this.partOf(identity); return (p && p.name) || identity; }
  private localMicMuted(): boolean {
    return this.manualMute || confirmedMicrophoneUnavailable(this.noMic, this.micBootstrapWanted);
  }
  private micPub(room: Room | null = this.voiceMediaRoom) { return room?.localParticipant.getTrackPublication(Track.Source.Microphone); }
  // Ждём, пока комната реально ПОДКЛЮЧИТСЯ (roomReady). Нужно, когда после свитча серверов WebRTC-connect
  // ещё идёт в фоне: объект Room есть, но публиковать в него нельзя. Резолвит true при готовности, false —
  // на таймауте или если вход отменён (disconnect на свитче сбросил inVoice). Поллинг дёшев (200мс).
  private waitRoomReady(room: Room, voiceEpoch: number, timeoutMs: number): Promise<boolean> {
    if (this.readyRooms.has(room)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = window.setInterval(() => {
        if (this.readyRooms.has(room)) { clearInterval(iv); resolve(true); }
        else if (!this.voiceIntentCurrent(voiceEpoch, room) || Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
      }, 200);
    });
  }

  // Web Audio разрешает запустить новый AudioContext только пока жив пользовательский жест. Сам вход
  // в голос содержит несколько сетевых await (ticket/lease/attributes), поэтому к startMic активация
  // клика уже потеряна. Подготавливаем input, analyser и shared output контексты синхронно в начале
  // первого входа; поздние Room-конструкторы получают тот же уже разблокированный outputCtx.
  private resumeSharedVoiceAudio() {
    // spCtx owns every existing speaking/VAD analyser graph. WebKit's `interrupted` state can be
    // resumed, but replacing that exact context would strand all MediaStreamSource nodes on the old
    // graph. Only a closed/missing context is replaceable; micActx deliberately uses the strict path.
    this.spCtx = resumeSharedGestureAudioContext(this.spCtx, () => new AudioContext());
    const output = this.getOutputContext();
    requestExactAudioContextResume(output, true);
  }
  private prepareVoiceAudio() {
    if (!this.micRaw) this.micActx = resumeGestureAudioContext(this.micActx, () => new AudioContext());
    else requestExactAudioContextResume(this.micActx, true);
    this.resumeSharedVoiceAudio();
  }

  // A second tap can replace a join while its network/microphone awaits are still pending. Create
  // the replacement context while that second gesture is live, then let stopMic atomically preserve
  // it while retiring the old generation. spCtx is shared across generations and is never replaced.
  private prepareReplacementMicContext(): AudioContext | null {
    const prepared = resumeGestureAudioContext<AudioContext>(null, () => new AudioContext());
    this.resumeSharedVoiceAudio();
    return prepared;
  }
  private async discardPreparedMicContext(context: AudioContext | null, clientIntent: number) {
    // A newer join may deliberately inherit this still-gesture-bound context while an older leave
    // tail is resolving. Only the unchanged client intent is allowed to discard unused ownership.
    if (!context || this.voiceClientIntent !== clientIntent || this.micActx !== context || this.micRaw || this.micLocalTrack) return;
    this.micActx = null;
    forgetExactAudioContextResume(context);
    try { await withVoiceTimeout(context.close(), VOICE_CLEANUP_TIMEOUT_MS, 'prepared microphone cleanup'); } catch { /**/ }
  }

  private queueVoiceJoin(channelId: string, serverId: string) {
    const existing = this.pendingVoiceJoin;
    if (existing?.serverId === serverId && existing.channelId === channelId) {
      // A repeated tap is a fresh browser activation, not a no-op. The pending Room may have spent
      // the interval backgrounded, where WebKit suspends (and can close) prepared contexts. Keep
      // the exact intent and its absolute timer, but synchronously revive every context it owns.
      const previousMicContext = this.micActx;
      const previousInitialContext = existing.initialMicContext;
      if (!this.inVoice) {
        this.prepareVoiceAudio();
        if (previousInitialContext && previousInitialContext === previousMicContext) {
          existing.initialMicContext = this.micActx;
        } else if (!previousInitialContext && (!previousMicContext || previousMicContext.state === 'closed')) {
          existing.initialMicContext = this.micActx;
        }
      } else {
        this.resumeSharedVoiceAudio();
      }
      if (existing.replacementMicContext) {
        existing.replacementMicContext = resumeGestureAudioContext(
          existing.replacementMicContext,
          () => new AudioContext(),
        );
      }
      return;
    }
    if (existing) this.cancelPendingVoiceJoin();
    this.beginVoiceDiagnostics('hub');
    const needsReplacement = this.inVoice && (this.voiceConnecting || this.voiceServerId !== serverId);
    const replacementMicContext = needsReplacement ? this.prepareReplacementMicContext() : null;
    // First join still captures the browser's user activation now; the ready Room consumes the same
    // contexts later without creating a gesture-less suspended AudioContext on mobile WebKit.
    const previousMicContext = this.micActx;
    if (!this.inVoice) this.prepareVoiceAudio();
    const initialMicContext = !this.inVoice && !previousMicContext ? this.micActx : null;
    const pending = { serverId, channelId, replacementMicContext, initialMicContext, timer: 0 };
    pending.timer = window.setTimeout(() => {
      if (this.pendingVoiceJoin !== pending) return;
      this.recordVoiceJoinFailure('hub', undefined, 'timed_out');
      this.cancelPendingVoiceJoin(serverId);
      this.hooks.toast('Realtime-связь не поднялась — попробуй войти ещё раз', 'warn');
    }, VOICE_JOIN_TIMEOUT_MS);
    this.pendingVoiceJoin = pending;
    this.hooks.toast('Realtime подключается — войду в канал автоматически', 'info');
  }

  cancelPendingVoiceJoin(serverId?: string) {
    const pending = this.pendingVoiceJoin;
    if (!pending || (serverId && pending.serverId !== serverId)) return;
    this.pendingVoiceJoin = null;
    if (pending.timer) clearTimeout(pending.timer);
    const context = pending.replacementMicContext;
    if (context && context !== this.micActx) {
      forgetExactAudioContextResume(context);
      if (context.state !== 'closed') void context.close().catch(() => {});
    }
    const initial = pending.initialMicContext;
    if (initial && this.micActx === initial && !this.inVoice && !this.micRaw && !this.micLocalTrack) {
      this.micActx = null;
      forgetExactAudioContextResume(initial);
      if (initial.state !== 'closed') void initial.close().catch(() => {});
      this.scheduleLevelMeterAfterVoiceExit(this.voiceEpoch);
    }
    if (!this.inVoice) this.resetVoiceDiagnostics();
  }

  private flushPendingVoiceJoin(room: Room, serverId: string) {
    const pending = this.pendingVoiceJoin;
    if (!pending || pending.serverId !== serverId || this.viewRoom !== room || !this.readyRooms.has(room)
      || this.reconnectingRooms.has(room)) return;
    this.pendingVoiceJoin = null;
    if (pending.timer) clearTimeout(pending.timer);
    void this.joinVoice(pending.channelId, pending.replacementMicContext);
  }

  /* ---------- VOICE join/leave/switch (несколько каналов на сервер) ---------- */
  // подключиться к голосовому каналу channelId; если уже в другом — переключиться без переподнятия микрофона
  async joinVoice(channelId: string, preparedReplacementContext?: AudioContext | null) {
    const targetRoom = this.viewRoom;
    const targetServer = this.viewServerId; // вход в голос — на СМОТРИМОМ сервере (его каналы в ServerView)
    if (!channelId || !targetServer) return;
    // Settings preview and voice capture must never own the physical microphone concurrently.
    // This is synchronous and therefore also cancels a preview gUM still pending on mobile WebKit.
    this.stopLevelMeter();
    // REST renders channels before the background LiveKit connection is stable. A pending or failed
    // Room is replaceable by store retry and must never become voiceRoom for an optimistic join.
    if (!targetRoom || !this.readyRooms.has(targetRoom) || this.reconnectingRooms.has(targetRoom)) {
      this.queueVoiceJoin(channelId, targetServer);
      return;
    }
    this.cancelPendingVoiceJoin(targetServer);
    // уже в голосовом на ЭТОМ же сервере → только смена канала (мик остаётся)
    if (this.inVoice && this.voiceServerId === targetServer) {
      if (this.currentVc === channelId && !this.voiceConnecting) return;
      if (!this.voiceConnecting) { await this.switchVoice(channelId); return; }
    }
    // Only a real replacement/new join owns reconnect state. A no-op tap on the current channel
    // must not make UI/PTT look healthy while its media room is still reconnecting.
    this.voiceReconnecting = false;
    // This is intentionally before ticket creation and every await: mobile WebKit only lets the
    // replacement AudioContext inherit user activation synchronously from this tap. Cross-server
    // teardown also closes the old pipeline, so it carries the same prepared ownership through leave.
    const replacingVoiceJoin = this.inVoice && this.voiceConnecting;
    const crossingVoiceServer = this.inVoice && this.voiceServerId !== targetServer;
    const replacingPendingJoin = replacingVoiceJoin && this.voiceRoom === targetRoom;
    const needsReplacementContext = replacingVoiceJoin || crossingVoiceServer;
    const replacementMicContext = needsReplacementContext
      ? (preparedReplacementContext !== undefined ? preparedReplacementContext : this.prepareReplacementMicContext())
      : null;
    if (!needsReplacementContext && preparedReplacementContext && preparedReplacementContext !== this.micActx) {
      forgetExactAudioContextResume(preparedReplacementContext);
      if (preparedReplacementContext.state !== 'closed') void preparedReplacementContext.close().catch(() => {});
    }
    // Важно вызвать ДО первого await и только для первого входа: текущий рабочий pipeline при переходе
    // между серверами трогать нельзя. Для уже разблокированной голосовой сессии остаётся обычный startMic.
    if (!this.inVoice) this.prepareVoiceAudio();
    if (crossingVoiceServer) this.finishVoiceDiagnostics();
    this.beginVoiceDiagnostics('intent');
    this.recordVoiceDiagnostic({ kind: 'hub_connected', stage: 'hub', outcome: 'ok', ...this.voiceDiagnosticState() });
    this.setVoiceDiagnosticJoinStage('intent');
    // в голосовом на ДРУГОМ сервере → покидаем его (Discord: молча переносим голос сюда)
    const session = this.sessionId(targetRoom);
    const clientIntent = ++this.voiceClientIntent;
    const joinDeadline = Date.now() + VOICE_JOIN_TIMEOUT_MS;
    let ticketFailure: unknown;
    // Start the global device/tab ordering fence before teardown, room-ready
    // waits, attributes or microphone setup can delay the eventual claim.
    const ticketPromise = session
      ? withVoiceDeadline(
        api.mintVoiceIntent(session, targetServer, channelId, clientIntent),
        joinDeadline,
        'voice intent ticket',
      ).catch((error) => { ticketFailure = error; return null; })
      : Promise.resolve(null);
    if (this.inVoice && this.voiceServerId !== targetServer) {
      await this.leaveVoice(replacementMicContext, true);
      // Пока завершался teardown A пользователь мог уже открыть C. Не публикуем голос в случайную комнату.
      if (this.viewRoom !== targetRoom || this.viewServerId !== targetServer || this.voiceClientIntent !== clientIntent) {
        await this.discardPreparedMicContext(replacementMicContext, clientIntent);
        this.scheduleLevelMeterAfterVoiceExit(this.voiceEpoch);
        return;
      }
    }
    const epoch = ++this.voiceEpoch;
    this.invalidateMicRecoveryOwner();
    this.clearVoiceReconnectRecovery();
    const disruptionAtStart = this.voiceTransportDisruptionSeq;
    this.voiceClaimPending = epoch; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    this.clearVoicePermissionRecovery();
    const replacedMedia = replacingPendingJoin ? this.voiceMediaRoom : null;
    const replacedPendingMedia = replacingPendingJoin ? this.pendingVoiceMediaRoom : null;
    this.currentVc = channelId;
    this.myVcAt = null;
    this.voicePresenceConfirmed = false;
    this.inVoice = true; this.clearPttOwnership(); // manualMute НЕ сбрасываем — пред-установка мута применяется на входе
    this.voiceConnecting = true;
    // Until the channel transport and durable hub presence are confirmed, the safe state is
    // listen-only. Microphone bootstrap runs independently after that boundary.
    this.noMic = true;
    this.micHadCapture = false;
    this.micBootstrapWanted = true;
    this.voiceRoom = targetRoom;         // реюз коннекта смотримого сервера как голосового (без второго соединения)
    this.voiceServerId = targetServer;
    targetRoom.remoteParticipants.forEach((p) => this.observeVoiceSession(p));
    this.liveKitT.setBroadcastRoom?.(this.voiceRoom); // браузер вещает в ГОЛОСОВУЮ комнату (не в смотримую при браузинге)
    // Состав канала сеем СРАЗУ, а не после всей сетевой части входа: между установкой currentVc и
    // концом join проходят секунды (ticket, lease, gUM, RNNoise, publish), и любой reconcile в этом
    // окне (таймер 3с, смена атрибутов пира) сравнивал новый канал с ПУСТЫМ составом — заходящий
    // слышал залп entry по всем, кто уже сидел. А вход соседа именно в этом окне, наоборот, глох.
    this.reconcileChannelSounds(true);
    this.emit(); // ОПТИМИСТИЧНО: канал виден сразу, но spinner/timer ждут подтверждённые lease + media + attrs
    // Быстрый A→B во время gUM/публикации инвалидирует старый pipeline прежде, чем создаём новый.
    if (replacingPendingJoin) {
      this.voiceMediaRoom = null; this.pendingVoiceMediaRoom = null; this.voiceMediaChannelId = null;
      await this.stopMic(replacedMedia, replacementMicContext);
      if (replacedMedia) this.disconnectRoom(replacedMedia);
      if (replacedPendingMedia && replacedPendingMedia !== replacedMedia) this.disconnectRoom(replacedPendingMedia);
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
        await this.discardPreparedMicContext(replacementMicContext, clientIntent);
        return;
      }
    }
    // viewRoom мог ещё подниматься (фоновый connect после свитча, ретраи ~9.5с): объект Room есть, но не
    // подключён (roomReady=false). Публикация mic/vc в неподнятую комнату молча провалилась бы — «зашёл»
    // по UI, по факту нет. Ждём готовности, показывая «подключение»; не поднялась за таймаут — откат.
    if (!this.readyRooms.has(targetRoom)) {
      const ready = await this.waitRoomReady(targetRoom, epoch, Math.min(15_000, Math.max(0, joinDeadline - Date.now())));
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
      if (!ready) {
        this.recordVoiceJoinFailure('hub', undefined, 'timed_out');
        this.hooks.toast('Realtime-связь не поднялась — попробуй ещё раз', 'warn');
        await this.leaveVoice(); // clears spinner/ownership synchronously; SDK cleanup remains bounded
        return;
      }
    }
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
    const ticketEvent = await ticketPromise;
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId) || this.voiceClientIntent !== clientIntent) return;
    const ticketAccepted = !!ticketEvent && ticketEvent.accepted !== false
      && Number.isSafeInteger(ticketEvent.ticket) && ticketEvent.ticket > 0;
    this.recordVoiceDiagnostic({
      kind: 'intent_finished', stage: 'intent', outcome: ticketAccepted ? 'ok' : 'failed',
      ...(ticketAccepted ? { code: 'none' as const } : classifyVoiceDiagnosticError(ticketFailure)),
      joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
    });
    if (!ticketAccepted || !ticketEvent) {
      if (this.voiceClaimPending === epoch) this.voiceClaimPending = 0;
      this.recordVoiceJoinFailure('intent', ticketFailure);
      this.hooks.toast('Не удалось согласовать вход между устройствами — попробуй ещё раз', 'warn');
      await this.leaveVoice();
      return;
    }
    let leaseEvent: VoiceLeaseEvent | null = null;
    let claimFailure: unknown;
    this.setVoiceDiagnosticJoinStage('claim');
    const claimPromise = api.claimVoiceLease(session, targetServer, channelId, clientIntent, ticketEvent.ticket);
    this.watchLateVoiceClaim(claimPromise, targetRoom, epoch, clientIntent, session, targetServer, channelId, joinDeadline);
    try {
      leaseEvent = await withVoiceDeadline(
        claimPromise,
        Math.min(joinDeadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
        'voice lease claim',
      );
    }
    catch (error) {
      claimFailure = error;
      // POST мог дойти, а ответ потеряться. Snapshot не меняет owner и позволяет безопасно понять,
      // был ли claim принят, вместо создания «невидимой» серверной аренды.
      try {
        leaseEvent = await withVoiceDeadline(
          api.getVoiceLease(),
          Math.min(joinDeadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
          'voice lease recovery',
        );
      } catch { /**/ }
    }
    const claimResult = this.finishVoiceClaim(epoch, leaseEvent);
    leaseEvent = claimResult.response;
    const deferredLease = claimResult.deferred;
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
      const staleLease = leaseEvent?.lease;
      if ((leaseEvent?.reason === 'claimed' || leaseEvent?.reason === 'idempotent') && leaseEvent.accepted !== false && staleLease
        && staleLease.sessionId === session && staleLease.serverId === targetServer && staleLease.channelId === channelId) {
        void api.releaseVoiceLease(session, staleLease.epoch).catch(() => {});
      }
      return;
    }
    if (!leaseEvent || !this.acceptVoiceLease(leaseEvent, targetServer, channelId)) {
      this.recordVoiceJoinFailure('claim', claimFailure);
      this.hooks.toast('Не удалось закрепить голосовую сессию — попробуй ещё раз', 'warn');
      await this.leaveVoice();
      return;
    }
    this.recordVoiceDiagnostic({
      kind: 'lease_claimed', stage: 'claim', outcome: 'ok', code: 'none',
      joinElapsedMs: this.voiceDiagnosticJoinElapsed(), ...this.voiceDiagnosticState(),
    });
    if (deferredLease) {
      this.onVoiceLease(deferredLease);
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
    }
    const mediaRoom = await this.connectVoiceMediaRoom(targetRoom, epoch, targetServer, channelId, joinDeadline);
    if (!mediaRoom || !this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
      if (this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
        this.hooks.toast(this.voiceMediaFailureText(
          epoch,
          'Не удалось подключить защищённый голосовой канал — попробуй ещё раз',
        ), 'warn');
        await this.leaveVoice();
      }
      return;
    }
    this.voiceMediaRoom = mediaRoom; this.pendingVoiceMediaRoom = null; this.voiceMediaChannelId = channelId;
    mediaRoom.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, mediaRoom, true)));
    // vcAt is required in the committed attributes, but build() hides it until the same commit
    // succeeds. A pending join therefore cannot start a local channel timer behind the spinner.
    this.myVcAt = this.channelStartFor(channelId);
    // deaf по пред-установке — сразу заявляем пирам (иначе зашёл «оглохшим», а бейджа deaf у них нет)
    if (!await this.commitVoiceAttributes(targetRoom, epoch, channelId, joinDeadline)) {
      if (this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
        this.recordVoiceJoinFailure('activation');
        this.hooks.toast('Не удалось синхронизировать голос — подключись ещё раз', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId) || this.voiceClaimPending !== 0) return;
    if (!await this.verifyVoiceTransactionBoundary(
      targetRoom,
      mediaRoom,
      epoch,
      channelId,
      disruptionAtStart,
      joinDeadline,
    )) {
      if (this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
        this.recordVoiceJoinFailure('activation', undefined,
          Date.now() >= joinDeadline ? 'timed_out' : 'failed');
        this.hooks.toast('Голосовой канал не восстановился — подключись ещё раз', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId) || this.voiceClaimPending !== 0
      || !this.voiceMediaActivated.has(mediaRoom)) return;
    // Claim отправляем ДО медленного gUM/RNNoise: окно с двумя активными устройствами минимально.
    this.lastVclaim = Date.now();
    this.dataSend({ t: 'vclaim', uid: this.me.id, session, epoch: this.voiceLeaseEpoch });
    // Media + lease-backed hub presence is the actual channel boundary. Microphone capture is a
    // separate, bounded bootstrap: a denied or stuck gUM/RNNoise/publish leaves an honest
    // listen-only connection and can never keep the channel spinner alive.
    this.voicePresenceConfirmed = true;
    this.reconcileAllAudio(); // подписываемся на пиров этого же канала (bootstrap мик-подписок)
    this.reconcileChannelSounds(); // состав уже посеян в начале join — тут озвучиваем тех, кто зашёл ПОКА я входил
    this.startConnPoll();
    this.voiceConnecting = false;
    this.lostVoiceServerId = null; this.lostVoiceChannel = null;
    playSound('entry'); // сам зашедший тоже слышит вход (остальные в канале — через onRemotePub)
    this.completeVoiceDiagnosticJoin();
    this.emit();
    void this.finishInitialMic(epoch, targetRoom, mediaRoom, channelId);
  }

  private async finishInitialMic(voiceEpoch: number, hub: Room, mediaRoom: Room, channelId: string) {
    if (!this.micBootstrapWanted || !this.voiceMediaIntentCurrent(voiceEpoch, hub, mediaRoom, channelId)) return;
    const foregroundGeneration = this.micForegroundGeneration;
    try {
      const started = await this.startMicWithDefaultFallback(
        voiceEpoch,
        'Сохранённый микрофон недоступен — включён системный',
      );
      if (!this.voiceMediaIntentCurrent(voiceEpoch, hub, mediaRoom, channelId)) return;
      if (!started) {
        // Hidden-page deferral and a newer exact owner retain responsibility. An ownerless false
        // result, however, is a completed listen-only failure; leaving bootstrapWanted set would
        // show an endless recovery state and swallow the next explicit retry.
        if (initialMicrophoneResultIsDeferred({
          foregroundChanged: foregroundGeneration !== this.micForegroundGeneration,
          foregroundPending: this.micForegroundRecoveryPending,
          startOwned: this.micStartOwnership.active,
          recoveryOwned: this.micRecoveryOwner !== 0,
          hasExactPublication: this.hasExactCurrentMicPublication(),
        })) {
          this.ensureVoiceAudioRunning();
          return;
        }
        this.recordVoiceMicFailure('mic_capture');
        this.micBootstrapWanted = false;
        this.micForegroundRecoveryPending = false;
        this.noMic = true;
        this.micRetryAt = Date.now() + 5_000;
        this.micFailureNotified = true;
        void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
        this.hooks.toast('Микрофон недоступен — ты в канале, но тебя не слышно', 'warn');
        this.emit();
        this.ensureVoiceAudioRunning();
        return;
      }
      this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
      void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
      this.emit();
    } catch (error) {
      if (!this.voiceMediaIntentCurrent(voiceEpoch, hub, mediaRoom, channelId)) return;
      // A hidden gUM owner can time out after foreground already installed a newer exact pipeline.
      // Its late failure owns neither UI nor attributes.
      if (foregroundGeneration !== this.micForegroundGeneration || this.micStartOwnership.active
        || this.micRecoveryOwner !== 0 || this.hasExactCurrentMicPublication()) return;
      this.recordVoiceMicFailure('mic_capture', error);
      this.noMic = true;
      const resumeDeferredBackgroundStart = isVoiceOperationTimeout(error) && this.micForegroundRecoveryPending;
      if (!resumeDeferredBackgroundStart) {
        this.micBootstrapWanted = false;
        this.micForegroundRecoveryPending = false;
      }
      this.micRetryAt = Date.now() + 5000; this.micFailureNotified = true;
      void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
      if (!resumeDeferredBackgroundStart)
        this.hooks.toast('Микрофон недоступен — ты в канале, но тебя не слышно', 'warn');
      this.emit();
      if (resumeDeferredBackgroundStart) void this.checkMicAlive(false);
    }
  }
  // перейти в другой голосовой канал того же сервера: микрофон остаётся, меняются подписки и стримы
  async switchVoice(channelId: string) {
    if (!this.voiceRoom || !this.voiceMediaRoom || !this.inVoice || this.currentVc === channelId) return;
    const previousChannel = this.currentVc;
    const previousPresenceConfirmed = this.voicePresenceConfirmed;
    const room = this.voiceRoom;
    const previousMediaRoom = this.voiceMediaRoom;
    const permissionRecovery = this.voicePermissionRecovery;
    const previousPermissionDeadline = permissionRecovery?.room === previousMediaRoom
      && permissionRecovery.voiceEpoch === this.voiceEpoch ? permissionRecovery.deadline : null;
    // If the user switches channels while the first permission request is still pending, the old
    // start owns (and will dispose) the AudioContext prepared by the original tap. Prepare the new
    // intent's context synchronously under this tap, before any ticket/lease await loses activation.
    if (this.micBootstrapWanted && !this.micLocalTrack && this.micActx?.state === 'closed') {
      forgetExactAudioContextResume(this.micActx);
      this.micActx = null;
    }
    const replacementMicContext = this.micBootstrapWanted && !this.micLocalTrack && !this.micActx
      ? this.prepareReplacementMicContext()
      : null;
    const epoch = ++this.voiceEpoch; // старый async voice-intent больше не может дописать прежний канал
    this.invalidateMicRecoveryOwner();
    this.clearVoiceReconnectRecovery();
    const disruptionAtStart = this.voiceTransportDisruptionSeq;
    if (this.micStartOwnership.active) {
      // A pending permission/publish operation belongs to the old exact channel. Its underlying
      // browser promise cannot be cancelled, but it must not block bootstrap for the new intent.
      ++this.micEpoch;
      this.micStartOwnership.invalidate();
    }
    if (replacementMicContext) this.micActx = replacementMicContext;
    this.voiceClaimPending = epoch; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    this.clearVoicePermissionRecovery();
    const serverId = this.voiceServerId;
    const session = this.sessionId(room);
    const clientIntent = ++this.voiceClientIntent;
    const switchDeadline = Date.now() + VOICE_JOIN_TIMEOUT_MS;
    const ticketPromise = session && serverId
      ? withVoiceDeadline(
        api.mintVoiceIntent(session, serverId, channelId, clientIntent),
        switchDeadline,
        'voice switch ticket',
      ).catch(() => null)
      : Promise.resolve(null);
    this.currentVc = channelId;
    this.myVcAt = this.channelStartFor(channelId);
    this.voicePresenceConfirmed = false;
    this.voiceConnecting = true;
    this.clearPttOwnership();
    this.reconcileChannelSounds(true); // состав НОВОГО канала — молча и сразу (иначе reconcile в окне свитча даст залп entry)
    // Пока сервер решает, кому принадлежит аккаунт, старый uplink молчит и старый vc снимается.
    // Это делает A→B атомарным для слушателей: никто не услышит речь в уже покинутом канале.
    this.applyGate();
    this.reconcileAllAudio();
    void this.setVoiceAttributes(room, this.wantedVoiceAttributes(room));
    this.emit();
    const ticketEvent = await ticketPromise;
    if (!this.voiceIntentCurrent(epoch, room, channelId) || this.voiceClientIntent !== clientIntent) return;
    if (!ticketEvent || ticketEvent.accepted === false || !Number.isSafeInteger(ticketEvent.ticket) || ticketEvent.ticket < 1) {
      const unfinishedClaim = this.finishVoiceClaim(epoch, null);
      this.currentVc = previousChannel;
      this.myVcAt = this.currentVc ? this.channelStartFor(this.currentVc) : null;
      // Notify may have arrived while the switch claim was fenced. Apply the newest authoritative
      // event only after restoring A: a foreign/released lease synchronously starts leaveVoice,
      // while a current local A lease safely refreshes its epoch before attributes can reopen.
      const deferredLease = unfinishedClaim.deferred || unfinishedClaim.response;
      if (deferredLease) {
        this.onVoiceLease(deferredLease);
        if (!this.voiceIntentCurrent(epoch, room, this.currentVc || undefined)) return;
      }
      let recoveryDeadline: number | null = null;
      const lateRecovery = this.voicePermissionRecovery;
      const latePermissionDeadline = lateRecovery?.room === previousMediaRoom && lateRecovery.voiceEpoch === epoch
        ? lateRecovery.deadline : null;
      if (previousPermissionDeadline != null && latePermissionDeadline != null)
        recoveryDeadline = Math.min(previousPermissionDeadline, latePermissionDeadline);
      else recoveryDeadline = previousPermissionDeadline ?? latePermissionDeadline;
      const oldMediaRevoked = !this.mediaPermissionsActive(previousMediaRoom) || !this.voiceMediaActivated.has(previousMediaRoom);
      if (this.currentVc && (oldMediaRevoked || recoveryDeadline != null)) {
        this.clearVoicePermissionRecovery();
        recoveryDeadline = this.beginVoicePermissionRecovery(previousMediaRoom, epoch, recoveryDeadline ?? Date.now() + 20_000);
      }
      if (!this.currentVc || !await this.commitVoiceAttributes(room, epoch, this.currentVc, switchDeadline)) {
        if (this.voiceIntentCurrent(epoch, room)) await this.leaveVoice();
        return;
      }
      if (!await this.verifyVoiceTransactionBoundary(
        room,
        previousMediaRoom,
        epoch,
        this.currentVc,
        disruptionAtStart,
        recoveryDeadline == null ? switchDeadline : Math.min(switchDeadline, recoveryDeadline),
      )) {
        if (this.voiceIntentCurrent(epoch, room, this.currentVc)) await this.leaveVoice();
        return;
      }
      if (!this.voiceIntentCurrent(epoch, room, this.currentVc) || !this.voiceMediaActivated.has(previousMediaRoom)) return;
      this.voicePresenceConfirmed = previousPresenceConfirmed;
      this.voiceConnecting = false;
      this.applyGate();
      this.reconcileAllAudio();
      this.hooks.toast('Не удалось согласовать переключение между устройствами — попробуй ещё раз', 'warn');
      this.emit();
      if (this.micBootstrapWanted && !this.micLocalTrack && this.currentVc)
        void this.finishInitialMic(epoch, room, previousMediaRoom, this.currentVc);
      return;
    }
    let leaseEvent: VoiceLeaseEvent | null = null;
    const switchClaimPromise = serverId
      ? api.claimVoiceLease(session, serverId, channelId, clientIntent, ticketEvent.ticket)
      : null;
    if (switchClaimPromise && serverId) {
      this.watchLateVoiceClaim(switchClaimPromise, room, epoch, clientIntent, session, serverId, channelId, switchDeadline);
    }
    try {
      if (switchClaimPromise) {
        leaseEvent = await withVoiceDeadline(
          switchClaimPromise,
          Math.min(switchDeadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
          'voice switch claim',
        );
      }
    }
    catch {
      try {
        leaseEvent = await withVoiceDeadline(
          api.getVoiceLease(),
          Math.min(switchDeadline, Date.now() + VOICE_OPERATION_TIMEOUT_MS),
          'voice switch recovery',
        );
      } catch { /**/ }
    }
    const claimResult = this.finishVoiceClaim(epoch, leaseEvent);
    leaseEvent = claimResult.response;
    const deferredLease = claimResult.deferred;
    if (!this.voiceIntentCurrent(epoch, room, channelId)) {
      const staleLease = leaseEvent?.lease;
      if ((leaseEvent?.reason === 'claimed' || leaseEvent?.reason === 'idempotent') && leaseEvent.accepted !== false && staleLease && serverId
        && staleLease.sessionId === session && staleLease.serverId === serverId && staleLease.channelId === channelId) {
        void api.releaseVoiceLease(session, staleLease.epoch).catch(() => {});
      }
      return;
    }
    if (!serverId || !leaseEvent || !this.acceptVoiceLease(leaseEvent, serverId, channelId)) {
      this.hooks.toast('Не удалось переключить голосовой канал', 'warn');
      // Без подтверждённого lease нельзя безопасно «откатиться»: за время запроса владельцем могло
      // стать другое устройство. Полный локальный выход исключает раздвоение звука.
      await this.leaveVoice();
      return;
    }
    if (deferredLease) {
      this.onVoiceLease(deferredLease);
      if (!this.voiceIntentCurrent(epoch, room, channelId)) return;
    }
    const nextMediaRoom = await this.connectVoiceMediaRoom(room, epoch, serverId, channelId, switchDeadline);
    if (!nextMediaRoom || !this.voiceIntentCurrent(epoch, room, channelId)) {
      if (this.voiceIntentCurrent(epoch, room, channelId)) {
        this.hooks.toast(this.voiceMediaFailureText(epoch, 'Не удалось подключить новый голосовой канал'), 'warn');
        await this.leaveVoice();
      }
      return;
    }
    this.clearVoicePermissionRecovery(previousMediaRoom, epoch);
    this.voiceMediaRoom = nextMediaRoom; this.pendingVoiceMediaRoom = null; this.voiceMediaChannelId = channelId;
    this.subscriptionRetries.clear();
    this.clearVoiceAudio();
    const transferred = await withVoiceDeadline(
      this.transferMicPublication(previousMediaRoom, nextMediaRoom, epoch, room, channelId),
      switchDeadline,
      'voice microphone transfer',
    ).catch(() => false);
    this.disconnectRoom(previousMediaRoom);
    if (!transferred || !this.voiceMediaIntentCurrent(epoch, room, nextMediaRoom, channelId)) {
      if (this.voiceIntentCurrent(epoch, room, channelId)) {
        this.hooks.toast('Не удалось перенести микрофон в новый канал', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    nextMediaRoom.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, nextMediaRoom, true)));
    if (!await this.commitVoiceAttributes(room, epoch, channelId, switchDeadline)) {
      if (this.voiceIntentCurrent(epoch, room, channelId)) {
        this.hooks.toast('Не удалось синхронизировать канал', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    if (!this.voiceIntentCurrent(epoch, room, channelId) || this.voiceClaimPending !== 0) return;
    if (!await this.verifyVoiceTransactionBoundary(
      room,
      nextMediaRoom,
      epoch,
      channelId,
      disruptionAtStart,
      switchDeadline,
    )) {
      if (this.voiceIntentCurrent(epoch, room, channelId)) {
        this.hooks.toast('Голосовой канал не восстановился после переключения', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    if (!this.voiceIntentCurrent(epoch, room, channelId) || this.voiceClaimPending !== 0
      || !this.voiceMediaActivated.has(nextMediaRoom)) return;
    this.voicePresenceConfirmed = true;
    this.voiceLeaseVerifying = false;
    this.voiceConnecting = false;
    // A reconnect event from the retired media room may have set the aggregate flag during the
    // handoff. Successful switch state is derived only from the new active media room and hub.
    this.reconnectingRooms.delete(previousMediaRoom);
    this.reconnecting = this.reconnectingRooms.size > 0;
    this.voiceReconnecting = this.reconnectingRooms.has(room) || this.reconnectingRooms.has(nextMediaRoom);
    this.applyGate();
    this.lastVclaim = Date.now();
    this.dataSend({ t: 'vclaim', uid: this.me.id, session, epoch: this.voiceLeaseEpoch });
    this.reconcileAllAudio();
    this.reconcileChannelSounds(); // состав посеян в начале свитча — тут озвучиваем зашедших за время переключения
    playSound('entry');
    this.emit();
    if (this.micBootstrapWanted && !this.micLocalTrack)
      void this.finishInitialMic(epoch, room, nextMediaRoom, channelId);
  }
  async leaveVoice(replacementMicContext: AudioContext | null = null, suppressLevelPreview = false) {
    if (!this.voiceRoom || !this.inVoice) return;
    // Cross-server handoff already closed the previous report and opened the replacement attempt
    // before its intent ticket was minted. Every other exit terminates the current diagnostic session.
    if (!suppressLevelPreview) this.finishVoiceDiagnostics();
    const epoch = ++this.voiceEpoch;
    this.invalidateMicRecoveryOwner();
    this.clearVoiceReconnectRecovery();
    this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    this.clearVoicePermissionRecovery();
    const vr = this.voiceRoom; // фиксируем: ниже обнулим указатель (и, возможно, порвём комнату)
    const vmr = this.voiceMediaRoom;
    const pendingMedia = this.pendingVoiceMediaRoom;
    this.voiceMediaRoom = null; this.pendingVoiceMediaRoom = null; this.voiceMediaChannelId = null;
    if (vmr) this.voiceMediaActivated.delete(vmr);
    if (pendingMedia && pendingMedia !== vmr) this.disconnectRoom(pendingMedia);
    const leaseSession = this.voiceLeaseSession;
    const leaseEpoch = this.voiceLeaseEpoch;
    this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
    if (leaseSession && leaseEpoch > 0) void api.releaseVoiceLease(leaseSession, leaseEpoch).catch(() => {}); // stale release сервер безопасно отвергнет
    // оптимистично: сразу убираем себя из канала (UI не ждёт async-очистку mic/треков)
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.voiceReconnecting = false; this.clearPttOwnership(); this.myVcAt = null; this.voicePresenceConfirmed = false; this.noMic = false; this.micHadCapture = false; this.micBootstrapWanted = false; // deafened/manualMute НЕ сбрасываем — персист-интент до след. входа
    this.myChannelPeers.clear(); // вышел — состав моего канала сброшен (другие услышат мой выход по unpub мика / vc'')
    playSound('exit'); // сам вышедший тоже слышит выход (остальные в канале — через onRemoteUnpub)
    this.emit();
    this.stopConnPoll();
    this.subscriptionRetries.clear();
    this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
    // Трек и vc очищаем СРАЗУ, до любых медленных await. Иначе leave кратко воскресал через старый
    // self-heal/setAttributes, а быстрый новый join мог быть уничтожен поздним хвостом этого leave.
    const micStop = this.stopMic(vmr, replacementMicContext);
    const attrStop = this.commitVoiceTombstone(vr, epoch);
    const shareStop = this.stopShare().catch(() => {}); // browser-share (LiveKit)
    this.hooks.endBroadcast?.();            // нативная трансляция (Rust-дерево) — тоже гасим
    vmr?.remoteParticipants.forEach((p) => {
      const rp = p.getTrackPublication(Track.Source.Microphone);
      if (rp) { try { (rp as any).setSubscribed(false); } catch { /**/ } }
      this.removeVoiceAudio(baseUid(p.identity), p.identity, undefined, vmr);
    });
    // Сносим мик-аудиоэлементы сразу (origin=voice), не ждём async onUnsub. Стрим-аудио (origin=view)
    // НЕ трогаем — стрим смотрится и без голосового (и может жить в ДРУГОЙ, смотримой комнате).
    document.querySelectorAll('#audioSink audio[data-origin="voice"]').forEach((a) => a.remove());
    this.clearVoiceAudio();
    try {
      await withVoiceTimeout(Promise.allSettled([micStop, attrStop, shareStop]), VOICE_CLEANUP_TIMEOUT_MS, 'voice leave cleanup');
    } catch { /** state and ownership were cleared synchronously above */ }
    if (vmr) this.disconnectRoom(vmr);
    if (vr !== this.viewRoom && vr !== this.voiceRoom) this.disconnectRoom(vr);
    if (this.voiceEpoch !== epoch || this.voiceRoom !== vr) return; // за teardown уже начался новый join
    // голосовая комната была voice-only (я смотрю ДРУГОЙ сервер) → рвём её; если это смотримая — оставляем как viewRoom
    if (vr !== this.viewRoom) this.disconnectRoom(vr);
    this.voiceRoom = null; this.voiceServerId = null;
    this.liveKitT.setBroadcastRoom?.(null); // вне голоса — вещание падает на смотримую комнату (fallback)
    // Screen audio remains owned by LiveKit's webAudioMix after leaving voice too. Unmuting the
    // attached SDK element here created a second, full-volume path around master/deafen/stream gain.
    this.applyAllStreamVolumes();
    this.emit();
    if (!suppressLevelPreview) this.scheduleLevelMeterAfterVoiceExit(epoch);
  }

  dismissLostVoice() {
    if (!this.lostVoiceServerId && !this.lostVoiceChannel) return;
    this.lostVoiceServerId = null;
    this.lostVoiceChannel = null;
    this.emit();
  }

  /* ---------- качество связи в голосовом (индикатор + пинг) ---------- */
  private startConnPoll() {
    if (this.connTimer) return;
    document.addEventListener('visibilitychange', this.onVoiceVisible);
    window.addEventListener('pageshow', this.onVoiceVisible);
    window.addEventListener('focus', this.onVoiceFocus);
    window.addEventListener('pagehide', this.onVoicePageHide);
    window.addEventListener('online', this.onVoiceNetworkChanged);
    window.addEventListener('offline', this.onVoiceNetworkChanged);
    if (document.hidden) this.markVoiceHidden();
    else this.voiceDiagnosticStallMonitor.start();
    this.pollPing();
    this.connTimer = window.setInterval(() => this.pollPing(), 2500);
  }
  private stopConnPoll() {
    ++this.voiceStatsGeneration;
    document.removeEventListener('visibilitychange', this.onVoiceVisible);
    window.removeEventListener('pageshow', this.onVoiceVisible);
    window.removeEventListener('focus', this.onVoiceFocus);
    window.removeEventListener('pagehide', this.onVoicePageHide);
    window.removeEventListener('online', this.onVoiceNetworkChanged);
    window.removeEventListener('offline', this.onVoiceNetworkChanged);
    this.voiceDiagnosticStallMonitor.stop();
    if (this.connTimer) { clearInterval(this.connTimer); this.connTimer = null; }
    this.voiceHiddenAt = 0; this.micForegroundRecoveryPending = false;
    this.hiddenMicStartOwner = 0; this.hiddenMicRecoveryOwner = 0;
    this.pingMs = null; this.connQuality = 'unknown'; this.voiceLeaseAuditTick = 0;
  }
  private async auditVoiceLease() {
    if (this.voiceLeaseAuditRunning || this.voiceLeaseVerifying || this.voiceClaimPending !== 0) return;
    const room = this.voiceRoom, voiceEpoch = this.voiceEpoch, serverId = this.voiceServerId, channelId = this.currentVc;
    if (!room || !serverId || !channelId || !this.voiceIntentCurrent(voiceEpoch, room, channelId)) return;
    this.voiceLeaseAuditRunning = true;
    try {
      const event = await api.getVoiceLease();
      if (!this.voiceIntentCurrent(voiceEpoch, room, channelId)) return;
      if (this.acceptVoiceLease(event, serverId, channelId)) {
        this.onVoiceLease(event);
        return;
      }
      this.onVoiceLease(event);
      if (this.voiceIntentCurrent(voiceEpoch, room, channelId)) await this.leaveVoice();
    } catch { /** transient API failure: next watchdog tick retries; current fence remains unchanged */ }
    finally { this.voiceLeaseAuditRunning = false; }
  }
  private voiceDiagnosticStatsTrack(room: Room): object | null {
    const local = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    // LiveKit can use separate publisher and subscriber PeerConnections. While somebody should be
    // audible, sample that exact receiver before our local sender; publisher candidate traffic is
    // not evidence that the remote voice reached this client. Otherwise keep uplink/RTT sampling.
    let fallback: RemoteTrack | null = null;
    for (const participant of room.remoteParticipants.values()) {
      const username = baseUid(participant.identity);
      if (username === this.me.username || participant !== this.mediaPartOf(username, room)
        || this.muteSet(this.voiceServerId).has(username) || this.voiceUserVolOf(username) <= 0) continue;
      const publication = participant.getTrackPublication(Track.Source.Microphone);
      const remote = publication?.track as RemoteTrack | undefined;
      if (!publication || !remote || publication.isMuted || (publication as any).isUpstreamPaused
        || remote.mediaStreamTrack.readyState === 'ended') continue;
      fallback ||= remote;
      if (participant.isSpeaking || this.speakingSet.has(username)) return remote;
    }
    if (local && (local as any).mediaStreamTrack?.readyState !== 'ended') return local;
    // Listen-only/noMic still gets bounded RTC observation while a quiet channel is idle.
    return fallback;
  }
  // RTT до сервера из уже выбранного sender/receiver getStats, фолбэк — candidate-pair
  private async pollPing() {
    // Watchdog: контекст публикации мика мог родиться/остаться 'suspended' (getUserMedia-промпт съел
    // user-activation) → пиры не слышат, хотя локально «всё работает». Держим его running, пока в войсе.
    if (this.inVoice && ((this.micActx && this.micActx.state !== 'running') || (this.spCtx && this.spCtx.state !== 'running')
      || (this.outputCtx && this.outputCtx.state !== 'running')
      || this.voiceMediaRoom?.canPlaybackAudio === false)) this.ensureVoiceAudioRunning();
    if (this.inVoice) void this.checkMicAlive(true); // мобилка: пере-снять мик, если источник умер на бэкграунде
    if (this.inVoice && ++this.voiceLeaseAuditTick % 4 === 0) void this.auditVoiceLease();
    if (this.inVoice) this.ensureRemoteVoicePlayback();
    this.observeVoiceDiagnosticMuteState();
    const room = this.voiceMediaRoom;
    const track = room ? this.voiceDiagnosticStatsTrack(room) : null;
    if (!this.inVoice || !room || !track || this.voiceStatsInFlight) return;
    const owner = { room, track, voiceEpoch: this.voiceEpoch, generation: this.voiceStatsGeneration };
    this.voiceStatsInFlight = owner;
    try {
      // Promise.resolve().then also converts a synchronous SDK/browser throw into this bounded
      // operation, so the owner is always released by the exact finally below.
      const rep: RTCStatsReport | undefined = await Promise.resolve().then(() => (track as any).getRTCStatsReport());
      const currentTrack = this.voiceDiagnosticStatsTrack(room);
      if (!this.inVoice || this.voiceStatsGeneration !== owner.generation || this.voiceEpoch !== owner.voiceEpoch
        || this.voiceMediaRoom !== room || currentTrack !== track || !rep) return;
      let rtt: number | null = null, cand: number | null = null;
      rep.forEach((s: any) => {
        if (s.type === 'remote-inbound-rtp' && s.roundTripTime != null) rtt = s.roundTripTime;
        if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && s.currentRoundTripTime != null) cand = s.currentRoundTripTime;
      });
      const v = rtt ?? cand;
      this.recordVoiceRtcSample(rep, v == null ? null : v * 1_000, track);
      let changed = false;
      // Гистерезис: раньше ЛЮБОЕ изменение округлённого пинга поднимало флаг, а значит каждые 2.5с
      // пересобирался весь снапшот и перерисовывался интерфейс ради колебания 41→42 мс. Показываем
      // число всё равно приблизительно, поэтому будим подписчиков только на заметный сдвиг.
      if (v != null) {
        const next = Math.round(v * 1000);
        if (this.pingMs == null || Math.abs(next - this.pingMs) >= 5) { this.pingMs = next; changed = true; }
        else this.pingMs = next; // значение обновляем всегда, ре-рендер не заказываем
      }
      // Качество читаем НАПРЯМУЮ из localParticipant.connectionQuality, а не ждём событие
      // ConnectionQualityChanged: оно приходит лишь при СМЕНЕ качества, поэтому при стабильной
      // связи с самого старта метка залипала на «соединение…» (unknown), хотя пинг уже шёл.
      const lp = room.localParticipant;
      let cq: VoiceQuality = lp?.connectionQuality != null ? mapQuality(lp.connectionQuality) : 'unknown';
      // Метка учитывает и потери (LiveKit), и ЗАДЕРЖКУ (RTT): берём худшее. Иначе при большом пинге
      // без потерь показывалось «отличное» (LiveKit quality латентность не видит). Цель голоса ≤250мс.
      // Заодно покрывает старый кейс «LiveKit ещё unknown, но RTT есть» (worse(unknown, pq) = pq).
      // 'lost' (полный обрыв от LiveKit) пингом не перебиваем.
      if (v != null && cq !== 'lost') {
        const ms = v * 1000;
        const pq: VoiceQuality = ms < 120 ? 'excellent' : ms < 250 ? 'good' : 'poor';
        cq = worseVoiceQuality(cq, pq);
      }
      if (cq !== this.connQuality) { this.connQuality = cq; changed = true; }
      if (changed) this.emit();
    } catch { /** a failed stats sample is cosmetic; the next settled tick may retry */ }
    finally {
      if (this.voiceStatsInFlight === owner) this.voiceStatsInFlight = null;
    }
  }

  /* ---------- MIC / DEAFEN / PTT ---------- */
  // Уважаем сохранённые echo/auto-gain настройки; браузерный NS — только в режиме 'basic'
  // (в 'rnnoise' его выключаем, чтобы не было каскада с нашей нейросетью).
  // deviceId через { exact } — иначе браузер игнорит выбор и берёт устройство по умолчанию
  // channelCount:1 — важно не только для экономии полосы: RnnoiseWorkletNode сконструирована на
  // maxChannels:1 (см. denoise.ts), а реальные микрофоны часто отдают gUM-поток 2-канальным по
  // умолчанию (даже физически моно-капсюль). При рассинхроне channel count шумодав обрабатывает
  // только часть каналов — второй проходит необработанным и может доминировать в RMS/метре.
  private micCapture() {
    const s = getSettings();
    return {
      deviceId: s.input ? { exact: s.input } : undefined,
      echoCancellation: s.ec,
      noiseSuppression: s.nsMode === 'basic',
      autoGainControl: s.agc,
      channelCount: 1,
    };
  }

  private voiceCaptureUnavailable(): boolean {
    // pagehide may enter BFCache before WebKit updates document.hidden (or without a matching
    // visibilitychange). voiceHiddenAt is therefore an equal capture fence, not just telemetry.
    return document.hidden || this.voiceHiddenAt > 0;
  }

  private hasExactCurrentMicPublication(): boolean {
    const room = this.voiceMediaRoom;
    const track = this.micLocalTrack;
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    return !!room && !!track && this.voiceMediaChannelId === this.currentVc
      && this.voiceMediaActivated.has(room) && publication?.track === track;
  }

  private hasHealthyCurrentMicTransport(): boolean {
    const room = this.voiceMediaRoom;
    const track = this.micLocalTrack;
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const health = microphoneTransportHealth(
      this.micRaw?.getAudioTracks()[0],
      track?.mediaStreamTrack,
      publication?.track === track,
      publication?.isUpstreamPaused === true,
      track?.isMuted === true || publication?.isMuted === true,
    );
    return !!room && !!track && this.voiceMediaChannelId === this.currentVc
      && this.voiceMediaActivated.has(room) && !health.ended && !health.muted && !health.upstreamPaused;
  }

  private fenceMicForCaptureRecovery(
    hub: Room | null = this.voiceRoom,
    retainAvailability = retainMicAvailabilityDuringRecovery(this.micHadCapture, this.noMic),
  ) {
    const changed = retainAvailability || (!retainAvailability && !this.noMic) || this.pttDown;
    if (!retainAvailability) this.noMic = true;
    this.clearPttOwnership();
    this.applyGate();
    if (hub && hub === this.voiceRoom && this.inVoice) void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
    if (changed) this.emit();
  }

  // Device IDs are not durable on mobile browsers: permissions, OS upgrades and reconnecting a
  // Bluetooth headset can rotate them. A stale explicit selection must fall back to the system
  // route instead of turning an otherwise valid voice join into permanent listen-only mode.
  private async startMicBeforeDeadline(expectedVoiceEpoch: number, deadline: number): Promise<boolean> {
    // startMic runs synchronously until its first await, so this captures the exact generation it
    // created (or the existing pipeline generation used for a republish).
    const attempt = this.startMic(expectedVoiceEpoch);
    const attemptMicEpoch = this.micEpoch;
    try { return await withVoiceDeadline(attempt, deadline, 'microphone start'); }
    catch (error) {
      // A late gUM/RNNoise/publish completion must only dispose its local resources. Invalidating
      // its generation prevents a timed-out join from publishing after the UI already moved on.
      if (isVoiceOperationTimeout(error) && this.micEpoch === attemptMicEpoch) {
        ++this.micEpoch;
        this.micStartOwnership.invalidate(attemptMicEpoch);
      }
      throw error;
    }
  }

  private async startMicWithDefaultFallback(
    expectedVoiceEpoch: number,
    fallbackToast?: string,
    deadline = Date.now() + VOICE_MIC_START_TIMEOUT_MS,
  ): Promise<boolean> {
    const selectedInput = getSettings().input;
    const foregroundGeneration = this.micForegroundGeneration;
    const attempt = this.startMicBeforeDeadline(expectedVoiceEpoch, deadline);
    const attemptMicEpoch = this.micEpoch;
    try { return await attempt; }
    catch (error) {
      if (!selectedInput || !selectedInputUnavailable(error)) throw error;
      // A late NotFound from the pre-background/pre-device-change owner must not erase the user's
      // newer selection or launch a second fallback capture over the current pipeline.
      if (foregroundGeneration !== this.micForegroundGeneration || this.micEpoch !== attemptMicEpoch
        || getSettings().input !== selectedInput || expectedVoiceEpoch !== this.voiceEpoch) return false;
      setSettings({ input: '' });
      const started = await this.startMicBeforeDeadline(expectedVoiceEpoch, deadline);
      if (started && fallbackToast) this.hooks.toast(fallbackToast, 'warn');
      return started;
    }
  }

  private async publishExistingMic(room: Room, expectedVoiceEpoch: number, hub: Room, channel: string): Promise<boolean> {
    const track = this.micLocalTrack;
    if (!track) return false;
    const preserveForegroundRecovery = this.micForegroundRecoveryPending || this.voiceCaptureUnavailable();
    const micOp = this.micEpoch;
    const current = () => this.micEpoch === micOp && this.micLocalTrack === track
      && track.mediaStreamTrack.readyState !== 'ended'
      && this.voiceMediaIntentCurrent(expectedVoiceEpoch, hub, room, channel) && this.voiceMediaActivated.has(room);
    const hidden = () => {
      if (!this.voiceCaptureUnavailable() || !current()) return false;
      this.micForegroundRecoveryPending = true;
      this.fenceMicForCaptureRecovery(hub);
      return true;
    };
    if (!current()) return false;
    const existing = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (existing?.track === track) return !hidden() && current();
    if (existing?.track) {
      try { await room.localParticipant.unpublishTrack(existing.track, true); } catch { /** publish below is authoritative */ }
      if (hidden()) return false;
      if (!current()) return false;
    }
    try {
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone, dtx: true, red: true, forceStereo: false, audioPreset: AudioPresets.music,
      });
    } catch (error) {
      if (hidden()) return false;
      this.recordVoiceMicFailure('mic_publish', error);
      return false;
    }
    if (hidden()) {
      try { await room.localParticipant.unpublishTrack(track, false); } catch { /** foreground recovery owns retirement */ }
      return false;
    }
    if (!current()) {
      // A timeout may have handed the same still-live track to a newer retry in the same room.
      // Never let the late attempt unpublish that newer owner's valid publication.
      if (this.micLocalTrack !== track || !this.voiceMediaIntentCurrent(expectedVoiceEpoch, hub, room, channel)) {
        try { await room.localParticipant.unpublishTrack(track, false); } catch { /** stale room is torn down by its owner */ }
      }
      return false;
    }
    if ((this.manualMute || this.deafened) !== track.isMuted) {
      try { await ((this.manualMute || this.deafened) ? track.mute() : track.unmute()); } catch { /** gate remains authoritative */ }
    }
    if (hidden()) {
      try { await room.localParticipant.unpublishTrack(track, false); } catch { /** foreground recovery owns retirement */ }
      return false;
    }
    if (current()) {
      this.micHadCapture = true;
      this.micBootstrapWanted = false;
      if (!preserveForegroundRecovery) this.micForegroundRecoveryPending = false;
      this.recordVoiceDiagnostic({
        kind: 'mic_published', stage: 'mic_publish', outcome: 'ok', code: 'none',
        ...this.voiceDiagnosticState(), trackState: 'live', publicationMuted: track.isMuted,
      });
      return true;
    }
    if (this.micLocalTrack !== track || !this.voiceMediaIntentCurrent(expectedVoiceEpoch, hub, room, channel)) {
      try { await room.localParticipant.unpublishTrack(track, false); } catch { /** newer owner controls room teardown */ }
    }
    return false;
  }

  private async transferMicPublication(oldRoom: Room, newRoom: Room, voiceEpoch: number, hub: Room, channel: string): Promise<boolean> {
    const track = this.micLocalTrack;
    if (!track) return true; // listen-only channel switch
    if (track.mediaStreamTrack.readyState === 'ended') return false;
    const oldPublication = oldRoom.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (oldPublication?.track === track) {
      try { await oldRoom.localParticipant.unpublishTrack(track, false); }
      catch { /** server lease eviction may already have removed the old publication */ }
    }
    if (!this.voiceMediaIntentCurrent(voiceEpoch, hub, newRoom, channel)) return false;
    return this.publishExistingMic(newRoom, voiceEpoch, hub, channel);
  }

  // строим цепочку: устройство -> [denoise?] -> preGate -> gain (микс/мут) -> published track
  //                                                     \-> vadDest (VAD/метр, ДО гейта — иначе
  //                                                         гейт слушает уже замолченный gain=0 сигнал
  //                                                         и залипает закрытым)
  private async startMic(expectedVoiceEpoch = this.voiceEpoch): Promise<boolean> {
    if (this.voiceCaptureUnavailable()) {
      // WebKit cannot reliably start capture in a hidden PWA. Preserve the user's request and let
      // the foreground lifecycle perform exactly one current-intent attempt instead.
      this.micForegroundRecoveryPending = true;
      return false;
    }
    const room = this.voiceMediaRoom;
    const hub = this.voiceRoom;
    const channel = this.currentVc;
    if (!room || !hub || !channel || !this.voiceMediaIntentCurrent(expectedVoiceEpoch, hub, room, channel)
      || !this.voiceMediaActivated.has(room)) return false;
    if (this.micStartOwnership.active) return false;
    const op = ++this.micEpoch;
    if (!this.micStartOwnership.begin(op)) return false;
    try {
    const current = () => op === this.micEpoch && this.voiceMediaIntentCurrent(expectedVoiceEpoch, hub, room, channel)
      && this.voiceMediaActivated.has(room);
    const armHiddenRecovery = () => {
      if (!current()) return;
      this.micForegroundRecoveryPending = true;
      this.hiddenMicStartOwner = op;
      if (this.micRecoveryOwner) this.hiddenMicRecoveryOwner = this.micRecoveryOwner;
      this.fenceMicForCaptureRecovery(hub);
    };
    const hiddenAfterAwait = async (unpublish: boolean, dispose?: (unpublish: boolean) => Promise<void>): Promise<boolean> => {
      if (!this.voiceCaptureUnavailable()) return false;
      armHiddenRecovery();
      if (dispose) await dispose(unpublish);
      return true;
    };
    if (this.micRaw && this.micActx && this.micLocalTrack) {
      const published = this.micPub(room)?.track === this.micLocalTrack
        || await this.publishExistingMic(room, expectedVoiceEpoch, hub, channel);
      if (this.voiceCaptureUnavailable()) {
        armHiddenRecovery();
        if (published && this.micLocalTrack) {
          try { await room.localParticipant.unpublishTrack(this.micLocalTrack, false); } catch { /** foreground recovery retires it */ }
        }
        return false;
      }
      if (published && current()) {
        this.micHadCapture = true;
        this.micBootstrapWanted = false;
        this.micForegroundRecoveryPending = false;
        this.noMic = false;
        return true;
      }
      return false;
    }
    // Publication могла пережить сбой локального AudioContext. Перед новым pipeline обязательно ждём
    // её удаления — одновременно две mic publications дают разным слушателям разные «первые» треки.
    const stalePublication = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (stalePublication) {
      try { await room.localParticipant.unpublishTrack(stalePublication, true); } catch { /**/ }
      if (this.voiceCaptureUnavailable()) { armHiddenRecovery(); return false; }
      if (!current()) return false;
    }
    let raw: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let denoise: RnnoiseWorkletNode | null = null;
    let vadDest: MediaStreamAudioDestinationNode | null = null;
    let gain: GainNode | null = null;
    let lat: LocalAudioTrack | null = null;
    let disposed = false;
    const dispose = async (unpublish: boolean) => {
      if (disposed) return;
      disposed = true;
      const waits: Promise<unknown>[] = [];
      if (unpublish && lat) {
        try { waits.push(room.localParticipant.unpublishTrack(lat, true)); } catch { /** local stop below is authoritative */ }
      }
      if (lat) { try { lat.stop(); } catch { /**/ } }
      raw?.getTracks().forEach((t) => t.stop());
      destroyDenoiseNode(denoise);
      if (vadDest) { try { vadDest.disconnect(); } catch { /**/ } }
      if (ctx) {
        forgetExactAudioContextResume(ctx);
        try { waits.push(ctx.close()); } catch { /**/ }
      }
      try {
        await withVoiceTimeout(Promise.allSettled(waits), VOICE_CLEANUP_TIMEOUT_MS, 'stale microphone pipeline cleanup');
      } catch { /** local tracks/nodes were already retired synchronously */ }
    };
    // Первый вход и ручная смена устройства заранее создают контекст непосредственно в обработчике
    // клика (prepareVoiceAudio/reapplyMic): после сетевых await пользовательская активация уже потеряна.
    // Автовосстановление без пользовательского жеста создаёт новый контекст здесь и страхуется unlock.
    try {
      ctx = (!this.micRaw && this.micActx) || new AudioContext();
      if (this.micActx === ctx) this.micActx = null; // pipeline локален до успешного publish/commit
      requestExactAudioContextResume(ctx);
      if (await hiddenAfterAwait(false, dispose)) return false;
      if (!current()) { await dispose(false); return false; }
      // spCtx тоже заранее подготавливается на первом входе: именно его анализатор открывает VAD-гейт.
      // При восстановлении без подготовленного контекста resume + gesture-unlock/watchdog остаются подстраховкой.
      if (this.spCtx?.state === 'closed') {
        forgetExactAudioContextResume(this.spCtx);
        this.spCtx = null;
      }
      this.spCtx = this.spCtx || new AudioContext();
      requestExactAudioContextResume(this.spCtx);
      if (await hiddenAfterAwait(false, dispose)) return false;
      if (!current()) { await dispose(false); return false; }
    } catch (error) {
      await dispose(false);
      if (!current()) return false;
      this.recordVoiceMicFailure('mic_capture', error);
      throw error;
    }
    if (this.voiceCaptureUnavailable()) {
      armHiddenRecovery();
      await dispose(false);
      return false;
    }
    try {
      const finishCapture = beginMicrophoneCapture();
      try {
        raw = await navigator.mediaDevices.getUserMedia({ audio: this.micCapture() });
        finishCapture();
      } catch (error) {
        finishCapture(error);
        throw error;
      }
    } catch (e) {
      if (this.voiceCaptureUnavailable() && current()) {
        this.recordVoiceDiagnostic({
          kind: 'mic_capture_finished', stage: 'mic_capture', outcome: 'cancelled', code: 'aborted',
          ...this.voiceDiagnosticState(),
        });
        armHiddenRecovery();
        await dispose(false);
        return false;
      }
      await dispose(false);
      if (!current()) return false;
      this.recordVoiceMicFailure('mic_capture', e);
      throw e;
    }
    this.recordVoiceDiagnostic({
      kind: 'mic_capture_finished', stage: 'mic_capture', outcome: 'ok', code: 'none',
      ...this.voiceDiagnosticState(), micEnabled: raw.getAudioTracks()[0]?.enabled === true, trackState: 'live',
    });
    if (await hiddenAfterAwait(false, dispose)) return false;
    if (!current()) { await dispose(false); return false; }
    let preGate: AudioNode;
    try {
      const src = ctx.createMediaStreamSource(raw);
      preGate = src;
      if (getSettings().nsMode === 'rnnoise') {
        denoise = await createDenoiseNode(ctx);
        if (await hiddenAfterAwait(false, dispose)) return false;
        if (!current()) { await dispose(false); return false; }
        if (denoise) {
          src.connect(denoise);
          // RnnoiseWorkletNode(maxChannels:1) реально пишет обработанный сигнал только в канал 0
          // своего выхода — канал 1 остаётся тишиной. Без явного сплита узел ниже по графу видит
          // "2-канальный" выход с тишиной в правом, и апмикс на publish даёт звук в одно (левое) ухо.
          // ChannelSplitterNode().connect(next) без явного output-индекса берёт ИМЕННО output 0 —
          // чистый моно-сигнал канала 0, который затем штатно дублируется в оба канала на publish.
          const split = ctx.createChannelSplitter(2);
          denoise.connect(split);
          preGate = split;
        }
        else this.hooks.toast('Шумодав недоступен — звук без обработки', 'warn');
      }
      gain = ctx.createGain();
      gain.gain.value = 0; // до commit/applyGate не выпускаем звук из ещё не подтверждённого pipeline
      preGate.connect(gain);
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      // VAD/метр — отвод ДО гейта (preGate), НЕ от micGain: гейт решает лишь что публикуется наружу,
      // а не что видит сам детектор речи.
      vadDest = ctx.createMediaStreamDestination();
      preGate.connect(vadDest);
      lat = new LocalAudioTrack(dest.stream.getAudioTracks()[0]);
    } catch (error) {
      await dispose(false);
      if (!current()) return false;
      this.recordVoiceMicFailure('mic_capture', error);
      throw error;
    }
    // Мьютим ДО publish (обязательно await — LocalAudioTrack.mute асинхронный, берёт свой lock):
    // AddTrackRequest несёт muted, поэтому SFU и все пиры сразу видят мут. Раньше трек публиковался
    // незамьюченным и глушился отдельным запросом следом — на каждом рестарте мика watchdog-ом у пиров
    // мигал бейдж «мик включился», а сам пользователь слышал щелчок мута, ничего не нажимая.
    if (this.manualMute || this.deafened) { try { await lat.mute(); } catch { /**/ } }
    if (await hiddenAfterAwait(false, dispose)) return false;
    if (!current()) { await dispose(false); return false; }
    try {
      await room.localParticipant.publishTrack(lat, {
        source: Track.Source.Microphone,
        dtx: true,
        red: true,
        forceStereo: false,
        audioPreset: AudioPresets.music,
      });
    } catch (error) {
      if (this.voiceCaptureUnavailable() && current()) {
        this.recordVoiceDiagnostic({
          kind: 'mic_published', stage: 'mic_publish', outcome: 'cancelled', code: 'aborted',
          ...this.voiceDiagnosticState(),
        });
        armHiddenRecovery();
        await dispose(false);
        return false;
      }
      await dispose(false);
      if (!current()) return false;
      this.recordVoiceMicFailure('mic_publish', error);
      throw error;
    }
    this.recordVoiceDiagnostic({
      kind: 'mic_published', stage: 'mic_publish', outcome: 'ok', code: 'none',
      ...this.voiceDiagnosticState(), trackState: 'live', publicationMuted: lat.isMuted,
    });
    if (await hiddenAfterAwait(true, dispose)) return false;
    if (!current()) { await dispose(true); return false; }
    // Состояние мута могло смениться, пока шёл publish (пользователь кликнул мик) — досводим.
    if ((this.manualMute || this.deafened) !== lat.isMuted) {
      try { await ((this.manualMute || this.deafened) ? lat.mute() : lat.unmute()); } catch { /**/ }
    }
    if (await hiddenAfterAwait(true, dispose)) return false;
    if (!current() || this.voiceCaptureUnavailable()) {
      if (this.voiceCaptureUnavailable()) armHiddenRecovery();
      await dispose(true);
      return false;
    }
    // Коммитим pipeline только после успешного publish и последней проверки generation. Старый async
    // хвост никогда не перезапишет ресурсы более свежего микрофона.
    this.micRaw = raw;
    this.micActx = ctx;
    this.micGain = gain;
    this.micDenoise = denoise;
    this.micVadDest = vadDest;
    this.micLocalTrack = lat;
    this.micHadCapture = true;
    this.micBootstrapWanted = false;
    this.micForegroundRecoveryPending = false;
    this.watchMicTracks(raw.getAudioTracks()[0], lat.mediaStreamTrack);
    this.micLevelAt = performance.now(); // отсчёт протухания стартует с момента запуска мика, а не с нуля
    this.startVadWatchdog();
    // индикатор «говорит» + VAD на rAF-анализаторе — сразу (рабочий на переднем плане и на время загрузки
    // ворклета); как только VAD-ворклет поднимется, он перехватит vadOpen и снимет свой мик со spLoop.
    this.attachAnalyser(this.me.username, vadDest.stream.getAudioTracks()[0]);
    this.applyGate();
    this.ensureVoiceAudioRunning(); // добить, если контекст всё ещё suspended (анлок на первый жест + watchdog)
    this.noMic = false;
    // VAD на аудио-потоке (не на rAF): гейт активации голосом должен работать и в фоновой вкладке, где
    // requestAnimationFrame заморожен и spLoop не двигал бы vadOpen (микрофон молча гейтился в тишину).
    void this.setupVadWorklet(ctx, preGate, op);
    return true;
    } finally {
      this.micStartOwnership.finish(op);
    }
  }
  // Поднять VAD-ворклет и передать ему владение vadOpen. Тап строго на preGate (после денойза, канал 0),
  // не на micGain — иначе детектор слушал бы уже замолченный (gain=0) сигнал и залипал закрытым. При
  // неудаче (нет AudioWorklet / гонка stop во время addModule) остаёмся на rAF-анализаторе spLoop.
  private async setupVadWorklet(ctx: AudioContext, preGate: AudioNode, epoch: number) {
    const vad = await createVadNode(ctx);
    if (!vad) return; // фолбэк: spLoop двигает vadOpen с rAF-анализатора + фейл-опен по vadStale
    if (this.micEpoch !== epoch || this.micActx !== ctx) { destroyVadNode(vad); return; } // мик пересобран/остановлен
    const node = vad.node;
    try {
      preGate.connect(node); // тап строго на preGate (после денойза, канал 0), НЕ на micGain
      node.port.onmessage = (e) => {
        if (this.micVadNode !== vad) return;
        // Первое сообщение = ворклет реально обрабатывает (0-output leaf гарантированно пуллится этим
        // движком) → передаём ему владение vadOpen и снимаем rAF-анализатор своего мика со spLoop, чтобы
        // не дублировать расчёт. Если ворклет вдруг не заработал бы — spLoop так и остаётся драйвером
        // (фолбэк без регрессии). spLoop продолжает вести индикаторы «говорит» у ЧУЖИХ пиров.
        if (this.analysers.has(this.me.username)) this.detachAnalyser(this.me.username, true); // keepSpeaking: applyLocalLevel ниже ведёт индикатор дальше без лишнего edge
        const rms = typeof e.data === 'number' ? e.data : Number.NaN;
        // Malformed worklet data is "no measurement", not silence: ignoring it lets vadStale()
        // fail open instead of repeatedly closing the user's microphone.
        if (Number.isFinite(rms) && rms >= 0) this.applyLocalLevel(rms);
      };
      this.micVadNode = vad;
    } catch { destroyVadNode(vad); this.micVadNode = null; }
  }
  // Обработка уровня своего мика из VAD-ворклета: порог/хвост/шумовой фон + гейт + индикатор «говорю».
  // Дублирует ветку isMe в spLoop, но с хвостом по времени (такт ворклета ≠ такту rAF).
  private applyLocalLevel(rms: number) {
    const db = rmsToDb(rms);
    const norm = dbToNorm(db);
    const threshold = this.thresholdNorm();
    const on = norm >= threshold;
    const now = performance.now();
    const wasStale = this.vadStale(); // гейт мог стоять в фейл-опене — после свежего замера пересчитать обязательно
    this.micLevelAt = now; // замер свежий → гейт снова верит своему решению (см. vadStale)
    if (on) this.selfSpeakUntil = now + VAD_HOLD_MS;
    const spk = on || now < this.selfSpeakUntil;
    this.updateNoiseFloor(db); // подъём медленный — фраза не продавит, постоянный шум со временем перекроет
    this.levelListeners.forEach((f) => f(norm, spk, threshold));
    if (spk !== this.vadOpen || wasStale) { this.vadOpen = spk; this.applyGate(); }
    const me = this.me.username;
    if (spk && !this.speakingSet.has(me)) { this.speakingSet.add(me); this.emit(); }
    else if (!spk && this.speakingSet.has(me)) { this.speakingSet.delete(me); this.emit(); }
  }
  // Гарантирует, что контекст ПУБЛИКАЦИИ микрофона (micActx) реально запущен. Браузер держит
  // AudioContext 'suspended' до пользовательского жеста в контексте страницы; startMic создаёт
  // контекст ПОСЛЕ await getUserMedia (+ промпт) → активация потеряна, контекст молчит, пиры не
  // слышат (а зелёный VAD-индикатор от отдельного spCtx работает — потому баг незаметен локально).
  // Полный перезаход «чинил» через sticky-activation. Резюмируем сразу + разовый анлок на первый
  // жест; conn-watchdog (pollPing) добивает, если контекст уснул повторно.
  private resumeRemoteAudioPlayback(explicitGesture = false, gestureToken = 0, refreshSdkFallbackRooms = false) {
    if (this.outputMixerNeedsRecovery()) this.beginOutputContextRecovery(explicitGesture, gestureToken);
    if (explicitGesture || (this.outputCtx && this.outputCtx.state !== 'running'))
      requestExactAudioContextResume(this.outputCtx, explicitGesture);
    // Output-context recovery owns its exact rooms. Outside it, startAudio is a repair operation,
    // not a heartbeat: LiveKit walks every remote audio track on each call.
    if (!this.outputRecovery) {
      new Set([this.viewRoom, this.voiceRoom, this.voiceMediaRoom].filter(Boolean)).forEach((candidate) => {
        const room = candidate as Room;
        // When Engine could not construct the shared mixer, boolean webAudioMix lets LiveKit own
        // a private context. WebKit can suspend that context in a backgrounded PWA without updating
        // canPlaybackAudio or pausing the element, so one bounded real foreground edge must force
        // startAudio to re-read/recreate it even when the cached flags still look healthy.
        if (explicitGesture || room.canPlaybackAudio === false
          || (refreshSdkFallbackRooms && room.options.webAudioMix === true))
          void this.startRoomAudio(room, explicitGesture, gestureToken);
      });
    }
    [...this.voiceAudioEls.values(), ...this.screenAudioEls.values()].forEach(({ el }) => {
      if (!explicitGesture && !el.paused) return;
      this.remoteAudioPlays.request(el, (current) => current.play(), explicitGesture, () => {
        if (!this.remoteAudioPlaybackBlocked()) this.clearRemoteAudioUnlock();
      }, gestureToken);
    });
  }
  private startRoomAudio(room: Room, explicitGesture = false, gestureToken = 0): Promise<boolean> {
    const attempt = this.remoteAudioStarts.acquire(
      room,
      (current) => {
        try { return current.startAudio(); }
        catch (error) { return Promise.reject(error); }
      },
      explicitGesture,
      () => {
        if (room !== this.viewRoom && room !== this.voiceRoom && room !== this.voiceMediaRoom) return;
        // Defense in depth for an SDK upgrade that changes its private mixer implementation:
        // startAudio must never remain the last writer of a participant's gain.
        if (room === this.voiceMediaRoom) this.applyAllVolumes();
        if (room === this.viewRoom) this.applyAllStreamVolumes();
      },
      gestureToken,
    );
    return attempt.outcome;
  }
  private remoteAudioPlaybackBlocked() {
    return !!this.outputRecovery || this.outputMixerNeedsRecovery()
      || (!!this.outputCtx && this.outputCtx.state !== 'running')
      || (this.screenAudioEls.size > 0 && this.viewRoom?.canPlaybackAudio === false)
      || (this.voiceAudioEls.size > 0 && this.voiceMediaRoom?.canPlaybackAudio === false)
      || [...this.voiceAudioEls.values(), ...this.screenAudioEls.values()].some(({ el }) => el.paused);
  }
  private clearRemoteAudioUnlock() {
    this.remoteAudioUnlock?.();
    this.remoteAudioUnlock = null;
    this.clearVoicePlaybackBlocked();
  }
  private ensureRemoteAudioPlayback(refreshSdkFallbackRooms = false) {
    if (!refreshSdkFallbackRooms && !this.remoteAudioPlaybackBlocked()) { this.clearRemoteAudioUnlock(); return; }
    this.resumeRemoteAudioPlayback(false, 0, refreshSdkFallbackRooms);
    if (!this.remoteAudioPlaybackBlocked()) { this.clearRemoteAudioUnlock(); return; }
    this.recordVoicePlaybackBlocked();
    if (this.remoteAudioUnlock) return;
    const gestures = new AudioUnlockGestureDeduper();
    const unlock = (event: Event) => {
      if (!gestures.accept(event)) return;
      this.resumeRemoteAudioPlayback(true, currentAudioUnlockGestureToken());
      if (!this.remoteAudioPlaybackBlocked()) this.clearRemoteAudioUnlock();
    };
    this.remoteAudioUnlock = () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
      document.removeEventListener('click', unlock, true);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('touchstart', unlock, true);
    document.addEventListener('click', unlock, true);
  }
  private ensureVoiceAudioRunning() {
    const resume = (explicitGesture = false, gestureToken = 0) => {
      requestExactAudioContextResume(this.micActx, explicitGesture);
      requestExactAudioContextResume(this.spCtx, explicitGesture);
      this.resumeRemoteAudioPlayback(explicitGesture, gestureToken);
    };
    resume();
    // ОБА контекста должны быть running: micActx = публикуемый звук, spCtx = VAD-гейт (без него gain залипает 0).
    // Раньше гейт стоял только на micActx → после его пред-резюма gesture-unlock не ставился, а spCtx оставался спящим.
    const running = () => (!this.micActx || this.micActx.state === 'running') && (!this.spCtx || this.spCtx.state === 'running')
      && (!this.outputCtx || this.outputCtx.state === 'running') && this.voiceMediaRoom?.canPlaybackAudio !== false;
    if (this.audioUnlock || running()) return;
    const gestures = new AudioUnlockGestureDeduper();
    const unlock = (event: Event) => {
      if (!gestures.accept(event)) return;
      resume(true, currentAudioUnlockGestureToken());
      if (running()) this.clearAudioUnlock();
    };
    this.audioUnlock = () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
      document.removeEventListener('click', unlock, true);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('touchstart', unlock, true);
    document.addEventListener('click', unlock, true);
  }
  private clearAudioUnlock() { if (this.audioUnlock) { this.audioUnlock(); this.audioUnlock = null; } }
  // Мобилка: свернул PWA (ушёл в TG) → на переднем плане gUM-источник мог УМЕРЕТЬ: iOS закрывает
  // захват перманентно (readyState='ended'), часть Android держит «залипший» muted. micActx резюмит
  // watchdog, но мёртвый источник шлёт ТИШИНУ в publish-destination → пиры не слышат (сам слышишь
  // всех — downstream цел). Лечение — пере-снять мик (re-getUserMedia). ended рестартим сразу; muted
  // даём время пережить обычную смену системного маршрута и рестартим только устойчивое состояние.
  private micRecoverySeq = 0;
  private micRecoveryOwner = 0;
  private micMutedAt = 0;
  private micRetryAt = 0;
  private micFailureNotified = false;
  private clearMicTrackLifecycle() {
    ++this.micMuteWriteSeq;
    this.micUnmuteWriteOwner = 0;
    this.micTrackCleanup?.();
    this.micTrackCleanup = null;
    if (this.micRecoveryTimer != null) clearTimeout(this.micRecoveryTimer);
    this.micRecoveryTimer = null;
    this.micMutedAt = 0;
  }
  private watchMicTracks(rawTrack: MediaStreamTrack, publishedTrack: MediaStreamTrack) {
    this.clearMicTrackLifecycle();
    const tracks = [...new Set([rawTrack, publishedTrack])];
    const owned = () => this.micRaw?.getAudioTracks()[0] === rawTrack
      && this.micLocalTrack?.mediaStreamTrack === publishedTrack && this.inVoice;
    const anyMuted = () => tracks.some((track) => track.muted);
    const ended = () => { if (owned()) void this.checkMicAlive(false); };
    const muted = () => {
      if (!owned()) return;
      if (this.voiceCaptureUnavailable()) this.micForegroundRecoveryPending = true;
      this.micMutedAt = Date.now();
      if (this.micRecoveryTimer != null) clearTimeout(this.micRecoveryTimer);
      // LiveKit listens to the processed destination track, not the raw gUM source, and pauses its
      // sender after a sustained destination mute. Observe both tracks so a live-looking raw source
      // cannot hide an already-paused upstream. Route swaps still receive the normal grace period.
      this.micRecoveryTimer = window.setTimeout(() => {
        this.micRecoveryTimer = null;
        if (owned() && anyMuted()) void this.checkMicAlive(true);
      }, MIC_MUTED_RESTART_MS + 50);
    };
    const unmuted = () => {
      if (anyMuted()) return;
      this.micMutedAt = 0;
      if (this.micRecoveryTimer != null) clearTimeout(this.micRecoveryTimer);
      this.micRecoveryTimer = null;
    };
    tracks.forEach((track) => {
      track.addEventListener('ended', ended);
      track.addEventListener('mute', muted);
      track.addEventListener('unmute', unmuted);
    });
    this.micTrackCleanup = () => {
      tracks.forEach((track) => {
        track.removeEventListener('ended', ended);
        track.removeEventListener('mute', muted);
        track.removeEventListener('unmute', unmuted);
      });
    };
    if (anyMuted()) muted();
  }
  private async checkMicAlive(fromWatchdog = false) {
    const hub = this.voiceRoom;
    const room = this.voiceMediaRoom;
    const channel = this.currentVc;
    if (!this.inVoice || !hub || !room || !channel || this.voiceConnecting || this.voiceLeaseVerifying
      || this.voiceClaimPending !== 0 || !this.voiceMediaActivated.has(room)) return;
    if (this.voiceCaptureUnavailable()) {
      // Never tear down or request capture while the PWA is hidden. WebKit can leave that gUM
      // promise pending until foreground, which used to block the foreground recovery itself.
      if (this.micRaw || this.micLocalTrack || this.micStartOwnership.active
        || this.micHadCapture || this.micBootstrapWanted) this.micForegroundRecoveryPending = true;
      return;
    }
    if (this.micRecoveryOwner !== 0 || this.micStartOwnership.active
      || (fromWatchdog && Date.now() < this.micRetryAt)) return;
    if (!automaticMicRecoveryAllowed(
      false,
      this.micHadCapture,
      this.micBootstrapWanted,
      this.micForegroundRecoveryPending,
      this.manualMute || this.deafened,
    )) return;
    // An explicit unmute owns the exact LiveKit sender until its bounded write settles. Inspecting
    // isUpstreamPaused before then would mistake the old deliberate mute for transport damage.
    if (this.micUnmuteWriteOwner !== 0) return;
    const voiceEpoch = this.voiceEpoch;
    const t = this.micRaw?.getAudioTracks()[0];
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const transportHealth = microphoneTransportHealth(
      t,
      this.micLocalTrack?.mediaStreamTrack,
      publication?.track === this.micLocalTrack,
      publication?.isUpstreamPaused === true,
      this.micLocalTrack?.isMuted === true || publication?.isMuted === true,
    );
    // reapplyMic can prepare a context under the user's mobile gesture while permission recovery is
    // still fail-closed. Once the room is re-activated, consume that context directly: tearing it
    // down first would force startMic to create a suspended non-gesture context on iOS.
    const preparedOnly = !!this.micActx && reusableMicrophoneAudioContextState(this.micActx.state)
      && !this.micRaw && !this.micLocalTrack;
    // Raw gUM and MediaStreamDestination tracks can both remain live/unmuted while WebKit leaves
    // their producing AudioContext `interrupted`. Treat the graph itself as a capture source: an
    // unusable/unknown context must enter the same fenced recovery as an ended hardware track.
    const micContextNeedsReplacement = !!this.micActx
      && !reusableMicrophoneAudioContextState(this.micActx.state);
    // UpstreamPaused already means LiveKit replaced the RTCRtpSender track with null after its own
    // mute debounce. It is terminal for this app-owned pipeline and must not receive another grace.
    const ended = !this.micActx || micContextNeedsReplacement
      || transportHealth.ended || transportHealth.upstreamPaused;
    const immediateForegroundRecovery = foregroundMicNeedsImmediateRecovery(
      this.micForegroundRecoveryPending,
      ended,
      transportHealth.muted,
      this.micHadCapture || this.micBootstrapWanted,
    );
    if (!ended && transportHealth.muted) {
      if (!this.micMutedAt) this.micMutedAt = Date.now();
      if (!immediateForegroundRecovery && (!fromWatchdog || !mutedTrackNeedsRestart(this.micMutedAt, Date.now()))) return;
    } else if (!ended && !immediateForegroundRecovery) {
      this.micMutedAt = 0; this.micForegroundRecoveryPending = false;
      return;
    }
    const recoveryOwner = ++this.micRecoverySeq;
    this.micRecoveryOwner = recoveryOwner;
    const recoveryCurrent = () => this.micRecoveryOwner === recoveryOwner
      && this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel);
    this.micMutedAt = 0; this.micForegroundRecoveryPending = false;
    const retainAvailability = retainMicAvailabilityDuringRecovery(this.micHadCapture, this.noMic);
    this.fenceMicForCaptureRecovery(hub, retainAvailability);
    this.recordVoiceDiagnostic({
      kind: 'mic_recovery_started', stage: 'mic_recovery', outcome: 'started',
      ...this.voiceDiagnosticState(),
    });
    try {
      if (!preparedOnly) {
        // iOS may return an AudioContext in WebKit's non-standard `interrupted` state while both
        // its processed destination track and the raw gUM track still look live. Keeping that exact
        // context would faithfully republish silence after every foreground reacquire. Preserve the
        // gesture-created context only when it is actually resumable; stopMic closes every other
        // state through the existing bounded cleanup before startMic builds a fresh graph.
        const recoveryContext = reusableMicrophoneAudioContextState(this.micActx?.state) ? this.micActx : null;
        await this.stopMic(room, recoveryContext);
      }
      if (!recoveryCurrent()) return;
      if (this.voiceCaptureUnavailable()) {
        this.micForegroundRecoveryPending = true;
        this.hiddenMicRecoveryOwner = recoveryOwner;
        this.recordVoiceDiagnostic({
          kind: 'mic_recovery_finished', stage: 'mic_recovery', outcome: 'cancelled', code: 'aborted',
          ...this.voiceDiagnosticState(),
        });
        return;
      }
      const started = await this.startMicWithDefaultFallback(voiceEpoch, 'Выбранный микрофон отключён — включён системный');
      if (!started || !recoveryCurrent()) {
        // Only a concrete newer/foreground owner may keep recovery pending. Some SDK publication
        // failures resolve as `false` rather than rejecting; treating that ownerless result as
        // superseded leaves peers seeing a working mic while no sender exists and retries hot-loop.
        const deferred = !recoveryCurrent() || this.micForegroundRecoveryPending
          || this.micStartOwnership.active || this.hasExactCurrentMicPublication();
        if (deferred) {
          this.recordVoiceDiagnostic({
            kind: 'mic_recovery_finished', stage: 'mic_recovery', outcome: 'superseded', code: 'aborted',
            ...this.voiceDiagnosticState(),
          });
          return;
        }
        this.recordVoiceMicFailure('mic_recovery');
        this.noMic = true;
        if (!this.micHadCapture) {
          this.micBootstrapWanted = false;
          this.micForegroundRecoveryPending = false;
        }
        this.micRetryAt = Date.now() + 5_000;
        void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
        if (!this.micFailureNotified) {
          this.micFailureNotified = true;
          this.hooks.toast('Микрофон потерян — пытаюсь восстановить подключение', 'warn');
        }
        this.emit();
        return;
      }
      this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
      void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
      this.recordVoiceDiagnostic({
        kind: 'mic_recovery_finished', stage: 'mic_recovery', outcome: 'recovered', code: 'none',
        ...this.voiceDiagnosticState(),
      });
      this.emit();
    } catch (error) {
      if (!recoveryCurrent()) return;
      this.recordVoiceMicFailure('mic_recovery', error);
      this.noMic = true;
      // Initial denial is a stable listen-only choice. Only a capture which worked before remains
      // eligible for periodic hardware/network recovery; otherwise the next attempt is user-driven.
      if (!this.micHadCapture) {
        this.micBootstrapWanted = false;
        this.micForegroundRecoveryPending = false;
      }
      this.micRetryAt = Date.now() + 5000;
      void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
      if (!this.micFailureNotified) {
        this.micFailureNotified = true;
        this.hooks.toast('Микрофон потерян — пытаюсь восстановить подключение', 'warn');
      }
      this.emit();
    }
    finally {
      if (this.micRecoveryOwner === recoveryOwner) {
        this.micRecoveryOwner = 0;
        this.applyGate();
        this.emit();
      }
    }
  }
  private reconcileMicPrivacyIntent() {
    const owner = ++this.micMuteWriteSeq;
    this.micUnmuteWriteOwner = 0;
    const hub = this.voiceRoom;
    const room = this.voiceMediaRoom;
    const channel = this.currentVc;
    const voiceEpoch = this.voiceEpoch;
    const publication = this.micPub(room);
    const track = publication?.track;
    const shouldMute = this.manualMute || this.deafened;

    if (shouldMute) {
      // If privacy changes while an automatic rebuild is between teardown and capture, retire that
      // owner. A later explicit unmute will validate/reacquire the damaged pipeline exactly once.
      if (this.micRecoveryOwner !== 0) {
        this.micForegroundRecoveryPending = true;
        this.invalidateMicRecoveryOwner();
        if (this.micStartOwnership.active) {
          ++this.micEpoch;
          this.micStartOwnership.invalidate();
        }
      }
      if (track) {
        try { void Promise.resolve(track.mute()).catch(() => { /** durable mute attribute remains authoritative */ }); }
        catch { /** durable mute attribute remains authoritative */ }
      }
      return;
    }

    // Physical unmute is allowed only for the app-owned, live publication of this exact voice
    // intent. A stale publication may still be present during a channel/lease handoff; touching it
    // could reopen an old sender. Mute above remains deliberately broader for privacy.
    const exactOwnership = !!hub && !!room && !!channel && !!track
      && track === this.micLocalTrack && this.hasExactCurrentMicPublication()
      && this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel);
    if (!hub || !room || !channel || !track || !exactOwnership) {
      void this.checkMicAlive(false);
      return;
    }
    const ownershipHealth = microphoneTransportHealth(
      this.micRaw?.getAudioTracks()[0],
      this.micLocalTrack?.mediaStreamTrack,
      true,
      publication?.isUpstreamPaused === true,
      track?.isMuted === true || publication?.isMuted === true,
    );
    // No exact/live publication means the previous source really disappeared. The normal fenced
    // recovery path is safe to start immediately now that the user explicitly wants to speak.
    if (ownershipHealth.ended) {
      void this.checkMicAlive(false);
      return;
    }

    this.micUnmuteWriteOwner = owner;
    let raw: Promise<unknown>;
    try { raw = Promise.resolve(track.unmute()); }
    catch (error) { raw = Promise.reject(error); }
    // A browser/SDK write is not cancellable. If this unmute resolves after a newer mute/deafen,
    // reassert privacy on the same exact publication; the gain gate and durable hub attribute stay
    // closed while this bounded repair catches the physical LiveKit track up.
    void raw.then(() => {
      if (this.micMuteWriteSeq === owner || (!this.manualMute && !this.deafened)
        || this.micPub(room)?.track !== track) return;
      try {
        void withVoiceTimeout(track.mute(), VOICE_ATTRIBUTE_TIMEOUT_MS, 'microphone remute')
          .catch(() => undefined);
      } catch { /** durable mute attribute remains authoritative */ }
    }, () => { /** the bounded owner below handles the failed explicit unmute */ });
    const finishUnmute = (writeSucceeded: boolean) => {
      if (this.micUnmuteWriteOwner !== owner) return;
      this.micUnmuteWriteOwner = 0;
      if (this.manualMute || this.deafened) return;
      const currentPublication = this.micPub(room);
      const currentOwnership = track === this.micLocalTrack
        && currentPublication?.track === track
        && this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)
        && this.voiceMediaActivated.has(room);
      if (!currentOwnership) {
        // Never touch the stale track. The current room, if any, is evaluated by its own fenced
        // recovery generation rather than inheriting this old write's result.
        void this.checkMicAlive(false);
        return;
      }
      const stillMuted = !writeSucceeded || track.isMuted || currentPublication.isMuted
        || track.mediaStreamTrack.enabled === false;
      // A rejected/timed-out unmute is not evidence of a healthy sender, even when stale browser
      // flags still say `live`. Arm one immediate, generation-fenced rebuild; checkMicAlive
      // consumes this flag before starting its single recovery owner.
      if (stillMuted) this.micForegroundRecoveryPending = true;
      void this.checkMicAlive(false);
    };
    void withVoiceTimeout(raw, VOICE_ATTRIBUTE_TIMEOUT_MS, 'microphone unmute')
      .then(() => finishUnmute(true), () => finishUnmute(false));
  }
  private supersedeHiddenMicOperations() {
    let superseded = false;
    if (this.hiddenMicStartOwner && this.micStartOwnership.owner === this.hiddenMicStartOwner) {
      ++this.micEpoch;
      this.micStartOwnership.invalidate(this.hiddenMicStartOwner);
      superseded = true;
    }
    if (this.hiddenMicRecoveryOwner && this.micRecoveryOwner === this.hiddenMicRecoveryOwner) {
      this.micRecoveryOwner = 0;
      ++this.micRecoverySeq;
      superseded = true;
    }
    this.hiddenMicStartOwner = 0;
    this.hiddenMicRecoveryOwner = 0;
    if (superseded) ++this.micForegroundGeneration;
  }
  private invalidateMicRecoveryOwner() {
    if (this.micRecoveryOwner) {
      this.micRecoveryOwner = 0;
      ++this.micRecoverySeq;
    }
    this.hiddenMicRecoveryOwner = 0;
  }
  private markVoiceHidden() {
    if (!this.inVoice) return;
    if (!this.voiceHiddenAt) {
      this.voiceHiddenAt = Date.now();
      this.recordVoiceDiagnostic({ kind: 'background', outcome: 'ok', ...this.voiceDiagnosticState() });
    }
    // A throttled timer may wake only after visibility has already changed again. Stop it on the
    // background edge; foreground start() establishes a fresh expected timestamp.
    this.voiceDiagnosticStallMonitor.stop();
    this.resetVoiceDiagnosticTransportWindow();
    // Reacquire on return only when this voice session actually owned or was starting capture.
    // A deliberate listen-only user must not receive a fresh permission prompt on every foreground.
    if (this.micStartOwnership.active) this.hiddenMicStartOwner = this.micStartOwnership.owner;
    if (this.micRecoveryOwner) this.hiddenMicRecoveryOwner = this.micRecoveryOwner;
    if (this.micRaw || this.micLocalTrack || this.micStartOwnership.active || this.micRecoveryOwner || this.micBootstrapWanted)
      this.micForegroundRecoveryPending = true;
  }
  private onVoicePageHide = () => {
    // WebKit/BFCache may deliver pagehide without blur or visibilitychange. PTT is an explicit hold,
    // so it must fail closed here; ordinary voice-activation capture keeps its existing background policy.
    this.forcePttRelease();
    this.markVoiceHidden();
  };
  private onVoiceVisible = () => { this.onVisible(false); };
  private onVoiceFocus = () => { this.onVisible(true); };
  // iOS/WebKit is allowed to suspend or end WebRTC capture while a PWA is hidden. We do not claim
  // background continuity: on foreground we resume playback and immediately reacquire an owned
  // source that returned muted/ended, without waiting for throttled watchdog timers.
  private onVisible = (focusFallback = false) => {
    if (!this.inVoice) return;
    // Уход в фон — момент, когда замирает requestAnimationFrame. Если гейт держится на spLoop
    // (ворклет не поднялся), замер протухнет именно сейчас, поэтому пересчитываем гейт сразу, не
    // дожидаясь троттлящегося таймера-сторожа. Возврат на вкладку пересчитает его тем же путём.
    if (document.hidden) {
      this.markVoiceHidden();
      window.setTimeout(() => this.applyGate(), VAD_STALE_MS + 50);
      return;
    }
    const returningFromBackground = this.voiceHiddenAt > 0;
    this.voiceHiddenAt = 0;
    this.voiceDiagnosticStallMonitor.start();
    this.retryPendingVoiceDiagnostic();
    if (returningFromBackground)
      this.recordVoiceDiagnostic({ kind: 'foreground', outcome: 'ok', ...this.voiceDiagnosticState() });
    const track = this.micRaw?.getAudioTracks()[0];
    const publication = this.voiceMediaRoom?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const transportHealth = microphoneTransportHealth(
      track,
      this.micLocalTrack?.mediaStreamTrack,
      publication?.track === this.micLocalTrack,
      publication?.isUpstreamPaused === true,
      this.micLocalTrack?.isMuted === true || publication?.isMuted === true,
    );
    const contextUnusable = !!this.micActx && !reusableMicrophoneAudioContextState(this.micActx.state);
    const ownsCapture = this.micHadCapture || this.micBootstrapWanted;
    // Standalone WebKit can deliver focus without pagehide/visibilitychange. In that fallback path,
    // arm recovery only from concrete transport/context damage so an ordinary desktop focus does
    // not rebuild a healthy microphone.
    if (focusFallback && ownsCapture
      && (transportHealth.ended || transportHealth.muted || transportHealth.upstreamPaused || contextUnusable)) {
      this.micForegroundRecoveryPending = true;
    }
    if ((returningFromBackground || focusFallback) && this.micForegroundRecoveryPending) {
      // A WebKit gUM promise may remain pending across the entire hidden period. Retire only the
      // exact owners observed at hide time, then let one new visible generation acquire capture.
      // The paired pageshow event sees cleared hidden-owner fields and cannot supersede that owner.
      if (returningFromBackground) this.supersedeHiddenMicOperations();
      this.micForegroundRecoveryPending = foregroundMicNeedsImmediateRecovery(
        true,
        transportHealth.ended || transportHealth.upstreamPaused || contextUnusable,
        transportHealth.muted,
        ownsCapture,
      );
    }
    this.applyGate();
    void this.checkMicAlive(false);
    this.ensureVoiceAudioRunning();
  };
  private async stopMic(
    room: Room | null = this.voiceMediaRoom,
    replacementContext: AudioContext | null = null,
  ): Promise<void> {
    ++this.micEpoch; // первым действием отменяем любой незавершённый gUM/RNNoise/publish
    this.micStartOwnership.invalidate();
    this.clearMicTrackLifecycle();
    const p = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const publishedTrack = p?.track;
    const localTrack = this.micLocalTrack; this.micLocalTrack = null;
    const raw = this.micRaw; this.micRaw = null;
    const denoise = this.micDenoise; this.micDenoise = null;
    const vadDest = this.micVadDest; this.micVadDest = null;
    const vadNode = this.micVadNode; this.micVadNode = null;
    const ctx = this.micActx;
    const preservedContext = reusableMicrophoneAudioContextState(replacementContext?.state)
      ? replacementContext
      : null;
    // Ownership changes synchronously, before unpublish/close awaits. A third tap can therefore
    // replace this prepared context without an older stop tail clearing the newer generation.
    this.micActx = preservedContext;
    this.micGain = null;
    this.detachAnalyser(this.me.username);
    this.vadOpen = false;
    this.selfSpeakUntil = 0;
    this.micLevelAt = 0;
    this.stopVadWatchdog();
    this.clearAudioUnlock();
    raw?.getTracks().forEach((t) => t.stop());
    destroyDenoiseNode(denoise);
    destroyVadNode(vadNode);
    if (vadDest) { try { vadDest.disconnect(); } catch { /**/ } }
    const waits: Promise<unknown>[] = [];
    if (room && publishedTrack) {
      try { waits.push(room.localParticipant.unpublishTrack(publishedTrack, true)); } catch { /**/ }
    }
    // A late SDK publication event can briefly expose a different track than the pipeline we own.
    // Retire both sides in that case; otherwise the detached processed track keeps the microphone
    // graph alive after leave/reapply even though the room publication was already removed.
    if (localTrack && localTrack !== publishedTrack) { try { localTrack.stop(); } catch { /**/ } }
    // The replacement may be a distinct gesture-created context which became interrupted before
    // teardown acquired it. Retire every rejected exact context and join each close to the same
    // bounded cleanup; the Set prevents a rejected ctx/replacement alias from being closed twice.
    const contextsToClose = new Set<AudioContext>();
    if (ctx && ctx !== preservedContext) contextsToClose.add(ctx);
    if (replacementContext && replacementContext !== preservedContext) contextsToClose.add(replacementContext);
    for (const context of contextsToClose) {
      forgetExactAudioContextResume(context);
      try { waits.push(context.close()); } catch { /**/ }
    }
    try {
      await withVoiceTimeout(Promise.allSettled(waits), VOICE_CLEANUP_TIMEOUT_MS, 'microphone cleanup');
    } catch { /** local ownership is already cleared; SDK cleanup may settle later */ }
    finally {
      // Explicit stop is idempotent and is still required when disconnected LiveKit rejects the
      // unpublish promise before honoring stopOnUnpublish=true.
      if (localTrack) { try { localTrack.stop(); } catch { /**/ } }
    }
  }
  // Замер уровня своего мика протух: ни ворклет, ни spLoop давно не присылали значение. Такое бывает,
  // когда ворклет не поднялся (нет AudioWorklet / модуль не догрузился) И вкладка ушла в фон — там
  // requestAnimationFrame заморожен, spLoop не тикает, и vadOpen застывает в последнем значении.
  // Застыть он может на «закрыто», и тогда человека НИКТО не слышит, пока он не вернётся на вкладку.
  // Поэтому протухший замер = «не знаю» = открываем гейт: лучше лишний фоновый шум, чем немой микрофон.
  private vadStale(): boolean { return performance.now() - this.micLevelAt > VAD_STALE_MS; }
  // gain = 1 (передаём) либо 0 (мут/оглушение/PTT-не-нажат/ниже порога чувствительности)
  private applyGate() {
    if (!this.micGain || !this.micActx) return;
    const s = getSettings();
    let target = 1;
    // Нет подтверждённого ownership — нет звука наружу. Особенно важно во время handoff и switch:
    // notify/HTTP/LiveKit-атрибуты могут прийти в разном порядке на разных устройствах.
    const media = this.voiceMediaRoom;
    const activeMedia = !!media && this.voiceMediaChannelId === this.currentVc && this.readyRooms.has(media)
      && this.voiceMediaActivated.has(media) && !!this.micLocalTrack && this.micPub(media)?.track === this.micLocalTrack;
    const hubAttrs = this.voiceRoom?.localParticipant.attributes || {};
    const hubAdvertised = (hubAttrs.vc || '') === (this.currentVc || '') && (hubAttrs.voiceSession || '') === this.voiceLeaseSession
      && (hubAttrs.voiceEpoch || '') === (this.voiceLeaseEpoch > 0 ? String(this.voiceLeaseEpoch) : '');
    if (!activeMedia || !hubAdvertised || this.micRecoveryOwner !== 0 || this.voiceConnecting || this.voiceLeaseVerifying || this.voiceClaimPending !== 0 || this.voiceLeaseEpoch <= 0
      || this.voiceLeaseSession !== this.sessionId()) target = 0;
    else if (this.manualMute || this.deafened) target = 0;
    else if (!voiceActivationAllowsAudio(s.mode, s.sensitivityAuto, this.vadOpen, this.vadStale(), this.pttDown)) target = 0;
    try { this.micGain.gain.setTargetAtTime(target, this.micActx.currentTime, 0.015); } catch { this.micGain.gain.value = target; }
  }
  // Сторож фейл-опена: сам по себе гейт пересчитывается только на событиях (замер уровня, мут, PTT),
  // а протухание — состояние без события. В фоне таймер троттлится, поэтому visibilitychange (onVisible
  // и уход в фон) дёргает applyGate отдельно — именно в этот момент rAF и замирает.
  private startVadWatchdog() {
    if (this.vadWatchdog != null) return;
    this.vadWatchdog = window.setInterval(() => {
      if (!this.micGain) return;
      if (getSettings().mode === 'voice') this.applyGate();
    }, VAD_WATCHDOG_MS);
  }
  private stopVadWatchdog() {
    if (this.vadWatchdog == null) return;
    clearInterval(this.vadWatchdog);
    this.vadWatchdog = null;
  }
  // текущий порог чувствительности (0..1), с учётом авто-режима
  private thresholdNorm(): number {
    const s = getSettings();
    if (s.sensitivityAuto) return dbToNorm(this.noiseFloorDb + 9); // запас над шумовым фоном
    return (s.sensitivity ?? 10) / 100;
  }
  // адаптивная оценка шумового фона: ВНИЗ инертно (реальный шум дрожит случайно от тика к тику — резкая
  // реакция вниз заставляла порог дёргаться вслед за каждым микро-провалом), вверх ещё медленнее — короткая
  // фраза (секунды) почти не сдвигает порог, а вот постоянный посторонний шум со временем всё же "выучивается"
  private updateNoiseFloor(db: number) {
    if (!Number.isFinite(db)) return;
    this.noiseFloorDb += (db - this.noiseFloorDb) * (db < this.noiseFloorDb ? 0.04 : 0.0015);
    this.noiseFloorDb = Math.max(MIN_DB, Math.min(0, this.noiseFloorDb));
  }
  // ---------- живой индикатор уровня для настроек ----------
  // В звонке данные уже шлёт локальный анализатор из spLoop. Вне звонка поднимаем временный захват микрофона.
  onInputLevel(cb: LevelListener): () => void {
    this.levelListeners.add(cb);
    if (!this.inVoice && this.levelListeners.size === 1) {
      if (document.hidden) this.levelForegroundRecoveryPending = true;
      else void this.startLevelMeter();
    }
    return () => {
      this.levelListeners.delete(cb);
      if (this.levelListeners.size === 0) {
        this.levelForegroundRecoveryPending = false;
        this.stopLevelMeter();
      }
    };
  }
  // Смена устройства/режима шумоподавления в настройках, пока превью-метр уже запущен (вне
  // звонка), сама по себе метр не перезапускает — иначе он продолжил бы слушать старый gUM-поток
  // со старыми constraints/денойзером. Дёргается из UI-обработчиков наравне с reapplyMic (тот
  // покрывает случай "в звонке", этот — "вне звонка"); внутри звонка это не-op.
  restartLevelMeter() {
    if (this.inVoice || this.levelListeners.size === 0) return;
    if (document.hidden) { this.suspendLevelMeterForBackground(); return; }
    this.stopLevelMeter();
    void this.startLevelMeter();
  }
  private suspendLevelMeterForBackground() {
    if (this.inVoice || this.levelListeners.size === 0) return;
    this.levelForegroundRecoveryPending = true;
    this.stopLevelMeter(true);
  }
  private scheduleLevelMeterAfterVoiceExit(expectedVoiceEpoch: number) {
    queueMicrotask(() => {
      if (!this.engineLifecycleActive || this.voiceEpoch !== expectedVoiceEpoch || this.inVoice
        || this.levelListeners.size === 0) return;
      if (document.hidden) { this.levelForegroundRecoveryPending = true; return; }
      this.levelForegroundRecoveryPending = false;
      if (!this.levelStartOwner && !this.levelStream) void this.startLevelMeter();
    });
  }
  private clearLevelTrackLifecycle() {
    this.levelTrackCleanup?.();
    this.levelTrackCleanup = null;
    if (this.levelRecoveryTimer != null) clearTimeout(this.levelRecoveryTimer);
    this.levelRecoveryTimer = null;
  }
  private watchLevelTrack(track: MediaStreamTrack, epoch: number) {
    this.clearLevelTrackLifecycle();
    const owned = () => this.levelEpoch === epoch && this.levelStream?.getAudioTracks()[0] === track
      && !this.inVoice && this.levelListeners.size > 0;
    const restart = () => {
      if (!owned()) return;
      this.levelRecoveryTimer = window.setTimeout(() => {
        this.levelRecoveryTimer = null;
        if (owned() && !document.hidden) this.restartLevelMeter();
      }, 0);
    };
    const muted = () => {
      if (!owned()) return;
      if (this.levelRecoveryTimer != null) clearTimeout(this.levelRecoveryTimer);
      this.levelRecoveryTimer = window.setTimeout(() => {
        this.levelRecoveryTimer = null;
        if (owned() && track.muted && !document.hidden) this.restartLevelMeter();
      }, MIC_MUTED_RESTART_MS + 50);
    };
    const unmuted = () => {
      if (this.levelRecoveryTimer != null) clearTimeout(this.levelRecoveryTimer);
      this.levelRecoveryTimer = null;
    };
    track.addEventListener('ended', restart);
    track.addEventListener('mute', muted);
    track.addEventListener('unmute', unmuted);
    this.levelTrackCleanup = () => {
      track.removeEventListener('ended', restart);
      track.removeEventListener('mute', muted);
      track.removeEventListener('unmute', unmuted);
    };
    if (track.readyState === 'ended') restart();
    else if (track.muted) muted();
  }
  // Превью-метр в настройках (вне звонка) прогоняем через тот же денойзер, что и в реальном
  // звонке — иначе маркер порога чувствительности в настройках не совпадал бы с тем, что
  // реально видит гейт во время разговора.
  private async startLevelMeter() {
    if (!this.engineLifecycleActive || this.inVoice || this.levelListeners.size === 0) return;
    if (document.hidden) { this.levelForegroundRecoveryPending = true; return; }
    // A browser denial is authoritative until a deliberate Retry succeeds. Reopening Settings must
    // not produce another automatic permission sheet from the preview meter.
    if (!automaticMicrophoneCaptureAllowed() || this.levelStartOwner) return;
    // Поколение запуска. Два старта накладываются буднично: restartLevelMeter (смена устройства или
    // режима шумодава) и re-mount MicMeter зовут stopLevelMeter, пока предыдущий старт ещё висит в
    // await getUserMedia — останавливать тогда нечего, и обе копии доходят до конца. Раньше
    // проигравшая просто делала `return`, не погасив СВОЙ gUM-поток: устройство захвата оставалось
    // открытым до перезагрузки (индикатор «микрофон используется» вне звонка), а её RnnoiseWorkletNode
    // и MediaStreamSource оставались висеть, потому что поля объекта уже перезаписал победитель.
    const op = ++this.levelEpoch;
    this.levelStartOwner = op;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let ownsCtx = false;
    let src: MediaStreamAudioSourceNode | null = null;
    let denoise: RnnoiseWorkletNode | null = null;
    let retryDefault = false;
    const current = () => this.engineLifecycleActive && op === this.levelEpoch && this.levelStartOwner === op
      && this.levelListeners.size > 0 && !this.inVoice && !document.hidden;
    const finishOwner = () => { if (this.levelStartOwner === op) this.levelStartOwner = 0; };
    const scheduleDefaultRetry = () => {
      if (!retryDefault || !this.engineLifecycleActive || document.hidden || this.inVoice || this.levelListeners.size === 0) return;
      queueMicrotask(() => { if (!this.levelStartOwner) void this.startLevelMeter(); });
    };
    const release = async () => {
      if (src) { try { src.disconnect(); } catch { /**/ } }
      destroyDenoiseNode(denoise);
      stream?.getTracks().forEach((t) => t.stop());
      if (ownsCtx && ctx && this.levelCtx !== ctx) {
        forgetExactAudioContextResume(ctx);
        try { await ctx.close(); } catch { /**/ }
      }
    };
    const fenceAfterAwait = async (): Promise<boolean> => {
      if (current()) return false;
      if (document.hidden && this.engineLifecycleActive && !this.inVoice && this.levelListeners.size > 0)
        this.levelForegroundRecoveryPending = true;
      await release();
      return true;
    };
    const finishCapture = beginMicrophoneCapture();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.micCapture() });
      finishCapture();
    }
    catch (error) {
      finishCapture(error);
      if (op !== this.levelEpoch || this.levelStartOwner !== op || !this.engineLifecycleActive
        || this.levelListeners.size === 0 || this.inVoice) return;
      if (document.hidden) this.levelForegroundRecoveryPending = true;
      else if (getSettings().input && selectedInputUnavailable(error)) {
        setSettings({ input: '' });
        this.hooks.toast('Сохранённый микрофон недоступен — включён системный', 'warn');
        retryDefault = true;
      } else this.hooks.toast('Нет доступа к микрофону', 'err');
      finishOwner();
      scheduleDefaultRetry();
      return;
    }
    if (await fenceAfterAwait() || !stream) { finishOwner(); return; }
    try {
      if (this.levelCtx?.state === 'closed') forgetExactAudioContextResume(this.levelCtx);
      ctx = this.levelCtx && this.levelCtx.state !== 'closed' ? this.levelCtx : new AudioContext();
      ownsCtx = ctx !== this.levelCtx;
      requestExactAudioContextResume(ctx);
      if (await fenceAfterAwait()) return;
      src = ctx.createMediaStreamSource(stream);
      let preAnalyser: AudioNode = src;
      if (getSettings().nsMode === 'rnnoise') {
        denoise = await createDenoiseNode(ctx);
        if (await fenceAfterAwait()) return;
        if (denoise) {
          src.connect(denoise);
          // см. startMic() — RnnoiseWorkletNode пишет только в канал 0, канал 1 тишина; без
          // сплита анализатор усреднял бы вдвое заниженный уровень (0.5*(L+0)).
          const split = ctx.createChannelSplitter(2);
          denoise.connect(split);
          preAnalyser = split;
        }
        else this.hooks.toast('Шумодав недоступен — звук без обработки', 'warn');
      }
      if (!current()) { await release(); return; }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5;
      const buf = new Uint8Array(analyser.fftSize);
      preAnalyser.connect(analyser);
      if (!current() || document.hidden) { await release(); return; }
      // Commit every resource atomically only after the final visibility/generation fence.
      this.levelCtx = ctx;
      this.levelStream = stream;
      this.levelSrc = src;
      this.levelDenoise = denoise;
      this.levelAnalyser = analyser;
      this.levelBuf = buf;
      const levelTrack = stream.getAudioTracks()[0];
      if (levelTrack) this.watchLevelTrack(levelTrack, op);
      this.levelRAF = requestAnimationFrame(this.levelLoop);
    } catch { await release(); }
    finally {
      finishOwner();
      scheduleDefaultRetry();
    }
  }
  private levelLoop = () => {
    if (!this.levelAnalyser || !this.levelBuf) return;
    this.levelAnalyser.getByteTimeDomainData(this.levelBuf as any);
    let sum = 0; for (let i = 0; i < this.levelBuf.length; i++) { const v = (this.levelBuf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / this.levelBuf.length);
    const db = rmsToDb(rms);
    const norm = dbToNorm(db);
    const threshold = this.thresholdNorm();
    const on = norm >= threshold;
    if (on) this.levelHold = 24; else if (this.levelHold > 0) this.levelHold--;
    const open = this.levelHold > 0 || on;
    this.updateNoiseFloor(db);
    this.levelListeners.forEach((f) => f(norm, open, threshold));
    this.levelRAF = requestAnimationFrame(this.levelLoop);
  };
  private stopLevelMeter(preserveForegroundRecovery = false) {
    this.levelEpoch++; // старт, ещё висящий в await, увидит смену поколения и освободит свой поток
    this.levelStartOwner = 0;
    if (!preserveForegroundRecovery) this.levelForegroundRecoveryPending = false;
    this.clearLevelTrackLifecycle();
    if (this.levelRAF) cancelAnimationFrame(this.levelRAF); this.levelRAF = null;
    if (this.levelSrc) { try { this.levelSrc.disconnect(); } catch { /**/ } this.levelSrc = null; }
    destroyDenoiseNode(this.levelDenoise); this.levelDenoise = null;
    this.levelAnalyser = null; this.levelBuf = null; this.levelHold = 0;
    if (this.levelStream) { this.levelStream.getTracks().forEach((t) => t.stop()); this.levelStream = null; }
    if (this.levelCtx) {
      forgetExactAudioContextResume(this.levelCtx);
      try { this.levelCtx.close(); } catch { /**/ }
      this.levelCtx = null;
    }
  }
  async reapplyMic(target: 'input' | 'route' = 'input') {
    const route = target === 'route';
    if (!this.voiceRoom || !this.voiceMediaRoom || !this.currentVc || !this.inVoice) {
      this.hooks.toast(route ? 'Вывод звука применится при подключении к голосовому' : 'Микрофон применится при подключении к голосовому');
      return;
    }
    // Создаём replacement ДО первого await, пока жив тап по пункту меню. Раньше новый AudioContext
    // рождался только после stopMic/unpublish и оставался suspended; следующий тап будил предыдущую
    // попытку, поэтому на iOS маршрут начинал работать лишь после нескольких переключений по кругу.
    const reapplyEpoch = ++this.micReapplyEpoch;
    const foregroundGeneration = this.micForegroundGeneration;
    let preparedCtx: AudioContext | null = null;
    try {
      preparedCtx = new AudioContext();
      requestExactAudioContextResume(preparedCtx, true);
      requestExactAudioContextResume(this.spCtx, true);
      requestExactAudioContextResume(this.outputCtx, true);
    } catch { preparedCtx = null; }
    const hub = this.voiceRoom;
    const room = this.voiceMediaRoom;
    const channel = this.currentVc;
    const voiceEpoch = this.voiceEpoch;
    this.fenceMicForCaptureRecovery(hub);
    await this.stopMic(room);
    if (reapplyEpoch !== this.micReapplyEpoch || foregroundGeneration !== this.micForegroundGeneration
      || !this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) {
      forgetExactAudioContextResume(preparedCtx);
      try { await preparedCtx?.close(); } catch { /**/ }
      return;
    }
    this.micActx = preparedCtx;
    preparedCtx = null; // startMic заберёт и закроет при любой ошибке до commit
    const micDeadline = Date.now() + VOICE_MIC_START_TIMEOUT_MS;
    try {
      if (!await this.startMicBeforeDeadline(voiceEpoch, micDeadline) || reapplyEpoch !== this.micReapplyEpoch
        || foregroundGeneration !== this.micForegroundGeneration
        || !this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) return;
      this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
      void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
      this.hooks.toast(route ? 'Вывод звука переключён' : 'Микрофон переключён', 'ok');
    }
    catch {
      if (reapplyEpoch !== this.micReapplyEpoch || foregroundGeneration !== this.micForegroundGeneration
        || this.hasExactCurrentMicPublication() || !this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) return;
      // На iPhone/iPad встроенный маршрут вывода WebKit предоставляет как связанный audioinput,
      // поэтому и обычный микрофон, и мобильный аудиомаршрут откатываются одним input reset.
      setSettings({ input: '' });
      try {
        if (!await this.startMicBeforeDeadline(voiceEpoch, micDeadline) || reapplyEpoch !== this.micReapplyEpoch
          || foregroundGeneration !== this.micForegroundGeneration
          || !this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) return;
        this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
        void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
        this.hooks.toast(route ? 'Аудиомаршрут недоступен — включён системный' : 'Выбранный микрофон недоступен — включён дефолтный', 'warn');
      }
      catch {
        if (reapplyEpoch !== this.micReapplyEpoch || foregroundGeneration !== this.micForegroundGeneration
          || this.hasExactCurrentMicPublication() || !this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) return;
        this.noMic = true; this.micRetryAt = Date.now() + 5000;
        if (!this.micHadCapture) {
          this.micBootstrapWanted = false;
          this.micForegroundRecoveryPending = false;
        }
        void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
        this.hooks.toast(route ? 'Не удалось переключить вывод звука' : 'Не удалось включить микрофон', 'err');
      }
    }
    this.emit();
  }
  private toggleManualMuteIntent() {
    this.manualMute = !this.manualMute;
    ++this.manualMuteIntentRevision;
    // Any explicit privacy change retires held PTT input. Removing mute later must require a fresh
    // key/touch press instead of reviving a pre-mute owner which is still physically held.
    this.clearPttOwnership();
    this.saveVoicePrefs();
    this.recordVoiceDiagnostic({
      kind: 'mute_changed', outcome: 'ok', code: 'none', ...this.voiceDiagnosticState(),
      micEnabled: !this.manualMute && !this.deafened,
    });
    // While deafened the physical track stays muted regardless of this preference. Keep the
    // existing full-mute sound authoritative instead of announcing an unmute nobody can hear.
    if (this.inVoice && !this.deafened) playSound(this.manualMute ? 'mute' : 'unmute');
    if (this.inVoice && this.voiceRoom && this.voiceMediaRoom) {
      // пока фулл-мут (deafened) активен, трек должен оставаться замьюченным на уровне LiveKit
      // независимо от ручного тогла — иначе снятие ручного мута во время deafen паразитно
      // размучивает трек (звук всё равно молчит через applyGate/gain=0, но у пиров и у себя
      // пропадает бейдж мута, будто фулл-мута больше нет).
      this.reconcileMicPrivacyIntent(); // ручной мут виден другим
      // Публикации может не быть (listen-only/рестарт мика) — тогда пиры узнают о муте только атрибутом.
      void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
      this.applyGate();
    }
    this.emit();
  }
  private restoreManualMuteIntent(previous: boolean, attemptRevision: number): boolean {
    if (!manualMuteIntentIsCurrent(attemptRevision, this.manualMuteIntentRevision)) return false;
    this.manualMute = previous;
    ++this.manualMuteIntentRevision; // the same async attempt cannot restore twice
    this.saveVoicePrefs();
    return true;
  }
  async toggleMic() {
    // Зашёл в голосовой БЕЗ мика → клик в устойчивом listen-only = новая попытка доступа. Пока
    // capture/connect уже занят, второй gUM запрещён, но сам ручной mute-интент принимается сразу.
    if (this.inVoice && this.noMic) {
      const captureBusy = microphoneCaptureBusy({
        startOwned: this.micStartOwnership.active,
        recoveryOwned: this.micRecoveryOwner !== 0,
        voiceTransaction: this.voiceConnecting || this.voiceLeaseVerifying || this.voiceClaimPending !== 0,
        foregroundPending: this.micForegroundRecoveryPending,
        bootstrapWanted: this.micBootstrapWanted,
      });
      if (unavailableMicrophoneButtonAction(captureBusy) === 'toggle-mute') {
        this.toggleManualMuteIntent();
        return;
      }
      const hub = this.voiceRoom;
      const room = this.voiceMediaRoom;
      const channel = this.currentVc;
      if (!hub || !room || !channel) return;
      const prevMute = this.manualMute; // не удалось поднять мик — интент мута обязан вернуться как был
      this.manualMute = false; // клик по устойчивому listen-only = «хочу говорить»
      const intentRevision = ++this.manualMuteIntentRevision;
      this.saveVoicePrefs(); // explicit intent survives a deferred foreground/switch owner
      const voiceEpoch = this.voiceEpoch;
      const foregroundGeneration = this.micForegroundGeneration;
      this.micBootstrapWanted = true;
      this.emit(); // кнопка сразу показывает занятый single-flight, не дожидаясь gUM/RNNoise/publish
      try {
        const started = await this.startMicWithDefaultFallback(voiceEpoch, 'Сохранённый микрофон недоступен — включён системный');
        if (!this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) return;
        if (!started) {
          // Hidden-page deferral or a newer reapply operation owns the next result. Preserve the
          // user's "I want to speak" intent and let that fenced owner finish it.
          if (this.micForegroundRecoveryPending || this.micStartOwnership.active || this.micLocalTrack) return;
          this.restoreManualMuteIntent(prevMute, intentRevision);
          this.micBootstrapWanted = false;
          this.emit();
          return;
        }
        this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
        this.saveVoicePrefs();
        void this.setVoiceAttributes(hub, this.wantedVoiceAttributes(hub));
        this.hooks.toast('Микрофон подключён');
      }
      catch {
        if (!this.voiceMediaIntentCurrent(voiceEpoch, hub, room, channel)) return;
        if (foregroundGeneration !== this.micForegroundGeneration || this.micStartOwnership.active
          || this.micRecoveryOwner !== 0 || this.hasExactCurrentMicPublication()) return;
        this.restoreManualMuteIntent(prevMute, intentRevision);
        this.micBootstrapWanted = false;
        this.micForegroundRecoveryPending = false;
        this.hooks.toast('Микрофон всё ещё недоступен', 'warn');
      }
      this.emit(); return;
    }
    // Работает и ВНЕ голоса: пред-установка мута (Discord-стиль) — применится на входе (startMic мьютит
    // при manualMute). В голосе — сразу мьютим/размьючиваем трек. Всегда персистим.
    this.toggleManualMuteIntent();
  }
  toggleDeaf() {
    // Работает и ВНЕ голоса: пред-установка «оглох» — применится на входе (joinVoice ставит deaf-атрибут,
    // reconcile не подпишется). Всегда персистим.
    this.deafened = !this.deafened;
    this.clearPttOwnership();
    this.saveVoicePrefs();
    this.recordVoiceDiagnostic({
      kind: 'deafen_changed', outcome: 'ok', code: 'none', ...this.voiceDiagnosticState(),
      deafened: this.deafened, micEnabled: !this.manualMute && !this.deafened,
    });
    if (this.inVoice) {
      // транслируем пирам, чтобы у них статус-бейдж отличался от простого мута мика (см. build())
      if (this.voiceRoom) void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
      this.reconcileMicPrivacyIntent();
      // deafen → отписка от всех миков (want=false при deafened), undeafen → переподписка. Отписка
      // надёжнее глушения громкостью: нет трека = точно тишина, и размут пира не воскресит звук.
      this.reconcileAllAudio();
      this.applyGate();
      this.applyAllVolumes();
    }
    // стрим-аудио (просмотр) глушим/восстанавливаем ВСЕГДА — просмотр не требует голоса, deafen вне канала тоже должен его глушить
    this.applyAllStreamVolumes();
    playSound(this.deafened ? 'fullMute' : 'unmute'); // оглох → fullMute; вернул звук → unmute (только сам)
    this.hooks.toast(this.deafened ? 'Тебя не слышно и ты никого не слышишь' : 'Звук включён');
    this.emit();
  }
  isDeafened() { return this.deafened; }
  private clearPttOwnership() {
    this.pttKeyboardDown = false;
    this.pttPointerDown = false;
    this.pttDown = false;
  }
  pttPress(owner: PttInputOwner): boolean {
    if (getSettings().mode !== 'ptt' || !this.inVoice || this.deafened || this.manualMute || this.noMic
      || this.voiceConnecting || this.voiceReconnecting || this.voiceLeaseVerifying || this.voiceClaimPending !== 0
      || this.voiceCaptureUnavailable() || this.micStartOwnership.active || this.micRecoveryOwner !== 0
      || !this.hasHealthyCurrentMicTransport()) return false;
    if ((owner === 'keyboard' && this.pttKeyboardDown) || (owner === 'pointer' && this.pttPointerDown)) return false;
    if (owner === 'keyboard') this.pttKeyboardDown = true;
    else this.pttPointerDown = true;
    if (!this.pttDown) {
      this.pttDown = true;
      this.applyGate();
      this.emit();
    }
    return true;
  }
  // Safe for blur/visibility/network handlers: always closes the gate even if mode or voice state
  // changed before the matching keyup was delivered.
  forcePttRelease() {
    const changed = this.pttDown;
    this.clearPttOwnership();
    this.applyGate();
    if (changed) this.emit();
  }
  pttRelease(owner: PttInputOwner) {
    const owned = owner === 'keyboard' ? this.pttKeyboardDown : this.pttPointerDown;
    if (!owned) return;
    if (owner === 'keyboard') this.pttKeyboardDown = false;
    else this.pttPointerDown = false;
    if (this.pttKeyboardDown || this.pttPointerDown) return;
    this.pttDown = false;
    this.applyGate();
    this.emit();
  }
  onModeChanged() {
    if (!this.inVoice) return;
    const wasDown = this.pttDown;
    this.forcePttRelease();
    if (!wasDown) this.emit();
  }

  /* ---------- speaking ---------- */
  private attachAnalyser(username: string, mst: MediaStreamTrack) {
    if (!mst) return;
    try {
      this.detachAnalyser(username);
      if (this.spCtx?.state === 'closed') {
        forgetExactAudioContextResume(this.spCtx);
        this.spCtx = null;
      }
      this.spCtx = this.spCtx || new AudioContext();
      requestExactAudioContextResume(this.spCtx);
      const src = this.spCtx.createMediaStreamSource(new MediaStream([mst]));
      const an = this.spCtx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.5; src.connect(an);
      this.analysers.set(username, { an, buf: new Uint8Array(an.fftSize), hold: 0, src, track: mst });
      if (isWindowIdle()) {
        if (!this.spIdleTimer) this.spIdleTimer = window.setInterval(() => { if (this.analysers.size) this.spLoop(true); }, 150);
      } else if (!this.spRAF) this.spRAF = requestAnimationFrame(() => this.spLoop());
    } catch { /**/ }
  }
  // keepSpeaking — снять анализатор, НЕ трогая speakingSet (передача владения VAD ворклету: индикатор
  // «говорю» дальше ведёт applyLocalLevel; иначе тут был бы лишний edge «замолчал»→«говорит» на хендофе).
  private detachAnalyser(username: string, keepSpeaking = false, expectedTrack?: MediaStreamTrack) {
    const o = this.analysers.get(username);
    if (expectedTrack && o?.track !== expectedTrack) return;
    if (o) { try { o.src.disconnect(); } catch { /**/ } this.analysers.delete(username); }
    if (!keepSpeaking && this.speakingSet.delete(username)) this.emit();
  }
  // Вызывается и из rAF (окно перед глазами), и из редкого таймера (окно без фокуса — например
  // приложение на втором мониторе, пока человек играет). Во втором случае считаем на каждом тике:
  // тик и так раз в 150мс.
  private spLoop = (fromTimer = false) => {
    this.spTick++;
    if (fromTimer || this.spTick % 3 === 0) {
      let changed = false;
      this.analysers.forEach((o, id) => {
        o.an.getByteTimeDomainData(o.buf as any);
        let sum = 0; for (let i = 0; i < o.buf.length; i++) { const v = (o.buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / o.buf.length);
        const isMe = id === this.me.username;
        let on: boolean, norm = 0, threshold = 0, db = 0;
        if (isMe) {
          db = rmsToDb(rms);
          norm = dbToNorm(db);
          threshold = this.thresholdNorm();
          on = norm >= threshold;
        } else on = rms > 0.018;
        if (on) o.hold = 8; else if (o.hold > 0) o.hold--;
        const spk = o.hold > 0 || on;
        if (isMe) {
          const wasStale = this.vadStale(); // гейт мог стоять в фейл-опене — после свежего замера пересчитать обязательно
          this.micLevelAt = performance.now();
          this.updateNoiseFloor(db); // подъём мед­ленный (см. updateNoiseFloor) — фраза его не продавит, а постоянный шум со временем перекроет
          this.levelListeners.forEach((f) => f(norm, spk, threshold));
          if (spk !== this.vadOpen || wasStale) { this.vadOpen = spk; this.applyGate(); }
        }
        if (spk && !this.speakingSet.has(id)) {
          this.speakingSet.add(id); changed = true;
          // Декодируемый track уже есть (иначе analyser не стал бы зелёным), но autoplay/audio element
          // мог отвалиться. Восстанавливаем playback прямо на первом speech-edge, не ждём watchdog.
          if (!isMe) this.ensureRemoteVoicePlayback(id);
        }
        else if (!spk && this.speakingSet.has(id)) { this.speakingSet.delete(id); changed = true; }
      });
      if (changed) this.emit();
    }
    // Пока окно не видно, индикаторы «говорит» рисовать некому, а живой rAF-цикл заставляет движок
    // планировать кадр каждый vsync — из-за чего и CSS-анимации рядом никогда не засыпают. Цикл
    // возобновляет onWindowIdle-подписка (см. конструктор), speakingSet при этом не трогаем: он
    // пересчитается на первом же кадре после возврата.
    this.spRAF = this.analysers.size && !isWindowIdle() ? requestAnimationFrame(() => this.spLoop()) : null;
  };

  /* ---------- track events (mic/chat only — video-domain events live in VideoTransport) ---------- */
  private removeVoiceAudio(username: string, identity?: string, track?: RemoteTrack, room?: Room): boolean {
    const entry = this.voiceAudioEls.get(username);
    if (!entry || (identity && entry.identity !== identity) || (track && entry.track !== track) || (room && entry.room !== room)) return false;
    this.voiceAudioEls.delete(username);
    this.remoteAudioPlays.forget(entry.el);
    this.forgetElementOutput(entry.el);
    this.detachAnalyser(username, false, (entry.track as any).mediaStreamTrack);
    if (!this.voiceAudioEls.size && !this.screenAudioEls.size) this.clearRemoteAudioUnlock();
    try {
      const detached = entry.track.detach(entry.el) as unknown;
      if (Array.isArray(detached)) detached.forEach((el) => (el as HTMLElement).remove());
      else (detached as HTMLElement | undefined)?.remove?.();
    }
    catch { try { entry.el.remove(); } catch { /**/ } }
    return true;
  }
  private clearVoiceAudio() {
    [...this.voiceAudioEls.keys()].forEach((username) => this.removeVoiceAudio(username));
  }
  private removeScreenAudio(username: string, identity?: string, track?: RemoteTrack): boolean {
    const entry = this.screenAudioEls.get(username);
    if (!entry || (identity && entry.identity !== identity) || (track && entry.track !== track)) return false;
    this.screenAudioEls.delete(username);
    this.remoteAudioPlays.forget(entry.el);
    this.forgetElementOutput(entry.el);
    if (!this.voiceAudioEls.size && !this.screenAudioEls.size) this.clearRemoteAudioUnlock();
    try {
      const detached = entry.track.detach(entry.el) as unknown;
      if (Array.isArray(detached)) detached.forEach((el) => (el as HTMLElement).remove());
      else (detached as HTMLElement | undefined)?.remove?.();
    } catch { try { entry.el.remove(); } catch { /**/ } }
    return true;
  }
  private clearScreenAudio() {
    [...this.screenAudioEls.keys()].forEach((username) => this.removeScreenAudio(username));
  }
  private configureScreenAudio(
    entry: { identity: string; track: RemoteTrack; el: HTMLMediaElement },
    p: RemoteParticipant,
  ) {
    const { el } = entry;
    el.autoplay = true;
    el.setAttribute('data-origin', 'view');
    el.setAttribute('data-screen-identity', entry.identity);
    if (!el.isConnected) document.getElementById('audioSink')?.appendChild(el);
    // attach() creates a fresh element on the OS route; do not reassert default through CoreAudio.
    seedAudioSinkTargetRoute(el);
    void this.switchElementOutput(el, getSettings().output || 'default');
    this.applyScreenAudioGain(baseUid(p.identity), p);
    this.ensureRemoteAudioPlayback();
  }
  private configureVoiceAudio(entry: { room: Room; identity: string; track: RemoteTrack; el: HTMLMediaElement }, p: Participant) {
    const { el } = entry;
    el.autoplay = true;
    el.setAttribute('data-origin', 'voice');
    el.setAttribute('data-voice-identity', entry.identity);
    if (!el.isConnected) document.getElementById('audioSink')?.appendChild(el);
    seedAudioSinkTargetRoute(el);
    // При webAudioMix SDK намеренно держит element muted/volume=0 и выводит через GainNode.
    // Размьют element создал бы обход gain (двойной звук и сломанный local mute).
    this.applyVolumeToParticipant(p);
    this.ensureVoiceOutput();
    void this.switchElementOutput(el, getSettings().output || 'default');
  }
  private ensureVoiceOutput(force = false) {
    const room = this.voiceMediaRoom;
    if (!room) return;
    const sink = getSettings().output || 'default';
    if (!force && this.voiceOutputRoom === room && this.voiceOutputSink === sink) return;
    if (!force && this.voiceOutputPending?.room === room && this.voiceOutputPending.sink === sink) return;
    const pending = { room, sink };
    this.voiceOutputPending = pending;
    void this.switchContextOutput(sink).then((effective) => {
      if (this.voiceMediaRoom !== room || this.voiceOutputPending !== pending) return;
      if (!effective) return; // superseded by a newer output request
      const current = getSettings().output || 'default';
      this.voiceOutputRoom = room;
      this.voiceOutputSink = current === sink ? effective : '';
    }).finally(() => {
      if (this.voiceOutputPending === pending) this.voiceOutputPending = null;
    });
  }
  private ensureRemoteVoicePlayback(username?: string) {
    const room = this.voiceMediaRoom;
    if (!room || !this.inVoice || this.deafened || !this.currentVc || this.voiceMediaChannelId !== this.currentVc
      || !this.voiceMediaActivated.has(room)) return;
    const users = username ? [username] : [...new Set([...room.remoteParticipants.values()].map((p) => baseUid(p.identity)))];
    for (const user of users) {
      if (user === this.me.username) continue;
      const p = this.mediaPartOf(user, room);
      const pub = p?.getTrackPublication(Track.Source.Microphone);
      const remoteTrack = pub?.track as RemoteTrack | undefined;
      const active = !!p && !!remoteTrack;
      if (!active) { this.removeVoiceAudio(user); continue; }
      let entry = this.voiceAudioEls.get(user);
      if (!entry || entry.room !== room || entry.identity !== p!.identity || entry.track !== remoteTrack || !entry.el.isConnected) {
        this.removeVoiceAudio(user);
        // Seed RemoteAudioTrack.elementVolume before attach() creates its GainNode. The stability
        // patch can then initialize the node at the exact saved value in the same task, avoiding a
        // one-frame full-volume burst on desktop reconnect/first subscription.
        this.applyVolumeToParticipant(p!);
        const el = remoteTrack.attach() as HTMLMediaElement;
        entry = { room, identity: p!.identity, track: remoteTrack, el };
        this.voiceAudioEls.set(user, entry);
        this.attachAnalyser(user, (remoteTrack as any).mediaStreamTrack);
        this.configureVoiceAudio(entry, p!);
      }
    }
    // One room/context/element recovery pass is sufficient for the whole reconciliation batch.
    // Running it from configureVoiceAudio multiplied native autoplay calls by participant count.
    this.ensureRemoteAudioPlayback();
  }
  private onRemotePub = (pub: TrackPublication, p: RemoteParticipant, room: Room, _silent?: boolean) => {
    if (pub.source === Track.Source.Microphone) {
      const own = baseUid(p.identity) === this.me.username; // своя же другая сессия — без звука/подписки
      if (!own) this.reconcileUserAudio(baseUid(p.identity)); // переоцениваем ВСЕ сессии пользователя атомарно
      this.emit();
    }
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant, room: Room) => {
    if (pub.source === Track.Source.Microphone) {
      if (room === this.voiceMediaRoom) this.reconcileUserAudio(baseUid(p.identity));
    }
    this.emit();
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant, room?: Room) => {
    if (track.kind === Track.Kind.Audio) {
      const isScreen = pub.source === Track.Source.ScreenShareAudio;
      const u = baseUid(p.identity);
      if (isScreen && room === this.viewRoom) {
        // A late TrackSubscribed from a replaced publication must not revive the old audio.
        if (p.getTrackPublication(Track.Source.ScreenShareAudio)?.track !== track) {
          try { track.detach().forEach((el) => el.remove()); } catch { /**/ }
          this.emit(); return;
        }
        this.removeScreenAudio(u);
        this.applyScreenAudioGain(u, p);
        const a = track.attach() as HTMLMediaElement;
        const entry = { identity: p.identity, track, el: a };
        this.screenAudioEls.set(u, entry);
        this.configureScreenAudio(entry, p);
      } else if (isScreen || !this.inVoice || room !== this.voiceMediaRoom || this.deafened || u === this.me.username
        || p !== this.mediaPartOf(u, this.voiceMediaRoom) || !this.currentVc || this.voiceMediaChannelId !== this.currentVc
        || !this.voiceMediaActivated.has(this.voiceMediaRoom)) {
        try { (pub as any).setSubscribed(false); track.detach().forEach((el) => el.remove()); } catch { /**/ }
        this.emit(); return;
      } else {
        if (p.getTrackPublication(Track.Source.Microphone)?.track !== track) {
          try { track.detach().forEach((el) => el.remove()); } catch { /**/ }
          this.emit(); return;
        }
        this.removeVoiceAudio(u);
        this.applyVolumeToParticipant(p);
        const a = track.attach() as HTMLMediaElement;
        const entry = { room: this.voiceMediaRoom, identity: p.identity, track, el: a };
        this.voiceAudioEls.set(u, entry);
        this.configureVoiceAudio(entry, p);
        this.ensureRemoteAudioPlayback();
        this.attachAnalyser(u, (track as any).mediaStreamTrack);
      }
    }
    this.emit();
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant, room?: Room) => {
    const u = baseUid(p.identity);
    this.clearSubscriptionRetries(p.identity, (pub as any).trackSid || (pub as any).sid, room);
    if (pub.source === Track.Source.ScreenShareAudio) {
      // An old publication can unsubscribe after its replacement has already attached. Remove
      // only the exact entry so that the new stream audio keeps playing.
      if (!this.removeScreenAudio(u, p.identity, track)) {
        try { track.detach().forEach((el) => el.remove()); } catch { /**/ }
      }
    } else {
      try { track.detach().forEach((el) => el.remove()); } catch { /**/ }
    }
    // Unsubscribe старой multi-device сессии не должен снести анализатор уже активной новой сессии.
    if (pub.source === Track.Source.Microphone) this.removeVoiceAudio(u, p.identity, track, room);
    this.emit();
  };

  /* ---------- streams (thin facades over VideoTransport) ---------- */
  getVideoTrack(key: string) { return this.liveKitT.getVideoTrack(key) ?? this.treeT.getVideoTrack(key); }

  private cancelWatchTimer(identity: string) {
    const timer = this.watchTimers.get(identity);
    if (timer !== undefined) window.clearTimeout(timer);
    this.watchTimers.delete(identity);
  }
  private cancelAllWatchTimers() {
    this.watchTimers.forEach((timer) => window.clearTimeout(timer));
    this.watchTimers.clear();
  }
  private completeWatch(identity: string) {
    this.cancelWatchTimer(identity);
    this.pendingWatch.delete(identity);
  }
  watchPlaybackGeneration(identity: string, streamKey: string): number {
    return this.watchPlaybackGate.generationFor(identity, streamKey);
  }
  confirmWatchPlayback(identity: string, streamKey: string, generation: number) {
    if (!this.pendingWatch.has(identity) || !this.watchPlaybackGate.confirms(identity, streamKey, generation)) return;
    const attempt = this.streamWatchDiagnostics.get(identity);
    this.finishStreamWatchDiagnostic(
      identity,
      attempt && attempt.reconnectCount > 0 ? 'stream_watch_recovered' : 'stream_watch_succeeded',
      { stage: 'watch_playback', outcome: attempt && attempt.reconnectCount > 0 ? 'recovered' : 'ok', code: 'none', trackState: 'live' },
    );
    this.completeWatch(identity);
    this.emit();
  }
  private clearWatch(identity: string, discardDiagnostic = false) {
    const transport = this.watchT.get(identity) ?? this.transportFor(identity);
    if (discardDiagnostic) this.streamWatchDiagnostics.delete(identity);
    else if (this.pendingWatch.has(identity)) this.finishStreamWatchDiagnostic(
      identity, 'stream_watch_failed',
      { stage: 'watch_track', outcome: 'failed', code: 'track_missing', trackState: 'missing' },
    );
    this.cancelWatchTimer(identity);
    this.watching.delete(identity);
    this.pendingWatch.delete(identity);
    this.watchPlaybackGate.end(identity);
    transport.unwatch(identity);
    this.watchT.delete(identity);
  }
  private clearAllWatches(
    unexpectedFailure?: Pick<VoiceDiagnosticEvent, 'stage' | 'outcome' | 'code' | 'trackState'>,
  ) {
    this.cancelAllWatchTimers();
    const identities = new Set([...this.watching, ...this.pendingWatch, ...this.watchT.keys()]);
    // Leaving/reloading the viewed server can race the 20-second first-frame deadline. Preserve a
    // terminal snapshot for every still-pending attempt instead of silently deleting the exact
    // timeline the administrator needs. Explicit logout has already discarded the account outbox,
    // so the same cleanup remains privacy-preserving on an intentional account exit.
    const failure = unexpectedFailure ?? {
      stage: 'watch_playback' as const,
      outcome: 'cancelled' as const,
      code: 'aborted' as const,
      trackState: 'missing' as const,
    };
    identities.forEach((identity) => {
      if (this.pendingWatch.has(identity)) {
        this.finishStreamWatchDiagnostic(identity, 'stream_watch_failed', failure);
      }
    });
    identities.forEach((identity) => {
      const transport = this.watchT.get(identity) ?? this.transportFor(identity);
      transport.unwatch(identity);
    });
    this.watching.clear();
    this.pendingWatch.clear();
    this.watchT.clear();
    this.watchPlaybackGate.clear();
    this.streamWatchDiagnostics.clear();
  }

  // Д3: quality пробрасывается в транспорт (выбор рендишн-дерева). Дефолт 'source' — UI-ключ
  // остаётся базовым identity; смена качества (Д4) = closeWatch()+watch(identity, q). transportFor
  // не меняется (пин по identity).
  watch(identity: string, quality: string = 'source') {
    // Грид до WATCH_MAX стримов одновременно (веб: свой tree-WS/PC на стрим; натив: свой
    // Rust relay-слот на стрим, WatchState = HashMap). Кап — единая точка для обоих клиентов
    // (натив идёт сюда же через treeVideo.watch). Уже смотрим этот стрим → no-op (guard в транспорте).
    if (!this.watching.has(identity) && this.watching.size >= WATCH_MAX) {
      this.hooks.toast(`Максимум ${WATCH_MAX} трансляции одновременно — закрой одну`, 'warn');
      return;
    }
    // Repeated UI/reconnect signals must not arm a second timeout over an already
    // successful (or still pending) attempt. Quality changes explicitly close first.
    if (this.watching.has(identity)) return;
    // no `this.room` participant guard here: a tree broadcaster (Э2) is a native peer,
    // not a LiveKit room participant (voice and video are separate transports now) —
    // existence is the VideoTransport's job (it no-ops safely on an unknown identity).
    this.watching.add(identity); this.pendingWatch.add(identity);
    const playbackGeneration = this.watchPlaybackGate.begin(identity);
    const t = this.transportFor(identity);
    this.watchT.set(identity, t); // пин: unwatch/статы пойдут в тот же транспорт, даже если объявление пропадёт
    this.beginStreamWatchDiagnostic(identity, t, playbackGeneration);
    const timer = window.setTimeout(() => {
      // A cancelled/replaced attempt is not allowed to tear down its successor.
      if (this.watchTimers.get(identity) !== timer) return;
      this.watchTimers.delete(identity);
      if (this.pendingWatch.has(identity)) {
        this.finishStreamWatchDiagnostic(identity, 'stream_watch_failed', {
          stage: 'watch_playback', outcome: 'timed_out', code: 'decode_timeout', trackState: 'missing',
        });
        this.clearWatch(identity, true);
        this.hooks.toast('Не удалось подключиться к трансляции', 'err'); this.emit();
      }
    }, WATCH_VIDEO_DEADLINE_MS);
    this.watchTimers.set(identity, timer);
    try { t.watch(identity, quality); }
    catch (error) {
      const classified = classifyVoiceDiagnosticError(error);
      this.finishStreamWatchDiagnostic(identity, 'stream_watch_failed', {
        stage: 'watch_signaling', outcome: 'failed', code: classified.code || 'unknown', trackState: 'missing',
      });
      this.cancelWatchTimer(identity);
      this.watching.delete(identity); this.pendingWatch.delete(identity);
      this.watchPlaybackGate.end(identity); this.watchT.delete(identity);
      this.hooks.toast('Не удалось начать подключение к трансляции', 'err'); this.emit();
      return;
    }
    if (!safeLocalStorageGet('sprayTip')) {
      safeLocalStorageSet('sprayTip', '1');
      this.hooks.toast('Кинь эмоут зрителям — 😃 в углу трансляции', 'info');
    }
    this.emit();
  }
  closeWatch(identity: string) {
    // A real viewer action can arrive before the 20-second watchdog (for example after the native
    // client already surfaced a listener/signaling/ICE error). Preserve that bounded attempt before
    // the ordinary transport cleanup removes its local routing key. Successful/already-finalized
    // watches have no pending recorder here, so closing a healthy tile creates no extra incident.
    if (this.pendingWatch.has(identity)) this.finishStreamWatchDiagnostic(
      identity, 'stream_watch_failed',
      { stage: 'watch_playback', outcome: 'cancelled', code: 'aborted', trackState: 'missing' },
    );
    this.clearWatch(identity, true);
    const m = this.streamWatchers.get(identity); if (m) { m.delete(this.me.username); }
    this.dataSend({ t: 'watch', s: identity, id: this.me.username, n: this.me.displayName, on: false });
    this.emit();
  }

  async share() {
    if (!this.inVoice) { this.hooks.toast('Сначала подключись к голосовому', 'warn'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { this.hooks.toast('Трансляция экрана не поддерживается на этом устройстве (нужен десктопный браузер)', 'warn'); return; }
    if (this.liveKitT.isBroadcasting(this.me.username)) { await this.stopShare(); this.hooks.toast('Трансляция остановлена'); return; }
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 }, displaySurface: 'browser' } as any,
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } as any,
        // @ts-ignore
        systemAudio: 'include', selfBrowserSurface: 'exclude',
      });
    } catch { this.screenStream = null; return; }
    const vt = this.screenStream.getVideoTracks()[0];
    try { await vt.applyConstraints({ frameRate: { ideal: 60, min: 30 } } as any); } catch { try { await vt.applyConstraints({ frameRate: { ideal: 60 } } as any); } catch { /**/ } }
    try { (vt as any).contentHint = 'motion'; } catch { /**/ }
    vt.addEventListener('ended', () => this.stopShare());
    try { await this.liveKitT.startBroadcast(this.me.username, this.screenStream); }
    catch { this.hooks.toast('Не удалось начать трансляцию', 'err'); this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null; return; }
    if (!this.screenStream.getAudioTracks()[0]) this.hooks.toast('Звук экрана не захвачен — включи галку «Поделиться аудио»', 'warn');
    this.keepAliveOn();
    const surf = (vt.getSettings() as any).displaySurface || '';
    if (surf === 'monitor' || surf === 'window') this.hooks.toast('Выбран экран/окно (~15fps). Для 60fps выбирай «Вкладка Chrome»', 'warn'); else this.hooks.toast('Трансляция запущена', 'ok');
    playSound('streamOn');
    if (this.voiceServerId) api.streamStart(this.voiceServerId).catch(() => {}); // фоновый push участникам не в комнате (broadcast на голосовом сервере)
    this.emit();
  }
  async stopShare() {
    if (!this.voiceRoom) return;
    const wasBroadcasting = this.liveKitT.isBroadcasting(this.me.username); // leaveVoice зовёт stopShare всегда — streamOff только если реально вещали
    await this.liveKitT.stopBroadcast(this.me.username);
    if (this.screenStream) { this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null; }
    this.keepAliveOff();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (wasBroadcasting) playSound('streamOff'); // сам вещатель слышит стоп (остальные на сервере — через onStreamStop)
    this.emit();
  }
  isSharing() { return this.liveKitT.isBroadcasting(this.me.username); }

  private keepAliveOn() { try { this.keepCtx = this.keepCtx || new AudioContext(); if (this.keepOsc) return; this.keepOsc = this.keepCtx.createOscillator(); const g = this.keepCtx.createGain(); g.gain.value = 0.0004; this.keepOsc.frequency.value = 30; this.keepOsc.connect(g); g.connect(this.keepCtx.destination); this.keepOsc.start(); } catch { /**/ } }
  private keepAliveOff() { try { if (this.keepOsc) { this.keepOsc.stop(); this.keepOsc.disconnect(); this.keepOsc = null; } } catch { /**/ } }

  async getScreenStats(): Promise<string | null> { return this.liveKitT.getScreenStats(this.me.username); }

  /** Позиция в дереве + живая RTP-статистика для дебаг-панели зрителя (Э2.1).
   *  `null` для транспортов без дерева (LiveKit) — StreamTile просто не покажет панель. */
  getTreeInfo(identity: string) { return this.transportFor(identity).getTreeInfo?.(identity) ?? null; }
  async getWatchRtpStats(identity: string) { return (await this.transportFor(identity).getRtpStats?.(identity)) ?? null; }

  /** Метаданные приложения вещателя (иконка/имя окна) — только tree-стримы;
   *  LiveKit (браузерная шара) метаданных не имеет → null (generic-глиф в UI). */
  getStreamAppMeta(identity: string) { return this.treeT.getStreamMeta?.(identity) ?? null; }

  /** Э8: топология дерева стрима + текущий родитель + ручной выбор пира (для UI пикера). */
  getStreamTopology(identity: string) { return this.transportFor(identity).getTopology?.(identity) ?? null; }
  getStreamParentId(identity: string) { return this.transportFor(identity).getParentId?.(identity) ?? null; }
  requestReparent(identity: string, targetId: string | null) { this.transportFor(identity).requestReparent?.(identity, targetId); }

  /* ---------- Д4: выбор качества (только при просмотре через сервер) ---------- */
  // Меню Авто/Source/1080/720/480/360 → transport делает unwatch+watch(quality, pinned).
  setStreamQuality(identity: string, mode: string) { this.transportFor(identity).setQuality?.(identity, mode); this.emit(); }
  getStreamQualityMode(identity: string): string { return this.transportFor(identity).getQualityMode?.(identity) ?? 'auto'; }
  // Доступная лестница рендишнов стрима (из stream-live.renditions). null — не tree/неизвестно.
  getStreamRenditions(identity: string): string[] | null { return this.treeT.getStreamMeta?.(identity)?.renditions ?? null; }
  // Смотрим ли через сервер (родитель = vrelay/рендишн-корень) — только тогда меню качества активно.
  isStreamViaServer(identity: string): boolean {
    const topo = this.getStreamTopology(identity);
    if (!topo || !topo.you) return false;
    const you = topo.nodes.find((n) => n.id === topo.you);
    const parent = you?.parentId ? topo.nodes.find((n) => n.id === you.parentId) : null;
    return !!(parent && (parent.virtual || (parent as any).server));
  }

  /* ---------- emotes (spray) ---------- */
  onEmote(cb: EmoteListener) { this.emoteListeners.add(cb); return () => { this.emoteListeners.delete(cb); }; }
  fling(streamerId: string, emote: Emote, size?: string) {
    const x = Math.random();
    this.emoteListeners.forEach((f) => f(streamerId, emote.id, this.me.displayName, x, size));
    this.dataSend({ t: 'emote', s: streamerId, e: emote.id, by: this.me.displayName, x, sz: size });
  }

  /* ---------- watchers presence ---------- */
  private announceWatch() {
    if (!this.viewRoom) return;
    const id = this.me.username;
    this.watching.forEach((sid) => {
      const m = this.wset(sid); m.set(id, { name: this.me.displayName, color: this.me.avatarColor, avatarUrl: this.me.avatarUrl, ts: Date.now() });
      this.dataSend({ t: 'watch', s: sid, id, n: this.me.displayName, c: this.me.avatarColor, a: this.me.avatarUrl, on: true });
    });
    // Раньше emit стоял безусловно, поэтому раз в 3 секунды пересобирался весь снапшот и будились
    // все подписчики useSyncExternalStore — то есть полный ре-рендер интерфейса на пустом месте,
    // даже когда пользователь ничего не смотрит и вообще свернул окно. Обновились только записи
    // watchers, значит эмитим ровно тогда, когда они есть (как рядом делает cleanupWatchers).
    if (this.watching.size) this.emit();
  }
  private wset(sid: string) { let m = this.streamWatchers.get(sid); if (!m) { m = new Map(); this.streamWatchers.set(sid, m); } return m; }
  private cleanupWatchers() { const now = Date.now(); let ch = false; this.streamWatchers.forEach((m) => m.forEach((v, wid) => { if (now - v.ts > 9000) { m.delete(wid); ch = true; } })); if (ch) this.emit(); }
  private cleanupPeer(id: string) { this.streamWatchers.delete(id); this.streamWatchers.forEach((m) => m.delete(id)); this.clearWatch(id); this.removeScreenAudio(id); } // voice analyser принадлежит media-room и снимается только её exact track event

  /* ---------- volumes ---------- */
  private volsFor(serverId: string | null | undefined) {
    const id = serverId || '';
    let vols = this.volsByServer.get(id);
    if (!vols) { vols = { users: {}, streams: {} }; if (id) this.volsByServer.set(id, vols); }
    return vols;
  }
  private muteSet(serverId: string | null | undefined) {
    const id = serverId || '';
    let set = this.perMuteByServer.get(id);
    if (!set) { set = new Set(); if (id) this.perMuteByServer.set(id, set); }
    return set;
  }
  streamVolOf(id: string) { const n = Number(this.volsFor(this.viewServerId).streams[id]); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; }
  private streamGainOf(id: string) { return effectiveStreamGain(getSettings().master, this.streamVolOf(id), this.deafened); }
  userVolOf(id: string) { const n = Number(this.volsFor(this.viewServerId).users[id]); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; }
  private voiceUserVolOf(id: string) { const n = Number(this.volsFor(this.voiceServerId).users[id]); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; }
  isMutedFor(id: string) { return this.muteSet(this.viewServerId).has(id); }
  setUserVol(username: string, v: number) {
    const serverId = this.viewServerId; if (!serverId) return;
    const vols = this.volsFor(serverId); vols.users[username] = Math.max(0, Math.min(2, Number(v) || 0));
    this.hooks.saveSettings(serverId, vols, { section: 'users', key: username });
    this.applyVolumeByName(username); this.emit();
  }
  setStreamVol(id: string, v: number) {
    const serverId = this.viewServerId; if (!serverId) return;
    const vols = this.volsFor(serverId); const value = Math.max(0, Math.min(1, Number(v) || 0)); vols.streams[id] = value;
    this.hooks.saveSettings(serverId, vols, { section: 'streams', key: id });
    const p = this.participantWithTrack(id, Track.Source.ScreenShareAudio, this.viewRoom);
    this.applyScreenAudioGain(id, p || undefined, effectiveStreamGain(getSettings().master, value, this.deafened));
    this.ensureRemoteAudioPlayback(); this.emit();
  }
  toggleUserMute(username: string) { const set = this.muteSet(this.viewServerId); if (set.has(username)) set.delete(username); else set.add(username); this.applyVolumeByName(username); this.emit(); }
  applyMaster() { this.applyAllVolumes(); this.applyAllStreamVolumes(); this.emit(); }
  onVoiceActivationSettingsChanged() { this.applyGate(); }
  private applyVolumeByName(username: string) {
    if (!this.voiceServerId || this.viewServerId !== this.voiceServerId) return;
    const p = this.mediaPartOf(username, this.voiceMediaRoom);
    if (!p || p === this.voiceMediaRoom?.localParticipant || !(p as any).setVolume) return;
    this.applyVolumeToParticipant(p);
  }
  // Громкость СТАВИМ на конкретную сессию (participant), а не через partOf(username): partOf
  // предпочитает mic-сессию, но при второй (ghost/реконнект) сессии или транзитной пропаже
  // mic-публикации возвращает ПУСТУЮ сессию — setVolume уходил мимо звучащего элемента, и на
  // undeafen громкость реально звучащей сессии оставалась 0 навсегда (ничто её больше не
  // восстанавливает). Прямой проход по каждому участнику этого промаха лишён.
  private applyVolumeToParticipant(p: Participant) {
    const u = baseUid(p.identity);
    const v = (this.deafened || this.muteSet(this.voiceServerId).has(u))
      ? 0
      : (getSettings().master / 100) * userVolumeToGain(this.voiceUserVolOf(u));
    try {
      if ((p as any).setVolume) (p as any).setVolume(v);
    } catch { /** webAudio watchdog/reattach повторит; element остаётся muted, обход gain запрещён */ }
  }
  private applyAllVolumes() { this.voiceMediaRoom?.remoteParticipants.forEach((p) => this.applyVolumeToParticipant(p)); }
  private participantWithTrack(username: string, source: Track.Source, room: Room | null): Participant | null {
    if (!room) return null;
    for (const p of room.remoteParticipants.values()) {
      if (baseUid(p.identity) === username && p.getTrackPublication(source)) return p;
    }
    return null;
  }
  private applyScreenAudioGain(username: string, participant?: Participant, exactGain?: number) {
    const gain = exactGain ?? this.streamGainOf(username);
    const entry = this.screenAudioEls.get(username);
    // LiveKit RemoteAudioTrack.setVolume выбирает правильный путь сам: SDK GainNode при
    // webAudioMix либо element.volume без него. Нельзя вручную размьючивать attached element —
    // при webAudioMix он намеренно muted/volume=0, иначе появится второй звук в обход gain.
    // The map entry is the exact audible replacement. During a multi-device handoff an arbitrary
    // first participant with the same base username can still own an older publication, so update
    // the attached track first and never let that stale participant short-circuit the real one.
    const participantTrack = participant?.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    applyExactScreenAudioGain(
      entry?.track as RemoteTrack & { setVolume?: (value: number) => void },
      participantTrack,
      participant ? () => (participant as any).setVolume(gain, Track.Source.ScreenShareAudio) : undefined,
      gain,
    );
  }
  private applyAllStreamVolumes() {
    this.screenAudioEls.forEach((_entry, username) => this.applyScreenAudioGain(username));
    this.viewRoom?.remoteParticipants.forEach((p) => {
      const u = baseUid(p.identity);
      if (!p.getTrackPublication(Track.Source.ScreenShareAudio)) return;
      this.applyScreenAudioGain(u, p);
    });
    if (this.screenAudioEls.size) this.ensureRemoteAudioPlayback();
  }
  async applyOutput(forceRouteRefresh = false) {
    const sink = getSettings().output || 'default';
    // The shared WebAudio context is the actual audible mixer. Await it first;
    // HTML elements below are only the Chromium echo-cancellation workaround
    // and the non-mixed screen-audio path.
    const effectiveSink = await this.switchContextOutput(sink, true, forceRouteRefresh);
    if (!effectiveSink) return; // a newer device selection owns the queue
    document.querySelectorAll('#audioSink audio').forEach((a) => {
      void this.switchElementOutput(a as HTMLMediaElement, effectiveSink, true, forceRouteRefresh);
    });
    this.ensureRemoteVoicePlayback();
    this.ensureVoiceOutput(true);
    this.ensureRemoteAudioPlayback();
    this.ensureVoiceAudioRunning();
  }

  /* ---------- chat ---------- */
  // упоминание меня: @username / @displayName / @everyone|@all|@все
  textMentionsMe(text: string): boolean {
    if (!text) return false;
    if (/@(everyone|all|все)(?![\p{L}\p{N}_])/iu.test(text)) return true; // \b не Unicode-aware → @все не ловилось; lookahead корректен для лат+кириллицы
    const low = text.toLowerCase();
    const u = (this.me.username || '').toLowerCase();
    const d = (this.me.displayName || '').toLowerCase();
    let m: RegExpExecArray | null; const re = /@([^\s@]+)/g;
    while ((m = re.exec(low))) { if (m[1] === u || m[1] === d) return true; }
    // многословный Ник (с пробелом) regex выше обрывает на пробеле — проверяем всю строку,
    // но с ГРАНИЦЕЙ токена, иначе @Ян ложно матчит @Янина (substring). Однословные Ники уже
    // покрыты точным сравнением в цикле, поэтому фолбэк нужен только для Ников с пробелом.
    if (d.includes(' ')) {
      const needle = '@' + d;
      for (let i = low.indexOf(needle); i !== -1; i = low.indexOf(needle, i + 1)) {
        const before = i === 0 ? '' : low[i - 1];
        const after = low[i + needle.length];
        if ((i === 0 || /\s/.test(before)) && (after === undefined || /[\s.,!?:;)»"']/.test(after))) return true;
      }
    }
    return false;
  }
  // ответ адресован мне? → уведомление/подсветка как при теге (@ник)
  private replyToMe(reply?: ReplyRef): boolean {
    if (!reply) return false;
    return (!!reply.uid && reply.uid === this.me.id) || reply.author === this.me.displayName;
  }
  private appendMessage(message: Omit<ChatMessage, 'id'>): number {
    const id = msgSeq++;
    const next = [...this.messages, { id, ...message }];
    // Срез идёт с НАЧАЛА, поэтому копим trimmedFront — компонент на столько же поднимет
    // firstItemIndex virtuoso. После явной пагинации лимит заранее расширен: первое live-сообщение
    // не удаляет только что загруженную страницу и не выбивает читаемый якорь.
    const trim = chatAppendFrontTrim(next.length, this.chatRetentionLimit);
    if (trim > 0) { this.trimmedFront += trim; this.messages = next.slice(trim); }
    else this.messages = next;
    this.emit();
    return id;
  }
  private pushMsg(who: string | null, text: string, sys: boolean, color?: number, mineOverride?: boolean, img?: string, ts?: number, uid?: string, reply?: ReplyRef, files?: Attachment[], mkey?: string, kind?: string, level?: number): number {
    const mine = mineOverride !== undefined ? mineOverride : (!sys && who === this.me.displayName);
    const mention = !sys && !mine && (this.textMentionsMe(text) || this.replyToMe(reply));
    return this.appendMessage({ uid, who, text, mine, sys, color, img, files, ts: ts ?? Date.now(), mention, reply, mkey, kind, level });
  }
  // статус отправки моего сообщения (для «не отправлено · повторить»)
  private pendingSend = new Map<number, { text: string; em: Record<string, string>; img?: string; reply?: ReplyRef; key: string; files?: Attachment[]; canonicalTransport: boolean; baseRevision: number | null }>();
  private setMsgStatus(localId: number, status: 'failed' | undefined) {
    let changed = false;
    this.messages = this.messages.map((m) => (m.id === localId && m.status !== status ? (changed = true, { ...m, status }) : m));
    if (changed) this.emit();
  }
  markSendResult(localId: number, ok: boolean, sid?: number, responseRevision?: number) {
    if (ok) {
      const responseIsOlder = this.chatRevisionKnown && Number.isSafeInteger(responseRevision)
        && Number(responseRevision) < this.chatRevision;
      const canonicalRowExists = sid != null && this.messages.some((message) => message.sid === sid);
      if (responseIsOlder && !canonicalRowExists) {
        const before = this.messages.length;
        this.messages = this.messages.filter((message) => message.id !== localId);
        this.pendingSend.delete(localId);
        this.reactions.delete(-localId);
        if (this.messages.length !== before) this.emit();
        void this.resynchronizeChat(this.chatStateServerId);
        return;
      }
      const rowStillExists = this.messages.some((message) => message.id === localId
        || (sid != null && message.sid === sid));
      // An authoritative clear/resync can remove the optimistic row while its
      // POST is still in flight. A success with no local/canonical row always
      // needs a fresh snapshot: an older revision proves that the clear won;
      // a newer revision means the POST may have committed after that clear
      // while its message.created frame was lost.
      if (!rowStillExists) {
        this.pendingSend.delete(localId);
        void this.resynchronizeChat(this.chatStateServerId);
        return;
      }
      const pend = this.pendingSend.get(localId);
      this.pendingSend.delete(localId);
      // Усыновляем серверный sid на оптимистичное сообщение — сразу включает edit/delete/реакции и
      // кликабельность реплая на него (иначе живут без sid до refetch).
      let ch = false;
      this.messages = this.messages.map((m) => (m.id === localId && m.sid == null && sid != null ? (ch = true, { ...m, sid, status: undefined }) : (m.id === localId && m.status ? (ch = true, { ...m, status: undefined }) : m)));
      const reactionChanged = sid != null ? this.adoptPendingReactions(localId, sid) : false;
      if (ch || reactionChanged) this.emit(); else this.setMsgStatus(localId, undefined);
      // Rollout fallback only. Once authenticated notify-WS announced canonical
      // chat, peers adopt from message.created and participant sid packets stop.
      if (!this.serverChatReady && sid != null && pend?.key && this.viewRoom)
        this.dataSend({ t: 'sid', mkey: pend.key, sid });
    } else {
      // Canonical created-event may beat a lost/aborted HTTP response. Once the
      // exact (uid,mkey) optimistic row has adopted a server id, that websocket
      // event proves persistence and a late network error must not mark it failed.
      const canonical = this.messages.some((message) => message.id === localId && message.sid != null);
      if (canonical) {
        this.pendingSend.delete(localId);
        this.setMsgStatus(localId, undefined);
      } else this.setMsgStatus(localId, 'failed');
    }
  }
  private applySidAdopt(d: any, senderUid?: string) {
    if (typeof d.sid !== 'number' || !d.mkey) return;
    if (!senderUid) return;
    const ids = this.messages.filter((m) => m.mkey === d.mkey && m.sid == null && m.uid === senderUid).map((m) => m.id);
    let ch = false;
    this.messages = this.messages.map((m) => (m.mkey === d.mkey && m.sid == null && m.uid === senderUid ? (ch = true, { ...m, sid: d.sid }) : m));
    ids.forEach((id) => { if (this.adoptPendingReactions(id, d.sid)) ch = true; });
    if (ch) this.emit();
  }
  retrySend(localId: number) {
    const p = this.pendingSend.get(localId); if (!p) return;
    this.setMsgStatus(localId, undefined);
    // только повторный persist (без ре-broadcast): если первый dataSend прошёл, у живых
    // сообщение уже есть — повтор рассылки дал бы дубль. Упал именно POST в БД. Тот же key —
    // если первый POST на самом деле дошёл (потерян лишь ответ), сервер проигнорит дубль.
    this.hooks.persistMessage(p.text, p.em, p.img, p.reply, localId, p.key, p.files, undefined, undefined, p.canonicalTransport);
  }
  sysMsg(text: string, meta?: { kind?: string }) {
    this.pushMsg(null, text, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, meta?.kind);
  }
  private chatRefreshTimers = new Map<string, number>();
  private lastChatRefresh = new Map<string, number>();
  refreshChat(targetSid?: number, logicalServerId?: string) {
    const exactSid = Number.isSafeInteger(targetSid) && (targetSid || 0) > 0 ? targetSid : undefined;
    // Notify-WS может восстановиться раньше LiveKit. Для exact release сервер чата приходит
    // из авторитетного notify-frame; обычный recent-путь по-прежнему использует viewRoom.
    const serverId = (typeof logicalServerId === 'string' && logicalServerId.trim()) || this.chatStateServerId;
    const key = `${serverId || 'none'}:${exactSid == null ? 'recent' : `sid:${exactSid}`}`;
    if (this.chatRefreshTimers.has(key) || Date.now() - (this.lastChatRefresh.get(key) || 0) < 1200) return;
    const timer = window.setTimeout(() => {
      this.chatRefreshTimers.delete(key);
      if (serverId && (exactSid != null || this.chatStateServerId === serverId)) {
        this.lastChatRefresh.set(key, Date.now());
        this.hooks.refetchChat?.(exactSid, serverId, exactSid != null);
      }
    }, 50);
    this.chatRefreshTimers.set(key, timer);
  }
  private mapHistory(list: HistoryMessage[]): ChatMessage[] {
    return list.map((raw) => {
      const member = raw.kind === 'release' ? undefined : this.members.find((candidate) => candidate.id === raw.uid);
      // The authenticated server snapshot remains the fallback for former members;
      // a current member is always rendered from the current server model.
      const m = member ? { ...raw, name: member.displayName, color: member.avatarColor } : raw;
      if (m.em) for (const k in m.em) this.onEmoteResolve?.(k, m.em[k]);
      // реакции из истории — авторитетны (корректируют realtime-дрейф). Ключ — серверный id (sid).
      if (m.id != null) {
        if (m.reactions && m.reactions.length) this.reactions.set(m.id, new Map(m.reactions.map((r) => [r.id, { name: r.name, count: r.count, mine: r.mine }])));
        else this.reactions.delete(m.id);
      }
      const isRelease = m.kind === 'release';
      const release = isRelease ? normalizeReleaseNote(m.release) || undefined : undefined;
      const mine = !isRelease && m.uid === this.me.id;
      return {
        id: msgSeq++,
        sid: m.id,
        uid: isRelease ? 'system:release' : m.uid,
        who: isRelease ? null : m.name,
        text: m.text,
        mine,
        sys: isRelease,
        color: isRelease ? undefined : m.color,
        img: isRelease ? undefined : m.img,
        files: isRelease ? undefined : m.files,
        ts: isRelease ? (normalizeReleaseTimestamp(m.ts) ?? normalizeReleaseTimestamp(release?.publishedAt) ?? Date.now()) : m.ts,
        mention: !isRelease && !mine && (this.textMentionsMe(m.text) || this.replyToMe(m.reply)),
        reply: isRelease ? undefined : m.reply,
        edited: !isRelease && m.edited,
        mkey: !isRelease ? m.mkey : undefined,
        kind: m.kind,
        level: m.level,
        release,
      };
    });
  }
  private installHistoryState(list: HistoryMessage[], hasMore: boolean) {
    ++this.chatGeneration;
    this.streamStateMessages.clear();
    this.reactions.clear();
    this.messages = this.mapHistory(list);
    this.chatMore = hasMore;
    this.oldestSid = list.length ? (list[0].id ?? null) : null;
    this.trimmedFront = 0;
    this.chatPrepended = 0;
    this.chatRetentionLimit = this.messages.length > CHAT_SESSION_MESSAGE_LIMIT
      ? this.messages.length + CHAT_SESSION_MESSAGE_LIMIT
      : CHAT_SESSION_MESSAGE_LIMIT;
  }
  private overlayPendingReactionWrites(serverId: string) {
    for (const pending of this.reactionWriteDesired.values()) {
      if (pending.serverId !== serverId) continue;
      let reactions = this.reactions.get(pending.sid);
      if (!reactions) { reactions = new Map(); this.reactions.set(pending.sid, reactions); }
      const current = reactions.get(pending.emoteId) || { name: pending.name, count: 0, mine: false };
      if (current.mine !== pending.mine) current.count = Math.max(0, current.count + (pending.mine ? 1 : -1));
      current.mine = pending.mine;
      current.name = pending.name;
      if (current.count > 0) reactions.set(pending.emoteId, current); else reactions.delete(pending.emoteId);
      if (!reactions.size) this.reactions.delete(pending.sid);
    }
  }
  private clearDurableMutationBookkeeping() {
    // Promises already in flight cannot be cancelled, but removing their queue
    // ownership makes late continuations no-ops against the post-clear view.
    this.reactionWrites.clear();
    this.reactionWriteSeq.clear();
    this.reactionWriteDesired.clear();
    this.chatMutationWrites.clear();
    this.chatMutationSeq.clear();
    this.chatEditDesired.clear();
  }
  private replaceChatSnapshot(
    list: HistoryMessage[],
    hasMore: boolean,
    serverId: string,
    lastClearRevision: number | null = null,
  ) {
    const optimistic = this.messages.filter((message) => message.sid == null && this.pendingSend.has(message.id));
    // Once the authenticated canonical transport is active, an authoritative
    // snapshot may be recovering a missed clear. Exact (uid,mkey) matches are
    // always adopted. For an unmatched row the transactionally consistent clear
    // watermark proves whether it predates that clear without dropping a POST
    // which merely started after the snapshot read.
    const pendingLocalReactions = new Map<number, Map<string, { name: string; count: number; mine: boolean }>>();
    for (const message of optimistic) {
      const value = this.reactions.get(-message.id);
      if (value) pendingLocalReactions.set(message.id, new Map(value));
    }
    this.installHistoryState(list, hasMore);
    const matchedOptimisticIds: Array<[number, number]> = [];
    for (const local of optimistic) {
      const pending = this.pendingSend.get(local.id);
      const key = local.mkey;
      const canonicalIndex = key
        ? this.messages.findIndex((message) => message.sid != null && message.uid === local.uid && message.mkey === key)
        : -1;
      if (canonicalIndex >= 0) {
        const canonical = this.messages[canonicalIndex];
        this.messages[canonicalIndex] = { ...canonical, id: local.id, mkey: key, status: undefined };
        this.pendingSend.delete(local.id);
        if (canonical.sid != null) matchedOptimisticIds.push([local.id, canonical.sid]);
      } else if (lastClearRevision == null
        || preserveOptimisticAtSnapshot(false, pending?.baseRevision, lastClearRevision)) {
        this.messages.push(local);
      } else {
        this.pendingSend.delete(local.id);
        this.reactions.delete(-local.id);
      }
      const pendingReactions = pendingLocalReactions.get(local.id);
      if (pendingReactions && (canonicalIndex >= 0 || lastClearRevision == null
        || preserveOptimisticAtSnapshot(false, pending?.baseRevision, lastClearRevision))) {
        this.reactions.set(-local.id, pendingReactions);
      }
    }
    matchedOptimisticIds.forEach(([localId, sid]) => { this.adoptPendingReactions(localId, sid); });
    this.overlayPendingReactionWrites(serverId);
  }
  // начальная страница истории (последние N) — заменяет весь чат, ставит курсор на самое старое
  loadHistory(list: HistoryMessage[], hasMore = false) {
    this.installHistoryState(list, hasMore);
    this.fenceSnapshotMentions();
    this.emit();
  }
  // догрузка пропущенного после реконнекта. Дедуп двойной:
  // 1) по sid — сообщения истории, уже показанные;
  // 2) по сигнатуре (автор+текст+картинка) — live-эхо от onData НЕ имеет sid, поэтому без этого
  //    refetchChat притаскивал те же сообщения из истории (уже с sid) и они дублировались.
  //    Совпавшему live-сообщению «усыновляем» серверный sid — дальше дедуп идёт по sid.
  // Оптимистичные и чужие realtime-копии сохраняют локальный id; история лишь усыновляет sid
  // и авторитетные поля, поэтому React-ключи не прыгают при восстановлении связи.
  mergeRecent(list: HistoryMessage[], canonicalCreated = false, notifyMappedMentions = true) {
    if (!list.length) return;
    const existingBySid = new Map<number, ChatMessage>();
    const duplicateLocalIds = new Set<number>();
    this.messages.forEach((message) => {
      if (message.sid == null) return;
      if (existingBySid.has(message.sid)) duplicateLocalIds.add(message.id);
      else existingBySid.set(message.sid, message);
    });
    const haveSids = new Set(existingBySid.keys());
    const filesSig = (files?: Attachment[]) => (files && files.length ? files.map((f) => f.url).join(',') : '');
    const sig = (uid?: string, text?: string, img?: string, files?: Attachment[]) => JSON.stringify([uid || '', text || '', img || '', filesSig(files)]);
    const liveBySig = new Map<string, ChatMessage[]>();
    const liveByMkey = new Map<string, ChatMessage[]>();
    for (const m of this.messages) {
      if (m.sid == null && !m.sys && m.uid) {
        const k = sig(m.uid, m.text, m.img, m.files);
        (liveBySig.get(k) || liveBySig.set(k, []).get(k)!).push(m);
        if (m.mkey) {
          const exact = `${m.uid}\u0000${m.mkey}`;
          (liveByMkey.get(exact) || liveByMkey.set(exact, []).get(exact)!).push(m);
        }
      }
    }
    const add: HistoryMessage[] = [];
    const historyForLocal = new Map<number, HistoryMessage>();
    const pendingReactionAdoptions: Array<[number, number]> = [];
    const seenIncomingSids = new Set<number>();
    let adopted = false;
    let canonicalized = false;
    let reactionsChanged = false;
    for (const m of list) {
      if (m.id == null) continue;
      if (seenIncomingSids.has(m.id)) continue;
      seenIncomingSids.add(m.id);
      if (haveSids.has(m.id)) {
        const existing = existingBySid.get(m.id);
        if (existing) { historyForLocal.set(existing.id, m); canonicalized = true; }
        const authoritative = new Map((m.reactions || []).map((r) => [r.id, { name: r.name, count: r.count, mine: r.mine }]));
        const current = this.reactions.get(m.id);
        if (current) for (const [emoteId, reaction] of current) {
          if (this.reactionWrites.has(`${this.chatStateServerId}:${m.id}:${emoteId}`)) authoritative.set(emoteId, reaction);
        }
        for (const pending of this.reactionWriteDesired.values()) {
          if (pending.serverId !== this.chatStateServerId || pending.sid !== m.id) continue;
          const reaction = authoritative.get(pending.emoteId) || { name: pending.name, count: 0, mine: false };
          if (reaction.mine !== pending.mine) reaction.count = Math.max(0, reaction.count + (pending.mine ? 1 : -1));
          reaction.mine = pending.mine;
          reaction.name = pending.name;
          if (reaction.count > 0) authoritative.set(pending.emoteId, reaction); else authoritative.delete(pending.emoteId);
        }
        if (authoritative.size) this.reactions.set(m.id, authoritative); else this.reactions.delete(m.id);
        reactionsChanged = true;
        continue;
      }
      if (m.mkey) {
        const exact = liveByMkey.get(`${m.uid}\u0000${m.mkey}`);
        const live = exact?.shift();
        if (live) {
          const signatureBucket = liveBySig.get(sig(live.uid, live.text, live.img, live.files));
          const signatureIndex = signatureBucket?.findIndex((candidate) => candidate.id === live.id) ?? -1;
          if (signatureBucket && signatureIndex >= 0) signatureBucket.splice(signatureIndex, 1);
          historyForLocal.set(live.id, m);
          pendingReactionAdoptions.push([live.id, m.id]);
          this.pendingSend.delete(live.id);
          adopted = true;
          continue;
        }
        // A canonical keyed message may adopt only the exact (uid,mkey) optimistic
        // row. Identical text is not identity and can be sent twice intentionally.
        add.push(m);
        haveSids.add(m.id);
        continue;
      }
      if (canonicalCreated) {
        add.push(m);
        haveSids.add(m.id);
        continue;
      }
      // Свои сообщения НЕ пропускаем безусловно: при мультисессии своё сообщение с другого
      // устройства могло не дойти по data-каналу (обрыв) → его надо догрузить. Дубля не будет —
      // оптимистичная копия лежит в liveBySig и усыновит sid; реально пропущенное попадёт в add.
      const bucket = liveBySig.get(sig(m.uid, m.text, m.img, m.files));
      if (bucket && bucket.length) {
        let bestIndex = -1;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (let i = 0; i < bucket.length; i++) {
          const delta = Math.abs((bucket[i].ts ?? m.ts) - m.ts);
          if (delta < bestDelta) { bestDelta = delta; bestIndex = i; }
        }
        // Realtime timestamps use the client clock and history uses the server clock;
        // allow a bounded skew, but do not pair identical messages hours apart.
        if (bestIndex >= 0 && bestDelta <= 5 * 60_000) {
          const live = bucket.splice(bestIndex, 1)[0];
          historyForLocal.set(live.id, m);
          pendingReactionAdoptions.push([live.id, m.id]);
          this.pendingSend.delete(live.id);
          adopted = true;
          continue;
        }
      } // усыновили sid, не дублируем
      add.push(m);
      haveSids.add(m.id);
    }
    const canonicalize = (current: ChatMessage, history: HistoryMessage): ChatMessage => {
      const isRelease = history.kind === 'release';
      const release = isRelease ? normalizeReleaseNote(history.release) || undefined : undefined;
      const mine = !isRelease && history.uid === this.me.id;
      return {
        ...current,
        sid: history.id,
        uid: isRelease ? 'system:release' : history.uid,
        who: isRelease ? null : history.name,
        text: history.text,
        mine,
        sys: isRelease,
        color: isRelease ? undefined : history.color,
        img: isRelease ? undefined : history.img,
        files: isRelease ? undefined : history.files,
        ts: isRelease ? (normalizeReleaseTimestamp(history.ts) ?? normalizeReleaseTimestamp(release?.publishedAt) ?? Date.now()) : history.ts,
        mention: !isRelease && !mine && (this.textMentionsMe(history.text) || this.replyToMe(history.reply)),
        reply: isRelease ? undefined : history.reply,
        edited: !isRelease && history.edited,
        mkey: !isRelease ? (history.mkey || current.mkey) : undefined,
        status: undefined,
        kind: history.kind,
        level: history.level,
        release,
      };
    };
    let merged = this.messages.filter((message) => !duplicateLocalIds.has(message.id)).map((message) => {
      const history = historyForLocal.get(message.id);
      return history ? canonicalize(message, history) : message;
    });
    const mapped = this.mapHistory(add);
    if (mapped.length) merged = [...merged, ...mapped];
    if (mapped.length || adopted || canonicalized || duplicateLocalIds.size) {
      // Preserve the relative order and virtual index of every existing local key. A whole-list
      // timestamp sort during reconnect could move the previous tail into the middle, making old
      // rows look like a fresh suffix and invalidating Virtuoso's measured anchor. Genuinely missed
      // rows already arrive in server order and are appended once; known rows are canonicalized in place.
      if (merged.length > this.chatRetentionLimit) {
        // Reconnect can deliver a large suffix batch while the user is reading history. Do not
        // delete that visible anchor in the same commit (or defer one mass trim to the next row).
        // ...но подъём обязан быть ограничен сверху. Иначе это храповик: mergeRecent дёргается
        // автоматически (RoomEvent.Reconnected → refetchChat), каждый раз добавляет ещё одно живое
        // окно и никогда не опускает потолок обратно — после нескольких реконнектов обрезка головы
        // выключена насовсем, и массив сообщений растёт со скоростью чата всю сессию.
        this.chatRetentionLimit = Math.min(
          chatRetentionLimitAfterProtectedInsert(
            this.chatRetentionLimit,
            merged.length,
            0,
            CHAT_SESSION_MESSAGE_LIMIT,
          ),
          chatRetentionHardCap(this.chatPrepended),
        );
      }
      this.messages = merged;
    }
    pendingReactionAdoptions.forEach(([localId, sid]) => {
      if (this.adoptPendingReactions(localId, sid)) reactionsChanged = true;
    });
    let mentioned: ChatMessage[] = [];
    if (notifyMappedMentions) {
      for (const message of mapped) if (message.sid != null) {
        claimBoundedMessageId(this.chatSnapshotSeenSids, message.sid);
        if (message.mention && this.claimChatMentionNotification(this.chatStateServerId, message.sid)) mentioned.push(message);
      }
      this.deliverMentionBatch(mentioned); // один звук, а не по сообщению (не спамим при длинном обрыве)
    }
    if (mapped.length || adopted || canonicalized || duplicateLocalIds.size || reactionsChanged) this.emit();
  }
  private deliverMentionBatch(mentioned: ChatMessage[]) {
    if (!mentioned.length) return;
    // One notification for a recovered batch rather than one sound per row.
    this.hooks.toast(mentioned.length === 1 ? `${mentioned[0].who} упомянул тебя` : `Тебя упомянули · ${mentioned.length}`, 'info');
    const exactMention = mentioned.length === 1 && mentioned[0].sid != null ? mentioned[0] : null;
    const tag = 'mention:' + this.chatStateServerId + (exactMention ? ':' + exactMention.sid : '');
    notify('mention', {
      title: mentioned.length === 1 ? String(mentioned[0].who) : 'Упоминания',
      body: mentioned.length === 1 ? String(mentioned[0].text || '').slice(0, 140) : `Тебя упомянули · ${mentioned.length}`,
      tag,
      destination: exactMention ? { serverId: this.chatStateServerId, messageId: exactMention.sid! } : { serverId: this.chatStateServerId },
    });
  }
  private fenceSnapshotMentions() {
    const notifyRecovered = this.chatMentionFenceEstablished;
    const newlyClaimed: ChatMessage[] = [];
    for (const message of this.messages) {
      if (message.sid == null) continue;
      const newlySeen = claimBoundedMessageId(this.chatSnapshotSeenSids, message.sid);
      if (notifyRecovered && newlySeen && message.mention
        && this.claimChatMentionNotification(this.chatStateServerId, message.sid)) newlyClaimed.push(message);
    }
    this.chatMentionFenceEstablished = true;
    if (notifyRecovered) this.deliverMentionBatch(newlyClaimed);
  }
  private bufferCanonicalChatEvent(rev: number, event: ChatCanonicalEvent) {
    if (this.chatEventBuffer.some((item) => item.rev === rev)) return;
    if (this.chatEventBuffer.length >= 1000) {
      this.chatEventBuffer.shift();
      this.chatEventBufferOverflow = true;
    }
    this.chatEventBuffer.push({ rev, event });
  }
  private applyCanonicalChatEvent(serverId: string, event: ChatCanonicalEvent, revision: number) {
    if (serverId !== this.chatStateServerId) return;
    if (event.type === 'message.created') {
      if (event.message.id != null) claimBoundedMessageId(this.chatSnapshotSeenSids, event.message.id);
      const member = event.message.kind === 'release'
        ? undefined
        : this.members.find((candidate) => candidate.id === event.message.uid);
      const message: HistoryMessage = {
        ...event.message,
        ...(member ? { name: member.displayName, color: member.avatarColor } : {}),
        ...((event.mkey || event.message.mkey) ? { mkey: event.mkey || event.message.mkey } : {}),
      };
      this.mergeRecent([message], true);
      return;
    }
    if (event.type === 'message.updated') {
      const desired = this.chatEditDesired.get(`message:${serverId}:${event.messageId}`);
      const visibleText = desired?.text || event.text;
      let changed = false;
      this.messages = this.messages.map((message) => message.sid === event.messageId
        && (message.text !== visibleText || !message.edited)
        ? (changed = true, { ...message, text: visibleText, edited: true })
        : message);
      if (changed) this.emit();
      return;
    }
    if (event.type === 'message.deleted') {
      const removed = this.messages.filter((message) => message.sid === event.messageId);
      if (!removed.length) return;
      this.messages = this.messages.filter((message) => message.sid !== event.messageId);
      removed.forEach((message) => this.pendingSend.delete(message.id));
      this.reactions.delete(event.messageId);
      this.emit();
      return;
    }
    if (event.type === 'reaction.updated') {
      if (!this.messages.some((message) => message.sid === event.messageId)) return;
      if (event.reactions.length) {
        this.reactions.set(event.messageId, new Map(event.reactions.map((reaction) => [reaction.id, {
          name: reaction.name,
          count: reaction.count,
          mine: reaction.mine,
        }])));
      } else this.reactions.delete(event.messageId);
      this.overlayPendingReactionWrites(serverId);
      this.emit();
      return;
    }
    // A clear revision removes every operation already started before it from
    // the visible state too. If one POST commits after the clear transaction,
    // its strictly higher created revision will append it again. Keeping the
    // old sid-less row here would instead create a permanent ghost when both
    // its response and created event were lost.
    this.chatLastClearRevision = Math.max(this.chatLastClearRevision, revision);
    this.pendingSend.clear();
    this.clearDurableMutationBookkeeping();
    this.replaceChatSnapshot([], false, serverId);
    this.emit();
  }
  onServerChatEvent(serverId: string, rev: number, event: ChatCanonicalEvent) {
    if (!this.serverChatReady || serverId !== this.chatStateServerId || !Number.isSafeInteger(rev) || rev <= 0) return;
    if (this.chatRevisionKnown && rev <= this.chatRevision) return;
    if (this.chatSyncPromise || !this.chatRevisionKnown || rev !== this.chatRevision + 1) {
      this.bufferCanonicalChatEvent(rev, event);
      void this.synchronizeChat(serverId);
      return;
    }
    this.applyCanonicalChatEvent(serverId, event, rev);
    this.chatRevision = rev;
  }
  resynchronizeChat(serverId: string): Promise<number> {
    if (this.chatSyncPromise && serverId === this.chatStateServerId) this.chatSyncAgain = true;
    return this.synchronizeChat(serverId);
  }
  synchronizeChat(serverId: string): Promise<number> {
    if (!serverId || serverId !== this.chatStateServerId) return Promise.resolve(this.messages.length);
    if (this.chatSyncPromise) return this.chatSyncPromise;
    const generation = this.chatSyncGeneration;
    let retryDelay = 250;
    let tracked: Promise<number>;
    tracked = this.hooks.fetchChatSnapshot(serverId).then((snapshot) => {
      if (generation !== this.chatSyncGeneration || serverId !== this.chatStateServerId) return this.messages.length;
      const revision = snapshot.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) {
        if (this.serverChatReady) throw new Error('invalid chat revision');
        this.replaceChatSnapshot(snapshot.messages, snapshot.hasMore, serverId);
        this.fenceSnapshotMentions();
        this.emit();
        return this.messages.length;
      }
      const lastClearRevision = snapshot.lastClearRevision;
      if (!validChatSnapshotRevisions(revision, lastClearRevision)) throw new Error('invalid chat clear revision');
      if (lastClearRevision > this.chatLastClearRevision) this.clearDurableMutationBookkeeping();
      const unchangedAuthoritativeState = canReconcileUnchangedChatSnapshot(
        this.canonicalSnapshotEstablished,
        this.chatRevisionKnown,
        this.chatRevision,
        this.chatLastClearRevision,
        revision,
        lastClearRevision,
        this.chatEventBuffer.map((item) => item.rev),
        this.chatEventBufferOverflow,
      );
      if (unchangedAuthoritativeState) {
        // Polling/reconnect must not throw away pages which the reader loaded.
        // Still merge the exact latest page to adopt uid+mkey optimistic rows and
        // reconcile authoritative edits/reactions without touching pagination.
        this.mergeRecent(snapshot.messages, true, false);
      } else {
        this.replaceChatSnapshot(snapshot.messages, snapshot.hasMore, serverId, lastClearRevision);
        this.fenceSnapshotMentions();
        if (this.serverChatReady) this.canonicalSnapshotEstablished = true;
      }
      this.chatSyncFailures = 0;
      this.chatRevision = revision;
      this.chatLastClearRevision = lastClearRevision;
      this.chatRevisionKnown = true;
      const replay = planChatEventReplay(revision, this.chatEventBuffer, this.chatEventBufferOverflow);
      this.chatEventBuffer = [];
      this.chatEventBufferOverflow = false;
      for (const item of replay.events) {
        this.applyCanonicalChatEvent(serverId, item.event, item.rev);
        this.chatRevision = item.rev;
      }
      if (replay.gap) this.chatSyncAgain = true;
      this.emit();
      return this.messages.length;
    }).catch(() => {
      if (generation === this.chatSyncGeneration && serverId === this.chatStateServerId && this.serverChatReady) {
        this.chatSyncFailures++;
        retryDelay = Math.min(30_000, 1000 * 2 ** Math.min(this.chatSyncFailures - 1, 5));
        this.chatSyncAgain = true;
      }
      return this.messages.length;
    }).finally(() => {
      if (this.chatSyncPromise !== tracked) return;
      this.chatSyncPromise = null;
      if (generation !== this.chatSyncGeneration || serverId !== this.chatStateServerId || !this.chatSyncAgain) return;
      this.chatSyncAgain = false;
      window.setTimeout(() => {
        if (generation === this.chatSyncGeneration && serverId === this.chatStateServerId) void this.synchronizeChat(serverId);
      }, retryDelay);
    });
    this.chatSyncPromise = tracked;
    return tracked;
  }
  // догрузка более старых сообщений при скролле вверх — prepend в начало, курсор сдвигается назад
  prependHistory(list: HistoryMessage[], hasMore: boolean) {
    this.chatMore = hasMore;
    if (list.length) {
      const firstPagination = this.chatPrepended === 0;
      this.messages = [...this.mapHistory(list), ...this.messages];
      this.oldestSid = list[0].id ?? this.oldestSid;
      this.chatPrepended += list.length; // якорь virtuoso сдвигается вместе с данными (один emit) — без прыжка
      this.chatRetentionLimit = Math.min(
        chatRetentionLimitAfterProtectedInsert(
          this.chatRetentionLimit,
          this.messages.length,
          list.length,
          firstPagination ? CHAT_SESSION_MESSAGE_LIMIT : 0,
        ),
        // Страницы, которые читатель пролистал сам, входят в потолок через chatPrepended — легитимный
        // рост окна пагинация не теряет, ограничивается только накопленный реконнектами запас.
        chatRetentionHardCap(this.chatPrepended),
      );
    }
    this.emit();
  }
  // очистка чата (админ): локально + всем; сервер уже почищен вызывающей стороной
  clearMessages(byName?: string, broadcast = true) {
    ++this.chatGeneration;
    this.streamStateMessages.clear();
    this.pendingSend.clear();
    this.clearDurableMutationBookkeeping();
    this.reactions.clear();
    this.messages = [];
    this.chatMore = false;
    this.oldestSid = null;
    this.trimmedFront = 0;
    this.chatPrepended = 0;
    this.chatRetentionLimit = CHAT_SESSION_MESSAGE_LIMIT;
    if (broadcast) this.dataSend({ t: 'clear', by: byName || this.me.displayName });
    this.emit();
    this.sysMsg((byName || this.me.displayName) + ' очистил чат');
  }
  sendChatWithEmotes(text: string, em: Record<string, string>, img?: string, reply?: ReplyRef, files?: Attachment[]) {
    if (!text.trim() && !img && !(files && files.length)) return;
    const t = text.trim();
    const key = newClientKey(); // общий ключ: dedup POST + mkey для усыновления sid всеми клиентами (реакции на чужих)
    const canonicalTransport = this.serverChatReady;
    const bufferedRevision = this.chatEventBuffer.reduce((latest, item) => Math.max(latest, item.rev), 0);
    const baseRevision = this.chatRevisionKnown || bufferedRevision > 0
      ? Math.max(this.chatRevision, bufferedRevision)
      : null;
    // realtime-раздача только при поднятой комнате; локальный эхо + persist работают и без неё —
    // в окне фоновой докрутки connect (сразу после входа в сервер) сообщение не теряется, ложится в БД.
    if (!canonicalTransport && this.viewRoom) this.dataSend({ t: 'chat', name: this.me.displayName, text: t, em, color: this.me.avatarColor, img, files, uid: this.me.id, reply, mkey: key });
    const id = this.pushMsg(this.me.displayName, t, false, this.me.avatarColor, true, img, undefined, this.me.id, reply, files, key);
    this.pendingSend.set(id, { text: t, em, img, reply, key, files, canonicalTransport, baseRevision });
    this.hooks.persistMessage(t, em, img, reply, id, key, files, undefined, undefined, canonicalTransport);
  }

  // --- Рейтинг: анонс достижения уровня (веха ×5) ---
  private announcedLevels = new Set<string>(); // сессионный дедуп (сервер тоже дедупит по client_key)
  // Пришёл пуш levelup по notify-WS (см. notifyws.ts). Виновник — мы; объявляем ОДИН раз в чат этого
  // сервера. Только если сейчас смотрим этот сервер (иначе комнаты нет — в чужой чат слать нельзя).
  onLevelUp(serverId: string, level: number) {
    if (!serverId || !Number.isFinite(level) || level <= 0) return;
    if (this.chatStateServerId !== serverId) return;
    this.announceLevelUp(level);
  }
  private announceLevelUp(level: number) {
    const key = `lvl:${this.chatStateServerId}:${this.me.id}:${level}`;
    if (this.announcedLevels.has(key)) return; // уже объявляли в этой сессии
    this.announcedLevels.add(key);
    const text = `🎉 ${this.me.displayName} — ${level} уровень!`; // нейтрально по роду; карточка рисует имя+уровень отдельно
    const canonicalTransport = this.serverChatReady;
    // realtime-раздача в комнату (карточка kind='levelup') + локальный эхо + персист (оффлайн увидят из истории).
    if (!canonicalTransport && this.viewRoom) this.dataSend({ t: 'chat', name: this.me.displayName, text, color: this.me.avatarColor, uid: this.me.id, mkey: key, kind: 'levelup', level });
    const id = this.pushMsg(this.me.displayName, text, false, this.me.avatarColor, true, undefined, undefined, this.me.id, undefined, undefined, key, 'levelup', level);
    this.hooks.persistMessage(text, {}, undefined, undefined, id, key, undefined, 'levelup', level, canonicalTransport);
  }
  // --- реакции 7TV (по серверному sid) ---
  getReactions(sid?: number | null, localId?: number): Reaction[] {
    const key = sid ?? (localId != null ? -localId : null);
    if (key == null) return [];
    const m = this.reactions.get(key);
    if (!m) return [];
    return [...m.entries()].map(([id, v]) => ({ id, name: v.name, count: v.count, mine: v.mine })).filter((r) => r.count > 0);
  }
  private setOwnReaction(sid: number, emote: { id: string; name: string }, mine: boolean): boolean {
    let reactions = this.reactions.get(sid);
    if (!reactions) { reactions = new Map(); this.reactions.set(sid, reactions); }
    const current = reactions.get(emote.id) || { name: emote.name, count: 0, mine: false };
    if (current.mine === mine) return false;
    current.mine = mine;
    current.count = Math.max(0, current.count + (mine ? 1 : -1));
    current.name = emote.name;
    if (current.count <= 0) reactions.delete(emote.id); else reactions.set(emote.id, current);
    if (!reactions.size) this.reactions.delete(sid);
    return true;
  }
  private sendReaction(sid: number, emote: { id: string; name: string }, add: boolean) {
    const serverId = this.chatStateServerId;
    const canonicalTransport = this.serverChatReady;
    const persist = this.hooks.reactMessage;
    if (!persist) {
      this.dataSend({ t: 'react', sid, id: emote.id, name: emote.name, uid: this.me.id, add });
      return;
    }
    const key = `${serverId}:${sid}:${emote.id}`;
    const seq = (this.reactionWriteSeq.get(key) || 0) + 1;
    this.reactionWriteSeq.set(key, seq);
    this.reactionWriteDesired.set(key, { serverId, sid, emoteId: emote.id, name: emote.name, mine: add });
    const previous = this.reactionWrites.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => persist(serverId, sid, emote.id, emote.name, add, canonicalTransport)).then((result) => {
      // Broadcast only durable state. Peers never keep a reaction that the API
      // rejected, and serialized writes preserve rapid add -> remove order.
      if (result.changed) {
        this.publishLegacyConfirmed(serverId, { t: 'react', sid, id: emote.id, name: emote.name, uid: this.me.id, add });
      } else {
        // Duplicate add / missing remove is a successful no-op, so emitting a
        // participant delta would drift legacy counts. Reconcile the exact
        // aggregate while the desired mine state remains overlaid.
        void this.resynchronizeChat(serverId);
      }
    }).catch(() => {
      if (this.chatStateServerId !== serverId || this.reactionWriteSeq.get(key) !== seq) return;
      if (this.setOwnReaction(sid, emote, !add)) this.emit();
      this.hooks.toast('Не удалось сохранить реакцию — изменение отменено', 'warn');
      this.hooks.refetchChat?.(sid, serverId, false); // обычное сообщение: одна сверка реакций, без ожидания release
    });
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      if (this.reactionWrites.get(key) !== tracked) return;
      this.reactionWrites.delete(key);
      if (this.reactionWriteSeq.get(key) === seq) {
        this.reactionWriteSeq.delete(key);
        this.reactionWriteDesired.delete(key);
      }
    });
    this.reactionWrites.set(key, tracked);
  }
  toggleReaction(sid: number, emote: { id: string; name: string }) {
    const add = !(this.reactions.get(sid)?.get(emote.id)?.mine || false);
    if (this.setOwnReaction(sid, emote, add)) this.emit();
    this.sendReaction(sid, emote, add);
  }
  // У live-сообщения sid приезжает вторым reliable-событием после DB persist. Реакция доступна уже
  // сейчас: рисуем её на временном ключе -localId, а после adoption атомарно переносим и отправляем.
  toggleMessageReaction(target: { id: number; sid?: number | null }, emote: { id: string; name: string }) {
    // Picker может быть открыт как раз в момент, когда reliable `sid` усыновил live-сообщение.
    // Разрешаем актуальный sid заново по стабильному local id, а не доверяем снимку из UI.
    const message = this.messages.find((m) => m.id === target.id);
    if (!message) return;
    const currentSid = message.sid ?? target.sid;
    if (currentSid != null) { this.toggleReaction(currentSid, emote); return; }
    if (!message.mkey) return;
    const key = -target.id;
    let m = this.reactions.get(key); if (!m) { m = new Map(); this.reactions.set(key, m); }
    const cur = m.get(emote.id) || { name: emote.name, count: 0, mine: false };
    const add = !cur.mine;
    cur.mine = add; cur.count = Math.max(0, cur.count + (add ? 1 : -1)); cur.name = emote.name;
    if (cur.count <= 0) m.delete(emote.id); else m.set(emote.id, cur);
    if (!m.size) this.reactions.delete(key);
    this.emit();
  }
  private adoptPendingReactions(localId: number, sid: number): boolean {
    if (!this.messages.some((m) => m.id === localId && m.sid === sid)) return false;
    const pending = this.reactions.get(-localId);
    if (!pending) return false;
    this.reactions.delete(-localId);
    let target = this.reactions.get(sid); if (!target) { target = new Map(); this.reactions.set(sid, target); }
    let changed = false;
    pending.forEach((r, id) => {
      if (!r.mine) return;
      const cur = target!.get(id) || { name: r.name, count: 0, mine: false };
      if (!cur.mine) { cur.mine = true; cur.count++; cur.name = r.name; target!.set(id, cur); changed = true; this.sendReaction(sid, { id, name: r.name }, true); }
    });
    if (!target.size) this.reactions.delete(sid);
    return changed;
  }
  private applyReaction(d: any) {
    const sid = d.sid; if (typeof sid !== 'number' || d.uid === this.me.id) return; // своё не дублируем (эха обычно нет)
    let m = this.reactions.get(sid); if (!m) { m = new Map(); this.reactions.set(sid, m); }
    const cur = m.get(d.id) || { name: String(d.name || ''), count: 0, mine: false };
    cur.name = String(d.name || cur.name);
    cur.count = Math.max(0, cur.count + (d.add ? 1 : -1));
    if (cur.count <= 0 && !cur.mine) m.delete(d.id); else m.set(d.id, cur);
    this.emit();
  }
  // --- edit / delete своего сообщения ---
  editChat(sid: number, text: string) {
    const t = text.trim(); if (!t) return;
    const serverId = this.chatStateServerId;
    const canonicalTransport = this.serverChatReady;
    const previous = this.messages.find((message) => message.sid === sid);
    if (!previous || !serverId) return;
    const key = `message:${serverId}:${sid}`;
    const seq = (this.chatMutationSeq.get(key) || 0) + 1;
    this.chatMutationSeq.set(key, seq);
    this.chatEditDesired.set(key, { seq, text: t });
    this.messages = this.messages.map((m) => (m.sid === sid ? { ...m, text: t, edited: true } : m));
    this.emit();
    const persist = this.hooks.editMessage;
    if (!persist) { this.chatEditDesired.delete(key); this.dataSend({ t: 'edit', sid, text: t }); return; }
    const previousWrite = this.chatMutationWrites.get(key) || Promise.resolve();
    const run = previousWrite.catch(() => {}).then(() => persist(serverId, sid, t, canonicalTransport)).then(() => {
      this.publishLegacyConfirmed(serverId, { t: 'edit', sid, text: t });
    }).catch(() => {
      if (this.chatStateServerId !== serverId || this.chatMutationSeq.get(key) !== seq) return;
      this.messages = this.messages.map((message) => message.sid === sid && message.text === t
        ? { ...message, text: previous.text, edited: previous.edited }
        : message);
      this.emit();
      this.hooks.toast('Не удалось изменить сообщение — изменение отменено', 'warn');
      void this.resynchronizeChat(serverId);
    });
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      if (this.chatMutationWrites.get(key) !== tracked) return;
      this.chatMutationWrites.delete(key);
      if (this.chatMutationSeq.get(key) === seq) {
        this.chatMutationSeq.delete(key);
        this.chatEditDesired.delete(key);
      }
    });
    this.chatMutationWrites.set(key, tracked);
  }
  deleteChat(sid: number) {
    const serverId = this.chatStateServerId;
    const canonicalTransport = this.serverChatReady;
    if (!serverId || !this.messages.some((message) => message.sid === sid)) return;
    const key = `message:${serverId}:${sid}`;
    const seq = (this.chatMutationSeq.get(key) || 0) + 1;
    this.chatMutationSeq.set(key, seq);
    this.chatEditDesired.delete(key);
    this.messages = this.messages.filter((m) => m.sid !== sid);
    this.reactions.delete(sid);
    this.emit();
    const persist = this.hooks.deleteMessage;
    if (!persist) { this.dataSend({ t: 'del', sid }); return; }
    const previousWrite = this.chatMutationWrites.get(key) || Promise.resolve();
    const run = previousWrite.catch(() => {}).then(() => persist(serverId, sid, canonicalTransport)).then(() => {
      this.publishLegacyConfirmed(serverId, { t: 'del', sid });
    }).catch(() => {
      if (this.chatStateServerId !== serverId || this.chatMutationSeq.get(key) !== seq) return;
      this.hooks.toast('Не удалось удалить сообщение — возвращаю актуальный чат', 'warn');
      void this.resynchronizeChat(serverId);
    });
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      if (this.chatMutationWrites.get(key) !== tracked) return;
      this.chatMutationWrites.delete(key);
      if (this.chatMutationSeq.get(key) === seq) this.chatMutationSeq.delete(key);
    });
    this.chatMutationWrites.set(key, tracked);
  }
  private applyEdit(d: any, senderUid?: string) {
    if (typeof d.sid !== 'number') return;
    if (!senderUid || !this.messages.some((m) => m.sid === d.sid && m.uid === senderUid)) return;
    let ch = false;
    this.messages = this.messages.map((m) => (m.sid === d.sid && m.uid === senderUid ? (ch = true, { ...m, text: String(d.text || ''), edited: true }) : m));
    if (ch) this.emit();
  }
  private applyDelete(d: any, senderUid?: string) {
    if (typeof d.sid !== 'number') return;
    if (!senderUid || !this.messages.some((m) => m.sid === d.sid && m.uid === senderUid)) return;
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !(m.sid === d.sid && m.uid === senderUid));
    if (this.messages.length !== before) { this.reactions.delete(d.sid); this.emit(); }
  }
  sendTyping() {
    if (!this.viewRoom) return;
    const now = Date.now();
    if (now - this.lastTypingSent < 2200) return; // троттлинг
    this.lastTypingSent = now;
    this.dataSend({ t: 'typing', name: this.me.displayName });
  }
  private pruneTyping() {
    const now = Date.now(); let ch = false;
    this.typingUsers.forEach((exp, n) => { if (exp <= now) { this.typingUsers.delete(n); ch = true; } });
    if (ch) this.emit();
  }
  private onData = (payload: Uint8Array, room?: Room, sender?: RemoteParticipant) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(payload));
      if (d.t === 'vclaim') {
        // vclaim прилетает по voiceRoom (dataSend роутит vclaim→voiceRoom) — обрабатываем только от неё.
        // Другая моя сессия зашла в голосовой → выхожу (одна голосовая на аккаунт). tie-break: если ГОНКА
        // (я тоже только что заявил голос) — уступает сессия с меньшим session-id; вне гонки новый девайс побеждает.
        if (room !== this.voiceRoom || !sender) return;
        const senderUsername = baseUid(sender.identity);
        const senderMember = this.members.find((m) => m.username === senderUsername);
        const hash = sender.identity.indexOf('#');
        const senderSession = hash < 0 ? sender.identity : sender.identity.slice(hash + 1);
        const parsedEpoch = Number(d.epoch);
        if (!Number.isSafeInteger(parsedEpoch) || parsedEpoch < 1) return;
        const senderEpoch = parsedEpoch;
        // Data channel доступен всем участникам комнаты: не доверяем uid/session из JSON. Claim обязан
        // совпасть с фактическим LiveKit-отправителем, иначе любой участник мог бы выгнать чужой аккаунт.
        if (!senderMember || d.uid !== senderMember.id || String(d.session || '') !== senderSession) return;
        const attrEpoch = Number((sender as any).attributes?.voiceEpoch) || 0;
        if (attrEpoch > 0 && (!Number.isSafeInteger(attrEpoch) || attrEpoch !== senderEpoch)) return;
        const currentClaim = this.activeVoiceSessions.get(senderUsername);
        // Reliable гарантирует порядок только внутри одного sender. Между ПК и телефоном старый
        // vclaim может приехать позже нового конкретно этому слушателю — не даём ему откатить выбор.
        if (!currentClaim || senderEpoch > currentClaim.epoch
          || (senderEpoch === currentClaim.epoch && sender.identity > currentClaim.identity)) {
          this.activeVoiceSessions.set(senderUsername, { identity: sender.identity, epoch: senderEpoch });
        }
        this.reconcileUserAudio(senderUsername);
        if (d.uid === this.me.id && senderUsername === this.me.username && sender.identity !== room.localParticipant.identity && this.inVoice) {
          const race = Date.now() - this.lastVclaim < 800;
          // При наличии server lease старый/legacy vclaim уже не авторитетен. Выходим только перед
          // строго более новым epoch; основной сигнал всё равно приходит по notify-WS.
          const newerLease = this.voiceLeaseEpoch <= 0 || senderEpoch > this.voiceLeaseEpoch;
          if (newerLease && (!race || senderSession > this.sessionId())) void this.leaveVoice();
        }
        this.emit();
        return;
      }
      // music (совместное прослушивание YouTube) — по voiceRoom; scoped по vc уже внутри music-store
      // чат/clear/emote/watch/typing — данные ПРОСМАТРИВАЕМОГО сервера, приходят по viewRoom
      if (room !== this.viewRoom) return;
      const senderUsername = sender ? baseUid(sender.identity) : '';
      const senderMember = senderUsername ? this.members.find((m) => m.username === senderUsername) : undefined;
      const senderUid = senderMember?.id;
      // Realtime payload не является авторитетом для личности отправителя. Не принимаем
      // uid, который не совпадает с LiveKit identity; иначе участник мог подделать имя,
      // uid и изменить локальный чат от имени другого человека.
      if (sender && (!senderMember || (d.uid != null && String(d.uid) !== senderUid))) return;
      // Release-пакет из RoomService не имеет participant-sender. Не доверяем его
      // payload: он лишь просит сверить авторитетную HTTP-историю. Пакет от обычного
      // участника с kind=release игнорируем, чтобы нельзя было подделать карточку RelayApp.
      if (d.t === 'release' || (d.t === 'chat' && d.kind === 'release')) {
        if (!sender) this.refreshChat(typeof d.sid === 'number' ? d.sid : undefined, this.chatStateServerId);
        return;
      }
      if (this.serverChatReady
        && (d.t === 'chat' || d.t === 'react' || d.t === 'edit' || d.t === 'del' || d.t === 'sid' || d.t === 'clear')) return;
      if (d.t === 'chat') {
        if (d.em) for (const k in d.em) this.onEmoteResolve?.(k, d.em[k]);
        this.typingUsers.delete(d.name);
        const authorName = sender ? (senderMember?.displayName || senderUsername) : String(d.name || '');
        const authorColor = senderMember?.avatarColor ?? d.color;
        const authorUid = senderUid || d.uid;
        const own = authorUid === this.me.id; // моё же сообщение с другой сессии — показываем как своё, без звука/меншена
        const repliedToMe = !own && this.replyToMe(d.reply);
        const mentioned = !own && (this.textMentionsMe(d.text) || repliedToMe);
        this.pushMsg(authorName, d.text, false, authorColor, own, d.img, undefined, authorUid, d.reply, d.files, d.mkey, d.kind, d.level);
        if (!own && mentioned) { // тост+notify ТОЛЬКО когда тегнули/реплайнули; звук тега даёт само notify (Discord)
          this.hooks.toast(repliedToMe ? `${authorName} ответил тебе` : `${authorName} упомянул тебя`, 'info');
          const fallback = d.img ? '🖼 изображение' : (d.files && d.files.length ? '📎 вложение' : '');
          const tag = 'mention:' + this.chatStateServerId + (d.mkey ? ':' + String(d.mkey) : '');
          notify('mention', { title: authorName, body: String(d.text || '').slice(0, 140) || fallback, tag });
        }
      }
      else if (d.t === 'clear') {
        if (sender && this.chatStateServerId) {
          // An explicit trusted legacy clear is also an authoritative boundary:
          // remove pre-clear optimistic ghosts immediately, then replace (not
          // merge) from the authenticated HTTP snapshot. Old APIs without a
          // revision are supported by synchronizeChat while canonical is off.
          this.clearMessages(senderMember?.displayName || senderUsername, false);
          void this.resynchronizeChat(this.chatStateServerId);
        }
      }
      else if (d.t === 'emote') this.emoteListeners.forEach((f) => f(d.s, d.e, d.by, d.x, d.sz));
      else if (d.t === 'watch' && senderUsername) { const m = this.wset(d.s); if (d.on) m.set(senderUsername, { name: senderMember?.displayName || senderUsername, color: senderMember?.avatarColor ?? 0, avatarUrl: senderMember?.avatarUrl, ts: Date.now() }); else m.delete(senderUsername); this.emit(); }
      else if (d.t === 'typing' && senderMember) { const name = senderMember.displayName; if (name !== this.me.displayName) { this.typingUsers.set(name, Date.now() + 3500); this.emit(); setTimeout(() => this.pruneTyping(), 3600); } }
      else if (d.t === 'react' && senderUid && d.uid === senderUid) this.applyReaction(d);
      else if (d.t === 'edit') this.applyEdit(d, senderUid);
      else if (d.t === 'del') this.applyDelete(d, senderUid);
      else if (d.t === 'sid') this.applySidAdopt(d, senderUid);
    } catch { /**/ }
  };
  onEmoteResolve: ((name: string, id: string) => void) | null = null;
  // Rolling-deploy bridge for already-open legacy tabs. This is deliberately
  // narrower than dataSend: it can publish only a mutation whose HTTP promise
  // has already resolved, into the exact current LiveKit room. It must not read
  // the current capability mode because that mode can flip while the request is
  // in flight; the caller captured and marked the transport at action start.
  publishLegacyConfirmed(serverId: string, obj:
    | { t: 'react'; sid: number; id: string; name: string; uid: string; add: boolean }
    | { t: 'edit'; sid: number; text: string }
    | { t: 'del'; sid: number }
    | { t: 'clear'; by: string }
  ) {
    const room = this.viewRoom;
    if (!room || !serverId || this.chatStateServerId !== serverId || this.viewServerId !== serverId) return;
    const validSid = 'sid' in obj && Number.isSafeInteger(obj.sid) && obj.sid > 0;
    const valid = obj.t === 'react'
      ? validSid && obj.uid === this.me.id && typeof obj.id === 'string' && obj.id.length > 0 && obj.id.length <= 64
        && typeof obj.name === 'string' && obj.name.length > 0 && obj.name.length <= 64 && typeof obj.add === 'boolean'
      : obj.t === 'edit'
        ? validSid && typeof obj.text === 'string' && obj.text.length > 0 && obj.text.length <= 1000
        : obj.t === 'del'
          ? validSid
          : typeof obj.by === 'string' && obj.by.length > 0 && obj.by.length <= 80;
    if (!valid) return;
    try {
      void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true }).catch(() => {});
    } catch { /**/ }
  }
  // reliable для состояния, которое нельзя терять: чат (сообщения), vclaim (одна голосовая на
  // аккаунт — потеря датаграммы оставила бы две сессии в войсе), clear (чистка чата).
  // vclaim принадлежит голосовой сессии → voiceRoom; чат/clear/typing/emote/watch — просматриваемому серверу → viewRoom
  private dataSend(obj: any) {
    if (this.serverChatReady
      && (obj.t === 'chat' || obj.t === 'react' || obj.t === 'edit' || obj.t === 'del' || obj.t === 'sid' || obj.t === 'clear')) return;
    const room = obj.t === 'vclaim' ? this.voiceRoom : this.viewRoom;
    if (!room) return;
    try { void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: obj.t === 'chat' || obj.t === 'vclaim' || obj.t === 'clear' || obj.t === 'react' || obj.t === 'edit' || obj.t === 'del' || obj.t === 'sid' }).catch(() => {}); } catch { /**/ }
  }

  emoteImg(id: string) { return emoteUrl(id); }
}

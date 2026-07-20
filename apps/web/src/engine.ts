import {
  Room, RoomEvent, Track, LocalAudioTrack, AudioPresets, ConnectionQuality,
  type RemoteParticipant, type Participant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { User, Member, ChatMessage, Emote, HistoryMessage, ReplyRef, Attachment, Reaction, ReleaseNote } from './types';
import { baseUid } from './util';
import { notify } from './notify';
import { api, type VoiceLeaseEvent } from './api';
import { isTauri, detectGame } from './native';
import { getSettings, setSettings } from './settings';
import { emoteUrl } from './emotes';
import { playSound } from './sounds';
import type { VideoTransport } from './transport/videoTransport';
import { LiveKitVideoTransport } from './transport/livekitVideo';
import { TreeVideoTransport } from './transport/treeVideo';
import { createDenoiseNode, destroyDenoiseNode } from './denoise';
import { userVolumeToGain } from './volumeCurve';
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';

export interface GameStatus { name: string; icon?: string }
export interface PeerState { online: boolean; inVoice: boolean; micMuted: boolean; streaming: boolean; deafened: boolean; away: boolean; game?: GameStatus | null }
export interface StreamInfo { key: string; identity: string; isLocal: boolean; appName?: string; appIcon?: string }
export type VoiceQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export interface Snapshot {
  connected: boolean;
  roomReady: boolean; // комната реально поднялась (после await connect), а не просто создан объект Room
  reconnecting: boolean;
  voiceQuality: VoiceQuality; // качество связи в голосовом (LiveKit ConnectionQuality)
  voicePing: number | null;   // RTT до сервера, мс (из WebRTC-статистики)
  inVoice: boolean;
  voiceConnecting: boolean;                    // оптимистично зашли, но mic ещё не опубликован (идёт подключение)
  myVoiceChannel: string | null;              // id голосового канала, в котором я сейчас (null = не в голосовом)
  voiceServerId: string | null;               // сервер, на котором я в голосовом (для персистентного VoiceDock + гарда auto-leave); null = не в голосе
  voiceChannels: Record<string, string>;      // username -> channelId (кто в каком голосовом канале)
  channelActiveSince: Record<string, number>; // channelId -> epoch ms первого захода в ПУСТОЙ канал (таймер в списке каналов, как в Discord)
  deafened: boolean;
  localMicMuted: boolean;
  micUnavailable: boolean; // зашёл в голосовой без микрофона (нет доступа) — listen-only
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

// шкала чувствительности ввода: rms(0..1) -> dB(-80..0) -> норм.уровень(0..1), сравнимый с порогом
const WATCH_MAX = 4; // грид: сколько чужих стримов зритель смотрит разом (веб — tree-WS/PC на стрим, натив — Rust relay-слот на стрим)
const STREAM_EDGE_GRACE_MS = 500;
const STREAM_MESSAGE_AGGREGATE_MS = 30_000;
const MIN_DB = -50; // шкала подогнана под уже обработанный браузером сигнал (AGC/NS), а не под теоретический динамический диапазон
function rmsToDb(rms: number): number { if (rms <= 0) return MIN_DB; return Math.max(MIN_DB, Math.min(0, 20 * Math.log10(rms))); }
function dbToNorm(db: number): number { return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB)); }

interface EngineHooks {
  toast: (text: string, kind?: 'ok' | 'warn' | 'err' | 'info') => void;
  saveSettings: (serverId: string, vols: { users: Record<string, number>; streams: Record<string, number> }) => void;
  peerJoined: (identity: string) => void;
  persistMessage: (text: string, em: Record<string, string>, image: string | undefined, reply: ReplyRef | undefined, localId: number, key: string, files?: Attachment[], kind?: string, level?: number) => void;
  refetchChat?: (sid?: number, serverId?: string) => void; // sid адресно сверяет строку; serverId отделяет history recovery от готовности LiveKit
  endBroadcast?: () => void; // остановить нативную трансляцию (Rust) при выходе из голосового — browser-share гасит stopShare
  reactMessage?: (serverId: string, sid: number, emoteId: string, emoteName: string, add: boolean) => Promise<void>; // персист реакции
  editMessage?: (serverId: string, sid: number, text: string) => void;   // персист редактирования
  deleteMessage?: (serverId: string, sid: number) => void;               // персист удаления
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
  private voiceRoom: Room | null = null;
  private me: User;
  private members: Member[] = [];
  private hooks: EngineHooks;

  inVoice = false;
  private voiceConnecting = false; // оптимистично зашли в канал, но mic ещё публикуется
  private voiceEpoch = 0; // поколение пользовательского voice-intent; инвалидирует старые async join/leave/switch
  private micEpoch = 0;   // поколение mic pipeline; старый gUM/RNNoise/publish не имеет права ожить после stop/restart
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
  private voiceLeaseAuditRunning = false;
  private voiceLeaseAuditTick = 0;
  private readyRooms = new WeakSet<Room>();
  private roomSessions = new WeakMap<Room, string>();
  private intentionalDisconnects = new WeakSet<Room>();
  private voiceAttrDesired = new WeakMap<Room, Record<string, string>>();
  private voiceAttrWrites = new WeakMap<Room, Promise<void>>();
  private lastVclaim = 0; // когда мы сами заявили голос (для tie-break гонки claim'ов между своими сессиями)
  private currentVc: string | null = null; // id голосового канала, в котором я сейчас (несколько каналов на сервер)
  private myVcAt: number | null = null;    // epoch ms момента, когда занятость МОЕГО канала началась (унаследован от тех, кто уже там был, либо now() если я первый)
  private myChannelPeers = new Set<string>(); // кто в моём голосовом канале (диф → entry/exit при входе/выходе/смене канала)
  private roomReady = false; // true только после успешного await r.connect() (не просто наличие объекта Room)
  private reconnecting = false;
  private connQuality: VoiceQuality = 'unknown'; // качество связи (обновляется по событию LiveKit)
  private pingMs: number | null = null;          // RTT до сервера, мс (опрос статистики в голосовом)
  private connTimer: number | null = null;       // таймер опроса пинга (только в голосовом)
  private deafened = localStorage.getItem('voiceDeaf') === '1'; // персист: пред-установка «оглох» до входа (Discord-стиль)
  private noMic = false; // зашёл в голосовой без микрофона (нет доступа) — listen-only, НЕ персист
  private pttDown = false;
  private watchTimers = new Map<string, number>();

  // mic pipeline: raw device -> [denoise?] -> gain (громкость/мут) -> published track
  //                                        \-> vadDest (отвод для VAD/метра, ДО гейта)
  private micRaw: MediaStream | null = null;
  private micActx: AudioContext | null = null;
  private micGain: GainNode | null = null;
  private micDenoise: RnnoiseWorkletNode | null = null;
  private micVadDest: MediaStreamAudioDestinationNode | null = null;
  private manualMute = localStorage.getItem('voiceMute') === '1'; // персист: пред-установка «мут мика» до входа (Discord-стиль)
  private saveVoicePrefs() { try { localStorage.setItem('voiceMute', this.manualMute ? '1' : '0'); localStorage.setItem('voiceDeaf', this.deafened ? '1' : '0'); } catch { /**/ } }
  private deafToggling = false; // окно подавления mute/unmute-звука от track.mute()/unmute() при оглушении (deaf сам играет fullMute/unmute)

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
  private screenAudioEls = new Map<string, HTMLMediaElement>();
  private voiceAudioEls = new Map<string, { identity: string; track: RemoteTrack; el: HTMLMediaElement }>();
  private watching = new Set<string>();
  // Транспорт, которым РЕАЛЬНО открыт watch. transportFor смотрит на «кто сейчас объявлен
  // вещающим» — это состояние меняется под активным watch (напр. stream-end уже удалил
  // запись из liveStreams) и роутинг уезжает не в тот транспорт. Пин снимает весь класс.
  private watchT = new Map<string, VideoTransport>();
  private pendingWatch = new Set<string>();
  private streamWatchers = new Map<string, Map<string, { name: string; color: number; avatarUrl?: string; ts: number }>>();
  private messages: ChatMessage[] = [];
  // Реакции 7TV по сообщению (ключ — серверный sid): emoteId -> {name, count, mine}. Источник правды —
  // история (getReactions читает UI); realtime-события (t:'react') мутируют, refetch корректирует дрейф.
  private reactions = new Map<number, Map<string, { name: string; count: number; mine: boolean }>>();
  private reactionWrites = new Map<string, Promise<void>>();
  private reactionWriteSeq = new Map<string, number>();
  private reactionWriteDesired = new Map<string, { serverId: string; sid: number; emoteId: string; name: string; mine: boolean }>();
  private chatGeneration = 0;
  private chatMore = false; // есть ли ещё более старые сообщения на сервере (пагинация вверх)
  private oldestSid: number | null = null; // DB-id самого старого загруженного сообщения = курсор для before
  private trimmedFront = 0; // сколько сообщений суммарно срезано с НАЧАЛА (для якоря virtuoso: срез спереди → firstItemIndex += N)
  private chatPrepended = 0; // сколько старых сообщений догружено пагинацией (для якоря: prepend → firstItemIndex -= N). Меняется ВМЕСТЕ с messages (один emit) → нет прыжка.
  private typingUsers = new Map<string, number>(); // displayName -> expiry ts
  private lastTypingSent = 0;

  private analysers = new Map<string, { an: AnalyserNode; buf: Uint8Array; hold: number; src: MediaStreamAudioSourceNode }>();
  private spCtx: AudioContext | null = null;
  private spRAF: number | null = null;
  private audioUnlock: (() => void) | null = null; // снятие разового gesture-анлока micActx (см. ensureVoiceAudioRunning)
  private spTick = 0;
  private speakingSet = new Set<string>();

  private keepCtx: AudioContext | null = null;
  private keepOsc: OscillatorNode | null = null;
  private screenStream: MediaStream | null = null;
  private presenceTimer: number | null = null;
  private viewServerId = '';                   // сервер, который смотрю (viewRoom) — теги notify чата/стримов
  private voiceServerId: string | null = null; // сервер, где я в голосовом (voiceRoom) — broadcast + снапшот; null вне войса
  private gameTimer: number | null = null;
  private myGame: GameStatus | null = null; // игра на переднем плане (натив, если включено в настройках)

  private volsByServer = new Map<string, { users: Record<string, number>; streams: Record<string, number> }>();
  private perMuteByServer = new Map<string, Set<string>>();
  private onlineHint = new Set<string>();
  private awayHint = new Set<string>();  // серверный хинт: члены «нет на месте» (idle, из /presence.away)
  private voiceHint: Record<string, string> = {}; // серверный хинт {username: channelId}: состав голосовых до подъёма локальной комнаты
  private activeVoiceSessions = new Map<string, { identity: string; epoch: number }>(); // monotonic vclaim per base user
  private subscriptionRetries = new Map<string, { attempts: number; nextAt: number }>();
  private voiceOutputRoom: Room | null = null;
  private voiceOutputSink = '';
  // LiveKit 2.20 does not await WebAudio AudioContext.setSinkId inside
  // Room.switchActiveDevice(). Own the mixer context so a rejected device
  // switch can never be mistaken for a successful one.
  private outputCtx: SinkableAudioContext | null = null;
  private outputSwitch: Promise<void> = Promise.resolve();
  private outputGeneration = 0;
  private voiceOutputPending: { room: Room; sink: string } | null = null;
  private outputDeviceTimer: number | null = null;

  private emoteListeners = new Set<EmoteListener>();
  private subs = new Set<() => void>();
  private snap: Snapshot;

  // VAD-гейт микрофона (режим "активация голосом"): передаём звук только выше порога чувствительности
  private vadOpen = false;
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

  constructor(me: User, hooks: EngineHooks) {
    this.me = me;
    this.hooks = hooks;
    const onVideoTrack = (_key: string, _track: unknown, identity: string, isLocal: boolean) => {
      if (!isLocal) this.completeWatch(baseUid(identity));
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
    this.treeT.onSeamlessSwitchFailed?.((_sid) => {
      this.hooks.toast('Не удалось переключить качество — стрим прервался', 'warn');
      this.emit();
    });
    // Headsets/Bluetooth outputs may disappear without touching the settings
    // UI. Re-verify both output routing and the captured mic immediately; the
    // regular watchdog remains the fallback for browsers without devicechange.
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (this.outputDeviceTimer) clearTimeout(this.outputDeviceTimer);
      this.outputDeviceTimer = window.setTimeout(() => {
        this.outputDeviceTimer = null;
        if (this.viewRoom || this.voiceRoom) void this.applyOutput();
        if (this.inVoice) void this.checkMicAlive(true);
      }, 200);
    });
    this.snap = this.build();
  }

  setMe(me: User) { this.me = me; }
  setMembers(m: Member[]) { this.members = m; this.emit(); }
  setOnlineHint(ids: string[]) { this.onlineHint = new Set(ids); this.emit(); }
  setAwayHint(ids: string[]) { this.awayHint = new Set(ids); this.emit(); }
  setVoiceHint(v: Record<string, string>) { this.voiceHint = v || {}; this.emit(); }
  setVols(serverId: string, v: { users?: Record<string, number>; streams?: Record<string, number> }) {
    if (!serverId) return;
    this.volsByServer.set(serverId, { users: { ...(v.users || {}) }, streams: { ...(v.streams || {}) } });
    if (serverId === this.voiceServerId) this.applyAllVolumes();
    if (serverId === this.viewServerId) this.applyAllStreamVolumes();
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
        const at = m.username === this.me.username ? this.myVcAt : Number((p as any)?.attributes?.vcAt) || null;
        if (at && (!(vc in channelActiveSince) || at < channelActiveSince[vc])) channelActiveSince[vc] = at;
      }
      const inV = !!vc; // членство канала задаёт vc-атрибут, mic publication не является presence
      const mp = p ? p.getTrackPublication(Track.Source.Microphone) : undefined;
      // «оглох» (deafen) транслируется пирам participant-атрибутом deaf (как vc для голосового
      // канала) — иначе другие видят для оглохшего то же «мик выключен», что и для просто мута.
      const deaf = m.username === this.me.username ? this.deafened : !!(p as any)?.attributes?.deaf;
      // !mp (трек ещё не опубликован / не доехал) — это «пока не знаем», а не «замучен»: иначе
      // на секунду мигал бы ложный бейдж «мут» всем в канале. || deaf — оглохший всегда замьючен.
      // «играет в X»: для себя — локальный детект, для пира — participant-атрибуты game/gicon
      let game: GameStatus | null = null;
      if (m.username === this.me.username) game = this.myGame;
      else { const gn = (p as any)?.attributes?.game; if (gn) game = { name: gn, icon: (p as any)?.attributes?.gicon || undefined }; }
      const streaming = this.isStreaming(m.username);
      // Игра показывается ТОЛЬКО из detect_game (атрибут/локальный myGame), НЕ из меты стрима: захваченное
      // окно ≠ «во что играет» (по решению пользователя). Стример без игры — просто LIVE, без «играет в X».
      const away = !inV && !streaming && this.awayHint.has(m.username); // idle-онлайн («нет на месте», жёлтый)
      presence[m.username] = { online, inVoice: inV, micMuted: (!!mp && mp.isMuted) || deaf, streaming, deafened: deaf, away, game };
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
    return {
      connected: !!this.viewRoom, roomReady: this.roomReady, reconnecting: this.reconnecting,
      voiceQuality: this.inVoice ? this.connQuality : 'unknown', voicePing: this.inVoice ? this.pingMs : null,
      inVoice: this.inVoice, voiceConnecting: this.inVoice && (this.voiceConnecting || this.voiceLeaseVerifying), myVoiceChannel: this.currentVc, voiceServerId: this.voiceServerId, voiceChannels, channelActiveSince, deafened: this.deafened,
      localMicMuted: this.localMicMuted(), micUnavailable: this.noMic, pttDown: this.pttDown,
      presence, speaking, streams, watching, pending, watchers, messages: this.messages, chatHasMore: this.chatMore, chatTrimmed: this.trimmedFront, chatPrepended: this.chatPrepended,
      typing: [...this.typingUsers].filter(([n, exp]) => exp > Date.now() && n !== this.me.displayName).map(([n]) => n),
    };
  }

  private getOutputContext(): SinkableAudioContext | null {
    if (this.outputCtx && this.outputCtx.state !== 'closed') return this.outputCtx;
    try { this.outputCtx = new AudioContext() as SinkableAudioContext; }
    catch { this.outputCtx = null; }
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
  private queueContextOutput(requested: string): Promise<void> {
    const ctx = this.getOutputContext();
    const run = this.outputSwitch.catch(() => {}).then(async () => {
      if (!ctx?.setSinkId) {
        if (requested !== 'default') throw new Error('Audio output switching is not supported');
        return;
      }
      await ctx.setSinkId(await this.normalizedContextSink(requested));
    });
    // Keep the queue usable after a rejected hardware switch while returning
    // the original promise to the caller so it can perform the fallback.
    this.outputSwitch = run.catch(() => {});
    return run;
  }
  private async switchContextOutput(requested: string, notifyOnFallback = true): Promise<string | null> {
    const generation = ++this.outputGeneration;
    try {
      await this.queueContextOutput(requested);
      if (generation !== this.outputGeneration || (getSettings().output || 'default') !== requested) return null;
      return requested;
    } catch {
      // Never let a failed A overwrite a newer B. The generation check occurs
      // before enqueueing the fallback; if B starts just after this check, its
      // operation is queued after default and therefore still wins.
      if (generation !== this.outputGeneration || (getSettings().output || 'default') !== requested) return null;
      if (requested === 'default') return 'default';
      await this.queueContextOutput('default').catch(() => {});
      if (generation !== this.outputGeneration || (getSettings().output || 'default') !== requested) return null;
      // A newer A -> B selection may already be queued. Only the still-current
      // failed selection is allowed to rewrite settings or show a warning.
      setSettings({ output: '' });
      if (notifyOnFallback) this.hooks.toast('Устройство вывода недоступно — включено системное', 'warn');
      return 'default';
    }
  }

  /* ---------- connection ---------- */
  async connect(url: string, token: string, serverId: string, sessionId: string) {
    const connectEpoch = ++this.connectEpoch;
    this.resetStreamEdges();
    const outputCtx = this.getOutputContext();
    const r = new Room({
      adaptiveStream: true, dynacast: true,
      // UI разрешает индивидуальное усиление до 200%. Без WebAudio mixer LiveKit пишет это
      // в HTMLMediaElement.volume (диапазон только 0..1), получает IndexSizeError и может оставить 0.
      webAudioMix: outputCtx ? { audioContext: outputCtx } : true,
      publishDefaults: { dtx: true, red: true, simulcast: true, audioPreset: AudioPresets.musicHighQuality },
    });
    if (sessionId) this.roomSessions.set(r, sessionId);
    void this.switchContextOutput(getSettings().output || 'default');
    // connect поднимает ТОЛЬКО viewRoom (смотрю сервер). voiceRoom НЕ трогаем — им владеют join/leaveVoice:
    // при входе в голос voiceRoom:=viewRoom (реюз), при уходе на другой сервер голосовая комната остаётся.
    this.viewRoom = r;
    this.viewServerId = serverId;
    this.roomReady = false;
    this.liveKitT.attach(r, { me: this.me.username, serverId });
    this.treeT.attach(r, { me: this.me.username, serverId });
    // Хендлеры ветвятся по РОЛИ комнаты r: voice-работа при r===voiceRoom, view-работа при r===viewRoom.
    // Пока комнаты равны (4a) — обе ветви истинны, как раньше. При расцепе (4c) событие voice-only комнаты
    // A не запустит view-логику (чат/presence), а view-only комнаты B — voice-логику (mic/vc/vclaim).
    r.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSub(track, pub, p, r))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.onUnsub(track, pub, p, r))
      .on(RoomEvent.ParticipantConnected, (p) => { const u = baseUid(p.identity); if (r === this.voiceRoom) { this.observeVoiceSession(p); this.reconcileUserAudio(u); } if (r === this.viewRoom) { if (u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.hooks.toast((p.name || u) + ' в сети', 'ok'); this.hooks.peerJoined(u); } this.emit(); })
      // u !== this.me.username — иначе отключение СВОЕЙ же зомби-сессии (неудачный первый коннект,
      // сеть/деплой) чистит АНАЛИЗАТОР ТЕКУЩЕЙ живой сессии (detachAnalyser(me) внутри cleanupPeer):
      // полоска чувствительности замирает, гейт «активация голосом» может замереть закрытым — мик
      // «пропадает» без видимой причины, лечится только перезаходом в канал. См. ParticipantConnected
      // строкой выше — та же защита у него уже была, тут её не хватало.
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        const u = baseUid(p.identity);
        this.clearSubscriptionRetries(p.identity);
        // Monotonic tombstone сохраняем: если после handoff новая сессия ушла, старая с меньшим
        // epoch не должна снова стать активной только потому, что всё ещё висит participant'ом.
        if (r === this.viewRoom && u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.cleanupPeer(u);
        if (r === this.voiceRoom) { this.reconcileUserAudio(u); this.reconcileChannelSounds(); }
        this.emit();
      })
      // звук мута слышен только самому мутящемуся — играем при локальном событии МОЕГО голосового трека
      .on(RoomEvent.TrackMuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p === this.voiceRoom?.localParticipant && !this.deafToggling) playSound('mute'); this.emit(); })
      .on(RoomEvent.Reconnecting, () => {
        if (r !== this.viewRoom && r !== this.voiceRoom) return;
        this.reconnecting = true;
        // До серверной проверки lease держим uplink в тишине: старый ПК не должен успеть заговорить
        // после reconnect, если во время offline телефон уже стал owner.
        if (r === this.voiceRoom && this.inVoice) {
          this.voiceLeaseVerifying = true;
          ++this.voiceLeaseVerifySeq;
          this.applyGate();
        }
        this.hooks.toast('Связь потеряна — переподключаюсь…', 'warn'); this.emit();
      })
      .on(RoomEvent.Reconnected, () => {
        if (r !== this.viewRoom && r !== this.voiceRoom) return;
        this.reconnecting = false;
        // Reconnect восстанавливает ТЕКУЩИЙ intent, но не делает новый vclaim: старый ПК, который был
        // offline во время handoff на телефон, не имеет права самовольно отобрать голос обратно.
        if (r === this.voiceRoom && this.inVoice && this.currentVc) {
          this.voiceLeaseVerifying = true;
          const verifySeq = ++this.voiceLeaseVerifySeq;
          this.applyGate();
          void this.verifyVoiceLeaseAfterReconnect(r, this.voiceEpoch, verifySeq);
        }
        // viewRoom-реконнект: ре-энумерация чужих стримов (появившийся во время обрыва не прошёл бы через
        // onStreamStart — нет живого TrackPublished) + догрузка чата, пришедшего во время обрыва.
        if (r === this.viewRoom) { this.liveKitT.onRoomConnected(); this.hooks.refetchChat?.(); }
        this.hooks.toast('Связь восстановлена', 'ok'); this.emit();
      })
      .on(RoomEvent.Disconnected, () => this.handleRoomDisconnected(r, serverId))
      // размут мика слышен только самому; при оглушении звук даёт toggleDeaf, тут глушим
      .on(RoomEvent.TrackUnmuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p === this.voiceRoom?.localParticipant && !this.deafToggling) playSound('unmute'); this.emit(); })
      // качество/пинг — метрика ГОЛОСОВОГО соединения (voiceRoom)
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (r === this.voiceRoom && p === r.localParticipant) { this.connQuality = mapQuality(q); this.emit(); } })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => { if (r === this.voiceRoom) this.ensureVoiceAudioRunning(); })
      .on(RoomEvent.TrackPublished, (pub, p) => { if (r === this.voiceRoom) this.onRemotePub(pub, p); })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        if (r !== this.voiceRoom) return;
        this.clearSubscriptionRetries(p.identity, (pub as any).trackSid || (pub as any).sid);
        this.onRemoteUnpub(pub, p);
      })
      .on(RoomEvent.TrackSubscriptionFailed, (trackSid, p) => {
        if (r !== this.voiceRoom) return;
        const key = `${p.identity}:${trackSid}`;
        const retry = this.subscriptionRetries.get(key) || { attempts: 0, nextAt: 0 };
        retry.nextAt = 0; this.subscriptionRetries.set(key, retry);
        this.reconcilePeerAudio(p);
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
    // voiceRoom: подписка на уже опубликованные микрофоны (bootstrap). viewRoom: ре-энумерация стримов.
    if (isVoice) r.remoteParticipants.forEach((p) => { this.observeVoiceSession(p); p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)); });
    if (isView) { this.liveKitT.onRoomConnected(); this.treeT.onRoomConnected(); }
    // ОДИН engine-таймер на оба соединения (методы внутри бьют в нужную комнату: announceWatch/reconcile/
    // selfHeal сами выбирают view/voice). connect зовётся на каждую смену смотримого сервера → чистим
    // прежний, чтобы не плодить таймеры при браузинге в голосе. self-heal vc/подписок — см. selfHealVc.
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = window.setInterval(() => { this.announceWatch(); this.cleanupWatchers(); if (this.inVoice) { this.reconcileAllAudio(); this.reconcileChannelSounds(); } this.selfHealVc(); }, 3000);
    // Детект игры (натив): раз в 10с публикуем участник-атрибуты game/gicon → все видят «играет в X».
    if (isTauri) { if (this.gameTimer) clearInterval(this.gameTimer); this.pollGame(); this.gameTimer = window.setInterval(() => this.pollGame(), 10000); }
    this.emit();
  }
  private async verifyVoiceLeaseAfterReconnect(room: Room, voiceEpoch: number, verifySeq: number) {
    let failures = 0;
    while (this.voiceLeaseVerifySeq === verifySeq && this.voiceIntentCurrent(voiceEpoch, room)) {
      let event: VoiceLeaseEvent;
      try { event = await api.getVoiceLease(); }
      catch {
        failures++;
        if (failures === 3) this.hooks.toast('Проверяю голосовую сессию — микрофон пока в тишине', 'warn');
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(5000, 500 * (2 ** Math.min(failures, 4)))));
        continue;
      }
      if (this.voiceLeaseVerifySeq !== verifySeq || !this.voiceIntentCurrent(voiceEpoch, room)) return;
      this.onVoiceLease(event);
      if (!this.voiceIntentCurrent(voiceEpoch, room)) return; // другой owner/release уже запустил leave
      const serverId = this.voiceServerId, channelId = this.currentVc;
      if (!serverId || !channelId || !this.acceptVoiceLease(event, serverId, channelId)) {
        await this.leaveVoice();
        return;
      }
      if (!this.myVcAt) this.myVcAt = this.channelStartFor(channelId);
      // Не открываем uplink раньше, чем сервер комнаты подтвердил актуальные voice-атрибуты.
      if (!await this.commitVoiceAttributes(room, voiceEpoch, channelId)) {
        failures++;
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(5000, 400 * (2 ** Math.min(failures, 4)))));
        continue;
      }
      if (this.voiceLeaseVerifySeq !== verifySeq || !this.voiceIntentCurrent(voiceEpoch, room, channelId)) return;
      this.voiceLeaseVerifying = false;
      this.reconcileAllAudio();
      this.applyGate();
      void this.checkMicAlive(false);
      this.emit();
      return;
    }
  }
  private handleRoomDisconnected(room: Room, serverId: string) {
    if (this.intentionalDisconnects.has(room)) { this.intentionalDisconnects.delete(room); return; }
    const wasViewing = room === this.viewRoom;
    const wasVoice = room === this.voiceRoom;
    if (!wasViewing && !wasVoice) return;
    const lostChannel = wasVoice ? this.currentVc : null;
    this.readyRooms.delete(room);
    this.reconnecting = false;
    if (wasVoice) {
      ++this.voiceEpoch;
      this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
      this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
      this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.pttDown = false;
      this.myVcAt = null; this.noMic = false; this.myChannelPeers.clear();
      // Terminal network loss не release'ит серверный lease (reconnect = observation only), но
      // локально больше не считаем себя owner. Следующий явный join получит новый epoch.
      this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
      this.stopConnPoll();
      this.subscriptionRetries.clear();
      this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
      void this.stopMic(room);
      room.remoteParticipants.forEach((p) => {
        const pub = p.getTrackPublication(Track.Source.Microphone);
        if (pub) { try { (pub as any).setSubscribed(false); } catch { /**/ } }
        this.detachAnalyser(baseUid(p.identity));
      });
      document.querySelectorAll('#audioSink audio[data-origin="voice"]').forEach((a) => a.remove());
      this.clearVoiceAudio();
      this.voiceRoom = null; this.voiceServerId = null;
      this.liveKitT.setBroadcastRoom?.(null);
    }
    if (wasViewing) {
      this.resetStreamEdges();
      this.clearAllWatches();
      ++this.connectEpoch;
      this.roomReady = false;
      this.viewRoom = null; this.viewServerId = '';
      this.liveKitT.detach(); this.treeT.detach();
      document.querySelectorAll('#audioSink audio[data-origin="view"]').forEach((a) => a.remove());
      this.screenAudioEls.clear();
    }
    if (!this.hooks.connectionLossExpected?.()) {
      this.hooks.toast(wasVoice ? 'Голосовая связь оборвалась — подключись снова' : 'Realtime-связь оборвалась — переподключаюсь…', 'warn');
    }
    this.emit();
    this.hooks.connectionLost?.(serverId, lostChannel, wasViewing);
  }
  private async pollGame() {
    const room = this.viewRoom;
    if (!room) return;
    let g: GameStatus | null = null;
    if (isTauri && getSettings().shareGame) {
      try { const d = await detectGame(); if (d && d.name) g = { name: d.name.slice(0, 48), icon: d.icon || undefined }; } catch { /**/ }
    }
    if (this.viewRoom !== room) return;
    this.myGame = g;
    const wantName = g?.name || '';
    const wantIcon = (g?.icon && g.icon.length < 4000) ? g.icon : ''; // атрибут маленький — большую иконку не шлём
    const attrs = room.localParticipant.attributes || {};
    if ((attrs.game || '') !== wantName || (attrs.gicon || '') !== wantIcon) {
      // setAttributes МЕРЖИТ (не заменяет) — vc/deaf не затираются (проверено существующим поведением)
      room.localParticipant.setAttributes({ game: wantName, gicon: wantIcon }).catch(() => {});
    }
    this.emit();
  }

  // Полный teardown (logout / выход с сервера, где я в голосе): рвём ОБЕ комнаты + всё состояние.
  disconnect() {
    ++this.voiceEpoch; ++this.connectEpoch;
    this.resetStreamEdges();
    this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    const oldVoiceRoom = this.voiceRoom;
    const leaseSession = this.voiceLeaseSession, leaseEpoch = this.voiceLeaseEpoch;
    this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
    if (leaseSession && leaseEpoch > 0) void api.releaseVoiceLease(leaseSession, leaseEpoch).catch(() => {});
    if (this.inVoice) this.hooks.endBroadcast?.(); // гасим нативную трансляцию (browser-share упадёт с room.disconnect)
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.gameTimer) { clearInterval(this.gameTimer); this.gameTimer = null; } this.myGame = null;
    this.stopConnPoll();
    this.analysers.forEach((o) => { try { o.src.disconnect(); } catch { /**/ } });
    this.analysers.clear(); this.speakingSet.clear();
    if (this.spRAF) cancelAnimationFrame(this.spRAF); this.spRAF = null;
    this.vadOpen = false;
    this.stopLevelMeter();
    this.keepAliveOff();
    document.querySelectorAll('#audioSink audio').forEach((a) => a.remove());
    this.clearVoiceAudio();
    this.clearAllWatches();
    this.liveKitT.detach(); this.treeT.detach(); this.screenAudioEls.clear();
    this.streamWatchers.clear();
    this.perMuteByServer.clear(); this.volsByServer.clear(); this.messages = []; this.reactions.clear(); this.reactionWrites.clear(); this.reactionWriteSeq.clear(); this.reactionWriteDesired.clear(); this.pendingSend.clear(); this.chatMore = false; this.oldestSid = null; this.trimmedFront = 0; ++this.chatGeneration;
    this.onlineHint.clear(); this.awayHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    this.activeVoiceSessions.clear();
    this.subscriptionRetries.clear();
    this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
    if (this.outputDeviceTimer) { clearTimeout(this.outputDeviceTimer); this.outputDeviceTimer = null; }
    void this.stopMic(oldVoiceRoom);
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.roomReady = false; this.screenStream = null; this.noMic = false; // deafened/manualMute НЕ трогаем — персист-интент
    // рвём ОБЕ комнаты (при расцепе разные; при shared — одна, Set схлопнёт дубль)
    new Set([this.viewRoom, this.voiceRoom].filter(Boolean)).forEach((rm) => this.disconnectRoom(rm as Room));
    this.viewRoom = null; this.voiceRoom = null; this.viewServerId = ''; this.voiceServerId = null; this.emit();
  }

  // Уйти со СМОТРИМОГО сервера (браузинг на другой / на главную-с-выходом), НЕ трогая голос: чистим
  // view-состояние (чат/стримы/presence-хинты/typing) и рвём viewRoom, ТОЛЬКО если она не голосовая.
  detachView() {
    ++this.connectEpoch;
    this.resetStreamEdges();
    this.messages = []; this.reactions.clear(); this.reactionWrites.clear(); this.reactionWriteSeq.clear(); this.reactionWriteDesired.clear(); this.pendingSend.clear(); this.chatMore = false; this.oldestSid = null; this.trimmedFront = 0; ++this.chatGeneration;
    this.clearAllWatches(); this.streamWatchers.clear();
    // presence-хинты и typing принадлежат ПРЕДЫДУЩЕМУ смотримому серверу
    this.onlineHint.clear(); this.awayHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    this.liveKitT.detach(); this.treeT.detach();
    document.querySelectorAll('#audioSink audio[data-origin="view"]').forEach((a) => a.remove()); // только стрим-аудио, не мик
    this.screenAudioEls.clear();
    this.roomReady = false;
    const vw = this.viewRoom;
    this.viewRoom = null; this.viewServerId = '';
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
    this.roomReady = this.readyRooms.has(this.viewRoom); // voice join мог ещё ждать незавершённый connect
    this.liveKitT.attach(this.viewRoom, { me: this.me.username, serverId: this.viewServerId });
    this.treeT.attach(this.viewRoom, { me: this.me.username, serverId: this.viewServerId });
    this.liveKitT.onRoomConnected(); this.treeT.onRoomConnected();
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
          if (this.voiceRoom) void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
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
    const p = this.partOf(username); if (!p) return false;
    if (p === this.viewRoom!.localParticipant) return this.inVoice;
    return !!p.getTrackPublication(Track.Source.Microphone);
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
  // подписка на микрофон пира только когда я в голосовом и мы в ОДНОМ канале (изоляция звука по каналам)
  private reconcilePeerAudio(p: Participant) {
    if (!this.voiceRoom || p === this.voiceRoom.localParticipant) return;
    const username = baseUid(p.identity);
    if (username === this.me.username) return; // своя же другая сессия — не подписываемся (эхо)
    const mp = p.getTrackPublication(Track.Source.Microphone);
    if (!mp) return;
    // ОГЛОХ (deafened) → НЕ подписываемся: нет трека = гарантированная тишина, независимо от громкости.
    // Иначе оглохший оставался подписан, а глушение по громкости могло не примениться (пир размутился →
    // resubscribe без re-apply громкости → слышно, хотя фулл-мут).
    const active = this.partOf(username, this.voiceRoom);
    const want = p === active && this.inVoice && !this.deafened && !!this.currentVc && (p as any).attributes?.vc === this.currentVc;
    const remotePub = mp as any;
    const retryKey = `${p.identity}:${remotePub.trackSid || remotePub.sid || 'mic'}`;
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
      if (!currentAudio || currentAudio.identity === p.identity) {
        this.removeVoiceAudio(username, p.identity);
        this.detachAnalyser(username);
      }
    }
    else if ((mp as any).track) this.ensureRemoteVoicePlayback(username);
  }
  private clearSubscriptionRetries(identity?: string, trackSid?: string) {
    if (!identity) { this.subscriptionRetries.clear(); return; }
    const exact = trackSid ? `${identity}:${trackSid}` : '';
    const prefix = `${identity}:`;
    for (const key of this.subscriptionRetries.keys()) {
      if ((exact && key === exact) || (!exact && key.startsWith(prefix))) this.subscriptionRetries.delete(key);
    }
  }
  private reconcileAllAudio() { this.voiceRoom?.remoteParticipants.forEach((p) => this.reconcilePeerAudio(p)); }
  private reconcileUserAudio(username: string) {
    this.voiceRoom?.remoteParticipants.forEach((p) => { if (baseUid(p.identity) === username) this.reconcilePeerAudio(p); });
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
    if (!seedOnly) {
      cur.forEach((u) => { if (!this.myChannelPeers.has(u)) playSound('entry'); });
      this.myChannelPeers.forEach((u) => { if (!cur.has(u)) playSound('exit'); });
    }
    this.myChannelPeers = cur;
  }
  private voiceIntentCurrent(epoch: number, room: Room, channel?: string): boolean {
    return this.voiceEpoch === epoch && this.inVoice && this.voiceRoom === room && (!channel || this.currentVc === channel);
  }
  // Все writers vc/deaf проходят через одну очередь на комнату. Поэтому запоздалый setAttributes(vc=old)
  // физически не может завершиться ПОСЛЕ более нового leave/switch и воскресить старое состояние.
  private setVoiceAttributes(room: Room, attrs: Record<string, string>, strict = false): Promise<void> {
    const next = { ...attrs };
    const active = this.voiceAttrWrites.get(room);
    const queued = this.voiceAttrDesired.get(room);
    if (!strict && active && queued && JSON.stringify(queued) === JSON.stringify(next)) return active;
    this.voiceAttrDesired.set(room, next);
    // Каждый новый intent цепляется ПОСЛЕ предыдущего. Promise, возвращённый leave/switch, включает
    // именно его запись — нет окна, где caller уже продолжил teardown, а tombstone ещё ждёт в фоне.
    const tracked = (active || Promise.resolve()).catch(() => {}).then(async () => {
      if (strict) await room.localParticipant.setAttributes(next);
      else { try { await room.localParticipant.setAttributes(next); } catch { /** self-heal повторит */ } }
    });
    this.voiceAttrWrites.set(room, tracked);
    const cleanup = () => { if (this.voiceAttrWrites.get(room) === tracked) this.voiceAttrWrites.delete(room); };
    void tracked.then(cleanup, cleanup);
    return tracked;
  }
  private async commitVoiceAttributes(room: Room, voiceEpoch: number, channelId: string): Promise<boolean> {
    const expected = this.wantedVoiceAttributes(room);
    const matches = () => {
      const actual = room.localParticipant.attributes || {};
      return Object.entries(expected).every(([key, value]) => (actual[key] || '') === value);
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.voiceIntentCurrent(voiceEpoch, room, channelId) || this.voiceClaimPending !== 0) return false;
      try {
        await this.setVoiceAttributes(room, expected, true);
        if (matches()) return true;
      } catch { /** retry below while the intent is still current */ }
      await new Promise((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)));
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
      vcAt: active && this.myVcAt ? String(this.myVcAt) : '',
      voiceSession: active ? this.voiceLeaseSession : '',
      voiceEpoch: active && this.voiceLeaseEpoch > 0 ? String(this.voiceLeaseEpoch) : '',
    };
  }
  private disconnectRoom(room: Room) {
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
    if (this.voiceRoom && this.inVoice) {
      const wantDeaf = this.deafened ? '1' : '';
      const a = this.voiceRoom.localParticipant.attributes || {};
      if ((a.vc || '') !== (this.currentVc || '') || (a.deaf || '') !== wantDeaf
        || (a.voiceSession || '') !== this.voiceLeaseSession || (a.voiceEpoch || '') !== (this.voiceLeaseEpoch > 0 ? String(this.voiceLeaseEpoch) : '')) {
        if (this.currentVc && !this.myVcAt) this.myVcAt = this.channelStartFor(this.currentVc); // не долетел исходный setAttributes — досчитываем сейчас
        void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
      }
    }
    // viewRoom, ЕСЛИ она НЕ голосовая (смотрю сервер, где не в войсе): моего голоса тут нет → vc/deaf ''
    // (иначе после leaveVoice/браузинга «залипну» в канале у других на этом сервере — vc:'' мог не долететь).
    if (this.viewRoom && this.viewRoom !== this.voiceRoom) {
      const a = this.viewRoom.localParticipant.attributes || {};
      if ((a.vc || '') !== '' || (a.deaf || '') !== '' || (a.voiceSession || '') !== '' || (a.voiceEpoch || '') !== '')
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
  private localMicMuted(): boolean { return this.manualMute || this.noMic; } // noMic (зашёл без мика) = тоже «нет звука наружу»
  private micPub() { return this.voiceRoom && this.voiceRoom.localParticipant.getTrackPublication(Track.Source.Microphone); }
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

  /* ---------- VOICE join/leave/switch (несколько каналов на сервер) ---------- */
  // подключиться к голосовому каналу channelId; если уже в другом — переключиться без переподнятия микрофона
  async joinVoice(channelId: string) {
    const targetRoom = this.viewRoom;
    const targetServer = this.viewServerId; // вход в голос — на СМОТРИМОМ сервере (его каналы в ServerView)
    if (!channelId || !targetRoom || !targetServer) return;
    // уже в голосовом на ЭТОМ же сервере → только смена канала (мик остаётся)
    if (this.inVoice && this.voiceServerId === targetServer) {
      if (this.currentVc === channelId && !this.voiceConnecting) return;
      if (!this.voiceConnecting) { await this.switchVoice(channelId); return; }
    }
    // в голосовом на ДРУГОМ сервере → покидаем его (Discord: молча переносим голос сюда)
    const session = this.sessionId(targetRoom);
    const clientIntent = ++this.voiceClientIntent;
    // Start the global device/tab ordering fence before teardown, room-ready
    // waits, attributes or microphone setup can delay the eventual claim.
    const ticketPromise = session
      ? api.mintVoiceIntent(session, targetServer, channelId, clientIntent).catch(() => null)
      : Promise.resolve(null);
    if (this.inVoice && this.voiceServerId !== targetServer) {
      await this.leaveVoice();
      // Пока завершался teardown A пользователь мог уже открыть C. Не публикуем голос в случайную комнату.
      if (this.viewRoom !== targetRoom || this.viewServerId !== targetServer || this.voiceClientIntent !== clientIntent) return;
    }
    const epoch = ++this.voiceEpoch;
    this.voiceClaimPending = epoch; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    const replacingPendingJoin = this.inVoice && this.voiceRoom === targetRoom && this.voiceConnecting;
    this.currentVc = channelId;
    this.inVoice = true; this.pttDown = false; // manualMute НЕ сбрасываем — пред-установка мута применяется на входе
    this.voiceConnecting = true;
    this.voiceRoom = targetRoom;         // реюз коннекта смотримого сервера как голосового (без второго соединения)
    this.voiceServerId = targetServer;
    targetRoom.remoteParticipants.forEach((p) => this.observeVoiceSession(p));
    this.liveKitT.setBroadcastRoom?.(this.voiceRoom); // браузер вещает в ГОЛОСОВУЮ комнату (не в смотримую при браузинге)
    this.emit(); // ОПТИМИСТИЧНО: сразу рисуем себя в канале + статус «подключение» (mic ещё публикуется)
    // Быстрый A→B во время gUM/публикации инвалидирует старый pipeline прежде, чем создаём новый.
    if (replacingPendingJoin) {
      await this.stopMic(targetRoom);
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
    }
    // viewRoom мог ещё подниматься (фоновый connect после свитча, ретраи ~9.5с): объект Room есть, но не
    // подключён (roomReady=false). Публикация mic/vc в неподнятую комнату молча провалилась бы — «зашёл»
    // по UI, по факту нет. Ждём готовности, показывая «подключение»; не поднялась за таймаут — откат.
    if (!this.readyRooms.has(targetRoom)) {
      const ready = await this.waitRoomReady(targetRoom, epoch, 15000);
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
      if (!ready) {
        this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
        this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.voiceRoom = null; this.voiceServerId = null;
        this.liveKitT.setBroadcastRoom?.(null);
        this.hooks.toast('Realtime-связь не поднялась — попробуй ещё раз', 'warn'); this.emit(); return;
      }
    }
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
    this.myVcAt = this.channelStartFor(channelId);
    const ticketEvent = await ticketPromise;
    if (!this.voiceIntentCurrent(epoch, targetRoom, channelId) || this.voiceClientIntent !== clientIntent) return;
    if (!ticketEvent || ticketEvent.accepted === false || !Number.isSafeInteger(ticketEvent.ticket) || ticketEvent.ticket < 1) {
      if (this.voiceClaimPending === epoch) this.voiceClaimPending = 0;
      this.hooks.toast('Не удалось согласовать вход между устройствами — попробуй ещё раз', 'warn');
      await this.leaveVoice();
      return;
    }
    let leaseEvent: VoiceLeaseEvent | null = null;
    try { leaseEvent = await api.claimVoiceLease(session, targetServer, channelId, clientIntent, ticketEvent.ticket); }
    catch {
      // POST мог дойти, а ответ потеряться. Snapshot не меняет owner и позволяет безопасно понять,
      // был ли claim принят, вместо создания «невидимой» серверной аренды.
      try { leaseEvent = await api.getVoiceLease(); } catch { /**/ }
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
      this.hooks.toast('Не удалось закрепить голосовую сессию — попробуй ещё раз', 'warn');
      await this.leaveVoice();
      return;
    }
    if (deferredLease) {
      this.onVoiceLease(deferredLease);
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
    }
    // deaf по пред-установке — сразу заявляем пирам (иначе зашёл «оглохшим», а бейджа deaf у них нет)
    if (!await this.commitVoiceAttributes(targetRoom, epoch, channelId)) {
      if (this.voiceIntentCurrent(epoch, targetRoom, channelId)) {
        this.hooks.toast('Не удалось синхронизировать голос — подключись ещё раз', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    // Claim отправляем ДО медленного gUM/RNNoise: окно с двумя активными устройствами минимально.
    this.lastVclaim = Date.now();
    this.dataSend({ t: 'vclaim', uid: this.me.id, session, epoch: this.voiceLeaseEpoch });
    // Микрофон недоступен (нет устройства/отказ в доступе) — НЕ отменяем вход: заходим слушателем
    // (listen-only). В канале, слышим всех, но нас не слышно. Как в Discord. noMic сбросится при
    // успешном захвате мика (повторный клик по кнопке мика зовёт reapplyMic/startMic).
    this.noMic = false;
    try {
      const started = await this.startMic(epoch);
      if (!started || !this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
    }
    catch {
      if (!this.voiceIntentCurrent(epoch, targetRoom, channelId)) return;
      this.noMic = true;
      this.micRetryAt = Date.now() + 5000; this.micFailureNotified = true;
      this.hooks.toast('Микрофон недоступен — ты в канале, но тебя не слышно', 'warn');
    }
    this.reconcileAllAudio(); // подписываемся на пиров этого же канала (bootstrap мик-подписок)
    this.reconcileChannelSounds(true); // сеем состав канала БЕЗ звука (не проигрываем entry по всем, кто уже там)
    this.startConnPoll();
    this.voiceConnecting = false;
    playSound('entry'); // сам зашедший тоже слышит вход (остальные в канале — через onRemotePub)
    this.emit();
  }
  // перейти в другой голосовой канал того же сервера: микрофон остаётся, меняются подписки и стримы
  async switchVoice(channelId: string) {
    if (!this.voiceRoom || !this.inVoice || this.currentVc === channelId) return;
    const previousChannel = this.currentVc;
    const epoch = ++this.voiceEpoch; // старый async voice-intent больше не может дописать прежний канал
    this.voiceClaimPending = epoch; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    const room = this.voiceRoom;
    const serverId = this.voiceServerId;
    const session = this.sessionId(room);
    const clientIntent = ++this.voiceClientIntent;
    const ticketPromise = session && serverId
      ? api.mintVoiceIntent(session, serverId, channelId, clientIntent).catch(() => null)
      : Promise.resolve(null);
    this.currentVc = channelId;
    this.myVcAt = this.channelStartFor(channelId);
    // Пока сервер решает, кому принадлежит аккаунт, старый uplink молчит и старый vc снимается.
    // Это делает A→B атомарным для слушателей: никто не услышит речь в уже покинутом канале.
    this.applyGate();
    void this.setVoiceAttributes(room, this.wantedVoiceAttributes(room));
    this.emit();
    const ticketEvent = await ticketPromise;
    if (!this.voiceIntentCurrent(epoch, room, channelId) || this.voiceClientIntent !== clientIntent) return;
    if (!ticketEvent || ticketEvent.accepted === false || !Number.isSafeInteger(ticketEvent.ticket) || ticketEvent.ticket < 1) {
      if (this.voiceClaimPending === epoch) this.voiceClaimPending = 0;
      this.currentVc = this.voiceLeaseChannel || previousChannel;
      this.myVcAt = this.currentVc ? this.channelStartFor(this.currentVc) : null;
      await this.setVoiceAttributes(room, this.wantedVoiceAttributes(room)).catch(() => {});
      this.applyGate();
      this.hooks.toast('Не удалось согласовать переключение между устройствами — попробуй ещё раз', 'warn');
      this.emit();
      return;
    }
    let leaseEvent: VoiceLeaseEvent | null = null;
    try { if (serverId) leaseEvent = await api.claimVoiceLease(session, serverId, channelId, clientIntent, ticketEvent.ticket); }
    catch { try { leaseEvent = await api.getVoiceLease(); } catch { /**/ } }
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
    if (!await this.commitVoiceAttributes(room, epoch, channelId)) {
      if (this.voiceIntentCurrent(epoch, room, channelId)) {
        this.hooks.toast('Не удалось синхронизировать канал', 'warn');
        await this.leaveVoice();
      }
      return;
    }
    this.applyGate();
    this.lastVclaim = Date.now();
    this.dataSend({ t: 'vclaim', uid: this.me.id, session, epoch: this.voiceLeaseEpoch });
    this.reconcileAllAudio();
    this.reconcileChannelSounds(true); // пере-сеем состав НОВОГО канала БЕЗ звука (мне не нужен бурст entry; другие услышат МЕНЯ через смену vc-атрибута)
    playSound('entry');
    this.emit();
  }
  async leaveVoice() {
    if (!this.voiceRoom || !this.inVoice) return;
    const epoch = ++this.voiceEpoch;
    this.voiceClaimPending = 0; this.deferredVoiceLease = null; this.matchedVoiceLease = null;
    this.voiceLeaseVerifying = false; ++this.voiceLeaseVerifySeq;
    const vr = this.voiceRoom; // фиксируем: ниже обнулим указатель (и, возможно, порвём комнату)
    const leaseSession = this.voiceLeaseSession;
    const leaseEpoch = this.voiceLeaseEpoch;
    this.voiceLeaseSession = ''; this.voiceLeaseChannel = ''; this.voiceLeaseEpoch = 0;
    if (leaseSession && leaseEpoch > 0) void api.releaseVoiceLease(leaseSession, leaseEpoch).catch(() => {}); // stale release сервер безопасно отвергнет
    // оптимистично: сразу убираем себя из канала (UI не ждёт async-очистку mic/треков)
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.pttDown = false; this.myVcAt = null; this.noMic = false; // deafened/manualMute НЕ сбрасываем — персист-интент до след. входа
    this.myChannelPeers.clear(); // вышел — состав моего канала сброшен (другие услышат мой выход по unpub мика / vc'')
    playSound('exit'); // сам вышедший тоже слышит выход (остальные в канале — через onRemoteUnpub)
    this.emit();
    this.stopConnPoll();
    this.subscriptionRetries.clear();
    this.voiceOutputRoom = null; this.voiceOutputSink = ''; this.voiceOutputPending = null;
    // Трек и vc очищаем СРАЗУ, до любых медленных await. Иначе leave кратко воскресал через старый
    // self-heal/setAttributes, а быстрый новый join мог быть уничтожен поздним хвостом этого leave.
    const micStop = this.stopMic(vr);
    const attrStop = this.commitVoiceTombstone(vr, epoch);
    const shareStop = this.stopShare().catch(() => {}); // browser-share (LiveKit)
    this.hooks.endBroadcast?.();            // нативная трансляция (Rust-дерево) — тоже гасим
    vr.remoteParticipants.forEach((p) => { const rp = p.getTrackPublication(Track.Source.Microphone); if (rp) { try { (rp as any).setSubscribed(false); } catch { /**/ } } this.detachAnalyser(baseUid(p.identity)); });
    // Сносим мик-аудиоэлементы сразу (origin=voice), не ждём async onUnsub. Стрим-аудио (origin=view)
    // НЕ трогаем — стрим смотрится и без голосового (и может жить в ДРУГОЙ, смотримой комнате).
    document.querySelectorAll('#audioSink audio[data-origin="voice"]').forEach((a) => a.remove());
    this.clearVoiceAudio();
    await Promise.allSettled([micStop, attrStop, shareStop]);
    if (this.voiceEpoch !== epoch || this.voiceRoom !== vr) return; // за teardown уже начался новый join
    // голосовая комната была voice-only (я смотрю ДРУГОЙ сервер) → рвём её; если это смотримая — оставляем как viewRoom
    if (vr !== this.viewRoom) this.disconnectRoom(vr);
    this.voiceRoom = null; this.voiceServerId = null;
    this.liveKitT.setBroadcastRoom?.(null); // вне голоса — вещание падает на смотримую комнату (fallback)
    this.screenAudioEls.forEach((a) => (a.muted = false));
    this.emit();
  }

  /* ---------- качество связи в голосовом (индикатор + пинг) ---------- */
  private startConnPoll() {
    if (this.connTimer) return;
    document.addEventListener('visibilitychange', this.onVisible);
    this.pollPing();
    this.connTimer = window.setInterval(() => this.pollPing(), 2500);
  }
  private stopConnPoll() {
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.connTimer) { clearInterval(this.connTimer); this.connTimer = null; }
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
  // RTT до сервера из WebRTC-статистики микрофонного трека (remote-inbound-rtp), фолбэк — candidate-pair
  private async pollPing() {
    // Watchdog: контекст публикации мика мог родиться/остаться 'suspended' (getUserMedia-промпт съел
    // user-activation) → пиры не слышат, хотя локально «всё работает». Держим его running, пока в войсе.
    if (this.inVoice && ((this.micActx && this.micActx.state !== 'running') || (this.spCtx && this.spCtx.state !== 'running')
      || this.voiceRoom?.canPlaybackAudio === false)) this.ensureVoiceAudioRunning();
    if (this.inVoice) void this.checkMicAlive(true); // мобилка: пере-снять мик, если источник умер на бэкграунде
    if (this.inVoice && ++this.voiceLeaseAuditTick % 4 === 0) void this.auditVoiceLease();
    if (this.inVoice) this.ensureRemoteVoicePlayback();
    const track = this.voiceRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    try {
      const rep: RTCStatsReport = await (track as any).getRTCStatsReport();
      let rtt: number | null = null, cand: number | null = null;
      rep.forEach((s: any) => {
        if (s.type === 'remote-inbound-rtp' && s.roundTripTime != null) rtt = s.roundTripTime;
        if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && s.currentRoundTripTime != null) cand = s.currentRoundTripTime;
      });
      const v = rtt ?? cand;
      let changed = false;
      if (v != null && this.pingMs !== Math.round(v * 1000)) { this.pingMs = Math.round(v * 1000); changed = true; }
      // Качество читаем НАПРЯМУЮ из localParticipant.connectionQuality, а не ждём событие
      // ConnectionQualityChanged: оно приходит лишь при СМЕНЕ качества, поэтому при стабильной
      // связи с самого старта метка залипала на «соединение…» (unknown), хотя пинг уже шёл.
      const lp = this.voiceRoom?.localParticipant;
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
    } catch { /**/ }
  }

  /* ---------- MIC / DEAFEN / PTT ---------- */
  // эхо/автогромкость всегда включены; браузерный NS — только в режиме 'basic' (в 'rnnoise' его
  // выключаем, чтобы не было каскада с нашей нейросетью; в 'off' — вообще без обработки шума).
  // deviceId через { exact } — иначе браузер игнорит выбор и берёт устройство по умолчанию
  // channelCount:1 — важно не только для экономии полосы: RnnoiseWorkletNode сконструирована на
  // maxChannels:1 (см. denoise.ts), а реальные микрофоны часто отдают gUM-поток 2-канальным по
  // умолчанию (даже физически моно-капсюль). При рассинхроне channel count шумодав обрабатывает
  // только часть каналов — второй проходит необработанным и может доминировать в RMS/метре.
  private micCapture() {
    const s = getSettings();
    return { deviceId: s.input ? { exact: s.input } : undefined, echoCancellation: true, noiseSuppression: s.nsMode === 'basic', autoGainControl: true, channelCount: 1 };
  }

  // строим цепочку: устройство -> [denoise?] -> preGate -> gain (микс/мут) -> published track
  //                                                     \-> vadDest (VAD/метр, ДО гейта — иначе
  //                                                         гейт слушает уже замолченный gain=0 сигнал
  //                                                         и залипает закрытым)
  private async startMic(expectedVoiceEpoch = this.voiceEpoch): Promise<boolean> {
    const room = this.voiceRoom;
    if (!room || !this.voiceIntentCurrent(expectedVoiceEpoch, room)) return false;
    if (this.micRaw && this.micActx && this.micPub()?.track) return true;
    const op = ++this.micEpoch;
    const current = () => op === this.micEpoch && this.voiceIntentCurrent(expectedVoiceEpoch, room);
    // Publication могла пережить сбой локального AudioContext. Перед новым pipeline обязательно ждём
    // её удаления — одновременно две mic publications дают разным слушателям разные «первые» треки.
    const stalePublication = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (stalePublication) {
      try { await room.localParticipant.unpublishTrack(stalePublication, true); } catch { /**/ }
      if (!current()) return false;
    }
    let raw: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let denoise: RnnoiseWorkletNode | null = null;
    let vadDest: MediaStreamAudioDestinationNode | null = null;
    let lat: LocalAudioTrack | null = null;
    let disposed = false;
    const dispose = async (unpublish: boolean) => {
      if (disposed) return;
      disposed = true;
      if (unpublish && lat) { try { await room.localParticipant.unpublishTrack(lat, true); } catch { try { lat.stop(); } catch { /**/ } } }
      else if (lat) { try { lat.stop(); } catch { /**/ } }
      raw?.getTracks().forEach((t) => t.stop());
      destroyDenoiseNode(denoise);
      if (vadDest) { try { vadDest.disconnect(); } catch { /**/ } }
      if (ctx) { try { await ctx.close(); } catch { /**/ } }
    };
    // Контекст ПУБЛИКАЦИИ создаём и резюмим ДО getUserMedia — пока жива user-activation от клика «войти
    // в голосовой». Раньше он рождался ПОСЛЕ gUM: на ПЕРВОМ входе промпт разрешения съедал активацию →
    // контекст 'suspended', а suspended MediaStreamDestination выдаёт ТИШИНУ (пиры не слышат до F5 —
    // после перезахода разрешение уже есть, промпта нет, активация клика доживает). Уже РАБОТАЮЩИЙ
    // контекст промпт не усыпляет. resume + gesture-unlock/watchdog (ensureVoiceAudioRunning) — подстраховка.
    ctx = new AudioContext();
    try { await ctx.resume?.(); } catch { /**/ }
    if (!current()) { await dispose(false); return false; }
    // spCtx (контекст VAD-анализатора) резюмим тем же до-промптовым окном активации, что и micActx. Гейт
    // «активации голосом» ставит vadOpen ИМЕННО из анализатора на spCtx (attachAnalyser/spLoop). Рождённый
    // 'suspended' ПОСЛЕ gUM-промпта (attachAnalyser зовётся в конце startMic, уже без активации) → анализатор
    // отдаёт константу → vadOpen залипает false → applyGate держит gain=0 → мик-трек ЖИВОЙ, но пиры слышат
    // ТИШИНУ (чинит только F5). Watchdog его не спасал: гейтится по micActx, а тот теперь заранее running.
    this.spCtx = this.spCtx || new AudioContext();
    try { await this.spCtx.resume?.(); } catch { /**/ }
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: this.micCapture() });
    } catch (e) {
      await dispose(false);
      if (!current()) return false;
      throw e;
    }
    if (!current()) { await dispose(false); return false; }
    const src = ctx.createMediaStreamSource(raw);
    let preGate: AudioNode = src;
    if (getSettings().nsMode === 'rnnoise') {
      denoise = await createDenoiseNode(ctx);
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
    const gain = ctx.createGain();
    gain.gain.value = 0; // до commit/applyGate не выпускаем звук из ещё не подтверждённого pipeline
    preGate.connect(gain);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    // VAD/метр — отвод ДО гейта (preGate), НЕ от micGain: гейт решает лишь что публикуется наружу,
    // а не что видит сам детектор речи.
    vadDest = ctx.createMediaStreamDestination();
    preGate.connect(vadDest);
    lat = new LocalAudioTrack(dest.stream.getAudioTracks()[0]);
    if (!current()) { await dispose(false); return false; }
    try {
      await room.localParticipant.publishTrack(lat, { source: Track.Source.Microphone, dtx: true, red: true, audioPreset: AudioPresets.musicHighQuality });
    } catch (error) {
      await dispose(false);
      if (!current()) return false;
      throw error;
    }
    if (!current()) { await dispose(true); return false; }
    // свежий трек публикуется НЕмьютнутым на уровне LiveKit — если сейчас ручной мут/оглушение,
    // домьютить сразу (иначе после reapplyMic в муте пиры читают mp.isMuted=false → бейдж мута
    // пропадает у всех, хотя мы молчим через gain=0). applyGate решает лишь громкость, не LiveKit-mute.
    if (this.manualMute || this.deafened) { try { lat.mute(); } catch { /**/ } }
    // Коммитим pipeline только после успешного publish и последней проверки generation. Старый async
    // хвост никогда не перезапишет ресурсы более свежего микрофона.
    this.micRaw = raw;
    this.micActx = ctx;
    this.micGain = gain;
    this.micDenoise = denoise;
    this.micVadDest = vadDest;
    // индикатор «говорит» — с очищенного (после denoise) сигнала, ДО гейта
    this.attachAnalyser(this.me.username, vadDest.stream.getAudioTracks()[0]);
    this.applyGate();
    this.ensureVoiceAudioRunning(); // добить, если контекст всё ещё suspended (анлок на первый жест + watchdog)
    this.noMic = false;
    return true;
  }
  // Гарантирует, что контекст ПУБЛИКАЦИИ микрофона (micActx) реально запущен. Браузер держит
  // AudioContext 'suspended' до пользовательского жеста в контексте страницы; startMic создаёт
  // контекст ПОСЛЕ await getUserMedia (+ промпт) → активация потеряна, контекст молчит, пиры не
  // слышат (а зелёный VAD-индикатор от отдельного spCtx работает — потому баг незаметен локально).
  // Полный перезаход «чинил» через sticky-activation. Резюмируем сразу + разовый анлок на первый
  // жест; conn-watchdog (pollPing) добивает, если контекст уснул повторно.
  private ensureVoiceAudioRunning() {
    const resume = () => {
      this.micActx?.resume?.().catch(() => {});
      this.spCtx?.resume?.().catch(() => {});
      this.outputCtx?.resume?.().catch(() => {});
      try { void this.voiceRoom?.startAudio().catch(() => {}); } catch { /**/ }
    };
    resume();
    // ОБА контекста должны быть running: micActx = публикуемый звук, spCtx = VAD-гейт (без него gain залипает 0).
    // Раньше гейт стоял только на micActx → после его пред-резюма gesture-unlock не ставился, а spCtx оставался спящим.
    const running = () => (!this.micActx || this.micActx.state === 'running') && (!this.spCtx || this.spCtx.state === 'running')
      && (!this.outputCtx || this.outputCtx.state === 'running') && this.voiceRoom?.canPlaybackAudio !== false;
    if (this.audioUnlock || running()) return;
    const unlock = () => { resume(); if (running()) this.clearAudioUnlock(); };
    this.audioUnlock = () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('touchstart', unlock, true);
  }
  private clearAudioUnlock() { if (this.audioUnlock) { this.audioUnlock(); this.audioUnlock = null; } }
  // Мобилка: свернул PWA (ушёл в TG) → на переднем плане gUM-источник мог УМЕРЕТЬ: iOS закрывает
  // захват перманентно (readyState='ended'), часть Android держит «залипший» muted. micActx резюмит
  // watchdog, но мёртвый источник шлёт ТИШИНУ в publish-destination → пиры не слышат (сам слышишь
  // всех — downstream цел). Лечение — пере-снять мик (re-getUserMedia). ended рестартим сразу; muted
  // даём авто-размуту (обычно снимается за тик), «залипший» >2 тиков (~5с) — рестартим.
  private micRestarting = false;
  private micMutedTicks = 0;
  private micRetryAt = 0;
  private micFailureNotified = false;
  private async checkMicAlive(fromWatchdog = false) {
    const room = this.voiceRoom;
    if (!this.inVoice || !room || this.micRestarting || (fromWatchdog && Date.now() < this.micRetryAt)) return;
    const voiceEpoch = this.voiceEpoch;
    const t = this.micRaw?.getAudioTracks()[0];
    const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const ended = !this.micActx || !t || t.readyState === 'ended' || !publication?.track;
    if (!ended && t && t.muted && fromWatchdog) this.micMutedTicks++;
    else if (t && !t.muted) this.micMutedTicks = 0;
    if (!ended && this.micMutedTicks < 2) return;
    this.micRestarting = true; this.micMutedTicks = 0;
    try {
      await this.stopMic(room);
      if (!this.voiceIntentCurrent(voiceEpoch, room)) return;
      let started = false;
      try { started = await this.startMic(voiceEpoch); }
      catch (error) {
        const name = String((error as any)?.name || '');
        const selectedDeviceGone = !!getSettings().input && (name === 'NotFoundError' || name === 'OverconstrainedError');
        if (!selectedDeviceGone || !this.voiceIntentCurrent(voiceEpoch, room)) throw error;
        setSettings({ input: '' });
        started = await this.startMic(voiceEpoch);
        if (started && this.voiceIntentCurrent(voiceEpoch, room)) this.hooks.toast('Выбранный микрофон отключён — включён системный', 'warn');
      }
      if (!started || !this.voiceIntentCurrent(voiceEpoch, room)) return;
      this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
      this.emit();
    } catch {
      if (!this.voiceIntentCurrent(voiceEpoch, room)) return;
      this.noMic = true;
      this.micRetryAt = Date.now() + 5000;
      if (!this.micFailureNotified) {
        this.micFailureNotified = true;
        this.hooks.toast('Микрофон потерян — пытаюсь восстановить подключение', 'warn');
      }
      this.emit();
    }
    finally { this.micRestarting = false; }
  }
  // Возврат PWA на передний план: мгновенно резюмим контексты + проверяем живость источника
  // (не ждём до 2.5с следующего watchdog-тика). muted-рестарт тут не делаем — только ended.
  private onVisible = () => {
    if (document.hidden || !this.inVoice) return;
    this.micActx?.resume?.().catch(() => {});
    this.spCtx?.resume?.().catch(() => {});
    void this.checkMicAlive(false);
    this.ensureVoiceAudioRunning();
  };
  private async stopMic(room: Room | null = this.voiceRoom): Promise<void> {
    ++this.micEpoch; // первым действием отменяем любой незавершённый gUM/RNNoise/publish
    const p = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const publishedTrack = p?.track;
    const raw = this.micRaw; this.micRaw = null;
    const denoise = this.micDenoise; this.micDenoise = null;
    const vadDest = this.micVadDest; this.micVadDest = null;
    const ctx = this.micActx; this.micActx = null;
    this.micGain = null;
    this.detachAnalyser(this.me.username);
    this.vadOpen = false;
    this.clearAudioUnlock();
    raw?.getTracks().forEach((t) => t.stop());
    destroyDenoiseNode(denoise);
    if (vadDest) { try { vadDest.disconnect(); } catch { /**/ } }
    const waits: Promise<unknown>[] = [];
    if (room && publishedTrack) {
      try { waits.push(room.localParticipant.unpublishTrack(publishedTrack, true)); } catch { /**/ }
    }
    if (ctx) { try { waits.push(ctx.close()); } catch { /**/ } }
    await Promise.allSettled(waits);
  }
  // gain = 1 (передаём) либо 0 (мут/оглушение/PTT-не-нажат/ниже порога чувствительности)
  private applyGate() {
    if (!this.micGain || !this.micActx) return;
    const s = getSettings();
    let target = 1;
    // Нет подтверждённого ownership — нет звука наружу. Особенно важно во время handoff и switch:
    // notify/HTTP/LiveKit-атрибуты могут прийти в разном порядке на разных устройствах.
    if (this.voiceLeaseVerifying || this.voiceClaimPending !== 0 || this.voiceLeaseEpoch <= 0 || this.voiceLeaseSession !== this.sessionId()) target = 0;
    else if (this.manualMute || this.deafened) target = 0;
    else if (s.mode === 'ptt') target = this.pttDown ? 1 : 0;
    else if (!this.vadOpen) target = 0; // "активация голосом": ниже порога чувствительности — не передаём
    try { this.micGain.gain.setTargetAtTime(target, this.micActx.currentTime, 0.015); } catch { this.micGain.gain.value = target; }
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
    this.noiseFloorDb += (db - this.noiseFloorDb) * (db < this.noiseFloorDb ? 0.04 : 0.0015);
    this.noiseFloorDb = Math.max(MIN_DB, Math.min(0, this.noiseFloorDb));
  }
  // ---------- живой индикатор уровня для настроек ----------
  // В звонке данные уже шлёт локальный анализатор из spLoop. Вне звонка поднимаем временный захват микрофона.
  onInputLevel(cb: LevelListener): () => void {
    this.levelListeners.add(cb);
    if (!this.inVoice && this.levelListeners.size === 1) this.startLevelMeter();
    return () => { this.levelListeners.delete(cb); if (this.levelListeners.size === 0) this.stopLevelMeter(); };
  }
  // Смена устройства/режима шумоподавления в настройках, пока превью-метр уже запущен (вне
  // звонка), сама по себе метр не перезапускает — иначе он продолжил бы слушать старый gUM-поток
  // со старыми constraints/денойзером. Дёргается из UI-обработчиков наравне с reapplyMic (тот
  // покрывает случай "в звонке", этот — "вне звонка"); внутри звонка это не-op.
  restartLevelMeter() {
    if (this.inVoice || this.levelListeners.size === 0) return;
    this.stopLevelMeter();
    this.startLevelMeter();
  }
  // Превью-метр в настройках (вне звонка) прогоняем через тот же денойзер, что и в реальном
  // звонке — иначе маркер порога чувствительности в настройках не совпадал бы с тем, что
  // реально видит гейт во время разговора.
  private async startLevelMeter() {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: this.micCapture() }); }
    catch { this.hooks.toast('Нет доступа к микрофону', 'err'); return; }
    if (this.levelListeners.size === 0 || this.inVoice) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.levelStream = stream;
    try {
      this.levelCtx = this.levelCtx || new AudioContext();
      this.levelCtx.resume?.().catch(() => {});
      this.levelSrc = this.levelCtx.createMediaStreamSource(stream);
      let preAnalyser: AudioNode = this.levelSrc;
      if (getSettings().nsMode === 'rnnoise') {
        this.levelDenoise = await createDenoiseNode(this.levelCtx);
        if (this.levelDenoise) {
          this.levelSrc.connect(this.levelDenoise);
          // см. startMic() — RnnoiseWorkletNode пишет только в канал 0, канал 1 тишина; без
          // сплита анализатор усреднял бы вдвое заниженный уровень (0.5*(L+0)).
          const split = this.levelCtx.createChannelSplitter(2);
          this.levelDenoise.connect(split);
          preAnalyser = split;
        }
        else this.hooks.toast('Шумодав недоступен — звук без обработки', 'warn');
      }
      // застали остановку/переключение режима, пока грузился denoise — не подключаем осиротевший граф
      if (this.levelListeners.size === 0 || this.inVoice || this.levelStream !== stream) return;
      this.levelAnalyser = this.levelCtx.createAnalyser();
      this.levelAnalyser.fftSize = 512; this.levelAnalyser.smoothingTimeConstant = 0.5;
      this.levelBuf = new Uint8Array(this.levelAnalyser.fftSize);
      preAnalyser.connect(this.levelAnalyser);
      this.levelRAF = requestAnimationFrame(this.levelLoop);
    } catch { /**/ }
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
  private stopLevelMeter() {
    if (this.levelRAF) cancelAnimationFrame(this.levelRAF); this.levelRAF = null;
    if (this.levelSrc) { try { this.levelSrc.disconnect(); } catch { /**/ } this.levelSrc = null; }
    destroyDenoiseNode(this.levelDenoise); this.levelDenoise = null;
    this.levelAnalyser = null; this.levelBuf = null; this.levelHold = 0;
    if (this.levelStream) { this.levelStream.getTracks().forEach((t) => t.stop()); this.levelStream = null; }
    if (this.levelCtx) { try { this.levelCtx.close(); } catch { /**/ } this.levelCtx = null; }
  }
  async reapplyMic() {
    if (!this.voiceRoom || !this.inVoice) { this.hooks.toast('Микрофон применится при подключении к голосовому'); return; }
    const room = this.voiceRoom;
    const voiceEpoch = this.voiceEpoch;
    await this.stopMic(room);
    if (!this.voiceIntentCurrent(voiceEpoch, room)) return;
    try {
      if (!await this.startMic(voiceEpoch) || !this.voiceIntentCurrent(voiceEpoch, room)) return;
      this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
      this.hooks.toast('Микрофон переключён', 'ok');
    }
    catch {
      if (!this.voiceIntentCurrent(voiceEpoch, room)) return;
      // выбранное устройство недоступно → откат на дефолтное
      setSettings({ input: '' });
      try {
        if (!await this.startMic(voiceEpoch) || !this.voiceIntentCurrent(voiceEpoch, room)) return;
        this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
        this.hooks.toast('Выбранный микрофон недоступен — включён дефолтный', 'warn');
      }
      catch {
        if (!this.voiceIntentCurrent(voiceEpoch, room)) return;
        this.noMic = true; this.micRetryAt = Date.now() + 5000;
        this.hooks.toast('Не удалось включить микрофон', 'err');
      }
    }
    this.emit();
  }
  async toggleMic() {
    // Зашёл в голосовой БЕЗ мика → клик = попытка получить доступ (дал разрешение позже / воткнул микрофон).
    if (this.inVoice && this.noMic) {
      this.manualMute = false; // клик по мику = «хочу говорить»
      const room = this.voiceRoom;
      const voiceEpoch = this.voiceEpoch;
      try {
        if (!room || !await this.startMic(voiceEpoch) || !this.voiceIntentCurrent(voiceEpoch, room)) return;
        this.noMic = false; this.micRetryAt = 0; this.micFailureNotified = false;
        this.saveVoicePrefs(); this.hooks.toast('Микрофон подключён');
      }
      catch { this.hooks.toast('Микрофон всё ещё недоступен', 'warn'); }
      this.emit(); return;
    }
    // Работает и ВНЕ голоса: пред-установка мута (Discord-стиль) — применится на входе (startMic мьютит
    // при manualMute). В голосе — сразу мьютим/размьючиваем трек. Всегда персистим.
    this.manualMute = !this.manualMute;
    this.saveVoicePrefs();
    if (this.inVoice && this.voiceRoom) {
      const p = this.micPub();
      // пока фулл-мут (deafened) активен, трек должен оставаться замьюченным на уровне LiveKit
      // независимо от ручного тогла — иначе снятие ручного мута во время deafen паразитно
      // размучивает трек (звук всё равно молчит через applyGate/gain=0, но у пиров и у себя
      // пропадает бейдж мута, будто фулл-мута больше нет).
      if (p && p.track) { (this.manualMute || this.deafened) ? p.track.mute() : p.track.unmute(); } // ручной мут виден другим
      this.applyGate();
    }
    this.emit();
  }
  toggleDeaf() {
    // Работает и ВНЕ голоса: пред-установка «оглох» — применится на входе (joinVoice ставит deaf-атрибут,
    // reconcile не подпишется). Всегда персистим.
    this.deafened = !this.deafened;
    this.saveVoicePrefs();
    if (this.inVoice) {
      // оглушение внутри мьютит/размьютит мик-трек → RoomEvent.TrackMuted/Unmuted. Глушим их
      // паразитный mute/unmute-звук на ~250мс: свой звук (fullMute/unmute) играем явно ниже.
      this.deafToggling = true;
      window.setTimeout(() => { this.deafToggling = false; }, 250);
      // транслируем пирам, чтобы у них статус-бейдж отличался от простого мута мика (см. build())
      if (this.voiceRoom) void this.setVoiceAttributes(this.voiceRoom, this.wantedVoiceAttributes(this.voiceRoom));
      const p = this.micPub();
      if (this.deafened) { if (p && p.track) p.track.mute(); }
      else { if (p && p.track && !this.manualMute) p.track.unmute(); }
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
  pttPress() { if (getSettings().mode !== 'ptt' || !this.inVoice || this.deafened || this.pttDown) return; this.pttDown = true; this.applyGate(); this.emit(); }
  pttRelease() { if (getSettings().mode !== 'ptt' || !this.inVoice || !this.pttDown) return; this.pttDown = false; this.applyGate(); this.emit(); }
  onModeChanged() { if (!this.inVoice) return; this.pttDown = false; this.applyGate(); this.emit(); }

  /* ---------- speaking ---------- */
  private attachAnalyser(username: string, mst: MediaStreamTrack) {
    if (!mst) return;
    try {
      this.detachAnalyser(username);
      this.spCtx = this.spCtx || new AudioContext();
      this.spCtx.resume?.().catch(() => {});
      const src = this.spCtx.createMediaStreamSource(new MediaStream([mst]));
      const an = this.spCtx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.5; src.connect(an);
      this.analysers.set(username, { an, buf: new Uint8Array(an.fftSize), hold: 0, src });
      if (!this.spRAF) this.spRAF = requestAnimationFrame(this.spLoop);
    } catch { /**/ }
  }
  private detachAnalyser(username: string) {
    const o = this.analysers.get(username);
    if (o) { try { o.src.disconnect(); } catch { /**/ } this.analysers.delete(username); }
    if (this.speakingSet.delete(username)) this.emit();
  }
  private spLoop = () => {
    this.spTick++;
    if (this.spTick % 3 === 0) {
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
          this.updateNoiseFloor(db); // подъём мед­ленный (см. updateNoiseFloor) — фраза его не продавит, а постоянный шум со временем перекроет
          this.levelListeners.forEach((f) => f(norm, spk, threshold));
          if (spk !== this.vadOpen) { this.vadOpen = spk; this.applyGate(); }
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
    this.spRAF = this.analysers.size ? requestAnimationFrame(this.spLoop) : null;
  };

  /* ---------- track events (mic/chat only — video-domain events live in VideoTransport) ---------- */
  private removeVoiceAudio(username: string, identity?: string): boolean {
    const entry = this.voiceAudioEls.get(username);
    if (!entry || (identity && entry.identity !== identity)) return false;
    this.voiceAudioEls.delete(username);
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
  private configureVoiceAudio(entry: { identity: string; track: RemoteTrack; el: HTMLMediaElement }, p: Participant) {
    const { el } = entry;
    el.autoplay = true;
    el.setAttribute('data-origin', 'voice');
    el.setAttribute('data-voice-identity', entry.identity);
    if (!el.isConnected) document.getElementById('audioSink')?.appendChild(el);
    // При webAudioMix SDK намеренно держит element muted/volume=0 и выводит через GainNode.
    // Размьют element создал бы обход gain (двойной звук и сломанный local mute).
    this.applyVolumeToParticipant(p);
    this.ensureVoiceOutput();
    const sink = getSettings().output || 'default';
    if ((el as any).setSinkId) void (el as any).setSinkId(sink).catch(() => {
      // Выбранный output исчез/недоступен — возвращаем этот element на системный default.
      if (sink !== 'default') void (el as any).setSinkId('default').catch(() => {});
    });
    // `autoplay=true` недостаточно: браузер может оставить element paused после background/device switch.
    void el.play().catch(() => { this.ensureVoiceAudioRunning(); });
  }
  private ensureVoiceOutput(force = false) {
    const room = this.voiceRoom;
    if (!room) return;
    const sink = getSettings().output || 'default';
    if (!force && this.voiceOutputRoom === room && this.voiceOutputSink === sink) return;
    if (!force && this.voiceOutputPending?.room === room && this.voiceOutputPending.sink === sink) return;
    const pending = { room, sink };
    this.voiceOutputPending = pending;
    void this.switchContextOutput(sink).then((effective) => {
      if (this.voiceRoom !== room || this.voiceOutputPending !== pending) return;
      if (!effective) return; // superseded by a newer output request
      const current = getSettings().output || 'default';
      this.voiceOutputRoom = room;
      this.voiceOutputSink = current === sink ? effective : '';
    }).finally(() => {
      if (this.voiceOutputPending === pending) this.voiceOutputPending = null;
    });
  }
  private ensureRemoteVoicePlayback(username?: string) {
    const room = this.voiceRoom;
    if (!room || !this.inVoice || this.deafened || !this.currentVc) return;
    const users = username ? [username] : [...new Set([...room.remoteParticipants.values()].map((p) => baseUid(p.identity)))];
    for (const user of users) {
      if (user === this.me.username) continue;
      const p = this.partOf(user, room);
      const pub = p?.getTrackPublication(Track.Source.Microphone);
      const remoteTrack = pub?.track as RemoteTrack | undefined;
      const active = !!p && (p as any).attributes?.vc === this.currentVc && !!remoteTrack;
      if (!active) { this.removeVoiceAudio(user); continue; }
      let entry = this.voiceAudioEls.get(user);
      if (!entry || entry.identity !== p!.identity || entry.track !== remoteTrack || !entry.el.isConnected) {
        this.removeVoiceAudio(user);
        const el = remoteTrack.attach() as HTMLMediaElement;
        entry = { identity: p!.identity, track: remoteTrack, el };
        this.voiceAudioEls.set(user, entry);
        this.attachAnalyser(user, (remoteTrack as any).mediaStreamTrack);
      }
      this.configureVoiceAudio(entry, p!);
    }
  }
  private onRemotePub = (pub: TrackPublication, p: RemoteParticipant, silent?: boolean) => {
    if (pub.source === Track.Source.Microphone) {
      const own = baseUid(p.identity) === this.me.username; // своя же другая сессия — без звука/подписки
      if (!own) this.reconcileUserAudio(baseUid(p.identity)); // переоцениваем ВСЕ сессии пользователя атомарно
      if (!own) this.reconcileChannelSounds(!!silent); // entry при живом входе пира в мой канал; seed на bootstrap (silent=true)
      this.emit();
    }
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant) => {
    if (pub.source === Track.Source.Microphone) this.reconcileChannelSounds(); // exit если пир был в моём канале (вышел из голоса)
    this.emit();
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant, room?: Room) => {
    if (track.kind === Track.Kind.Audio) {
      const isScreen = pub.source === Track.Source.ScreenShareAudio;
      const u = baseUid(p.identity);
      if (isScreen && room === this.viewRoom) {
        const a = track.attach() as HTMLMediaElement; a.autoplay = true; a.setAttribute('data-origin', 'view');
        document.getElementById('audioSink')?.appendChild(a);
        const sink = getSettings().output || 'default'; if ((a as any).setSinkId) void (a as any).setSinkId(sink).catch(() => {});
        this.screenAudioEls.set(u, a);
        try { (p as any).setVolume(this.deafened ? 0 : this.streamVolOf(u), Track.Source.ScreenShareAudio); } catch { /**/ }
        void a.play().catch(() => {});
      } else if (isScreen || !this.inVoice || room !== this.voiceRoom || this.deafened || u === this.me.username || p !== this.partOf(u, this.voiceRoom) || !this.currentVc || (p as any).attributes?.vc !== this.currentVc) {
        try { (pub as any).setSubscribed(false); track.detach().forEach((el) => el.remove()); } catch { /**/ }
        this.emit(); return;
      } else {
        this.removeVoiceAudio(u);
        const a = track.attach() as HTMLMediaElement;
        const entry = { identity: p.identity, track, el: a };
        this.voiceAudioEls.set(u, entry);
        this.configureVoiceAudio(entry, p);
        this.attachAnalyser(u, (track as any).mediaStreamTrack);
      }
    }
    this.emit();
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant, _room?: Room) => {
    track.detach().forEach((el) => el.remove());
    const u = baseUid(p.identity);
    this.clearSubscriptionRetries(p.identity, (pub as any).trackSid || (pub as any).sid);
    if (pub.source === Track.Source.ScreenShareAudio) this.screenAudioEls.delete(u);
    // Unsubscribe старой multi-device сессии не должен снести анализатор уже активной новой сессии.
    if (pub.source === Track.Source.Microphone && (p === this.partOf(u, this.voiceRoom) || !this.partOf(u, this.voiceRoom))) {
      this.removeVoiceAudio(u, p.identity);
      this.detachAnalyser(u);
    }
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
  private clearWatch(identity: string) {
    const transport = this.watchT.get(identity) ?? this.transportFor(identity);
    this.cancelWatchTimer(identity);
    this.watching.delete(identity);
    this.pendingWatch.delete(identity);
    transport.unwatch(identity);
    this.watchT.delete(identity);
  }
  private clearAllWatches() {
    this.cancelAllWatchTimers();
    const identities = new Set([...this.watching, ...this.pendingWatch, ...this.watchT.keys()]);
    identities.forEach((identity) => {
      const transport = this.watchT.get(identity) ?? this.transportFor(identity);
      transport.unwatch(identity);
    });
    this.watching.clear();
    this.pendingWatch.clear();
    this.watchT.clear();
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
    const t = this.transportFor(identity);
    this.watchT.set(identity, t); // пин: unwatch/статы пойдут в тот же транспорт, даже если объявление пропадёт
    t.watch(identity, quality);
    if (!localStorage.getItem('sprayTip')) { localStorage.setItem('sprayTip', '1'); this.hooks.toast('Кинь эмоут зрителям — 😃 в углу трансляции', 'info'); }
    this.emit();
    const timer = window.setTimeout(() => {
      // A cancelled/replaced attempt is not allowed to tear down its successor.
      if (this.watchTimers.get(identity) !== timer) return;
      this.watchTimers.delete(identity);
      if (this.pendingWatch.has(identity)) {
        this.clearWatch(identity);
        this.hooks.toast('Не удалось подключиться к трансляции', 'err'); this.emit();
      }
    }, 10000);
    this.watchTimers.set(identity, timer);
  }
  closeWatch(identity: string) {
    this.clearWatch(identity);
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
    this.emit();
  }
  private wset(sid: string) { let m = this.streamWatchers.get(sid); if (!m) { m = new Map(); this.streamWatchers.set(sid, m); } return m; }
  private cleanupWatchers() { const now = Date.now(); let ch = false; this.streamWatchers.forEach((m) => m.forEach((v, wid) => { if (now - v.ts > 9000) { m.delete(wid); ch = true; } })); if (ch) this.emit(); }
  private cleanupPeer(id: string) { this.streamWatchers.delete(id); this.streamWatchers.forEach((m) => m.delete(id)); this.detachAnalyser(id); this.clearWatch(id); const sa = this.screenAudioEls.get(id); if (sa) { try { sa.remove(); } catch { /**/ } this.screenAudioEls.delete(id); } } // защитно: при резком обрыве TrackUnsubscribed может не прийти → стрим-аудио залипнет

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
  userVolOf(id: string) { const n = Number(this.volsFor(this.viewServerId).users[id]); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; }
  private voiceUserVolOf(id: string) { const n = Number(this.volsFor(this.voiceServerId).users[id]); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; }
  isMutedFor(id: string) { return this.muteSet(this.viewServerId).has(id); }
  setUserVol(username: string, v: number) {
    const serverId = this.viewServerId; if (!serverId) return;
    const vols = this.volsFor(serverId); vols.users[username] = Math.max(0, Math.min(2, Number(v) || 0));
    this.hooks.saveSettings(serverId, vols); this.applyVolumeByName(username);
  }
  setStreamVol(id: string, v: number) {
    const serverId = this.viewServerId; if (!serverId) return;
    const vols = this.volsFor(serverId); const value = Math.max(0, Math.min(1, Number(v) || 0)); vols.streams[id] = value;
    this.hooks.saveSettings(serverId, vols);
    const p = this.participantWithTrack(id, Track.Source.ScreenShareAudio, this.viewRoom);
    if (p) { try { (p as any).setVolume(this.deafened ? 0 : value, Track.Source.ScreenShareAudio); } catch { /**/ } }
  }
  toggleUserMute(username: string) { const set = this.muteSet(this.viewServerId); if (set.has(username)) set.delete(username); else set.add(username); this.applyVolumeByName(username); this.emit(); }
  applyMaster() { this.applyAllVolumes(); }
  private applyVolumeByName(username: string) {
    if (!this.voiceServerId || this.viewServerId !== this.voiceServerId) return;
    const p = this.partOf(username, this.voiceRoom);
    if (!p || p === this.viewRoom?.localParticipant || !(p as any).setVolume) return;
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
  private applyAllVolumes() { this.voiceRoom?.remoteParticipants.forEach((p) => this.applyVolumeToParticipant(p)); }
  private participantWithTrack(username: string, source: Track.Source, room: Room | null): Participant | null {
    if (!room) return null;
    for (const p of room.remoteParticipants.values()) {
      if (baseUid(p.identity) === username && p.getTrackPublication(source)) return p;
    }
    return null;
  }
  private applyAllStreamVolumes() {
    this.viewRoom?.remoteParticipants.forEach((p) => {
      const u = baseUid(p.identity);
      if (!p.getTrackPublication(Track.Source.ScreenShareAudio)) return;
      try { (p as any).setVolume(this.deafened ? 0 : this.streamVolOf(u), Track.Source.ScreenShareAudio); } catch { /**/ }
    });
  }
  async applyOutput() {
    const sink = getSettings().output || 'default';
    // The shared WebAudio context is the actual audible mixer. Await it first;
    // HTML elements below are only the Chromium echo-cancellation workaround
    // and the non-mixed screen-audio path.
    const effectiveSink = await this.switchContextOutput(sink);
    if (!effectiveSink) return; // a newer device selection owns the queue
    document.querySelectorAll('#audioSink audio').forEach((a) => {
      if ((a as any).setSinkId) void (a as any).setSinkId(effectiveSink).catch(() => effectiveSink === 'default' ? undefined : (a as any).setSinkId('default').catch(() => {}));
      void (a as HTMLMediaElement).play().catch(() => {});
    });
    this.ensureRemoteVoicePlayback();
    this.ensureVoiceOutput(true);
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
    // кап на память сессии; срез идёт с НАЧАЛА, поэтому копим trimmedFront — компонент на столько же
    // поднимет firstItemIndex virtuoso, иначе якорь скролла рассинхронится и контент прыгнет.
    const CAP = 1000;
    if (next.length > CAP) { this.trimmedFront += next.length - CAP; this.messages = next.slice(next.length - CAP); }
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
  private pendingSend = new Map<number, { text: string; em: Record<string, string>; img?: string; reply?: ReplyRef; key: string; files?: Attachment[] }>();
  private setMsgStatus(localId: number, status: 'failed' | undefined) {
    let changed = false;
    this.messages = this.messages.map((m) => (m.id === localId && m.status !== status ? (changed = true, { ...m, status }) : m));
    if (changed) this.emit();
  }
  markSendResult(localId: number, ok: boolean, sid?: number) {
    if (ok) {
      const pend = this.pendingSend.get(localId);
      this.pendingSend.delete(localId);
      // Усыновляем серверный sid на оптимистичное сообщение — сразу включает edit/delete/реакции и
      // кликабельность реплая на него (иначе живут без sid до refetch).
      let ch = false;
      this.messages = this.messages.map((m) => (m.id === localId && m.sid == null && sid != null ? (ch = true, { ...m, sid, status: undefined }) : (m.id === localId && m.status ? (ch = true, { ...m, status: undefined }) : m)));
      const reactionChanged = sid != null ? this.adoptPendingReactions(localId, sid) : false;
      if (ch || reactionChanged) this.emit(); else this.setMsgStatus(localId, undefined);
      // Раздаём серверный sid ВСЕМ по mkey — чтобы ДРУГИЕ могли реагировать/edit на этом сообщении (у них оно live, без sid).
      if (sid != null && pend?.key && this.viewRoom) this.dataSend({ t: 'sid', mkey: pend.key, sid });
    } else this.setMsgStatus(localId, 'failed');
  }
  private applySidAdopt(d: any) {
    if (typeof d.sid !== 'number' || !d.mkey) return;
    const ids = this.messages.filter((m) => m.mkey === d.mkey && m.sid == null).map((m) => m.id);
    let ch = false;
    this.messages = this.messages.map((m) => (m.mkey === d.mkey && m.sid == null ? (ch = true, { ...m, sid: d.sid }) : m));
    ids.forEach((id) => { if (this.adoptPendingReactions(id, d.sid)) ch = true; });
    if (ch) this.emit();
  }
  retrySend(localId: number) {
    const p = this.pendingSend.get(localId); if (!p) return;
    this.setMsgStatus(localId, undefined);
    // только повторный persist (без ре-broadcast): если первый dataSend прошёл, у живых
    // сообщение уже есть — повтор рассылки дал бы дубль. Упал именно POST в БД. Тот же key —
    // если первый POST на самом деле дошёл (потерян лишь ответ), сервер проигнорит дубль.
    this.hooks.persistMessage(p.text, p.em, p.img, p.reply, localId, p.key, p.files);
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
    const serverId = (typeof logicalServerId === 'string' && logicalServerId.trim()) || this.viewServerId;
    const key = `${serverId || 'none'}:${exactSid == null ? 'recent' : `sid:${exactSid}`}`;
    if (this.chatRefreshTimers.has(key) || Date.now() - (this.lastChatRefresh.get(key) || 0) < 1200) return;
    const timer = window.setTimeout(() => {
      this.chatRefreshTimers.delete(key);
      if (serverId && (exactSid != null || this.viewServerId === serverId)) {
        this.lastChatRefresh.set(key, Date.now());
        this.hooks.refetchChat?.(exactSid, serverId);
      }
    }, 50);
    this.chatRefreshTimers.set(key, timer);
  }
  private mapHistory(list: HistoryMessage[]): ChatMessage[] {
    return list.map((m) => {
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
        kind: m.kind,
        level: m.level,
        release,
      };
    });
  }
  // начальная страница истории (последние N) — заменяет весь чат, ставит курсор на самое старое
  loadHistory(list: HistoryMessage[], hasMore = false) {
    ++this.chatGeneration;
    this.streamStateMessages.clear();
    this.reactions.clear();
    this.messages = this.mapHistory(list);
    this.chatMore = hasMore;
    this.oldestSid = list.length ? (list[0].id ?? null) : null; // list в ASC-порядке, [0] — самое старое
    this.trimmedFront = 0; this.chatPrepended = 0; // новая история — счётчики якоря virtuoso сбрасываются
    this.emit();
  }
  // догрузка пропущенного после реконнекта. Дедуп двойной:
  // 1) по sid — сообщения истории, уже показанные;
  // 2) по сигнатуре (автор+текст+картинка) — live-эхо от onData НЕ имеет sid, поэтому без этого
  //    refetchChat притаскивал те же сообщения из истории (уже с sid) и они дублировались.
  //    Совпавшему live-сообщению «усыновляем» серверный sid — дальше дедуп идёт по sid.
  // Оптимистичные и чужие realtime-копии сохраняют локальный id; история лишь усыновляет sid
  // и авторитетные поля, поэтому React-ключи не прыгают при восстановлении связи.
  mergeRecent(list: HistoryMessage[]) {
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
    for (const m of this.messages) {
      if (m.sid == null && !m.sys && m.uid) { const k = sig(m.uid, m.text, m.img, m.files); (liveBySig.get(k) || liveBySig.set(k, []).get(k)!).push(m); }
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
          if (this.reactionWrites.has(`${this.viewServerId}:${m.id}:${emoteId}`)) authoritative.set(emoteId, reaction);
        }
        for (const pending of this.reactionWriteDesired.values()) {
          if (pending.serverId !== this.viewServerId || pending.sid !== m.id) continue;
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
      this.messages = merged;
    }
    pendingReactionAdoptions.forEach(([localId, sid]) => {
      if (this.adoptPendingReactions(localId, sid)) reactionsChanged = true;
    });
    const mentioned = mapped.filter((m) => m.mention); // один звук, а не по сообщению (не спамим при длинном обрыве)
    if (mentioned.length) {
      // звук тега играет само уведомление (notify) — как в Discord; на обычные сообщения не звучим
      this.hooks.toast(mentioned.length === 1 ? `${mentioned[0].who} упомянул тебя` : `Тебя упомянули · ${mentioned.length}`, 'info');
      notify('mention', { title: mentioned.length === 1 ? String(mentioned[0].who) : 'Упоминания', body: mentioned.length === 1 ? String(mentioned[0].text || '').slice(0, 140) : `Тебя упомянули · ${mentioned.length}`, tag: 'mention:' + this.viewServerId });
    }
    if (mapped.length || adopted || canonicalized || duplicateLocalIds.size || reactionsChanged) this.emit();
  }
  // догрузка более старых сообщений при скролле вверх — prepend в начало, курсор сдвигается назад
  prependHistory(list: HistoryMessage[], hasMore: boolean) {
    this.chatMore = hasMore;
    if (list.length) {
      this.messages = [...this.mapHistory(list), ...this.messages];
      this.oldestSid = list[0].id ?? this.oldestSid;
      this.chatPrepended += list.length; // якорь virtuoso сдвигается вместе с данными (один emit) — без прыжка
    }
    this.emit();
  }
  // очистка чата (админ): локально + всем; сервер уже почищен вызывающей стороной
  clearMessages(byName?: string) {
    ++this.chatGeneration;
    this.streamStateMessages.clear();
    this.messages = [];
    this.dataSend({ t: 'clear', by: byName || this.me.displayName });
    this.emit();
    this.sysMsg((byName || this.me.displayName) + ' очистил чат');
  }
  sendChatWithEmotes(text: string, em: Record<string, string>, img?: string, reply?: ReplyRef, files?: Attachment[]) {
    if (!text.trim() && !img && !(files && files.length)) return;
    const t = text.trim();
    const key = newClientKey(); // общий ключ: dedup POST + mkey для усыновления sid всеми клиентами (реакции на чужих)
    // realtime-раздача только при поднятой комнате; локальный эхо + persist работают и без неё —
    // в окне фоновой докрутки connect (сразу после входа в сервер) сообщение не теряется, ложится в БД.
    if (this.viewRoom) this.dataSend({ t: 'chat', name: this.me.displayName, text: t, em, color: this.me.avatarColor, img, files, uid: this.me.id, reply, mkey: key });
    const id = this.pushMsg(this.me.displayName, t, false, this.me.avatarColor, true, img, undefined, this.me.id, reply, files, key);
    this.pendingSend.set(id, { text: t, em, img, reply, key, files });
    this.hooks.persistMessage(t, em, img, reply, id, key, files);
  }

  // --- Рейтинг: анонс достижения уровня (веха ×5) ---
  private announcedLevels = new Set<string>(); // сессионный дедуп (сервер тоже дедупит по client_key)
  // Пришёл пуш levelup по notify-WS (см. notifyws.ts). Виновник — мы; объявляем ОДИН раз в чат этого
  // сервера. Только если сейчас смотрим этот сервер (иначе комнаты нет — в чужой чат слать нельзя).
  onLevelUp(serverId: string, level: number) {
    if (!serverId || !Number.isFinite(level) || level <= 0) return;
    if (this.viewServerId !== serverId) return;
    this.announceLevelUp(level);
  }
  private announceLevelUp(level: number) {
    const key = `lvl:${this.viewServerId}:${this.me.id}:${level}`;
    if (this.announcedLevels.has(key)) return; // уже объявляли в этой сессии
    this.announcedLevels.add(key);
    const text = `🎉 ${this.me.displayName} — ${level} уровень!`; // нейтрально по роду; карточка рисует имя+уровень отдельно
    // realtime-раздача в комнату (карточка kind='levelup') + локальный эхо + персист (оффлайн увидят из истории).
    if (this.viewRoom) this.dataSend({ t: 'chat', name: this.me.displayName, text, color: this.me.avatarColor, uid: this.me.id, mkey: key, kind: 'levelup', level });
    const id = this.pushMsg(this.me.displayName, text, false, this.me.avatarColor, true, undefined, undefined, this.me.id, undefined, undefined, key, 'levelup', level);
    this.hooks.persistMessage(text, {}, undefined, undefined, id, key, undefined, 'levelup', level);
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
    const serverId = this.viewServerId;
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
    const run = previous.catch(() => {}).then(() => persist(serverId, sid, emote.id, emote.name, add)).then(() => {
      // Broadcast only durable state. Peers never keep a reaction that the API
      // rejected, and serialized writes preserve rapid add -> remove order.
      if (this.viewServerId === serverId)
        this.dataSend({ t: 'react', sid, id: emote.id, name: emote.name, uid: this.me.id, add });
    }).catch(() => {
      if (this.viewServerId !== serverId || this.reactionWriteSeq.get(key) !== seq) return;
      if (this.setOwnReaction(sid, emote, !add)) this.emit();
      this.hooks.toast('Не удалось сохранить реакцию — изменение отменено', 'warn');
      this.hooks.refetchChat?.(sid);
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
    this.messages = this.messages.map((m) => (m.sid === sid ? { ...m, text: t, edited: true } : m));
    this.emit();
    this.dataSend({ t: 'edit', sid, text: t });
    this.hooks.editMessage?.(this.viewServerId, sid, t);
  }
  deleteChat(sid: number) {
    this.messages = this.messages.filter((m) => m.sid !== sid);
    this.reactions.delete(sid);
    this.emit();
    this.dataSend({ t: 'del', sid });
    this.hooks.deleteMessage?.(this.viewServerId, sid);
  }
  private applyEdit(d: any) {
    if (typeof d.sid !== 'number') return;
    let ch = false;
    this.messages = this.messages.map((m) => (m.sid === d.sid ? (ch = true, { ...m, text: String(d.text || ''), edited: true }) : m));
    if (ch) this.emit();
  }
  private applyDelete(d: any) {
    if (typeof d.sid !== 'number') return;
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.sid !== d.sid);
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
      if (d.t === 'music') { if (room === this.voiceRoom) this.onMusicMessage?.(d); return; }
      // чат/clear/emote/watch/typing — данные ПРОСМАТРИВАЕМОГО сервера, приходят по viewRoom
      if (room !== this.viewRoom) return;
      // Release-пакет из RoomService не имеет participant-sender. Не доверяем его
      // payload: он лишь просит сверить авторитетную HTTP-историю. Пакет от обычного
      // участника с kind=release игнорируем, чтобы нельзя было подделать карточку RelayApp.
      if (d.t === 'release' || (d.t === 'chat' && d.kind === 'release')) {
        if (!sender) this.refreshChat(typeof d.sid === 'number' ? d.sid : undefined, this.viewServerId);
        return;
      }
      if (d.t === 'chat') {
        if (d.em) for (const k in d.em) this.onEmoteResolve?.(k, d.em[k]);
        this.typingUsers.delete(d.name);
        const own = d.uid === this.me.id; // моё же сообщение с другой сессии — показываем как своё, без звука/меншена
        const repliedToMe = !own && this.replyToMe(d.reply);
        const mentioned = !own && (this.textMentionsMe(d.text) || repliedToMe);
        this.pushMsg(d.name, d.text, false, d.color, own, d.img, undefined, d.uid, d.reply, d.files, d.mkey, d.kind, d.level);
        if (!own && mentioned) { // тост+notify ТОЛЬКО когда тегнули/реплайнули; звук тега даёт само notify (Discord)
          this.hooks.toast(repliedToMe ? `${d.name} ответил тебе` : `${d.name} упомянул тебя`, 'info');
          const fallback = d.img ? '🖼 изображение' : (d.files && d.files.length ? '📎 вложение' : '');
          notify('mention', { title: d.name, body: String(d.text || '').slice(0, 140) || fallback, tag: 'mention:' + this.viewServerId });
        }
      }
      else if (d.t === 'clear') { ++this.chatGeneration; this.streamStateMessages.clear(); this.messages = []; this.reactions.clear(); this.emit(); this.sysMsg((d.by || 'Админ') + ' очистил чат'); }
      else if (d.t === 'emote') this.emoteListeners.forEach((f) => f(d.s, d.e, d.by, d.x, d.sz));
      else if (d.t === 'watch') { const m = this.wset(d.s); if (d.on) m.set(d.id, { name: d.n, color: d.c ?? 0, avatarUrl: d.a, ts: Date.now() }); else m.delete(d.id); this.emit(); }
      else if (d.t === 'typing') { if (d.name && d.name !== this.me.displayName) { this.typingUsers.set(d.name, Date.now() + 3500); this.emit(); setTimeout(() => this.pruneTyping(), 3600); } }
      else if (d.t === 'react') this.applyReaction(d);
      else if (d.t === 'edit') this.applyEdit(d);
      else if (d.t === 'del') this.applyDelete(d);
      else if (d.t === 'sid') this.applySidAdopt(d);
    } catch { /**/ }
  };
  onEmoteResolve: ((name: string, id: string) => void) | null = null;
  onMusicMessage: ((d: any) => void) | null = null;   // music.ts подписывается: приём синка сессии прослушивания
  sendMusic(obj: any) { this.dataSend({ ...obj, t: 'music' }); } // рассылка по voiceRoom (scoped по vc внутри music.ts)
  // reliable для состояния, которое нельзя терять: чат (сообщения), vclaim (одна голосовая на
  // аккаунт — потеря датаграммы оставила бы две сессии в войсе), clear (чистка чата).
  // vclaim принадлежит голосовой сессии → voiceRoom; чат/clear/typing/emote/watch — просматриваемому серверу → viewRoom
  private dataSend(obj: any) { const room = (obj.t === 'vclaim' || obj.t === 'music') ? this.voiceRoom : this.viewRoom; if (!room) return; try { void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: obj.t === 'chat' || obj.t === 'vclaim' || obj.t === 'clear' || obj.t === 'music' || obj.t === 'react' || obj.t === 'edit' || obj.t === 'del' || obj.t === 'sid' }).catch(() => {}); } catch { /**/ } }

  emoteImg(id: string) { return emoteUrl(id); }
}

import {
  Room, RoomEvent, Track, LocalAudioTrack, AudioPresets, ConnectionQuality,
  type RemoteParticipant, type Participant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { User, Member, ChatMessage, Emote, HistoryMessage, ReplyRef, Attachment, Reaction } from './types';
import { baseUid } from './util';
import { notify } from './notify';
import { api } from './api';
import { isTauri, detectGame } from './native';
import { getSettings, setSettings } from './settings';
import { emoteUrl } from './emotes';
import { playSound } from './sounds';
import type { VideoTransport } from './transport/videoTransport';
import { LiveKitVideoTransport } from './transport/livekitVideo';
import { TreeVideoTransport } from './transport/treeVideo';
import { createDenoiseNode, destroyDenoiseNode } from './denoise';
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

// шкала чувствительности ввода: rms(0..1) -> dB(-80..0) -> норм.уровень(0..1), сравнимый с порогом
const WATCH_MAX = 4; // грид: сколько чужих стримов зритель смотрит разом (веб — tree-WS/PC на стрим, натив — Rust relay-слот на стрим)
const MIN_DB = -50; // шкала подогнана под уже обработанный браузером сигнал (AGC/NS), а не под теоретический динамический диапазон
function rmsToDb(rms: number): number { if (rms <= 0) return MIN_DB; return Math.max(MIN_DB, Math.min(0, 20 * Math.log10(rms))); }
function dbToNorm(db: number): number { return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB)); }

interface EngineHooks {
  toast: (text: string, kind?: 'ok' | 'warn' | 'err' | 'info') => void;
  saveSettings: (vols: { users: Record<string, number>; streams: Record<string, number> }) => void;
  peerJoined: (identity: string) => void;
  persistMessage: (text: string, em: Record<string, string>, image: string | undefined, reply: ReplyRef | undefined, localId: number, key: string, files?: Attachment[], kind?: string, level?: number) => void;
  refetchChat?: () => void; // догрузить свежие сообщения (после реконнекта — заполнить пропуск)
  endBroadcast?: () => void; // остановить нативную трансляцию (Rust) при выходе из голосового — browser-share гасит stopShare
  reactMessage?: (serverId: string, sid: number, emoteId: string, emoteName: string, add: boolean) => void; // персист реакции
  editMessage?: (serverId: string, sid: number, text: string) => void;   // персист редактирования
  deleteMessage?: (serverId: string, sid: number) => void;               // персист удаления
}

let msgSeq = 1;

// стабильный dedup-ключ сообщения (переживает retry) — сервер по нему игнорит дубль,
// если первый POST дошёл, а ответ потерялся
function newClientKey(): string {
  try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
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
  private screenAudioEls = new Map<string, HTMLMediaElement>();
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

  VOLS = { users: {} as Record<string, number>, streams: {} as Record<string, number> };
  private perMute = new Set<string>();
  private onlineHint = new Set<string>();
  private awayHint = new Set<string>();  // серверный хинт: члены «нет на месте» (idle, из /presence.away)
  private voiceHint: Record<string, string> = {}; // серверный хинт {username: channelId}: состав голосовых до подъёма локальной комнаты

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
      if (!isLocal) this.pendingWatch.delete(identity);
      this.emit();
    };
    const onStreamStart = (identity: string, silent: boolean) => {
      this.emit();
      if (!silent) {
        const who = this.nameOf(identity);
        this.sysMsg(`📺 ${who} начал трансляцию — «▶ Смотреть» в списке`);
        playSound('streamOn');
        this.hooks.toast(who + ' начал трансляцию', 'info');
        notify('stream', { title: who, body: 'начал(а) трансляцию', tag: 'stream:' + this.viewServerId }); // тег как у серверного push → local+push схлопываются в один баннер
      }
    };
    const onStreamStop = (identity: string) => {
      // Разрываем watch явно (idempotent, no-op если уже не смотрели) — иначе
      // при обрыве вещателя <video> остаётся с последним кадром/чёрным экраном
      // навсегда: без unwatch() PeerConnection и трек никто не закрывает.
      this.transportFor(identity).unwatch(identity);
      this.watchT.delete(identity);
      this.watching.delete(identity); this.pendingWatch.delete(identity);
      this.sysMsg(`${this.nameOf(identity)} закончил трансляцию`);
      if (baseUid(identity) !== this.me.username) playSound('streamOff'); // свой streamOff играет stopShare (без задвоения)
      this.emit();
    };
    for (const t of [this.liveKitT, this.treeT]) {
      t.onVideoTrack(onVideoTrack as any);
      t.onVideoTrackRemoved(() => this.emit());
      t.onStreamStart(onStreamStart);
      t.onStreamStop(onStreamStop);
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
    this.snap = this.build();
  }

  setMe(me: User) { this.me = me; }
  setMembers(m: Member[]) { this.members = m; this.emit(); }
  setOnlineHint(ids: string[]) { this.onlineHint = new Set(ids); this.emit(); }
  setAwayHint(ids: string[]) { this.awayHint = new Set(ids); this.emit(); }
  setVoiceHint(v: Record<string, string>) { this.voiceHint = v || {}; this.emit(); }
  setVols(v: { users?: Record<string, number>; streams?: Record<string, number> }) {
    this.VOLS.users = v.users || {}; this.VOLS.streams = v.streams || {};
  }
  // состояние пагинации чата (для UI/догрузки старых сообщений)
  get chatHasMore() { return this.chatMore; }
  get chatOldestCursor() { return this.oldestSid; }

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
      if (this.roomReady && p) {
        vc = this.voiceChannelOf(m.username) || '';                          // vc-атрибут (доезжает и для «старых» пиров)
        if (!vc && this.isInVoice(m.username)) vc = this.voiceHint[m.username] || ''; // атрибут в полёте, но mic-трек уже виден
      } else {
        vc = this.voiceHint[m.username] || '';                               // пир не виден локально → серверный хинт
      }
      if (vc) {
        voiceChannels[m.username] = vc;
        const at = m.username === this.me.username ? this.myVcAt : Number((p as any)?.attributes?.vcAt) || null;
        if (at && (!(vc in channelActiveSince) || at < channelActiveSince[vc])) channelActiveSince[vc] = at;
      }
      const inV = !!vc || this.isInVoice(m.username);
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
      inVoice: this.inVoice, voiceConnecting: this.inVoice && this.voiceConnecting, myVoiceChannel: this.currentVc, voiceServerId: this.voiceServerId, voiceChannels, channelActiveSince, deafened: this.deafened,
      localMicMuted: this.localMicMuted(), pttDown: this.pttDown,
      presence, speaking, streams, watching, pending, watchers, messages: this.messages, chatHasMore: this.chatMore, chatTrimmed: this.trimmedFront, chatPrepended: this.chatPrepended,
      typing: [...this.typingUsers].filter(([n, exp]) => exp > Date.now() && n !== this.me.displayName).map(([n]) => n),
    };
  }

  /* ---------- connection ---------- */
  async connect(url: string, token: string, serverId: string) {
    const r = new Room({
      adaptiveStream: true, dynacast: true,
      publishDefaults: { dtx: true, red: true, simulcast: true, audioPreset: AudioPresets.musicHighQuality },
    });
    // connect поднимает ТОЛЬКО viewRoom (смотрю сервер). voiceRoom НЕ трогаем — им владеют join/leaveVoice:
    // при входе в голос voiceRoom:=viewRoom (реюз), при уходе на другой сервер голосовая комната остаётся.
    this.viewRoom = r;
    this.viewServerId = serverId;
    this.liveKitT.attach(r, { me: this.me.username, serverId });
    this.treeT.attach(r, { me: this.me.username, serverId });
    // Хендлеры ветвятся по РОЛИ комнаты r: voice-работа при r===voiceRoom, view-работа при r===viewRoom.
    // Пока комнаты равны (4a) — обе ветви истинны, как раньше. При расцепе (4c) событие voice-only комнаты
    // A не запустит view-логику (чат/presence), а view-only комнаты B — voice-логику (mic/vc/vclaim).
    r.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.onSub(track, pub, p, r))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.onUnsub(track, pub, p, r))
      .on(RoomEvent.ParticipantConnected, (p) => { if (r === this.viewRoom) { const u = baseUid(p.identity); if (u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.hooks.toast((p.name || u) + ' в сети', 'ok'); this.hooks.peerJoined(u); } this.emit(); })
      // u !== this.me.username — иначе отключение СВОЕЙ же зомби-сессии (неудачный первый коннект,
      // сеть/деплой) чистит АНАЛИЗАТОР ТЕКУЩЕЙ живой сессии (detachAnalyser(me) внутри cleanupPeer):
      // полоска чувствительности замирает, гейт «активация голосом» может замереть закрытым — мик
      // «пропадает» без видимой причины, лечится только перезаходом в канал. См. ParticipantConnected
      // строкой выше — та же защита у него уже была, тут её не хватало.
      .on(RoomEvent.ParticipantDisconnected, (p) => { if (r === this.viewRoom) { const u = baseUid(p.identity); if (u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.cleanupPeer(u); } if (r === this.voiceRoom) this.reconcileChannelSounds(); this.emit(); })
      // звук мута слышен только самому мутящемуся — играем при локальном событии МОЕГО голосового трека
      .on(RoomEvent.TrackMuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p === this.voiceRoom?.localParticipant && !this.deafToggling) playSound('mute'); this.emit(); })
      .on(RoomEvent.Reconnecting, () => { this.reconnecting = true; this.hooks.toast('Связь потеряна — переподключаюсь…', 'warn'); this.emit(); })
      .on(RoomEvent.Reconnected, () => {
        this.reconnecting = false;
        // voiceRoom-реконнект: заново заявляем vc/deaf + reconcile + vclaim (иначе на пару секунд пропадёт
        // звук/состав, и одна-голосовая могла разъехаться, пока мы лежали).
        if (r === this.voiceRoom && this.inVoice && this.currentVc) {
          if (!this.myVcAt) this.myVcAt = this.channelStartFor(this.currentVc);
          this.voiceRoom?.localParticipant.setAttributes({ vc: this.currentVc, deaf: this.deafened ? '1' : '', vcAt: String(this.myVcAt) }).catch(() => {});
          this.reconcileAllAudio();
          this.lastVclaim = Date.now();
          this.dataSend({ t: 'vclaim', uid: this.me.id, session: this.sessionId() });
        }
        // viewRoom-реконнект: ре-энумерация чужих стримов (появившийся во время обрыва не прошёл бы через
        // onStreamStart — нет живого TrackPublished) + догрузка чата, пришедшего во время обрыва.
        if (r === this.viewRoom) { this.liveKitT.onRoomConnected(); this.hooks.refetchChat?.(); }
        this.hooks.toast('Связь восстановлена', 'ok'); this.emit();
      })
      .on(RoomEvent.Disconnected, () => { this.reconnecting = false; this.emit(); })
      // размут мика слышен только самому; при оглушении звук даёт toggleDeaf, тут глушим
      .on(RoomEvent.TrackUnmuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p === this.voiceRoom?.localParticipant && !this.deafToggling) playSound('unmute'); this.emit(); })
      // качество/пинг — метрика ГОЛОСОВОГО соединения (voiceRoom)
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (r === this.voiceRoom && p === r.localParticipant) { this.connQuality = mapQuality(q); this.emit(); } })
      .on(RoomEvent.TrackPublished, (pub, p) => { if (r === this.voiceRoom) this.onRemotePub(pub, p); })
      .on(RoomEvent.TrackUnpublished, (pub, p) => { if (r === this.voiceRoom) this.onRemoteUnpub(pub, p); })
      // пир сменил vc → пере-подписка на его микрофон, только в voiceRoom (в viewRoom чужого сервера
      // микрофоны не слушаю). Дисплей ростера обновляет emit() (build читает vc из соответствующей комнаты).
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => { if (p !== r.localParticipant && r === this.voiceRoom) { this.reconcilePeerAudio(p as Participant); this.reconcileChannelSounds(); } this.emit(); })
      .on(RoomEvent.DataReceived, (payload) => this.onData(payload, r));
    await r.connect(url, token, { autoSubscribe: false });
    this.roomReady = true; // комната реально поднялась — можно снимать скелетоны голосового/сцены
    // voiceRoom: подписка на уже опубликованные микрофоны (bootstrap). viewRoom: ре-энумерация стримов.
    if (r === this.voiceRoom) r.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)));
    if (r === this.viewRoom) { this.liveKitT.onRoomConnected(); this.treeT.onRoomConnected(); }
    // ОДИН engine-таймер на оба соединения (методы внутри бьют в нужную комнату: announceWatch/reconcile/
    // selfHeal сами выбирают view/voice). connect зовётся на каждую смену смотримого сервера → чистим
    // прежний, чтобы не плодить таймеры при браузинге в голосе. self-heal vc/подписок — см. selfHealVc.
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = window.setInterval(() => { this.announceWatch(); this.cleanupWatchers(); if (this.inVoice) { this.reconcileAllAudio(); this.reconcileChannelSounds(); } this.selfHealVc(); }, 3000);
    // Детект игры (натив): раз в 10с публикуем участник-атрибуты game/gicon → все видят «играет в X».
    if (isTauri) { if (this.gameTimer) clearInterval(this.gameTimer); this.pollGame(); this.gameTimer = window.setInterval(() => this.pollGame(), 10000); }
    this.emit();
  }
  private async pollGame() {
    if (!this.viewRoom) return;
    let g: GameStatus | null = null;
    if (isTauri && getSettings().shareGame) {
      try { const d = await detectGame(); if (d && d.name) g = { name: d.name.slice(0, 48), icon: d.icon || undefined }; } catch { /**/ }
    }
    this.myGame = g;
    const wantName = g?.name || '';
    const wantIcon = (g?.icon && g.icon.length < 4000) ? g.icon : ''; // атрибут маленький — большую иконку не шлём
    const attrs = this.viewRoom.localParticipant.attributes || {};
    if ((attrs.game || '') !== wantName || (attrs.gicon || '') !== wantIcon) {
      // setAttributes МЕРЖИТ (не заменяет) — vc/deaf не затираются (проверено существующим поведением)
      this.viewRoom.localParticipant.setAttributes({ game: wantName, gicon: wantIcon }).catch(() => {});
    }
    this.emit();
  }

  // Полный teardown (logout / выход с сервера, где я в голосе): рвём ОБЕ комнаты + всё состояние.
  disconnect() {
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
    this.liveKitT.detach(); this.treeT.detach(); this.screenAudioEls.clear();
    this.watching.clear(); this.pendingWatch.clear(); this.watchT.clear(); this.streamWatchers.clear();
    this.perMute.clear(); this.messages = []; this.chatMore = false; this.oldestSid = null; this.trimmedFront = 0;
    this.onlineHint.clear(); this.awayHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    this.clearAudioUnlock();
    if (this.micRaw) { this.micRaw.getTracks().forEach((t) => t.stop()); this.micRaw = null; }
    if (this.micActx) { try { this.micActx.close(); } catch { /**/ } this.micActx = null; }
    this.micGain = null;
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.roomReady = false; this.screenStream = null; // deafened/manualMute НЕ трогаем — персист-интент
    // рвём ОБЕ комнаты (при расцепе разные; при shared — одна, Set схлопнёт дубль)
    new Set([this.viewRoom, this.voiceRoom].filter(Boolean)).forEach((rm) => { try { (rm as Room).disconnect(); } catch { /**/ } });
    this.viewRoom = null; this.voiceRoom = null; this.viewServerId = ''; this.voiceServerId = null; this.emit();
  }

  // Уйти со СМОТРИМОГО сервера (браузинг на другой / на главную-с-выходом), НЕ трогая голос: чистим
  // view-состояние (чат/стримы/presence-хинты/typing) и рвём viewRoom, ТОЛЬКО если она не голосовая.
  detachView() {
    this.messages = []; this.chatMore = false; this.oldestSid = null; this.trimmedFront = 0;
    this.watching.clear(); this.pendingWatch.clear(); this.watchT.clear(); this.streamWatchers.clear();
    // presence-хинты и typing принадлежат ПРЕДЫДУЩЕМУ смотримому серверу
    this.onlineHint.clear(); this.awayHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    this.liveKitT.detach(); this.treeT.detach();
    document.querySelectorAll('#audioSink audio[data-origin="view"]').forEach((a) => a.remove()); // только стрим-аудио, не мик
    this.screenAudioEls.clear();
    this.roomReady = false;
    const vw = this.viewRoom;
    this.viewRoom = null; this.viewServerId = '';
    if (vw && vw !== this.voiceRoom) { try { vw.disconnect(); } catch { /**/ } } // не рвём, если это голосовая комната (голос продолжается)
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
    this.roomReady = true; // голосовая комната уже подключена
    this.liveKitT.attach(this.viewRoom, { me: this.me.username, serverId: this.viewServerId });
    this.treeT.attach(this.viewRoom, { me: this.me.username, serverId: this.viewServerId });
    this.liveKitT.onRoomConnected(); this.treeT.onRoomConnected();
    this.emit();
  }

  /* ---------- presence helpers ---------- */
  // участник по БАЗОВОМУ username (identity = username#session). Несколько сессий одного юзера →
  // предпочитаем ту, что в голосовом (с mic-треком), иначе любую.
  private partOf(username: string, room: Room | null = this.viewRoom): Participant | null {
    if (!room) return null;
    if (username === this.me.username) return room.localParticipant;
    let any: Participant | null = null;
    for (const p of room.remoteParticipants.values()) {
      if (baseUid(p.identity) !== username) continue;
      if (p.getTrackPublication(Track.Source.Microphone)) return p;
      any = p;
    }
    return any;
  }
  // id этой сессии = суффикс после # в моём LiveKit-identity (для tie-break гонки vclaim)
  private sessionId(): string { const id = this.voiceRoom?.localParticipant.identity || ''; const i = id.indexOf('#'); return i < 0 ? id : id.slice(i + 1); }
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
    if (baseUid(p.identity) === this.me.username) return; // своя же другая сессия — не подписываемся (эхо)
    const mp = p.getTrackPublication(Track.Source.Microphone);
    if (!mp) return;
    // ОГЛОХ (deafened) → НЕ подписываемся: нет трека = гарантированная тишина, независимо от громкости.
    // Иначе оглохший оставался подписан, а глушение по громкости могло не примениться (пир размутился →
    // resubscribe без re-apply громкости → слышно, хотя фулл-мут).
    const want = this.inVoice && !this.deafened && !!this.currentVc && (p as any).attributes?.vc === this.currentVc;
    try { (mp as any).setSubscribed(want); } catch { /**/ }
    if (!want) this.detachAnalyser(baseUid(p.identity));
  }
  private reconcileAllAudio() { this.voiceRoom?.remoteParticipants.forEach((p) => this.reconcilePeerAudio(p)); }
  // Кто СЕЙЧАС в МОЁМ голосовом канале (base username). Для entry/exit при их входе/выходе — в т.ч. при
  // СМЕНЕ канала: там мик не пере-публикуется (нет TrackPublished/Unpublished), меняется только vc-атрибут.
  private currentChannelPeers(): Set<string> {
    const s = new Set<string>();
    if (!this.inVoice || !this.currentVc || !this.voiceRoom) return s;
    this.voiceRoom.remoteParticipants.forEach((p) => {
      const u = baseUid(p.identity);
      if (u !== this.me.username && (p as any).attributes?.vc === this.currentVc) s.add(u);
    });
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
      if ((a.vc || '') !== (this.currentVc || '') || (a.deaf || '') !== wantDeaf) {
        if (this.currentVc && !this.myVcAt) this.myVcAt = this.channelStartFor(this.currentVc); // не долетел исходный setAttributes — досчитываем сейчас
        this.voiceRoom.localParticipant.setAttributes({ vc: this.currentVc || '', deaf: wantDeaf, vcAt: this.currentVc ? String(this.myVcAt) : '' }).catch(() => {});
      }
    }
    // viewRoom, ЕСЛИ она НЕ голосовая (смотрю сервер, где не в войсе): моего голоса тут нет → vc/deaf ''
    // (иначе после leaveVoice/браузинга «залипну» в канале у других на этом сервере — vc:'' мог не долететь).
    if (this.viewRoom && this.viewRoom !== this.voiceRoom) {
      const a = this.viewRoom.localParticipant.attributes || {};
      if ((a.vc || '') !== '' || (a.deaf || '') !== '')
        this.viewRoom.localParticipant.setAttributes({ vc: '', deaf: '', vcAt: '' }).catch(() => {});
    }
  }
  private isStreaming(username: string): boolean {
    if (username === this.me.username) {
      // web self-share (LiveKit) ИЛИ НАТИВНЫЙ self-стрим: его поднимает Rust, web-treeT в дерево НЕ
      // вещает (treeT.isBroadcasting всегда false) — берём из discovery liveStreams (isRemoteBroadcasting),
      // куда сервер шлёт stream-live И самому вещателю. Иначе стример не видел свой LIVE (другие — видели).
      return this.liveKitT.isBroadcasting(username) || this.treeT.isRemoteBroadcasting(username);
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
  private localMicMuted(): boolean { return this.manualMute; }
  private micPub() { return this.voiceRoom && this.voiceRoom.localParticipant.getTrackPublication(Track.Source.Microphone); }
  // Ждём, пока комната реально ПОДКЛЮЧИТСЯ (roomReady). Нужно, когда после свитча серверов WebRTC-connect
  // ещё идёт в фоне: объект Room есть, но публиковать в него нельзя. Резолвит true при готовности, false —
  // на таймауте или если вход отменён (disconnect на свитче сбросил inVoice). Поллинг дёшев (200мс).
  private waitRoomReady(timeoutMs: number): Promise<boolean> {
    if (this.roomReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = window.setInterval(() => {
        if (this.roomReady) { clearInterval(iv); resolve(true); }
        else if (!this.inVoice || Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
      }, 200);
    });
  }

  /* ---------- VOICE join/leave/switch (несколько каналов на сервер) ---------- */
  // подключиться к голосовому каналу channelId; если уже в другом — переключиться без переподнятия микрофона
  async joinVoice(channelId: string) {
    if (!channelId || !this.viewRoom) return;
    const targetServer = this.viewServerId; // вход в голос — на СМОТРИМОМ сервере (его каналы в ServerView)
    // уже в голосовом на ЭТОМ же сервере → только смена канала (мик остаётся)
    if (this.inVoice && this.voiceServerId === targetServer) {
      if (this.currentVc !== channelId) await this.switchVoice(channelId);
      return;
    }
    // в голосовом на ДРУГОМ сервере → покидаем его (Discord: молча переносим голос сюда)
    if (this.inVoice && this.voiceServerId !== targetServer) await this.leaveVoice();
    this.currentVc = channelId;
    this.inVoice = true; this.pttDown = false; // manualMute НЕ сбрасываем — пред-установка мута применяется на входе
    this.voiceConnecting = true;
    this.voiceRoom = this.viewRoom;      // реюз коннекта смотримого сервера как голосового (без второго соединения)
    this.voiceServerId = targetServer;
    this.liveKitT.setBroadcastRoom?.(this.voiceRoom); // браузер вещает в ГОЛОСОВУЮ комнату (не в смотримую при браузинге)
    this.emit(); // ОПТИМИСТИЧНО: сразу рисуем себя в канале + статус «подключение» (mic ещё публикуется)
    // viewRoom мог ещё подниматься (фоновый connect после свитча, ретраи ~9.5с): объект Room есть, но не
    // подключён (roomReady=false). Публикация mic/vc в неподнятую комнату молча провалилась бы — «зашёл»
    // по UI, по факту нет. Ждём готовности, показывая «подключение»; не поднялась за таймаут — откат.
    if (!this.roomReady) {
      const ready = await this.waitRoomReady(15000);
      if (this.currentVc !== channelId || !this.inVoice) return; // за время ожидания свитч/выход/передумал
      if (!ready || !this.voiceRoom) {
        this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.voiceRoom = null; this.voiceServerId = null;
        this.hooks.toast('Realtime-связь не поднялась — попробуй ещё раз', 'warn'); this.emit(); return;
      }
    }
    if (!this.voiceRoom) { this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.voiceServerId = null; this.emit(); return; }
    this.myVcAt = this.channelStartFor(channelId);
    // deaf по пред-установке — сразу заявляем пирам (иначе зашёл «оглохшим», а бейджа deaf у них нет)
    try { await this.voiceRoom.localParticipant.setAttributes({ vc: channelId, vcAt: String(this.myVcAt), deaf: this.deafened ? '1' : '' }); } catch { /**/ }
    try { await this.startMic(); }
    catch {
      this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.myVcAt = null;
      try { await this.voiceRoom.localParticipant.setAttributes({ vc: '', vcAt: '' }); } catch { /**/ }
      this.voiceRoom = null; this.voiceServerId = null;
      this.hooks.toast('Нет доступа к микрофону', 'err'); this.emit(); return;
    }
    this.reconcileAllAudio(); // подписываемся на пиров этого же канала (bootstrap мик-подписок)
    this.reconcileChannelSounds(true); // сеем состав канала БЕЗ звука (не проигрываем entry по всем, кто уже там)
    this.startConnPoll();
    this.lastVclaim = Date.now();
    this.dataSend({ t: 'vclaim', uid: this.me.id, session: this.sessionId() }); // забираем голос у своих других сессий (одна голосовая на аккаунт)
    this.voiceConnecting = false;
    playSound('entry'); // сам зашедший тоже слышит вход (остальные в канале — через onRemotePub)
    this.emit();
  }
  // перейти в другой голосовой канал того же сервера: микрофон остаётся, меняются подписки и стримы
  async switchVoice(channelId: string) {
    if (!this.voiceRoom || !this.inVoice || this.currentVc === channelId) return;
    this.currentVc = channelId;
    this.myVcAt = this.channelStartFor(channelId);
    try { await this.voiceRoom.localParticipant.setAttributes({ vc: channelId, vcAt: String(this.myVcAt) }); } catch { /**/ }
    this.reconcileAllAudio();
    this.reconcileChannelSounds(true); // пере-сеем состав НОВОГО канала БЕЗ звука (мне не нужен бурст entry; другие услышат МЕНЯ через смену vc-атрибута)
    playSound('entry');
    this.emit();
  }
  async leaveVoice() {
    if (!this.voiceRoom || !this.inVoice) return;
    const vr = this.voiceRoom; // фиксируем: ниже обнулим указатель (и, возможно, порвём комнату)
    // оптимистично: сразу убираем себя из канала (UI не ждёт async-очистку mic/треков)
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.pttDown = false; this.myVcAt = null; // deafened/manualMute НЕ сбрасываем — персист-интент до след. входа
    this.myChannelPeers.clear(); // вышел — состав моего канала сброшен (другие услышат мой выход по unpub мика / vc'')
    playSound('exit'); // сам вышедший тоже слышит выход (остальные в канале — через onRemoteUnpub)
    this.emit();
    this.stopConnPoll();
    await this.stopShare().catch(() => {}); // browser-share (LiveKit)
    this.hooks.endBroadcast?.();            // нативная трансляция (Rust-дерево) — тоже гасим
    this.stopMic();
    vr.remoteParticipants.forEach((p) => { const rp = p.getTrackPublication(Track.Source.Microphone); if (rp) { try { (rp as any).setSubscribed(false); } catch { /**/ } } this.detachAnalyser(baseUid(p.identity)); });
    // Сносим мик-аудиоэлементы сразу (origin=voice), не ждём async onUnsub. Стрим-аудио (origin=view)
    // НЕ трогаем — стрим смотрится и без голосового (и может жить в ДРУГОЙ, смотримой комнате).
    document.querySelectorAll('#audioSink audio[data-origin="voice"]').forEach((a) => a.remove());
    try { await vr.localParticipant.setAttributes({ vc: '', deaf: '', vcAt: '' }); } catch { /**/ }
    // голосовая комната была voice-only (я смотрю ДРУГОЙ сервер) → рвём её; если это смотримая — оставляем как viewRoom
    if (vr !== this.viewRoom) { try { vr.disconnect(); } catch { /**/ } }
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
    this.pingMs = null; this.connQuality = 'unknown';
  }
  // RTT до сервера из WebRTC-статистики микрофонного трека (remote-inbound-rtp), фолбэк — candidate-pair
  private async pollPing() {
    // Watchdog: контекст публикации мика мог родиться/остаться 'suspended' (getUserMedia-промпт съел
    // user-activation) → пиры не слышат, хотя локально «всё работает». Держим его running, пока в войсе.
    if (this.inVoice && ((this.micActx && this.micActx.state !== 'running') || (this.spCtx && this.spCtx.state !== 'running'))) this.ensureVoiceAudioRunning();
    if (this.inVoice) void this.checkMicAlive(true); // мобилка: пере-снять мик, если источник умер на бэкграунде
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
      let cq = lp?.connectionQuality != null ? mapQuality(lp.connectionQuality) : 'unknown';
      if (cq === 'unknown' && v != null) {
        // LiveKit ещё не отдал качество, но RTT есть → связь жива. Выводим из пинга, чтобы не залипать.
        const ms = v * 1000; cq = ms < 120 ? 'excellent' : ms < 250 ? 'good' : 'poor';
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
  private async startMic() {
    if (!this.voiceRoom) return;
    // Контекст ПУБЛИКАЦИИ создаём и резюмим ДО getUserMedia — пока жива user-activation от клика «войти
    // в голосовой». Раньше он рождался ПОСЛЕ gUM: на ПЕРВОМ входе промпт разрешения съедал активацию →
    // контекст 'suspended', а suspended MediaStreamDestination выдаёт ТИШИНУ (пиры не слышат до F5 —
    // после перезахода разрешение уже есть, промпта нет, активация клика доживает). Уже РАБОТАЮЩИЙ
    // контекст промпт не усыпляет. resume + gesture-unlock/watchdog (ensureVoiceAudioRunning) — подстраховка.
    this.micActx = new AudioContext();
    try { await this.micActx.resume?.(); } catch { /**/ }
    // spCtx (контекст VAD-анализатора) резюмим тем же до-промптовым окном активации, что и micActx. Гейт
    // «активации голосом» ставит vadOpen ИМЕННО из анализатора на spCtx (attachAnalyser/spLoop). Рождённый
    // 'suspended' ПОСЛЕ gUM-промпта (attachAnalyser зовётся в конце startMic, уже без активации) → анализатор
    // отдаёт константу → vadOpen залипает false → applyGate держит gain=0 → мик-трек ЖИВОЙ, но пиры слышат
    // ТИШИНУ (чинит только F5). Watchdog его не спасал: гейтится по micActx, а тот теперь заранее running.
    this.spCtx = this.spCtx || new AudioContext();
    try { await this.spCtx.resume?.(); } catch { /**/ }
    try {
      this.micRaw = await navigator.mediaDevices.getUserMedia({ audio: this.micCapture() });
    } catch (e) {
      try { this.micActx.close(); } catch { /**/ } this.micActx = null; // отказ в доступе — не течём контекстом
      throw e;
    }
    const src = this.micActx.createMediaStreamSource(this.micRaw);
    const ctx = this.micActx; // снимок — ниже единственный await, за время которого concurrent
    // stopMic() (watchdog/повторный join) мог обнулить this.micActx; сверяем перед продолжением.
    let preGate: AudioNode = src;
    if (getSettings().nsMode === 'rnnoise') {
      this.micDenoise = await createDenoiseNode(ctx);
      if (this.micActx !== ctx) { destroyDenoiseNode(this.micDenoise); this.micDenoise = null; return; }
      if (this.micDenoise) {
        src.connect(this.micDenoise);
        // RnnoiseWorkletNode(maxChannels:1) реально пишет обработанный сигнал только в канал 0
        // своего выхода — канал 1 остаётся тишиной. Без явного сплита узел ниже по графу видит
        // "2-канальный" выход с тишиной в правом, и апмикс на publish даёт звук в одно (левое) ухо.
        // ChannelSplitterNode().connect(next) без явного output-индекса берёт ИМЕННО output 0 —
        // чистый моно-сигнал канала 0, который затем штатно дублируется в оба канала на publish.
        const split = this.micActx.createChannelSplitter(2);
        this.micDenoise.connect(split);
        preGate = split;
      }
      else this.hooks.toast('Шумодав недоступен — звук без обработки', 'warn');
    }
    this.micGain = this.micActx.createGain();
    preGate.connect(this.micGain);
    const dest = this.micActx.createMediaStreamDestination();
    this.micGain.connect(dest);
    // VAD/метр — отвод ДО гейта (preGate), НЕ от micGain: гейт решает лишь что публикуется наружу,
    // а не что видит сам детектор речи.
    this.micVadDest = this.micActx.createMediaStreamDestination();
    preGate.connect(this.micVadDest);
    const lat = new LocalAudioTrack(dest.stream.getAudioTracks()[0]);
    await this.voiceRoom.localParticipant.publishTrack(lat, { source: Track.Source.Microphone, dtx: true, red: true, audioPreset: AudioPresets.musicHighQuality });
    // свежий трек публикуется НЕмьютнутым на уровне LiveKit — если сейчас ручной мут/оглушение,
    // домьютить сразу (иначе после reapplyMic в муте пиры читают mp.isMuted=false → бейдж мута
    // пропадает у всех, хотя мы молчим через gain=0). applyGate решает лишь громкость, не LiveKit-mute.
    if (this.manualMute || this.deafened) { try { lat.mute(); } catch { /**/ } }
    // индикатор «говорит» — с очищенного (после denoise) сигнала, ДО гейта
    this.attachAnalyser(this.me.username, this.micVadDest.stream.getAudioTracks()[0]);
    this.applyGate();
    this.ensureVoiceAudioRunning(); // добить, если контекст всё ещё suspended (анлок на первый жест + watchdog)
  }
  // Гарантирует, что контекст ПУБЛИКАЦИИ микрофона (micActx) реально запущен. Браузер держит
  // AudioContext 'suspended' до пользовательского жеста в контексте страницы; startMic создаёт
  // контекст ПОСЛЕ await getUserMedia (+ промпт) → активация потеряна, контекст молчит, пиры не
  // слышат (а зелёный VAD-индикатор от отдельного spCtx работает — потому баг незаметен локально).
  // Полный перезаход «чинил» через sticky-activation. Резюмируем сразу + разовый анлок на первый
  // жест; conn-watchdog (pollPing) добивает, если контекст уснул повторно.
  private ensureVoiceAudioRunning() {
    const resume = () => { this.micActx?.resume?.().catch(() => {}); this.spCtx?.resume?.().catch(() => {}); };
    resume();
    // ОБА контекста должны быть running: micActx = публикуемый звук, spCtx = VAD-гейт (без него gain залипает 0).
    // Раньше гейт стоял только на micActx → после его пред-резюма gesture-unlock не ставился, а spCtx оставался спящим.
    const running = () => (!this.micActx || this.micActx.state === 'running') && (!this.spCtx || this.spCtx.state === 'running');
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
  private async checkMicAlive(fromWatchdog = false) {
    if (!this.inVoice || !this.voiceRoom || this.micRestarting || !this.micActx) return;
    const t = this.micRaw?.getAudioTracks()[0];
    const ended = !t || t.readyState === 'ended';
    if (!ended && t && t.muted && fromWatchdog) this.micMutedTicks++;
    else if (t && !t.muted) this.micMutedTicks = 0;
    if (!ended && this.micMutedTicks < 2) return;
    this.micRestarting = true; this.micMutedTicks = 0;
    try { this.stopMic(); await this.startMic(); } catch { /**/ }
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
  private stopMic() {
    const p = this.micPub();
    if (p && p.track) { try { this.voiceRoom?.localParticipant.unpublishTrack(p.track, true); } catch { /**/ } }
    this.detachAnalyser(this.me.username);
    this.vadOpen = false;
    this.clearAudioUnlock();
    if (this.micRaw) { this.micRaw.getTracks().forEach((t) => t.stop()); this.micRaw = null; }
    destroyDenoiseNode(this.micDenoise); this.micDenoise = null;
    if (this.micVadDest) { try { this.micVadDest.disconnect(); } catch { /**/ } this.micVadDest = null; }
    if (this.micActx) { try { this.micActx.close(); } catch { /**/ } this.micActx = null; }
    this.micGain = null;
  }
  // gain = 1 (передаём) либо 0 (мут/оглушение/PTT-не-нажат/ниже порога чувствительности)
  private applyGate() {
    if (!this.micGain || !this.micActx) return;
    const s = getSettings();
    let target = 1;
    if (this.manualMute || this.deafened) target = 0;
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
    this.stopMic();
    try { await this.startMic(); this.hooks.toast('Микрофон переключён', 'ok'); }
    catch {
      // выбранное устройство недоступно → откат на дефолтное
      setSettings({ input: '' });
      try { await this.startMic(); this.hooks.toast('Выбранный микрофон недоступен — включён дефолтный', 'warn'); }
      catch { this.hooks.toast('Не удалось включить микрофон', 'err'); }
    }
    this.emit();
  }
  async toggleMic() {
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
      this.voiceRoom?.localParticipant.setAttributes({ deaf: this.deafened ? '1' : '' }).catch(() => {});
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
    this.screenAudioEls.forEach((a) => (a.muted = this.deafened));
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
        if (spk && !this.speakingSet.has(id)) { this.speakingSet.add(id); changed = true; }
        else if (!spk && this.speakingSet.has(id)) { this.speakingSet.delete(id); changed = true; }
      });
      if (changed) this.emit();
    }
    this.spRAF = this.analysers.size ? requestAnimationFrame(this.spLoop) : null;
  };

  /* ---------- track events (mic/chat only — video-domain events live in VideoTransport) ---------- */
  private onRemotePub = (pub: TrackPublication, p: RemoteParticipant, silent?: boolean) => {
    if (pub.source === Track.Source.Microphone) {
      const own = baseUid(p.identity) === this.me.username; // своя же другая сессия — без звука/подписки
      // подписываемся на микрофон только если я в голосовом, НЕ оглох и пир в ТОМ ЖЕ канале
      if (!own && this.inVoice && !this.deafened && !!this.currentVc && (p as any).attributes?.vc === this.currentVc) {
        try { (pub as any).setSubscribed(true); } catch { /**/ }
      }
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
      const a = track.attach(); a.autoplay = true;
      const isScreen = pub.source === Track.Source.ScreenShareAudio;
      // метка происхождения: teardown одной комнаты сносит из #audioSink только СВОИ элементы (стрим-аудио
      // viewRoom vs мик-аудио voiceRoom), иначе уход со стрим-сервера снёс бы голос и наоборот.
      a.setAttribute('data-origin', isScreen ? 'view' : 'voice');
      document.getElementById('audioSink')?.appendChild(a);
      const out = getSettings().output; if ((a as any).setSinkId && out) (a as any).setSinkId(out).catch(() => {});
      const u = baseUid(p.identity);
      if (isScreen) { this.screenAudioEls.set(u, a); a.muted = this.deafened; a.volume = this.streamVolOf(u); }
      else if (!this.inVoice || room !== this.voiceRoom) { try { track.detach().forEach((el) => el.remove()); } catch { /**/ } this.emit(); return; } // mic клеим только в голосовой комнате и в войсе (in-flight после leave / чужая комната)
      else { (a as HTMLAudioElement).muted = this.deafened; this.applyVolumeToParticipant(p); this.attachAnalyser(u, (track as any).mediaStreamTrack); }
    }
    this.emit();
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant, _room?: Room) => {
    track.detach().forEach((el) => el.remove());
    const u = baseUid(p.identity);
    if (pub.source === Track.Source.ScreenShareAudio) this.screenAudioEls.delete(u);
    if (pub.source === Track.Source.Microphone) this.detachAnalyser(u);
    this.emit();
  };

  /* ---------- streams (thin facades over VideoTransport) ---------- */
  getVideoTrack(key: string) { return this.liveKitT.getVideoTrack(key) ?? this.treeT.getVideoTrack(key); }

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
      this.watchTimers.delete(identity);
      if (this.pendingWatch.has(identity)) {
        this.pendingWatch.delete(identity); this.watching.delete(identity);
        this.transportFor(identity).unwatch(identity);
        this.watchT.delete(identity);
        this.hooks.toast('Не удалось подключиться к трансляции', 'err'); this.emit();
      }
    }, 10000);
    this.watchTimers.set(identity, timer);
  }
  closeWatch(identity: string) {
    this.watching.delete(identity); this.pendingWatch.delete(identity);
    // Таймер watch() (10с "не удалось подключиться") иначе переживал явный закрытие —
    // если закрыли до коннекта, он всё равно стрелял и повторно звал unwatch()+toast.
    const t = this.watchTimers.get(identity); if (t) { clearTimeout(t); this.watchTimers.delete(identity); }
    this.transportFor(identity).unwatch(identity);
    this.watchT.delete(identity);
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
  private cleanupPeer(id: string) { this.streamWatchers.delete(id); this.streamWatchers.forEach((m) => m.delete(id)); this.detachAnalyser(id); this.watching.delete(id); this.pendingWatch.delete(id); this.watchT.delete(id); const sa = this.screenAudioEls.get(id); if (sa) { try { sa.remove(); } catch { /**/ } this.screenAudioEls.delete(id); } } // защитно: при резком обрыве TrackUnsubscribed может не прийти → стрим-аудио залипнет

  /* ---------- volumes ---------- */
  streamVolOf(id: string) { return this.VOLS.streams[id] !== undefined ? this.VOLS.streams[id] : 1; }
  userVolOf(id: string) { return this.VOLS.users[id] !== undefined ? this.VOLS.users[id] : 1; }
  isMutedFor(id: string) { return this.perMute.has(id); }
  setUserVol(username: string, v: number) { this.VOLS.users[username] = v; this.hooks.saveSettings(this.VOLS); this.applyVolumeByName(username); }
  setStreamVol(id: string, v: number) { this.VOLS.streams[id] = v; this.hooks.saveSettings(this.VOLS); const a = this.screenAudioEls.get(id); if (a) a.volume = v; }
  toggleUserMute(username: string) { if (this.perMute.has(username)) this.perMute.delete(username); else this.perMute.add(username); this.applyVolumeByName(username); this.emit(); }
  applyMaster() { this.applyAllVolumes(); }
  private applyVolumeByName(username: string) {
    const p = this.partOf(username);
    if (!p || p === this.viewRoom?.localParticipant || !(p as any).setVolume) return;
    this.applyVolumeToParticipant(p);
  }
  // Громкость СТАВИМ на конкретную сессию (participant), а не через partOf(username): partOf
  // предпочитает mic-сессию, но при второй (ghost/реконнект) сессии или транзитной пропаже
  // mic-публикации возвращает ПУСТУЮ сессию — setVolume уходил мимо звучащего элемента, и на
  // undeafen громкость реально звучащей сессии оставалась 0 навсегда (ничто её больше не
  // восстанавливает). Прямой проход по каждому участнику этого промаха лишён.
  private applyVolumeToParticipant(p: Participant) {
    if (!(p as any).setVolume) return;
    const u = baseUid(p.identity);
    const v = (this.deafened || this.perMute.has(u)) ? 0 : (getSettings().master / 100) * this.userVolOf(u);
    try { (p as any).setVolume(v); } catch { /**/ }
  }
  private applyAllVolumes() { this.voiceRoom?.remoteParticipants.forEach((p) => this.applyVolumeToParticipant(p)); }
  async applyOutput() { if (!this.viewRoom) return; const out = getSettings().output; try { await this.viewRoom.switchActiveDevice('audiooutput', out || 'default'); } catch { /**/ } document.querySelectorAll('#audioSink audio').forEach((a) => { if ((a as any).setSinkId && out) (a as any).setSinkId(out).catch(() => {}); }); }

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
  private pushMsg(who: string | null, text: string, sys: boolean, color?: number, mineOverride?: boolean, img?: string, ts?: number, uid?: string, reply?: ReplyRef, files?: Attachment[], mkey?: string, kind?: string, level?: number): number {
    const mine = mineOverride !== undefined ? mineOverride : (!sys && who === this.me.displayName);
    const mention = !sys && !mine && (this.textMentionsMe(text) || this.replyToMe(reply));
    const id = msgSeq++;
    const next = [...this.messages, { id, uid, who, text, mine, sys, color, img, files, ts: ts ?? Date.now(), mention, reply, mkey, kind, level }];
    // кап на память сессии; срез идёт с НАЧАЛА, поэтому копим trimmedFront — компонент на столько же
    // поднимет firstItemIndex virtuoso, иначе якорь скролла рассинхронится и контент прыгнет.
    const CAP = 1000;
    if (next.length > CAP) { this.trimmedFront += next.length - CAP; this.messages = next.slice(next.length - CAP); }
    else this.messages = next;
    this.emit();
    return id;
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
      if (ch) this.emit(); else this.setMsgStatus(localId, undefined);
      // Раздаём серверный sid ВСЕМ по mkey — чтобы ДРУГИЕ могли реагировать/edit на этом сообщении (у них оно live, без sid).
      if (sid != null && pend?.key && this.viewRoom) this.dataSend({ t: 'sid', mkey: pend.key, sid });
    } else this.setMsgStatus(localId, 'failed');
  }
  private applySidAdopt(d: any) {
    if (typeof d.sid !== 'number' || !d.mkey) return;
    let ch = false;
    this.messages = this.messages.map((m) => (m.mkey === d.mkey && m.sid == null ? (ch = true, { ...m, sid: d.sid }) : m));
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
  sysMsg(text: string) { this.pushMsg(null, text, true); }
  private mapHistory(list: HistoryMessage[]): ChatMessage[] {
    return list.map((m) => {
      if (m.em) for (const k in m.em) this.onEmoteResolve?.(k, m.em[k]);
      // реакции из истории — авторитетны (корректируют realtime-дрейф). Ключ — серверный id (sid).
      if (m.id != null) {
        if (m.reactions && m.reactions.length) this.reactions.set(m.id, new Map(m.reactions.map((r) => [r.id, { name: r.name, count: r.count, mine: r.mine }])));
        else this.reactions.delete(m.id);
      }
      return { id: msgSeq++, sid: m.id, uid: m.uid, who: m.name, text: m.text, mine: m.uid === this.me.id, sys: false, color: m.color, img: m.img, files: m.files, ts: m.ts, mention: m.uid !== this.me.id && (this.textMentionsMe(m.text) || this.replyToMe(m.reply)), reply: m.reply, edited: m.edited, kind: m.kind, level: m.level };
    });
  }
  // начальная страница истории (последние N) — заменяет весь чат, ставит курсор на самое старое
  loadHistory(list: HistoryMessage[], hasMore = false) {
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
  // Свои сообщения не трогаем (показаны оптимистично, приходят с m.uid === me.id).
  mergeRecent(list: HistoryMessage[]) {
    if (!list.length) return;
    const haveSids = new Set(this.messages.map((m) => m.sid).filter((s): s is number => s != null));
    const filesSig = (files?: Attachment[]) => (files && files.length ? files.map((f) => f.url).join(',') : '');
    const sig = (uid?: string, text?: string, img?: string, files?: Attachment[]) => `${uid || ''}${text || ''}${img || ''}${filesSig(files)}`;
    const liveBySig = new Map<string, ChatMessage[]>();
    for (const m of this.messages) {
      if (m.sid == null && !m.sys && m.uid) { const k = sig(m.uid, m.text, m.img, m.files); (liveBySig.get(k) || liveBySig.set(k, []).get(k)!).push(m); }
    }
    const add: HistoryMessage[] = [];
    for (const m of list) {
      if (m.id == null || haveSids.has(m.id)) continue;
      // Свои сообщения НЕ пропускаем безусловно: при мультисессии своё сообщение с другого
      // устройства могло не дойти по data-каналу (обрыв) → его надо догрузить. Дубля не будет —
      // оптимистичная копия лежит в liveBySig и усыновит sid; реально пропущенное попадёт в add.
      const bucket = liveBySig.get(sig(m.uid, m.text, m.img, m.files));
      if (bucket && bucket.length) { bucket.shift()!.sid = m.id; continue; } // усыновили sid, не дублируем
      add.push(m);
    }
    if (!add.length) return;
    const mapped = this.mapHistory(add);
    this.messages = [...this.messages, ...mapped];
    const mentioned = mapped.filter((m) => m.mention); // один звук, а не по сообщению (не спамим при длинном обрыве)
    if (mentioned.length) {
      // звук тега играет само уведомление (notify) — как в Discord; на обычные сообщения не звучим
      this.hooks.toast(mentioned.length === 1 ? `${mentioned[0].who} упомянул тебя` : `Тебя упомянули · ${mentioned.length}`, 'info');
      notify('mention', { title: mentioned.length === 1 ? String(mentioned[0].who) : 'Упоминания', body: mentioned.length === 1 ? String(mentioned[0].text || '').slice(0, 140) : `Тебя упомянули · ${mentioned.length}`, tag: 'mention:' + this.viewServerId });
    }
    this.emit();
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
  getReactions(sid?: number | null): Reaction[] {
    if (sid == null) return [];
    const m = this.reactions.get(sid);
    if (!m) return [];
    return [...m.entries()].map(([id, v]) => ({ id, name: v.name, count: v.count, mine: v.mine })).filter((r) => r.count > 0);
  }
  toggleReaction(sid: number, emote: { id: string; name: string }) {
    let m = this.reactions.get(sid); if (!m) { m = new Map(); this.reactions.set(sid, m); }
    const cur = m.get(emote.id) || { name: emote.name, count: 0, mine: false };
    const add = !cur.mine;
    cur.mine = add; cur.count = Math.max(0, cur.count + (add ? 1 : -1)); cur.name = emote.name;
    if (cur.count <= 0) m.delete(emote.id); else m.set(emote.id, cur);
    this.emit();
    this.dataSend({ t: 'react', sid, id: emote.id, name: emote.name, uid: this.me.id, add });
    this.hooks.reactMessage?.(this.viewServerId, sid, emote.id, emote.name, add);
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
  private onData = (payload: Uint8Array, room?: Room) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(payload));
      if (d.t === 'vclaim') {
        // vclaim прилетает по voiceRoom (dataSend роутит vclaim→voiceRoom) — обрабатываем только от неё.
        // Другая моя сессия зашла в голосовой → выхожу (одна голосовая на аккаунт). tie-break: если ГОНКА
        // (я тоже только что заявил голос) — уступает сессия с меньшим session-id; вне гонки новый девайс побеждает.
        if (room !== this.voiceRoom) return;
        if (d.uid === this.me.id && this.inVoice) {
          const race = Date.now() - this.lastVclaim < 800;
          if (!race || String(d.session || '') > this.sessionId()) this.leaveVoice();
        }
        return;
      }
      // music (совместное прослушивание YouTube) — по voiceRoom; scoped по vc уже внутри music-store
      if (d.t === 'music') { if (room === this.voiceRoom) this.onMusicMessage?.(d); return; }
      // чат/clear/emote/watch/typing — данные ПРОСМАТРИВАЕМОГО сервера, приходят по viewRoom
      if (room !== this.viewRoom) return;
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
      else if (d.t === 'clear') { this.messages = []; this.reactions.clear(); this.emit(); this.sysMsg((d.by || 'Админ') + ' очистил чат'); }
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
  private dataSend(obj: any) { const room = (obj.t === 'vclaim' || obj.t === 'music') ? this.voiceRoom : this.viewRoom; if (!room) return; try { room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: obj.t === 'chat' || obj.t === 'vclaim' || obj.t === 'clear' || obj.t === 'music' || obj.t === 'react' || obj.t === 'edit' || obj.t === 'del' || obj.t === 'sid' }); } catch { /**/ } }

  emoteImg(id: string) { return emoteUrl(id); }
}

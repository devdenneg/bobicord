import {
  Room, RoomEvent, Track, LocalAudioTrack, AudioPresets, ConnectionQuality,
  type RemoteParticipant, type Participant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { User, Member, ChatMessage, Emote, HistoryMessage, ReplyRef } from './types';
import { baseUid } from './util';
import { notify } from './notify';
import { api } from './api';
import { getSettings, setSettings } from './settings';
import { emoteUrl } from './emotes';
import { playSound } from './sounds';
import type { VideoTransport } from './transport/videoTransport';
import { LiveKitVideoTransport } from './transport/livekitVideo';
import { TreeVideoTransport } from './transport/treeVideo';

export interface PeerState { online: boolean; inVoice: boolean; micMuted: boolean; streaming: boolean; deafened: boolean }
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
  voiceChannels: Record<string, string>;      // username -> channelId (кто в каком голосовом канале)
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
  typing: string[];
}

type EmoteListener = (streamerId: string, emoteId: string, by: string, x: number, size?: string) => void;
export type LevelListener = (level: number, open: boolean, threshold: number) => void;

// шкала чувствительности ввода: rms(0..1) -> dB(-80..0) -> норм.уровень(0..1), сравнимый с порогом
const MIN_DB = -50; // шкала подогнана под уже обработанный браузером сигнал (AGC/NS), а не под теоретический динамический диапазон
function rmsToDb(rms: number): number { if (rms <= 0) return MIN_DB; return Math.max(MIN_DB, Math.min(0, 20 * Math.log10(rms))); }
function dbToNorm(db: number): number { return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB)); }

interface EngineHooks {
  toast: (text: string, kind?: 'ok' | 'warn' | 'err' | 'info') => void;
  saveSettings: (vols: { users: Record<string, number>; streams: Record<string, number> }) => void;
  peerJoined: (identity: string) => void;
  persistMessage: (text: string, em: Record<string, string>, image: string | undefined, reply: ReplyRef | undefined, localId: number, key: string) => void;
  refetchChat?: () => void; // догрузить свежие сообщения (после реконнекта — заполнить пропуск)
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
  private room: Room | null = null;
  private me: User;
  private members: Member[] = [];
  private hooks: EngineHooks;

  inVoice = false;
  private voiceConnecting = false; // оптимистично зашли в канал, но mic ещё публикуется
  private lastVclaim = 0; // когда мы сами заявили голос (для tie-break гонки claim'ов между своими сессиями)
  private currentVc: string | null = null; // id голосового канала, в котором я сейчас (несколько каналов на сервер)
  private roomReady = false; // true только после успешного await r.connect() (не просто наличие объекта Room)
  private reconnecting = false;
  private connQuality: VoiceQuality = 'unknown'; // качество связи (обновляется по событию LiveKit)
  private pingMs: number | null = null;          // RTT до сервера, мс (опрос статистики в голосовом)
  private connTimer: number | null = null;       // таймер опроса пинга (только в голосовом)
  private deafened = false;
  private pttDown = false;
  private watchTimers = new Map<string, number>();

  // mic pipeline: raw device -> gain (громкость/мут) -> published track
  private micRaw: MediaStream | null = null;
  private micActx: AudioContext | null = null;
  private micGain: GainNode | null = null;
  private manualMute = false;

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
  private chatMore = false; // есть ли ещё более старые сообщения на сервере (пагинация вверх)
  private oldestSid: number | null = null; // DB-id самого старого загруженного сообщения = курсор для before
  private trimmedFront = 0; // сколько сообщений суммарно срезано с НАЧАЛА (для якоря virtuoso: срез спереди → firstItemIndex += N)
  private typingUsers = new Map<string, number>(); // displayName -> expiry ts
  private lastTypingSent = 0;

  private analysers = new Map<string, { an: AnalyserNode; buf: Uint8Array; hold: number; src: MediaStreamAudioSourceNode }>();
  private spCtx: AudioContext | null = null;
  private spRAF: number | null = null;
  private spTick = 0;
  private speakingSet = new Set<string>();

  private keepCtx: AudioContext | null = null;
  private keepOsc: OscillatorNode | null = null;
  private screenStream: MediaStream | null = null;
  private presenceTimer: number | null = null;
  private serverId = ''; // текущий сервер (для api.streamStart → фоновый push о трансляции)

  VOLS = { users: {} as Record<string, number>, streams: {} as Record<string, number> };
  private perMute = new Set<string>();
  private onlineHint = new Set<string>();
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
        playSound('stream');
        this.hooks.toast(who + ' начал трансляцию', 'info');
        notify('stream', { title: who, body: 'начал(а) трансляцию', tag: 'stream-' + identity });
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
    this.snap = this.build();
  }

  setMe(me: User) { this.me = me; }
  setMembers(m: Member[]) { this.members = m; this.emit(); }
  setOnlineHint(ids: string[]) { this.onlineHint = new Set(ids); this.emit(); }
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
      if (vc) voiceChannels[m.username] = vc;
      const inV = !!vc || this.isInVoice(m.username);
      const mp = p ? p.getTrackPublication(Track.Source.Microphone) : undefined;
      // «оглох» (deafen) транслируется пирам participant-атрибутом deaf (как vc для голосового
      // канала) — иначе другие видят для оглохшего то же «мик выключен», что и для просто мута.
      const deaf = m.username === this.me.username ? this.deafened : !!(p as any)?.attributes?.deaf;
      // !mp (трек ещё не опубликован / не доехал) — это «пока не знаем», а не «замучен»: иначе
      // на секунду мигал бы ложный бейдж «мут» всем в канале. || deaf — оглохший всегда замьючен.
      presence[m.username] = { online, inVoice: inV, micMuted: (!!mp && mp.isMuted) || deaf, streaming: this.isStreaming(m.username), deafened: deaf };
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
      connected: !!this.room, roomReady: this.roomReady, reconnecting: this.reconnecting,
      voiceQuality: this.inVoice ? this.connQuality : 'unknown', voicePing: this.inVoice ? this.pingMs : null,
      inVoice: this.inVoice, voiceConnecting: this.inVoice && this.voiceConnecting, myVoiceChannel: this.currentVc, voiceChannels, deafened: this.deafened,
      localMicMuted: this.localMicMuted(), pttDown: this.pttDown,
      presence, speaking, streams, watching, pending, watchers, messages: this.messages, chatHasMore: this.chatMore, chatTrimmed: this.trimmedFront,
      typing: [...this.typingUsers].filter(([n, exp]) => exp > Date.now() && n !== this.me.displayName).map(([n]) => n),
    };
  }

  /* ---------- connection ---------- */
  async connect(url: string, token: string, serverId: string) {
    this.room = new Room({
      adaptiveStream: true, dynacast: true,
      publishDefaults: { dtx: true, red: true, simulcast: true, audioPreset: AudioPresets.musicHighQuality },
    });
    const r = this.room;
    this.serverId = serverId;
    this.liveKitT.attach(r, { me: this.me.username, serverId });
    this.treeT.attach(r, { me: this.me.username, serverId });
    r.on(RoomEvent.TrackSubscribed, this.onSub)
      .on(RoomEvent.TrackUnsubscribed, this.onUnsub)
      .on(RoomEvent.ParticipantConnected, (p) => { const u = baseUid(p.identity); if (u !== this.me.username && !this.hasOtherSession(u, p.identity)) this.hooks.toast((p.name || u) + ' в сети', 'ok'); this.hooks.peerJoined(u); this.emit(); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { const u = baseUid(p.identity); if (!this.hasOtherSession(u, p.identity)) this.cleanupPeer(u); this.emit(); })
      // звук мута слышен только самому мутящемуся (не остальным) — играем при локальном событии
      .on(RoomEvent.TrackMuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p === this.room?.localParticipant) playSound('mute'); this.emit(); })
      .on(RoomEvent.Reconnecting, () => { this.reconnecting = true; this.hooks.toast('Связь потеряна — переподключаюсь…', 'warn'); this.emit(); })
      .on(RoomEvent.Reconnected, () => {
        this.reconnecting = false;
        // после реконнекта заново заявляем голосовой канал (vc-атрибут мог потеряться) и чиним
        // подписки сразу, не дожидаясь периодического self-heal — иначе на пару секунд пропадёт звук/состав
        if (this.inVoice && this.currentVc) {
          this.room?.localParticipant.setAttributes({ vc: this.currentVc, deaf: this.deafened ? '1' : '' }).catch(() => {});
          this.reconcileAllAudio();
          // переотправляем vclaim (одна голосовая на аккаунт): пока мы лежали, другая сессия могла
          // зайти в голосовой и её vclaim до нас не дошёл — иначе обе сессии остались бы в войсе
          this.lastVclaim = Date.now();
          this.dataSend({ t: 'vclaim', uid: this.me.id, session: this.sessionId() });
        }
        // ре-энумерация чужих screenshare-публикаций: стрим, появившийся во время обрыва, иначе не
        // прошёл бы через onStreamStart (нет живого TrackPublished) — бейдж/«Смотреть» не появлялись
        this.liveKitT.onRoomConnected();
        this.hooks.refetchChat?.(); // догрузить сообщения, пришедшие во время обрыва
        this.hooks.toast('Связь восстановлена', 'ok'); this.emit();
      })
      .on(RoomEvent.Disconnected, () => { this.reconnecting = false; this.emit(); })
      .on(RoomEvent.TrackUnmuted, () => this.emit())
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (p === r.localParticipant) { this.connQuality = mapQuality(q); this.emit(); } })
      .on(RoomEvent.TrackPublished, this.onRemotePub)
      .on(RoomEvent.TrackUnpublished, this.onRemoteUnpub)
      // пир сменил голосовой канал (атрибут vc) → пере-подписаться/отписаться от его микрофона
      // (стримы server-wide и watch не трогаем — смотреть можно из любого канала)
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => { if (p !== r.localParticipant) this.reconcilePeerAudio(p as Participant); this.emit(); })
      .on(RoomEvent.DataReceived, this.onData);
    await r.connect(url, token, { autoSubscribe: false });
    this.roomReady = true; // комната реально поднялась — можно снимать скелетоны голосового/сцены
    r.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)));
    this.liveKitT.onRoomConnected();
    this.treeT.onRoomConnected();
    // periodic self-heal подписок на микрофоны: атрибут vc (голосовой канал) мог доехать без события
    // ParticipantAttributesChanged (гонка при быстрых прыжках между каналами / реконнекте) — тогда пир
    // виден в канале, но его не слышно. setSubscribed идемпотентен, поэтому реконсиляция дёшева и безопасна.
    this.presenceTimer = window.setInterval(() => { this.announceWatch(); this.cleanupWatchers(); if (this.inVoice) this.reconcileAllAudio(); }, 3000);
    this.emit();
  }

  disconnect() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
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
    // presence-хинты и typing принадлежат ПРЕДЫДУЩЕМУ серверу — иначе при свитче первый emit (по
    // setMembers нового сервера) рисует их онлайн/в чужом голосовом канале до прихода нового /presence
    this.onlineHint.clear(); this.voiceHint = {}; this.typingUsers.clear();
    if (this.micRaw) { this.micRaw.getTracks().forEach((t) => t.stop()); this.micRaw = null; }
    if (this.micActx) { try { this.micActx.close(); } catch { /**/ } this.micActx = null; }
    this.micGain = null;
    this.inVoice = false; this.roomReady = false; this.deafened = false; this.manualMute = false; this.screenStream = null;
    if (this.room) { try { this.room.disconnect(); } catch { /**/ } }
    this.room = null; this.emit();
  }

  /* ---------- presence helpers ---------- */
  // участник по БАЗОВОМУ username (identity = username#session). Несколько сессий одного юзера →
  // предпочитаем ту, что в голосовом (с mic-треком), иначе любую.
  private partOf(username: string): Participant | null {
    if (!this.room) return null;
    if (username === this.me.username) return this.room.localParticipant;
    let any: Participant | null = null;
    for (const p of this.room.remoteParticipants.values()) {
      if (baseUid(p.identity) !== username) continue;
      if (p.getTrackPublication(Track.Source.Microphone)) return p;
      any = p;
    }
    return any;
  }
  // id этой сессии = суффикс после # в моём LiveKit-identity (для tie-break гонки vclaim)
  private sessionId(): string { const id = this.room?.localParticipant.identity || ''; const i = id.indexOf('#'); return i < 0 ? id : id.slice(i + 1); }
  // есть ли у юзера ещё живые сессии, кроме указанной (для presence/cleanup при отключении одной)
  private hasOtherSession(username: string, exceptIdentity: string): boolean {
    if (!this.room) return false;
    for (const p of this.room.remoteParticipants.values()) {
      if (p.identity !== exceptIdentity && baseUid(p.identity) === username) return true;
    }
    return false;
  }
  private isInVoice(username: string): boolean {
    const p = this.partOf(username); if (!p) return false;
    if (p === this.room!.localParticipant) return this.inVoice;
    return !!p.getTrackPublication(Track.Source.Microphone);
  }
  // голосовой канал участника: для себя — currentVc, для пира — participant-атрибут vc
  private voiceChannelOf(username: string): string | null {
    if (username === this.me.username) return this.currentVc;
    const p = this.partOf(username);
    const vc = (p as any)?.attributes?.vc;
    return vc || null;
  }
  // подписка на микрофон пира только когда я в голосовом и мы в ОДНОМ канале (изоляция звука по каналам)
  private reconcilePeerAudio(p: Participant) {
    if (!this.room || p === this.room.localParticipant) return;
    if (baseUid(p.identity) === this.me.username) return; // своя же другая сессия — не подписываемся (эхо)
    const mp = p.getTrackPublication(Track.Source.Microphone);
    if (!mp) return;
    const want = this.inVoice && !!this.currentVc && (p as any).attributes?.vc === this.currentVc;
    try { (mp as any).setSubscribed(want); } catch { /**/ }
    if (!want) this.detachAnalyser(baseUid(p.identity));
  }
  private reconcileAllAudio() { this.room?.remoteParticipants.forEach((p) => this.reconcilePeerAudio(p)); }
  private isStreaming(username: string): boolean {
    if (username === this.me.username) return this.liveKitT.isBroadcasting(username) || this.treeT.isBroadcasting(username);
    return this.liveKitT.isRemoteBroadcasting(username) || this.treeT.isRemoteBroadcasting(username);
  }
  // Один стрим — один транспорт (не dual-publish): смотрим, откуда реально вещает
  // identity, дерево или LiveKit-комната, и подключаемся тем же транспортом.
  // Для уже открытого watch приоритет у пина (watchT) — объявление могло уже пропасть.
  private transportFor(identity: string): VideoTransport {
    return this.watchT.get(identity) ?? (this.treeT.isRemoteBroadcasting(identity) ? this.treeT : this.liveKitT);
  }
  private nameOf(identity: string): string { const p = this.partOf(identity); return (p && p.name) || identity; }
  private localMicMuted(): boolean { return this.manualMute; }
  private micPub() { return this.room && this.room.localParticipant.getTrackPublication(Track.Source.Microphone); }

  /* ---------- VOICE join/leave/switch (несколько каналов на сервер) ---------- */
  // подключиться к голосовому каналу channelId; если уже в другом — переключиться без переподнятия микрофона
  async joinVoice(channelId: string) {
    if (!this.room || !channelId) return;
    if (this.inVoice) { if (this.currentVc !== channelId) await this.switchVoice(channelId); return; }
    this.currentVc = channelId;
    this.inVoice = true; this.manualMute = false; this.pttDown = false;
    this.voiceConnecting = true;
    this.emit(); // ОПТИМИСТИЧНО: сразу рисуем себя в канале + статус «подключение» (mic ещё публикуется)
    try { await this.room.localParticipant.setAttributes({ vc: channelId }); } catch { /**/ }
    try { await this.startMic(); }
    catch {
      this.inVoice = false; this.currentVc = null; this.voiceConnecting = false;
      try { await this.room.localParticipant.setAttributes({ vc: '' }); } catch { /**/ }
      this.hooks.toast('Нет доступа к микрофону', 'err'); this.emit(); return;
    }
    this.reconcileAllAudio(); // подписываемся только на пиров этого же канала
    this.startConnPoll();
    this.lastVclaim = Date.now();
    this.dataSend({ t: 'vclaim', uid: this.me.id, session: this.sessionId() }); // забираем голос у своих других сессий (одна голосовая на аккаунт)
    this.voiceConnecting = false;
    this.emit();
  }
  // перейти в другой голосовой канал того же сервера: микрофон остаётся, меняются подписки и стримы
  async switchVoice(channelId: string) {
    if (!this.room || !this.inVoice || this.currentVc === channelId) return;
    this.currentVc = channelId;
    try { await this.room.localParticipant.setAttributes({ vc: channelId }); } catch { /**/ }
    this.reconcileAllAudio();
    playSound('join');
    this.emit();
  }
  async leaveVoice() {
    if (!this.room || !this.inVoice) return;
    // оптимистично: сразу убираем себя из канала (UI не ждёт async-очистку mic/треков)
    this.inVoice = false; this.currentVc = null; this.voiceConnecting = false; this.deafened = false; this.manualMute = false; this.pttDown = false;
    this.emit();
    this.stopConnPoll();
    await this.stopShare().catch(() => {});
    this.stopMic();
    this.room.remoteParticipants.forEach((p) => { const rp = p.getTrackPublication(Track.Source.Microphone); if (rp) { try { (rp as any).setSubscribed(false); } catch { /**/ } } this.detachAnalyser(baseUid(p.identity)); });
    try { await this.room.localParticipant.setAttributes({ vc: '', deaf: '' }); } catch { /**/ }
    this.screenAudioEls.forEach((a) => (a.muted = false));
    this.emit();
  }

  /* ---------- качество связи в голосовом (индикатор + пинг) ---------- */
  private startConnPoll() {
    if (this.connTimer) return;
    this.pollPing();
    this.connTimer = window.setInterval(() => this.pollPing(), 2500);
  }
  private stopConnPoll() {
    if (this.connTimer) { clearInterval(this.connTimer); this.connTimer = null; }
    this.pingMs = null; this.connQuality = 'unknown';
  }
  // RTT до сервера из WebRTC-статистики микрофонного трека (remote-inbound-rtp), фолбэк — candidate-pair
  private async pollPing() {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    try {
      const rep: RTCStatsReport = await (track as any).getRTCStatsReport();
      let rtt: number | null = null, cand: number | null = null;
      rep.forEach((s: any) => {
        if (s.type === 'remote-inbound-rtp' && s.roundTripTime != null) rtt = s.roundTripTime;
        if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && s.currentRoundTripTime != null) cand = s.currentRoundTripTime;
      });
      const v = rtt ?? cand;
      if (v != null) { this.pingMs = Math.round(v * 1000); this.emit(); }
    } catch { /**/ }
  }

  /* ---------- MIC / DEAFEN / PTT ---------- */
  // шумодав/эхо/автогромкость всегда включены (дефолт для всех)
  // deviceId через { exact } — иначе браузер игнорит выбор и берёт устройство по умолчанию
  private micCapture() { const s = getSettings(); return { deviceId: s.input ? { exact: s.input } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }; }

  // строим цепочку: устройство -> analyser(VAD) + gain -> published track
  private async startMic() {
    if (!this.room) return;
    this.micRaw = await navigator.mediaDevices.getUserMedia({ audio: this.micCapture() });
    this.micActx = new AudioContext();
    this.micActx.resume?.().catch(() => {});
    const src = this.micActx.createMediaStreamSource(this.micRaw);
    this.micGain = this.micActx.createGain();
    src.connect(this.micGain);
    const dest = this.micActx.createMediaStreamDestination();
    this.micGain.connect(dest);
    const lat = new LocalAudioTrack(dest.stream.getAudioTracks()[0]);
    await this.room.localParticipant.publishTrack(lat, { source: Track.Source.Microphone, dtx: true, red: true, audioPreset: AudioPresets.musicHighQuality });
    // индикатор «говорит» берём с сырого трека устройства
    this.attachAnalyser(this.me.username, this.micRaw.getAudioTracks()[0]);
    this.applyGate();
  }
  private stopMic() {
    const p = this.micPub();
    if (p && p.track) { try { this.room?.localParticipant.unpublishTrack(p.track, true); } catch { /**/ } }
    this.detachAnalyser(this.me.username);
    this.vadOpen = false;
    if (this.micRaw) { this.micRaw.getTracks().forEach((t) => t.stop()); this.micRaw = null; }
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
  private startLevelMeter() {
    navigator.mediaDevices.getUserMedia({ audio: this.micCapture() }).then((stream) => {
      if (this.levelListeners.size === 0 || this.inVoice) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.levelStream = stream;
      try {
        this.levelCtx = this.levelCtx || new AudioContext();
        this.levelCtx.resume?.().catch(() => {});
        this.levelSrc = this.levelCtx.createMediaStreamSource(stream);
        this.levelAnalyser = this.levelCtx.createAnalyser();
        this.levelAnalyser.fftSize = 512; this.levelAnalyser.smoothingTimeConstant = 0.5;
        this.levelBuf = new Uint8Array(this.levelAnalyser.fftSize);
        this.levelSrc.connect(this.levelAnalyser);
        this.levelRAF = requestAnimationFrame(this.levelLoop);
      } catch { /**/ }
    }).catch(() => this.hooks.toast('Нет доступа к микрофону', 'err'));
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
    this.levelAnalyser = null; this.levelBuf = null; this.levelHold = 0;
    if (this.levelStream) { this.levelStream.getTracks().forEach((t) => t.stop()); this.levelStream = null; }
    if (this.levelCtx) { try { this.levelCtx.close(); } catch { /**/ } this.levelCtx = null; }
  }
  async reapplyMic() {
    if (!this.room || !this.inVoice) { this.hooks.toast('Микрофон применится при подключении к голосовому'); return; }
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
    if (!this.inVoice || !this.room) return;
    this.manualMute = !this.manualMute;
    const p = this.micPub();
    // пока фулл-мут (deafened) активен, трек должен оставаться замьюченным на уровне LiveKit
    // независимо от ручного тогла — иначе снятие ручного мута во время deafen паразитно
    // размучивает трек (звук всё равно молчит через applyGate/gain=0, но у пиров и у себя
    // пропадает бейдж мута, будто фулл-мута больше нет).
    if (p && p.track) { (this.manualMute || this.deafened) ? p.track.mute() : p.track.unmute(); } // ручной мут виден другим
    this.applyGate();
    this.emit();
  }
  toggleDeaf() {
    if (!this.inVoice) return;
    this.deafened = !this.deafened;
    // транслируем пирам, чтобы у них статус-бейдж отличался от простого мута мика (см. build())
    this.room?.localParticipant.setAttributes({ deaf: this.deafened ? '1' : '' }).catch(() => {});
    const p = this.micPub();
    if (this.deafened) { if (p && p.track) p.track.mute(); }
    else { if (p && p.track && !this.manualMute) p.track.unmute(); this.reconcileAllAudio(); } // undeafen: поднять пиров, чья подписка отвалилась в окне deafen
    this.applyGate();
    this.screenAudioEls.forEach((a) => (a.muted = this.deafened));
    this.applyAllVolumes();
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
      // подписываемся на микрофон только если я в голосовом и пир в ТОМ ЖЕ канале
      if (!own && this.inVoice && !!this.currentVc && (p as any).attributes?.vc === this.currentVc) {
        try { (pub as any).setSubscribed(true); } catch { /**/ }
        if (!silent) playSound('join');
      }
      this.emit();
    }
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant) => {
    if (pub.source === Track.Source.Microphone && this.inVoice && baseUid(p.identity) !== this.me.username) playSound('leave'); // вышел из голосового
    this.emit();
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    if (track.kind === Track.Kind.Audio) {
      const a = track.attach(); a.autoplay = true; document.getElementById('audioSink')?.appendChild(a);
      const out = getSettings().output; if ((a as any).setSinkId && out) (a as any).setSinkId(out).catch(() => {});
      const u = baseUid(p.identity);
      if (pub.source === Track.Source.ScreenShareAudio) { this.screenAudioEls.set(u, a); a.muted = this.deafened; a.volume = this.streamVolOf(u); }
      else { this.applyVolumeToParticipant(p); this.attachAnalyser(u, (track as any).mediaStreamTrack); }
    }
    this.emit();
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    track.detach().forEach((el) => el.remove());
    const u = baseUid(p.identity);
    if (pub.source === Track.Source.ScreenShareAudio) this.screenAudioEls.delete(u);
    if (pub.source === Track.Source.Microphone) this.detachAnalyser(u);
    this.emit();
  };

  /* ---------- streams (thin facades over VideoTransport) ---------- */
  getVideoTrack(key: string) { return this.liveKitT.getVideoTrack(key) ?? this.treeT.getVideoTrack(key); }

  watch(identity: string) {
    // no `this.room` participant guard here: a tree broadcaster (Э2) is a native peer,
    // not a LiveKit room participant (voice and video are separate transports now) —
    // existence is the VideoTransport's job (it no-ops safely on an unknown identity).
    this.watching.add(identity); this.pendingWatch.add(identity);
    const t = this.transportFor(identity);
    this.watchT.set(identity, t); // пин: unwatch/статы пойдут в тот же транспорт, даже если объявление пропадёт
    t.watch(identity);
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
    playSound('stream');
    if (this.serverId) api.streamStart(this.serverId).catch(() => {}); // фоновый push участникам не в комнате
    this.emit();
  }
  async stopShare() {
    if (!this.room) return;
    await this.liveKitT.stopBroadcast(this.me.username);
    if (this.screenStream) { this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null; }
    this.keepAliveOff();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
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

  /* ---------- emotes (spray) ---------- */
  onEmote(cb: EmoteListener) { this.emoteListeners.add(cb); return () => { this.emoteListeners.delete(cb); }; }
  fling(streamerId: string, emote: Emote, size?: string) {
    const x = Math.random();
    this.emoteListeners.forEach((f) => f(streamerId, emote.id, this.me.displayName, x, size));
    this.dataSend({ t: 'emote', s: streamerId, e: emote.id, by: this.me.displayName, x, sz: size });
  }

  /* ---------- watchers presence ---------- */
  private announceWatch() {
    if (!this.room) return;
    const id = this.me.username;
    this.watching.forEach((sid) => {
      const m = this.wset(sid); m.set(id, { name: this.me.displayName, color: this.me.avatarColor, avatarUrl: this.me.avatarUrl, ts: Date.now() });
      this.dataSend({ t: 'watch', s: sid, id, n: this.me.displayName, c: this.me.avatarColor, a: this.me.avatarUrl, on: true });
    });
    this.emit();
  }
  private wset(sid: string) { let m = this.streamWatchers.get(sid); if (!m) { m = new Map(); this.streamWatchers.set(sid, m); } return m; }
  private cleanupWatchers() { const now = Date.now(); let ch = false; this.streamWatchers.forEach((m) => m.forEach((v, wid) => { if (now - v.ts > 9000) { m.delete(wid); ch = true; } })); if (ch) this.emit(); }
  private cleanupPeer(id: string) { this.streamWatchers.delete(id); this.streamWatchers.forEach((m) => m.delete(id)); this.detachAnalyser(id); this.watching.delete(id); this.pendingWatch.delete(id); this.watchT.delete(id); }

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
    if (!p || p === this.room?.localParticipant || !(p as any).setVolume) return;
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
  private applyAllVolumes() { this.room?.remoteParticipants.forEach((p) => this.applyVolumeToParticipant(p)); }
  async applyOutput() { if (!this.room) return; const out = getSettings().output; try { await this.room.switchActiveDevice('audiooutput', out || 'default'); } catch { /**/ } document.querySelectorAll('#audioSink audio').forEach((a) => { if ((a as any).setSinkId && out) (a as any).setSinkId(out).catch(() => {}); }); }

  /* ---------- chat ---------- */
  // упоминание меня: @username / @displayName / @everyone|@all|@все
  textMentionsMe(text: string): boolean {
    if (!text) return false;
    if (/@(everyone|all|все)\b/i.test(text)) return true;
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
  private pushMsg(who: string | null, text: string, sys: boolean, color?: number, mineOverride?: boolean, img?: string, ts?: number, uid?: string, reply?: ReplyRef): number {
    const mine = mineOverride !== undefined ? mineOverride : (!sys && who === this.me.displayName);
    const mention = !sys && !mine && (this.textMentionsMe(text) || this.replyToMe(reply));
    const id = msgSeq++;
    const next = [...this.messages, { id, uid, who, text, mine, sys, color, img, ts: ts ?? Date.now(), mention, reply }];
    // кап на память сессии; срез идёт с НАЧАЛА, поэтому копим trimmedFront — компонент на столько же
    // поднимет firstItemIndex virtuoso, иначе якорь скролла рассинхронится и контент прыгнет.
    const CAP = 1000;
    if (next.length > CAP) { this.trimmedFront += next.length - CAP; this.messages = next.slice(next.length - CAP); }
    else this.messages = next;
    this.emit();
    return id;
  }
  // статус отправки моего сообщения (для «не отправлено · повторить»)
  private pendingSend = new Map<number, { text: string; em: Record<string, string>; img?: string; reply?: ReplyRef; key: string }>();
  private setMsgStatus(localId: number, status: 'failed' | undefined) {
    let changed = false;
    this.messages = this.messages.map((m) => (m.id === localId && m.status !== status ? (changed = true, { ...m, status }) : m));
    if (changed) this.emit();
  }
  markSendResult(localId: number, ok: boolean) {
    if (ok) { this.pendingSend.delete(localId); this.setMsgStatus(localId, undefined); }
    else this.setMsgStatus(localId, 'failed');
  }
  retrySend(localId: number) {
    const p = this.pendingSend.get(localId); if (!p) return;
    this.setMsgStatus(localId, undefined);
    // только повторный persist (без ре-broadcast): если первый dataSend прошёл, у живых
    // сообщение уже есть — повтор рассылки дал бы дубль. Упал именно POST в БД. Тот же key —
    // если первый POST на самом деле дошёл (потерян лишь ответ), сервер проигнорит дубль.
    this.hooks.persistMessage(p.text, p.em, p.img, p.reply, localId, p.key);
  }
  sysMsg(text: string) { this.pushMsg(null, text, true); }
  private mapHistory(list: HistoryMessage[]): ChatMessage[] {
    return list.map((m) => {
      if (m.em) for (const k in m.em) this.onEmoteResolve?.(k, m.em[k]);
      return { id: msgSeq++, sid: m.id, uid: m.uid, who: m.name, text: m.text, mine: m.uid === this.me.id, sys: false, color: m.color, img: m.img, ts: m.ts, mention: m.uid !== this.me.id && (this.textMentionsMe(m.text) || this.replyToMe(m.reply)), reply: m.reply };
    });
  }
  // начальная страница истории (последние N) — заменяет весь чат, ставит курсор на самое старое
  loadHistory(list: HistoryMessage[], hasMore = false) {
    this.messages = this.mapHistory(list);
    this.chatMore = hasMore;
    this.oldestSid = list.length ? (list[0].id ?? null) : null; // list в ASC-порядке, [0] — самое старое
    this.trimmedFront = 0; // новая история — счётчик среза сбрасывается (компонент тоже обнулит prevTrim)
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
    const sig = (uid?: string, text?: string, img?: string) => `${uid || ''}${text || ''}${img || ''}`;
    const liveBySig = new Map<string, ChatMessage[]>();
    for (const m of this.messages) {
      if (m.sid == null && !m.sys && m.uid) { const k = sig(m.uid, m.text, m.img); (liveBySig.get(k) || liveBySig.set(k, []).get(k)!).push(m); }
    }
    const add: HistoryMessage[] = [];
    for (const m of list) {
      if (m.id == null || haveSids.has(m.id)) continue;
      // Свои сообщения НЕ пропускаем безусловно: при мультисессии своё сообщение с другого
      // устройства могло не дойти по data-каналу (обрыв) → его надо догрузить. Дубля не будет —
      // оптимистичная копия лежит в liveBySig и усыновит sid; реально пропущенное попадёт в add.
      const bucket = liveBySig.get(sig(m.uid, m.text, m.img));
      if (bucket && bucket.length) { bucket.shift()!.sid = m.id; continue; } // усыновили sid, не дублируем
      add.push(m);
    }
    if (!add.length) return;
    const mapped = this.mapHistory(add);
    this.messages = [...this.messages, ...mapped];
    const mentioned = mapped.filter((m) => m.mention); // один звук, а не по сообщению (не спамим при длинном обрыве)
    if (mentioned.length) {
      playSound('mention');
      this.hooks.toast(mentioned.length === 1 ? `${mentioned[0].who} упомянул тебя` : `Тебя упомянули · ${mentioned.length}`, 'info');
      notify('mention', { title: mentioned.length === 1 ? String(mentioned[0].who) : 'Упоминания', body: mentioned.length === 1 ? String(mentioned[0].text || '').slice(0, 140) : `Тебя упомянули · ${mentioned.length}`, tag: 'mention' });
    }
    else playSound('msg');
    this.emit();
  }
  // догрузка более старых сообщений при скролле вверх — prepend в начало, курсор сдвигается назад
  prependHistory(list: HistoryMessage[], hasMore: boolean) {
    this.chatMore = hasMore;
    if (list.length) {
      this.messages = [...this.mapHistory(list), ...this.messages];
      this.oldestSid = list[0].id ?? this.oldestSid;
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
  sendChatWithEmotes(text: string, em: Record<string, string>, img?: string, reply?: ReplyRef) {
    if (!text.trim() && !img) return;
    const t = text.trim();
    // realtime-раздача только при поднятой комнате; локальный эхо + persist работают и без неё —
    // в окне фоновой докрутки connect (сразу после входа в сервер) сообщение не теряется, ложится в БД.
    if (this.room) this.dataSend({ t: 'chat', name: this.me.displayName, text: t, em, color: this.me.avatarColor, img, uid: this.me.id, reply });
    const id = this.pushMsg(this.me.displayName, t, false, this.me.avatarColor, true, img, undefined, this.me.id, reply);
    const key = newClientKey();
    this.pendingSend.set(id, { text: t, em, img, reply, key });
    this.hooks.persistMessage(t, em, img, reply, id, key);
  }
  sendTyping() {
    if (!this.room) return;
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
  private onData = (payload: Uint8Array) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(payload));
      if (d.t === 'chat') {
        if (d.em) for (const k in d.em) this.onEmoteResolve?.(k, d.em[k]);
        this.typingUsers.delete(d.name);
        const own = d.uid === this.me.id; // моё же сообщение с другой сессии — показываем как своё, без звука/меншена
        const repliedToMe = !own && this.replyToMe(d.reply);
        const mentioned = !own && (this.textMentionsMe(d.text) || repliedToMe);
        this.pushMsg(d.name, d.text, false, d.color, own, d.img, undefined, d.uid, d.reply);
        if (!own) {
          playSound(mentioned ? 'mention' : 'msg');
          if (mentioned) {
            this.hooks.toast(repliedToMe ? `${d.name} ответил тебе` : `${d.name} упомянул тебя`, 'info');
            notify('mention', { title: d.name, body: String(d.text || '').slice(0, 140) || '🖼 изображение', tag: 'mention' });
          }
        }
      }
      else if (d.t === 'vclaim') {
        // другая моя сессия зашла в голосовой → выхожу (одна голосовая на аккаунт).
        // tie-break: если это ГОНКА (я тоже только что заявил голос) — уступает сессия с меньшим
        // session-id; вне гонки (я просто сидел в голосовом) новый девайс всегда побеждает.
        if (d.uid === this.me.id && this.inVoice) {
          const race = Date.now() - this.lastVclaim < 800;
          if (!race || String(d.session || '') > this.sessionId()) this.leaveVoice();
        }
      }
      else if (d.t === 'clear') { this.messages = []; this.emit(); this.sysMsg((d.by || 'Админ') + ' очистил чат'); }
      else if (d.t === 'emote') this.emoteListeners.forEach((f) => f(d.s, d.e, d.by, d.x, d.sz));
      else if (d.t === 'watch') { const m = this.wset(d.s); if (d.on) m.set(d.id, { name: d.n, color: d.c ?? 0, avatarUrl: d.a, ts: Date.now() }); else m.delete(d.id); this.emit(); }
      else if (d.t === 'typing') { if (d.name && d.name !== this.me.displayName) { this.typingUsers.set(d.name, Date.now() + 3500); this.emit(); setTimeout(() => this.pruneTyping(), 3600); } }
    } catch { /**/ }
  };
  onEmoteResolve: ((name: string, id: string) => void) | null = null;
  // reliable для состояния, которое нельзя терять: чат (сообщения), vclaim (одна голосовая на
  // аккаунт — потеря датаграммы оставила бы две сессии в войсе), clear (чистка чата).
  private dataSend(obj: any) { if (!this.room) return; try { this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: obj.t === 'chat' || obj.t === 'vclaim' || obj.t === 'clear' }); } catch { /**/ } }

  emoteImg(id: string) { return emoteUrl(id); }
}

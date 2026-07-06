import {
  Room, RoomEvent, Track, LocalAudioTrack, AudioPresets,
  type RemoteParticipant, type Participant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { User, Member, ChatMessage, Emote, HistoryMessage } from './types';
import { getSettings, setSettings } from './settings';
import { emoteUrl } from './emotes';
import { playSound } from './sounds';
import type { VideoTransport } from './transport/videoTransport';
import { LiveKitVideoTransport } from './transport/livekitVideo';
import { TreeVideoTransport } from './transport/treeVideo';

export interface PeerState { online: boolean; inVoice: boolean; micMuted: boolean; streaming: boolean }
export interface StreamInfo { key: string; identity: string; isLocal: boolean }
export interface Snapshot {
  connected: boolean;
  reconnecting: boolean;
  inVoice: boolean;
  deafened: boolean;
  localMicMuted: boolean;
  pttDown: boolean;
  presence: Record<string, PeerState>;
  speaking: Record<string, boolean>;
  streams: StreamInfo[];
  watching: Record<string, true>;
  pending: Record<string, true>;
  watchers: Record<string, { name: string }[]>;
  messages: ChatMessage[];
  chatHasMore: boolean; // есть ли ещё более старые сообщения для догрузки вверх
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
  persistMessage: (text: string, em: Record<string, string>, image?: string) => void;
}

let msgSeq = 1;

export class Engine {
  private room: Room | null = null;
  private me: User;
  private members: Member[] = [];
  private hooks: EngineHooks;

  inVoice = false;
  private reconnecting = false;
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
  private pendingWatch = new Set<string>();
  private streamWatchers = new Map<string, Map<string, { name: string; ts: number }>>();
  private messages: ChatMessage[] = [];
  private chatMore = false; // есть ли ещё более старые сообщения на сервере (пагинация вверх)
  private oldestSid: number | null = null; // DB-id самого старого загруженного сообщения = курсор для before
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

  VOLS = { users: {} as Record<string, number>, streams: {} as Record<string, number> };
  private perMute = new Set<string>();
  private onlineHint = new Set<string>();

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
        this.sysMsg(`📺 ${this.nameOf(identity)} начал трансляцию — «▶ Смотреть» в списке`);
        playSound('stream');
        this.hooks.toast(this.nameOf(identity) + ' начал трансляцию', 'info');
      }
    };
    const onStreamStop = (identity: string) => {
      // Разрываем watch явно (idempotent, no-op если уже не смотрели) — иначе
      // при обрыве вещателя <video> остаётся с последним кадром/чёрным экраном
      // навсегда: без unwatch() PeerConnection и трек никто не закрывает.
      this.transportFor(identity).unwatch(identity);
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
    for (const m of this.members) {
      const p = this.partOf(m.username);
      const online = !!p || this.onlineHint.has(m.username);
      const inV = this.isInVoice(m.username);
      const mp = p ? p.getTrackPublication(Track.Source.Microphone) : undefined;
      presence[m.username] = { online, inVoice: inV, micMuted: !mp || mp.isMuted, streaming: this.isStreaming(m.username) };
    }
    const speaking: Record<string, boolean> = {};
    this.speakingSet.forEach((u) => (speaking[u] = true));
    const streams: StreamInfo[] = [...this.liveKitT.getStreams(), ...this.treeT.getStreams()];
    const watching: Record<string, true> = {}; this.watching.forEach((u) => (watching[u] = true));
    const pending: Record<string, true> = {}; this.pendingWatch.forEach((u) => (pending[u] = true));
    const watchers: Record<string, { name: string }[]> = {};
    this.streamWatchers.forEach((m, sid) => (watchers[sid] = [...m.values()].map((v) => ({ name: v.name }))));
    return {
      connected: !!this.room, reconnecting: this.reconnecting, inVoice: this.inVoice, deafened: this.deafened,
      localMicMuted: this.localMicMuted(), pttDown: this.pttDown,
      presence, speaking, streams, watching, pending, watchers, messages: this.messages, chatHasMore: this.chatMore,
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
    this.liveKitT.attach(r, { me: this.me.username, serverId });
    this.treeT.attach(r, { me: this.me.username, serverId });
    r.on(RoomEvent.TrackSubscribed, this.onSub)
      .on(RoomEvent.TrackUnsubscribed, this.onUnsub)
      .on(RoomEvent.ParticipantConnected, (p) => { this.hooks.peerJoined(p.identity); this.hooks.toast((p.name || p.identity) + ' в сети', 'ok'); this.emit(); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { this.cleanupPeer(p.identity); this.emit(); })
      .on(RoomEvent.TrackMuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p !== this.room?.localParticipant) playSound('mute'); this.emit(); })
      .on(RoomEvent.Reconnecting, () => { this.reconnecting = true; this.hooks.toast('Связь потеряна — переподключаюсь…', 'warn'); this.emit(); })
      .on(RoomEvent.Reconnected, () => { this.reconnecting = false; this.hooks.toast('Связь восстановлена', 'ok'); this.emit(); })
      .on(RoomEvent.Disconnected, () => { this.reconnecting = false; this.emit(); })
      .on(RoomEvent.TrackUnmuted, () => this.emit())
      .on(RoomEvent.TrackPublished, this.onRemotePub)
      .on(RoomEvent.TrackUnpublished, this.onRemoteUnpub)
      .on(RoomEvent.DataReceived, this.onData);
    await r.connect(url, token, { autoSubscribe: false });
    r.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)));
    this.liveKitT.onRoomConnected();
    this.treeT.onRoomConnected();
    this.presenceTimer = window.setInterval(() => { this.announceWatch(); this.cleanupWatchers(); }, 3000);
    this.emit();
  }

  disconnect() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.analysers.forEach((o) => { try { o.src.disconnect(); } catch { /**/ } });
    this.analysers.clear(); this.speakingSet.clear();
    if (this.spRAF) cancelAnimationFrame(this.spRAF); this.spRAF = null;
    this.vadOpen = false;
    this.stopLevelMeter();
    this.keepAliveOff();
    document.querySelectorAll('#audioSink audio').forEach((a) => a.remove());
    this.liveKitT.detach(); this.treeT.detach(); this.screenAudioEls.clear();
    this.watching.clear(); this.pendingWatch.clear(); this.streamWatchers.clear();
    this.perMute.clear(); this.messages = []; this.chatMore = false; this.oldestSid = null;
    if (this.micRaw) { this.micRaw.getTracks().forEach((t) => t.stop()); this.micRaw = null; }
    if (this.micActx) { try { this.micActx.close(); } catch { /**/ } this.micActx = null; }
    this.micGain = null;
    this.inVoice = false; this.deafened = false; this.manualMute = false; this.screenStream = null;
    if (this.room) { try { this.room.disconnect(); } catch { /**/ } }
    this.room = null; this.emit();
  }

  /* ---------- presence helpers ---------- */
  private partOf(username: string): Participant | null {
    if (!this.room) return null;
    if (username === this.me.username) return this.room.localParticipant;
    return this.room.remoteParticipants.get(username) || null;
  }
  private isInVoice(username: string): boolean {
    const p = this.partOf(username); if (!p) return false;
    if (p === this.room!.localParticipant) return this.inVoice;
    return !!p.getTrackPublication(Track.Source.Microphone);
  }
  private isStreaming(username: string): boolean {
    if (username === this.me.username) return this.liveKitT.isBroadcasting(username) || this.treeT.isBroadcasting(username);
    return this.liveKitT.isRemoteBroadcasting(username) || this.treeT.isRemoteBroadcasting(username);
  }
  // Один стрим — один транспорт (не dual-publish): смотрим, откуда реально вещает
  // identity, дерево или LiveKit-комната, и подключаемся тем же транспортом.
  private transportFor(identity: string): VideoTransport {
    return this.treeT.isRemoteBroadcasting(identity) ? this.treeT : this.liveKitT;
  }
  private nameOf(identity: string): string { const p = this.partOf(identity); return (p && p.name) || identity; }
  private localMicMuted(): boolean { return this.manualMute; }
  private micPub() { return this.room && this.room.localParticipant.getTrackPublication(Track.Source.Microphone); }

  /* ---------- VOICE join/leave ---------- */
  async joinVoice() {
    if (!this.room || this.inVoice) return;
    this.inVoice = true; this.manualMute = false; this.pttDown = false;
    try { await this.startMic(); }
    catch { this.inVoice = false; this.hooks.toast('Нет доступа к микрофону', 'err'); this.emit(); return; }
    this.room.remoteParticipants.forEach((p) => { const mp = p.getTrackPublication(Track.Source.Microphone); if (mp) { try { (mp as any).setSubscribed(true); } catch { /**/ } } });
    this.emit();
  }
  async leaveVoice() {
    if (!this.room || !this.inVoice) return;
    await this.stopShare().catch(() => {});
    this.stopMic();
    this.room.remoteParticipants.forEach((p) => { const rp = p.getTrackPublication(Track.Source.Microphone); if (rp) { try { (rp as any).setSubscribed(false); } catch { /**/ } } this.detachAnalyser(p.identity); });
    this.inVoice = false; this.deafened = false; this.manualMute = false; this.pttDown = false;
    this.screenAudioEls.forEach((a) => (a.muted = false));
    this.emit();
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
    if (p && p.track) { this.manualMute ? p.track.mute() : p.track.unmute(); } // ручной мут виден другим
    this.applyGate();
    this.emit();
  }
  toggleDeaf() {
    if (!this.inVoice) return;
    this.deafened = !this.deafened;
    const p = this.micPub();
    if (this.deafened) { if (p && p.track) p.track.mute(); }
    else { if (p && p.track && !this.manualMute) p.track.unmute(); }
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
  private onRemotePub = (pub: TrackPublication, _p: RemoteParticipant, silent?: boolean) => {
    if (pub.source === Track.Source.Microphone) { if (this.inVoice) { try { (pub as any).setSubscribed(true); } catch { /**/ } if (!silent) playSound('join'); } this.emit(); }
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant) => {
    if (pub.source === Track.Source.Microphone && this.inVoice) playSound('leave'); // вышел из голосового
    this.emit();
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    if (track.kind === Track.Kind.Audio) {
      const a = track.attach(); a.autoplay = true; document.getElementById('audioSink')?.appendChild(a);
      const out = getSettings().output; if ((a as any).setSinkId && out) (a as any).setSinkId(out).catch(() => {});
      if (pub.source === Track.Source.ScreenShareAudio) { this.screenAudioEls.set(p.identity, a); a.muted = this.deafened; a.volume = this.streamVolOf(p.identity); }
      else { this.applyVolumeByName(p.identity); this.attachAnalyser(p.identity, (track as any).mediaStreamTrack); }
    }
    this.emit();
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    track.detach().forEach((el) => el.remove());
    if (pub.source === Track.Source.ScreenShareAudio) this.screenAudioEls.delete(p.identity);
    if (pub.source === Track.Source.Microphone) this.detachAnalyser(p.identity);
    this.emit();
  };

  /* ---------- streams (thin facades over VideoTransport) ---------- */
  getVideoTrack(key: string) { return this.liveKitT.getVideoTrack(key) ?? this.treeT.getVideoTrack(key); }

  watch(identity: string) {
    // no `this.room` participant guard here: a tree broadcaster (Э2) is a native peer,
    // not a LiveKit room participant (voice and video are separate transports now) —
    // existence is the VideoTransport's job (it no-ops safely on an unknown identity).
    this.watching.add(identity); this.pendingWatch.add(identity);
    this.transportFor(identity).watch(identity);
    if (!localStorage.getItem('sprayTip')) { localStorage.setItem('sprayTip', '1'); this.hooks.toast('Кинь эмоут зрителям — 😃 в углу трансляции', 'info'); }
    this.emit();
    const timer = window.setTimeout(() => {
      this.watchTimers.delete(identity);
      if (this.pendingWatch.has(identity)) {
        this.pendingWatch.delete(identity); this.watching.delete(identity);
        this.transportFor(identity).unwatch(identity);
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
      const m = this.wset(sid); m.set(id, { name: this.me.displayName, ts: Date.now() });
      this.dataSend({ t: 'watch', s: sid, id, n: this.me.displayName, on: true });
    });
    this.emit();
  }
  private wset(sid: string) { let m = this.streamWatchers.get(sid); if (!m) { m = new Map(); this.streamWatchers.set(sid, m); } return m; }
  private cleanupWatchers() { const now = Date.now(); let ch = false; this.streamWatchers.forEach((m) => m.forEach((v, wid) => { if (now - v.ts > 9000) { m.delete(wid); ch = true; } })); if (ch) this.emit(); }
  private cleanupPeer(id: string) { this.streamWatchers.delete(id); this.streamWatchers.forEach((m) => m.delete(id)); this.detachAnalyser(id); this.watching.delete(id); this.pendingWatch.delete(id); }

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
    const base = this.userVolOf(username);
    const v = (this.deafened || this.perMute.has(username)) ? 0 : (getSettings().master / 100) * base;
    try { (p as any).setVolume(v); } catch { /**/ }
  }
  private applyAllVolumes() { this.room?.remoteParticipants.forEach((p) => this.applyVolumeByName(p.identity)); }
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
    return !!d && low.includes('@' + d);
  }
  private pushMsg(who: string | null, text: string, sys: boolean, color?: number, mineOverride?: boolean, img?: string, ts?: number) {
    const mine = mineOverride !== undefined ? mineOverride : (!sys && who === this.me.displayName);
    const mention = !sys && !mine && this.textMentionsMe(text);
    this.messages = [...this.messages, { id: msgSeq++, who, text, mine, sys, color, img, ts: ts ?? Date.now(), mention }].slice(-500);
    this.emit();
  }
  sysMsg(text: string) { this.pushMsg(null, text, true); }
  private mapHistory(list: HistoryMessage[]): ChatMessage[] {
    return list.map((m) => {
      if (m.em) for (const k in m.em) this.onEmoteResolve?.(k, m.em[k]);
      return { id: msgSeq++, sid: m.id, who: m.name, text: m.text, mine: m.uid === this.me.id, sys: false, color: m.color, img: m.img, ts: m.ts, mention: m.uid !== this.me.id && this.textMentionsMe(m.text) };
    });
  }
  // начальная страница истории (последние N) — заменяет весь чат, ставит курсор на самое старое
  loadHistory(list: HistoryMessage[], hasMore = false) {
    this.messages = this.mapHistory(list);
    this.chatMore = hasMore;
    this.oldestSid = list.length ? (list[0].id ?? null) : null; // list в ASC-порядке, [0] — самое старое
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
  sendChatWithEmotes(text: string, em: Record<string, string>, img?: string) {
    if (!text.trim() && !img) return;
    const t = text.trim();
    // realtime-раздача только при поднятой комнате; локальный эхо + persist работают и без неё —
    // в окне фоновой докрутки connect (сразу после входа в сервер) сообщение не теряется, ложится в БД.
    if (this.room) this.dataSend({ t: 'chat', name: this.me.displayName, text: t, em, color: this.me.avatarColor, img });
    this.pushMsg(this.me.displayName, t, false, this.me.avatarColor, true, img);
    this.hooks.persistMessage(t, em, img);
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
      if (d.t === 'chat') { if (d.em) for (const k in d.em) this.onEmoteResolve?.(k, d.em[k]); this.typingUsers.delete(d.name); const mentioned = this.textMentionsMe(d.text); this.pushMsg(d.name, d.text, false, d.color, false, d.img); playSound(mentioned ? 'mention' : 'msg'); if (mentioned) this.hooks.toast(`${d.name} упомянул тебя`, 'info'); }
      else if (d.t === 'clear') { this.messages = []; this.emit(); this.sysMsg((d.by || 'Админ') + ' очистил чат'); }
      else if (d.t === 'emote') this.emoteListeners.forEach((f) => f(d.s, d.e, d.by, d.x, d.sz));
      else if (d.t === 'watch') { const m = this.wset(d.s); if (d.on) m.set(d.id, { name: d.n, ts: Date.now() }); else m.delete(d.id); this.emit(); }
      else if (d.t === 'typing') { if (d.name && d.name !== this.me.displayName) { this.typingUsers.set(d.name, Date.now() + 3500); this.emit(); setTimeout(() => this.pruneTyping(), 3600); } }
    } catch { /**/ }
  };
  onEmoteResolve: ((name: string, id: string) => void) | null = null;
  private dataSend(obj: any) { if (!this.room) return; try { this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: obj.t === 'chat' }); } catch { /**/ } }

  emoteImg(id: string) { return emoteUrl(id); }
}

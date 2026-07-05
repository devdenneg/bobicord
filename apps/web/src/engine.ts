import {
  Room, RoomEvent, Track, LocalAudioTrack, AudioPresets,
  type RemoteParticipant, type Participant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { User, Member, ChatMessage, Emote } from './types';
import { getSettings, setSettings } from './settings';
import { emoteUrl } from './emotes';
import { playSound } from './sounds';
import type { VideoTransport } from './transport/videoTransport';
import { LiveKitVideoTransport } from './transport/livekitVideo';
import { TreeVideoTransport } from './transport/treeVideo';

function makeVideoTransport(): VideoTransport {
  return import.meta.env.VITE_VIDEO_TRANSPORT === 'tree' ? new TreeVideoTransport() : new LiveKitVideoTransport();
}

export interface PeerState { online: boolean; inVoice: boolean; micMuted: boolean; streaming: boolean }
export interface StreamInfo { key: string; identity: string; isLocal: boolean }
export interface Snapshot {
  connected: boolean;
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
  typing: string[];
}

type EmoteListener = (streamerId: string, emoteId: string, by: string, x: number) => void;

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
  private deafened = false;
  private pttDown = false;

  // mic pipeline: raw device -> gain (громкость/мут) -> published track
  private micRaw: MediaStream | null = null;
  private micActx: AudioContext | null = null;
  private micGain: GainNode | null = null;
  private manualMute = false;

  private videoT: VideoTransport = makeVideoTransport();
  private screenAudioEls = new Map<string, HTMLMediaElement>();
  private watching = new Set<string>();
  private pendingWatch = new Set<string>();
  private streamWatchers = new Map<string, Map<string, { name: string; ts: number }>>();
  private messages: ChatMessage[] = [];
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

  constructor(me: User, hooks: EngineHooks) {
    this.me = me;
    this.hooks = hooks;
    this.videoT.onVideoTrack((_key, _track, identity, isLocal) => {
      if (!isLocal) this.pendingWatch.delete(identity);
      this.emit();
    });
    this.videoT.onVideoTrackRemoved(() => this.emit());
    this.videoT.onStreamStart((identity, silent) => {
      this.emit();
      if (!silent) {
        this.sysMsg(`📺 ${this.nameOf(identity)} начал трансляцию — «▶ Смотреть» в списке`);
        playSound('stream');
        this.hooks.toast(this.nameOf(identity) + ' начал трансляцию', 'info');
      }
    });
    this.videoT.onStreamStop((identity) => {
      // Разрываем watch явно (idempotent, no-op если уже не смотрели) — иначе
      // при обрыве вещателя <video> остаётся с последним кадром/чёрным экраном
      // навсегда: без unwatch() PeerConnection и трек никто не закрывает.
      this.videoT.unwatch(identity);
      this.watching.delete(identity); this.pendingWatch.delete(identity);
      this.sysMsg(`${this.nameOf(identity)} закончил трансляцию`);
      this.emit();
    });
    this.snap = this.build();
  }

  setMe(me: User) { this.me = me; }
  setMembers(m: Member[]) { this.members = m; this.emit(); }
  setOnlineHint(ids: string[]) { this.onlineHint = new Set(ids); this.emit(); }
  setVols(v: { users?: Record<string, number>; streams?: Record<string, number> }) {
    this.VOLS.users = v.users || {}; this.VOLS.streams = v.streams || {};
  }

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
    const streams: StreamInfo[] = this.videoT.getStreams();
    const watching: Record<string, true> = {}; this.watching.forEach((u) => (watching[u] = true));
    const pending: Record<string, true> = {}; this.pendingWatch.forEach((u) => (pending[u] = true));
    const watchers: Record<string, { name: string }[]> = {};
    this.streamWatchers.forEach((m, sid) => (watchers[sid] = [...m.values()].map((v) => ({ name: v.name }))));
    return {
      connected: !!this.room, inVoice: this.inVoice, deafened: this.deafened,
      localMicMuted: this.localMicMuted(), pttDown: this.pttDown,
      presence, speaking, streams, watching, pending, watchers, messages: this.messages,
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
    this.videoT.attach(r, { me: this.me.username, serverId });
    r.on(RoomEvent.TrackSubscribed, this.onSub)
      .on(RoomEvent.TrackUnsubscribed, this.onUnsub)
      .on(RoomEvent.ParticipantConnected, (p) => { this.hooks.peerJoined(p.identity); this.hooks.toast((p.name || p.identity) + ' в сети', 'ok'); this.emit(); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { this.cleanupPeer(p.identity); this.emit(); })
      .on(RoomEvent.TrackMuted, (pub, p) => { if (this.inVoice && pub.source === Track.Source.Microphone && p !== this.room?.localParticipant) playSound('mute'); this.emit(); })
      .on(RoomEvent.TrackUnmuted, () => this.emit())
      .on(RoomEvent.TrackPublished, this.onRemotePub)
      .on(RoomEvent.TrackUnpublished, this.onRemoteUnpub)
      .on(RoomEvent.DataReceived, this.onData);
    await r.connect(url, token, { autoSubscribe: false });
    r.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)));
    this.videoT.onRoomConnected();
    this.presenceTimer = window.setInterval(() => { this.announceWatch(); this.cleanupWatchers(); }, 3000);
    this.emit();
  }

  disconnect() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.analysers.forEach((o) => { try { o.src.disconnect(); } catch { /**/ } });
    this.analysers.clear(); this.speakingSet.clear();
    if (this.spRAF) cancelAnimationFrame(this.spRAF); this.spRAF = null;
    this.keepAliveOff();
    document.querySelectorAll('#audioSink audio').forEach((a) => a.remove());
    this.videoT.detach(); this.screenAudioEls.clear();
    this.watching.clear(); this.pendingWatch.clear(); this.streamWatchers.clear();
    this.perMute.clear(); this.messages = [];
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
    if (username === this.me.username) return this.videoT.isBroadcasting(username);
    return this.videoT.isRemoteBroadcasting(username);
  }
  private nameOf(identity: string): string { const p = this.partOf(identity); return (p && p.name) || identity; }
  private localMicMuted(): boolean { return this.manualMute; }
  private micPub() { return this.room && this.room.localParticipant.getTrackPublication(Track.Source.Microphone); }

  /* ---------- VOICE join/leave ---------- */
  async joinVoice() {
    if (!this.room || this.inVoice) return;
    this.inVoice = true; this.manualMute = false;
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
    this.inVoice = false; this.deafened = false; this.manualMute = false;
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
    if (this.micRaw) { this.micRaw.getTracks().forEach((t) => t.stop()); this.micRaw = null; }
    if (this.micActx) { try { this.micActx.close(); } catch { /**/ } this.micActx = null; }
    this.micGain = null;
  }
  // gain = громкость микрофона, 0 при муте/оглушении/PTT-не-нажат
  private applyGate() {
    if (!this.micGain || !this.micActx) return;
    const s = getSettings();
    const vol = (s.micVolume ?? 100) / 100;
    let target = vol;
    if (this.manualMute || this.deafened) target = 0;
    else if (s.mode === 'ptt' && !this.pttDown) target = 0;
    try { this.micGain.gain.setTargetAtTime(target, this.micActx.currentTime, 0.015); } catch { this.micGain.gain.value = target; }
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
  applyMicVolume() { this.applyGate(); }

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
        const rms = Math.sqrt(sum / o.buf.length); const on = rms > 0.018;
        if (on) o.hold = 8; else if (o.hold > 0) o.hold--;
        const spk = o.hold > 0 || on;
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
  getVideoTrack(key: string) { return this.videoT.getVideoTrack(key); }

  watch(identity: string) {
    // no `this.room` participant guard here: a tree broadcaster (Э2) is a native peer,
    // not a LiveKit room participant (voice and video are separate transports now) —
    // existence is the VideoTransport's job (it no-ops safely on an unknown identity).
    this.watching.add(identity); this.pendingWatch.add(identity);
    this.videoT.watch(identity);
    if (!localStorage.getItem('sprayTip')) { localStorage.setItem('sprayTip', '1'); this.hooks.toast('Кинь эмоут зрителям — 😃 в углу трансляции', 'info'); }
    this.emit();
    setTimeout(() => {
      if (this.pendingWatch.has(identity)) {
        this.pendingWatch.delete(identity); this.watching.delete(identity);
        this.videoT.unwatch(identity);
        this.hooks.toast('Не удалось подключиться к трансляции', 'err'); this.emit();
      }
    }, 10000);
  }
  closeWatch(identity: string) {
    this.watching.delete(identity);
    this.videoT.unwatch(identity);
    const m = this.streamWatchers.get(identity); if (m) { m.delete(this.me.username); }
    this.dataSend({ t: 'watch', s: identity, id: this.me.username, n: this.me.displayName, on: false });
    this.emit();
  }

  async share() {
    if (!this.inVoice) { this.hooks.toast('Сначала подключись к голосовому', 'warn'); return; }
    if (this.videoT.isBroadcasting(this.me.username)) { await this.stopShare(); this.hooks.toast('Трансляция остановлена'); return; }
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
    try { await this.videoT.startBroadcast(this.me.username, this.screenStream); }
    catch { this.hooks.toast('Вещание доступно только из нативного приложения', 'err'); this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null; return; }
    if (!this.screenStream.getAudioTracks()[0]) this.hooks.toast('Звук экрана не захвачен — включи галку «Поделиться аудио»', 'warn');
    this.keepAliveOn();
    const surf = (vt.getSettings() as any).displaySurface || '';
    if (surf === 'monitor' || surf === 'window') this.hooks.toast('Выбран экран/окно (~15fps). Для 60fps выбирай «Вкладка Chrome»', 'warn'); else this.hooks.toast('Трансляция запущена', 'ok');
    playSound('stream');
    this.emit();
  }
  async stopShare() {
    if (!this.room) return;
    await this.videoT.stopBroadcast(this.me.username);
    if (this.screenStream) { this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null; }
    this.keepAliveOff();
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    this.emit();
  }
  isSharing() { return this.videoT.isBroadcasting(this.me.username); }

  private keepAliveOn() { try { this.keepCtx = this.keepCtx || new AudioContext(); if (this.keepOsc) return; this.keepOsc = this.keepCtx.createOscillator(); const g = this.keepCtx.createGain(); g.gain.value = 0.0004; this.keepOsc.frequency.value = 30; this.keepOsc.connect(g); g.connect(this.keepCtx.destination); this.keepOsc.start(); } catch { /**/ } }
  private keepAliveOff() { try { if (this.keepOsc) { this.keepOsc.stop(); this.keepOsc.disconnect(); this.keepOsc = null; } } catch { /**/ } }

  async getScreenStats(): Promise<string | null> { return this.videoT.getScreenStats(this.me.username); }

  /** Позиция в дереве + живая RTP-статистика для дебаг-панели зрителя (Э2.1).
   *  `null` для транспортов без дерева (LiveKit) — StreamTile просто не покажет панель. */
  getTreeInfo(identity: string) { return this.videoT.getTreeInfo?.(identity) ?? null; }
  async getWatchRtpStats(identity: string) { return (await this.videoT.getRtpStats?.(identity)) ?? null; }

  /* ---------- emotes (spray) ---------- */
  onEmote(cb: EmoteListener) { this.emoteListeners.add(cb); return () => { this.emoteListeners.delete(cb); }; }
  fling(streamerId: string, emote: Emote) {
    const x = Math.random();
    this.emoteListeners.forEach((f) => f(streamerId, emote.id, this.me.displayName, x));
    this.dataSend({ t: 'emote', s: streamerId, e: emote.id, by: this.me.displayName, x });
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
  private pushMsg(who: string | null, text: string, sys: boolean, color?: number, mineOverride?: boolean, img?: string) {
    const mine = mineOverride !== undefined ? mineOverride : (!sys && who === this.me.displayName);
    this.messages = [...this.messages, { id: msgSeq++, who, text, mine, sys, color, img }].slice(-500);
    this.emit();
  }
  sysMsg(text: string) { this.pushMsg(null, text, true); }
  loadHistory(list: { uid: string; name: string; color: number; text: string; em: Record<string, string>; img?: string }[]) {
    this.messages = list.map((m) => {
      if (m.em) for (const k in m.em) this.onEmoteResolve?.(k, m.em[k]);
      return { id: msgSeq++, who: m.name, text: m.text, mine: m.uid === this.me.id, sys: false, color: m.color, img: m.img };
    });
    this.emit();
  }
  sendChatWithEmotes(text: string, em: Record<string, string>, img?: string) {
    if ((!text.trim() && !img) || !this.room) return;
    const t = text.trim();
    this.dataSend({ t: 'chat', name: this.me.displayName, text: t, em, color: this.me.avatarColor, img });
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
      if (d.t === 'chat') { if (d.em) for (const k in d.em) this.onEmoteResolve?.(k, d.em[k]); this.typingUsers.delete(d.name); this.pushMsg(d.name, d.text, false, d.color, false, d.img); playSound('msg'); }
      else if (d.t === 'emote') this.emoteListeners.forEach((f) => f(d.s, d.e, d.by, d.x));
      else if (d.t === 'watch') { const m = this.wset(d.s); if (d.on) m.set(d.id, { name: d.n, ts: Date.now() }); else m.delete(d.id); this.emit(); }
      else if (d.t === 'typing') { if (d.name && d.name !== this.me.displayName) { this.typingUsers.set(d.name, Date.now() + 3500); this.emit(); setTimeout(() => this.pruneTyping(), 3600); } }
    } catch { /**/ }
  };
  onEmoteResolve: ((name: string, id: string) => void) | null = null;
  private dataSend(obj: any) { if (!this.room) return; try { this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: obj.t === 'chat' }); } catch { /**/ } }

  emoteImg(id: string) { return emoteUrl(id); }
}

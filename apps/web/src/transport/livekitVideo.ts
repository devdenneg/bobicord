import {
  Room, RoomEvent, Track, LocalVideoTrack, LocalAudioTrack,
  type RemoteParticipant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { VideoTransport } from './videoTransport';
import type { StreamInfo } from '../engine';
import { baseUid } from '../util';

/**
 * LiveKit SFU implementation of VideoTransport — behavior identical to pre-Э0 engine.ts.
 * Screen-share video (`Track.Source.ScreenShare`) + its bundled audio (`ScreenShareAudio`)
 * are published/subscribed through the LiveKit Room. VP8, no simulcast, 8Mbps cap — unchanged
 * from the original `share()`; H.264 swap is Э2.
 */
export class LiveKitVideoTransport implements VideoTransport {
  private room: Room | null = null;         // attached-комната для событий/watch/discovery (= смотримая, viewRoom)
  private broadcastRoom: Room | null = null; // S5: комната ВЕЩАНИЯ (голосовая); null → вещаем в this.room (shared)
  private me = '';
  setBroadcastRoom(room: Room | null) { this.broadcastRoom = room; }
  private bcRoom(): Room | null { return this.broadcastRoom || this.room; }

  private videoTracks = new Map<string, LocalVideoTrack | RemoteTrack>();
  private streamInfoByKey = new Map<string, StreamInfo>();
  // A logical stream is keyed by the base username, while LiveKit participants are
  // per-session identities. Keep the selected session explicit so a second tab/device
  // can take over without tearing down the logical watch.
  private watchedUsers = new Set<string>();
  private activeWatchSession = new Map<string, string>();
  private announcedScreenSessions = new Set<string>();

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: LocalVideoTrack | RemoteTrack, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();

  /* ---------- lifecycle ---------- */
  attach(room: Room, ctx: { me: string; serverId: string }) {
    this.room = room;
    this.me = ctx.me;
    room
      .on(RoomEvent.TrackSubscribed, this.onSub)
      .on(RoomEvent.TrackUnsubscribed, this.onUnsub)
      .on(RoomEvent.LocalTrackPublished, this.onLocalPub)
      .on(RoomEvent.LocalTrackUnpublished, this.onLocalUnpub)
      .on(RoomEvent.TrackPublished, this.onRemotePub)
      .on(RoomEvent.TrackUnpublished, this.onRemoteUnpub)
      .on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
  }
  onRoomConnected() {
    if (!this.room) return;
    this.room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)));
    // локальная screenshare, если вещаю В ЭТУ комнату (напр. вернулся на свой голосовой сервер после
    // браузинга) — регистрируем для превью; LocalTrackPublished мог не долететь (вещание шло в другую комнату).
    const sp = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (sp && sp.track) this.addVideo(sp.trackSid, sp.track as any, this.me, true);
  }
  detach() {
    if (this.room) {
      this.room
        .off(RoomEvent.TrackSubscribed, this.onSub)
        .off(RoomEvent.TrackUnsubscribed, this.onUnsub)
        .off(RoomEvent.LocalTrackPublished, this.onLocalPub)
        .off(RoomEvent.LocalTrackUnpublished, this.onLocalUnpub)
        .off(RoomEvent.TrackPublished, this.onRemotePub)
        .off(RoomEvent.TrackUnpublished, this.onRemoteUnpub)
        .off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
    }
    this.watchedUsers.forEach((username) => this.setUserSubscribed(username, false));
    this.watchedUsers.clear();
    this.activeWatchSession.clear();
    this.announcedScreenSessions.clear();
    this.videoTracks.clear();
    this.streamInfoByKey.clear();
    this.room = null;
  }

  /* ---------- broadcasting (local) ---------- */
  async startBroadcast(_streamId: string, source: MediaStream) {
    const room = this.bcRoom(); if (!room) return; // вещаем в ГОЛОСОВУЮ комнату, не в смотримую
    const vt = source.getVideoTracks()[0];
    const lvt = new LocalVideoTrack(vt);
    await room.localParticipant.publishTrack(lvt, {
      source: Track.Source.ScreenShare,
      videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      videoCodec: 'vp8',
      simulcast: false,
      degradationPreference: 'maintain-framerate' as any,
    });
    const at = source.getAudioTracks()[0];
    if (at) {
      const lat = new LocalAudioTrack(at);
      await room.localParticipant.publishTrack(lat, { source: Track.Source.ScreenShareAudio, dtx: false, red: false });
    }
    // Если вещаю В смотримую комнату (shared) — LocalTrackPublished сам зарегистрирует превью. Если в
    // ДРУГУЮ (голосовую при браузинге) — событие туда не долетит (слушаем viewRoom), но превью там и не
    // нужно (смотрю другой сервер); при возврате на голосовой onRoomConnected перерегистрирует локальный трек.
  }
  async stopBroadcast(_streamId: string) {
    const room = this.bcRoom(); if (!room) return;
    const v = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (v && v.track) { try { await room.localParticipant.unpublishTrack(v.track, true); } catch { /**/ } }
    const a = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
    if (a && a.track) { try { await room.localParticipant.unpublishTrack(a.track, true); } catch { /**/ } }
  }
  isBroadcasting(_streamId: string) { const room = this.bcRoom(); return !!(room && room.localParticipant.isScreenShareEnabled); }
  private participantsByUser(username: string): RemoteParticipant[] {
    const out: RemoteParticipant[] = [];
    if (!this.room) return out;
    for (const p of this.room.remoteParticipants.values()) {
      if (baseUid(p.identity) !== username) continue;
      out.push(p);
    }
    return out;
  }
  private broadcastingParticipant(username: string, excludeIdentity?: string): RemoteParticipant | undefined {
    const activeIdentity = this.activeWatchSession.get(username);
    const participants = this.participantsByUser(username);
    const active = activeIdentity && activeIdentity !== excludeIdentity
      ? participants.find((p) => p.identity === activeIdentity && !!p.getTrackPublication(Track.Source.ScreenShare))
      : undefined;
    return active || participants.find((p) => p.identity !== excludeIdentity && !!p.getTrackPublication(Track.Source.ScreenShare));
  }
  private setParticipantSubscribed(p: RemoteParticipant, subscribed: boolean) {
    const video = p.getTrackPublication(Track.Source.ScreenShare);
    const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
    [video, audio].forEach((pub) => {
      if (!pub) return;
      try { (pub as any).setSubscribed(subscribed); } catch { /**/ }
    });
  }
  private setUserSubscribed(username: string, subscribed: boolean) {
    this.participantsByUser(username).forEach((p) => this.setParticipantSubscribed(p, subscribed));
  }
  private activateWatchSession(username: string, next?: RemoteParticipant) {
    const previousIdentity = this.activeWatchSession.get(username);
    if (previousIdentity === next?.identity) {
      if (next) this.setParticipantSubscribed(next, true);
      return;
    }
    const previous = previousIdentity ? this.room?.remoteParticipants.get(previousIdentity) : undefined;
    if (previous) this.setParticipantSubscribed(previous, false);
    if (next) {
      this.activeWatchSession.set(username, next.identity);
      this.setParticipantSubscribed(next, true);
    } else {
      this.activeWatchSession.delete(username);
    }
  }
  isRemoteBroadcasting(username: string) {
    return !!this.broadcastingParticipant(username);
  }

  async getScreenStats(_streamId: string): Promise<string | null> {
    const pub = this.bcRoom()?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (!pub || !pub.track) return null;
    try {
      const rep = await (pub.track as any).getRTCStatsReport();
      let o: any = null, rem: any = null, src: any = null;
      rep.forEach((s: any) => { if (s.type === 'outbound-rtp' && s.kind === 'video') o = s; if (s.type === 'remote-inbound-rtp' && s.kind === 'video') rem = s; if (s.type === 'media-source' && s.kind === 'video') src = s; });
      if (!o) return null;
      const fps = Math.round(o.framesPerSecond || 0), res = (o.frameWidth || 0) + '×' + (o.frameHeight || 0);
      const cap = src ? Math.round(src.framesPerSecond || 0) : null;
      const loss = rem && rem.fractionLost != null ? (rem.fractionLost * 100).toFixed(1) + '%' : '—';
      const rtt = rem && rem.roundTripTime != null ? Math.round(rem.roundTripTime * 1000) + 'ms' : '—';
      return `${res} · ${fps}fps${cap != null ? ' (захв ' + cap + ')' : ''} · ${rtt} · потери ${loss}`;
    } catch { return null; }
  }

  /* ---------- watching (remote) ---------- */
  watch(streamId: string, _quality?: string) {
    // Д3: quality игнорируется — LiveKit-путь идёт через SFU, деревьев/рендишнов нет.
    this.watchedUsers.add(streamId);
    this.activateWatchSession(streamId, this.broadcastingParticipant(streamId));
  }
  unwatch(streamId: string) {
    this.watchedUsers.delete(streamId);
    this.setUserSubscribed(streamId, false);
    this.activeWatchSession.delete(streamId);
  }

  /* ---------- track registry ---------- */
  getVideoTrack(key: string) { return this.videoTracks.get(key); }
  getStreams(): StreamInfo[] {
    const out: StreamInfo[] = [];
    this.videoTracks.forEach((_t, key) => { const info = this.streamInfoByKey.get(key); if (info) out.push(info); });
    return out;
  }
  private addVideo(key: string, track: LocalVideoTrack | RemoteTrack, identity: string, isLocal: boolean) {
    this.videoTracks.set(key, track);
    this.streamInfoByKey.set(key, { key, identity, isLocal });
    this.videoTrackCbs.forEach((cb) => cb(key, track, identity, isLocal));
  }
  private delVideo(key: string) {
    this.videoTracks.delete(key);
    this.streamInfoByKey.delete(key);
    this.videoTrackRemovedCbs.forEach((cb) => cb(key));
  }

  /* ---------- room events (video-domain only; mic/chat stay in engine.ts) ---------- */
  private onRemotePub = (pub: TrackPublication, p: RemoteParticipant, silent?: boolean) => {
    const username = baseUid(p.identity);
    if (pub.source === Track.Source.ScreenShareAudio) {
      if (this.watchedUsers.has(username) && this.activeWatchSession.get(username) === p.identity) {
        try { (pub as any).setSubscribed(true); } catch { /**/ }
      }
      return;
    }
    if (pub.source !== Track.Source.ScreenShare) return;
    if (this.watchedUsers.has(username)) {
      const active = this.broadcastingParticipant(username);
      this.activateWatchSession(username, active || p);
    }
    if (this.announcedScreenSessions.has(p.identity)) return;
    this.announcedScreenSessions.add(p.identity);
    this.streamStartCbs.forEach((cb) => cb(p.identity, !!silent));
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant) => {
    if (pub.source !== Track.Source.ScreenShare) return;
    const username = baseUid(p.identity);
    if (this.watchedUsers.has(username) && this.activeWatchSession.get(username) === p.identity) {
      this.setParticipantSubscribed(p, false);
      this.activateWatchSession(username, this.broadcastingParticipant(username, p.identity));
    }
    if (!this.announcedScreenSessions.delete(p.identity)) return;
    this.streamStopCbs.forEach((cb) => cb(p.identity));
  };
  private onParticipantDisconnected = (p: RemoteParticipant) => {
    const username = baseUid(p.identity);
    if (this.watchedUsers.has(username) && this.activeWatchSession.get(username) === p.identity) {
      this.activateWatchSession(username, this.broadcastingParticipant(username, p.identity));
    }
    if (this.announcedScreenSessions.delete(p.identity)) this.streamStopCbs.forEach((cb) => cb(p.identity));
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Video) return;
    this.addVideo(pub.trackSid, track, baseUid(p.identity), false);
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication) => {
    if (track.kind !== Track.Kind.Video) return;
    track.detach().forEach((el) => el.remove());
    this.delVideo(pub.trackSid);
  };
  private onLocalPub = (pub: TrackPublication) => {
    const track = pub.track;
    if (track && track.kind === Track.Kind.Video) this.addVideo(pub.trackSid, track as LocalVideoTrack, this.me, true);
  };
  private onLocalUnpub = (pub: TrackPublication) => {
    if (pub.track) (pub.track as any).detach?.().forEach((el: HTMLElement) => el.remove());
    this.delVideo(pub.trackSid);
  };

  /* ---------- event registration ---------- */
  onStreamStart(cb: (identity: string, silent: boolean) => void) { this.streamStartCbs.add(cb); return () => { this.streamStartCbs.delete(cb); }; }
  onStreamStop(cb: (identity: string) => void) { this.streamStopCbs.add(cb); return () => { this.streamStopCbs.delete(cb); }; }
  onVideoTrack(cb: (key: string, track: LocalVideoTrack | RemoteTrack, identity: string, isLocal: boolean) => void) { this.videoTrackCbs.add(cb); return () => { this.videoTrackCbs.delete(cb); }; }
  onVideoTrackRemoved(cb: (key: string) => void) { this.videoTrackRemovedCbs.add(cb); return () => { this.videoTrackRemovedCbs.delete(cb); }; }
}

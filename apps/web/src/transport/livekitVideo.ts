import {
  Room, RoomEvent, Track, LocalVideoTrack, LocalAudioTrack,
  type RemoteParticipant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type { VideoTransport } from './videoTransport';
import type { StreamInfo } from '../engine';

/**
 * LiveKit SFU implementation of VideoTransport — behavior identical to pre-Э0 engine.ts.
 * Screen-share video (`Track.Source.ScreenShare`) + its bundled audio (`ScreenShareAudio`)
 * are published/subscribed through the LiveKit Room. VP8, no simulcast, 8Mbps cap — unchanged
 * from the original `share()`; H.264 swap is Э2.
 */
export class LiveKitVideoTransport implements VideoTransport {
  private room: Room | null = null;
  private me = '';

  private videoTracks = new Map<string, LocalVideoTrack | RemoteTrack>();
  private streamInfoByKey = new Map<string, StreamInfo>();

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: LocalVideoTrack | RemoteTrack, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();

  /* ---------- lifecycle ---------- */
  attach(room: Room, ctx: { me: string }) {
    this.room = room;
    this.me = ctx.me;
    room
      .on(RoomEvent.TrackSubscribed, this.onSub)
      .on(RoomEvent.TrackUnsubscribed, this.onUnsub)
      .on(RoomEvent.LocalTrackPublished, this.onLocalPub)
      .on(RoomEvent.LocalTrackUnpublished, this.onLocalUnpub)
      .on(RoomEvent.TrackPublished, this.onRemotePub)
      .on(RoomEvent.TrackUnpublished, this.onRemoteUnpub);
  }
  onRoomConnected() {
    if (!this.room) return;
    this.room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.onRemotePub(pub, p, true)));
  }
  detach() {
    if (this.room) {
      this.room
        .off(RoomEvent.TrackSubscribed, this.onSub)
        .off(RoomEvent.TrackUnsubscribed, this.onUnsub)
        .off(RoomEvent.LocalTrackPublished, this.onLocalPub)
        .off(RoomEvent.LocalTrackUnpublished, this.onLocalUnpub)
        .off(RoomEvent.TrackPublished, this.onRemotePub)
        .off(RoomEvent.TrackUnpublished, this.onRemoteUnpub);
    }
    this.videoTracks.clear();
    this.streamInfoByKey.clear();
    this.room = null;
  }

  /* ---------- broadcasting (local) ---------- */
  async startBroadcast(_streamId: string, source: MediaStream) {
    if (!this.room) return;
    const vt = source.getVideoTracks()[0];
    const lvt = new LocalVideoTrack(vt);
    await this.room.localParticipant.publishTrack(lvt, {
      source: Track.Source.ScreenShare,
      videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      videoCodec: 'vp8',
      simulcast: false,
      degradationPreference: 'maintain-framerate' as any,
    });
    const at = source.getAudioTracks()[0];
    if (at) {
      const lat = new LocalAudioTrack(at);
      await this.room.localParticipant.publishTrack(lat, { source: Track.Source.ScreenShareAudio, dtx: false, red: false });
    }
  }
  async stopBroadcast(_streamId: string) {
    if (!this.room) return;
    const v = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (v && v.track) { try { await this.room.localParticipant.unpublishTrack(v.track, true); } catch { /**/ } }
    const a = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
    if (a && a.track) { try { await this.room.localParticipant.unpublishTrack(a.track, true); } catch { /**/ } }
  }
  isBroadcasting(_streamId: string) { return !!(this.room && this.room.localParticipant.isScreenShareEnabled); }
  isRemoteBroadcasting(identity: string) {
    const p = this.room?.remoteParticipants.get(identity);
    return !!(p && p.getTrackPublication(Track.Source.ScreenShare));
  }

  async getScreenStats(_streamId: string): Promise<string | null> {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
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
  watch(streamId: string) {
    const p = this.room?.remoteParticipants.get(streamId); if (!p) return;
    const v = p.getTrackPublication(Track.Source.ScreenShare), a = p.getTrackPublication(Track.Source.ScreenShareAudio);
    [v, a].forEach((pub) => { if (pub) { try { (pub as any).setSubscribed(true); } catch { /**/ } } });
  }
  unwatch(streamId: string) {
    const p = this.room?.remoteParticipants.get(streamId); if (!p) return;
    const v = p.getTrackPublication(Track.Source.ScreenShare), a = p.getTrackPublication(Track.Source.ScreenShareAudio);
    [v, a].forEach((pub) => { if (pub) { try { (pub as any).setSubscribed(false); } catch { /**/ } } });
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
    if (pub.source !== Track.Source.ScreenShare) return;
    this.streamStartCbs.forEach((cb) => cb(p.identity, !!silent));
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant) => {
    if (pub.source !== Track.Source.ScreenShare) return;
    this.streamStopCbs.forEach((cb) => cb(p.identity));
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Video) return;
    this.addVideo(pub.trackSid, track, p.identity, false);
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

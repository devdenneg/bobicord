import {
  Room, RoomEvent, Track, LocalVideoTrack, LocalAudioTrack,
  type RemoteParticipant, type TrackPublication, type RemoteTrack,
} from 'livekit-client';
import type {
  StreamWatchTransportDiagnostic,
  StreamWatchTransportDiagnosticCode,
  StreamWatchTransportTrackState,
  VideoTransport,
} from './videoTransport';
import type { StreamInfo } from '../engine';
import { baseUid } from '../util';
import { ExactPeerStatsSampler } from '../rtcStatsSampler';

interface LocalScreenStatsTrack {
  getRTCStatsReport(): PromiseLike<RTCStatsReport>;
}

const localScreenStatsSampler = new ExactPeerStatsSampler<LocalScreenStatsTrack, RTCStatsReport>(2);
const LIVEKIT_WATCH_RESUBSCRIBE_DELAYS_MS = [250, 1_000, 2_500] as const;
const LIVEKIT_WATCH_DECODE_TIMEOUT_MS = 4_000;

interface LiveKitWatchRetryState {
  generation: number;
  participant: RemoteParticipant;
  publication: TrackPublication;
  attempts: number;
  timer: number | null;
  candidateTrack: RemoteTrack | null;
  exhausted: boolean;
  phase: 'waiting_subscription' | 'awaiting_decode' | 'exhausted';
}

interface LiveKitWatchOwner {
  participant: RemoteParticipant;
  publication: TrackPublication;
  track: RemoteTrack | null;
}

function diagnosticTrackState(track: RemoteTrack | null | undefined): StreamWatchTransportTrackState {
  const state = track?.mediaStreamTrack?.readyState;
  return state === 'live' || state === 'ended' ? state : track ? 'unknown' : 'missing';
}

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
  private remotePublicationByKey = new Map<string, TrackPublication>();
  // A logical stream is keyed by the base username, while LiveKit participants are
  // per-session identities. Keep the selected session explicit so a second tab/device
  // can take over without tearing down the logical watch.
  private watchedUsers = new Set<string>();
  private activeWatchOwners = new Map<string, LiveKitWatchOwner>();
  private announcedScreenSessions = new Set<string>();
  private watchReconnectCount = new Map<string, number>();
  private recoveringWatches = new Set<string>();
  private watchRetryGenerations = new Map<string, number>();
  private watchRetryStates = new Map<string, LiveKitWatchRetryState>();

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: LocalVideoTrack | RemoteTrack, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();
  private watchDiagnosticCbs = new Set<(event: StreamWatchTransportDiagnostic) => void>();
  private switchFailedCbs = new Set<(streamId: string) => void>();

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
    const watchedUsers = [...this.watchedUsers];
    this.watchedUsers.clear();
    watchedUsers.forEach((username) => this.setUserSubscribed(username, false));
    this.cancelAllWatchRetries();
    this.activeWatchOwners.clear();
    this.announcedScreenSessions.clear();
    this.watchReconnectCount.clear();
    this.recoveringWatches.clear();
    this.videoTracks.clear();
    this.streamInfoByKey.clear();
    this.remotePublicationByKey.clear();
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
    const owner = this.activeWatchOwners.get(username);
    const participants = this.participantsByUser(username);
    const active = owner && owner.participant.identity !== excludeIdentity
      && this.room?.remoteParticipants.get(owner.participant.identity) === owner.participant
      && owner.participant.getTrackPublication(Track.Source.ScreenShare) === owner.publication
      ? owner.participant
      : undefined;
    return active || participants.find((p) => p.identity !== excludeIdentity && !!p.getTrackPublication(Track.Source.ScreenShare));
  }
  private setPublicationSubscribed(pub: TrackPublication, subscribed: boolean): boolean {
    try {
      (pub as any).setSubscribed(subscribed);
      return true;
    } catch {
      return false;
    }
  }
  private setParticipantSubscribed(p: RemoteParticipant, subscribed: boolean): boolean {
    const video = p.getTrackPublication(Track.Source.ScreenShare);
    const audio = p.getTrackPublication(Track.Source.ScreenShareAudio);
    let ok = !!video;
    [video, audio].forEach((pub) => {
      if (!pub) return;
      if (!this.setPublicationSubscribed(pub, subscribed)) ok = false;
    });
    return ok;
  }
  private setWatchOwnerSubscribed(owner: LiveKitWatchOwner, subscribed: boolean): boolean {
    let ok = this.setPublicationSubscribed(owner.publication, subscribed);
    // Screen-share audio is selected by source in LiveKit. Touch it only while this exact participant
    // object is still current; a late owner from an old room/session must not mute its replacement.
    if (this.room?.remoteParticipants.get(owner.participant.identity) === owner.participant) {
      const audio = owner.participant.getTrackPublication(Track.Source.ScreenShareAudio);
      if (audio && !this.setPublicationSubscribed(audio, subscribed)) ok = false;
    }
    return ok;
  }
  private setUserSubscribed(username: string, subscribed: boolean) {
    this.participantsByUser(username).forEach((p) => this.setParticipantSubscribed(p, subscribed));
  }
  private clearWatchRetryTimer(state: LiveKitWatchRetryState) {
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = null;
  }
  private cancelWatchRetry(username: string) {
    this.watchRetryGenerations.set(username, (this.watchRetryGenerations.get(username) || 0) + 1);
    const state = this.watchRetryStates.get(username);
    if (state) this.clearWatchRetryTimer(state);
    this.watchRetryStates.delete(username);
  }
  private cancelAllWatchRetries() {
    this.watchRetryStates.forEach((state) => {
      if (state.timer !== null) window.clearTimeout(state.timer);
    });
    this.watchRetryStates.clear();
    this.watchRetryGenerations.clear();
  }
  private ensureWatchRetryState(
    username: string,
    publication: TrackPublication,
    participant: RemoteParticipant,
  ): LiveKitWatchRetryState {
    const generation = this.watchRetryGenerations.get(username) || 0;
    let state = this.watchRetryStates.get(username);
    if (!state || state.generation !== generation) {
      if (state) this.clearWatchRetryTimer(state);
      state = {
        generation, participant, publication, attempts: 0, timer: null,
        candidateTrack: null, exhausted: false, phase: 'waiting_subscription',
      };
      this.watchRetryStates.set(username, state);
      return state;
    }
    if (state.participant !== participant || state.publication !== publication) {
      this.clearWatchRetryTimer(state);
      state.participant = participant;
      state.publication = publication;
      state.candidateTrack = null;
      if (!state.exhausted) state.phase = 'waiting_subscription';
    }
    return state;
  }
  private isExactWatchOwner(
    username: string,
    participant: RemoteParticipant,
    publication: TrackPublication,
  ): boolean {
    const owner = this.activeWatchOwners.get(username);
    return this.watchedUsers.has(username)
      && this.room?.remoteParticipants.get(participant.identity) === participant
      && owner?.participant === participant
      && owner.publication === publication
      && participant.getTrackPublication(Track.Source.ScreenShare) === publication;
  }
  private exhaustWatchRecovery(
    username: string,
    state: LiveKitWatchRetryState,
    code: StreamWatchTransportDiagnosticCode,
  ) {
    if (this.watchRetryStates.get(username) !== state || state.exhausted) return;
    this.clearWatchRetryTimer(state);
    state.candidateTrack = null;
    state.exhausted = true;
    state.phase = 'exhausted';
    this.emitWatchDiagnostic(username, {
      stage: 'watch_recovery', outcome: 'timed_out', code, trackState: 'missing',
      reconnectCount: this.watchReconnectCount.get(username) || 0,
    });
    // A terminal transport episode must release Engine's logical watch owner too. Otherwise its
    // `watching` guard turns the viewer's next explicit click into a permanent no-op. This is not
    // a broadcaster stop: stream discovery remains live and the viewer may immediately retry.
    this.switchFailedCbs.forEach((cb) => cb(username));
  }
  private scheduleWatchRetry(username: string, publication: TrackPublication, participant: RemoteParticipant) {
    const state = this.ensureWatchRetryState(username, publication, participant);
    const generation = state.generation;
    const scheduleNext = () => {
      if (this.watchRetryStates.get(username) !== state
        || this.watchRetryGenerations.get(username) !== generation
        || state.timer !== null || state.candidateTrack || state.exhausted
        || state.phase !== 'waiting_subscription') return;
      const delay = LIVEKIT_WATCH_RESUBSCRIBE_DELAYS_MS[state.attempts];
      if (delay === undefined) {
        // The final setSubscribed(true) result is asynchronous in real LiveKit rooms. Give it one
        // finite delivery window instead of declaring failure in the same task as the third request.
        // TrackSubscribed replaces this timer with its exact decoded-frame watchdog.
        const timer = window.setTimeout(() => {
          if (state.timer !== timer || this.watchRetryStates.get(username) !== state
            || this.watchRetryGenerations.get(username) !== generation) return;
          state.timer = null;
          if (!this.isExactWatchOwner(username, state.participant, state.publication)) return;
          this.exhaustWatchRecovery(username, state, 'track_missing');
        }, LIVEKIT_WATCH_DECODE_TIMEOUT_MS);
        state.timer = timer;
        return;
      }
      const timer = window.setTimeout(() => {
        if (state.timer !== timer || this.watchRetryStates.get(username) !== state
          || this.watchRetryGenerations.get(username) !== generation) return;
        state.timer = null;
        if (!this.isExactWatchOwner(username, state.participant, state.publication)) {
          return;
        }
        state.attempts += 1;
        this.emitWatchDiagnostic(username, {
          stage: 'watch_join', outcome: 'started', code: 'track_missing', trackState: 'missing',
          reconnectCount: this.watchReconnectCount.get(username) || 0,
        });
        const owner = this.activeWatchOwners.get(username)!;
        const subscribed = this.setWatchOwnerSubscribed(owner, true);
        this.emitWatchDiagnostic(username, {
          stage: 'watch_join', outcome: subscribed ? 'ok' : 'failed', code: subscribed ? 'none' : 'sdk',
          trackState: 'missing', reconnectCount: this.watchReconnectCount.get(username) || 0,
        });
        // TrackSubscribed can be delivered synchronously by a test double or an SDK implementation.
        // It moves this episode to awaiting-decode before another SDK request is scheduled. Only an
        // exact decoded-frame confirmation replenishes the budget; a later unsubscribe resumes at
        // the next delay instead of silently starting over at 250 ms.
        if (this.watchRetryStates.get(username) === state && !state.candidateTrack) scheduleNext();
      }, delay);
      state.timer = timer;
    };
    scheduleNext();
  }
  private armWatchDecodeTimer(username: string, state: LiveKitWatchRetryState, track: RemoteTrack) {
    if (state.exhausted || state.phase !== 'awaiting_decode' || state.candidateTrack !== track) return;
    this.clearWatchRetryTimer(state);
    const generation = state.generation;
    const timer = window.setTimeout(() => {
      if (state.timer !== timer || this.watchRetryStates.get(username) !== state
        || this.watchRetryGenerations.get(username) !== generation
        || state.phase !== 'awaiting_decode' || state.candidateTrack !== track) return;
      state.timer = null;
      const owner = this.activeWatchOwners.get(username);
      if (!owner || owner.participant !== state.participant || owner.publication !== state.publication
        || owner.track !== track || state.publication.track !== track
        || !this.isExactWatchOwner(username, state.participant, state.publication)) return;
      this.emitWatchDiagnostic(username, {
        stage: 'watch_playback', outcome: 'stalled', code: 'decode_timeout', trackState: 'live',
        reconnectCount: this.watchReconnectCount.get(username) || 0,
      });
      state.candidateTrack = null;
      state.phase = 'waiting_subscription';
      owner.track = null;
      // Force a fresh SDK subscription inside the same finite episode. If Unsubscribed is emitted
      // synchronously it schedules the next slot first; the explicit call below remains idempotent.
      this.discardRemoteTrack(track, state.publication, true);
      if (state.attempts >= LIVEKIT_WATCH_RESUBSCRIBE_DELAYS_MS.length) {
        this.exhaustWatchRecovery(username, state, 'decode_timeout');
      } else {
        this.scheduleWatchRetry(username, state.publication, state.participant);
      }
    }, LIVEKIT_WATCH_DECODE_TIMEOUT_MS);
    state.timer = timer;
  }
  private activateWatchSession(username: string, next?: RemoteParticipant): boolean {
    const previous = this.activeWatchOwners.get(username);
    const nextPublication = next && this.room?.remoteParticipants.get(next.identity) === next
      ? next.getTrackPublication(Track.Source.ScreenShare)
      : undefined;
    if (previous && previous.participant === next && previous.publication === nextPublication) {
      return this.setWatchOwnerSubscribed(previous, true);
    }
    // Publish the logical replacement before unsubscribing the old physical session. Some SDK
    // versions synchronously emit TrackUnsubscribed from setSubscribed(false); that event must see
    // the replacement owner and may not re-arm the retired publication.
    const nextOwner = next && nextPublication
      ? { participant: next, publication: nextPublication, track: null }
      : undefined;
    if (nextOwner) {
      this.activeWatchOwners.set(username, nextOwner);
      if (this.recoveringWatches.has(username)) {
        this.ensureWatchRetryState(username, nextOwner.publication, nextOwner.participant);
      }
    } else {
      this.activeWatchOwners.delete(username);
      const retry = this.watchRetryStates.get(username);
      if (retry) {
        this.clearWatchRetryTimer(retry);
        retry.candidateTrack = null;
        if (!retry.exhausted) retry.phase = 'waiting_subscription';
      }
    }
    if (previous && previous !== nextOwner) {
      // A same-participant re-publication has a new exact video owner. Unsubscribe only the retired
      // publication: source-based lookup already points at the replacement and would turn it off.
      if (previous.participant === next) this.setPublicationSubscribed(previous.publication, false);
      else this.setWatchOwnerSubscribed(previous, false);
    }
    return nextOwner ? this.setWatchOwnerSubscribed(nextOwner, true) : false;
  }

  private subscribeWatchSession(username: string, next?: RemoteParticipant) {
    this.emitWatchDiagnostic(username, {
      stage: 'watch_join', outcome: 'started', code: 'none',
      reconnectCount: this.watchReconnectCount.get(username) || 0,
    });
    const subscribed = this.activateWatchSession(username, next);
    const owner = this.activeWatchOwners.get(username);
    if (owner && this.recoveringWatches.has(username)) {
      this.scheduleWatchRetry(username, owner.publication, owner.participant);
    }
    this.emitWatchDiagnostic(username, {
      stage: 'watch_join', outcome: subscribed ? 'ok' : next ? 'failed' : 'stalled',
      code: subscribed ? 'none' : next ? 'sdk' : 'track_missing',
      trackState: next ? 'unknown' : 'missing',
      reconnectCount: this.watchReconnectCount.get(username) || 0,
    });
  }

  private beginWatchRecovery(
    username: string,
    code: StreamWatchTransportDiagnosticCode = 'track_missing',
  ) {
    if (this.recoveringWatches.has(username)) return;
    this.recoveringWatches.add(username);
    const reconnectCount = (this.watchReconnectCount.get(username) || 0) + 1;
    this.watchReconnectCount.set(username, reconnectCount);
    this.emitWatchDiagnostic(username, {
      stage: 'watch_recovery', outcome: 'started', code, reconnectCount,
      trackState: 'missing',
    });
  }
  isRemoteBroadcasting(username: string) {
    return !!this.broadcastingParticipant(username);
  }

  async getScreenStats(_streamId: string): Promise<string | null> {
    const room = this.bcRoom();
    const pub = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const rawTrack = pub?.track;
    if (!room || !pub || !rawTrack) return null;
    const track = rawTrack as unknown as LocalScreenStatsTrack;
    try {
      const rep = await localScreenStatsSampler.sample(track, (current) => current.getRTCStatsReport());
      const currentRoom = this.bcRoom();
      const currentPub = currentRoom?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (!rep || currentRoom !== room || currentPub !== pub || currentPub.track !== rawTrack) return null;
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
    this.watchReconnectCount.delete(streamId);
    this.recoveringWatches.delete(streamId);
    this.cancelWatchRetry(streamId);
    this.emitWatchDiagnostic(streamId, { stage: 'watch_signaling', outcome: 'started', code: 'none' });
    this.watchedUsers.add(streamId);
    if (!this.room) {
      this.emitWatchDiagnostic(streamId, {
        stage: 'watch_signaling', outcome: 'failed', code: 'signaling_closed', connectionState: 'closed',
      });
      this.subscribeWatchSession(streamId);
      return;
    }
    this.emitWatchDiagnostic(streamId, {
      stage: 'watch_signaling', outcome: 'ok', code: 'none', connectionState: 'connected',
    });
    this.subscribeWatchSession(streamId, this.broadcastingParticipant(streamId));
  }
  unwatch(streamId: string) {
    this.watchedUsers.delete(streamId);
    this.cancelWatchRetry(streamId);
    this.activeWatchOwners.delete(streamId);
    this.setUserSubscribed(streamId, false);
    this.watchReconnectCount.delete(streamId);
    this.recoveringWatches.delete(streamId);
  }
  confirmPlayback(streamId: string, candidate?: MediaStreamTrack): boolean {
    const owner = this.activeWatchOwners.get(streamId);
    const track = owner?.track;
    const mediaTrack = track?.mediaStreamTrack;
    if (!owner || !track || !candidate || candidate !== mediaTrack
      || candidate.readyState !== 'live' || candidate.muted
      || !this.isExactWatchOwner(streamId, owner.participant, owner.publication)
      || owner.publication.track !== track
      || this.videoTracks.get(owner.publication.trackSid) !== track
      || this.remotePublicationByKey.get(owner.publication.trackSid) !== owner.publication) return false;
    const reconnectCount = this.watchReconnectCount.get(streamId) || 0;
    const recovered = this.recoveringWatches.delete(streamId);
    this.cancelWatchRetry(streamId);
    if (recovered) {
      this.emitWatchDiagnostic(streamId, {
        stage: 'watch_recovery', outcome: 'recovered', code: 'none', trackState: 'live', reconnectCount,
      });
    }
    this.watchReconnectCount.delete(streamId);
    return true;
  }
  acceptsScreenAudio(
    streamId: string,
    participant: RemoteParticipant,
    publication: TrackPublication,
    candidate?: RemoteTrack,
  ): boolean {
    const owner = this.activeWatchOwners.get(streamId);
    return baseUid(participant.identity) === streamId
      && publication.source === Track.Source.ScreenShareAudio
      && !!owner
      && owner.participant === participant
      && this.isExactWatchOwner(streamId, participant, owner.publication)
      && participant.getTrackPublication(Track.Source.ScreenShareAudio) === publication
      && (candidate === undefined || publication.track === candidate);
  }

  /* ---------- track registry ---------- */
  getVideoTrack(key: string) { return this.videoTracks.get(key); }
  getStreams(): StreamInfo[] {
    const out: StreamInfo[] = [];
    this.videoTracks.forEach((_t, key) => { const info = this.streamInfoByKey.get(key); if (info) out.push(info); });
    return out;
  }
  private addVideo(
    key: string,
    track: LocalVideoTrack | RemoteTrack,
    identity: string,
    isLocal: boolean,
    publication?: TrackPublication,
  ) {
    this.videoTracks.set(key, track);
    this.streamInfoByKey.set(key, { key, identity, isLocal });
    if (publication) this.remotePublicationByKey.set(key, publication);
    else this.remotePublicationByKey.delete(key);
    this.videoTrackCbs.forEach((cb) => cb(key, track, identity, isLocal));
  }
  private delVideo(key: string, publication?: TrackPublication, track?: RemoteTrack) {
    if (publication && this.remotePublicationByKey.get(key) !== publication) return;
    if (track && this.videoTracks.get(key) !== track) return;
    this.videoTracks.delete(key);
    this.streamInfoByKey.delete(key);
    this.remotePublicationByKey.delete(key);
    this.videoTrackRemovedCbs.forEach((cb) => cb(key));
  }
  private discardRemoteTrack(track: RemoteTrack, pub: TrackPublication, unsubscribe: boolean) {
    try { track.detach().forEach((el) => el.remove()); } catch { /** already detached */ }
    this.delVideo(pub.trackSid, pub, track);
    if (unsubscribe) this.setPublicationSubscribed(pub, false);
  }

  /* ---------- room events (video-domain only; mic/chat stay in engine.ts) ---------- */
  private onRemotePub = (pub: TrackPublication, p: RemoteParticipant, silent?: boolean) => {
    const username = baseUid(p.identity);
    if (pub.source === Track.Source.ScreenShareAudio) {
      if (this.watchedUsers.has(username)
        && this.activeWatchOwners.get(username)?.participant === p
        && this.room?.remoteParticipants.get(p.identity) === p) {
        try { (pub as any).setSubscribed(true); } catch { /**/ }
      }
      return;
    }
    if (pub.source !== Track.Source.ScreenShare) return;
    if (this.room?.remoteParticipants.get(p.identity) !== p
      || p.getTrackPublication(Track.Source.ScreenShare) !== pub) return;
    if (this.watchedUsers.has(username)) {
      const active = this.broadcastingParticipant(username);
      this.subscribeWatchSession(username, active || p);
    }
    if (this.announcedScreenSessions.has(p.identity)) return;
    this.announcedScreenSessions.add(p.identity);
    this.streamStartCbs.forEach((cb) => cb(p.identity, !!silent));
  };
  private onRemoteUnpub = (pub: TrackPublication, p: RemoteParticipant) => {
    if (pub.source !== Track.Source.ScreenShare) return;
    const username = baseUid(p.identity);
    const owner = this.activeWatchOwners.get(username);
    const publishedTrack = pub.track;
    if (publishedTrack?.kind === Track.Kind.Video) {
      try { (publishedTrack as RemoteTrack).detach().forEach((el) => el.remove()); } catch { /**/ }
    }
    this.delVideo(pub.trackSid, pub);
    const currentParticipant = this.room?.remoteParticipants.get(p.identity);
    const currentPublication = currentParticipant?.getTrackPublication(Track.Source.ScreenShare);
    const sameIdentityReplacement = currentParticipant
      && currentPublication && currentPublication !== pub
      ? currentParticipant
      : undefined;
    if (this.watchedUsers.has(username) && owner?.participant === p && owner.publication === pub) {
      if (sameIdentityReplacement) {
        // LiveKit can deliver old Unpublished after a same-participant re-publication is already
        // current. Move atomically to it without manufacturing a recovery or muting the new source.
        this.subscribeWatchSession(username, sameIdentityReplacement);
      } else {
      this.emitWatchDiagnostic(username, {
        stage: 'watch_track', outcome: 'stalled', code: 'track_missing', trackState: 'missing',
        reconnectCount: this.watchReconnectCount.get(username) || 0,
      });
      this.beginWatchRecovery(username, 'track_missing');
      this.subscribeWatchSession(username, this.broadcastingParticipant(username, p.identity));
      }
    }
    if (sameIdentityReplacement) return;
    if (!this.announcedScreenSessions.delete(p.identity)) return;
    this.streamStopCbs.forEach((cb) => cb(p.identity));
  };
  private onParticipantDisconnected = (p: RemoteParticipant) => {
    const username = baseUid(p.identity);
    const owner = this.activeWatchOwners.get(username);
    const currentParticipant = this.room?.remoteParticipants.get(p.identity);
    const sameIdentityReplacement = currentParticipant && currentParticipant !== p
      && currentParticipant.getTrackPublication(Track.Source.ScreenShare)
      ? currentParticipant
      : undefined;
    if (this.watchedUsers.has(username) && owner?.participant === p) {
      this.emitWatchDiagnostic(username, {
        stage: 'watch_track', outcome: 'stalled', code: 'track_missing', trackState: 'missing',
        reconnectCount: this.watchReconnectCount.get(username) || 0,
      });
      this.beginWatchRecovery(username, 'track_missing');
      this.subscribeWatchSession(
        username,
        sameIdentityReplacement || this.broadcastingParticipant(username, p.identity),
      );
    }
    if (sameIdentityReplacement) return;
    if (this.announcedScreenSessions.delete(p.identity)) this.streamStopCbs.forEach((cb) => cb(p.identity));
  };
  private onSub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Video) return;
    if (pub.source !== Track.Source.ScreenShare) return;
    const username = baseUid(p.identity);
    const owner = this.activeWatchOwners.get(username);
    // TrackSubscribed may settle after unwatch, room replacement or a same-session re-publication.
    // Only the exact current ScreenShare publication and exact SDK track can enter Engine.
    const exactPublication = this.isExactWatchOwner(username, p, pub);
    if (!exactPublication || pub.track !== track) {
      // If the publication object itself is still current, this is only a delayed callback for its
      // previous RemoteTrack. setSubscribed(false) would unsubscribe the replacement track too.
      this.discardRemoteTrack(track, pub, !exactPublication);
      return;
    }
    const trackState = diagnosticTrackState(track);
    if (trackState === 'ended') {
      const reconnectCount = this.watchReconnectCount.get(username) || 0;
      this.emitWatchDiagnostic(username, {
        stage: 'watch_track', outcome: 'stalled', code: 'track_missing', trackState, reconnectCount,
      });
      this.beginWatchRecovery(username, 'track_missing');
      const retry = this.ensureWatchRetryState(username, pub, p);
      this.clearWatchRetryTimer(retry);
      retry.candidateTrack = null;
      if (!retry.exhausted) retry.phase = 'waiting_subscription';
      this.discardRemoteTrack(track, pub, true);
      const alternate = this.broadcastingParticipant(username, p.identity);
      if (alternate) this.subscribeWatchSession(username, alternate);
      else this.scheduleWatchRetry(username, pub, p);
      return;
    }
    owner!.track = track;
    this.addVideo(pub.trackSid, track, username, false, pub);
    const retry = this.watchRetryStates.get(username);
    if (retry && retry.generation === (this.watchRetryGenerations.get(username) || 0)) {
      this.clearWatchRetryTimer(retry);
      retry.participant = p;
      retry.publication = pub;
      retry.candidateTrack = track;
      if (!retry.exhausted) {
        retry.phase = 'awaiting_decode';
        this.armWatchDecodeTimer(username, retry, track);
      }
    }
    const reconnectCount = this.watchReconnectCount.get(username) || 0;
    this.emitWatchDiagnostic(username, {
      stage: 'watch_track', outcome: 'ok', code: 'none', trackState, reconnectCount,
    });
  };
  private onUnsub = (track: RemoteTrack, pub: TrackPublication, p: RemoteParticipant) => {
    if (track.kind !== Track.Kind.Video) return;
    if (pub.source !== Track.Source.ScreenShare) return;
    const username = baseUid(p.identity);
    const owner = this.activeWatchOwners.get(username);
    const exact = this.isExactWatchOwner(username, p, pub) && owner?.track === track;
    if (exact) {
      // Retire exact track ownership before any SDK callbacks or retry scheduling. A duplicate late
      // Unsubscribed edge for this physical track must not reset the final bounded response window.
      owner!.track = null;
      this.emitWatchDiagnostic(username, {
        stage: 'watch_track', outcome: 'stalled', code: 'track_missing',
        trackState: track.mediaStreamTrack?.readyState === 'ended' ? 'ended' : 'missing',
        reconnectCount: this.watchReconnectCount.get(username) || 0,
      });
      this.beginWatchRecovery(username, 'track_missing');
      // An unexpected SDK unsubscribe while the logical watch is still active is recoverable.
      // Explicit unwatch removes watchedUsers before toggling the subscription, so it cannot
      // accidentally re-subscribe a stream the viewer intentionally closed.
      const retry = this.ensureWatchRetryState(username, pub, p);
      this.clearWatchRetryTimer(retry);
      retry.candidateTrack = null;
      if (!retry.exhausted) retry.phase = 'waiting_subscription';
      const alternate = this.broadcastingParticipant(username, p.identity);
      if (alternate) this.subscribeWatchSession(username, alternate);
      else this.scheduleWatchRetry(username, pub, p);
    }
    this.discardRemoteTrack(track, pub, false);
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
  onWatchDiagnostic(cb: (event: StreamWatchTransportDiagnostic) => void) {
    this.watchDiagnosticCbs.add(cb);
    return () => { this.watchDiagnosticCbs.delete(cb); };
  }
  onSeamlessSwitchFailed(cb: (streamId: string) => void) {
    this.switchFailedCbs.add(cb);
    return () => { this.switchFailedCbs.delete(cb); };
  }

  private emitWatchDiagnostic(
    streamId: string,
    event: Omit<StreamWatchTransportDiagnostic, 'streamId' | 'streamTransport'>,
  ) {
    // Keep the emitted shape closed: LiveKit participant identities, room URLs and SDK errors
    // are deliberately unavailable to diagnostic consumers.
    const diagnostic: StreamWatchTransportDiagnostic = {
      streamId,
      stage: event.stage,
      outcome: event.outcome,
      code: event.code,
      streamTransport: 'livekit',
    };
    if (event.connectionState !== undefined) diagnostic.connectionState = event.connectionState;
    if (event.iceState !== undefined) diagnostic.iceState = event.iceState;
    if (event.trackState !== undefined) diagnostic.trackState = event.trackState;
    if (event.reconnectCount !== undefined) {
      diagnostic.reconnectCount = Number.isFinite(event.reconnectCount)
        ? Math.max(0, Math.min(1000, Math.trunc(event.reconnectCount))) : 0;
    }
    this.watchDiagnosticCbs.forEach((cb) => {
      try { cb({ ...diagnostic }); } catch { /** diagnostics must not destabilize playback */ }
    });
  }
}

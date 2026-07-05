import type { Room } from 'livekit-client';
import type { VideoTransport, TreeInfo, RtpStats } from './videoTransport';
import { MediaStreamVideoHandle } from './videoTransport';
import type { StreamInfo } from '../engine';
import { getToken } from '../api';
import { detectSymmetricNat } from './natDetect';

/**
 * P2P relay-tree implementation of VideoTransport (Evolution-TZ Э2).
 *
 * Browser is always a LEAF: it only ever receives (never broadcasts, never forwards —
 * CLAUDE.md invariants 2+3). `startBroadcast` throws; the Share button was removed
 * from the UI, this is only a defensive backstop.
 *
 * Signaling: WS to `/tree` (apps/server/tree.js, Э1). Two kinds of connection:
 *  - one long-lived "discovery" socket (no `join`) that just listens for
 *    `stream-live`/`stream-end` announcements, so the member list can show a live badge
 *    without the viewer having tried to watch anything yet;
 *  - one dedicated socket per actively-watched `streamId`, joined as
 *    `role:'viewer', native:false`. The assigned parent (native peer, capacity>0) is
 *    always the SDP offerer — it holds the media; the browser only answers.
 *
 * H.264-only (CLAUDE.md invariant 4): before answering, we call
 * `setCodecPreferences` on the video transceiver so no VP8/VP9/AV1 codec makes it
 * into our SDP answer.
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

interface WatchState {
  ws: WebSocket;
  pc: RTCPeerConnection | null;
  parentId: string | null;
  closed: boolean;
  iceServers: RTCIceServer[];
}


function treeWsUrl(): string {
  const override = (import.meta as any).env?.VITE_TREE_WS_URL as string | undefined;
  const base = override || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
  const token = getToken() || '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function preferH264(pc: RTCPeerConnection) {
  const caps = (window as any).RTCRtpReceiver?.getCapabilities?.('video');
  const h264 = (caps?.codecs || []).filter((c: any) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return; // browser too old / no capability introspection — negotiate whatever the offer had
  pc.getTransceivers().forEach((t) => {
    if (t.receiver?.track?.kind !== 'video') return;
    try { t.setCodecPreferences(h264); } catch { /**/ }
  });
}

export class TreeVideoTransport implements VideoTransport {
  private me = '';
  private closed = false;
  private discoveryWs: WebSocket | null = null;
  private liveStreams = new Set<string>();
  private watches = new Map<string, WatchState>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private natProbe: Promise<boolean> = Promise.resolve(false);

  private videoTracks = new Map<string, MediaStreamVideoHandle>();
  private streamInfoByKey = new Map<string, StreamInfo>();
  private treeInfoByStream = new Map<string, TreeInfo>();

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: MediaStreamVideoHandle, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();

  /* ---------- lifecycle ---------- */
  attach(_room: Room, ctx: { me: string }) {
    this.me = ctx.me;
    this.closed = false;
    this.natProbe = detectSymmetricNat();
    this.openDiscovery();
  }
  onRoomConnected() { /* discovery socket already syncs live-stream backlog on connect */ }
  detach() {
    this.closed = true;
    if (this.discoveryWs) { try { this.discoveryWs.close(); } catch { /**/ } this.discoveryWs = null; }
    this.watches.forEach((_w, streamId) => this.unwatch(streamId));
    this.watches.clear();
    this.liveStreams.clear();
    this.videoTracks.clear();
    this.streamInfoByKey.clear();
  }

  private openDiscovery() {
    if (this.closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(treeWsUrl()); } catch { return; }
    this.discoveryWs = ws;
    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'welcome') {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) this.iceServers = msg.iceServers;
      } else if (msg.t === 'stream-live') {
        if (!this.liveStreams.has(msg.identity)) {
          this.liveStreams.add(msg.identity);
          this.streamStartCbs.forEach((cb) => cb(msg.identity, !!msg.initial));
        }
      } else if (msg.t === 'stream-end') {
        this.liveStreams.delete(msg.identity);
        this.streamStopCbs.forEach((cb) => cb(msg.identity));
      }
    };
    ws.onclose = () => { if (this.discoveryWs === ws) this.discoveryWs = null; if (!this.closed) setTimeout(() => this.openDiscovery(), 3000); };
    ws.onerror = () => { try { ws.close(); } catch { /**/ } };
  }

  /* ---------- broadcasting (browser never broadcasts — native-only, CLAUDE.md invariant 2) ---------- */
  async startBroadcast(_streamId: string, _source: MediaStream): Promise<void> {
    throw new Error('Вещание доступно только из нативного приложения');
  }
  async stopBroadcast(_streamId: string): Promise<void> { /* no-op: nothing was ever started */ }
  isBroadcasting(_streamId: string) { return false; }
  isRemoteBroadcasting(identity: string) { return this.liveStreams.has(identity); }
  async getScreenStats(_streamId: string): Promise<string | null> { return null; }

  /* ---------- watching (remote, leaf) ---------- */
  watch(streamId: string) {
    if (this.watches.has(streamId)) return;
    let ws: WebSocket;
    try { ws = new WebSocket(treeWsUrl()); } catch { return; }
    const st: WatchState = { ws, pc: null, parentId: null, closed: false, iceServers: this.iceServers };
    this.watches.set(streamId, st);

    ws.onopen = async () => {
      const symmetricNat = await this.natProbe.catch(() => false);
      try { ws.send(JSON.stringify({ t: 'join', streamId, role: 'viewer', native: false, identity: this.me, symmetricNat })); } catch { /**/ }
    };
    ws.onmessage = (ev) => this.onWatchMessage(streamId, st, ev);
    ws.onclose = () => { if (!st.closed) this.teardownWatch(streamId, st); };
    ws.onerror = () => { try { ws.close(); } catch { /**/ } };
  }
  unwatch(streamId: string) {
    const st = this.watches.get(streamId);
    if (!st) return;
    st.closed = true;
    try { st.ws.send(JSON.stringify({ t: 'leave' })); } catch { /**/ }
    try { st.ws.close(); } catch { /**/ }
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.delVideo(streamId);
  }
  private teardownWatch(streamId: string, st: WatchState) {
    if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; }
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.delVideo(streamId);
  }

  /** Последний известный tree-info (позиция в дереве) для смотрибельного стрима. */
  getTreeInfo(streamId: string): TreeInfo | null { return this.treeInfoByStream.get(streamId) || null; }

  /** Живая RTP-статистика входящего видео (Э2.1 — дебаг-панель зрителя). `null`,
   * если сейчас не смотрим этот стрим или ещё нет отчёта. */
  async getRtpStats(streamId: string): Promise<RtpStats | null> {
    const st = this.watches.get(streamId);
    if (!st?.pc) return null;
    let report: RTCStatsReport;
    try { report = await st.pc.getStats(); } catch { return null; }
    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        return {
          width: stat.frameWidth || 0,
          height: stat.frameHeight || 0,
          fps: stat.framesPerSecond || 0,
          framesDropped: stat.framesDropped || 0,
          packetsLost: stat.packetsLost || 0,
        };
      }
    }
    return null;
  }

  private onWatchMessage(streamId: string, st: WatchState, ev: MessageEvent) {
    let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case 'welcome': {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) st.iceServers = msg.iceServers;
        break;
      }
      case 'assign-parent': {
        if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; this.delVideo(streamId); }
        st.parentId = msg.parentId || null;
        break;
      }
      case 'sdp': {
        if (msg.from !== st.parentId || msg.type !== 'offer') return;
        this.onParentOffer(streamId, st, msg.sdp);
        break;
      }
      case 'ice': {
        if (msg.from !== st.parentId || !st.pc || !msg.candidate) return;
        st.pc.addIceCandidate(msg.candidate).catch(() => {});
        break;
      }
      case 'tree-info': {
        this.treeInfoByStream.set(streamId, {
          myDepth: msg.myDepth ?? 0,
          treeDepth: msg.depth ?? 0,
          children: msg.children ?? 0,
          health: msg.health || 'ok',
        });
        break;
      }
    }
  }

  private async onParentOffer(streamId: string, st: WatchState, sdp: string) {
    const pc = new RTCPeerConnection({ iceServers: st.iceServers.length ? st.iceServers : DEFAULT_ICE_SERVERS });
    st.pc = pc;
    pc.onicecandidate = (e) => {
      if (!e.candidate || !st.parentId) return;
      try { st.ws.send(JSON.stringify({ t: 'ice', streamId, to: st.parentId, candidate: e.candidate })); } catch { /**/ }
    };
    pc.ontrack = (e) => {
      if (e.track.kind !== 'video') return; // audio passthrough (game/system sound) — follow-up once a real native broadcaster (Э5) sends it
      const handle = new MediaStreamVideoHandle(e.streams[0] || new MediaStream([e.track]));
      this.addVideo(streamId, handle, streamId, false);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      preferH264(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      st.ws.send(JSON.stringify({ t: 'sdp', streamId, to: st.parentId, type: 'answer', sdp: pc.localDescription!.sdp }));
    } catch { /**/ }
  }

  /* ---------- track registry ---------- */
  getVideoTrack(key: string) { return this.videoTracks.get(key); }
  getStreams(): StreamInfo[] {
    const out: StreamInfo[] = [];
    this.videoTracks.forEach((_t, key) => { const info = this.streamInfoByKey.get(key); if (info) out.push(info); });
    return out;
  }
  private addVideo(key: string, handle: MediaStreamVideoHandle, identity: string, isLocal: boolean) {
    this.videoTracks.set(key, handle);
    this.streamInfoByKey.set(key, { key, identity, isLocal });
    this.videoTrackCbs.forEach((cb) => cb(key, handle, identity, isLocal));
  }
  private delVideo(key: string) {
    if (!this.videoTracks.has(key)) return;
    this.videoTracks.delete(key);
    this.streamInfoByKey.delete(key);
    this.videoTrackRemovedCbs.forEach((cb) => cb(key));
  }

  /* ---------- event registration ---------- */
  onStreamStart(cb: (identity: string, silent: boolean) => void) { this.streamStartCbs.add(cb); return () => { this.streamStartCbs.delete(cb); }; }
  onStreamStop(cb: (identity: string) => void) { this.streamStopCbs.add(cb); return () => { this.streamStopCbs.delete(cb); }; }
  onVideoTrack(cb: (key: string, track: MediaStreamVideoHandle, identity: string, isLocal: boolean) => void) { this.videoTrackCbs.add(cb); return () => { this.videoTrackCbs.delete(cb); }; }
  onVideoTrackRemoved(cb: (key: string) => void) { this.videoTrackRemovedCbs.add(cb); return () => { this.videoTrackRemovedCbs.delete(cb); }; }
}

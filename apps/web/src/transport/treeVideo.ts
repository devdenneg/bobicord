import type { Room } from 'livekit-client';
import type { VideoTransport, TreeInfo, RtpStats, TreeTopology } from './videoTransport';
import { MediaStreamVideoHandle } from './videoTransport';
import type { StreamInfo } from '../engine';
import { getToken } from '../api';
import { detectSymmetricNat } from './natDetect';
import {
  isTauri, startNativeWatch, stopNativeWatch, nativeWatchAnswer, nativeWatchIce, nativeWatchReparent,
  onNativeWatchOffer, onNativeWatchIce, onNativeTopology,
} from '../native';

// Ёмкость нативного relay (passthrough) — сколько зрителей он ретранслирует. Rust держит
// upstream+фанаут; webview только рендерит. Больше браузерного (транскод дорог, натив нет).
const NATIVE_RELAY_CAPACITY = 4;

interface NativeWatchState {
  pc: RTCPeerConnection | null; // локальный показ: webview answerer к Rust-offerer
  unlisten: Array<() => void>;
  closed: boolean;
}

/**
 * P2P relay-tree implementation of VideoTransport (Evolution-TZ Э2/Э8).
 *
 * The browser NEVER broadcasts (native-only, invariant 2) — `startBroadcast` throws.
 * It DOES relay as a fallback (Э8, отклонение от инв.3 по решению пользователя): a
 * browser viewer can re-serve the stream it receives to a few children by re-adding the
 * received MediaStreamTrack into child RTCPeerConnections. This is TRANSCODE relay
 * (Chromium decodes+re-encodes per hop) — worse latency/quality than native passthrough,
 * so browser capacity is kept small and scored low. In Tauri, relay is done by Rust
 * (native passthrough) and this JS path never serves children.
 *
 * Signaling: WS to `/tree` (apps/server/tree.js). Two kinds of connection:
 *  - one long-lived "discovery" socket (no `join`) that listens for
 *    `stream-live`/`stream-end` announcements (live badge without watching yet);
 *  - one dedicated socket per actively-watched `streamId`, joined as
 *    `role:'viewer', native:false, maxChildren`. The parent is always the SDP offerer
 *    (it holds media, we answer); to OUR children WE are the offerer.
 *
 * H.264-only (invariant 4): `setCodecPreferences` forces H.264 both when answering the
 * parent and when offering to children.
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
// Ёмкость браузерного relay: мало (транскод дорог по CPU/задержке). 0 при симметричном NAT.
const BROWSER_RELAY_CAPACITY = 2;

interface WatchState {
  ws: WebSocket;
  pc: RTCPeerConnection | null;   // upstream (к родителю) — мы answerer
  parentId: string | null;
  closed: boolean;
  iceServers: RTCIceServer[];
  recvVideo: MediaStreamTrack | null;   // принятые треки — переотдаём детям (Э8 relay)
  recvAudio: MediaStreamTrack | null;
  children: Map<string, RTCPeerConnection>; // downstream (к нашим детям) — мы offerer
  pendingChildren: Set<string>;   // assign-child пришёл раньше, чем появился трек
  maxChildren: number;
}


function treeWsUrl(): string {
  const override = (import.meta as any).env?.VITE_TREE_WS_URL as string | undefined;
  // В нативе location.host = tauri.localhost (bundle без reverse-proxy) — фолбэк на прод-сервер,
  // тот же, что nativeWsUrl в native.ts. Без него discovery/viewer-сокеты webview шли бы в
  // tauri.localhost → liveStreams пуст → активные стримы и LIVE-бейджи не видны в натив-приложении.
  const nativeDefault = isTauri ? 'wss://138-16-170-21.sslip.io/tree' : null;
  const base = override || nativeDefault || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
  const token = getToken() || '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

// Форс H.264 (инвариант 4) на всех видео-трансиверах PC — и на приёме от родителя
// (receiver.track video), и на отдаче детям (sender.track video, relay-хоп).
function preferH264(pc: RTCPeerConnection) {
  const caps = (window as any).RTCRtpReceiver?.getCapabilities?.('video');
  const h264 = (caps?.codecs || []).filter((c: any) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return; // browser too old / no capability introspection — negotiate whatever the offer had
  pc.getTransceivers().forEach((t) => {
    const isVideo = t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video';
    if (!isVideo) return;
    try { t.setCodecPreferences(h264); } catch { /**/ }
  });
}

export class TreeVideoTransport implements VideoTransport {
  private me = '';
  private serverId = '';
  private closed = false;
  private discoveryWs: WebSocket | null = null;
  private liveStreams = new Set<string>();
  private watches = new Map<string, WatchState>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private natProbe: Promise<boolean> = Promise.resolve(false);

  private videoTracks = new Map<string, MediaStreamVideoHandle>();
  private streamInfoByKey = new Map<string, StreamInfo>();
  private treeInfoByStream = new Map<string, TreeInfo>();
  private topologyByStream = new Map<string, TreeTopology>();
  private topologyCbs = new Set<(streamId: string) => void>();
  private nativeWatches = new Map<string, NativeWatchState>();

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: MediaStreamVideoHandle, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();

  /* ---------- lifecycle ---------- */
  attach(_room: Room, ctx: { me: string; serverId: string }) {
    this.me = ctx.me;
    this.serverId = ctx.serverId;
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
    this.nativeWatches.forEach((st, streamId) => this.nativeUnwatch(streamId, st));
    this.nativeWatches.clear();
    this.liveStreams.clear();
    this.videoTracks.clear();
    this.streamInfoByKey.clear();
    this.topologyByStream.clear();
  }

  private openDiscovery() {
    if (this.closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(treeWsUrl()); } catch { return; }
    this.discoveryWs = ws;
    // Сервер узнаёт, в каком сервере (гильдии) мы сидим, только из этого сообщения —
    // до него бэклог живых стримов не шлётся (см. tree.js onHello), а после join'а
    // вещателя используется, чтобы не разослать stream-live/stream-end в чужие серверы.
    ws.onopen = () => { try { ws.send(JSON.stringify({ t: 'hello', serverId: this.serverId })); } catch { /**/ } };
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
    if (this.watches.has(streamId) || this.nativeWatches.has(streamId)) return;
    // В Tauri видео/relay держит Rust (native passthrough): webview не джойнится в дерево
    // сам, а получает поток от локального Rust-пира через IPC (см. nativeWatch).
    if (isTauri) { this.nativeWatch(streamId); return; }
    let ws: WebSocket;
    try { ws = new WebSocket(treeWsUrl()); } catch { return; }
    const st: WatchState = {
      ws, pc: null, parentId: null, closed: false, iceServers: this.iceServers,
      recvVideo: null, recvAudio: null, children: new Map(), pendingChildren: new Set(), maxChildren: 0,
    };
    this.watches.set(streamId, st);

    ws.onopen = async () => {
      const symmetricNat = await this.natProbe.catch(() => false);
      // В Tauri видео/relay держит Rust (native passthrough) — webview только рендерит,
      // детей не обслуживает. В браузере — небольшой транскод-relay (0 при симметричном NAT).
      st.maxChildren = (isTauri || symmetricNat) ? 0 : BROWSER_RELAY_CAPACITY;
      try { ws.send(JSON.stringify({ t: 'join', streamId, role: 'viewer', native: false, maxChildren: st.maxChildren, identity: this.me, symmetricNat, serverId: this.serverId })); } catch { /**/ }
    };
    ws.onmessage = (ev) => this.onWatchMessage(streamId, st, ev);
    ws.onclose = () => { if (!st.closed) this.teardownWatch(streamId, st); };
    ws.onerror = () => { try { ws.close(); } catch { /**/ } };
  }
  unwatch(streamId: string) {
    const nst = this.nativeWatches.get(streamId);
    if (nst) { this.nativeUnwatch(streamId, nst); return; }
    const st = this.watches.get(streamId);
    if (!st) return;
    st.closed = true;
    try { st.ws.send(JSON.stringify({ t: 'leave' })); } catch { /**/ }
    try { st.ws.close(); } catch { /**/ }
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    this.closeChildren(st);
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.delVideo(streamId);
  }
  private teardownWatch(streamId: string, st: WatchState) {
    if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; }
    this.closeChildren(st);
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.delVideo(streamId);
  }
  private closeChildren(st: WatchState) {
    st.children.forEach((pc) => { try { pc.close(); } catch { /**/ } });
    st.children.clear();
    st.pendingChildren.clear();
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
      case 'assign-child': {
        // Нас назначили родителем для childId — переотдаём ему принятый поток (Э8 relay).
        if (msg.childId) this.serveChild(streamId, st, msg.childId);
        break;
      }
      case 'sdp': {
        if (msg.from === st.parentId && msg.type === 'offer') { this.onParentOffer(streamId, st, msg.sdp); return; }
        // answer от нашего ребёнка (мы ему offerer)
        const childPc = st.children.get(msg.from);
        if (childPc && msg.type === 'answer') childPc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
        break;
      }
      case 'ice': {
        if (!msg.candidate) return;
        if (msg.from === st.parentId && st.pc) { st.pc.addIceCandidate(msg.candidate).catch(() => {}); return; }
        const childPc = st.children.get(msg.from);
        if (childPc) childPc.addIceCandidate(msg.candidate).catch(() => {});
        break;
      }
      case 'drop-peer': {
        // Ребёнок ушёл/переехал — закрываем его downstream-PC.
        const childPc = st.children.get(msg.peerId);
        if (childPc) { try { childPc.close(); } catch { /**/ } st.children.delete(msg.peerId); st.pendingChildren.delete(msg.peerId); break; }
        // Иначе это наш родитель (в т.ч. корень-вещатель) пропал. Если дерево ещё живо,
        // следом придёт 'assign-parent' с новым родителем — тот хендлер закроет старый PC.
        // Если это конец вещания целиком, сервер шлёт то же сообщение каждому зрителю —
        // закрываем watch-сокет сразу (onclose делает полный teardown), иначе <video>
        // застревает на последнем кадре навсегда.
        if (msg.peerId === st.parentId) { try { st.ws.close(); } catch { /**/ } }
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
      case 'tree-topology': {
        this.setTopology(streamId, { you: msg.you ?? null, nodes: msg.nodes || [] });
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
      if (e.track.kind === 'audio') {
        st.recvAudio = e.track; // звук игры/системы — переотдаём детям (relay)
        return;
      }
      if (e.track.kind !== 'video') return;
      st.recvVideo = e.track;
      const handle = new MediaStreamVideoHandle(e.streams[0] || new MediaStream([e.track]));
      this.addVideo(streamId, handle, streamId, false);
      // Дети, назначенные до появления трека — обслуживаем теперь.
      const pending = [...st.pendingChildren];
      st.pendingChildren.clear();
      pending.forEach((childId) => this.serveChild(streamId, st, childId));
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      preferH264(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      st.ws.send(JSON.stringify({ t: 'sdp', streamId, to: st.parentId, type: 'answer', sdp: pc.localDescription!.sdp }));
    } catch { /**/ }
  }

  // Э8 relay: переотдаём принятый поток ребёнку childId (мы — offerer, транскод-хоп).
  private async serveChild(streamId: string, st: WatchState, childId: string) {
    if (st.children.has(childId)) return;
    if (!st.recvVideo) { st.pendingChildren.add(childId); return; } // ждём трек от родителя
    const pc = new RTCPeerConnection({ iceServers: st.iceServers.length ? st.iceServers : DEFAULT_ICE_SERVERS });
    st.children.set(childId, pc);
    try {
      pc.addTrack(st.recvVideo);
      if (st.recvAudio) pc.addTrack(st.recvAudio);
      preferH264(pc);
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        try { st.ws.send(JSON.stringify({ t: 'ice', streamId, to: childId, candidate: e.candidate })); } catch { /**/ }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          if (st.children.get(childId) === pc) { try { pc.close(); } catch { /**/ } st.children.delete(childId); }
        }
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      st.ws.send(JSON.stringify({ t: 'sdp', streamId, to: childId, type: 'offer', sdp: pc.localDescription!.sdp }));
    } catch {
      try { pc.close(); } catch { /**/ }
      st.children.delete(childId);
    }
  }

  /* ---------- native watch (Tauri: Rust держит upstream+relay, webview рендерит) ---------- */
  private async nativeWatch(streamId: string) {
    const st: NativeWatchState = { pc: null, unlisten: [], closed: false };
    this.nativeWatches.set(streamId, st);
    const offCb = (sid: string, sdp: string) => { if (sid === streamId && !st.closed) this.onNativeOffer(streamId, st, sdp); };
    const iceCb = (sid: string, candidate: any) => { if (sid === streamId && st.pc && candidate) st.pc.addIceCandidate(candidate).catch(() => {}); };
    const topoCb = (payload: any) => { if (payload && payload.streamId === streamId) this.setTopology(streamId, { you: payload.you ?? null, nodes: payload.nodes || [] }); };
    try {
      st.unlisten.push(await onNativeWatchOffer(offCb));
      st.unlisten.push(await onNativeWatchIce(iceCb));
      st.unlisten.push(await onNativeTopology(topoCb));
    } catch { /**/ }
    if (st.closed) { st.unlisten.forEach((u) => { try { u(); } catch { /**/ } }); return; }
    try { await startNativeWatch(streamId, this.me, this.serverId, NATIVE_RELAY_CAPACITY); }
    catch { this.nativeUnwatch(streamId, st); }
  }
  private async onNativeOffer(streamId: string, st: NativeWatchState, sdp: string) {
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers.length ? this.iceServers : DEFAULT_ICE_SERVERS });
    st.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) nativeWatchIce(e.candidate).catch(() => {}); };
    pc.ontrack = (e) => {
      if (e.track.kind !== 'video') return;
      const handle = new MediaStreamVideoHandle(e.streams[0] || new MediaStream([e.track]));
      this.addVideo(streamId, handle, streamId, false);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      preferH264(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await nativeWatchAnswer(pc.localDescription!.sdp);
    } catch { /**/ }
  }
  private nativeUnwatch(streamId: string, st: NativeWatchState) {
    st.closed = true;
    st.unlisten.forEach((u) => { try { u(); } catch { /**/ } });
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    this.nativeWatches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.topologyByStream.delete(streamId);
    this.delVideo(streamId);
    stopNativeWatch().catch(() => {});
  }

  /* ---------- topology / manual peer pick (Э8) ---------- */
  private setTopology(streamId: string, topo: TreeTopology) {
    this.topologyByStream.set(streamId, topo);
    this.topologyCbs.forEach((cb) => cb(streamId));
  }
  getTopology(streamId: string): TreeTopology | null { return this.topologyByStream.get(streamId) || null; }
  getParentId(streamId: string): string | null {
    const topo = this.topologyByStream.get(streamId);
    if (!topo || !topo.you) return null;
    return topo.nodes.find((n) => n.id === topo.you)?.parentId ?? null;
  }
  requestReparent(streamId: string, targetId: string | null) {
    if (this.nativeWatches.has(streamId)) { nativeWatchReparent(targetId).catch(() => {}); return; }
    const st = this.watches.get(streamId);
    if (st) { try { st.ws.send(JSON.stringify({ t: 'request-reparent', streamId, targetParentId: targetId })); } catch { /**/ } }
  }
  onTopology(cb: (streamId: string) => void) { this.topologyCbs.add(cb); return () => { this.topologyCbs.delete(cb); }; }

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

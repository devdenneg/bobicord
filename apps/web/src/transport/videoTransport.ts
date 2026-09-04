import type { Room, LocalVideoTrack, RemoteParticipant, RemoteTrack, TrackPublication } from 'livekit-client';
import type { StreamInfo } from '../engine';

/**
 * Transport-agnostic video pipeline contract (Evolution-TZ Э0).
 *
 * Э0: `LiveKitVideoTransport` — current LiveKit SFU behavior, unchanged.
 * Э2: `TreeVideoTransport` (P2P relay-дерево, браузер = лист) implements the same
 *     contract so `engine.ts` needs zero changes when the transport is swapped.
 *
 * `streamId` === broadcaster identity for now (1 stream per user); Э8 multi-stream
 * will widen this to a real per-stream id.
 */

/** Minimal track-like handle so non-LiveKit transports can hand StreamTile a video
 *  without it needing to know which transport produced it (StreamTile only ever
 *  calls `.attach(el)` / `.detach(el)`, cast through `as any`). */
export class MediaStreamVideoHandle {
  constructor(private stream: MediaStream) {}
  getMediaStream(): MediaStream { return this.stream; }
  attach(el?: HTMLMediaElement): HTMLMediaElement {
    const v = el || document.createElement('video');
    v.srcObject = this.stream;
    return v;
  }
  detach(el?: HTMLMediaElement): HTMLMediaElement[] {
    const els = el ? [el] : [];
    els.forEach((e) => { if (e.srcObject === this.stream) e.srcObject = null; });
    return els;
  }
}

/** Позиция листа/ретранслятора в relay-дереве (Evolution-TZ Э2.1 — дебаг-панель зрителя). */
export interface TreeInfo {
  /** Глубина ЭТОГО узла от вещателя (0 = сам вещатель, 1 = его прямой ребёнок...). */
  myDepth: number;
  /** Максимальная глубина всего дерева (общее здоровье, не личная позиция). */
  treeDepth: number;
  /** Сколько узлов ретранслируют через нас (у браузера всегда 0 — лист, инвариант 3). */
  children: number;
  health: string;
}

export interface RtpStats {
  width: number;
  height: number;
  fps: number;
  framesDropped: number;
  packetsLost: number;
  /** Средняя задержка джиттер-буфера декодера за последний интервал опроса, мс
   *  (дельта jitterBufferDelay/jitterBufferEmittedCount). Часть оценки задержки. */
  jitterBufferMs: number;
}

/** Узел relay-дерева (Э8) — для UI «у кого беру стрим» и ручного выбора пира. */
export interface TreeNode {
  id: string;
  identity: string;
  parentId: string | null;
  depth: number;
  children: number;
  capacity: number;
  native: boolean;
  /** Э9: виртуальный серверный fallback-relay (vrelay). */
  virtual?: boolean;
  /** Д4: «серверный» узел (vrelay ИЛИ рендишн-корень) — родитель=сервер → меню качества активно. */
  server?: boolean;
  broadcaster: boolean;
  availableOutgoing: number;
  rtt: number;
  loss: number;
}
export interface TreeTopology {
  /** id ЭТОГО узла в дереве (себя подсветить в UI). */
  you: string | null;
  nodes: TreeNode[];
}

/**
 * Privacy-bounded progress emitted while a viewer transport establishes or repairs playback.
 * `streamId` is a local routing key only: consumers must use it to find the owning attempt and
 * must never copy it into an uploaded diagnostic report. The transport deliberately exposes no
 * SDP, ICE candidates, URLs, peer identities or raw errors.
 */
export type StreamWatchTransportDiagnosticStage =
  | 'watch_auth'
  | 'watch_listeners'
  | 'watch_native_start'
  | 'watch_signaling'
  | 'watch_join'
  | 'watch_parent'
  | 'watch_negotiation'
  | 'watch_track'
  | 'watch_playback'
  | 'watch_recovery';

export type StreamWatchTransportDiagnosticOutcome =
  | 'started'
  | 'ok'
  | 'failed'
  | 'timed_out'
  | 'blocked'
  | 'unsupported'
  | 'cancelled'
  | 'superseded'
  | 'stalled'
  | 'recovered';

export type StreamWatchTransportDiagnosticCode =
  | 'none'
  | 'timeout'
  | 'network'
  | 'offline'
  | 'auth'
  | 'permission'
  | 'device_lost'
  | 'media_blocked'
  | 'disconnected'
  | 'sdk'
  | 'unsupported'
  | 'aborted'
  | 'unknown'
  | 'signaling_unauthorized'
  | 'signaling_forbidden'
  | 'listener_failed'
  | 'native_start_failed'
  | 'signaling_closed'
  | 'no_parent'
  | 'negotiation_failed'
  | 'ice_failed'
  | 'track_missing'
  | 'decode_timeout'
  | 'playback_waiting';

export type StreamWatchTransportConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'closed'
  | 'unknown';

export type StreamWatchTransportIceState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'closed'
  | 'unknown';

export type StreamWatchTransportTrackState = 'live' | 'ended' | 'missing' | 'unknown';
export type StreamWatchTransportKind = 'tree_web' | 'tree_native' | 'livekit';

export interface StreamWatchTransportDiagnostic {
  streamId: string;
  stage: StreamWatchTransportDiagnosticStage;
  outcome: StreamWatchTransportDiagnosticOutcome;
  code: StreamWatchTransportDiagnosticCode;
  connectionState?: StreamWatchTransportConnectionState;
  iceState?: StreamWatchTransportIceState;
  trackState?: StreamWatchTransportTrackState;
  reconnectCount?: number;
  streamTransport: StreamWatchTransportKind;
}

export interface VideoTransport {
  /** Wire room-event listeners. Call once, BEFORE `room.connect()`. */
  attach(room: Room, ctx: { me: string; serverId: string }): void;
  /** Replay already-published tracks (mirrors LiveKit's own late-subscribe pattern). Call AFTER `room.connect()` resolves. */
  onRoomConnected(): void;
  /** Unhook listeners + clear internal registries. Call from engine.disconnect(). */
  detach(): void;

  startBroadcast(streamId: string, source: MediaStream): Promise<void>;
  stopBroadcast(streamId: string): Promise<void>;
  isBroadcasting(streamId: string): boolean;
  /** Расцеп voice/view (S5): вещать надо в ГОЛОСОВУЮ комнату, а не в смотримую. Транспорт слушает
   *  события/watch на смотримой комнате (attach), но broadcast-операции целятся в этот room. Только
   *  LiveKit (браузер вещает через SFU). null = вещать в attached-комнату (обычный shared-случай). */
  setBroadcastRoom?(room: Room | null): void;
  isRemoteBroadcasting(identity: string): boolean;
  getScreenStats(streamId: string): Promise<string | null>;

  /** Д3: `quality` выбирает рендишн-дерево (`streamId::quality`). Дефолт 'source' —
   *  поведение неотличимо от «до». Д4: `pinned` — ручной выбор (авто-ABR не трогает). Смена
   *  качества = unwatch+watch. LiveKit игнорирует quality (SFU-путь, деревьев нет). */
  watch(streamId: string, quality?: string, pinned?: boolean): void;
  unwatch(streamId: string): void;
  /** Confirms that the exact attached stream produced a decoded frame. Tree transports use this
   *  stronger signal (rather than ontrack) to reset recovery backoff and retained-frame timers.
   *  `false` rejects a stale retained-frame notification from an earlier tree generation. */
  confirmPlayback?(streamId: string, candidate?: MediaStreamTrack): boolean;
  /** LiveKit-only exact ownership check for the separately attached ScreenShareAudio track. Omitting
   *  `candidate` checks the current publication; providing it also fences a late old track callback. */
  acceptsScreenAudio?(
    streamId: string,
    participant: RemoteParticipant,
    publication: TrackPublication,
    candidate?: RemoteTrack,
  ): boolean;

  /** Д4: сменить качество зрителя (меню Авто/Source/1080/720/480/360). mode='auto' — снять
   *  pin, сервер адаптирует; иначе pin на рендишн. Реализовано как unwatch+watch. Только tree. */
  setQuality?(streamId: string, mode: string): void;
  /** Д4: текущий режим качества зрителя ('auto' | 'source' | '1080'|...). LiveKit — undefined. */
  getQualityMode?(streamId: string): string | null;
  /** Д4: рендишн недоступен (агент отказал/кап/апскейл) — reason для тоста + фолбэк на source. */
  onRenditionUnavailable?(cb: (streamId: string, rendition: string, reason: string) => void): () => void;
  /** Бесшовное переключение/восстановление не доехало за конечный транспортный бюджет:
   *  Engine обязан освободить логического владельца плитки, чтобы явный повторный watch не был no-op. */
  onSeamlessSwitchFailed?(cb: (streamId: string) => void): () => void;

  /** Только TreeVideoTransport (Э2.1) — позиция в дереве и живая RTP-статистика
   *  для дебаг-панели зрителя. LiveKit-транспорт их не реализует (там SFU, нет дерева). */
  getTreeInfo?(streamId: string): TreeInfo | null;
  getRtpStats?(streamId: string): Promise<RtpStats | null>;

  /** Только TreeVideoTransport (Э8) — топология дерева, текущий родитель и ручной
   *  выбор пира зрителем. LiveKit не реализует. */
  getTopology?(streamId: string): TreeTopology | null;
  getParentId?(streamId: string): string | null;
  requestReparent?(streamId: string, targetId: string | null): void;
  onTopology?(cb: (streamId: string) => void): () => void;
  /** Сервер отклонил ручной reparent («взять»/«через сервер») — reason для тоста зрителю. */
  onReparentDenied?(cb: (streamId: string, reason: string) => void): () => void;

  /** Только TreeVideoTransport — метаданные приложения вещателя (иконка/имя окна из
   *  stream-live). LiveKit не реализует: getDisplayMedia метаданных не даёт. */
  getStreamMeta?(identity: string): { appName?: string; appIcon?: string; renditions?: string[] } | null;

  getVideoTrack(key: string): LocalVideoTrack | RemoteTrack | MediaStreamVideoHandle | undefined;
  getStreams(): StreamInfo[];

  onStreamStart(cb: (identity: string, silent: boolean) => void): () => void;
  onStreamStop(cb: (identity: string) => void): () => void;
  onVideoTrack(cb: (key: string, track: LocalVideoTrack | RemoteTrack | MediaStreamVideoHandle, identity: string, isLocal: boolean) => void): () => void;
  onVideoTrackRemoved(cb: (key: string) => void): () => void;
  /** Safe, structured watch progress. The callback must not persist its local-only `streamId`. */
  onWatchDiagnostic?(cb: (event: StreamWatchTransportDiagnostic) => void): () => void;
}

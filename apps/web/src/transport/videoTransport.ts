import type { Room, LocalVideoTrack, RemoteTrack } from 'livekit-client';
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

  watch(streamId: string): void;
  unwatch(streamId: string): void;

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
  getStreamMeta?(identity: string): { appName?: string; appIcon?: string } | null;

  getVideoTrack(key: string): LocalVideoTrack | RemoteTrack | MediaStreamVideoHandle | undefined;
  getStreams(): StreamInfo[];

  onStreamStart(cb: (identity: string, silent: boolean) => void): () => void;
  onStreamStop(cb: (identity: string) => void): () => void;
  onVideoTrack(cb: (key: string, track: LocalVideoTrack | RemoteTrack | MediaStreamVideoHandle, identity: string, isLocal: boolean) => void): () => void;
  onVideoTrackRemoved(cb: (key: string) => void): () => void;
}

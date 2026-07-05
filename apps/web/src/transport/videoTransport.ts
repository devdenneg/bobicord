import type { Room, LocalVideoTrack, RemoteTrack } from 'livekit-client';
import type { StreamInfo } from '../engine';

/**
 * Transport-agnostic video pipeline contract (Evolution-TZ Э0).
 *
 * Э0: only `LiveKitVideoTransport` exists — current LiveKit SFU behavior, unchanged.
 * Э2: `TreeVideoTransport` (P2P relay-дерево, браузер = лист) will implement the same
 *     contract so `engine.ts` needs zero changes when the transport is swapped.
 *
 * `streamId` === broadcaster identity for now (1 stream per user); Э8 multi-stream
 * will widen this to a real per-stream id.
 */
export interface VideoTransport {
  /** Wire room-event listeners. Call once, BEFORE `room.connect()`. */
  attach(room: Room, ctx: { me: string }): void;
  /** Replay already-published tracks (mirrors LiveKit's own late-subscribe pattern). Call AFTER `room.connect()` resolves. */
  onRoomConnected(): void;
  /** Unhook listeners + clear internal registries. Call from engine.disconnect(). */
  detach(): void;

  startBroadcast(streamId: string, source: MediaStream): Promise<void>;
  stopBroadcast(streamId: string): Promise<void>;
  isBroadcasting(streamId: string): boolean;
  isRemoteBroadcasting(identity: string): boolean;
  getScreenStats(streamId: string): Promise<string | null>;

  watch(streamId: string): void;
  unwatch(streamId: string): void;

  getVideoTrack(key: string): LocalVideoTrack | RemoteTrack | undefined;
  getStreams(): StreamInfo[];

  onStreamStart(cb: (identity: string, silent: boolean) => void): () => void;
  onStreamStop(cb: (identity: string) => void): () => void;
  onVideoTrack(cb: (key: string, track: LocalVideoTrack | RemoteTrack, identity: string, isLocal: boolean) => void): () => void;
  onVideoTrackRemoved(cb: (key: string) => void): () => void;
}

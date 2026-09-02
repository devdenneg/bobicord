export type MediaPlayOutcome = 'playing' | 'blocked' | 'waiting';

type SinkTarget = object & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export type AudioSinkRouteOutcome = 'applied' | 'unsupported' | 'failed' | 'timed-out' | 'superseded';

export interface AudioSinkRouteOptions {
  timeoutMs?: number;
  normalize?: (sinkId: string) => string | Promise<string>;
}

type NavigatorLike = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>;

type AppleVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture' | 'fullscreen') => void;
  webkitPresentationMode?: 'inline' | 'picture-in-picture' | 'fullscreen';
};

type AppleFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

type AppleDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
};

export function effectiveStreamGain(masterPercent: number, streamVolume: number, silent = false): number {
  if (silent) return 0;
  const master = Number.isFinite(masterPercent) ? Math.max(0, Math.min(100, masterPercent)) / 100 : 1;
  const personal = Number.isFinite(streamVolume) ? Math.max(0, Math.min(1, streamVolume)) : 1;
  return master * personal;
}

type VolumeTrack = { setVolume?: (value: number) => void };

/** Applies gain to the exact attached LiveKit track; a same-username stale participant is ignored. */
export function applyExactScreenAudioGain(
  exactTrack: VolumeTrack | null | undefined,
  participantTrack: unknown,
  applyParticipant: (() => void) | undefined,
  gain: number,
) {
  try { exactTrack?.setVolume?.(gain); } catch { /** matching participant fallback may still apply */ }
  if (!applyParticipant || (exactTrack && participantTrack !== exactTrack)) return;
  try { applyParticipant(); } catch { /** playback recovery will retry */ }
}

export function isAutoplayBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = String((error as { name?: unknown }).name || '');
  return name === 'NotAllowedError' || name === 'SecurityError';
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(fallback);
    });
  });
}

const AUDIO_OUTPUT_ROUTE_TIMEOUT_MS = 1_500;
interface SinkRouteState {
  generation: number;
  desired: string;
  normalize: (sinkId: string) => string | Promise<string>;
  timeoutMs: number;
  queue: Promise<void>;
}
const sinkRouteStates = new WeakMap<object, SinkRouteState>();

type SinkOperationResult<T> =
  | { outcome: 'resolved'; value: T }
  | { outcome: 'failed' | 'timed-out' };

function settleSinkOperation<T>(promise: Promise<T>, timeoutMs: number): Promise<SinkOperationResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ outcome: 'timed-out' });
    }, Math.max(0, timeoutMs));
    promise.then((value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ outcome: 'resolved', value });
    }, () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ outcome: 'failed' });
    });
  });
}

/**
 * Serializes output changes per exact media target. A timed-out browser promise cannot block the
 * settings UI forever; if that old promise eventually applies after a newer selection, the latest
 * desired route is queued once more so the stale hardware result cannot remain authoritative.
 */
function enqueueAudioSinkRoute(
  target: SinkTarget,
  setSinkId: (sinkId: string) => Promise<void>,
  state: SinkRouteState,
  sinkId: string,
  generation: number,
  normalize: (sinkId: string) => string | Promise<string>,
  timeoutMs: number,
): Promise<AudioSinkRouteOutcome> {
  const run = state.queue.catch(() => {}).then(async (): Promise<AudioSinkRouteOutcome> => {
    if (generation !== state.generation) return 'superseded';
    let normalization: SinkOperationResult<string>;
    try {
      normalization = await settleSinkOperation(Promise.resolve(normalize(sinkId)), timeoutMs);
    } catch {
      return 'failed';
    }
    if (normalization.outcome !== 'resolved') return normalization.outcome;
    // A newer selection that arrived while device enumeration was pending owns the hardware.
    if (generation !== state.generation) return 'superseded';
    let raw: Promise<void>;
    try { raw = Promise.resolve(setSinkId.call(target, normalization.value)); }
    catch { return 'failed'; }
    const result = await settleSinkOperation(raw, timeoutMs);
    if (result.outcome === 'resolved') return 'applied';
    if (result.outcome === 'failed') return 'failed';
    // A rejected promise changed nothing. A promise that merely exceeded the deadline may still
    // apply later; only that late success needs to repair a now-stale route.
    void raw.then(() => {
      if (generation === state.generation) return;
      const currentSetSinkId = target.setSinkId;
      if (typeof currentSetSinkId !== 'function') return;
      // Append a repair for the current generation without minting a newer generation. That keeps
      // the real latest caller's result authoritative instead of making it look "superseded" by
      // this internal replay; a future explicit selection still invalidates the repair normally.
      void enqueueAudioSinkRoute(
        target,
        currentSetSinkId,
        state,
        state.desired,
        state.generation,
        state.normalize,
        state.timeoutMs,
      );
    }, () => {});
    return 'timed-out';
  });
  state.queue = run.then(() => {}, () => {});
  return run;
}

export function routeAudioSinkTarget(
  target: SinkTarget,
  sinkId: string,
  options: AudioSinkRouteOptions = {},
): Promise<AudioSinkRouteOutcome> {
  const setSinkId = target.setSinkId;
  if (typeof setSinkId !== 'function') return Promise.resolve('unsupported'); // Safari follows the system route.
  const normalize = options.normalize ?? ((value: string) => value);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs as number)
    : AUDIO_OUTPUT_ROUTE_TIMEOUT_MS;
  let state = sinkRouteStates.get(target);
  if (!state) {
    state = { generation: 0, desired: sinkId, normalize, timeoutMs, queue: Promise.resolve() };
    sinkRouteStates.set(target, state);
  }
  state.desired = sinkId;
  state.normalize = normalize;
  state.timeoutMs = timeoutMs;
  const generation = ++state.generation;
  return enqueueAudioSinkRoute(target, setSinkId, state, sinkId, generation, normalize, timeoutMs);
}

/** Coalesces identical output selections for one exact media element until an explicit retry. */
export class ExactMediaOutputRouteGate<TTarget extends object = object> {
  private readonly desired = new WeakMap<TTarget, string>();

  claim(target: TTarget, sinkId: string, force = false): boolean {
    if (!force && this.desired.get(target) === sinkId) return false;
    this.desired.set(target, sinkId);
    return true;
  }

  forget(target: TTarget): void {
    this.desired.delete(target);
  }
}

/** Keeps a playback confirmation tied to the exact watch attempt and track that produced it. */
export class StreamWatchPlaybackGate {
  private generations = new Map<string, number>();
  private attempts = new Map<string, { generation: number; trackKeys: Set<string> }>();

  begin(identity: string): number {
    const generation = (this.generations.get(identity) || 0) + 1;
    this.generations.set(identity, generation);
    this.attempts.set(identity, { generation, trackKeys: new Set() });
    return generation;
  }

  acceptTrack(identity: string, trackKey: string): number {
    const attempt = this.attempts.get(identity);
    if (!attempt || !trackKey) return 0;
    attempt.trackKeys.add(trackKey);
    return attempt.generation;
  }

  generationFor(identity: string, trackKey: string): number {
    const attempt = this.attempts.get(identity);
    return attempt?.trackKeys.has(trackKey) ? attempt.generation : 0;
  }

  confirms(identity: string, trackKey: string, generation: number): boolean {
    const attempt = this.attempts.get(identity);
    return !!attempt && generation > 0 && attempt.generation === generation && attempt.trackKeys.has(trackKey);
  }

  end(identity: string) { this.attempts.delete(identity); }
  clear() { this.attempts.clear(); }
}

export async function playMediaElement(element: HTMLMediaElement, timeoutMs = 3_000): Promise<MediaPlayOutcome> {
  try {
    const attempt = element.play();
    if (attempt && typeof attempt.then === 'function') {
      const outcome = await settleWithin(
        attempt.then(() => 'playing' as const, (error) => (isAutoplayBlocked(error) ? 'blocked' as const : 'waiting' as const)),
        timeoutMs,
        'waiting' as const,
      );
      return outcome;
    }
    return 'playing';
  } catch (error) {
    return isAutoplayBlocked(error) ? 'blocked' : 'waiting';
  }
}

interface ExactAsyncActionState {
  ordinary?: Promise<boolean>;
  gesture?: Promise<boolean>;
  gestureRetry?: Promise<boolean>;
  gestureToken?: number;
  gestureRetryToken?: number;
}

export interface ExactAsyncActionAttempt {
  started: boolean;
  outcome: Promise<boolean>;
}

/**
 * Keeps one browser async action owner on the exact target. WebKit can leave a non-gesture promise
 * pending across a page/radio transition; watchdog retries share that physical call. Two bounded
 * gesture lanes allow a second real tap after an immediately-backgrounded first tap, while any
 * further taps share the exact retry instead of accumulating native browser promises.
 */
export class ExactAsyncActionCoordinator<TTarget extends object> {
  private readonly states = new WeakMap<TTarget, ExactAsyncActionState>();

  acquire(
    target: TTarget,
    play: (current: TTarget) => void | PromiseLike<void>,
    explicitGesture = false,
    onSuccess?: () => void,
    gestureToken = 0,
  ): ExactAsyncActionAttempt {
    let state = this.states.get(target);
    if (!state) {
      state = {};
      this.states.set(target, state);
    }
    if (explicitGesture && gestureToken) {
      if (state.gestureToken === gestureToken && state.gesture)
        return { started: false, outcome: state.gesture };
      if (state.gestureRetryToken === gestureToken && state.gestureRetry)
        return { started: false, outcome: state.gestureRetry };
    }
    const lane: 'ordinary' | 'gesture' | 'gestureRetry' = !explicitGesture
      ? 'ordinary'
      : (state.gesture ? 'gestureRetry' : 'gesture');
    if (state[lane]) return { started: false, outcome: state[lane] };

    let raw: Promise<void>;
    try {
      // Invoke synchronously: moving an explicit-gesture play() into a microtask loses transient
      // user activation in WebKit even though the resulting promise itself is asynchronous.
      raw = Promise.resolve(play(target));
    } catch (error) {
      raw = Promise.reject(error);
    }
    const owner = raw.then(() => true, () => false);
    state[lane] = owner;
    if (lane === 'gesture') state.gestureToken = gestureToken;
    else if (lane === 'gestureRetry') state.gestureRetryToken = gestureToken;
    void owner.then((ok) => {
      if (this.states.get(target) !== state || state![lane] !== owner) return;
      delete state![lane];
      if (lane === 'gesture') delete state!.gestureToken;
      else if (lane === 'gestureRetry') delete state!.gestureRetryToken;
      if (!state!.ordinary && !state!.gesture && !state!.gestureRetry) this.states.delete(target);
      if (ok) { try { onSuccess?.(); } catch { /** playback success observers are optional */ } }
    });
    return { started: true, outcome: owner };
  }

  request(
    target: TTarget,
    play: (current: TTarget) => void | PromiseLike<void>,
    explicitGesture = false,
    onSuccess?: () => void,
    gestureToken = 0,
  ): boolean {
    return this.acquire(target, play, explicitGesture, onSuccess, gestureToken).started;
  }

  forget(target: TTarget): void {
    // The native promise is not cancellable. Removing exact ownership prevents its late settlement
    // from affecting a replacement element and lets the detached target be collected afterwards.
    this.states.delete(target);
  }
}

export class ExactMediaPlayCoordinator<TTarget extends object> extends ExactAsyncActionCoordinator<TTarget> {}

type ExactWebAudioMixRoom = object & {
  options?: {
    webAudioMix?: boolean | { audioContext?: AudioContext };
  };
};

/**
 * Reads the custom mixer context through the exact LiveKit 2.20 Room runtime shape. Engine uses
 * this only as a recovery fence: a boolean/unknown shape is not silently treated as rebound.
 */
export function exactWebAudioMixContext(room: object): AudioContext | null {
  const mix = (room as ExactWebAudioMixRoom).options?.webAudioMix;
  return mix && typeof mix === 'object' && 'audioContext' in mix && mix.audioContext
    ? mix.audioContext
    : null;
}

/**
 * Atomically points a set of exact LiveKit Rooms at a replacement mixer context. Only a closed
 * context (or the replacement itself) may be overwritten; a different live mixer indicates an
 * SDK/runtime ownership change and fails closed. Best-effort rollback avoids splitting rooms when
 * an upgraded/frozen options object rejects a write midway through the set.
 */
export function rebindExactWebAudioMixContexts(
  rooms: Iterable<object>,
  replacement: AudioContext,
): boolean {
  const changes: Array<{ mix: { audioContext?: AudioContext }; previous: AudioContext }> = [];
  for (const room of rooms) {
    const mix = (room as ExactWebAudioMixRoom).options?.webAudioMix;
    if (!mix || typeof mix !== 'object' || !('audioContext' in mix) || !mix.audioContext) return false;
    const previous = mix.audioContext;
    if (previous !== replacement && previous.state !== 'closed') return false;
    if (previous !== replacement) changes.push({ mix, previous });
  }
  let applied = 0;
  try {
    for (const change of changes) {
      change.mix.audioContext = replacement;
      if (change.mix.audioContext !== replacement) throw new Error('LiveKit mixer context is immutable');
      applied++;
    }
    return true;
  } catch {
    for (let index = applied - 1; index >= 0; index--) {
      try { changes[index].mix.audioContext = changes[index].previous; } catch { /** fail closed */ }
    }
    return false;
  }
}

export async function playMediaElementCoordinated<TElement extends HTMLMediaElement>(
  coordinator: ExactMediaPlayCoordinator<TElement>,
  element: TElement,
  explicitGesture = false,
  timeoutMs = 3_000,
): Promise<MediaPlayOutcome> {
  const attempt = coordinator.acquire(element, (current) => current.play(), explicitGesture);
  return await settleWithin(attempt.outcome, timeoutMs, false) ? 'playing' : 'waiting';
}

/** iPhone/iPad lock HTMLMediaElement.volume. Safari 26 exposes :volume-locked;
 *  the platform fallback keeps older installed PWAs on the WebAudio path too. */
export function mediaElementVolumeLocked(
  element: Pick<Element, 'matches'>,
  nav: NavigatorLike | null = typeof navigator === 'undefined' ? null : navigator,
): boolean {
  try { if (element.matches(':volume-locked')) return true; } catch { /** selector is newer than this WebKit */ }
  const ua = nav?.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua)
    || (nav?.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
}

interface StreamAudioControllerOptions {
  preferWebAudio?: boolean;
  audioContextFactory?: () => AudioContext;
  onNeedsUnlock?: () => void;
  onPlaybackReady?: () => void;
  onOutputRouteFailure?: (outcome: AudioSinkRouteOutcome) => boolean | void;
  shareContext?: boolean;
}

let sharedTreeAudioContext: AudioContext | null = null;
let sharedTreeAudioContextRefs = 0;
const exactTreeAudioContextResumes = new ExactAsyncActionCoordinator<AudioContext>();
let treeStreamOutputSink = 'default';
const treeStreamAudioControllers = new Set<TreeStreamAudioController>();
const notifiedTreeOutputFailures = new WeakMap<SinkTarget, string>();

async function routeTreeOutputTarget(
  target: SinkTarget,
  sinkId: string,
  reportInheritedFailure = false,
): Promise<AudioSinkRouteOutcome> {
  // Returning to the system route ends the failed custom-selection episode even if the browser
  // reports `unsupported` (Safari follows the OS route without setSinkId). A later selection of
  // the same device must be allowed to report a fresh disconnect.
  if (sinkId === 'default') notifiedTreeOutputFailures.delete(target);
  const outcome = await routeAudioSinkTarget(target, sinkId);
  // A late result belongs only to the exact inherited route that requested it. A newer Settings
  // selection must never be reset by an older tile that finished routing afterwards.
  if (treeStreamOutputSink !== sinkId) return outcome;
  if (outcome === 'applied') {
    notifiedTreeOutputFailures.delete(target);
    return outcome;
  }
  if (sinkId === 'default' || outcome === 'superseded'
    || (outcome !== 'failed' && outcome !== 'timed-out' && outcome !== 'unsupported')) return outcome;
  // Shared AudioContexts can be inherited by several tiles at once. Report one hardware failure
  // for the target/sink pair; applyOutput() will perform the authoritative aggregate fallback.
  if (reportInheritedFailure && notifiedTreeOutputFailures.get(target) !== sinkId) {
    // The controller which enqueued this shared-context route may be disposed before the browser
    // rejects setSinkId. Dispatch to any live owner of the exact target and mark it handled only
    // after that owner accepts responsibility for the aggregate Engine fallback.
    const handled = [...treeStreamAudioControllers]
      .some((controller) => controller.reportInheritedOutputFailure(target, sinkId, outcome));
    if (handled) notifiedTreeOutputFailures.set(target, sinkId);
  }
  return outcome;
}

function acquireSharedTreeAudioContext(factory: () => AudioContext): AudioContext {
  if (!sharedTreeAudioContext || sharedTreeAudioContext.state === 'closed') {
    if (sharedTreeAudioContext) exactTreeAudioContextResumes.forget(sharedTreeAudioContext);
    sharedTreeAudioContext = factory();
    sharedTreeAudioContextRefs = 0;
  }
  sharedTreeAudioContextRefs++;
  return sharedTreeAudioContext;
}

function closeAudioContext(context: AudioContext) {
  exactTreeAudioContextResumes.forget(context);
  try { void context.close().catch(() => {}); } catch { /** already closed */ }
}

function releaseSharedTreeAudioContext(context: AudioContext) {
  if (context !== sharedTreeAudioContext) { closeAudioContext(context); return; }
  sharedTreeAudioContextRefs = Math.max(0, sharedTreeAudioContextRefs - 1);
  if (sharedTreeAudioContextRefs !== 0) return;
  sharedTreeAudioContext = null;
  closeAudioContext(context);
}

/**
 * Routes a tree/P2P stream's audio through a GainNode on Apple mobile, where
 * HTMLMediaElement.volume is locked. The video element stays muted for the
 * whole WebAudio lifetime, so there is never a second unscaled audio path.
 */
export class TreeStreamAudioController {
  private gainValue = 1;
  private readonly directVolumeLocked: boolean;
  private preferWebAudio: boolean;
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private sourceStream: MediaStream | null = null;
  private currentTrack: MediaStreamTrack | null = null;
  private disposed = false;
  private readonly audioContextFactory: () => AudioContext;
  private readonly onNeedsUnlock?: () => void;
  private readonly onPlaybackReady?: () => void;
  private readonly onOutputRouteFailure?: (outcome: AudioSinkRouteOutcome) => boolean | void;
  private readonly shareContext: boolean;

  private readonly onTracksChanged = () => {
    this.syncTracks();
    if (this.currentTrack && this.preferWebAudio && this.context?.state !== 'running') this.onNeedsUnlock?.();
  };

  private readonly onCurrentTrackEnded = () => {
    if (this.currentTrack?.readyState === 'ended') this.syncTracks();
  };

  private readonly onContextStateChange = () => {
    if (this.disposed || !this.currentTrack) return;
    if (this.context?.state === 'running') this.onPlaybackReady?.();
    else this.onNeedsUnlock?.();
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    options: StreamAudioControllerOptions = {},
  ) {
    this.directVolumeLocked = mediaElementVolumeLocked(video);
    this.preferWebAudio = options.preferWebAudio ?? this.directVolumeLocked;
    this.onNeedsUnlock = options.onNeedsUnlock;
    this.onPlaybackReady = options.onPlaybackReady;
    this.onOutputRouteFailure = options.onOutputRouteFailure;
    this.shareContext = options.shareContext ?? !options.audioContextFactory;
    this.audioContextFactory = options.audioContextFactory ?? (() => {
      const Constructor = globalThis.AudioContext
        || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error('WebAudio unavailable');
      return new Constructor();
    });
    treeStreamAudioControllers.add(this);
    stream.addEventListener('addtrack', this.onTracksChanged);
    stream.addEventListener('removetrack', this.onTracksChanged);
    this.syncTracks();
    if (!this.preferWebAudio) this.routeInheritedOutput(this.video);
  }

  get usesWebAudio(): boolean { return this.preferWebAudio; }

  private disconnectSource() {
    this.currentTrack?.removeEventListener('ended', this.onCurrentTrackEnded);
    this.currentTrack = null;
    try { this.sourceNode?.disconnect(); } catch { /** already disconnected */ }
    this.sourceNode = null;
    this.sourceStream = null;
  }

  private routeInheritedOutput(target: SinkTarget) {
    const requested = treeStreamOutputSink;
    void routeTreeOutputTarget(target, requested, true);
  }

  reportInheritedOutputFailure(
    target: SinkTarget,
    requested: string,
    outcome: AudioSinkRouteOutcome,
  ): boolean {
    if (this.disposed || treeStreamOutputSink !== requested || this.outputSinkTarget() !== target
      || !this.onOutputRouteFailure) return false;
    try { return this.onOutputRouteFailure(outcome) !== false; }
    catch { return false; }
  }

  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context;
    if (this.context) this.releaseContext();
    const context = this.shareContext
      ? acquireSharedTreeAudioContext(this.audioContextFactory)
      : this.audioContextFactory();
    this.context = context;
    if (typeof context.addEventListener === 'function') context.addEventListener('statechange', this.onContextStateChange);
    else context.onstatechange = this.onContextStateChange;
    this.routeInheritedOutput(context);
    return context;
  }

  private releaseContext() {
    const context = this.context;
    if (!context) return;
    if (typeof context.removeEventListener === 'function') context.removeEventListener('statechange', this.onContextStateChange);
    else if (context.onstatechange === this.onContextStateChange) context.onstatechange = null;
    this.context = null;
    if (this.shareContext) releaseSharedTreeAudioContext(context);
    else closeAudioContext(context);
  }

  private useElementFallback(track: MediaStreamTrack | null = this.currentTrack) {
    this.preferWebAudio = false;
    this.disconnectSource();
    try { this.gainNode?.disconnect(); } catch { /** already disconnected */ }
    this.gainNode = null;
    this.releaseContext();
    this.currentTrack = track;
    track?.addEventListener('ended', this.onCurrentTrackEnded, { once: true });
    this.applyElementGain();
    this.routeInheritedOutput(this.video);
  }

  private retainVolumeLockedWebAudio(track: MediaStreamTrack | null = this.currentTrack) {
    // iPhone/iPad ignore HTMLMediaElement.volume. Unmuting after a mixer construction failure would
    // therefore turn any saved master/per-stream gain into full-volume audio. Keep the direct path
    // fail-closed and retain WebAudio ownership so the next explicit playback retry can rebuild it.
    this.disconnectSource();
    try { this.gainNode?.disconnect(); } catch { /** partially constructed graph */ }
    this.gainNode = null;
    this.releaseContext();
    this.currentTrack = track;
    track?.addEventListener('ended', this.onCurrentTrackEnded, { once: true });
    this.video.muted = true;
    if (track && this.gainValue > 0) this.onNeedsUnlock?.();
  }

  private applyElementGain() {
    this.video.volume = Math.max(0, Math.min(1, this.gainValue));
    this.video.muted = this.gainValue <= 0;
  }

  /**
   * WebKit may close an AudioContext while an installed PWA is backgrounded. Rebuild the graph
   * around the still-live exact track instead of leaving every later Retry bound to that dead
   * context. Shared controllers migrate one by one to the single replacement context.
   */
  private rebuildClosedContext() {
    this.disconnectSource();
    try { this.gainNode?.disconnect(); } catch { /** the old context already tore its graph down */ }
    this.gainNode = null;
    this.releaseContext();
    this.syncTracks();
  }

  syncTracks() {
    if (this.disposed) return;
    const next = this.stream.getAudioTracks().find((track) => track.readyState !== 'ended') || null;
    if (next === this.currentTrack) return;
    this.disconnectSource();
    if (!next) {
      // Preserve the ordinary desktop tree contract before attach: a video-first MediaStream has
      // no sound yet, and leaving its direct path unmuted lets a later audio track become audible
      // at the same srcObject boundary. Apple volume-locked media must stay muted because WebAudio
      // is its only scaled path; addtrack will build and unlock that graph.
      this.video.volume = Math.max(0, Math.min(1, this.gainValue));
      this.video.muted = this.preferWebAudio || this.gainValue <= 0;
      return;
    }
    this.currentTrack = next;
    next.addEventListener('ended', this.onCurrentTrackEnded, { once: true });
    if (!this.preferWebAudio) { this.applyElementGain(); return; }
    try {
      const context = this.ensureContext();
      if (!this.gainNode) {
        this.gainNode = context.createGain();
        this.gainNode.connect(context.destination);
      }
      this.sourceStream = new MediaStream([next]);
      this.sourceNode = context.createMediaStreamSource(this.sourceStream);
      this.sourceNode.connect(this.gainNode);
      this.video.muted = true;
      this.setGain(this.gainValue);
    } catch {
      if (this.directVolumeLocked) this.retainVolumeLockedWebAudio(next);
      else this.useElementFallback(next);
    }
  }

  setGain(value: number) {
    const previous = this.gainValue;
    this.gainValue = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    if (!this.preferWebAudio) {
      if (this.currentTrack) this.applyElementGain();
      else { this.video.volume = this.gainValue; this.video.muted = this.gainValue <= 0; }
      return;
    }
    this.video.muted = true;
    if (!this.gainNode || !this.context) {
      if (previous <= 0 && this.gainValue > 0) this.onNeedsUnlock?.();
      return;
    }
    try { this.gainNode.gain.setValueAtTime(this.gainValue, this.context.currentTime); }
    catch { this.gainNode.gain.value = this.gainValue; }
    if (previous <= 0 && this.gainValue > 0 && this.context.state !== 'running') this.onNeedsUnlock?.();
  }

  async resume(timeoutMs = 1_500, explicitGesture = false): Promise<boolean> {
    if (this.disposed || !this.currentTrack || !this.preferWebAudio) return true;
    let context = this.context;
    if (!context || context.state === 'closed') {
      this.rebuildClosedContext();
      // A construction failure deliberately switches to the audible element fallback; a track
      // that ended during backgrounding also has no audio context left to unlock.
      if (!this.currentTrack || !this.preferWebAudio) return true;
      context = this.context;
      if (!context || context.state === 'closed') return false;
    }
    if (context.state !== 'running') {
      const attempt = exactTreeAudioContextResumes.acquire(
        context,
        (current) => current.resume(),
        explicitGesture,
      );
      if (!await settleWithin(attempt.outcome, timeoutMs, false)) return false;
    }
    return context.state === 'running';
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    treeStreamAudioControllers.delete(this);
    this.stream.removeEventListener('addtrack', this.onTracksChanged);
    this.stream.removeEventListener('removetrack', this.onTracksChanged);
    this.disconnectSource();
    try { this.gainNode?.disconnect(); } catch { /** already disconnected */ }
    this.gainNode = null;
    this.releaseContext();
    // The owning effect detaches srcObject immediately after this cleanup.
    this.video.muted = true;
  }

  outputSinkTarget(): SinkTarget | null {
    if (this.disposed) return null;
    return this.preferWebAudio ? this.context : this.video;
  }
}

/** Updates every live tree/P2P tile and becomes the initial route for tracks arriving later. */
export async function setTreeStreamOutputSink(sinkId: string): Promise<AudioSinkRouteOutcome> {
  treeStreamOutputSink = sinkId || 'default';
  const targets = new Set<SinkTarget>();
  treeStreamAudioControllers.forEach((controller) => {
    const target = controller.outputSinkTarget();
    if (target) targets.add(target); // shared AudioContext is switched exactly once.
  });
  if (!targets.size) return 'applied'; // future controllers inherit treeStreamOutputSink on creation.
  const outcomes = await Promise.all([...targets].map((target) => routeTreeOutputTarget(target, treeStreamOutputSink)));
  // A partially routed tree is not a successful device switch: every audible target must agree.
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('timed-out')) return 'timed-out';
  if (outcomes.includes('unsupported')) return 'unsupported';
  if (outcomes.includes('applied')) return 'applied';
  return 'superseded';
}

async function awaitOptional(result: void | Promise<void>): Promise<void> {
  if (result && typeof (result as Promise<void>).then === 'function') await result;
}

export async function toggleStreamFullscreen(container: HTMLElement, video: HTMLVideoElement): Promise<boolean> {
  const doc = document as AppleDocument;
  if (doc.fullscreenElement && typeof doc.exitFullscreen === 'function') {
    try { await doc.exitFullscreen(); return true; } catch { return false; }
  }
  if (doc.webkitFullscreenElement && typeof doc.webkitExitFullscreen === 'function') {
    try { await awaitOptional(doc.webkitExitFullscreen()); return true; } catch { return false; }
  }
  if (typeof container.requestFullscreen === 'function') {
    try { await container.requestFullscreen(); return true; } catch { /** try the WebKit video fallback */ }
  }
  const appleContainer = container as AppleFullscreenElement;
  if (typeof appleContainer.webkitRequestFullscreen === 'function') {
    try { await awaitOptional(appleContainer.webkitRequestFullscreen()); return true; } catch { /** try video fullscreen */ }
  }
  const appleVideo = video as AppleVideoElement;
  if (typeof appleVideo.webkitEnterFullscreen === 'function') {
    try { appleVideo.webkitEnterFullscreen(); return true; } catch { /** safe no-op below */ }
  }
  return false;
}

export async function toggleStreamPictureInPicture(video: HTMLVideoElement): Promise<boolean> {
  const doc = document;
  const appleVideo = video as AppleVideoElement;
  if (doc.pictureInPictureElement && typeof doc.exitPictureInPicture === 'function') {
    try { await doc.exitPictureInPicture(); return true; } catch { return false; }
  }
  if (typeof video.requestPictureInPicture === 'function') {
    try { await video.requestPictureInPicture(); return true; } catch { /** try WebKit presentation mode */ }
  }
  if (typeof appleVideo.webkitSetPresentationMode === 'function') {
    try {
      appleVideo.webkitSetPresentationMode(
        appleVideo.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture',
      );
      return true;
    } catch { /** safe no-op below */ }
  }
  return false;
}

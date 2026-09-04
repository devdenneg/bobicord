export type MediaPlayOutcome = 'playing' | 'blocked' | 'waiting';

type SinkTarget = object & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export type AudioSinkRouteOutcome = 'applied' | 'unsupported' | 'failed' | 'timed-out' | 'superseded';

export type AudioSinkRouteOperation = 'enumerate' | 'set_sink';
export type AudioSinkRouteFailureCode =
  | 'timeout' | 'permission' | 'device_lost' | 'unsupported' | 'aborted' | 'invalid_state' | 'unknown';

export interface AudioSinkRouteFailure {
  operation: AudioSinkRouteOperation;
  outcome: 'unsupported' | 'failed' | 'timed-out';
  code: AudioSinkRouteFailureCode;
}

export interface AudioSinkRouteOptions {
  timeoutMs?: number;
  normalize?: (sinkId: string) => string | Promise<string>;
  /** Re-resolve and reapply a logical route after an actual OS device-change edge. */
  force?: boolean;
  /** Receives fixed categories only; browser error objects and hardware identifiers never escape. */
  onFailure?: (failure: AudioSinkRouteFailure) => void;
}

/**
 * A platform without setSinkId already follows the system route, so `unsupported` confirms only
 * logical default. Failed, timed-out and superseded writes never prove which physical route won.
 */
export function audioSinkRoutesConfirmed(
  requested: string,
  outcomes: readonly AudioSinkRouteOutcome[],
): boolean {
  return outcomes.every((outcome) => outcome === 'applied'
    || (requested === 'default' && outcome === 'unsupported'));
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

/** Extends one pending first-frame deadline without ever shortening it or exceeding a hard cap. */
export function boundedWatchRecoveryDeadline(
  startedAt: number,
  currentDeadlineAt: number,
  recoveryAt: number,
  recoveryGraceMs: number,
  maxDurationMs: number,
): number {
  return Math.min(
    startedAt + Math.max(0, maxDurationMs),
    Math.max(currentDeadlineAt, recoveryAt + Math.max(0, recoveryGraceMs)),
  );
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
  applied?: string;
  failedDesired?: string;
  normalize: (sinkId: string) => string | Promise<string>;
  timeoutMs: number;
  onFailure?: (failure: AudioSinkRouteFailure) => void;
  queue: Promise<void>;
}
const sinkRouteStates = new WeakMap<object, SinkRouteState>();

type SinkOperationResult<T> =
  | { outcome: 'resolved'; value: T }
  | { outcome: 'failed'; code: AudioSinkRouteFailureCode }
  | { outcome: 'timed-out'; code: 'timeout' };

function classifyAudioSinkFailure(error: unknown): AudioSinkRouteFailureCode {
  const name = error && typeof error === 'object' && 'name' in error
    && typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'NotReadableError')
    return 'device_lost';
  if (name === 'NotSupportedError') return 'unsupported';
  if (name === 'AbortError') return 'aborted';
  if (name === 'InvalidStateError') return 'invalid_state';
  return 'unknown';
}

function reportAudioSinkFailure(
  observer: AudioSinkRouteOptions['onFailure'],
  operation: AudioSinkRouteOperation,
  outcome: 'unsupported' | 'failed' | 'timed-out',
  code: AudioSinkRouteFailureCode,
) {
  try { observer?.({ operation, outcome, code }); } catch { /** diagnostics cannot affect routing */ }
}

function settleSinkOperation<T>(promise: Promise<T>, timeoutMs: number): Promise<SinkOperationResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ outcome: 'timed-out', code: 'timeout' });
    }, Math.max(0, timeoutMs));
    promise.then((value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ outcome: 'resolved', value });
    }, (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ outcome: 'failed', code: classifyAudioSinkFailure(error) });
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
  setSinkId: SinkTarget['setSinkId'],
  state: SinkRouteState,
  sinkId: string,
  generation: number,
  normalize: (sinkId: string) => string | Promise<string>,
  timeoutMs: number,
  force: boolean,
  onFailure?: (failure: AudioSinkRouteFailure) => void,
): Promise<AudioSinkRouteOutcome> {
  const run = state.queue.catch(() => {}).then(async (): Promise<AudioSinkRouteOutcome> => {
    if (generation !== state.generation) return 'superseded';
    // Fresh browser media targets already use the system route. Keep the logical state without
    // asking CoreAudio/WebKit to re-apply the same default on every join or foreground edge.
    if (!force && state.applied === sinkId && state.failedDesired !== sinkId) return 'applied';
    if (typeof setSinkId !== 'function') {
      reportAudioSinkFailure(onFailure, 'set_sink', 'unsupported', 'unsupported');
      return 'unsupported'; // Safari follows the system route.
    }
    let normalization: SinkOperationResult<string>;
    try {
      normalization = await settleSinkOperation(Promise.resolve(normalize(sinkId)), timeoutMs);
    } catch (error) {
      if (generation !== state.generation) return 'superseded';
      if (generation === state.generation) state.failedDesired = sinkId;
      reportAudioSinkFailure(onFailure, 'enumerate', 'failed', classifyAudioSinkFailure(error));
      return 'failed';
    }
    if (normalization.outcome !== 'resolved') {
      if (generation !== state.generation) return 'superseded';
      if (generation === state.generation) state.failedDesired = sinkId;
      reportAudioSinkFailure(onFailure, 'enumerate', normalization.outcome, normalization.code);
      return normalization.outcome;
    }
    // A newer selection that arrived while device enumeration was pending owns the hardware.
    if (generation !== state.generation) return 'superseded';
    let raw: Promise<void>;
    try { raw = Promise.resolve(setSinkId.call(target, normalization.value)); }
    catch (error) {
      if (generation !== state.generation) return 'superseded';
      if (generation === state.generation) state.failedDesired = sinkId;
      reportAudioSinkFailure(onFailure, 'set_sink', 'failed', classifyAudioSinkFailure(error));
      return 'failed';
    }
    const result = await settleSinkOperation(raw, timeoutMs);
    if (result.outcome === 'resolved') {
      // Even a superseded operation changed the physical target before the next queued request.
      // Recording that exact intermediate route makes a same-as-before successor re-apply instead
      // of incorrectly no-oping and leaving this stale route audible.
      state.applied = sinkId;
      if (generation === state.generation && state.failedDesired === sinkId) delete state.failedDesired;
      return 'applied';
    }
    if (result.outcome === 'failed') {
      if (generation !== state.generation) return 'superseded';
      if (generation === state.generation) state.failedDesired = sinkId;
      reportAudioSinkFailure(onFailure, 'set_sink', 'failed', result.code);
      return 'failed';
    }
    // The browser may already have changed hardware before leaving its promise pending. The
    // previous logical route is therefore no longer confirmed: a following custom -> default
    // request must physically restore the system route even before this promise settles.
    state.applied = undefined;
    const current = generation === state.generation;
    if (current) {
      state.failedDesired = sinkId;
      reportAudioSinkFailure(onFailure, 'set_sink', 'timed-out', 'timeout');
    }
    // A rejected promise changed nothing. A promise that merely exceeded the deadline may still
    // apply later; only that late success needs to repair a now-stale route.
    void raw.then(() => {
      state.applied = sinkId;
      if (generation === state.generation) {
        if (state.failedDesired === sinkId) delete state.failedDesired;
        return;
      }
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
        true,
        state.onFailure,
      );
    }, () => {});
    return current ? 'timed-out' : 'superseded';
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
  state.onFailure = options.onFailure;
  const generation = ++state.generation;
  return enqueueAudioSinkRoute(
    target, setSinkId, state, sinkId, generation, normalize, timeoutMs, options.force === true, options.onFailure,
  );
}

/** Seeds the route of an exact, newly-created browser target before any asynchronous switch. */
export function seedAudioSinkTargetRoute(target: object, sinkId = 'default'): boolean {
  if (sinkRouteStates.has(target)) return false;
  sinkRouteStates.set(target, {
    generation: 0,
    desired: sinkId,
    applied: sinkId,
    normalize: (value) => value,
    timeoutMs: AUDIO_OUTPUT_ROUTE_TIMEOUT_MS,
    queue: Promise.resolve(),
  });
  return true;
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

/**
 * Waits for a frame owned by the exact current video track inside a stable MediaStream.
 *
 * Tree reparenting deliberately keeps the MediaStream and video element alive so fullscreen and
 * the last good frame survive the handoff. That also means ordinary `loadeddata`/`playing` events
 * can describe the retained predecessor. The frame callback is therefore generation-fenced to the
 * replacement track. Older WebKit versions without requestVideoFrameCallback first require a
 * strict decoded-frame counter increment; only builds without either counter may use the exact
 * track's own mute-to-unmute edge as the final fail-closed fallback.
 */
export class ExactVideoTrackFrameObserver {
  private static readonly COUNTER_POLL_INTERVAL_MS = 100;
  private static readonly COUNTER_POLL_TIMEOUT_MS = 30_000;
  private candidate: MediaStreamTrack | null = null;
  private candidateUnmute: EventListener | null = null;
  private candidateEnded: EventListener | null = null;
  private frameRequest: number | null = null;
  private counterPollTimer: number | null = null;
  private counterPollDeadline = 0;
  private counterBaseline: { source: 'standard' | 'webkit'; value: number } | null = null;
  private fallbackUnmuteGeneration: number | null = null;
  private generation = 0;
  private disposed = false;

  private readonly onAddTrack = (event: Event) => {
    const track = (event as Event & { track?: MediaStreamTrack }).track;
    if (track?.kind === 'video') this.adopt(track);
  };

  private readonly onRemoveTrack = (event: Event) => {
    const track = (event as Event & { track?: MediaStreamTrack }).track;
    if (track === this.candidate && !this.stream.getVideoTracks().includes(track)) this.clearCandidate();
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly stream: MediaStream,
    private readonly onFrame: (track: MediaStreamTrack) => void,
    private readonly counterPolling: {
      now?: () => number;
      setTimer?: (callback: () => void, delayMs: number) => number;
      clearTimer?: (timer: number) => void;
      intervalMs?: number;
      timeoutMs?: number;
    } = {},
  ) {
    stream.addEventListener('addtrack', this.onAddTrack);
    stream.addEventListener('removetrack', this.onRemoveTrack);
    const current = stream.getVideoTracks()[0];
    if (current) this.adopt(current);
  }

  private owns(track: MediaStreamTrack, generation: number): boolean {
    return !this.disposed && this.generation === generation && this.candidate === track
      && track.readyState === 'live' && !track.muted
      && this.stream.getVideoTracks().includes(track);
  }

  private cancelFrameRequest() {
    const request = this.frameRequest;
    this.frameRequest = null;
    if (request === null || typeof this.video.cancelVideoFrameCallback !== 'function') return;
    try { this.video.cancelVideoFrameCallback(request); } catch { /** stale browser callback is generation-fenced */ }
  }

  private cancelCounterPoll() {
    const timer = this.counterPollTimer;
    this.counterPollTimer = null;
    this.counterPollDeadline = 0;
    this.counterBaseline = null;
    if (timer === null) return;
    const clearTimer = this.counterPolling.clearTimer ?? ((handle: number) => globalThis.clearTimeout(handle));
    try { clearTimer(timer); } catch { /** a stale callback remains generation-fenced */ }
  }

  private decodedFrameCounter(): { source: 'standard' | 'webkit'; value: number } | null {
    try {
      const quality = this.video.getVideoPlaybackQuality?.();
      const value = quality?.totalVideoFrames;
      if (Number.isFinite(value) && value! >= 0) return { source: 'standard', value: value! };
    } catch { /** older WebKit may expose a throwing partial implementation */ }
    const value = (this.video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount;
    return Number.isFinite(value) && value! >= 0 ? { source: 'webkit', value: value! } : null;
  }

  private scheduleCounterPoll(track: MediaStreamTrack, generation: number) {
    if (this.counterPollTimer !== null || !this.owns(track, generation)) return;
    const now = this.counterPolling.now ?? Date.now;
    if (!this.counterPollDeadline) {
      const timeoutMs = Number.isFinite(this.counterPolling.timeoutMs)
        ? Math.max(0, this.counterPolling.timeoutMs!)
        : ExactVideoTrackFrameObserver.COUNTER_POLL_TIMEOUT_MS;
      this.counterPollDeadline = now() + timeoutMs;
    }
    if (now() >= this.counterPollDeadline) {
      this.counterPollDeadline = 0;
      this.counterBaseline = null;
      return;
    }
    const intervalMs = Number.isFinite(this.counterPolling.intervalMs)
      ? Math.max(0, this.counterPolling.intervalMs!)
      : ExactVideoTrackFrameObserver.COUNTER_POLL_INTERVAL_MS;
    const setTimer = this.counterPolling.setTimer
      ?? ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
    let timer: number | null = null;
    timer = setTimer(() => {
      if (timer === null || this.counterPollTimer !== timer) return;
      this.counterPollTimer = null;
      if (!this.owns(track, generation)) return;
      const current = this.decodedFrameCounter();
      if (!current) {
        this.counterPollDeadline = 0;
        this.counterBaseline = null;
        // A counter disappearing mid-flight must not turn retained element dimensions into proof.
        // Only an unconsumed exact mute -> unmute edge may finish without a decoded-frame counter.
        this.requestCounterFallback(track, generation);
        return;
      }
      const baseline = this.counterBaseline;
      if (!baseline || baseline.source !== current.source || current.value < baseline.value) {
        // Some WebKit versions reset the element counter when a MediaStream swaps its video track.
        // Treat that as a new baseline; the first strictly later frame is the proof we need.
        this.counterBaseline = current;
      } else if (current.value > baseline.value
        && this.video.videoWidth > 0 && this.video.readyState >= 2) {
        this.counterPollDeadline = 0;
        this.counterBaseline = null;
        this.fallbackUnmuteGeneration = null;
        this.onFrame(track);
        return;
      }
      this.scheduleCounterPoll(track, generation);
    }, intervalMs);
    this.counterPollTimer = timer;
  }

  private requestCounterFallback(track: MediaStreamTrack, generation: number) {
    if (!this.owns(track, generation)) return;
    if (this.counterPollTimer !== null) return;
    const baseline = this.decodedFrameCounter();
    if (baseline) {
      // When a decoded-frame counter exists it is stronger than an unmute notification: wait for
      // a strict increment after this exact candidate became observable.
      this.fallbackUnmuteGeneration = null;
      this.counterBaseline = baseline;
      this.counterPollDeadline = 0;
      this.scheduleCounterPoll(track, generation);
      return;
    }
    if (this.fallbackUnmuteGeneration !== generation) return;
    // No counter exists in this WebKit build. The exact candidate's own mute -> unmute edge is the
    // last safe proof available; consume it only after dimensions are ready, never for a later
    // rewatch of an already-unmuted track.
    if (this.video.videoWidth <= 0 || this.video.readyState < 2) return;
    this.fallbackUnmuteGeneration = null;
    this.onFrame(track);
  }

  private clearCandidate() {
    const track = this.candidate;
    if (track && this.candidateUnmute) track.removeEventListener('unmute', this.candidateUnmute);
    if (track && this.candidateEnded) track.removeEventListener('ended', this.candidateEnded);
    this.candidate = null;
    this.candidateUnmute = null;
    this.candidateEnded = null;
    this.fallbackUnmuteGeneration = null;
    ++this.generation;
    this.cancelFrameRequest();
    this.cancelCounterPoll();
  }

  private adopt(track: MediaStreamTrack) {
    if (this.disposed || track.kind !== 'video' || !this.stream.getVideoTracks().includes(track)) return;
    if (this.candidate === track) { this.requestCurrentFrame(); return; }
    this.clearCandidate();
    this.candidate = track;
    const generation = this.generation;
    this.candidateUnmute = () => {
      if (!this.owns(track, generation)) return;
      this.fallbackUnmuteGeneration = generation;
      // A callback registered while the receiver was muted can remain pending forever in WebKit.
      // Re-arm it at the exact first-packet edge instead of accumulating another native callback.
      this.cancelFrameRequest();
      this.requestCurrentFrame();
    };
    this.candidateEnded = () => {
      if (this.candidate === track && this.generation === generation) this.clearCandidate();
    };
    track.addEventListener('unmute', this.candidateUnmute);
    track.addEventListener('ended', this.candidateEnded, { once: true });
    this.requestCurrentFrame();
  }

  requestCurrentFrame() {
    const track = this.candidate;
    const generation = this.generation;
    if (!track || !this.owns(track, generation)) return;
    const request = this.video.requestVideoFrameCallback;
    if (typeof request !== 'function') {
      // Dimensions/readyState belong to the stable element and may describe its retained previous
      // frame. A strict post-adopt decoded-frame counter increment or this track's own unmute edge
      // is required before the replacement can become authoritative.
      this.requestCounterFallback(track, generation);
      return;
    }
    this.cancelCounterPoll();
    if (this.frameRequest !== null) return;
    let requestId: number | null = null;
    try {
      requestId = request.call(this.video, () => {
        if (requestId !== null && this.frameRequest === requestId) this.frameRequest = null;
        if (!this.owns(track, generation)) return;
        if (this.video.videoWidth > 0 && this.video.readyState >= 2) this.onFrame(track);
      });
      this.frameRequest = requestId;
    } catch {
      // Treat a throwing partial RVFC implementation like an unavailable one. The fallback still
      // requires the exact track's unmute edge or a post-baseline decoded-frame counter increment.
      this.requestCounterFallback(track, generation);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stream.removeEventListener('addtrack', this.onAddTrack);
    this.stream.removeEventListener('removetrack', this.onRemoveTrack);
    this.clearCandidate();
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
  options: Pick<AudioSinkRouteOptions, 'force' | 'onFailure'> = {},
): Promise<AudioSinkRouteOutcome> {
  // Returning to the system route ends the failed custom-selection episode even if the browser
  // reports `unsupported` (Safari follows the OS route without setSinkId). A later selection of
  // the same device must be allowed to report a fresh disconnect.
  if (sinkId === 'default') notifiedTreeOutputFailures.delete(target);
  const outcome = await routeAudioSinkTarget(target, sinkId, options);
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
    // A newly-created media element follows the OS route until this controller explicitly moves it.
    seedAudioSinkTargetRoute(video);
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
    // A fresh or replacement AudioContext starts on the system route. For a shared context the
    // first controller seeds it and later controllers leave its exact route state untouched.
    seedAudioSinkTargetRoute(context);
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
export async function setTreeStreamOutputSink(
  sinkId: string,
  options: Pick<AudioSinkRouteOptions, 'force' | 'onFailure'> = {},
): Promise<AudioSinkRouteOutcome> {
  treeStreamOutputSink = sinkId || 'default';
  const targets = new Set<SinkTarget>();
  treeStreamAudioControllers.forEach((controller) => {
    const target = controller.outputSinkTarget();
    if (target) targets.add(target); // shared AudioContext is switched exactly once.
  });
  if (!targets.size) return 'applied'; // future controllers inherit treeStreamOutputSink on creation.
  const outcomes = await Promise.all(
    [...targets].map((target) => routeTreeOutputTarget(target, treeStreamOutputSink, false, options)),
  );
  // A partially routed tree is not a successful device switch: every audible target must agree.
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('timed-out')) return 'timed-out';
  if (outcomes.includes('unsupported')) return 'unsupported';
  if (outcomes.includes('superseded')) return 'superseded';
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

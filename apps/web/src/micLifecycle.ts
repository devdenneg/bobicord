export const MIC_MUTED_RESTART_MS = 4000;
export const VOICE_JOIN_TIMEOUT_MS = 30_000;
export const VOICE_OPERATION_TIMEOUT_MS = 8_000;
export const VOICE_MEDIA_CONNECT_TIMEOUT_MS = 12_000;
export const VOICE_ATTRIBUTE_TIMEOUT_MS = 4_000;
export const VOICE_MIC_START_TIMEOUT_MS = 15_000;
export const VOICE_CLEANUP_TIMEOUT_MS = 5_000;
// Reconnect is an observation/re-activation of the existing lease, not an open-ended mode.
// Mobile radios can leave both HTTP and SDK promises pending after a route change, so the whole
// verifier has one absolute fail-closed deadline in addition to per-call bounds.
export const VOICE_RECONNECT_VERIFY_TIMEOUT_MS = 20_000;

export class VoiceOperationTimeoutError extends Error {
  override readonly name = 'VoiceOperationTimeoutError';

  constructor(readonly operation: string) {
    super(`${operation} timed out`);
  }
}

// A microphone start is not cancellable once WebKit has entered getUserMedia().
// Ownership therefore has to be fenced separately from the underlying promise:
// invalidating an old owner lets the current voice intent proceed, while a late
// finally from the old operation is unable to clear the newer owner.
export class VoiceMicStartOwnership {
  private currentOwner = 0;

  get active(): boolean { return this.currentOwner !== 0; }
  get owner(): number { return this.currentOwner; }

  begin(owner: number): boolean {
    if (this.active || !Number.isSafeInteger(owner) || owner < 1) return false;
    this.currentOwner = owner;
    return true;
  }

  finish(owner: number): void {
    if (this.currentOwner === owner) this.currentOwner = 0;
  }

  invalidate(owner?: number): void {
    if (owner == null || this.currentOwner === owner) this.currentOwner = 0;
  }
}

export interface GestureAudioContextLike {
  readonly state?: string;
  resume?: () => void | PromiseLike<void>;
  close?: () => void | PromiseLike<void>;
}

type AudioUnlockGestureEvent = Pick<Event, 'type' | 'timeStamp'> & Partial<Pick<KeyboardEvent, 'repeat'>> & {
  pointerType?: string;
  detail?: number;
};

const AUDIO_UNLOCK_COMPAT_EVENT_MS = 800;
const audioUnlockEventTokens = new WeakMap<object, number>();
let audioUnlockGestureSeq = 0;
let currentAudioUnlockGesture = 0;
let currentAudioUnlockGestureWallAt = Number.NEGATIVE_INFINITY;
let lastDirectGestureType = '';
let lastDirectGestureAt = Number.NEGATIVE_INFINITY;
let lastDirectGestureToken = 0;
let lastKeyGestureAt = Number.NEGATIVE_INFINITY;
let lastKeyGestureToken = 0;

function audioUnlockGestureToken(event: AudioUnlockGestureEvent): number {
  const cached = audioUnlockEventTokens.get(event);
  if (cached !== undefined) return cached;
  const at = Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
  let token = 0;
  if (event.type === 'keydown') {
    if (!event.repeat) {
      token = ++audioUnlockGestureSeq;
      lastKeyGestureAt = at;
      lastKeyGestureToken = token;
    }
  } else if (event.type === 'touchstart' || event.type === 'pointerdown') {
    if (lastDirectGestureType && lastDirectGestureType !== event.type
      && Math.abs(at - lastDirectGestureAt) <= AUDIO_UNLOCK_COMPAT_EVENT_MS) {
      token = lastDirectGestureToken;
    } else {
      token = ++audioUnlockGestureSeq;
      lastDirectGestureType = event.type;
      lastDirectGestureAt = at;
      lastDirectGestureToken = token;
    }
  } else if (event.type === 'click') {
    if (Math.abs(at - lastDirectGestureAt) <= AUDIO_UNLOCK_COMPAT_EVENT_MS) token = lastDirectGestureToken;
    else if (event.detail === 0 && Math.abs(at - lastKeyGestureAt) <= AUDIO_UNLOCK_COMPAT_EVENT_MS) token = lastKeyGestureToken;
    else token = ++audioUnlockGestureSeq;
  } else token = ++audioUnlockGestureSeq;
  audioUnlockEventTokens.set(event, token);
  if (token) {
    currentAudioUnlockGesture = token;
    currentAudioUnlockGestureWallAt = Date.now();
  }
  return token;
}

export function currentAudioUnlockGestureToken(): number {
  return Date.now() - currentAudioUnlockGestureWallAt <= AUDIO_UNLOCK_COMPAT_EVENT_MS
    ? currentAudioUnlockGesture
    : 0;
}

/**
 * Deduplicates the compatibility events emitted for one physical browser activation. Mobile
 * Safari can dispatch touchstart + pointerdown + click for one finger, and keyboard activation can
 * follow keydown with detail=0 click. Separate real touches/keys remain separate recovery chances.
 */
export class AudioUnlockGestureDeduper {
  private handledToken = 0;

  accept(event: AudioUnlockGestureEvent): boolean {
    const token = audioUnlockGestureToken(event);
    if (!token || this.handledToken === token) return false;
    this.handledToken = token;
    return true;
  }
}

interface ExactAudioContextResumeState {
  ordinary?: Promise<boolean>;
  gesture?: Promise<boolean>;
  gestureRetry?: Promise<boolean>;
  gestureToken?: number;
  gestureRetryToken?: number;
}

export interface ExactAudioContextResumeAttempt {
  started: boolean;
  outcome: Promise<boolean>;
}

/**
 * Owns the native resume() promise for one exact AudioContext. WebKit can leave resume pending
 * across a page/radio transition; periodic recovery therefore shares one physical ordinary call.
 * Two bounded gesture lanes let a repeated real tap supersede an initial tap whose native promise
 * froze during an immediate page hide, without allowing further taps to grow pending calls.
 */
export class ExactAudioContextResumeCoordinator<TContext extends GestureAudioContextLike> {
  private readonly states = new WeakMap<TContext, ExactAudioContextResumeState>();

  acquire(
    context: TContext,
    explicitGesture = false,
    onSuccess?: () => void,
    gestureToken = 0,
  ): ExactAudioContextResumeAttempt | null {
    if (context.state === 'closed') {
      this.states.delete(context);
      return null;
    }
    let state = this.states.get(context);
    if (!state) {
      state = {};
      this.states.set(context, state);
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
      // Invocation must stay in the event handler. Moving a gesture resume into a microtask loses
      // transient user activation in WebKit even though the returned promise is asynchronous.
      raw = Promise.resolve(context.resume?.());
    } catch (error) {
      raw = Promise.reject(error);
    }
    const owner = raw.then(() => true, () => false);
    state[lane] = owner;
    if (lane === 'gesture') state.gestureToken = gestureToken;
    else if (lane === 'gestureRetry') state.gestureRetryToken = gestureToken;
    void owner.then((ok) => {
      if (this.states.get(context) !== state || state![lane] !== owner) return;
      delete state![lane];
      if (lane === 'gesture') delete state!.gestureToken;
      else if (lane === 'gestureRetry') delete state!.gestureRetryToken;
      if (!state!.ordinary && !state!.gesture && !state!.gestureRetry) this.states.delete(context);
      if (ok) { try { onSuccess?.(); } catch { /** recovery observers are optional */ } }
    });
    return { started: true, outcome: owner };
  }

  request(context: TContext, explicitGesture = false, onSuccess?: () => void): boolean {
    return this.acquire(context, explicitGesture, onSuccess, explicitGesture ? currentAudioUnlockGestureToken() : 0)?.started ?? false;
  }

  forget(context: TContext): void {
    // Native resume is not cancellable. Fencing its owner prevents a late settlement from touching
    // replacement state and releases the coordinator's reference before the context is closed.
    this.states.delete(context);
  }
}

const exactAudioContextResumes = new ExactAudioContextResumeCoordinator<GestureAudioContextLike>();

export function requestExactAudioContextResume(
  context: GestureAudioContextLike | null | undefined,
  explicitGesture = false,
  onSuccess?: () => void,
): boolean {
  return !!context && exactAudioContextResumes.request(context, explicitGesture, onSuccess);
}

export function acquireExactAudioContextResume(
  context: GestureAudioContextLike | null | undefined,
  explicitGesture = false,
  onSuccess?: () => void,
): ExactAudioContextResumeAttempt | null {
  return context ? exactAudioContextResumes.acquire(
    context,
    explicitGesture,
    onSuccess,
    explicitGesture ? currentAudioUnlockGestureToken() : 0,
  ) : null;
}

export function forgetExactAudioContextResume(context: GestureAudioContextLike | null | undefined): void {
  if (context) exactAudioContextResumes.forget(context);
}

function retireGestureAudioContext(context: GestureAudioContextLike): void {
  forgetExactAudioContextResume(context);
  try {
    // Closing must be initiated synchronously so a newly-created context can claim the same audio
    // resources, but it cannot be awaited here without losing the caller's transient activation.
    void Promise.resolve(context.close?.()).catch(() => { /** best-effort retirement */ });
  } catch { /** an already-broken context is unusable either way */ }
}

/**
 * Reuses a live audio context, or creates its replacement, and invokes resume synchronously while
 * the caller still owns the browser user activation. The returned promise is deliberately not
 * awaited: WebKit decides whether the gesture is valid at invocation time, while a pending resume
 * must not hold the channel-tap handler or create an unhandled rejection.
 */
export function resumeGestureAudioContext<T extends GestureAudioContextLike>(
  current: T | null | undefined,
  create: () => T,
): T | null {
  const canReuseCurrent = !!current && reusableMicrophoneAudioContextState(current.state);
  if (current && !canReuseCurrent) retireGestureAudioContext(current);
  let context: T | null = canReuseCurrent ? current! : null;
  if (!context) {
    try { context = create(); }
    catch { return null; }
  }
  // New AudioContexts normally start suspended (or running). If WebKit creates one directly in an
  // interrupted/unknown state, fail closed and leave the gesture available to the rest of the tap
  // handler instead of binding another native resume promise to a context that can emit silence.
  if (!reusableMicrophoneAudioContextState(context.state)) {
    retireGestureAudioContext(context);
    return null;
  }
  requestExactAudioContextResume(context, true);
  return context;
}

/**
 * Shared analyser contexts own long-lived MediaStreamSource graphs. Unlike the replaceable
 * microphone processing context, an interrupted WebKit context must retain its exact identity:
 * replacing it would strand every analyser on the old graph. Only a terminal context is forgotten;
 * resume is still invoked synchronously so WebKit can restore the existing graph under the tap.
 */
export function resumeSharedGestureAudioContext<T extends GestureAudioContextLike>(
  current: T | null | undefined,
  create: () => T,
): T | null {
  if (current?.state === 'closed') forgetExactAudioContextResume(current);
  let context = current?.state === 'closed' ? null : (current ?? null);
  if (!context) {
    try { context = create(); }
    catch { return null; }
  }
  requestExactAudioContextResume(context, true);
  return context;
}

export function isVoiceOperationTimeout(error: unknown): error is VoiceOperationTimeoutError {
  return error instanceof VoiceOperationTimeoutError
    || (error instanceof Error && error.name === 'VoiceOperationTimeoutError');
}

export function withVoiceTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, operation: string): Promise<T> {
  const boundedMs = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new VoiceOperationTimeoutError(operation));
    }, boundedMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function withVoiceDeadline<T>(promise: PromiseLike<T>, deadline: number, operation: string): Promise<T> {
  return withVoiceTimeout(promise, Math.max(0, deadline - Date.now()), operation);
}

export async function voiceWriteCommittedForCurrentIntent(
  write: PromiseLike<unknown>,
  deadline: number,
  operation: string,
  intentCurrent: () => boolean,
  attributesMatch: () => boolean,
): Promise<boolean> {
  await withVoiceDeadline(write, deadline, operation);
  // The check intentionally happens after the deferred write. A second tap can
  // replace the voice intent while the SDK promise is pending, and matching old
  // attributes must never authorize that superseded continuation.
  return intentCurrent() && attributesMatch();
}

export function automaticMicRecoveryAllowed(
  pageHidden: boolean,
  hadCapture: boolean,
  bootstrapWanted: boolean,
  foregroundRecoveryPending: boolean,
): boolean {
  return !pageHidden && (hadCapture || bootstrapWanted || foregroundRecoveryPending);
}

export function foregroundMicNeedsImmediateRecovery(
  returningFromBackground: boolean,
  trackEnded: boolean,
  trackMuted: boolean,
  reacquireOwnedCapture = false,
): boolean {
  return returningFromBackground && (reacquireOwnedCapture || trackEnded || trackMuted);
}

/**
 * WebKit exposes a non-standard `interrupted` state after some iOS background/audio-session
 * transitions. Reusing that context can produce a live-looking MediaStreamDestination which only
 * emits silence. Preserve the gesture-created context for the two recoverable standard states;
 * every terminal or unknown state must be rebuilt with the microphone pipeline.
 */
export function reusableMicrophoneAudioContextState(state: unknown): boolean {
  return state === 'running' || state === 'suspended';
}

export interface StorageReader {
  getItem(key: string): string | null;
}

export function readStoredFlag(storage: StorageReader, key: string): boolean {
  try { return storage.getItem(key) === '1'; }
  catch { return false; }
}

export function selectedInputUnavailable(error: unknown): boolean {
  const name = String((error as { name?: unknown } | null)?.name || '');
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

export function mutedTrackNeedsRestart(mutedAt: number, now: number): boolean {
  return mutedAt > 0 && Number.isFinite(now) && now - mutedAt >= MIC_MUTED_RESTART_MS;
}

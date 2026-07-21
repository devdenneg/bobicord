export const CHAT_BOTTOM_ENTER_PX = 32;
export const CHAT_BOTTOM_LEAVE_PX = 64;
export const CHAT_PHYSICAL_BOTTOM_EPSILON_PX = 1;
export const CHAT_TAIL_RESERVE_PX = 12;
export const CHAT_TAIL_STABLE_FRAMES = 2;
export const CHAT_TAIL_MAX_WRITES = 12;
export const CHAT_TAIL_MAX_SAME_TARGET_WRITES = 3;
export const CHAT_PREPEND_WARMUP_FRAMES = 2;
export const CHAT_PREPEND_STABLE_FRAMES = 8;
export const CHAT_PREPEND_MAX_FRAMES = 54;
export const CHAT_HISTORY_PAGE_SIZE = 30;
// Measure the complete incoming page except its first row. Rendering that first row would fire
// Virtuoso's startReached again and could cascade another request before the user reaches it.
export const CHAT_PREPEND_OVERSCAN_ITEMS = CHAT_HISTORY_PAGE_SIZE - 1;
export const CHAT_SESSION_MESSAGE_LIMIT = 1000;

export type ChatTailIndex = number | 'LAST';
export type ChatTailBehavior = 'auto' | 'smooth';

/**
 * Exact semantic target for the end of the virtual chat.
 *
 * Virtuoso measures its Footer asynchronously. The explicit reserve makes the first scroll
 * reach the browser's physical maximum even during the frame where the footer is already in
 * the DOM but is not yet included in Virtuoso's measured footer height. Once measured, the
 * extra offset is harmless because the browser clamps the target to the same physical maximum.
 */
export function chatTailIndexLocation<T extends ChatTailIndex>(
  index: T,
  behavior: ChatTailBehavior = 'auto',
) {
  return { index, align: 'end' as const, offset: CHAT_TAIL_RESERVE_PX, behavior };
}

export type ChatScrollDirection = 'none' | 'up' | 'down';

export interface ChatScrollGeometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

export interface ChatScrollState {
  atBottom: boolean;
  following: boolean;
}

export type ChatTailSettlePhase = 'waiting' | 'targeting' | 'settled' | 'cancelled';

export interface ChatTailSettleState {
  phase: ChatTailSettlePhase;
  observedMax: number | null;
  stableFrames: number;
  targetScrollTop: number | null;
  targetWrites: number;
  writes: number;
}

export interface ChatTailSettleInput {
  geometry: ChatScrollGeometry;
  ready: boolean;
  scrolling: boolean;
  following: boolean;
  direction: ChatScrollDirection;
  rearmBlocked: boolean;
  prepend: boolean;
}

export interface ChatTailSettleDecision {
  state: ChatTailSettleState;
  scrollTop: number | null;
  keepSampling: boolean;
}

export interface ChatVirtualSnapshot {
  count: number;
  prepended: number;
  trimmed: number;
  firstItemIndex: number;
}

export interface ChatPrependTransition {
  kind: 'prepend';
  inserted: number;
  valid: boolean;
  anchorPreserved: boolean;
  allowFollow: false;
  allowTailSettle: false;
}

export interface ChatPrependSettleProgress {
  frames: number;
  stableFrames: number;
}

export interface ChatPrependSettleDecision {
  progress: ChatPrependSettleProgress;
  done: boolean;
}

export interface ChatPrependGeometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  anchorTop: number;
}

export const INITIAL_CHAT_PREPEND_SETTLE: ChatPrependSettleProgress = {
  frames: 0,
  stableFrames: 0,
};

export interface ChatPrependLifecycleTransaction {
  serverId: string;
  historyGeneration: number;
  committed: boolean;
  targetPrepended: number | null;
}

export interface ChatPrependLifecycleSnapshot {
  serverId: string | undefined;
  historyGeneration: number;
  prepended: number;
}

export type ChatPrependLifecycleDecision = 'wait' | 'settle' | 'cancel';

export const INITIAL_CHAT_TAIL_SETTLE: ChatTailSettleState = {
  phase: 'waiting',
  observedMax: null,
  stableFrames: 0,
  targetScrollTop: null,
  targetWrites: 0,
  writes: 0,
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Distance from the physical end of the scroller, normalized for browser overscroll. */
export function chatBottomDistance(geometry: ChatScrollGeometry): number {
  const scrollHeight = Math.max(0, finiteOr(geometry.scrollHeight, 0));
  const clientHeight = Math.max(0, finiteOr(geometry.clientHeight, 0));
  const scrollTop = finiteOr(geometry.scrollTop, 0);
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/** Browser-clamped physical maximum for the chat scroller. */
export function chatPhysicalMaxScrollTop(geometry: ChatScrollGeometry): number {
  const scrollHeight = Math.max(0, finiteOr(geometry.scrollHeight, 0));
  const clientHeight = Math.max(0, finiteOr(geometry.clientHeight, 0));
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Finite physical-tail convergence used after Virtuoso finishes its semantic positioning.
 *
 * Two identical layout frames are required before a write, so the target is not taken from a
 * half-measured list. If Virtuoso pulls the viewport back while it is still measuring a newly
 * appended row, the same exact target gets two bounded repair attempts. Per-target and total
 * write caps plus the caller deadline keep that convergence finite and prevent a retry loop.
 */
export function reduceChatTailSettle(
  state: ChatTailSettleState,
  input: ChatTailSettleInput,
): ChatTailSettleDecision {
  if (state.phase === 'settled' || state.phase === 'cancelled') {
    return { state, scrollTop: null, keepSampling: false };
  }
  if (!input.following || input.direction === 'up' || input.rearmBlocked || input.prepend) {
    return {
      state: { ...state, phase: 'cancelled', stableFrames: 0 },
      scrollTop: null,
      keepSampling: false,
    };
  }
  if (!input.ready || input.scrolling) {
    return {
      state: { ...state, stableFrames: 0 },
      scrollTop: null,
      keepSampling: true,
    };
  }

  const physicalMax = chatPhysicalMaxScrollTop(input.geometry);
  const sameMaximum = state.observedMax != null
    && Math.abs(state.observedMax - physicalMax) <= CHAT_PHYSICAL_BOTTOM_EPSILON_PX;
  const stableFrames = sameMaximum ? state.stableFrames + 1 : 1;
  const observed = { ...state, observedMax: physicalMax, stableFrames };
  if (stableFrames < CHAT_TAIL_STABLE_FRAMES) {
    return { state: observed, scrollTop: null, keepSampling: true };
  }

  if (chatBottomDistance(input.geometry) <= CHAT_PHYSICAL_BOTTOM_EPSILON_PX) {
    return {
      state: { ...observed, phase: 'settled' },
      scrollTop: null,
      keepSampling: false,
    };
  }

  const targetAlreadyWritten = observed.targetScrollTop != null
    && Math.abs(observed.targetScrollTop - physicalMax) <= CHAT_PHYSICAL_BOTTOM_EPSILON_PX;
  if (targetAlreadyWritten && observed.targetWrites >= CHAT_TAIL_MAX_SAME_TARGET_WRITES) {
    return {
      state: { ...observed, phase: 'cancelled' },
      scrollTop: null,
      keepSampling: false,
    };
  }
  if (observed.writes >= CHAT_TAIL_MAX_WRITES) {
    return {
      state: { ...observed, phase: 'cancelled' },
      scrollTop: null,
      keepSampling: false,
    };
  }
  return {
    state: {
      ...observed,
      phase: 'targeting',
      stableFrames: 0,
      targetScrollTop: physicalMax,
      targetWrites: targetAlreadyWritten ? observed.targetWrites + 1 : 1,
      writes: observed.writes + 1,
    },
    scrollTop: physicalMax,
    keepSampling: true,
  };
}

/** The firstItemIndex contract required by Virtuoso for an atomic prepend. */
export function chatVirtualFirstItemIndex(base: number, prepended: number, trimmed: number): number {
  return base - prepended + trimmed;
}

/** A history request and its viewport restoration are one non-overlapping transaction. */
export function canStartChatPrepend(requesting: boolean, guarding: boolean): boolean {
  return !requesting && !guarding;
}

/**
 * Decides whether a committed prepend still belongs to the currently rendered history.
 * A scope or target mismatch must cancel instead of silently leaving the guard active.
 */
export function classifyChatPrependLifecycle(
  transaction: ChatPrependLifecycleTransaction,
  current: ChatPrependLifecycleSnapshot,
): ChatPrependLifecycleDecision {
  if (transaction.serverId !== current.serverId
    || transaction.historyGeneration !== current.historyGeneration) return 'cancel';
  if (!transaction.committed) return 'wait';
  return transaction.targetPrepended === current.prepended ? 'settle' : 'cancel';
}

/**
 * Validates the atomic data/index transition required when older rows are inserted above.
 * Bottom-follow and tail writes are always forbidden for the duration of this transition.
 */
export function classifyChatPrepend(
  before: ChatVirtualSnapshot,
  after: ChatVirtualSnapshot,
  visibleOffset: number,
): ChatPrependTransition {
  const inserted = after.count - before.count;
  const valid = Number.isInteger(inserted)
    && inserted > 0
    && after.prepended - before.prepended === inserted
    && after.trimmed === before.trimmed
    && after.firstItemIndex === before.firstItemIndex - inserted;
  const anchorPreserved = valid
    && before.firstItemIndex + visibleOffset
      === after.firstItemIndex + visibleOffset + inserted;
  return {
    kind: 'prepend',
    inserted,
    valid,
    anchorPreserved,
    allowFollow: false,
    allowTailSettle: false,
  };
}

/**
 * Virtuoso applies its prepend compensation over two animation frames. The passive guard must
 * wait for both frames and for the temporary numeric deviation to disappear before it starts
 * accepting quiet geometry; `auto`/NaN is the normal align-to-bottom value.
 */
export function canVerifyChatPrependGeometry(elapsedFrames: number, deviation: number): boolean {
  const frames = Math.max(0, Math.floor(finiteOr(elapsedFrames, 0)));
  const hasActiveDeviation = Number.isFinite(deviation) && Math.abs(deviation) > 0.5;
  return frames >= CHAT_PREPEND_WARMUP_FRAMES && !hasActiveDeviation;
}

/**
 * Advances the finite passive verification window. No custom scroll writes are allowed here:
 * Virtuoso remains the sole owner of prepend compensation while this guard only observes it.
 */
export function advanceChatPrependSettle(
  current: ChatPrependSettleProgress,
  geometryStable: boolean,
): ChatPrependSettleDecision {
  const frames = Math.max(0, Math.floor(finiteOr(current.frames, 0))) + 1;
  const previousStable = Math.max(0, Math.floor(finiteOr(current.stableFrames, 0)));
  const stableFrames = geometryStable ? previousStable + 1 : 0;
  return {
    progress: { frames, stableFrames },
    done: frames >= CHAT_PREPEND_MAX_FRAMES || stableFrames >= CHAT_PREPEND_STABLE_FRAMES,
  };
}

function isSameChatPrependGeometry(
  previous: ChatPrependGeometry | null,
  current: ChatPrependGeometry,
): boolean {
  if (!previous) return false;
  return Math.abs(previous.scrollHeight - current.scrollHeight) <= 0.5
    && Math.abs(previous.clientHeight - current.clientHeight) <= 0.5
    && Math.abs(previous.scrollTop - current.scrollTop) <= 0.5
    && Math.abs(previous.anchorTop - current.anchorTop) <= 0.5;
}

/** A fixed baseline prevents sub-pixel movement from accumulating across a quiet-looking streak. */
export function isChatPrependGeometryQuiet(
  previous: ChatPrependGeometry | null,
  baseline: ChatPrependGeometry | null,
  current: ChatPrependGeometry,
): boolean {
  return isSameChatPrependGeometry(previous, current)
    && isSameChatPrependGeometry(baseline, current);
}

/**
 * A protected history/reconnect insertion grows capacity monotonically. The caller may grant one
 * future live window without repeatedly resetting that reserve on every later history page.
 */
export function chatRetentionLimitAfterProtectedInsert(
  currentLimit: number,
  loadedCount: number,
  insertedCount: number,
  liveReserve = 0,
): number {
  const limit = Math.max(0, Math.floor(finiteOr(currentLimit, CHAT_SESSION_MESSAGE_LIMIT)));
  const count = Math.max(0, Math.floor(finiteOr(loadedCount, 0)));
  const inserted = Math.max(0, Math.floor(finiteOr(insertedCount, 0)));
  const reserve = Math.max(0, Math.floor(finiteOr(liveReserve, 0)));
  return Math.max(limit + inserted, count + reserve);
}

/** Number of oldest messages that may be dropped by one append under the current limit. */
export function chatAppendFrontTrim(nextCount: number, retentionLimit: number): number {
  const count = Math.max(0, Math.floor(finiteOr(nextCount, 0)));
  const limit = Math.max(0, Math.floor(finiteOr(retentionLimit, CHAT_SESSION_MESSAGE_LIMIT)));
  return Math.max(0, count - limit);
}

/**
 * Canonical tail state for the chat.
 *
 * Entering the bottom zone uses a tighter threshold than leaving it. This hysteresis keeps
 * fractional layout measurements and tiny touchpad movement from alternating the unread state,
 * while an intentional upward scroll still detaches follow mode once the tail is actually gone.
 */
export function reduceChatScrollState(
  state: ChatScrollState,
  distance: number,
  direction: ChatScrollDirection = 'none',
  rearmBlocked = false,
): ChatScrollState {
  // An explicit jump to an older reply is intentional history navigation. Smooth scrolling
  // starts with a few frames inside the bottom threshold, so geometry alone must not re-arm
  // follow mode until the user explicitly heads down again.
  if (rearmBlocked) return { atBottom: false, following: false };

  const normalizedDistance = Math.max(0, finiteOr(distance, Number.POSITIVE_INFINITY));
  const atBottom = normalizedDistance <= (state.atBottom ? CHAT_BOTTOM_LEAVE_PX : CHAT_BOTTOM_ENTER_PX);

  let following = state.following;
  if (direction === 'up' && normalizedDistance > CHAT_BOTTOM_LEAVE_PX) following = false;
  else if (normalizedDistance <= CHAT_BOTTOM_ENTER_PX) following = true;

  return { atBottom, following };
}

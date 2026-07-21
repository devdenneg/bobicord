export const CHAT_BOTTOM_ENTER_PX = 32;
export const CHAT_BOTTOM_LEAVE_PX = 64;
export const CHAT_PHYSICAL_BOTTOM_EPSILON_PX = 1;
export const CHAT_TAIL_RESERVE_PX = 12;
export const CHAT_TAIL_STABLE_FRAMES = 2;
export const CHAT_TAIL_MAX_WRITES = 12;

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
 * half-measured list. A target can be written once and retried once after another stable pair
 * (covering a delayed Virtuoso pullback); further writes require a changed physical maximum.
 * The caller also provides a hard deadline, while settled/cancelled states never write again.
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
  if (targetAlreadyWritten && observed.targetWrites >= 2) {
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

/** Pixel correction that keeps the same visible item at the same viewport position. */
export function chatPrependAnchorDelta(beforeTop: number, afterTop: number): number {
  if (!Number.isFinite(beforeTop) || !Number.isFinite(afterTop)) return 0;
  return afterTop - beforeTop;
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

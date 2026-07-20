export const CHAT_BOTTOM_ENTER_PX = 32;
export const CHAT_BOTTOM_LEAVE_PX = 64;

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

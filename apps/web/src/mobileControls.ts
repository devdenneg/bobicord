/** Small state machine shared by hold-to-talk and range-preview pointer interactions. */
export class PrimaryPointerHold {
  private pointerId: number | null = null;

  begin(pointerId: number, isPrimary: boolean, button: number): boolean {
    if (!isPrimary || button !== 0 || this.pointerId !== null) return false;
    this.pointerId = pointerId;
    return true;
  }

  end(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    return true;
  }

  cancel(): boolean {
    if (this.pointerId === null) return false;
    this.pointerId = null;
    return true;
  }

  active(): number | null {
    return this.pointerId;
  }
}

export const PTT_TOUCH_HOLD_MS = 180;
export const PTT_TOUCH_SLOP_PX = 14;

export type DelayedPointerHoldRelease = 'tap' | 'hold';

/**
 * Distinguishes a short touch (the ordinary mute button) from an intentional PTT hold. The
 * microphone gate is opened only after activate(), so a quick tap can never leak a short burst.
 */
export class DelayedPrimaryPointerHold {
  private pointerId: number | null = null;
  private held = false;
  private startX = 0;
  private startY = 0;

  begin(pointerId: number, isPrimary: boolean, button: number, clientX = 0, clientY = 0): boolean {
    if (!isPrimary || button !== 0 || this.pointerId !== null) return false;
    this.pointerId = pointerId;
    this.held = false;
    this.startX = clientX;
    this.startY = clientY;
    return true;
  }

  owns(pointerId: number): boolean {
    return this.pointerId === pointerId;
  }

  active(): number | null {
    return this.pointerId;
  }

  pendingTap(pointerId: number): boolean {
    return this.owns(pointerId) && !this.held;
  }

  activate(pointerId: number): boolean {
    if (!this.owns(pointerId) || this.held) return false;
    this.held = true;
    return true;
  }

  tapMovedBeyond(pointerId: number, clientX: number, clientY: number, slopPx = PTT_TOUCH_SLOP_PX): boolean {
    if (!this.owns(pointerId) || this.held) return false;
    return Math.hypot(clientX - this.startX, clientY - this.startY) > Math.max(0, slopPx);
  }

  end(pointerId: number): DelayedPointerHoldRelease | null {
    if (!this.owns(pointerId)) return null;
    const release = this.held ? 'hold' : 'tap';
    this.pointerId = null;
    this.held = false;
    return release;
  }

  cancel(pointerId?: number): DelayedPointerHoldRelease | null {
    if (this.pointerId === null || (pointerId !== undefined && !this.owns(pointerId))) return null;
    const release = this.held ? 'hold' : 'tap';
    this.pointerId = null;
    this.held = false;
    return release;
  }
}

/**
 * Holds only cancelled/long touch gestures. Every new physical pointerdown clears the fence before
 * it starts, so a missing WebKit compatibility click cannot consume the next mouse or touch action.
 */
export class PttCompatibilityClickFence {
  private suppressed: number[] = [];

  arm(pointerId: number): void {
    if (!Number.isFinite(pointerId)) return;
    if (!this.suppressed.includes(pointerId)) this.suppressed.push(pointerId);
    if (this.suppressed.length > 16) this.suppressed.shift();
  }

  consume(
    pointerId: number | null,
    pointerType: string,
    clickDetail: number,
    firesTouchEvents?: boolean,
  ): boolean {
    const touchGenerated = pointerType === 'touch' || pointerType === 'pen' || firesTouchEvents === true
      // Older WebKit exposes neither PointerEvent.pointerType nor InputDeviceCapabilities. A real
      // mouse has a preceding pointerdown which clears this fence; keyboard/AT click has detail 0.
      || (!pointerType && firesTouchEvents === undefined && clickDetail > 0);
    if (!touchGenerated) return false;
    if (pointerId !== null) {
      const exact = this.suppressed.indexOf(pointerId);
      if (exact >= 0) {
        this.suppressed.splice(exact, 1);
        return true;
      }
    }
    // WebKit may mint a different synthetic click pointerId or expose a legacy MouseEvent.
    return this.suppressed.shift() !== undefined;
  }

  clear(): void {
    this.suppressed = [];
  }
}

export function isRangeAdjustmentKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
    || key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End';
}

export function webScreenShareSupported(mediaDevices: { getDisplayMedia?: unknown } | null | undefined): boolean {
  return typeof mediaDevices?.getDisplayMedia === 'function';
}

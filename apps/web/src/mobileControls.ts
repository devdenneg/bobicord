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

export function suppressPointerToggleWhilePtt(ptt: boolean, clickDetail: number): boolean {
  // Pointer-generated click has detail > 0. Keyboard activation is detail === 0 and remains an
  // accessible way to toggle the manual mute state without undoing a completed touch PTT hold.
  return ptt && clickDetail > 0;
}

export function isRangeAdjustmentKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
    || key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End';
}

export function webScreenShareSupported(mediaDevices: { getDisplayMedia?: unknown } | null | undefined): boolean {
  return typeof mediaDevices?.getDisplayMedia === 'function';
}

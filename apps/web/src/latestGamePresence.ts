export interface LatestGamePresenceDependencies<Room, Game> {
  currentRoom: () => Room | null;
  enabled: () => boolean;
  detect: () => Promise<Game | null>;
  apply: (room: Room, game: Game | null) => void;
  clearLocal: () => void;
}

/**
 * Owns one uncancellable native game-detection invoke. Timer/focus triggers collapse into one
 * latest rerun; every result is fenced to the exact room, generation and current privacy setting.
 */
export class LatestGamePresence<Room, Game> {
  private generation = 0;
  private physical: Promise<Game | null> | null = null;
  private rerun = false;
  private intentActive = false;
  private appliedRoom: Room | null = null;

  constructor(private readonly dependencies: LatestGamePresenceDependencies<Room, Game>) {}

  request(): void {
    const room = this.dependencies.currentRoom();
    if (!room || !this.dependencies.enabled()) {
      if (this.intentActive || this.appliedRoom) this.invalidate();
      return;
    }
    this.intentActive = true;
    if (this.physical) {
      this.rerun = true;
      return;
    }

    const generation = this.generation;
    const physical = Promise.resolve().then(this.dependencies.detect);
    this.physical = physical;
    void physical.then((game) => {
      if (generation !== this.generation || room !== this.dependencies.currentRoom()
        || !this.dependencies.enabled()) return;
      try {
        if (this.appliedRoom && this.appliedRoom !== room) this.dependencies.apply(this.appliedRoom, null);
        this.dependencies.apply(room, game);
        this.appliedRoom = game ? room : null;
      } catch { /** the next poll remains available after a transient participant error */ }
    }, () => { /** native detection failure is retried by the next latest trigger */ }).finally(() => {
      if (this.physical !== physical) return;
      this.physical = null;
      if (!this.rerun) return;
      this.rerun = false;
      this.request();
    });
  }

  /** Invalidates a room/settings/logout boundary and clears already published presence now. */
  invalidate(): void {
    this.generation += 1;
    this.rerun = false;
    this.intentActive = false;
    const appliedRoom = this.appliedRoom;
    this.appliedRoom = null;
    if (appliedRoom) {
      try { this.dependencies.apply(appliedRoom, null); }
      catch { this.dependencies.clearLocal(); }
    } else this.dependencies.clearLocal();
  }
}

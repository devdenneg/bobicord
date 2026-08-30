interface NativeBroadcastStartOwnerOptions {
  stopTimeoutMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export interface NativeBroadcastStartIntent {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isCurrent: () => boolean;
  publish: () => void;
}

interface ActiveStart {
  generation: number;
  result: Promise<boolean>;
}

interface StopFlight {
  actual: Promise<void>;
  bounded: Promise<void>;
}

/**
 * Owns one native screen-share start intent. Closing the form or changing its account/voice owner
 * can never publish a late successful capture; a best-effort stop is issued immediately and again
 * after start only when the early stop completed before the native start did.
 */
export class NativeBroadcastStartOwner {
  private generation = 0;
  private active: ActiveStart | null = null;
  private stopFlight: StopFlight | null = null;
  private stop: (() => Promise<void>) | null = null;
  private readonly stopTimeoutMs: number;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancelTimer: (timer: unknown) => void;

  constructor(options: NativeBroadcastStartOwnerOptions = {}) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2_000;
    this.schedule = options.schedule || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimer = options.cancel || ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(intent: NativeBroadcastStartIntent): Promise<boolean> {
    if (this.active) return this.active.result;
    const generation = ++this.generation;
    this.stop = intent.stop;
    const nativeStart = Promise.resolve().then(intent.start);
    const record: ActiveStart = { generation, result: Promise.resolve(false) };
    this.active = record;

    const isCurrent = () => {
      if (generation !== this.generation) return false;
      try { return intent.isCurrent(); } catch { return false; }
    };
    const run = (async () => {
      try {
        await nativeStart;
      } catch (error) {
        await this.stopBounded();
        if (!isCurrent()) return false;
        throw error;
      }
      if (!isCurrent()) {
        // If an early cancel-stop returned before native start, its flight is already cleared and
        // this creates the required second idempotent stop. If it is still queued, this joins it.
        await this.stopBounded();
        return false;
      }
      try {
        intent.publish();
        return true;
      } catch (error) {
        await this.stopBounded();
        throw error;
      }
    })();
    const tracked = run.finally(() => {
      if (this.active === record) this.active = null;
    });
    record.result = tracked;
    return tracked;
  }

  invalidate(): void {
    this.generation += 1;
    if (this.active) void this.stopBounded();
  }

  dispose(): void {
    this.invalidate();
  }

  private stopBounded(): Promise<void> {
    if (this.stopFlight) return this.stopFlight.bounded;
    const stop = this.stop;
    if (!stop) return Promise.resolve();
    const actual = Promise.resolve().then(stop);
    let timer: unknown;
    let settled = false;
    const bounded = new Promise<void>((resolve) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        this.cancelTimer(timer);
        resolve();
      };
      timer = this.schedule(finish, this.stopTimeoutMs);
      actual.then(finish, finish);
    });
    const flight = { actual, bounded };
    this.stopFlight = flight;
    void actual.then(
      () => { if (this.stopFlight === flight) this.stopFlight = null; },
      () => { if (this.stopFlight === flight) this.stopFlight = null; },
    );
    return bounded;
  }
}

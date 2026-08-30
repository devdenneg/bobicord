interface InvitePreviewRequestOptions {
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface InvitePreviewCallbacks<T> {
  onPending: () => void;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
}

/** Owns the debounce, AbortController and latest-result fence for one mounted invite form. */
export class InvitePreviewRequest<T> {
  private generation = 0;
  private timer: unknown = null;
  private controller: AbortController | null = null;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancelTimer: (timer: unknown) => void;

  constructor(options: InvitePreviewRequestOptions = {}) {
    this.schedule = options.schedule || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimer = options.cancel || ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(
    code: string,
    load: (signal: AbortSignal) => Promise<T>,
    callbacks: InvitePreviewCallbacks<T>,
    delayMs = 400,
  ): void {
    this.invalidate();
    const generation = this.generation;
    callbacks.onPending();
    if (!code) return;

    const run = async () => {
      if (generation !== this.generation) return;
      this.timer = null;
      const controller = new AbortController();
      this.controller = controller;
      try {
        const value = await load(controller.signal);
        if (generation === this.generation && !controller.signal.aborted) callbacks.onSuccess(value);
      } catch (error) {
        if (generation === this.generation && !controller.signal.aborted) callbacks.onError(error);
      } finally {
        if (generation === this.generation && this.controller === controller) this.controller = null;
      }
    };
    if (delayMs <= 0) void run();
    else this.timer = this.schedule(() => { void run(); }, delayMs);
  }

  invalidate(): void {
    this.generation += 1;
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.invalidate();
  }
}

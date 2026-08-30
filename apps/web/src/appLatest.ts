export interface AppLatestInfo { version: string; url: string }

interface AppLatestLoaderOptions {
  timeoutMs?: number;
  successCacheMs?: number;
  emptyCacheMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface AppLatestFlight {
  actual: Promise<AppLatestInfo | null>;
  bounded: Promise<AppLatestInfo | null>;
}

/** One bounded physical manifest request shared by every Home mount. */
export class AppLatestLoader {
  private readonly timeoutMs: number;
  private readonly successCacheMs: number;
  private readonly emptyCacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private cache: { value: AppLatestInfo | null; until: number } | null = null;
  private flight: AppLatestFlight | null = null;

  constructor(private readonly url: string, options: AppLatestLoaderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.successCacheMs = options.successCacheMs ?? 5 * 60_000;
    this.emptyCacheMs = options.emptyCacheMs ?? 30_000;
    this.fetchImpl = options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    this.now = options.now || Date.now;
    this.schedule = options.schedule || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancel = options.cancel || ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  load(signal?: AbortSignal): Promise<AppLatestInfo | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const shared = this.sharedLoad();
    if (!signal) return shared;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: AppLatestInfo | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        resolve(value);
      };
      const aborted = () => finish(null);
      signal.addEventListener('abort', aborted, { once: true });
      shared.then(finish, () => finish(null));
    });
  }

  private sharedLoad(): Promise<AppLatestInfo | null> {
    if (this.cache && this.cache.until > this.now()) return Promise.resolve(this.cache.value);
    if (this.flight) return this.flight.bounded;

    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const actual = (async () => {
      const response = await this.fetchImpl(this.url, controller ? { signal: controller.signal } : undefined);
      if (!response.ok) return null;
      const data = await response.json();
      const url = data?.platforms?.['windows-x86_64']?.url;
      return typeof data?.version === 'string' && typeof url === 'string' ? { version: data.version, url } : null;
    })();
    let timer: unknown;
    let boundedSettled = false;
    const bounded = new Promise<AppLatestInfo | null>((resolve) => {
      const finish = (value: AppLatestInfo | null) => {
        if (boundedSettled) return;
        boundedSettled = true;
        this.cancel(timer);
        resolve(value);
      };
      timer = this.schedule(() => { controller?.abort(); finish(null); }, this.timeoutMs);
      actual.then(finish, () => finish(null));
    });
    const flight = { actual, bounded };
    this.flight = flight;
    void actual.then(
      (value) => {
        this.cache = { value, until: this.now() + (value ? this.successCacheMs : this.emptyCacheMs) };
        if (this.flight === flight) this.flight = null;
      },
      () => { if (this.flight === flight) this.flight = null; },
    );
    return bounded;
  }
}

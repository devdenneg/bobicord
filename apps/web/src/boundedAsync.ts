export class AsyncOperationTimeoutError extends Error {
  constructor(message = 'Операция не завершилась вовремя') {
    super(message);
    this.name = 'AsyncOperationTimeoutError';
  }
}

export interface BoundedKeyedOperationOptions {
  timeoutMs: number;
  maxInFlight: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface BoundedFlight<T> {
  actual: Promise<T>;
  bounded: Promise<T>;
}

/**
 * Keeps one native operation per exact key and a hard cap across distinct keys.
 * A caller deadline may settle while the uncancellable native promise remains in
 * the map; later callers reuse the same bounded result instead of leaking more IPC.
 */
export class BoundedKeyedOperations<T> {
  private readonly flights = new Map<string, BoundedFlight<T>>();
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(private readonly options: BoundedKeyedOperationOptions) {
    this.schedule = options.schedule || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancel = options.cancel || ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing.bounded;
    if (this.flights.size >= this.options.maxInFlight) {
      return Promise.reject(new AsyncOperationTimeoutError('Слишком много незавершённых операций'));
    }

    const actual = Promise.resolve().then(operation);
    let timer: unknown;
    let settled = false;
    const bounded = new Promise<T>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.cancel(timer);
        callback();
      };
      timer = this.schedule(() => finish(() => reject(new AsyncOperationTimeoutError())), this.options.timeoutMs);
      actual.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
    const flight = { actual, bounded };
    this.flights.set(key, flight);
    // Clear capacity only when the physical promise really settles. `then` handles both outcomes,
    // so a late rejection after the caller deadline cannot become unhandled.
    void actual.then(
      () => { if (this.flights.get(key) === flight) this.flights.delete(key); },
      () => { if (this.flights.get(key) === flight) this.flights.delete(key); },
    );
    return bounded;
  }
}

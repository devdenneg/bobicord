export interface OwnedRefreshOptions<T> {
  owner: string;
  signal?: AbortSignal;
  load: (signal?: AbortSignal) => Promise<T>;
  isOwnerCurrent: (owner: string) => boolean;
  commit: (value: T) => void;
}

interface RefreshFlight {
  owner: string;
  revision: number;
  controller: AbortController | null;
  signal?: AbortSignal;
  promise: Promise<boolean>;
}

/**
 * Coalesces background reads of one account-owned snapshot. `invalidate()` is the
 * write/mutation fence: a response that started before it can never commit, even
 * when the underlying fetch ignores AbortSignal and resolves much later.
 */
export class OwnedLatestRefresh<T> {
  private revision = 0;
  private requestSequence = 0;
  private flight: RefreshFlight | null = null;

  invalidate(): void {
    this.revision += 1;
    this.requestSequence += 1;
    this.flight?.controller?.abort();
  }

  run(options: OwnedRefreshOptions<T>): Promise<boolean> {
    if (!options.owner || options.signal?.aborted) return Promise.resolve(false);
    const revision = this.revision;
    const current = this.flight;
    if (current && current.owner === options.owner && current.revision === revision
      && !current.controller?.signal.aborted && !current.signal?.aborted) return current.promise;

    const sequence = ++this.requestSequence;
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const relayAbort = () => controller?.abort();
    if (options.signal?.aborted) controller?.abort();
    else options.signal?.addEventListener('abort', relayAbort, { once: true });

    const operation = (async () => {
      try {
        const value = await options.load(controller?.signal || options.signal);
        if (options.signal?.aborted || controller?.signal.aborted
          || this.revision !== revision || this.requestSequence !== sequence
          || !options.isOwnerCurrent(options.owner)) return false;
        options.commit(value);
        return true;
      } catch (error) {
        if (options.signal?.aborted || controller?.signal.aborted) return false;
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', relayAbort);
      }
    })();
    const tracked = operation.finally(() => {
      if (this.flight?.promise === tracked) this.flight = null;
    });
    this.flight = { owner: options.owner, revision, controller, signal: options.signal, promise: tracked };
    return tracked;
  }
}

interface JsonFetchDeadlineOptions {
  fetchImpl?: typeof fetch;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

/** Keep one deadline alive through both response headers and JSON body parsing. */
export function fetchJsonWithDeadline<T = unknown>(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
  options: JsonFetchDeadlineOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl || ((input, requestInit) => globalThis.fetch(input, requestInit));
  const schedule = options.schedule || ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel || ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const externalSignal = init.signal;
  if (externalSignal?.aborted) return Promise.reject(abortReason(externalSignal));

  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer: unknown;
  let settled = false;
  let removeExternalAbort = () => {};

  return new Promise<T>((resolve, reject) => {
    const finish = (value: T | Error, failed: boolean) => {
      if (settled) return;
      settled = true;
      cancel(timer);
      removeExternalAbort();
      if (failed) reject(value);
      else resolve(value as T);
    };
    if (externalSignal) {
      const onAbort = () => {
        controller?.abort(externalSignal.reason);
        finish(abortReason(externalSignal), true);
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
    }

    timer = schedule(() => {
      controller?.abort();
      finish(new Error(`Request timed out after ${timeoutMs}ms`), true);
    }, timeoutMs);

    const requestInit = controller ? { ...init, signal: controller.signal } : init;
    const actual = Promise.resolve().then(async () => {
      const response = await fetchImpl(url, requestInit);
      return await response.json() as T;
    });
    actual.then(
      (value) => finish(value, false),
      (error) => finish(error instanceof Error ? error : new Error(String(error)), true),
    );
  });
}

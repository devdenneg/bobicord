export const DOWNLOAD_TIMEOUT_MS = 120_000;

interface DownloadFetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** Fetches and consumes a download body under one exact abort/deadline owner. */
export async function fetchDownloadBlob(url: string, signal?: AbortSignal, options: DownloadFetchOptions = {}): Promise<Blob> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const relayAbort = () => controller?.abort();
  if (signal?.aborted) controller?.abort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const schedule = options.schedule || ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel || ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const timer = controller ? schedule(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) : null;
  try {
    const fetchImpl = options.fetchImpl || ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) throw new Error('Ошибка ' + response.status);
    return await response.blob();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Загрузка отменена', 'AbortError');
    if (controller?.signal.aborted) throw new Error('Сервер не ответил вовремя');
    throw error;
  } finally {
    if (timer !== null) cancel(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

const RECOVERABLE_AUTH_BOOTSTRAP_CODES = new Set([
  'NETWORK_ERROR',
  'REQUEST_TIMEOUT',
  'REQUEST_ABORTED',
  'AUTH_LOCK_TIMEOUT',
  'REFRESH_STALE',
  'PERSISTENT_AUTH_UNAVAILABLE',
]);

const TERMINAL_AUTH_BOOTSTRAP_CODES = new Set([
  'SESSION_REVOKED',
  'REFRESH_INVALID',
]);

export const AUTH_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

/**
 * The server has already installed and returned an authenticated session at this point. A failed
 * follow-up snapshot is not evidence that the credential disappeared: retain the authenticated
 * shell only for transport/concurrency failures and bounded-retry that read in the background.
 */
export function isRecoverableAcceptedSessionBootstrapError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; status?: unknown };
  const code = typeof failure.code === 'string' ? failure.code : '';
  if (TERMINAL_AUTH_BOOTSTRAP_CODES.has(code)) return false;
  if (RECOVERABLE_AUTH_BOOTSTRAP_CODES.has(code)) return true;
  const status = Number(failure.status);
  return Number.isFinite(status) && (status === 408 || status === 425 || status === 429 || status >= 500);
}

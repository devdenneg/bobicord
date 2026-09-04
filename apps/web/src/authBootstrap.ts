export const AUTH_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export function isTerminalAuthBootstrapError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { status?: unknown; code?: unknown };
  return Number(failure.status) === 401 || Number(failure.status) === 403
    || failure.code === 'SESSION_REVOKED' || failure.code === 'REFRESH_INVALID';
}

// Only a follow-up GET may use these retries, after authentication has returned a trusted user.
// Never replay a password/login mutation after an ambiguous transport failure.
export function isRecoverableAcceptedSessionBootstrapError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || isTerminalAuthBootstrapError(error)) return false;
  const failure = error as { status?: unknown; code?: unknown };
  if (failure.code === 'NETWORK_ERROR' || failure.code === 'REQUEST_TIMEOUT') return true;
  const status = Number(failure.status);
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

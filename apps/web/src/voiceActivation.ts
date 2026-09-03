/** Five seconds is outside an ordinary join but still catches the observed 6.6s successful path. */
export const SLOW_VOICE_JOIN_DIAGNOSTIC_MS = 5_000;

export type VoiceActivationHttpFailureDisposition = 'retry' | 'terminal' | 'server-updating';

/**
 * An activation request has already used the API client's single auth-refresh retry. Invalid,
 * unauthorized and forbidden requests therefore cannot recover inside the same voice intent.
 * A missing method/route is also terminal for this deployed server, but remains distinguishable
 * so the UI can explain a rolling client/server update without inspecting raw response text.
 */
export function voiceActivationHttpFailureDisposition(
  status: number | undefined,
): VoiceActivationHttpFailureDisposition {
  if (status === 404 || status === 405) return 'server-updating';
  if (status === 400 || status === 401 || status === 403) return 'terminal';
  return 'retry';
}

/**
 * Successful joins below this threshold remain ordinary control traffic. Only the already-bounded
 * fixed-schema diagnostic path consumes this scalar; no request, token or device data is accepted.
 */
export function shouldReportSlowVoiceJoin(joinElapsedMs: number): boolean {
  return Number.isFinite(joinElapsedMs) && joinElapsedMs >= SLOW_VOICE_JOIN_DIAGNOSTIC_MS;
}

/**
 * Keeps one activation retry inside its transaction deadline while respecting a server hint as
 * the minimum useful delay. Inputs are reduced to finite non-negative durations before use.
 */
export function boundedVoiceActivationRetryDelayMs(
  normalBackoffMs: number,
  remainingMs: number,
  serverRetryAfterSeconds?: number,
): number {
  const remaining = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  const normal = Number.isFinite(normalBackoffMs) ? Math.max(0, normalBackoffMs) : 0;
  const server = Number.isFinite(serverRetryAfterSeconds)
    ? Math.max(0, serverRetryAfterSeconds as number) * 1_000
    : 0;
  return Math.min(remaining, Math.max(normal, server));
}

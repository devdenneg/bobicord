import type { AuthResponse, PersistentSessionResponse } from './types';

export type NativeAuthResumeState = 'anonymous' | 'active' | 'logout_pending';

export interface NativeAuthResumeResult {
  state: NativeAuthResumeState;
  bundle?: PersistentSessionResponse;
}

export interface NativePushCleanup {
  userId: string;
  endpoint: string;
}

export interface NativeLogoutResult {
  complete: boolean;
  pending: boolean;
  pushCleanup?: { userId?: string; endpoints?: string[] };
}

export class NativeAuthBrokerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly attemptsRemaining?: number;
  readonly retryAfter?: number;

  constructor(value: unknown) {
    const raw = normalizeBrokerError(value);
    super(raw.message);
    this.name = 'NativeAuthBrokerError';
    this.code = raw.code;
    this.status = raw.status;
    this.details = raw.details;
    this.attemptsRemaining = raw.attemptsRemaining;
    this.retryAfter = raw.retryAfter;
  }
}

interface NormalizedBrokerError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
  attemptsRemaining?: number;
  retryAfter?: number;
}

function finiteNonNegative(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

function normalizeBrokerError(value: unknown): NormalizedBrokerError {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    const text = candidate;
    try { candidate = JSON.parse(text); }
    catch {
      return { code: 'NATIVE_AUTH_ERROR', message: text || 'Не удалось обработать защищённую сессию', status: 0 };
    }
  }
  const raw = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : {};
  const details = raw.details && typeof raw.details === 'object' && !Array.isArray(raw.details)
    ? raw.details as Record<string, unknown> : undefined;
  return {
    code: typeof raw.code === 'string' && raw.code ? raw.code : 'NATIVE_AUTH_ERROR',
    message: typeof raw.message === 'string' && raw.message
      ? raw.message : 'Не удалось обработать защищённую сессию',
    status: finiteNonNegative(raw.status) || 0,
    details,
    attemptsRemaining: finiteNonNegative(raw.attemptsRemaining ?? details?.attemptsRemaining),
    retryAfter: finiteNonNegative(raw.retryAfter ?? details?.retryAfter),
  };
}

async function invokeAuth<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof NativeAuthBrokerError ? error : new NativeAuthBrokerError(error);
  }
}

export function resumeNativeAuth(legacyToken: string | null): Promise<NativeAuthResumeResult> {
  return invokeAuth('native_auth_resume', { legacyToken: legacyToken || null });
}

export function refreshNativeAuth(): Promise<PersistentSessionResponse> {
  return invokeAuth('native_auth_refresh');
}

export function loginNativeAuth(username: string, password: string): Promise<AuthResponse> {
  return invokeAuth('native_auth_login', { username, password });
}

export function verifyNativeRegistration(flowId: string, code: string): Promise<AuthResponse> {
  return invokeAuth('native_auth_register_verify', { flowId, code });
}

export function verifyNativeEmail(
  accessToken: string,
  flowId: string,
  code: string,
): Promise<AuthResponse> {
  return invokeAuth('native_auth_email_verify', { accessToken, flowId, code });
}

export function changeNativePassword(
  accessToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<AuthResponse> {
  return invokeAuth('native_auth_password_change', { accessToken, currentPassword, newPassword });
}

export function beginNativeLogout(): Promise<boolean> {
  return invokeAuth('native_auth_begin_logout');
}

export function drainNativeLogout(pushCleanups: NativePushCleanup[]): Promise<NativeLogoutResult> {
  return invokeAuth('native_auth_drain_logout', { pushCleanups });
}

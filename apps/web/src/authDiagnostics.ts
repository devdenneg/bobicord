import { DiagnosticReportOutbox } from './diagnosticOutbox';
import type { DiagnosticOutboxOptions } from './diagnosticOutbox';
import { VoiceDiagnosticsRecorder } from './voiceDiagnostics';
import type { VoiceDiagnosticsRecorderOptions } from './voiceDiagnostics';
import type { VoiceDiagnosticEvent, VoiceDiagnosticReport } from './types';

const TRACE_TTL_MS = 5 * 60_000;
const FAILURE_COOLDOWN_MS = 30_000;
export type AuthDiagnosticStage = 'auth_login' | 'auth_session' | 'auth_profile';
export type AuthDiagnosticFinish = (error?: unknown, status?: number) => void;
type AuthDiagnosticUser = { id: string; username: string };
type Upload = (report: VoiceDiagnosticReport) => Promise<unknown>;

export interface AuthDiagnosticAttempt {
  request(stage: AuthDiagnosticStage): AuthDiagnosticFinish;
  accept(user: AuthDiagnosticUser, upload: Upload): boolean;
  cancel(): void;
}

export interface AuthDiagnosticsOptions extends VoiceDiagnosticsRecorderOptions {
  outbox?: DiagnosticOutboxOptions;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Trace {
  recorder: VoiceDiagnosticsRecorder;
  /** Only a short-lived in-memory equality guard, never an event or report field. */
  subject: string | null;
  createdAt: number;
  failed: boolean;
  timer: unknown;
}

interface AttemptState {
  ownerId: string | null;
}

function normalizedSubject(subject?: string): string | null {
  if (typeof subject !== 'string' || subject.length > 128) return null;
  return subject.trim().toLowerCase() || null;
}

function boundedStatus(status: unknown): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 599
    ? status : undefined;
}

function errorField(error: unknown, field: 'name' | 'code' | 'status'): unknown {
  try { return error && typeof error === 'object' ? (error as Record<string, unknown>)[field] : undefined; }
  catch { return undefined; }
}

function failureCategory(error: unknown, status?: number): NonNullable<VoiceDiagnosticEvent['code']> {
  // Read only classifications. Error messages, request objects and response bodies are never kept.
  const code = errorField(error, 'code'), name = errorField(error, 'name');
  if (code === 'REQUEST_ABORTED' || name === 'AbortError') return 'aborted';
  if (code === 'REQUEST_TIMEOUT' || name === 'TimeoutError' || status === 408) return 'timeout';
  if (code === 'NETWORK_ERROR' || name === 'TypeError') return 'network';
  if (code === 'INVALID_RESPONSE') return 'invalid_response';
  if (status === 429) return 'rate_limited';
  if (status !== undefined && status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  return 'unknown';
}

/**
 * Pre-login evidence stays in one expiring memory-only recorder. Uploads are enabled only after
 * the caller has installed credentials and supplied the authenticated server user. Constructors
 * do no work, so importing this manager from the API module never reads uninitialized imports.
 */
export class AuthDiagnostics {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private current: AttemptState | null = null;
  private trace: Trace | null = null;
  private outbox: DiagnosticReportOutbox | null = null;
  private lastFailureAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: AuthDiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as number));
  }

  get active(): boolean { return this.current !== null; }
  get accepted(): boolean { return this.current?.ownerId != null; }

  private clearTrace(): void {
    if (!this.trace) return;
    this.clearTimer(this.trace.timer);
    this.trace.subject = null;
    this.trace.recorder.reset();
    this.trace = null;
  }

  private newTrace(subject: string | null): Trace {
    this.clearTrace();
    const recorder = new VoiceDiagnosticsRecorder({ ...this.options, now: this.now });
    recorder.start();
    const trace: Trace = { recorder, subject, createdAt: this.now(), failed: false, timer: null };
    this.trace = trace;
    trace.timer = this.setTimer(() => { if (this.trace === trace) this.clearTrace(); }, TRACE_TTL_MS);
    return trace;
  }

  private liveTrace(): Trace {
    const age = this.trace ? this.now() - this.trace.createdAt : TRACE_TTL_MS;
    return this.trace && age >= 0 && age < TRACE_TTL_MS ? this.trace : this.newTrace(null);
  }

  private stopUploader(): void {
    this.outbox?.dispose();
    this.outbox = null;
  }

  startAttempt(subject?: string): AuthDiagnosticAttempt {
    const normalized = normalizedSubject(subject);
    const age = this.trace ? this.now() - this.trace.createdAt : TRACE_TTL_MS;
    const retain = !this.current?.ownerId && this.trace?.failed && normalized !== null
      && normalized === this.trace.subject && age >= 0 && age < TRACE_TTL_MS;
    this.stopUploader();
    const attempt: AttemptState = { ownerId: null };
    this.current = attempt;
    this.lastFailureAt = Number.NEGATIVE_INFINITY;
    if (!retain) this.newTrace(normalized);
    return {
      request: (stage) => this.requestFor(attempt, stage),
      accept: (user, upload) => this.acceptFor(attempt, user, upload),
      cancel: () => {
        if (this.current !== attempt) return;
        this.stopUploader();
        this.current = null;
        if (attempt.ownerId || !this.trace?.failed) this.clearTrace();
      },
    };
  }

  request(stage: AuthDiagnosticStage): AuthDiagnosticFinish {
    return this.current ? this.requestFor(this.current, stage) : () => {};
  }

  private requestFor(attempt: AttemptState, stage: AuthDiagnosticStage): AuthDiagnosticFinish {
    if (this.current !== attempt || !['auth_login', 'auth_session', 'auth_profile'].includes(stage)) return () => {};
    const trace = this.liveTrace();
    const startedAt = this.now();
    trace.recorder.record({ kind: 'auth_request_started', stage, outcome: 'started' });
    let finished = false;
    return (error, status) => {
      if (finished || this.current !== attempt || this.trace !== trace) return;
      finished = true;
      if (this.now() - trace.createdAt >= TRACE_TTL_MS) { this.clearTrace(); return; }
      const errorStatus = errorField(error, 'status');
      const httpStatus = boundedStatus(status) ?? boundedStatus(errorStatus) ?? 0;
      const failed = error != null || httpStatus >= 400;
      const code = failed ? failureCategory(error, httpStatus) : 'none';
      trace.recorder.record({
        kind: 'auth_request_finished', stage,
        outcome: code === 'aborted' ? 'cancelled' : code === 'timeout' ? 'timed_out' : failed ? 'failed' : 'ok',
        code, httpStatus, requestElapsedMs: this.now() - startedAt,
      });
      if (!failed || code === 'aborted') return;
      trace.failed = true;
      if (!attempt.ownerId || !this.outbox || this.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS) return;
      if (this.outbox.enqueue(trace.recorder.buildReport('auth_failed'))) this.lastFailureAt = this.now();
    };
  }

  accept(user: AuthDiagnosticUser, upload: Upload): boolean {
    if (!this.current) this.startAttempt();
    return this.acceptFor(this.current!, user, upload);
  }

  private acceptFor(attempt: AttemptState, user: AuthDiagnosticUser, upload: Upload): boolean {
    if (this.current !== attempt || typeof user?.id !== 'string' || !user.id || user.id.length > 128
      || !normalizedSubject(user.username) || typeof upload !== 'function') return false;
    if (attempt.ownerId) {
      if (attempt.ownerId === user.id) return true;
      this.dispose();
      return false;
    }
    let trace = this.liveTrace();
    if (trace.subject !== null && trace.subject !== normalizedSubject(user.username)) trace = this.newTrace(null);
    trace.subject = null;
    attempt.ownerId = user.id;
    const ownerId = user.id;
    this.outbox = new DiagnosticReportOutbox(ownerId, async (report) => {
      if (this.current !== attempt || attempt.ownerId !== ownerId) throw new Error('diagnostic owner inactive');
      return upload(report);
    }, { ...this.options.outbox, now: this.now });
    this.outbox.start();
    if (trace.failed) {
      this.outbox.enqueue(trace.recorder.buildReport('auth_recovered'));
      trace.failed = false;
    }
    return true;
  }

  dispose(): void {
    this.current = null;
    this.stopUploader();
    this.clearTrace();
    this.lastFailureAt = Number.NEGATIVE_INFINITY;
  }
}

export const authDiagnostics = new AuthDiagnostics();

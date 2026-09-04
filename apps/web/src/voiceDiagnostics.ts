import type {
  VoiceDiagnosticClient,
  VoiceDiagnosticEvent,
  VoiceDiagnosticIncident,
  VoiceDiagnosticReport,
} from './types';

declare const __APP_VERSION__: string;

export const VOICE_DIAGNOSTIC_MAX_EVENTS = 128;
export const VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES = 24 * 1024;
// Reports are retained for three days server-side. Long-running desktop/PWA calls must keep a
// useful monotonic timeline instead of pinning every event after minute ten to one timestamp.
const MAX_SESSION_MS = 3 * 24 * 60 * 60_000;

const INCIDENTS = new Set<VoiceDiagnosticIncident>([
  'manual', 'join_succeeded', 'join_stuck', 'connection_failed', 'reconnect_loop', 'uplink_silent',
  'inbound_silent', 'mute_divergence', 'mic_failed', 'playback_blocked',
  'output_route_failed', 'ui_stall', 'session_ended', 'stream_watch_succeeded',
  'stream_watch_failed', 'stream_watch_recovered', 'auth_failed', 'auth_recovered',
]);
const EVENT_KINDS = new Set<VoiceDiagnosticEvent['kind']>([
  'join_started', 'intent_finished', 'hub_connected', 'lease_claimed',
  'media_token_received', 'media_connected', 'media_activated', 'join_completed',
  'join_failed', 'mic_capture_finished', 'mic_published', 'mic_recovery_started',
  'mic_recovery_finished', 'mute_changed', 'deafen_changed', 'background',
  'foreground', 'network_changed', 'reconnecting', 'reconnected', 'disconnected',
  'playback_blocked', 'output_route_failed', 'ui_stall', 'rtc_sample',
  'uplink_stalled', 'inbound_stalled', 'left', 'stream_watch_started',
  'stream_watch_step', 'stream_watch_retry', 'stream_watch_finished',
  'auth_request_started', 'auth_request_finished', 'mic_source_changed',
]);
const PLATFORMS = new Set<VoiceDiagnosticClient['platform']>([
  'ios', 'ipados', 'android', 'macos', 'windows', 'linux', 'other', 'unknown',
]);
const INSTALL_MODES = new Set<VoiceDiagnosticClient['installMode']>([
  'browser', 'standalone', 'native', 'unknown',
]);
const NETWORK_TYPES = new Set<VoiceDiagnosticClient['networkType']>([
  'slow-2g', '2g', '3g', '4g', 'wifi', 'ethernet', 'cellular', 'other', 'unknown',
]);
const STAGES = new Set<NonNullable<VoiceDiagnosticEvent['stage']>>([
  'intent', 'hub', 'claim', 'media_token', 'media_connect', 'activation',
  'mic_capture', 'mic_publish', 'mic_recovery', 'playback', 'output_route', 'rtc', 'ui',
  'watch_intent', 'watch_auth', 'watch_listeners', 'watch_native_start',
  'watch_signaling', 'watch_join', 'watch_parent', 'watch_negotiation',
  'watch_track', 'watch_playback', 'watch_recovery',
  'auth_login', 'auth_session', 'auth_profile',
]);
const OUTCOMES = new Set<NonNullable<VoiceDiagnosticEvent['outcome']>>([
  'started', 'ok', 'failed', 'timed_out', 'blocked', 'unsupported', 'cancelled',
  'superseded', 'stalled', 'recovered',
]);
const ERROR_CODES = new Set<NonNullable<VoiceDiagnosticEvent['code']>>([
  'none', 'timeout', 'network', 'offline', 'auth', 'permission', 'device_lost',
  'media_blocked', 'disconnected', 'sdk', 'unsupported', 'aborted', 'invalid_state', 'unknown',
  'session_closing', 'rate_limited', 'server', 'invalid_response',
  'signaling_unauthorized', 'signaling_forbidden', 'listener_failed',
  'native_start_failed', 'signaling_closed', 'no_parent', 'negotiation_failed',
  'ice_failed', 'track_missing', 'decode_timeout', 'playback_waiting',
]);
const CONNECTION_STATES = new Set<NonNullable<VoiceDiagnosticEvent['connectionState']>>([
  'new', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'unknown',
]);
const ICE_STATES = new Set<NonNullable<VoiceDiagnosticEvent['iceState']>>([
  'new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed', 'unknown',
]);
const TRACK_STATES = new Set<NonNullable<VoiceDiagnosticEvent['trackState']>>([
  'live', 'ended', 'missing', 'unknown',
]);
const AUDIO_CONTEXT_STATES = new Set<NonNullable<VoiceDiagnosticEvent['audioContextState']>>([
  'running', 'suspended', 'interrupted', 'closed', 'missing', 'unknown',
]);
const AUDIO_SESSION_STATES = new Set<NonNullable<VoiceDiagnosticEvent['audioSessionState']>>([
  'active', 'inactive', 'interrupted',
]);
const AUDIO_SESSION_TYPES = new Set<NonNullable<VoiceDiagnosticEvent['audioSessionType']>>([
  'auto', 'play-and-record', 'playback', 'ambient', 'transient', 'transient-solo',
]);
const CAPTURE_EVENTS = new Set<NonNullable<VoiceDiagnosticEvent['captureEvent']>>([
  'mute', 'unmute', 'ended', 'session_state',
]);
const OUTPUT_ROUTES = new Set<NonNullable<VoiceDiagnosticEvent['outputRoute']>>([
  'default', 'custom', 'system', 'unsupported', 'unknown',
]);
const OUTPUT_TARGETS = new Set<NonNullable<VoiceDiagnosticEvent['outputTarget']>>([
  'voice_mixer', 'media_element', 'stream_mixer', 'context_recovery',
]);
const OUTPUT_OPERATIONS = new Set<NonNullable<VoiceDiagnosticEvent['outputOperation']>>([
  'enumerate', 'set_sink', 'create_context', 'rebind', 'resume', 'start_audio',
]);
const MIC_MODES = new Set<NonNullable<VoiceDiagnosticEvent['micMode']>>(['voice', 'ptt', 'unknown']);
const MIC_CAPTURE_PATHS = new Set<NonNullable<VoiceDiagnosticEvent['micCapturePath']>>(['direct', 'webaudio']);
const STREAM_TRANSPORTS = new Set<NonNullable<VoiceDiagnosticEvent['streamTransport']>>([
  'livekit', 'tree_web', 'tree_native',
]);
const WATCH_END_REASONS = new Set<NonNullable<VoiceDiagnosticEvent['watchEndReason']>>([
  'user_close', 'view_switch', 'server_exit', 'auth_handoff', 'session_terminal',
  'logout', 'engine_dispose', 'connection_loss', 'stream_ended', 'quality_change',
  'recovery_failed', 'playback_timeout', 'superseded', 'unknown',
]);

const BOOLEAN_FIELDS = [
  'documentHidden', 'online', 'micEnabled', 'publicationMuted', 'upstreamPaused',
  'deafened', 'pushToTalk', 'speechDetected', 'canPlaybackAudio',
  'rawTrackMuted', 'rawTrackEnabled', 'publishedTrackEnabled',
] as const satisfies readonly (keyof VoiceDiagnosticEvent)[];

const NUMBER_FIELDS = {
  requestElapsedMs: [0, 120_000, true],
  rttMs: [0, 120_000, true],
  jitterMs: [0, 120_000, true],
  packetsLostDelta: [0, 10_000_000, true],
  packetsReceivedDelta: [0, 100_000_000, true],
  packetsSentDelta: [0, 100_000_000, true],
  bytesReceivedDelta: [0, 2_000_000_000, true],
  bytesSentDelta: [0, 2_000_000_000, true],
  concealedSamplesDelta: [0, 2_000_000_000, true],
  audioLevel: [0, 1, false],
  eventLoopLagMs: [0, 120_000, true],
  joinElapsedMs: [0, MAX_SESSION_MS, true],
  reconnectCount: [0, 1_000, true],
  participantCount: [0, 10_000, true],
} as const satisfies Partial<Record<keyof VoiceDiagnosticEvent, readonly [number, number, boolean]>>;

export interface VoiceDiagnosticEnvironment {
  userAgent?: unknown;
  platform?: unknown;
  maxTouchPoints?: unknown;
  standalone?: unknown;
  displayModeStandalone?: unknown;
  native?: unknown;
  connectionType?: unknown;
  effectiveNetworkType?: unknown;
  appVersion?: unknown;
}

export type VoiceDiagnosticEventInput = Omit<VoiceDiagnosticEvent, 'atMs'>;

export interface VoiceDiagnosticsRecorderOptions {
  now?: () => number;
  client?: VoiceDiagnosticClient;
  createReportId?: () => string;
}

function finiteNumber(value: unknown, min: number, max: number, integer: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const bounded = Math.max(min, Math.min(max, value));
  return integer ? Math.round(bounded) : Math.round(bounded * 1_000) / 1_000;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback?: T): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : fallback;
}

function safeAppVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[.-](\d{1,6}))?$/u.exec(value);
  if (!match) return undefined;
  return match.slice(1).filter((part): part is string => part !== undefined)
    .map((part) => String(Number(part))).join('.');
}

function globalEnvironment(): VoiceDiagnosticEnvironment {
  const nav = typeof navigator === 'object' ? navigator as Navigator & {
    standalone?: boolean;
    connection?: { type?: string; effectiveType?: string };
  } : undefined;
  const displayModeStandalone = typeof window === 'object'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  return {
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
    standalone: nav?.standalone,
    displayModeStandalone,
    native: typeof window === 'object' && '__TAURI_INTERNALS__' in window,
    connectionType: nav?.connection?.type,
    effectiveNetworkType: nav?.connection?.effectiveType,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
  };
}

export function detectVoiceDiagnosticNetworkType(
  environment: VoiceDiagnosticEnvironment = globalEnvironment(),
): VoiceDiagnosticClient['networkType'] {
  const physical = enumValue(environment.connectionType, NETWORK_TYPES);
  if (physical === 'wifi' || physical === 'ethernet' || physical === 'cellular') return physical;
  const effective = enumValue(environment.effectiveNetworkType, NETWORK_TYPES);
  if (effective === 'slow-2g' || effective === '2g' || effective === '3g' || effective === '4g') return effective;
  if (typeof environment.connectionType === 'string' || typeof environment.effectiveNetworkType === 'string') return 'other';
  return 'unknown';
}

export function detectVoiceDiagnosticClient(
  environment: VoiceDiagnosticEnvironment = globalEnvironment(),
): VoiceDiagnosticClient {
  const ua = typeof environment.userAgent === 'string' ? environment.userAgent : '';
  const platformValue = typeof environment.platform === 'string' ? environment.platform : '';
  const touchPoints = typeof environment.maxTouchPoints === 'number' ? environment.maxTouchPoints : 0;
  let platform: VoiceDiagnosticClient['platform'] = 'unknown';
  if (/iPhone|iPod/u.test(ua)) platform = 'ios';
  else if (/iPad/u.test(ua) || (platformValue === 'MacIntel' && touchPoints > 1)) platform = 'ipados';
  else if (/Android/u.test(ua)) platform = 'android';
  else if (/Win/u.test(platformValue) || /Windows/u.test(ua)) platform = 'windows';
  else if (/Mac/u.test(platformValue) || /Macintosh|Mac OS X/u.test(ua)) platform = 'macos';
  else if (/Linux/u.test(platformValue) || /Linux/u.test(ua)) platform = 'linux';
  else if (ua || platformValue) platform = 'other';

  const kind: VoiceDiagnosticClient['kind'] = environment.native === true ? 'native' : 'web';
  const installMode: VoiceDiagnosticClient['installMode'] = kind === 'native'
    ? 'native'
    : (environment.standalone === true || environment.displayModeStandalone === true ? 'standalone' : 'browser');
  const client: VoiceDiagnosticClient = {
    kind,
    platform,
    installMode,
    networkType: detectVoiceDiagnosticNetworkType(environment),
  };
  const appVersion = safeAppVersion(environment.appVersion);
  if (appVersion) client.appVersion = appVersion;
  return client;
}

function sanitizeClient(client: VoiceDiagnosticClient): VoiceDiagnosticClient {
  const safe: VoiceDiagnosticClient = {
    kind: client.kind === 'native' ? 'native' : 'web',
    platform: enumValue(client.platform, PLATFORMS, 'unknown')!,
    installMode: enumValue(client.installMode, INSTALL_MODES, 'unknown')!,
    networkType: enumValue(client.networkType, NETWORK_TYPES, 'unknown')!,
  };
  const appVersion = safeAppVersion(client.appVersion);
  if (appVersion) safe.appVersion = appVersion;
  return safe;
}

function sanitizeEvent(input: VoiceDiagnosticEventInput, atMs: number): VoiceDiagnosticEvent | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as unknown as Record<string, unknown>;
  const kind = enumValue(source.kind, EVENT_KINDS);
  if (!kind) return null;
  const event: VoiceDiagnosticEvent = { atMs, kind };
  const stage = enumValue(source.stage, STAGES);
  const outcome = enumValue(source.outcome, OUTCOMES);
  const code = enumValue(source.code, ERROR_CODES);
  const connectionState = enumValue(source.connectionState, CONNECTION_STATES);
  const iceState = enumValue(source.iceState, ICE_STATES);
  const trackState = enumValue(source.trackState, TRACK_STATES);
  const audioContextState = enumValue(source.audioContextState, AUDIO_CONTEXT_STATES);
  const audioSessionState = enumValue(source.audioSessionState, AUDIO_SESSION_STATES);
  const audioSessionType = enumValue(source.audioSessionType, AUDIO_SESSION_TYPES);
  const captureEvent = enumValue(source.captureEvent, CAPTURE_EVENTS);
  const outputRoute = enumValue(source.outputRoute, OUTPUT_ROUTES);
  const outputTarget = enumValue(source.outputTarget, OUTPUT_TARGETS);
  const outputOperation = enumValue(source.outputOperation, OUTPUT_OPERATIONS);
  const micMode = enumValue(source.micMode, MIC_MODES);
  const micCapturePath = enumValue(source.micCapturePath, MIC_CAPTURE_PATHS);
  const streamTransport = enumValue(source.streamTransport, STREAM_TRANSPORTS);
  const watchEndReason = enumValue(source.watchEndReason, WATCH_END_REASONS);
  const networkType = enumValue(source.networkType, NETWORK_TYPES);
  if (stage) event.stage = stage;
  if (outcome) event.outcome = outcome;
  if (code) event.code = code;
  if (connectionState) event.connectionState = connectionState;
  if (iceState) event.iceState = iceState;
  if (trackState) event.trackState = trackState;
  if (audioContextState) event.audioContextState = audioContextState;
  if (audioSessionState) event.audioSessionState = audioSessionState;
  if (audioSessionType) event.audioSessionType = audioSessionType;
  if (captureEvent) event.captureEvent = captureEvent;
  if (outputRoute) event.outputRoute = outputRoute;
  if (outputTarget) event.outputTarget = outputTarget;
  if (outputOperation) event.outputOperation = outputOperation;
  if (micMode) event.micMode = micMode;
  if (micCapturePath) event.micCapturePath = micCapturePath;
  if (streamTransport) event.streamTransport = streamTransport;
  if (watchEndReason) event.watchEndReason = watchEndReason;
  if (networkType) event.networkType = networkType;
  if (typeof source.httpStatus === 'number' && Number.isInteger(source.httpStatus)
    && source.httpStatus >= 0 && source.httpStatus <= 599) event.httpStatus = source.httpStatus;
  for (const field of BOOLEAN_FIELDS) {
    if (typeof source[field] === 'boolean') (event as unknown as Record<string, unknown>)[field] = source[field];
  }
  for (const [field, limits] of Object.entries(NUMBER_FIELDS)) {
    const value = finiteNumber(source[field], limits[0], limits[1], limits[2]);
    if (value !== undefined) (event as unknown as Record<string, unknown>)[field] = value;
  }
  return event;
}

function monotonicNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function createVoiceDiagnosticReportId(): string {
  const bytes = new Uint8Array(12);
  const cryptoApi = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function reportByteLength(report: VoiceDiagnosticReport): number {
  return new TextEncoder().encode(JSON.stringify(report)).byteLength;
}

/**
 * Stores only the fixed diagnostic schema. In particular, no caller-owned object is spread into a
 * report, so unexpected fields cannot accidentally become part of an upload.
 */
export class VoiceDiagnosticsRecorder {
  private readonly now: () => number;
  private readonly createReportId: () => string;
  private client: VoiceDiagnosticClient;
  private startedAt = 0;
  private lastNow = 0;
  private events: VoiceDiagnosticEvent[] = [];
  private truncated = false;
  private running = false;

  constructor(options: VoiceDiagnosticsRecorderOptions = {}) {
    this.now = options.now ?? monotonicNow;
    this.createReportId = options.createReportId ?? createVoiceDiagnosticReportId;
    this.client = sanitizeClient(options.client ?? detectVoiceDiagnosticClient());
  }

  get active(): boolean { return this.running; }

  start(client?: VoiceDiagnosticClient): void {
    if (client) this.client = sanitizeClient(client);
    const current = this.now();
    this.startedAt = Number.isFinite(current) ? current : 0;
    this.lastNow = this.startedAt;
    this.events = [];
    this.truncated = false;
    this.running = true;
  }

  reset(): void {
    this.events = [];
    this.truncated = false;
    this.running = false;
    this.startedAt = 0;
    this.lastNow = 0;
  }

  private elapsedMs(): number {
    const sampled = this.now();
    if (Number.isFinite(sampled)) this.lastNow = Math.max(this.lastNow, sampled);
    return Math.round(Math.max(0, Math.min(MAX_SESSION_MS, this.lastNow - this.startedAt)));
  }

  record(input: VoiceDiagnosticEventInput): boolean {
    if (!this.running) return false;
    const event = sanitizeEvent(input, this.elapsedMs());
    if (!event) return false;
    this.events.push(event);
    if (this.events.length > VOICE_DIAGNOSTIC_MAX_EVENTS) {
      this.events.splice(0, this.events.length - VOICE_DIAGNOSTIC_MAX_EVENTS);
      this.truncated = true;
    }
    return true;
  }

  buildReport(incident: VoiceDiagnosticIncident): VoiceDiagnosticReport {
    if (!INCIDENTS.has(incident)) throw new TypeError('Invalid voice diagnostic incident');
    const durationMs = this.running ? this.elapsedMs() : 0;
    const report: VoiceDiagnosticReport = {
      schemaVersion: 1,
      clientReportId: this.createReportId(),
      incident,
      client: { ...this.client },
      durationMs,
      events: this.events.map((event) => ({ ...event })),
    };
    if (this.truncated) report.truncated = true;
    // The ordinary API parser is intentionally smaller than legacy stream diagnostics. Trim the
    // oldest fixed-schema samples here so a useful incident tail reaches the server instead of the
    // whole request being rejected before route-level validation can run.
    while (reportByteLength(report) > VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES && report.events.length > 1) {
      report.events.shift();
      report.truncated = true;
    }
    return report;
  }
}

export interface VoiceEventLoopStallMonitorOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  isDocumentHidden?: () => boolean;
  intervalMs?: number;
  thresholdMs?: number;
  cooldownMs?: number;
}

/** A single-timer, foreground-only watchdog. start()/stop() map to one active voice session. */
export class VoiceEventLoopStallMonitor {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly isDocumentHidden: () => boolean;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly cooldownMs: number;
  private readonly onStall: (lagMs: number) => void;
  private timer: unknown = null;
  private running = false;
  private expectedAt = 0;
  private lastIncidentAt = Number.NEGATIVE_INFINITY;

  constructor(onStall: (lagMs: number) => void, options: VoiceEventLoopStallMonitorOptions = {}) {
    this.onStall = onStall;
    this.now = options.now ?? monotonicNow;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.isDocumentHidden = options.isDocumentHidden ?? (() => typeof document === 'object' && document.hidden);
    this.intervalMs = finiteNumber(options.intervalMs ?? 1_000, 100, 60_000, true) ?? 1_000;
    this.thresholdMs = finiteNumber(options.thresholdMs ?? 800, 100, 120_000, true) ?? 800;
    this.cooldownMs = finiteNumber(options.cooldownMs ?? 30_000, 0, 600_000, true) ?? 30_000;
  }

  get active(): boolean { return this.running; }

  start(): boolean {
    if (this.running) return false;
    this.running = true;
    this.lastIncidentAt = Number.NEGATIVE_INFINITY;
    this.expectedAt = this.now() + this.intervalMs;
    this.arm();
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (!this.running || this.timer !== null) return;
    this.timer = this.setTimer(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    this.timer = null;
    if (!this.running) return;
    const current = this.now();
    const lagMs = Math.max(0, current - this.expectedAt);
    this.expectedAt = current + this.intervalMs;
    try {
      if (!this.isDocumentHidden() && lagMs >= this.thresholdMs
        && current - this.lastIncidentAt >= this.cooldownMs) {
        this.lastIncidentAt = current;
        try { this.onStall(Math.round(Math.min(120_000, lagMs))); }
        catch { /** diagnostics must never destabilize the media session */ }
      }
    } finally {
      this.arm();
    }
  }
}

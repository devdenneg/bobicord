const crypto = require('crypto');

const VOICE_DIAGNOSTIC_SCHEMA_VERSION = 1;
const VOICE_DIAGNOSTIC_RETENTION_MS = 3 * 24 * 60 * 60_000;
const VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES = 24 * 1024;
const VOICE_DIAGNOSTIC_MAX_SESSION_MS = 3 * 24 * 60 * 60_000;

const INCIDENTS = new Set([
  'manual', 'join_succeeded', 'join_stuck', 'connection_failed', 'reconnect_loop', 'uplink_silent',
  'inbound_silent', 'mute_divergence', 'mic_failed', 'playback_blocked',
  'output_route_failed', 'ui_stall', 'session_ended', 'stream_watch_succeeded',
  'stream_watch_failed', 'stream_watch_recovered', 'auth_failed', 'auth_recovered',
]);
const CLIENT_KINDS = new Set(['web', 'native']);
const PLATFORMS = new Set(['ios', 'ipados', 'android', 'macos', 'windows', 'linux', 'other', 'unknown']);
const INSTALL_MODES = new Set(['browser', 'standalone', 'native', 'unknown']);
const NETWORK_TYPES = new Set(['slow-2g', '2g', '3g', '4g', 'wifi', 'ethernet', 'cellular', 'other', 'unknown']);
const EVENT_KINDS = new Set([
  'join_started', 'intent_finished', 'hub_connected', 'lease_claimed',
  'media_token_received', 'media_connected', 'media_activated', 'join_completed',
  'join_failed', 'mic_capture_finished', 'mic_published', 'mic_recovery_started',
  'mic_recovery_finished', 'mute_changed', 'deafen_changed', 'background',
  'foreground', 'network_changed', 'reconnecting', 'reconnected', 'disconnected',
  'playback_blocked', 'output_route_failed', 'ui_stall', 'rtc_sample',
  'uplink_stalled', 'inbound_stalled', 'left', 'stream_watch_started',
  'stream_watch_step', 'stream_watch_retry', 'stream_watch_finished',
  'auth_request_started', 'auth_request_finished',
]);
const STAGES = new Set([
  'intent', 'hub', 'claim', 'media_token', 'media_connect', 'activation',
  'mic_capture', 'mic_publish', 'mic_recovery', 'playback', 'output_route', 'rtc', 'ui',
  'watch_intent', 'watch_auth', 'watch_listeners', 'watch_native_start',
  'watch_signaling', 'watch_join', 'watch_parent', 'watch_negotiation',
  'watch_track', 'watch_playback', 'watch_recovery',
  'auth_login', 'auth_session', 'auth_profile',
]);
const OUTCOMES = new Set([
  'started', 'ok', 'failed', 'timed_out', 'blocked', 'unsupported', 'cancelled',
  'superseded', 'stalled', 'recovered',
]);
const ERROR_CODES = new Set([
  'none', 'timeout', 'network', 'offline', 'auth', 'permission', 'device_lost',
  'media_blocked', 'disconnected', 'sdk', 'unsupported', 'aborted', 'invalid_state', 'unknown',
  'session_closing', 'rate_limited', 'server', 'invalid_response',
  'signaling_unauthorized', 'signaling_forbidden', 'listener_failed',
  'native_start_failed', 'signaling_closed', 'no_parent', 'negotiation_failed',
  'ice_failed', 'track_missing', 'decode_timeout', 'playback_waiting',
]);
const CONNECTION_STATES = new Set(['new', 'connecting', 'connected', 'reconnecting', 'disconnected', 'closed', 'unknown']);
const ICE_STATES = new Set(['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed', 'unknown']);
const TRACK_STATES = new Set(['live', 'ended', 'missing', 'unknown']);
const AUDIO_CONTEXT_STATES = new Set(['running', 'suspended', 'interrupted', 'closed', 'missing', 'unknown']);
const OUTPUT_ROUTES = new Set(['default', 'custom', 'system', 'unsupported', 'unknown']);
const OUTPUT_TARGETS = new Set(['voice_mixer', 'media_element', 'stream_mixer', 'context_recovery']);
const OUTPUT_OPERATIONS = new Set([
  'enumerate', 'set_sink', 'create_context', 'rebind', 'resume', 'start_audio',
]);
const MIC_MODES = new Set(['voice', 'ptt', 'unknown']);
const MIC_CAPTURE_PATHS = new Set(['direct', 'webaudio']);
const STREAM_TRANSPORTS = new Set(['livekit', 'tree_web', 'tree_native']);
const WATCH_END_REASONS = new Set([
  'user_close', 'view_switch', 'server_exit', 'auth_handoff', 'session_terminal',
  'logout', 'engine_dispose', 'connection_loss', 'stream_ended', 'quality_change',
  'recovery_failed', 'playback_timeout', 'superseded', 'unknown',
]);
const CONTROL_INCIDENTS = new Set(['join_succeeded', 'session_ended', 'stream_watch_succeeded', 'auth_recovered']);

const BOOLEAN_FIELDS = [
  'documentHidden', 'online', 'micEnabled', 'publicationMuted', 'upstreamPaused',
  'deafened', 'pushToTalk', 'speechDetected', 'canPlaybackAudio',
];
const NUMBER_FIELDS = Object.freeze({
  requestElapsedMs: [0, 120_000],
  rttMs: [0, 120_000],
  jitterMs: [0, 120_000],
  packetsLostDelta: [0, 10_000_000],
  packetsReceivedDelta: [0, 100_000_000],
  packetsSentDelta: [0, 100_000_000],
  bytesReceivedDelta: [0, 2_000_000_000],
  bytesSentDelta: [0, 2_000_000_000],
  concealedSamplesDelta: [0, 2_000_000_000],
  audioLevel: [0, 1],
  eventLoopLagMs: [0, 120_000],
  joinElapsedMs: [0, 600_000],
  reconnectCount: [0, 1_000],
  participantCount: [0, 10_000],
});

class VoiceDiagnosticValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceDiagnosticValidationError';
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enumValue(value, allowed, fallback) {
  const normalized = typeof value === 'string' ? value : '';
  return allowed.has(normalized) ? normalized : fallback;
}

function finiteNumber(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const bounded = Math.max(min, Math.min(max, value));
  return integer ? Math.round(bounded) : Math.round(bounded * 1000) / 1000;
}

function safeAppVersion(value) {
  if (typeof value !== 'string') return undefined;
  // Canonicalize instead of storing the supplied string verbatim. Even a value placed in this
  // field by a buggy client therefore cannot smuggle a token or an error message into storage.
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[.-](\d{1,6}))?$/u.exec(value);
  if (!match) return undefined;
  return match.slice(1).filter((part) => part !== undefined).map((part) => String(Number(part))).join('.');
}

/**
 * The report has no free-form text fields by design. Unknown keys are discarded rather than
 * copied, so a future client mistake cannot persist credentials, URLs, chat, SDP/ICE or hardware
 * identifiers. User identity is always added separately from the authenticated server session.
 */
function sanitizeVoiceDiagnosticReport(raw, { maxPayloadBytes = VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES } = {}) {
  if (!isPlainRecord(raw) || raw.schemaVersion !== VOICE_DIAGNOSTIC_SCHEMA_VERSION) {
    throw new VoiceDiagnosticValidationError('bad_schema');
  }
  const incident = enumValue(raw.incident, INCIDENTS);
  if (!incident) throw new VoiceDiagnosticValidationError('bad_incident');
  if (!isPlainRecord(raw.client)) throw new VoiceDiagnosticValidationError('bad_client');
  const kind = enumValue(raw.client.kind, CLIENT_KINDS);
  if (!kind) throw new VoiceDiagnosticValidationError('bad_client');

  const client = {
    kind,
    platform: enumValue(raw.client.platform, PLATFORMS, 'unknown'),
    installMode: enumValue(raw.client.installMode, INSTALL_MODES, 'unknown'),
    networkType: enumValue(raw.client.networkType, NETWORK_TYPES, 'unknown'),
  };
  let clientReportId;
  if (raw.clientReportId !== undefined) {
    if (typeof raw.clientReportId !== 'string' || !/^[a-f0-9]{24}$/u.test(raw.clientReportId)) {
      throw new VoiceDiagnosticValidationError('bad_report_id');
    }
    clientReportId = raw.clientReportId;
  }
  const appVersion = safeAppVersion(raw.client.appVersion);
  if (appVersion) client.appVersion = appVersion;

  const events = [];
  const sourceEvents = Array.isArray(raw.events) ? raw.events.slice(-128) : [];
  for (const source of sourceEvents) {
    if (!isPlainRecord(source)) continue;
    const eventKind = enumValue(source.kind, EVENT_KINDS);
    const atMs = finiteNumber(source.atMs, 0, VOICE_DIAGNOSTIC_MAX_SESSION_MS, true);
    if (!eventKind || atMs === undefined) continue;
    const event = { atMs, kind: eventKind };
    const stage = enumValue(source.stage, STAGES);
    const outcome = enumValue(source.outcome, OUTCOMES);
    const code = enumValue(source.code, ERROR_CODES);
    const connectionState = enumValue(source.connectionState, CONNECTION_STATES);
    const iceState = enumValue(source.iceState, ICE_STATES);
    const trackState = enumValue(source.trackState, TRACK_STATES);
    const audioContextState = enumValue(source.audioContextState, AUDIO_CONTEXT_STATES);
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
    if (outputRoute) event.outputRoute = outputRoute;
    if (outputTarget) event.outputTarget = outputTarget;
    if (outputOperation) event.outputOperation = outputOperation;
    if (micMode) event.micMode = micMode;
    if (micCapturePath) event.micCapturePath = micCapturePath;
    if (streamTransport) event.streamTransport = streamTransport;
    if (watchEndReason) event.watchEndReason = watchEndReason;
    if (networkType) event.networkType = networkType;
    if (Number.isInteger(source.httpStatus) && source.httpStatus >= 0 && source.httpStatus <= 599) {
      event.httpStatus = source.httpStatus;
    }
    for (const field of BOOLEAN_FIELDS) if (typeof source[field] === 'boolean') event[field] = source[field];
    for (const [field, [min, max]] of Object.entries(NUMBER_FIELDS)) {
      const value = finiteNumber(source[field], min, max, field !== 'audioLevel');
      if (value !== undefined) event[field] = value;
    }
    events.push(event);
  }
  if (!events.length) throw new VoiceDiagnosticValidationError('no_events');

  const durationMs = finiteNumber(raw.durationMs, 0, VOICE_DIAGNOSTIC_MAX_SESSION_MS, true);
  const report = {
    schemaVersion: VOICE_DIAGNOSTIC_SCHEMA_VERSION,
    ...(clientReportId ? { clientReportId } : {}),
    incident,
    client,
    durationMs: durationMs === undefined ? events[events.length - 1].atMs : durationMs,
    events,
  };
  let truncated = Boolean(raw.truncated) || sourceEvents.length < (Array.isArray(raw.events) ? raw.events.length : 0);
  if (truncated) report.truncated = true;
  let encoded = JSON.stringify(report);
  while (Buffer.byteLength(encoded, 'utf8') > maxPayloadBytes && report.events.length > 1) {
    report.events.shift();
    truncated = true;
    report.truncated = true;
    encoded = JSON.stringify(report);
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxPayloadBytes) {
    throw new VoiceDiagnosticValidationError('payload_too_large');
  }
  return report;
}

function installVoiceDiagnosticsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_diagnostics(
      id TEXT PRIMARY KEY,
      client_report_id TEXT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      incident TEXT NOT NULL,
      client_kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      created INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_diag_created ON voice_diagnostics(created DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_diag_created_id ON voice_diagnostics(created DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_diag_user_created ON voice_diagnostics(user_id, created DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_diag_incident_created ON voice_diagnostics(incident, created DESC);
  `);
  const columns = db.prepare('PRAGMA table_info(voice_diagnostics)').all();
  if (!columns.some((column) => column.name === 'client_report_id')) {
    db.exec('ALTER TABLE voice_diagnostics ADD COLUMN client_report_id TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_diag_user_client_report
      ON voice_diagnostics(user_id, client_report_id);
  `);
}

/**
 * Process-wide admission cap for diagnostic writes. It deliberately stores no IP, account or
 * request identifier: only the current window timestamp and aggregate count exist in memory.
 */
function createVoiceDiagnosticGlobalLimiter({
  limit = 120,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 120;
  const boundedWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000;
  let windowStarted = null;
  let count = 0;

  function consume() {
    const at = now();
    if (windowStarted === null || at - windowStarted >= boundedWindowMs || at < windowStarted) {
      windowStarted = at;
      count = 0;
    }
    if (count >= boundedLimit) {
      return { allowed: false, retryAfterMs: Math.max(1, boundedWindowMs - (at - windowStarted)) };
    }
    count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  return { consume };
}

function isVoiceDiagnosticsAdmin(user, bootstrapUsername = 'denis') {
  return Boolean(user && user.username === bootstrapUsername);
}

/** Bounded per-account burst/hour windows; an overloaded table rejects new owners until expiry. */
function createVoiceDiagnosticUserLimiter({
  burstLimit = 4, hourlyLimit = 20, maxUsers = 10_000, now = () => Date.now(),
} = {}) {
  const users = new Map();
  function consume(userId) {
    const key = String(userId);
    const at = now();
    let state = users.get(key);
    if (!state) {
      if (users.size >= maxUsers) {
        for (const [owner, value] of users) {
          if (at - value.hourlyStarted >= 60 * 60_000 || at < value.hourlyStarted) users.delete(owner);
        }
      }
      if (users.size >= maxUsers) return { allowed: false, retryAfterMs: 60_000 };
      state = { burstStarted: at, burstCount: 0, hourlyStarted: at, hourlyCount: 0 };
      users.set(key, state);
    }
    if (at - state.burstStarted >= 60_000 || at < state.burstStarted) {
      state.burstStarted = at;
      state.burstCount = 0;
    }
    if (at - state.hourlyStarted >= 60 * 60_000 || at < state.hourlyStarted) {
      state.hourlyStarted = at;
      state.hourlyCount = 0;
    }
    let retryAfterMs = 0;
    if (state.burstCount >= burstLimit) retryAfterMs = Math.max(retryAfterMs, 60_000 - (at - state.burstStarted));
    if (state.hourlyCount >= hourlyLimit) retryAfterMs = Math.max(retryAfterMs, 60 * 60_000 - (at - state.hourlyStarted));
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
    state.burstCount += 1;
    state.hourlyCount += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { consume };
}

function isVoiceDiagnosticControlIncident(incident) {
  return CONTROL_INCIDENTS.has(incident);
}

function createVoiceDiagnosticsStore(db, {
  now = () => Date.now(),
  randomId = () => crypto.randomBytes(12).toString('hex'),
  retentionMs = VOICE_DIAGNOSTIC_RETENTION_MS,
  maxRows = 500,
  maxRowsPerUser = 30,
} = {}) {
  installVoiceDiagnosticsSchema(db);
  const deleteExpired = db.prepare('DELETE FROM voice_diagnostics WHERE created < ?');
  const deleteUserOverflow = db.prepare(`DELETE FROM voice_diagnostics WHERE id IN (
    SELECT id FROM voice_diagnostics WHERE user_id=?
      ORDER BY CASE WHEN incident IN ('join_succeeded','session_ended','stream_watch_succeeded','auth_recovered') THEN 0 ELSE 1 END DESC,
        created DESC, id DESC LIMIT -1 OFFSET ?
  )`);
  const deleteGlobalOverflow = db.prepare(`DELETE FROM voice_diagnostics WHERE id IN (
    SELECT id FROM voice_diagnostics
      ORDER BY CASE WHEN incident IN ('join_succeeded','session_ended','stream_watch_succeeded','auth_recovered') THEN 0 ELSE 1 END DESC,
        created DESC, id DESC LIMIT -1 OFFSET ?
  )`);
  const insert = db.prepare(`INSERT INTO voice_diagnostics(
    id,client_report_id,user_id,username,incident,client_kind,platform,created,event_count,duration_ms,truncated,payload
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const findByClientReportId = db.prepare(`SELECT id,created,incident,client_kind,platform,event_count
    FROM voice_diagnostics WHERE user_id=? AND client_report_id=? AND created>=?`);

  const savedMetadata = (row) => ({
    id: row.id,
    createdAt: row.created,
    incident: row.incident,
    client: row.client_kind,
    platform: row.platform,
    eventCount: row.event_count,
  });

  const prune = db.transaction((at = now()) => {
    deleteExpired.run(at - retentionMs);
    if (maxRowsPerUser >= 0) {
      const owners = db.prepare('SELECT DISTINCT user_id FROM voice_diagnostics').all();
      for (const owner of owners) deleteUserOverflow.run(owner.user_id, maxRowsPerUser);
    }
    if (maxRows >= 0) deleteGlobalOverflow.run(maxRows);
  });

  function findExisting(userId, clientReportId) {
    if (typeof clientReportId !== 'string' || !/^[a-f0-9]{24}$/u.test(clientReportId)) return null;
    const createdAt = now();
    // This runs before admission limiting so a lost HTTP response can be acknowledged without
    // spending another slot. Keep it as one indexed lookup: maintenance remains owned by startup,
    // the bounded timer, save and admin reads rather than every retry probe.
    const existing = findByClientReportId.get(String(userId), clientReportId, createdAt - retentionMs);
    return existing ? savedMetadata(existing) : null;
  }

  const save = db.transaction(({ userId, username, raw }) => {
    const report = sanitizeVoiceDiagnosticReport(raw);
    const normalizedUserId = String(userId);
    const createdAt = now();
    // Expire first: a very late retry must not receive a successful response pointing at a row
    // that the bounded read window already hides (and the next maintenance pass would delete).
    prune(createdAt);
    if (report.clientReportId) {
      const existing = findByClientReportId.get(normalizedUserId, report.clientReportId, createdAt - retentionMs);
      if (existing) return savedMetadata(existing);
    }
    const id = randomId();
    const payload = JSON.stringify(report);
    try {
      insert.run(
        id, report.clientReportId || null, normalizedUserId, String(username), report.incident,
        report.client.kind, report.client.platform, createdAt, report.events.length,
        report.durationMs, report.truncated ? 1 : 0, payload,
      );
    } catch (error) {
      const existing = report.clientReportId
        ? findByClientReportId.get(normalizedUserId, report.clientReportId, createdAt - retentionMs)
        : null;
      if (existing) return savedMetadata(existing);
      throw error;
    }
    prune(createdAt);
    return savedMetadata({
      id, created: createdAt, incident: report.incident, client_kind: report.client.kind,
      platform: report.client.platform, event_count: report.events.length,
    });
  });

  function list({ limit = 50, beforeCreated, beforeId, incident, client } = {}) {
    const at = now();
    prune(at);
    // A malformed filter must never broaden a supposedly filtered admin query to every report.
    if (incident !== undefined && !INCIDENTS.has(incident)) return { items: [], nextCursor: null };
    if (client !== undefined && !CLIENT_KINDS.has(client)) return { items: [], nextCursor: null };
    const hasBeforeCreated = beforeCreated !== undefined;
    const hasBeforeId = beforeId !== undefined;
    const validCursor = Number.isSafeInteger(beforeCreated) && beforeCreated > 0
      && typeof beforeId === 'string' && /^[a-f0-9]{24}$/u.test(beforeId);
    if (hasBeforeCreated !== hasBeforeId || ((hasBeforeCreated || hasBeforeId) && !validCursor)) {
      return { items: [], nextCursor: null };
    }
    const boundedLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50));
    const clauses = ['created >= ?'];
    const params = [at - retentionMs];
    if (validCursor) {
      clauses.push('(created < ? OR (created = ? AND id < ?))');
      params.push(beforeCreated, beforeCreated, beforeId);
    }
    if (incident !== undefined) { clauses.push('incident = ?'); params.push(incident); }
    if (client !== undefined) { clauses.push('client_kind = ?'); params.push(client); }
    const rows = db.prepare(`SELECT id,user_id,username,incident,client_kind,platform,created,event_count,duration_ms,truncated
      FROM voice_diagnostics WHERE ${clauses.join(' AND ')} ORDER BY created DESC,id DESC LIMIT ?`)
      .all(...params, boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit).map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      incident: row.incident,
      client: row.client_kind,
      platform: row.platform,
      createdAt: row.created,
      eventCount: row.event_count,
      durationMs: row.duration_ms,
      truncated: Boolean(row.truncated),
    }));
    const tail = hasMore ? items[items.length - 1] : null;
    return {
      items,
      nextCursor: tail ? { createdAt: tail.createdAt, id: tail.id } : null,
    };
  }

  function detail(id) {
    const at = now();
    prune(at);
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/u.test(id)) return null;
    const row = db.prepare(`SELECT id,user_id,username,created,payload
      FROM voice_diagnostics WHERE id=? AND created>=?`).get(id, at - retentionMs);
    if (!row) return null;
    let report;
    try { report = JSON.parse(row.payload); } catch { return null; }
    return { id: row.id, userId: row.user_id, username: row.username, createdAt: row.created, report };
  }

  function purgeUser(userId) {
    return db.prepare('DELETE FROM voice_diagnostics WHERE user_id=?').run(String(userId)).changes;
  }

  return { save, findExisting, list, detail, prune, purgeUser };
}

module.exports = {
  INCIDENTS,
  CLIENT_KINDS,
  VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES,
  VOICE_DIAGNOSTIC_RETENTION_MS,
  VoiceDiagnosticValidationError,
  createVoiceDiagnosticGlobalLimiter,
  createVoiceDiagnosticUserLimiter,
  createVoiceDiagnosticsStore,
  installVoiceDiagnosticsSchema,
  isVoiceDiagnosticControlIncident,
  isVoiceDiagnosticsAdmin,
  sanitizeVoiceDiagnosticReport,
};

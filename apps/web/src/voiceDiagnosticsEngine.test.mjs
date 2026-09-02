import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = readFileSync(join(here, 'engine.ts'), 'utf8');

assert.match(engine, /VoiceDiagnosticsRecorder[\s\S]*VoiceEventLoopStallMonitor[\s\S]*detectVoiceDiagnosticNetworkType/,
  'Engine uses the bounded client recorder and foreground-only stall monitor');
assert.match(engine, /VOICE_DIAGNOSTIC_MAX_REPORTS_PER_SESSION = 4/,
  'one voice session has a hard report-attempt budget');
assert.match(engine, /VOICE_DIAGNOSTIC_REPORT_COOLDOWN_MS = 15_000[\s\S]*VOICE_DIAGNOSTIC_MAX_REPORTS_PER_SESSION = 4/,
  'diagnostic admission remains cooled down and bounded');
assert.match(engine, /if \(!this\.voiceDiagnosticAccountActive \|\| this\.voiceDiagnosticReportInFlight\) return false/,
  'physical uploads remain single-flight for the account');
const voiceUploadGate = engine.match(/private beginVoiceDiagnosticUpload\([\s\S]*?\n  }\n\n  private drainQueuedVoiceDiagnostic/)?.[0] || '';
assert.equal((voiceUploadGate.match(/api\.submitVoiceDiagnostic\(/g) || []).length, 1,
  'all voice incidents pass through one privacy-safe upload gate');
assert.match(engine, /new DiagnosticReportOutbox\([\s\S]*?api\.submitVoiceDiagnostic\(report\)/,
  'stream watch reports use the same fixed-schema authenticated endpoint');
assert.match(engine, /async connect\([\s\S]*streamDiagnosticOutbox\.start\(\)[\s\S]*ensureOutputLifecycleListeners/,
  'a reused Engine restarts durable diagnostic delivery after a full server disconnect');
assert.match(engine, /beginStreamWatchDiagnostic[\s\S]*stream_watch_started[\s\S]*recordStreamWatchTransportDiagnostic/,
  'one structured timeline starts at the exact viewer click and receives transport progress');
assert.match(engine, /finishStreamWatchDiagnostic[\s\S]*streamDiagnosticOutbox\.enqueue/,
  'a terminal stream result is persisted before its upload starts');
assert.match(engine, /const attempt = this\.streamWatchDiagnostics\.get\(event\.streamId\);[\s\S]*attempt\.recorder\.record\(\{[\s\S]*kind:/,
  'the broadcaster identity is consumed only as a local routing key');
assert.match(engine, /confirmWatchPlayback[\s\S]*stream_watch_recovered[\s\S]*stream_watch_succeeded/,
  'the first playable frame always emits a success or recovered control report');
assert.match(engine, /decode_timeout[\s\S]*clearWatch\(identity, true\)/,
  'the exact 20 second watch owner records its terminal timeout before cleanup');
assert.match(engine, /closeWatch\(identity: string\)[\s\S]*pendingWatch\.has\(identity\)[\s\S]*stream_watch_failed[\s\S]*outcome: 'cancelled'[\s\S]*code: 'aborted'[\s\S]*clearWatch\(identity, true\)/,
  'closing a still-pending tile preserves the failed attempt before exact transport cleanup');
assert.match(engine, /clearAllWatches\([\s\S]*const failure = unexpectedFailure \?\?[\s\S]*outcome: 'cancelled'[\s\S]*code: 'aborted'[\s\S]*finishStreamWatchDiagnostic\(identity, 'stream_watch_failed', failure\)/,
  'server exit and ordinary engine teardown preserve every pending watch timeline');
assert.match(engine, /if \(wasViewing\)[\s\S]*clearAllWatches\(\{[\s\S]*watch_signaling[\s\S]*signaling_closed/,
  'an unexpected room loss persists pending watch attempts before transport teardown');

for (const event of [
  'join_started', 'intent_finished', 'hub_connected', 'lease_claimed',
  'media_token_received', 'media_connected', 'media_activated', 'join_completed', 'join_failed',
  'mic_capture_finished', 'mic_published', 'mic_recovery_started', 'mic_recovery_finished',
  'mute_changed', 'deafen_changed', 'background', 'foreground', 'network_changed',
  'reconnecting', 'reconnected', 'disconnected', 'playback_blocked', 'output_route_failed',
  'ui_stall', 'rtc_sample', 'uplink_stalled', 'inbound_stalled', 'left',
]) {
  assert.match(engine, new RegExp(`kind: '${event}'`), `Engine records ${event}`);
}

assert.match(engine, /queueVoiceJoin[\s\S]*beginVoiceDiagnostics\('hub'\)[\s\S]*recordVoiceJoinFailure\('hub', undefined, 'timed_out'\)/,
  'a channel tap queued behind realtime readiness still produces a bounded stuck-join report');
assert.match(engine, /startConnPoll[\s\S]*addEventListener\('online', this\.onVoiceNetworkChanged\)[\s\S]*voiceDiagnosticStallMonitor\.start\(\)/,
  'network and UI-stall observation starts only with an active voice connection');
assert.match(engine, /stopConnPoll[\s\S]*removeEventListener\('online', this\.onVoiceNetworkChanged\)[\s\S]*voiceDiagnosticStallMonitor\.stop\(\)/,
  'voice lifecycle cleanup removes diagnostic listeners and the only stall timer');
assert.match(engine, /startConnPoll[\s\S]*if \(document\.hidden\) this\.markVoiceHidden\(\);[\s\S]*else this\.voiceDiagnosticStallMonitor\.start\(\)/,
  'a voice session never starts stall timing while already backgrounded');
assert.match(engine, /markVoiceHidden\(\)[\s\S]*voiceDiagnosticStallMonitor\.stop\(\)[\s\S]*resetVoiceDiagnosticTransportWindow\(\)/,
  'backgrounding stops UI-stall timing and invalidates RTC comparison baselines');
assert.match(engine, /onVisible = \([\s\S]*voiceDiagnosticStallMonitor\.start\(\)[\s\S]*retryPendingVoiceDiagnostic\(\)/,
  'foreground starts a fresh stall window and offers one pending upload retry');
assert.match(engine, /ensureRemoteAudioPlayback[\s\S]*recordVoicePlaybackBlocked\(\)/,
  'a persistent failed playback repair is captured');
assert.match(engine, /pollPing[\s\S]*getRTCStatsReport\(\)[\s\S]*recordVoiceRtcSample\(rep, v == null \? null : v \* 1_000, track\)/,
  'diagnostics reuse the already-owned RTC report');
assert.equal((engine.match(/\.getRTCStatsReport\(\)/g) || []).length, 1,
  'diagnostics never allocate an additional native getStats operation');
assert.match(engine, /voiceDiagnosticStatsTrack[\s\S]*remoteParticipants\.values\(\)[\s\S]*Track\.Source\.Microphone[\s\S]*participant\.isSpeaking \|\| this\.speakingSet\.has\(username\)[\s\S]*return remote[\s\S]*if \(local[\s\S]*return local[\s\S]*return fallback/,
  'diagnostics sample the exact audible receiver before publisher RTT, with a listen-only fallback');
assert.match(engine, /observeVoiceDiagnosticMuteState\(\)[\s\S]*VOICE_DIAGNOSTIC_MUTE_DIVERGENCE_MS[\s\S]*submitVoiceDiagnostic\('mute_divergence'\)/,
  'transient SDK mute changes must persist before they become an incident');
assert.match(engine, /recordVoiceRtcSample[\s\S]*hasOutboundAudio[\s\S]*hasInboundAudio[\s\S]*previousTotals\.track !== track[\s\S]*voiceDiagnosticUplinkSilence = emptyVoiceDiagnosticSilenceState\(\)[\s\S]*voiceDiagnosticInboundSilence = emptyVoiceDiagnosticSilenceState\(\)[\s\S]*previousTotals\?\.track === track[\s\S]*observeVoiceDiagnosticSilence/,
  'the already-owned RTC report drives bounded directional silence observation');
assert.doesNotMatch(engine, /inboundTransportComparable|transportInboundBytes/,
  'publisher candidate traffic can never masquerade as received remote speech');
assert.match(engine, /voiceDiagnosticExpectsUplink[\s\S]*manualMute[\s\S]*deafened[\s\S]*pttDown/,
  'manual mute, deafen and a closed PTT gate cannot create an uplink incident');
assert.match(engine, /voiceDiagnosticExpectsInbound[\s\S]*participant\.isSpeaking[\s\S]*speakingSet/,
  'inbound silence requires positive remote-speaking evidence, not a merely unmuted peer');
assert.match(engine, /submitVoiceDiagnostic\(direction === 'uplink' \? 'uplink_silent' : 'inbound_silent'\)/,
  'a confirmed directional stall uses the matching incident enum');
assert.match(engine, /voiceDiagnosticPendingReport[\s\S]*pending\.userId !== this\.me\.id/,
  'one sanitized retry is fenced to the same authenticated user');
assert.match(engine, /beginVoiceDiagnosticUpload\(report, false\)/,
  'the bounded retry cannot recursively requeue itself');
assert.match(engine, /voiceDiagnosticQueuedReport[\s\S]*VOICE_DIAGNOSTIC_INCIDENT_PRIORITY[\s\S]*queued\.priority > priority/,
  'one bounded queued snapshot retains the most important incident while another upload is in flight');
assert.match(engine, /VOICE_DIAGNOSTIC_MAX_REPORTS_PER_SESSION - 1[\s\S]*voiceDiagnosticQueuedReport = \{ report, userId: this\.me\.id, priority, reservedAt: now \}/,
  'ordinary samples reserve one report slot for the exact terminal call outcome');
assert.match(engine, /finishVoiceDiagnostics[\s\S]*kind: 'left'[\s\S]*submitVoiceDiagnostic\(incident, true\)[\s\S]*resetVoiceDiagnostics\(\)/,
  'the immutable terminal snapshot is admitted before the recorder is reset');
assert.match(engine, /drainQueuedVoiceDiagnostic[\s\S]*document\.hidden[\s\S]*beginVoiceDiagnosticUpload\(queued\.report, true\)/,
  'a hidden queued snapshot waits for foreground and keeps its own idempotency key');
assert.match(engine, /retainPendingVoiceDiagnostic[\s\S]*VOICE_DIAGNOSTIC_INCIDENT_PRIORITY\[existing\.report\.incident\][\s\S]*VOICE_DIAGNOSTIC_INCIDENT_PRIORITY\[report\.incident\]/,
  'a failed terminal upload can replace a less important retained retry');
assert.match(engine, /onVoiceNetworkChanged[\s\S]*retryPendingVoiceDiagnostic\(\)/,
  'an online edge retries one pending diagnostic after its cooldown');
assert.doesNotMatch(engine, /beginVoiceDiagnostics[\s\S]{0,500}clearVoiceDiagnosticPendingReport\(\)/,
  'a quick rejoin cannot erase the previous call report waiting for connectivity');
assert.match(engine, /finishVoiceDiagnostics[\s\S]*resetVoiceDiagnostics\(\)/,
  'a failed upload survives the exact voice exit that produced it');
assert.match(engine, /voiceDiagnosticRetryHandler = \(\) => this\.retryPendingVoiceDiagnostic\(\)[\s\S]*addEventListener\('online', this\.voiceDiagnosticRetryHandler\)[\s\S]*addEventListener\('visibilitychange', this\.voiceDiagnosticRetryHandler\)[\s\S]*addEventListener\('pageshow', this\.voiceDiagnosticRetryHandler\)/,
  'the account-scoped Engine retries an offline or hidden report after any foreground edge');
assert.match(engine, /disconnect\(discardVoiceDiagnostics = false\)[\s\S]*if \(discardVoiceDiagnostics\)[\s\S]*voiceDiagnosticAccountActive = false[\s\S]*clearVoiceDiagnosticPendingReport\(\)[\s\S]*if \(discardVoiceDiagnostics && this\.voiceDiagnosticRetryHandler\)[\s\S]*removeEventListener\('online', this\.voiceDiagnosticRetryHandler\)[\s\S]*removeEventListener\('visibilitychange', this\.voiceDiagnosticRetryHandler\)[\s\S]*removeEventListener\('pageshow', this\.voiceDiagnosticRetryHandler\)/,
  'only explicit logout invalidates the retained report while transport-only teardown preserves it');
assert.match(engine, /if \(discardVoiceDiagnostics\)[\s\S]*clearVoiceDiagnosticPendingReport\(\)[\s\S]*clearVoiceDiagnosticQueuedReport\(\)/,
  'explicit logout discards every report snapshot owned by the old account');
assert.match(engine, /voiceDiagnosticRetryDelayMs[\s\S]*NETWORK_ERROR[\s\S]*REQUEST_TIMEOUT[\s\S]*status === 429[\s\S]*status >= 500/,
  'only transient upload failures are retried and Retry-After is bounded');

const classifier = engine.slice(
  engine.indexOf('function classifyVoiceDiagnosticError'),
  engine.indexOf('function voiceMediaIdentityParts'),
);
assert.match(classifier, /NotAllowedError[\s\S]*NotFoundError[\s\S]*NotSupportedError[\s\S]*AbortError/,
  'raw browser errors are reduced to fixed categories');
assert.doesNotMatch(classifier, /\.message|\.stack|JSON\.stringify/,
  'classification never serializes an error payload');

console.log('voice diagnostics engine: ok');

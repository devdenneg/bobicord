import type { VoiceDiagnosticEventInput } from './voiceDiagnostics';

const MAX_STATS = 64;
const COUNTERS = ['packetsSent', 'bytesSent', 'packetsReceived', 'bytesReceived', 'packetsLost'] as const;
type Counter = typeof COUNTERS[number];
interface StatBaseline {
  /** Local-only identity. Never copied to an event or a stored diagnostic report. */
  key: string;
  timestamp: number;
  counters: Partial<Record<Counter, number>>;
}
export interface VoiceDiagnosticStatsState { samples: StatBaseline[] }
interface StatsReportLike {
  values?: () => IterableIterator<unknown>;
  forEach: (callback: (value: any) => void) => void;
}

function number(value: unknown, signed = false): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && (signed || value >= 0) ? value : undefined;
}

/** Read only the already-collected microphone report; no timers, getStats, IO or raw report retention. */
export function summarizeVoiceDiagnosticStats(
  report: StatsReportLike,
  previous: VoiceDiagnosticStatsState | null = null,
): { state: VoiceDiagnosticStatsState; event: VoiceDiagnosticEventInput } {
  const entries: Record<string, unknown>[] = [];
  const collect = (value: unknown) => {
    if (entries.length < MAX_STATS && value && typeof value === 'object') entries.push(value as Record<string, unknown>);
  };
  if (typeof report.values === 'function') {
    for (const value of report.values()) { collect(value); if (entries.length >= MAX_STATS) break; }
  } else report.forEach(collect); // small test/legacy hosts may expose only forEach

  const old = new Map((previous?.samples ?? []).slice(0, MAX_STATS).map((sample) => [sample.key, sample]));
  const state: VoiceDiagnosticStatsState = { samples: [] };
  const event: VoiceDiagnosticEventInput = { kind: 'rtc_sample', stage: 'rtc' };
  const totals: Partial<Record<Counter, number>> = {};
  let remoteRtt: number | undefined;
  let candidateRtt: number | undefined;
  let jitter: number | undefined;
  const selected = new Set(entries.filter((entry) => entry.type === 'transport')
    .map((entry) => entry.selectedCandidatePairId).filter((id): id is string => typeof id === 'string'));

  for (const entry of entries) {
    if (entry.type === 'candidate-pair' && (selected.size ? selected.has(String(entry.id))
      : entry.nominated === true && entry.state === 'succeeded')) {
      const rtt = number(entry.currentRoundTripTime);
      if (rtt !== undefined) candidateRtt = Math.max(candidateRtt ?? 0, rtt);
    }
    const type = entry.type;
    if (type !== 'outbound-rtp' && type !== 'remote-inbound-rtp' && type !== 'inbound-rtp') continue;
    if ((entry.kind ?? entry.mediaType) !== 'audio') continue;
    if (type === 'remote-inbound-rtp') {
      const rtt = number(entry.roundTripTime);
      if (rtt !== undefined) remoteRtt = Math.max(remoteRtt ?? 0, rtt);
      const value = number(entry.jitter);
      if (value !== undefined) jitter = Math.max(jitter ?? 0, value);
    }
    // IDs and SSRC distinguish counter generations. Device/track replacement also resets state at
    // the caller. Counter/time regressions must not look like huge traffic or packet-loss spikes.
    if (typeof entry.id !== 'string' || entry.id.length > 256) continue;
    const ssrc = number(entry.ssrc);
    const timestamp = number(entry.timestamp);
    if (timestamp === undefined) continue;
    const key = JSON.stringify([type, entry.id, ssrc ?? null]);
    const counters: StatBaseline['counters'] = {};
    const fields: readonly Counter[] = type === 'outbound-rtp' ? ['packetsSent', 'bytesSent']
      : type === 'remote-inbound-rtp' ? ['packetsLost'] : ['packetsReceived', 'bytesReceived'];
    for (const field of fields) {
      const value = number(entry[field], field === 'packetsLost');
      if (value !== undefined) counters[field] = value;
    }
    const prior = old.get(key);
    if (prior && timestamp <= prior.timestamp) { state.samples.push(prior); continue; }
    state.samples.push({ key, timestamp, counters });
    if (!prior) continue;
    const reset = fields.some((field) => field !== 'packetsLost' && counters[field] !== undefined
      && prior.counters[field] !== undefined && counters[field]! < prior.counters[field]!);
    if (reset) continue;
    for (const field of fields) {
      const value = counters[field], before = prior.counters[field];
      if (value === undefined || before === undefined) continue;
      // Negative loss corrections are normal when late packets arrive; keep the new baseline.
      totals[field] = (totals[field] ?? 0) + Math.max(0, value - before);
    }
  }
  const milliseconds = (seconds: number) => Math.min(120_000, Math.round(seconds * 1000));
  const rtt = remoteRtt ?? candidateRtt;
  if (rtt !== undefined) event.rttMs = milliseconds(rtt);
  if (jitter !== undefined) event.jitterMs = milliseconds(jitter);
  if (totals.packetsSent !== undefined) event.packetsSentDelta = Math.min(100_000_000, totals.packetsSent);
  if (totals.bytesSent !== undefined) event.bytesSentDelta = Math.min(2_000_000_000, totals.bytesSent);
  if (totals.packetsReceived !== undefined) event.packetsReceivedDelta = Math.min(100_000_000, totals.packetsReceived);
  if (totals.bytesReceived !== undefined) event.bytesReceivedDelta = Math.min(2_000_000_000, totals.bytesReceived);
  if (totals.packetsLost !== undefined) event.packetsLostDelta = Math.min(10_000_000, totals.packetsLost);
  return { state, event };
}

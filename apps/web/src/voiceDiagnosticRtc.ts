export const VOICE_DIAGNOSTIC_SILENT_INTERVALS = 4;
export const VOICE_DIAGNOSTIC_SILENT_MIN_MS = 8_000;

export interface VoiceDiagnosticSilenceState {
  samples: number;
  since: number | null;
  stalled: boolean;
}

export interface VoiceDiagnosticInboundExpectation {
  transportObservable: boolean;
  deafened: boolean;
  canPlaybackAudio: boolean;
  outputAudible: boolean;
  speakingRemote: boolean;
}

export const emptyVoiceDiagnosticSilenceState = (): VoiceDiagnosticSilenceState => ({
  samples: 0, since: null, stalled: false,
});

/**
 * Silence is actionable only when there is positive evidence that remote speech should be heard.
 * An unmuted publication alone is not evidence: a healthy quiet channel may legitimately emit no
 * audio packets for long stretches when Opus DTX is active.
 */
export function voiceDiagnosticInboundExpected(input: VoiceDiagnosticInboundExpectation): boolean {
  return input.transportObservable && !input.deafened && input.canPlaybackAudio
    && input.outputAudible && input.speakingRemote;
}

/** A pure, bounded consecutive-sample state machine shared by both RTC directions. */
export function advanceVoiceDiagnosticSilence(
  state: VoiceDiagnosticSilenceState,
  expected: boolean,
  comparable: boolean,
  progressed: boolean,
  intervalStartedAt: number,
  now: number,
): { state: VoiceDiagnosticSilenceState; started: boolean; recovered: boolean } {
  if (!expected || !comparable)
    return { state: emptyVoiceDiagnosticSilenceState(), started: false, recovered: false };
  if (progressed)
    return { state: emptyVoiceDiagnosticSilenceState(), started: false, recovered: state.stalled };
  const samples = state.samples + 1;
  const since = state.since ?? Math.max(0, Math.min(intervalStartedAt, now));
  const stalled = state.stalled || (samples >= VOICE_DIAGNOSTIC_SILENT_INTERVALS
    && now - since >= VOICE_DIAGNOSTIC_SILENT_MIN_MS);
  return {
    state: { samples, since, stalled },
    started: stalled && !state.stalled,
    recovered: false,
  };
}

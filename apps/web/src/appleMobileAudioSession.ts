import { currentAppleMobilePlatform } from './audioDevices';

// Pin the recording category while a voice/preview owner is alive. This avoids
// depending on WebKit's automatic category transitions between capture and WebAudio;
// it does not grant background execution or prevent OS microphone interruptions.
// https://www.w3.org/TR/audio-session/#audio-session-types
type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
type AudioSessionLike = { type: AudioSessionType };
type LeaseState = { users: number; previous: AudioSessionType };

const RECORDING_TYPE = 'play-and-record';
const SESSION_TYPES = new Set<string>(['auto', 'playback', 'transient', 'transient-solo', 'ambient', RECORDING_TYPE]);
const leases = new WeakMap<AudioSessionLike, LeaseState>();
const noop = () => {};

/** Acquire synchronously before capture; release exactly when that logical owner ends. */
export function acquireAppleMobileAudioSession(): () => void {
  let session: AudioSessionLike;
  let state: LeaseState;
  try {
    if (!currentAppleMobilePlatform() || typeof navigator === 'undefined') return noop;
    const candidate = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
    if (!candidate || typeof candidate !== 'object') return noop;
    const previous = candidate.type;
    if (typeof previous !== 'string' || !SESSION_TYPES.has(previous)) return noop;
    session = candidate;
    const active = leases.get(session);
    if (active) {
      // Another owner may have changed the category. Do not fight that writer or
      // replace our original snapshot; last release checks the current value.
      state = active;
      state.users++;
    } else {
      if (previous !== RECORDING_TYPE) {
        try {
          session.type = RECORDING_TYPE;
          if (session.type !== RECORDING_TYPE) return noop; // unsupported/ignored setter
        } catch {
          // A setter may apply before throwing, or the verification getter may fail.
          // Roll back only a value still identifiable as our own, never another writer's.
          try { if (session.type === RECORDING_TYPE) session.type = previous; } catch { /** optional API */ }
          return noop;
        }
      }
      state = { users: 1, previous };
      leases.set(session, state);
    }
  } catch {
    // This API is optional, including implementations with throwing accessors.
    // AudioSession failure must never turn a usable microphone into listen-only.
    return noop;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (leases.get(session) !== state || --state.users > 0) return;
    leases.delete(session);
    try {
      if (session.type === RECORDING_TYPE && state.previous !== RECORDING_TYPE) session.type = state.previous;
    } catch { /** optional category restoration must not break teardown */ }
  };
}

import { currentAppleMobilePlatform } from './audioDevices';

// RNNoise consumes 480-sample frames at 48 kHz and does not resample internally.
// Request that rate when creating the capture graph, while a user gesture is still active.
export const MICROPHONE_SAMPLE_RATE = 48_000;

export function createMicrophoneAudioContext(): AudioContext {
  // iOS capture is published directly; WebAudio only meters it. Match the current
  // hardware route instead of forcing RNNoise's rate on Safari's shared audio session.
  if (currentAppleMobilePlatform()) return new AudioContext();
  try {
    return new AudioContext({ sampleRate: MICROPHONE_SAMPLE_RATE });
  } catch (error) {
    // Some devices/browser versions cannot use a requested rate. Keep capture available;
    // createDenoiseNode checks the actual rate before enabling RNNoise on this fallback.
    if ((error as { name?: string })?.name !== 'NotSupportedError') throw error;
    return new AudioContext();
  }
}

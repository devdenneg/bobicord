const PATCH_MARK = Symbol.for('relay.livekit-audio-gain-stability.v1');

interface GainParamLike {
  value?: number;
  cancelScheduledValues?: (time: number) => void;
  setValueAtTime?: (value: number, time: number) => void;
}

interface RemoteAudioTrackLike {
  audioContext?: { state?: string; currentTime?: number };
  elementVolume?: number;
  gainNode?: { gain?: GainParamLike };
}

interface RemoteAudioTrackPrototype {
  [PATCH_MARK]?: boolean;
  setAudioContext: (this: RemoteAudioTrackLike, context: unknown) => unknown;
  connectWebAudio: (this: RemoteAudioTrackLike, context: { currentTime?: number }, element: unknown) => unknown;
}

/**
 * LiveKit 2.20 reconnects every RemoteAudioTrack to the same AudioContext on each startAudio().
 * That recreates its GainNode at 1 and ramps back later (and skips an exact 0 altogether). Avoid
 * the needless reconnect and make every genuinely new node exact before the JS task can yield.
 */
export function installLiveKitAudioGainStability(
  constructor: { prototype: RemoteAudioTrackPrototype },
): void {
  const prototype = constructor.prototype;
  if (prototype[PATCH_MARK]) return;
  const setAudioContext = prototype.setAudioContext;
  const connectWebAudio = prototype.connectWebAudio;
  if (typeof setAudioContext !== 'function' || typeof connectWebAudio !== 'function') return;

  prototype.setAudioContext = function stableAudioContext(context: unknown) {
    if (context && this.audioContext === context && this.audioContext?.state !== 'closed') return;
    return setAudioContext.call(this, context);
  };
  prototype.connectWebAudio = function stableWebAudioGain(context, element) {
    const result = connectWebAudio.call(this, context, element);
    const requested = Number(this.elementVolume);
    const value = Number.isFinite(requested) ? Math.max(0, requested) : 1;
    const gain = this.gainNode?.gain;
    const at = Number.isFinite(Number(context?.currentTime)) ? Number(context.currentTime) : 0;
    if (gain) {
      try { gain.cancelScheduledValues?.(at); } catch { /** unsupported AudioParam shim */ }
      try {
        if (gain.setValueAtTime) gain.setValueAtTime(value, at);
        else gain.value = value;
      } catch {
        try { gain.value = value; } catch { /** the SDK's own target remains as fallback */ }
      }
    }
    return result;
  };
  Object.defineProperty(prototype, PATCH_MARK, { value: true, configurable: false });
}

const PATCH_MARK = Symbol.for('relay.livekit-audio-gain-stability.v2');

interface GainParamLike {
  value?: number;
  cancelScheduledValues?: (time: number) => void;
  setValueAtTime?: (value: number, time: number) => void;
}

interface RemoteAudioTrackLike {
  audioContext?: { state?: string; currentTime?: number };
  elementVolume?: number;
  gainNode?: { gain?: GainParamLike };
  sourceNode?: unknown;
  attachedElements?: ArrayLike<unknown>;
}

interface MediaElementLike {
  volume: number;
}

interface RemoteAudioTrackPrototype {
  [PATCH_MARK]?: boolean;
  setAudioContext: (this: RemoteAudioTrackLike, context: unknown) => unknown;
  connectWebAudio: (this: RemoteAudioTrackLike, context: { currentTime?: number }, element: unknown) => unknown;
  setVolume: (this: RemoteAudioTrackLike, volume: number) => unknown;
  attach: (this: RemoteAudioTrackLike, element?: MediaElementLike) => MediaElementLike;
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
  const setVolume = prototype.setVolume;
  const attach = prototype.attach;
  if (typeof setAudioContext !== 'function' || typeof connectWebAudio !== 'function'
    || typeof setVolume !== 'function' || typeof attach !== 'function') return;

  prototype.setAudioContext = function stableAudioContext(context: unknown) {
    const hasAttachedElements = Number(this.attachedElements?.length || 0) > 0;
    const graphReady = !hasAttachedElements || (!!this.sourceNode && !!this.gainNode);
    // A same-context call is redundant only while every attached element still owns a complete
    // source -> gain graph. LiveKit can keep audioContext after a partial WebAudio construction
    // failure; skipping that retry would leave the participant permanently silent.
    if (context && this.audioContext === context && this.audioContext?.state !== 'closed' && graphReady) return;
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
  prototype.setVolume = function stableDirectVolume(volume) {
    const requested = Number.isFinite(volume) ? Math.max(0, volume) : 1;
    if (this.audioContext) return setVolume.call(this, requested);
    // HTMLMediaElement.volume is limited to 0..1. Keep the requested value for a future WebAudio
    // GainNode, but never let a >100% preference throw IndexSizeError in the direct fallback.
    const result = setVolume.call(this, Math.min(1, requested));
    this.elementVolume = requested;
    return result;
  };
  prototype.attach = function stableDirectAttach(element) {
    const attached = attach.call(this, element);
    // LiveKit checks `if (elementVolume)` and skips an exact zero. In no-mixer fallback that would
    // unmute a newly attached peer at full volume despite a saved per-user mute or deafen state.
    if (!this.audioContext && this.elementVolume !== undefined) {
      const requested = Number(this.elementVolume);
      const direct = Number.isFinite(requested) ? Math.max(0, Math.min(1, requested)) : 1;
      try { attached.volume = direct; } catch { /** detached/locked media element */ }
    }
    return attached;
  };
  Object.defineProperty(prototype, PATCH_MARK, { value: true, configurable: false });
}

import { useSyncExternalStore } from 'react';
import { getEngine } from './store';
import type { Snapshot } from './engine';

const EMPTY: Snapshot = {
  connected: false, roomReady: false, reconnecting: false, voiceQuality: 'unknown', voicePing: null, inVoice: false, deafened: false, localMicMuted: true, pttDown: false,
  presence: {}, speaking: {}, streams: [], watching: {}, pending: {}, watchers: {}, messages: [], chatHasMore: false, chatTrimmed: 0, typing: [],
};

export function useEngine(): Snapshot {
  return useSyncExternalStore(
    (cb) => { const e = getEngine(); return e ? e.subscribe(cb) : () => {}; },
    () => { const e = getEngine(); return e ? e.getSnapshot() : EMPTY; },
  );
}

export const AUDIO_CAPTURE_CHANGED_EVENT = 'relay-audio-capture-changed';
const ENUMERATE_TIMEOUT_MS = 6_000;

export interface AudioDeviceInventorySnapshot {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  status: 'idle' | 'loading' | 'ready' | 'error';
}

export function notifyAudioCaptureChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUDIO_CAPTURE_CHANGED_EVENT));
}

// Shared by Settings and the dock: enumerate never asks for permission or starts a microphone.
// Events during a request invalidate its result and coalesce into one follow-up, not parallel I/O.
export function createAudioDeviceInventory() {
  let snapshot: AudioDeviceInventorySnapshot = { inputs: [], outputs: [], status: 'idle' };
  const listeners = new Set<(snapshot: AudioDeviceInventorySnapshot) => void>();
  let revision = 0, pending = false, inFlight = false;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const emit = (next: AudioDeviceInventorySnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };
  const run = () => {
    if (!listeners.size || inFlight || !pending) return;
    pending = false;
    inFlight = true;
    const owner = revision;
    let timedOut = false;
    emit({ ...snapshot, status: 'loading' });
    deadline = setTimeout(() => {
      deadline = null;
      timedOut = true;
      if (listeners.size) emit({ ...snapshot, status: 'error' });
      // enumerateDevices cannot be aborted. Keep its single-flight ownership until it settles.
    }, ENUMERATE_TIMEOUT_MS);
    void Promise.resolve().then(() => navigator.mediaDevices?.enumerateDevices?.() ?? []).then((devices) => {
      if (!listeners.size || owner !== revision || timedOut) return;
      emit({
        inputs: devices.filter((device) => device.kind === 'audioinput'),
        outputs: devices.filter((device) => device.kind === 'audiooutput'), status: 'ready',
      });
    }).catch(() => {
      if (listeners.size && owner === revision && !timedOut) emit({ ...snapshot, status: 'error' });
    }).finally(() => {
      if (deadline !== null) clearTimeout(deadline);
      deadline = null;
      inFlight = false;
      run();
    });
  };
  const refresh = () => {
    if (!listeners.size) return;
    revision += 1;
    pending = true;
    // A StrictMode/unmount cycle cancels the UI deadline, not the unabortable browser call.
    if (inFlight && deadline === null) deadline = setTimeout(() => {
      deadline = null;
      if (listeners.size) emit({ ...snapshot, status: 'error' });
    }, ENUMERATE_TIMEOUT_MS);
    run();
  };
  const visible = () => { if (document.visibilityState === 'visible') refresh(); };
  const attach = () => {
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener(AUDIO_CAPTURE_CHANGED_EVENT, refresh);
    document.addEventListener('visibilitychange', visible);
  };
  const detach = () => {
    navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pageshow', refresh);
    window.removeEventListener(AUDIO_CAPTURE_CHANGED_EVENT, refresh);
    document.removeEventListener('visibilitychange', visible);
    revision += 1;
    pending = false;
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
  };
  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener: (snapshot: AudioDeviceInventorySnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      if (listeners.size === 1) { attach(); refresh(); }
      return () => { listeners.delete(listener); if (!listeners.size) detach(); };
    },
  };
}

export const audioDeviceInventory = createAudioDeviceInventory();

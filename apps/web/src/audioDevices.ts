export interface AudioDeviceLike {
  deviceId: string;
  label: string;
  groupId?: string;
}

export interface AudioDeviceChoice {
  id: string;
  label: string;
}

export type AudioDeviceGetter = (
  kind: 'audioinput' | 'audiooutput',
  requestPermissions: boolean,
) => Promise<AudioDeviceLike[]>;

export interface AudioDeviceLoadState {
  inputs: AudioDeviceLike[];
  outputs: AudioDeviceLike[];
  inputFailed: boolean;
  outputFailed: boolean;
  partial: boolean;
  permissionDenied: boolean;
  retryable: boolean;
}

export interface AudioDeviceLoad {
  /** Resolves no later than the UI deadline, with any list that is already available. */
  bounded: Promise<AudioDeviceLoadState>;
  /** Resolves after a late permission prompt and the mandatory post-permission enumeration. */
  settled: Promise<AudioDeviceLoadState>;
}

interface AudioDeviceLoadOptions {
  requestPermission?: boolean;
  forcePermission?: boolean;
  timeoutMs?: number;
  coordinationTimeoutMs?: number;
}

const AUDIO_DEVICE_UI_DEADLINE_MS = 4_000;
const MICROPHONE_CAPTURE_COORDINATION_MS = 12_000;

let microphonePermissionDenied = false;
let microphonePageHidden = typeof document !== 'undefined' ? document.hidden : false;
let microphoneCaptureSequence = 0;
let latestMicrophonePermissionResult = 0;
const microphoneCaptures = new Map<number, number>(); // capture generation -> coordination expiry
let microphonePermissionProbe: { promise: Promise<void>; expiresAt: number } | null = null;
const microphoneCaptureWaiters = new Set<() => void>();
const microphonePermissionListeners = new Set<() => void>();

// pagehide may precede document.hidden on iOS (and BFCache restore may deliver pageshow without a
// matching visibility event). Device menus and the settings preview share this fail-closed fence:
// neither is allowed to open a new permission sheet behind a hidden browser tab or standalone PWA.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const syncMicrophonePageVisibility = () => { microphonePageHidden = document.hidden; };
  window.addEventListener('pagehide', () => { microphonePageHidden = true; });
  window.addEventListener('pageshow', syncMicrophonePageVisibility);
  document.addEventListener('visibilitychange', syncMicrophonePageVisibility);
}

function normalizedCoordinationMs(value = MICROPHONE_CAPTURE_COORDINATION_MS): number {
  return Number.isFinite(value) ? Math.max(0, value) : MICROPHONE_CAPTURE_COORDINATION_MS;
}

function pruneExpiredMicrophoneCaptures(now = Date.now()) {
  microphoneCaptures.forEach((expiresAt, generation) => {
    if (expiresAt <= now) microphoneCaptures.delete(generation);
  });
}

function hasActiveMicrophoneCapture(): boolean {
  pruneExpiredMicrophoneCaptures();
  return microphoneCaptures.size > 0;
}

function isPermissionDeniedError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name || '')
    : '';
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

/**
 * Coordinates raw getUserMedia calls with device enumeration. Settings mount a live MicMeter, so
 * its capture must finish before a device loader considers opening a second permission prompt.
 */
export function beginMicrophoneCapture(coordinationTimeoutMs = MICROPHONE_CAPTURE_COORDINATION_MS): (error?: unknown) => void {
  const generation = ++microphoneCaptureSequence;
  microphoneCaptures.set(generation, Date.now() + normalizedCoordinationMs(coordinationTimeoutMs));
  let finished = false;
  return (error?: unknown) => {
    if (finished) return;
    finished = true;
    microphoneCaptures.delete(generation);
    // A stale WebKit promise may settle after an explicit newer Retry. Its older
    // denial/success cannot overwrite the permission state established by the winner.
    if (generation >= latestMicrophonePermissionResult) {
      latestMicrophonePermissionResult = generation;
      if (error === undefined) microphonePermissionDenied = false;
      else if (isPermissionDeniedError(error)) microphonePermissionDenied = true;
    }
    microphoneCaptureWaiters.forEach((resolve) => resolve());
    microphonePermissionListeners.forEach((listener) => {
      try { listener(); } catch { /** a device-list subscriber must never fail microphone capture */ }
    });
  };
}

export function subscribeMicrophonePermissionSettled(listener: () => void): () => void {
  microphonePermissionListeners.add(listener);
  return () => microphonePermissionListeners.delete(listener);
}

function microphonePageCaptureVisible(): boolean {
  const hiddenNow = typeof document !== 'undefined' && document.hidden;
  return !microphonePageHidden && !hiddenNow;
}

export function automaticMicrophoneCaptureAllowed(): boolean {
  return !microphonePermissionDenied && microphonePageCaptureVisible();
}

function waitForMicrophoneCapture(): Promise<void> {
  if (!hasActiveMicrophoneCapture()) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      microphoneCaptureWaiters.delete(check);
      resolve();
    };
    const check = () => {
      if (settled) return;
      pruneExpiredMicrophoneCaptures();
      if (microphoneCaptures.size === 0) { finish(); return; }
      if (timer !== null) globalThis.clearTimeout(timer);
      const nearestExpiry = Math.min(...microphoneCaptures.values());
      timer = globalThis.setTimeout(check, Math.max(1, nearestExpiry - Date.now() + 1));
    };
    microphoneCaptureWaiters.add(check);
    check();
  });
}

function devicesNeedPermission(inputs: AudioDeviceLike[], outputs: AudioDeviceLike[], inputFailed: boolean): boolean {
  return inputFailed || inputs.length === 0
    || inputs.some((device) => !device.label.trim())
    || outputs.some((device) => !device.label.trim());
}

async function requestMicrophonePermission(
  getDevices: AudioDeviceGetter,
  force: boolean,
  coordinationTimeoutMs: number,
): Promise<void> {
  if (!microphonePageCaptureVisible()) return;
  if (microphonePermissionDenied && !force) return;
  const now = Date.now();
  if (microphonePermissionProbe?.expiresAt && microphonePermissionProbe.expiresAt > now) {
    return microphonePermissionProbe.promise;
  }
  // A never-settled WebKit probe no longer owns the process after its coordination lease.
  // The promise itself cannot be cancelled, but an explicit Retry may create a newer winner.
  microphonePermissionProbe = null;
  const leaseMs = normalizedCoordinationMs(coordinationTimeoutMs);
  const finishCapture = beginMicrophoneCapture(leaseMs);
  let record: { promise: Promise<void>; expiresAt: number };
  const probe = Promise.resolve()
    .then(() => getDevices('audioinput', true))
    .then(() => finishCapture(), (error) => finishCapture(error))
    .finally(() => {
      if (microphonePermissionProbe === record) microphonePermissionProbe = null;
    });
  record = { promise: probe, expiresAt: now + leaseMs };
  microphonePermissionProbe = record;
  return probe;
}

/**
 * Loads both audio lists without creating two concurrent permission captures. The first pass never
 * asks for permission. If labels are still protected, one single-flight audio permission probe is
 * allowed and both lists are enumerated again only after that probe settles. The UI receives a
 * partial/retryable result after four seconds even when WebKit keeps a permission promise pending.
 */
export function loadAudioDevices(
  getDevices: AudioDeviceGetter,
  options: AudioDeviceLoadOptions = {},
): AudioDeviceLoad {
  const requestPermission = options.requestPermission !== false;
  const forcePermission = options.forcePermission === true;
  const timeoutMs = options.timeoutMs ?? AUDIO_DEVICE_UI_DEADLINE_MS;
  const coordinationTimeoutMs = normalizedCoordinationMs(options.coordinationTimeoutMs);
  let inputs: AudioDeviceLike[] = [];
  let outputs: AudioDeviceLike[] = [];
  let inputStatus: 'pending' | 'ready' | 'failed' = 'pending';
  let outputStatus: 'pending' | 'ready' | 'failed' = 'pending';
  let permissionPending = false;

  const state = (): AudioDeviceLoadState => {
    const inputFailed = inputStatus === 'failed';
    const outputFailed = outputStatus === 'failed';
    const incomplete = inputStatus === 'pending' || outputStatus === 'pending' || permissionPending
      || devicesNeedPermission(inputs, outputs, inputFailed);
    return {
      inputs: [...inputs],
      outputs: [...outputs],
      inputFailed,
      outputFailed,
      partial: incomplete,
      permissionDenied: microphonePermissionDenied,
      retryable: incomplete || inputFailed || outputFailed,
    };
  };

  const enumerateKind = async (kind: 'audioinput' | 'audiooutput') => {
    try {
      const devices = await getDevices(kind, false);
      if (kind === 'audioinput') { inputs = devices; inputStatus = 'ready'; }
      else { outputs = devices; outputStatus = 'ready'; }
    } catch {
      if (kind === 'audioinput') inputStatus = 'failed';
      else outputStatus = 'failed';
    }
  };
  const enumerateBoth = async () => {
    inputStatus = 'pending';
    outputStatus = 'pending';
    await Promise.all([enumerateKind('audioinput'), enumerateKind('audiooutput')]);
  };

  const settled = (async () => {
    await enumerateBoth();
    const afterInitialEnumeration = state();
    if (!devicesNeedPermission(
      afterInitialEnumeration.inputs,
      afterInitialEnumeration.outputs,
      afterInitialEnumeration.inputFailed,
    )) return afterInitialEnumeration;

    // A MicMeter/voice capture already owns getUserMedia. Await it and re-enumerate rather than
    // racing it with a second prompt. The bounded result below still unblocks the UI after 4s.
    if (hasActiveMicrophoneCapture()) {
      permissionPending = true;
      await waitForMicrophoneCapture();
      permissionPending = false;
      await enumerateBoth();
      const afterCapture = state();
      if (!devicesNeedPermission(
        afterCapture.inputs,
        afterCapture.outputs,
        afterCapture.inputFailed,
      )) return afterCapture;
      // Never stack an automatic prompt over a capture that merely exceeded its
      // coordination lease. Only an explicit user Retry may supersede it.
      if (!forcePermission) return afterCapture;
    }

    if (!requestPermission || (microphonePermissionDenied && !forcePermission)) return state();
    permissionPending = true;
    await requestMicrophonePermission(getDevices, forcePermission, coordinationTimeoutMs);
    permissionPending = false;
    // LiveKit itself normally re-enumerates after getUserMedia, but the output list and some WebKit
    // routes are separate. Always refresh both kinds after the permission attempt has settled.
    await enumerateBoth();
    return state();
  })();

  const bounded = new Promise<AudioDeviceLoadState>((resolve) => {
    const timer = globalThis.setTimeout(() => resolve(state()), Math.max(0, timeoutMs));
    void settled.then((result) => {
      globalThis.clearTimeout(timer);
      resolve(result);
    });
  });
  return { bounded, settled };
}

export interface AppleMobilePlatform {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

const normalized = (value: string) => value.trim().toLocaleLowerCase();

function uniqueChoiceLabels(choices: AudioDeviceChoice[]): AudioDeviceChoice[] {
  const counts = new Map<string, number>();
  const used = new Set<string>();
  return choices.map((choice) => {
    const base = choice.label.trim() || 'Устройство';
    const key = normalized(base);
    let number = (counts.get(key) || 0) + 1;
    let label = number === 1 ? base : `${base} (${number})`;
    while (used.has(normalized(label))) {
      number++;
      label = `${base} (${number})`;
    }
    counts.set(key, number);
    used.add(normalized(label));
    return { ...choice, label };
  });
}

function isDefaultDevice(device: AudioDeviceLike): boolean {
  const id = normalized(device.deviceId);
  const label = normalized(device.label);
  return !id
    || id === 'default'
    || id === 'communications'
    || id === 'communication'
    || label === 'default'
    || label === 'communications'
    || label === 'communication'
    || label === 'по умолчанию'
    || label === 'связь по умолчанию'
    || label.startsWith('default - ')
    || label.startsWith('communications - ');
}

export function isAppleMobilePlatform(platform: AppleMobilePlatform): boolean {
  return /iPad|iPhone|iPod/i.test(platform.userAgent)
    || (platform.platform === 'MacIntel' && platform.maxTouchPoints > 1);
}

export function currentAppleMobilePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return isAppleMobilePlatform({
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
  });
}

export function directAudioOutputSelectionSupported(): boolean {
  if (typeof HTMLMediaElement === 'undefined' || typeof AudioContext === 'undefined') return false;
  const mediaElementCanSwitch = typeof (HTMLMediaElement.prototype as HTMLMediaElement & {
    setSinkId?: (deviceId: string) => Promise<void>;
  }).setSinkId === 'function';
  const audioContextCanSwitch = typeof (AudioContext.prototype as AudioContext & {
    setSinkId?: (deviceId: string) => Promise<void>;
  }).setSinkId === 'function';
  return mediaElementCanSwitch && audioContextCanSwitch;
}

export function audioDeviceChoices(devices: AudioDeviceLike[], unnamedLabel = 'Устройство'): AudioDeviceChoice[] {
  const seenIds = new Set<string>();
  const seenGroupLabels = new Set<string>();
  const choices: AudioDeviceChoice[] = [];
  for (const device of devices) {
    const id = device.deviceId.trim();
    const group = device.groupId?.trim() || '';
    const groupLabel = group ? `${group}\u0000${normalized(device.label) || normalized(unnamedLabel)}` : '';
    if (isDefaultDevice(device) || seenIds.has(id) || (!!groupLabel && seenGroupLabels.has(groupLabel))) continue;
    seenIds.add(id);
    if (groupLabel) seenGroupLabels.add(groupLabel);
    choices.push({ id, label: device.label.trim() || unnamedLabel });
  }
  return uniqueChoiceLabels(choices);
}

function appleMobileRouteLabel(label: string): string | null {
  const value = normalized(label);
  if (/(earpiece|receiver|разговорный динамик)/i.test(value)) return 'Разговорный динамик';
  if (/(^speaker$|^динамик$|speakerphone|loudspeaker|(?:iphone|ipad) speaker|speaker (?:iphone|ipad)|динамик (?:iphone|ipad)|громкая связь|внешний динамик)/i.test(value)) return 'Громкая связь';
  if (/(airpods|earbuds|headphones|headset|bluetooth|hands[ -]?free|car audio|usb audio|usb headset|наушник|гарнитур)/i.test(value)) return label.trim() || 'Наушники';
  return null;
}

export function appleMobileAudioRoutes(devices: AudioDeviceLike[]): AudioDeviceChoice[] {
  const routes: AudioDeviceChoice[] = [];
  const seenIds = new Set<string>();
  const seenGroupLabels = new Set<string>();
  const seenBuiltInRoutes = new Set<string>();
  for (const device of devices) {
    const id = device.deviceId.trim();
    const group = device.groupId?.trim() || '';
    if (isDefaultDevice(device) || seenIds.has(id)) continue;
    const label = appleMobileRouteLabel(device.label);
    if (!label) continue;
    const labelKey = normalized(label);
    const builtIn = label === 'Громкая связь' || label === 'Разговорный динамик';
    const groupLabel = !builtIn && group ? `${group}\u0000${labelKey}` : '';
    if (!!groupLabel && seenGroupLabels.has(groupLabel)) continue;
    if (builtIn && seenBuiltInRoutes.has(labelKey)) continue;
    seenIds.add(id);
    if (groupLabel) seenGroupLabels.add(groupLabel);
    if (builtIn) seenBuiltInRoutes.add(labelKey);
    routes.push({ id, label });
  }
  return uniqueChoiceLabels(routes);
}

export function audioDeviceSelectionMissing(selectedId: string, choices: AudioDeviceChoice[]): boolean {
  return !!selectedId && !choices.some((choice) => choice.id === selectedId);
}

export function audioOutputChoices(
  appleMobile: boolean,
  inputs: AudioDeviceLike[],
  outputs: AudioDeviceLike[],
  directOutputSupported = true,
): { choices: AudioDeviceChoice[]; viaInput: boolean } {
  const outputChoices = audioDeviceChoices(outputs, 'Устройство вывода');
  if (!appleMobile || (directOutputSupported && outputChoices.length > 0)) {
    return { choices: directOutputSupported ? outputChoices : [], viaInput: false };
  }
  const routes = appleMobileAudioRoutes(inputs);
  if (routes.length > 0) return { choices: routes, viaInput: true };
  return { choices: directOutputSupported ? outputChoices : [], viaInput: false };
}

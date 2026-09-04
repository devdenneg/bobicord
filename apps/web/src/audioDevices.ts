export interface AudioDeviceLike {
  deviceId: string;
  label: string;
  groupId?: string;
}

export interface AudioDeviceChoice {
  id: string;
  label: string;
}

export interface AppleMobilePlatform {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

const normalized = (value: string) => value.trim().toLocaleLowerCase();

function isDefaultDevice(device: AudioDeviceLike): boolean {
  const label = normalized(device.label);
  return !device.deviceId
    || device.deviceId === 'default'
    || label === 'default'
    || label === 'по умолчанию';
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

export function audioDeviceChoices(devices: AudioDeviceLike[]): AudioDeviceChoice[] {
  const seenIds = new Set<string>();
  const choices: AudioDeviceChoice[] = [];
  for (const device of devices) {
    if (isDefaultDevice(device) || seenIds.has(device.deviceId)) continue;
    const label = device.label.trim() || `Устройство ${device.deviceId.slice(0, 6)}`;
    seenIds.add(device.deviceId);
    choices.push({ id: device.deviceId, label });
  }
  return choices;
}

function appleMobileRouteLabel(label: string): string | null {
  const value = normalized(label);
  if (value.includes('speakerphone') || value.includes('loudspeaker')) return 'Громкая связь';
  if (value.includes('earpiece') || value.includes('receiver')) return 'Разговорный динамик';
  if (/(airpods|earbuds|headphones|headset|bluetooth)/i.test(value)) return label.trim() || 'Наушники';
  return null;
}

export function appleMobileAudioRoutes(devices: AudioDeviceLike[]): AudioDeviceChoice[] {
  const routes: AudioDeviceChoice[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (const device of devices) {
    if (isDefaultDevice(device) || seenIds.has(device.deviceId)) continue;
    const label = appleMobileRouteLabel(device.label);
    if (!label) continue;
    const labelKey = normalized(label);
    if (seenLabels.has(labelKey)) continue;
    seenIds.add(device.deviceId);
    seenLabels.add(labelKey);
    routes.push({ id: device.deviceId, label });
  }
  return routes;
}

export function audioOutputChoices(
  appleMobile: boolean,
  inputs: AudioDeviceLike[],
  outputs: AudioDeviceLike[],
): { choices: AudioDeviceChoice[]; viaInput: boolean } {
  const outputChoices = audioDeviceChoices(outputs);
  if (!appleMobile || outputChoices.length > 0) return { choices: outputChoices, viaInput: false };
  const routes = appleMobileAudioRoutes(inputs);
  return routes.length > 0 ? { choices: routes, viaInput: true } : { choices: [], viaInput: false };
}

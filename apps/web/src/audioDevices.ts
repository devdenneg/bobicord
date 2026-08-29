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

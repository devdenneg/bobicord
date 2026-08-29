import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'audioDevices.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  appleMobileAudioRoutes,
  audioDeviceSelectionMissing,
  audioDeviceChoices,
  audioOutputChoices,
  directAudioOutputSelectionSupported,
  isAppleMobilePlatform,
} = await import('data:text/javascript,' + encodeURIComponent(js));

const device = (deviceId, label, groupId = '') => ({ deviceId, label, groupId });

assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 }), true);
assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 }), false);

const originalMediaElement = globalThis.HTMLMediaElement;
const originalAudioContext = globalThis.AudioContext;
globalThis.HTMLMediaElement = class HTMLMediaElement {};
globalThis.AudioContext = class AudioContext {};
assert.equal(directAudioOutputSelectionSupported(), false);
globalThis.HTMLMediaElement.prototype.setSinkId = async () => {};
assert.equal(directAudioOutputSelectionSupported(), false);
globalThis.AudioContext.prototype.setSinkId = async () => {};
assert.equal(directAudioOutputSelectionSupported(), true);
if (originalMediaElement === undefined) delete globalThis.HTMLMediaElement;
else globalThis.HTMLMediaElement = originalMediaElement;
if (originalAudioContext === undefined) delete globalThis.AudioContext;
else globalThis.AudioContext = originalAudioContext;

assert.deepEqual(audioDeviceChoices([
  device('default', 'По умолчанию'),
  device('communications', 'Communications - Bluetooth headset'),
  device('default-alias', 'Default - Phone speaker'),
  device('ios-default', 'По умолчанию'),
  device('mic-1', 'Встроенный микрофон'),
  device('mic-1', 'Встроенный микрофон'),
  device('mic-2', 'Встроенный микрофон'),
  device('mic-2-copy', 'Копия микрофона', 'same-physical-device'),
  device('mic-2-copy-2', 'Копия микрофона', 'same-physical-device'),
  device('mic-2-alt', 'Другой вход', 'same-physical-device'),
  device('anonymous-1', ''),
  device('anonymous-2', ''),
]), [
  { id: 'mic-1', label: 'Встроенный микрофон' },
  { id: 'mic-2', label: 'Встроенный микрофон (2)' },
  { id: 'mic-2-copy', label: 'Копия микрофона' },
  { id: 'mic-2-alt', label: 'Другой вход' },
  { id: 'anonymous-1', label: 'Устройство' },
  { id: 'anonymous-2', label: 'Устройство (2)' },
]);

const availableMics = audioDeviceChoices([device('mic-1', 'Микрофон')]);
assert.equal(audioDeviceSelectionMissing('', availableMics), false);
assert.equal(audioDeviceSelectionMissing('mic-1', availableMics), false);
assert.equal(audioDeviceSelectionMissing('removed-mic', availableMics), true);

const routes = appleMobileAudioRoutes([
  device('default', 'По умолчанию'),
  device('route-speaker', 'Speakerphone', 'built-in-phone'),
  device('route-receiver', 'Headset earpiece', 'built-in-phone'),
  device('route-airpods', 'Denis AirPods'),
  device('route-airpods-2', 'Denis AirPods'),
  device('route-speaker-copy', 'Громкая связь'),
  device('route-bluetooth-ru', 'Гарнитура Bluetooth'),
  device('phone-mic', 'iPhone Microphone'),
]);
assert.deepEqual(routes, [
  { id: 'route-speaker', label: 'Громкая связь' },
  { id: 'route-receiver', label: 'Разговорный динамик' },
  { id: 'route-airpods', label: 'Denis AirPods' },
  { id: 'route-airpods-2', label: 'Denis AirPods (2)' },
  { id: 'route-bluetooth-ru', label: 'Гарнитура Bluetooth' },
]);

assert.deepEqual(appleMobileAudioRoutes([
  device('route-speaker-ru', 'Динамик iPhone'),
]), [{ id: 'route-speaker-ru', label: 'Громкая связь' }]);
assert.deepEqual(appleMobileAudioRoutes([
  device('route-speaker-short', 'Динамик'),
  device('route-receiver-ru', 'Разговорный динамик'),
]), [
  { id: 'route-speaker-short', label: 'Громкая связь' },
  { id: 'route-receiver-ru', label: 'Разговорный динамик' },
]);

assert.deepEqual(audioOutputChoices(true, [
  device('route-speaker', 'Speakerphone'),
  device('route-receiver', 'Headset earpiece'),
], [device('default', 'По умолчанию')]), {
  choices: [
    { id: 'route-speaker', label: 'Громкая связь' },
    { id: 'route-receiver', label: 'Разговорный динамик' },
  ],
  viaInput: true,
});

assert.deepEqual(audioOutputChoices(true, [device('route-speaker', 'Speakerphone')], [
  device('default', 'По умолчанию'),
  device('usb-output', 'USB Audio'),
]), {
  choices: [{ id: 'usb-output', label: 'USB Audio' }],
  viaInput: false,
});

assert.deepEqual(audioOutputChoices(true, [
  device('route-speaker', 'Speakerphone'),
  device('route-airpods', 'Denis AirPods'),
], [device('usb-output', 'USB Audio')], false), {
  choices: [
    { id: 'route-speaker', label: 'Громкая связь' },
    { id: 'route-airpods', label: 'Denis AirPods' },
  ],
  viaInput: true,
});

assert.deepEqual(audioOutputChoices(true, [], [device('usb-output', 'USB Audio')], false), {
  choices: [],
  viaInput: false,
});

assert.deepEqual(audioOutputChoices(false, [], [device('usb-output', 'USB Audio')], false), {
  choices: [],
  viaInput: false,
});

console.log('audio devices: ok');

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
  audioDeviceChoices,
  audioOutputChoices,
  isAppleMobilePlatform,
  withSelectedAudioDevice,
} = await import('data:text/javascript,' + encodeURIComponent(js));

const device = (deviceId, label, groupId = '') => ({ deviceId, label, groupId });

assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 }), true);
assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
assert.equal(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 }), false);

assert.deepEqual(audioDeviceChoices([
  device('default', 'По умолчанию'),
  device('communications', 'Default communications device'),
  device('ios-default', 'По умолчанию'),
  device('mic-1', 'Встроенный микрофон'),
  device('mic-1', 'Встроенный микрофон'),
  device('mic-2', 'Встроенный микрофон'),
]), [
  { id: 'mic-1', label: 'Встроенный микрофон' },
  { id: 'mic-2', label: 'Встроенный микрофон' },
]);

const routes = appleMobileAudioRoutes([
  device('default', 'По умолчанию'),
  device('route-speaker', 'Speakerphone'),
  device('route-receiver', 'Headset earpiece'),
  device('route-airpods', 'Denis AirPods'),
  device('phone-mic', 'iPhone Microphone'),
]);
assert.deepEqual(routes, [
  { id: 'route-speaker', label: 'Громкая связь' },
  { id: 'route-receiver', label: 'Разговорный динамик' },
  { id: 'route-airpods', label: 'Denis AirPods' },
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

console.log('audio devices: ok');

assert.deepEqual(withSelectedAudioDevice([], 'saved-mic'), [
  { id: 'saved-mic', label: 'Выбранное устройство недоступно', unavailable: true },
]);
assert.deepEqual(withSelectedAudioDevice([{ id: 'saved-mic', label: 'USB' }], 'saved-mic'), [{ id: 'saved-mic', label: 'USB' }]);
assert.deepEqual(withSelectedAudioDevice([], ''), []);

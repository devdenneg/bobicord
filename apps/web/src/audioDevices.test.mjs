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
  automaticMicrophoneCaptureAllowed,
  directAudioOutputSelectionSupported,
  isAppleMobilePlatform,
  loadAudioDevices,
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

// A menu opened just before an iPhone browser tab/PWA is hidden must not create a permission sheet
// after its first asynchronous enumeration completes.
{
  const originalDocument = globalThis.document;
  globalThis.document = { hidden: true };
  let hiddenPermissionProbes = 0;
  const hiddenGetter = async (kind, requestPermissions) => {
    if (requestPermissions) hiddenPermissionProbes++;
    return kind === 'audioinput' ? [device('hidden-mic', '')] : [device('hidden-output', '')];
  };
  assert.equal(automaticMicrophoneCaptureAllowed(), false);
  const hiddenResult = await loadAudioDevices(hiddenGetter, { forcePermission: true, timeoutMs: 100 }).settled;
  assert.equal(hiddenPermissionProbes, 0, 'a hidden page never starts getUserMedia from device discovery');
  assert.equal(hiddenResult.partial, true, 'the foreground Retry remains available after hidden discovery is fenced');
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  assert.equal(automaticMicrophoneCaptureAllowed(), true);
}

// Enumeration never requests permission on its first pass. One permission probe follows, and both
// kinds are enumerated again only after it resolves so labels/routes cannot stay stale.
{
  const calls = [];
  let permissionGranted = false;
  const getter = async (kind, requestPermissions) => {
    calls.push(`${kind}:${requestPermissions}`);
    if (requestPermissions) {
      permissionGranted = true;
      return [device('mic-1', 'Phone mic')];
    }
    if (kind === 'audioinput') return [device('mic-1', permissionGranted ? 'Phone mic' : '')];
    return [device('out-1', permissionGranted ? 'Phone speaker' : '')];
  };
  const result = await loadAudioDevices(getter, { timeoutMs: 100 }).settled;
  assert.deepEqual(calls, [
    'audioinput:false',
    'audiooutput:false',
    'audioinput:true',
    'audioinput:false',
    'audiooutput:false',
  ]);
  assert.equal(result.partial, false);
  assert.equal(result.inputs[0].label, 'Phone mic');
  assert.equal(result.outputs[0].label, 'Phone speaker');
}

// A hanging mobile permission sheet cannot leave the menu spinner infinite. The bounded result is
// partial/retryable, while the same generation still accepts the late permission result.
{
  let grant;
  let granted = false;
  const getter = async (kind, requestPermissions) => {
    if (requestPermissions) {
      await new Promise((resolve) => { grant = () => { granted = true; resolve(); }; });
    }
    return kind === 'audioinput'
      ? [device('mic-late', granted ? 'Late mic' : '')]
      : [device('out-late', granted ? 'Late speaker' : '')];
  };
  const request = loadAudioDevices(getter, { timeoutMs: 5 });
  const bounded = await request.bounded;
  assert.equal(bounded.partial, true);
  assert.equal(bounded.retryable, true);
  assert.equal(typeof grant, 'function');
  grant();
  const settled = await request.settled;
  assert.equal(settled.partial, false);
  assert.equal(settled.inputs[0].label, 'Late mic');
}

// Two menus opening together share one permission capture; neither can create a second WebKit
// sheet while the first getUserMedia call is unresolved.
{
  let grant;
  let granted = false;
  let probes = 0;
  const getter = async (kind, requestPermissions) => {
    if (requestPermissions) {
      probes++;
      await new Promise((resolve) => { grant = () => { granted = true; resolve(); }; });
    }
    return kind === 'audioinput'
      ? [device('mic-shared', granted ? 'Shared mic' : '')]
      : [device('out-shared', granted ? 'Shared speaker' : '')];
  };
  const first = loadAudioDevices(getter, { timeoutMs: 100 });
  const second = loadAudioDevices(getter, { timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(probes, 1);
  assert.equal(typeof grant, 'function');
  grant();
  const [firstResult, secondResult] = await Promise.all([first.settled, second.settled]);
  assert.equal(firstResult.partial, false);
  assert.equal(secondResult.partial, false);
  assert.equal(probes, 1, 'the permission probe remains single-flight');
}

// NotAllowed is remembered for automatic reloads. Only an explicit Retry may issue another probe.
{
  let deniedProbes = 0;
  const deniedGetter = async (kind, requestPermissions) => {
    if (requestPermissions) {
      deniedProbes++;
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    }
    return kind === 'audioinput' ? [device('mic-denied', '')] : [device('out-denied', '')];
  };
  const denied = await loadAudioDevices(deniedGetter, { timeoutMs: 100 }).settled;
  assert.equal(denied.permissionDenied, true);
  assert.equal(automaticMicrophoneCaptureAllowed(), false);
  assert.equal(deniedProbes, 1);
  await loadAudioDevices(deniedGetter, { timeoutMs: 100 }).settled;
  assert.equal(deniedProbes, 1, 'automatic reload must not repeat a denied permission request');

  let forcedProbe = 0;
  let granted = false;
  const retryGetter = async (kind, requestPermissions) => {
    if (requestPermissions) { forcedProbe++; granted = true; }
    return kind === 'audioinput'
      ? [device('mic-retry', granted ? 'Restored mic' : '')]
      : [device('out-retry', granted ? 'Restored speaker' : '')];
  };
  const retried = await loadAudioDevices(retryGetter, { forcePermission: true, timeoutMs: 100 }).settled;
  assert.equal(forcedProbe, 1);
  assert.equal(retried.permissionDenied, false);
  assert.equal(retried.partial, false);
  assert.equal(automaticMicrophoneCaptureAllowed(), true);
}

// A getUserMedia promise can stay pending forever after an iOS PWA was backgrounded. Its
// coordination lease must expire so an explicit Retry can create a newer single-flight probe;
// a late denial from the abandoned generation cannot overwrite the successful retry.
{
  let rejectAbandoned;
  let probes = 0;
  let granted = false;
  const getter = async (kind, requestPermissions) => {
    if (requestPermissions) {
      probes++;
      if (probes === 1) {
        await new Promise((_resolve, reject) => { rejectAbandoned = reject; });
      } else {
        granted = true;
      }
    }
    return kind === 'audioinput'
      ? [device('mic-hang', granted ? 'Recovered mic' : '')]
      : [device('out-hang', granted ? 'Recovered speaker' : '')];
  };
  const abandoned = loadAudioDevices(getter, { timeoutMs: 2, coordinationTimeoutMs: 8 });
  const partial = await abandoned.bounded;
  assert.equal(partial.partial, true);
  assert.equal(typeof rejectAbandoned, 'function');
  await new Promise((resolve) => setTimeout(resolve, 12));
  const recovered = await loadAudioDevices(getter, {
    forcePermission: true,
    timeoutMs: 100,
    coordinationTimeoutMs: 8,
  }).settled;
  assert.equal(probes, 2, 'explicit Retry supersedes the expired WebKit permission promise');
  assert.equal(recovered.partial, false);
  assert.equal(recovered.inputs[0].label, 'Recovered mic');
  rejectAbandoned(Object.assign(new Error('late denial'), { name: 'NotAllowedError' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(automaticMicrophoneCaptureAllowed(), true,
    'an older late denial cannot overwrite the newer successful generation');
}

console.log('audio devices: ok');

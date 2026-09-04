import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const device = (deviceId, label = deviceId, kind = 'audioinput') => ({ deviceId, label, kind });
function load(path, imports, globals, extra = '') {
  const filename = fileURLToPath(new URL(path, import.meta.url));
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  runInNewContext(js + extra, { exports, console, Error, ...globals, require: (id) => imports[id] || {} }, { filename });
  return exports;
}
class Target {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
  emit(type) { this.dispatchEvent({ type }); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
function environment() {
  const window = new Target(), document = new Target(), mediaDevices = new Target();
  document.visibilityState = 'visible'; document.body = {}; document.getElementById = () => null;
  const timers = new Map(), requests = []; let id = 0;
  mediaDevices.enumerateDevices = () => { const request = deferred(); requests.push(request); return request.promise; };
  mediaDevices.getUserMedia = () => { throw new Error('Enumeration must never capture'); };
  const globals = {
    window, document, navigator: { mediaDevices }, Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn) => { const next = ++id; timers.set(next, fn); return next; }, clearTimeout: (key) => timers.delete(key),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  };
  const module = load('./audioDeviceInventory.ts', {}, globals);
  return { ...globals, globals, ...module, timers, requests,
    timeout() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); },
  };
}

test('shared inventory coalesces event bursts, drops stale results and never captures', async () => {
  const h = environment(), seen = [];
  const stop = h.audioDeviceInventory.subscribe((snapshot) => seen.push(snapshot));
  const stopOther = h.audioDeviceInventory.subscribe(() => {});
  await settle(); assert.equal(h.requests.length, 1);
  h.window.emit('focus'); h.window.emit('pageshow'); h.navigator.mediaDevices.emit('devicechange'); h.notifyAudioCaptureChanged();
  await settle(); assert.equal(h.requests.length, 1);
  h.requests[0].resolve([device('old')]); await settle();
  assert.equal(h.requests.length, 2); assert.equal(seen.some((snapshot) => snapshot.inputs[0]?.deviceId === 'old'), false);
  h.requests[1].resolve([device('new'), device('speaker', 'Speaker', 'audiooutput')]); await settle();
  assert.equal(h.audioDeviceInventory.getSnapshot().inputs[0].deviceId, 'new');
  assert.equal(h.audioDeviceInventory.getSnapshot().outputs[0].deviceId, 'speaker');
  stop(); assert.ok(h.window.count() > 0);
  stopOther(); assert.equal(h.window.count() + h.document.count() + h.navigator.mediaDevices.count(), 0); assert.equal(h.timers.size, 0);
});

test('visible/capture refreshes labels, hidden visibility does not enumerate', async () => {
  const h = environment(); const stop = h.audioDeviceInventory.subscribe(() => {});
  await settle(); h.requests[0].resolve([device('mic', '')]); await settle();
  h.document.visibilityState = 'hidden'; h.document.emit('visibilitychange'); await settle(); assert.equal(h.requests.length, 1);
  h.document.visibilityState = 'visible'; h.document.emit('visibilitychange'); await settle();
  h.requests[1].resolve([device('mic', 'Allowed microphone')]); await settle();
  assert.equal(h.audioDeviceInventory.getSnapshot().inputs[0].label, 'Allowed microphone');
  h.notifyAudioCaptureChanged(); await settle(); assert.equal(h.requests.length, 3);
  stop(); h.requests[2].resolve([]); await settle();
  assert.equal(h.audioDeviceInventory.getSnapshot().inputs[0].deviceId, 'mic');
});

test('unmount/remount keeps a single raw request, ignores its old result and bounds the UI wait', async () => {
  const h = environment(); const stop = h.audioDeviceInventory.subscribe(() => {});
  await settle(); stop(); assert.equal(h.timers.size, 0);
  const stopNext = h.audioDeviceInventory.subscribe(() => {});
  await settle(); assert.equal(h.requests.length, 1);
  h.timeout(); assert.equal(h.audioDeviceInventory.getSnapshot().status, 'error');
  h.requests[0].resolve([device('stale')]); await settle(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve([device('current')]); await settle();
  assert.equal(h.audioDeviceInventory.getSnapshot().inputs[0].deviceId, 'current'); stopNext();
});

test('a hung enumerate times out without starting an endless or parallel retry loop', async () => {
  const h = environment(); const stop = h.audioDeviceInventory.subscribe(() => {});
  await settle(); h.window.emit('focus'); h.timeout(); await settle();
  assert.equal(h.audioDeviceInventory.getSnapshot().status, 'error');
  assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  h.requests[0].resolve([device('timed-out')]); await settle(); assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error('denied')); await settle();
  assert.equal(h.audioDeviceInventory.getSnapshot().status, 'error'); stop();
});

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) { for (const child of tree) { const result = find(child, predicate); if (result) return result; } return null; }
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function uiHarness(path, component, props = {}, appleMobile = false, initialSettings = {}) {
  const h = environment(), hooks = [], subscriptions = new Set(), effects = [];
  let index = 0, dirty = false, tree;
  let settings = { input: '', output: '', nsMode: 'off', mode: 'voice', keybinds: {}, master: 100, notifyVolume: 60, ...initialSettings };
  const calls = [];
  const engine = { reapplyMic: async (...args) => { calls.push(['reapply', ...args]); }, restartLevelMeter() { calls.push(['meter']); }, applyOutput: async () => { calls.push(['output']); } };
  const react = {
    useState(initial) { const key = index++; if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial; return [hooks[key], (next) => { const value = typeof next === 'function' ? next(hooks[key]) : next; if (value !== hooks[key]) { hooks[key] = value; dirty = true; } }]; },
    useRef(initial) { const key = index++; return hooks[key] ||= { current: initial }; },
    useMemo(make, deps) { const key = index++; if (!hooks[key] || deps.some((dep, i) => dep !== hooks[key].deps[i])) hooks[key] = { deps, value: make() }; return hooks[key].value; },
    useEffect(effect, deps) { const key = index++; if (!hooks[key] || deps.some((dep, i) => dep !== hooks[key].deps[i])) { const previous = hooks[key]; hooks[key] = { deps, cleanup: null }; effects.push(() => { previous?.cleanup?.(); hooks[key].cleanup = effect(); }); } },
  };
  react.useLayoutEffect = react.useEffect;
  const jsx = (type, props) => ({ type, props });
  const devices = load('./audioDevices.ts', {}, h.globals);
  const settingsModule = { getSettings: () => settings,
    setSettings(patch) { settings = { ...settings, ...patch }; for (const fn of subscriptions) fn(); },
    subscribeSettings(fn) { subscriptions.add(fn); return () => subscriptions.delete(fn); },
  };
  const module = load(path, {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'react-dom': { createPortal: (child) => child },
    '../audioDevices': { ...devices, currentAppleMobilePlatform: () => appleMobile }, '../audioDeviceInventory': { audioDeviceInventory: h.audioDeviceInventory },
    '../settings': settingsModule, '../store': { getEngine: () => engine }, '../native': { isTauri: false },
    '../theme': { getTheme: () => 'dark', THEMES: [] },
  }, h.globals, `\nexports.TestComponent = ${component};`);
  const render = () => {
    let rounds = 0;
    do { dirty = false; index = 0; tree = module.TestComponent(props); for (const effect of effects.splice(0)) effect(); } while (dirty && ++rounds < 12);
    assert.ok(rounds < 12, 'UI must not loop from inventory state');
    return tree;
  };
  render();
  return { ...h, render, calls, settings: () => settings, setSettings: settingsModule.setSettings,
    find: (predicate) => { const node = find(tree, predicate); assert.ok(node, 'Expected UI node'); return node; },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); assert.equal(subscriptions.size, 0); },
  };
}

test('Settings handlers refresh selectors, preserve missing preference and follow async fallback settings', async () => {
  const h = uiHarness('./components/Modals.tsx', 'SettingsModal', {}, false, { input: 'missing-mic' });
  await settle(); h.requests[0].resolve([]); await settle(); h.render();
  const input = h.find((node) => node.type === 'select' && node.props.value === 'missing-mic');
  assert.equal(find(input, (node) => node.type === 'option' && node.props.value === 'missing-mic').props.disabled, true);
  assert.equal(h.settings().input, 'missing-mic');
  input.props.onPointerDown(); await settle(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve([device('usb')]); await settle(); h.render();
  h.find((node) => node.type === 'select' && node.props.value === 'missing-mic').props.onChange({ target: { value: 'usb' } });
  assert.equal(h.settings().input, 'usb'); assert.ok(h.calls.some(([name]) => name === 'meter'));
  h.setSettings({ input: '' }); h.render();
  assert.ok(h.find((node) => node.type === 'select' && node.props.value === ''));
  h.unmount(); assert.equal(h.window.count() + h.document.count() + h.navigator.mediaDevices.count(), 0);
});

test('Settings iOS known route selection restarts preview and does not invent arbitrary routes', async () => {
  const h = uiHarness('./components/Modals.tsx', 'SettingsModal', {}, true);
  await settle(); h.requests[0].resolve([device('speaker', 'Speakerphone'), device('unknown', 'Arbitrary microphone')]); await settle(); h.render();
  const output = h.find((node) => node.type === 'select' && find(node, (option) => option.type === 'option' && option.props.value === 'speaker'));
  assert.equal(find(output, (node) => node.type === 'option' && node.props.value === 'unknown'), null);
  output.props.onChange({ target: { value: 'speaker' } }); await settle(); h.render();
  assert.equal(h.settings().input, 'speaker'); assert.equal(h.settings().output, '');
  assert.ok(h.calls.some(([name, reason]) => name === 'reapply' && reason === 'route'));
  assert.ok(h.calls.some(([name]) => name === 'meter')); assert.ok(h.calls.some(([name]) => name === 'output'));
  h.notifyAudioCaptureChanged(); await settle(); h.requests[1].resolve([]); await settle(); h.render();
  assert.ok(h.find((node) => node.type === 'option' && node.props.value === 'speaker' && node.props.disabled));
  h.unmount();
});

test('dock opening refreshes inventory; missing selected item stays checked and inert', async () => {
  const h = uiHarness('./components/VoiceDock.tsx', 'DeviceMenu', { kind: 'input' }, false, { input: 'gone' });
  await settle(); h.requests[0].resolve([]); await settle(); h.render();
  h.find((node) => node.type === 'button' && node.props['aria-label'] === 'Выбрать микрофон').props.onClick(); h.render(); await settle();
  assert.equal(h.requests.length, 2);
  const missing = h.find((node) => node.props?.role === 'menuitemradio' && node.props['aria-disabled']);
  assert.equal(missing.props['aria-checked'], true); missing.props.onClick(); assert.equal(h.calls.length, 0);
  h.requests[1].resolve([device('usb')]); await settle(); h.render();
  h.find((node) => node.props?.role === 'menuitemradio' && node.props.children === 'usb').props.onClick();
  assert.equal(h.settings().input, 'usb'); assert.ok(h.calls.some(([name]) => name === 'meter'));
  h.unmount();
});

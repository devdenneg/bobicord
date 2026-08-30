import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const origin = 'https://relay.example';
const plain = (value) => JSON.parse(JSON.stringify(value));
const normalizeSource = (value) => value.replace(/\r\n?/gu, '\n');
const readSource = (relative) => normalizeSource(readFileSync(new URL(relative, import.meta.url), 'utf8'));
assert.equal(normalizeSource('windows\r\nlegacy-mac\r'), 'windows\nlegacy-mac\n',
  'source-contract checks normalize platform line endings');
const storeSource = readSource('./store.ts');
const mainSource = readSource('./main.tsx');
const appSource = readSource('./App.tsx');
const serverViewSource = readSource('./components/ServerView.tsx');
assert.match(storeSource, /if \(!isTauri\) setSettings\(\{ notif: false \}\);[\s\S]{0,300}set\(\{ me: user/,
  'browser notification UI must become fail-closed before React can run the account init effect');
assert.match(storeSource, /emoteSize: storedEmoteSize\(\)/,
  'blocked localStorage cannot crash store construction before the first render');
assert.match(storeSource, /takePendingEntryIntent\(\)/,
  'blocked sessionStorage cannot reject an already authenticated account during post-auth routing');
assert.match(storeSource, /get\(\)\.me\?\.id \|\| get\(\)\.pendingUser\?\.id \|\| ''/,
  'email-gated logout cleans the exact pending account push binding');
assert.match(mainSource, /if \(invite\) rememberPendingInvite\(invite\)/,
  'invite boot keeps an in-memory fallback when sessionStorage is unavailable');
assert.doesNotMatch(appSource.match(/function ServerSkeleton\(\)[\s\S]*?\n\}/)?.[0] || '', /localStorage\./,
  'the server loading shell must render when localStorage access is blocked');
assert.doesNotMatch(serverViewSource.match(/function useResizable\([\s\S]*?\n\}/)?.[0] || '', /localStorage\./,
  'resizable server columns must not crash when localStorage read/write throws');
assert.match(mainSource, /destinationAccepted[\s\S]{0,500}e\.ports\?\.\[0\]\?\.postMessage\(\{ ok: true \}\)/,
  'the page acknowledges an exact notification destination only after its listener accepted it');

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

function loadTsCommonJs(relative, { requireMap = {}, globals = {} } = {}) {
  const source = readSource(relative);
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const context = vm.createContext({
    module: { exports }, exports,
    require(specifier) {
      if (Object.hasOwn(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`unexpected require: ${specifier}`);
    },
    URL, URLSearchParams, Date, Promise, Error, Set, Map, JSON, ArrayBuffer, Uint8Array,
    atob, btoa, console, ...globals,
  });
  vm.runInContext(code, context, { filename: relative });
  return context.module.exports;
}

const throwingLayoutStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('quota'); },
  removeItem() { throw new Error('blocked'); },
};
const safeStorage = loadTsCommonJs('./safeStorage.ts', { globals: { localStorage: throwingLayoutStorage } });
assert.equal(safeStorage.safeLocalStorageGet('membersOpen'), null,
  'a blocked storage getter falls back without throwing during render');
assert.equal(safeStorage.safeLocalStorageSet('membersOpen', '0'), false);
assert.equal(safeStorage.safeLocalStorageGet('membersOpen'), '0',
  'a failed write remains authoritative in memory for the current page');
assert.equal(safeStorage.safeLocalStorageRemove('membersOpen'), false);
assert.equal(safeStorage.safeLocalStorageGet('membersOpen'), null,
  'a failed removal cannot resurrect an older readable layout value');

const appliedThemes = [];
const appliedThemeColors = [];
const throwingThemeStorage = {
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('storage unavailable'); },
};
const theme = loadTsCommonJs('./theme.ts', {
  globals: {
    localStorage: throwingThemeStorage,
    document: {
      documentElement: { setAttribute(name, value) { appliedThemes.push({ name, value }); } },
      querySelector(selector) {
        assert.equal(selector, 'meta[name="theme-color"]');
        return { setAttribute(name, value) { appliedThemeColors.push({ name, value }); } };
      },
    },
  },
});
assert.equal(theme.getTheme(), 'dark', 'blocked localStorage falls back before application render');
assert.doesNotThrow(() => theme.setTheme('light'));
assert.deepEqual(appliedThemes.at(-1), { name: 'data-theme', value: 'light' },
  'a theme choice still applies in memory when persistence is blocked');
assert.deepEqual(appliedThemeColors.at(-1), { name: 'content', value: '#e9ebef' },
  'a live theme choice keeps the browser/PWA system chrome color in sync');

function settingsTab(storage) {
  const pageListeners = new Map();
  const documentListeners = new Map();
  const workerListeners = new Map();
  const workerMessages = [];
  const pageEvents = [];
  const add = (target, type, listener) => {
    const listeners = target.get(type) || [];
    listeners.push(listener);
    target.set(type, listeners);
  };
  const dispatch = (target, type, event = {}) => {
    for (const listener of target.get(type) || []) listener(event);
  };
  const window = {
    addEventListener(type, listener) { add(pageListeners, type, listener); },
    dispatchEvent(event) {
      pageEvents.push(event);
      dispatch(pageListeners, event.type, event);
      return true;
    },
  };
  const serviceWorker = {
    controller: { postMessage(message) { workerMessages.push(message); } },
    addEventListener(type, listener) { add(workerListeners, type, listener); },
  };
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  }
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) { add(documentListeners, type, listener); },
  };
  const settings = loadTsCommonJs('./settings.ts', {
    globals: { localStorage: storage, window, document, navigator: { serviceWorker }, CustomEvent },
  });
  return {
    settings, workerMessages, pageEvents,
    dispatchStorage(newValue) { dispatch(pageListeners, 'storage', { key: 'audioSettings', newValue }); },
    dispatchControllerChange() { dispatch(workerListeners, 'controllerchange'); },
    dispatchPageShow() { dispatch(pageListeners, 'pageshow'); },
    dispatchVisibility(state = 'visible') {
      document.visibilityState = state;
      dispatch(documentListeners, 'visibilitychange');
    },
  };
}

{
  const storage = new MemoryStorage();
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'full', master: 100 }));
  const tabA = settingsTab(storage);
  const tabB = settingsTab(storage);
  tabA.settings.setSettings({ notifPrivacy: 'hidden' });
  tabA.settings.setSettings({ notifMention: false });
  const hiddenRaw = storage.getItem('audioSettings');
  tabB.dispatchStorage(hiddenRaw);
  assert.equal(tabB.settings.getSettings().notifPrivacy, 'hidden',
    'a privacy choice is synchronized to another live tab');
  assert.equal(tabB.workerMessages.at(-1).privacy, 'hidden');
  assert.equal(tabB.settings.getSettings().notifMention, false,
    'per-kind push preferences are synchronized together with privacy');
  assert.equal(tabA.pageEvents.some((event) => event.type === 'relay-notification-push-prefs-changed'), true,
    'a privacy choice asks the exact active account to refresh backend push preferences');
}

{
  const storage = new MemoryStorage();
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'full', notifMention: true, master: 100 }));
  const frozenTab = settingsTab(storage);
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'hidden', notifMention: false, master: 100 }));
  frozenTab.dispatchPageShow();
  assert.equal(frozenTab.settings.getSettings().notifPrivacy, 'hidden');
  assert.equal(frozenTab.settings.getSettings().notifMention, false);
  assert.equal(frozenTab.workerMessages.at(-1).privacy, 'hidden',
    'a BFCache tab re-reads durable prefs on pageshow even when its worker did not change');

  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'full', notifMention: true, master: 100 }));
  const replacedWorkerTab = settingsTab(storage);
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'hidden', notifMention: false, master: 100 }));
  replacedWorkerTab.dispatchControllerChange();
  assert.equal(replacedWorkerTab.settings.getSettings().notifPrivacy, 'hidden');
  assert.equal(replacedWorkerTab.settings.getSettings().notifMention, false);
  assert.equal(replacedWorkerTab.workerMessages.at(-1).privacy, 'hidden',
    'a tab that missed storage events re-reads durable privacy before controlling a replacement worker');

  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'full', notifStream: true, master: 100 }));
  const visibleTab = settingsTab(storage);
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'sender', notifStream: false, master: 100 }));
  visibleTab.dispatchVisibility('hidden');
  assert.equal(visibleTab.settings.getSettings().notifPrivacy, 'full', 'background transition alone does not mutate state');
  visibleTab.dispatchVisibility('visible');
  assert.equal(visibleTab.settings.getSettings().notifPrivacy, 'sender');
  assert.equal(visibleTab.settings.getSettings().notifStream, false,
    'foreground resume reconciles every push preference without requiring a worker replacement');

  // The same stale tab must not overwrite hidden privacy while saving an unrelated audio setting.
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'full', notifMention: true, master: 100 }));
  const staleWriter = settingsTab(storage);
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'hidden', notifMention: false, master: 100 }));
  staleWriter.settings.setSettings({ master: 55 });
  assert.equal(JSON.parse(storage.getItem('audioSettings')).notifPrivacy, 'hidden',
    'an unrelated stale-tab write preserves the current durable privacy policy');
  assert.equal(JSON.parse(storage.getItem('audioSettings')).notifMention, false,
    'an unrelated stale-tab write cannot re-enable a per-kind server preference');
}

{
  let durable = JSON.stringify({ notifPrivacy: 'full' });
  const readableUnwritable = {
    getItem() { return durable; },
    setItem() { throw new Error('write blocked'); },
  };
  const tab = settingsTab(readableUnwritable);
  tab.settings.setSettings({ notifPrivacy: 'hidden' });
  durable = JSON.stringify({ notifPrivacy: 'full' });
  tab.dispatchControllerChange();
  assert.equal(tab.settings.getSettings().notifPrivacy, 'hidden');
  assert.equal(tab.workerMessages.at(-1).privacy, 'hidden',
    'a controller change cannot erase an explicit in-memory choice after storage rejected its write');
}

{
  let durable = JSON.stringify({ notifPrivacy: 'hidden', notifMention: false, notifStream: false });
  const readableUnwritable = {
    getItem() { return durable; },
    setItem() { throw new Error('write blocked'); },
  };
  const tab = settingsTab(readableUnwritable);
  tab.settings.setSettings({ notifPrivacy: 'full', notifMention: true, notifStream: true });
  // Simulate a frozen/BFCache interval where this tab could not receive the storage event. The
  // durable policy remains restrictive and must floor the failed less-restrictive local attempt.
  durable = JSON.stringify({ notifPrivacy: 'hidden', notifMention: false, notifStream: false });
  tab.dispatchPageShow();
  assert.deepEqual(plain(tab.settings.getNotificationPushPrefs()), {
    notifPrivacy: 'hidden', notifMention: false, notifStream: false,
  }, 'a failed less-restrictive write cannot overrule durable cross-tab privacy after BFCache resume');
  assert.equal(tab.workerMessages.some((message) => message.privacy === 'full'), false,
    'a rejected full-content choice is never sent to either a current or replacement worker');
}

for (const corrupt of ['not-json', JSON.stringify({ notifPrivacy: 'leak' })]) {
  const storage = new MemoryStorage();
  storage.setItem('audioSettings', corrupt);
  const tab = settingsTab(storage);
  assert.equal(tab.settings.getSettings().notifPrivacy, 'hidden');
  assert.equal(tab.workerMessages.at(-1).privacy, 'hidden',
    'corrupted stored privacy fails closed before the first worker message');
}
assert.equal(settingsTab(new MemoryStorage()).settings.getSettings().notifPrivacy, 'full',
  'an actually absent settings record retains the product default');

{
  const storage = new MemoryStorage();
  storage.setItem('audioSettings', JSON.stringify({ notifPrivacy: 'full' }));
  const rollingLegacyWorkerTab = settingsTab(storage);
  assert.equal(rollingLegacyWorkerTab.workerMessages.at(-1).privacy, 'hidden',
    'anonymous/logout-fenced boot never restores full privacy into a rolling legacy worker');
  rollingLegacyWorkerTab.settings.authorizeNotificationPrivacySync();
  assert.equal(rollingLegacyWorkerTab.workerMessages.at(-1).privacy, 'full',
    'the chosen privacy is restored only after exact endpoint confirmation');
  rollingLegacyWorkerTab.settings.revokeNotificationPrivacySync();
  assert.equal(rollingLegacyWorkerTab.workerMessages.at(-1).privacy, 'hidden',
    'logout uses the legacy privacy message even when a worker does not understand session state');
}

// iOS install instructions are shown only in a Safari tab, never standalone/Android/other iOS browsers.
const pwaInstall = loadTsCommonJs('./pwaInstall.ts');
const iphoneSafari = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone', maxTouchPoints: 5,
};
assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall(iphoneSafari, { matchMedia: () => ({ matches: false }) }), true);
assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall({ ...iphoneSafari, standalone: true }, { matchMedia: () => ({ matches: false }) }), false);
assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall(iphoneSafari, { matchMedia: () => ({ matches: true }) }), false,
  'display-mode standalone must never be covered by the Safari-tab install card');
assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall({ ...iphoneSafari, userAgent: iphoneSafari.userAgent.replace('Version/18.0', 'CriOS/130.0') }, { matchMedia: () => ({ matches: false }) }), false);
const ipadDesktopSafari = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  platform: 'MacIntel', maxTouchPoints: 5,
};
assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall(ipadDesktopSafari, { matchMedia: () => ({ matches: false }) }), true,
  'iPad Safari desktop mode still needs the install instructions');
for (const embeddedToken of ['[FBAN/FBIOS;FBAV/500.0]', 'Instagram 350.0.0']) {
  assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall({
    ...iphoneSafari, userAgent: iphoneSafari.userAgent + ' ' + embeddedToken,
  }, { matchMedia: () => ({ matches: false }) }), false,
  `${embeddedToken} in-app webview must not receive unusable Safari instructions`);
}
assert.equal(pwaInstall.iosSafariNeedsHomeScreenInstall({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130 Safari/537.36' }, { matchMedia: () => ({ matches: false }) }), false);

// Page-side destination storage preserves late correlation but has a hard count and exact deletion.
const sessionStorage = new MemoryStorage();
const workerMessages = [];
const pageWindow = {
  setTimeout,
  clearTimeout,
  dispatchEvent() {},
};
const notificationDestination = loadTsCommonJs('./notificationDestination.ts', {
  globals: {
    sessionStorage,
    window: pageWindow,
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({ active: { postMessage(message) { workerMessages.push(message); } } }),
      },
    },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  },
});
for (let index = 0; index < 70; index++) {
  notificationDestination.rememberNotificationDestination(`msg:server-${index}:correlation`, { serverId: `server-${index}` });
}
const tagKeys = [...sessionStorage.values.keys()].filter((key) => key.startsWith('relay.notification.destination.tag.v1:'));
assert.equal(tagKeys.length, 64, 'page destination state must stay bounded');
assert.equal(notificationDestination.resolveNotificationDestination('msg:server-69:correlation')?.serverId, 'server-69',
  'same-millisecond pruning must retain the newest page correlation');
notificationDestination.rememberNotificationDestination('msg:server-correlation:nonce', { serverId: 'server-correlation', messageId: 42 });
notificationDestination.rememberNotificationDestination('msg:server-correlation:nonce', { serverId: 'server-correlation' });
assert.deepEqual(plain(notificationDestination.resolveNotificationDestination('msg:server-correlation:nonce')), {
  serverId: 'server-correlation', messageId: 42,
}, 'a late server-only banner must not erase the exact message id');
assert.equal(notificationDestination.forgetNotificationDestination('msg:server-correlation:nonce'), true);
assert.equal(notificationDestination.resolveNotificationDestination('msg:server-correlation:nonce')?.messageId, undefined);
notificationDestination.queueNotificationDestination({ serverId: 'queued', messageId: 7 });
assert.deepEqual(plain(notificationDestination.peekNotificationDestination('queued')), { serverId: 'queued', messageId: 7 });

// A broken install can leave serviceWorker.ready pending forever. Thousands of destination updates
// must share one waiter and retain only a bounded tail until controllerchange supplies a worker.
const stalledSessionStorage = new MemoryStorage();
let readyReads = 0;
let stalledController = null;
const controllerListeners = new Set();
const stalledMessages = [];
const neverReady = new Promise(() => {});
const stalledServiceWorker = {
  get controller() { return stalledController; },
  get ready() { readyReads++; return neverReady; },
  addEventListener(type, listener) { if (type === 'controllerchange') controllerListeners.add(listener); },
};
const stalledDestination = loadTsCommonJs('./notificationDestination.ts', {
  globals: {
    sessionStorage: stalledSessionStorage,
    window: pageWindow,
    navigator: { serviceWorker: stalledServiceWorker },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  },
});
for (let index = 0; index < 2_000; index++) {
  stalledDestination.rememberNotificationDestination(`msg:stalled-${index}:correlation`, { serverId: `stalled-${index}` });
}
assert.equal(readyReads, 1, 'a never-settling serviceWorker.ready is observed exactly once');
stalledController = { postMessage(message) { stalledMessages.push(message); } };
controllerListeners.forEach((listener) => listener());
assert.equal(stalledMessages.length, 64, 'controller recovery flushes only the bounded latest destination tail');
assert.equal(stalledMessages.at(-1).tag, 'msg:stalled-1999:correlation');

const notificationBanners = loadTsCommonJs('./notificationBanners.ts', {
  globals: { setTimeout, clearTimeout },
});
let closedBanners = 0;
await notificationBanners.closeShownPushNotifications(50, {
  async getRegistration() {
    return { async getNotifications() { return [
      { close() { closedBanners++; } },
      { close() { throw new Error('already gone'); } },
      { close() { closedBanners++; } },
    ]; } };
  },
});
assert.equal(closedBanners, 2, 'visible boot/logout closes every reachable banner despite one stale entry');
const bannerDeadlineStarted = Date.now();
await notificationBanners.closeShownPushNotifications(5, { getRegistration: () => new Promise(() => {}) });
assert.ok(Date.now() - bannerDeadlineStarted < 100,
  'a stalled ServiceWorker registration cannot hold visible boot or explicit logout');
assert.match(mainSource, /closeVisiblePushBanners\(\);/,
  'already-visible boot closes old OS banners without waiting for a visibility transition');
assert.match(storeSource, /const closePushBanners = closeShownPushNotifications\(\)[\s\S]*const stopNativeCapture =[\s\S]*await Promise\.all\(\[closePushBanners, stopNativeCapture\]\);[\s\S]*location\.reload\(\)/,
  'explicit logout closes account banners and native capture before reloading the page');
assert.match(storeSource, /const hideFuturePush = setPushNotificationSessionActive\(false\)[\s\S]*await Promise\.race\(\[hideFuturePush,[\s\S]*unsubscribePush\(logoutUserId\)/,
  'explicit logout persists a fail-closed worker floor before offline endpoint cleanup');
assert.match(storeSource, /preparePushLogout\(logoutUserId\);[\s\S]*await api\.beginLogout\(\);[\s\S]*setPushNotificationSessionActive\(false\)/,
  'the cross-tab logout fence is durable before an older subscription can reactivate the worker');

// Push subscription must compare VAPID keys, rotate safely, confirm backend, and scope cleanup.
const localStorage = new MemoryStorage();
const pushCleanup = loadTsCommonJs('./pushCleanup.ts', { globals: { localStorage } });
function vapid(seed) {
  return Buffer.from(Uint8Array.from({ length: 65 }, (_, index) => (seed + index) & 255)).toString('base64url');
}
function keyBytes(key) { return Uint8Array.from(Buffer.from(key, 'base64url')); }
function fakeSubscription(endpoint, key, onUnsubscribe = () => {}) {
  const raw = keyBytes(key);
  return {
    endpoint,
    options: { applicationServerKey: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) },
    toJSON() { return { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }; },
    async unsubscribe() { onUnsubscribe(endpoint); return true; },
  };
}
function pushFixture({
  key, subscription, vapidFailureOnce = false, subscribeFailure = false,
  cleanupModule = pushCleanup, storage = localStorage,
  cleanupResponse = { ok: true, removed: true, safeToUnsubscribe: true },
  lockManager, settingsProvider, subscribeGate, subscribeResponse,
  sessionActiveAck = true, sessionActiveAckGate, sessionAckTimeoutImmediately = false,
} = {}) {
  let current = subscription || null;
  let vapidCalls = 0;
  const persisted = [];
  const persistedPrefs = [];
  const backendCleanups = [];
  const localUnsubscribes = [];
  const sessionStates = [];
  const privacySyncStates = [];
  let authRevision = 1;
  let logoutFenced = false;
  class FixtureMessageChannel {
    constructor() {
      const port1 = { onmessage: null, start() {}, close() {} };
      const port2 = {
        close() {},
        postMessage(value) { Promise.resolve().then(() => port1.onmessage?.({ data: value })); },
      };
      this.port1 = port1;
      this.port2 = port2;
    }
  }
  const workerController = {
    postMessage(message, ports) {
      if (message?.type !== 'set-notification-session-active') return;
      sessionStates.push(message.active === true);
      const acknowledge = () => ports?.[0]?.postMessage({
        ok: message.active === true ? sessionActiveAck : true,
      });
      if (message.active === true && sessionActiveAck === null) return;
      if (message.active === true && sessionActiveAckGate) void sessionActiveAckGate.promise.then(acknowledge);
      else acknowledge();
    },
  };
  const registration = {
    active: workerController,
    pushManager: {
      async getSubscription() { return current; },
      async subscribe(options) {
        const bytes = new Uint8Array(options.applicationServerKey);
        const createdKey = Buffer.from(bytes).toString('base64url');
        current = fakeSubscription('https://push.example/new-' + persisted.length, createdKey, (endpoint) => localUnsubscribes.push(endpoint));
        return current;
      },
    },
  };
  const api = {
    async pushVapid() {
      vapidCalls += 1;
      if (vapidFailureOnce && vapidCalls === 1) throw new Error('offline');
      return { enabled: true, key };
    },
    async pushSubscribe(value, prefs) {
      if (subscribeFailure) throw new Error('backend offline');
      persisted.push(value);
      persistedPrefs.push(prefs);
      if (subscribeGate) await subscribeGate.promise;
      return subscribeResponse || {
        ok: true,
        userId: cleanupModule.readPushBinding()?.userId,
        endpoint: value.endpoint,
      };
    },
    async pushUnsubscribe(endpoint) { backendCleanups.push(endpoint); return cleanupResponse; },
  };
  const window = {
    PushManager: class PushManager {},
    setTimeout(callback, delay) {
      return setTimeout(callback, sessionAckTimeoutImmediately && delay === 1_500 ? 0 : delay);
    },
    clearTimeout,
  };
  const navigator = { serviceWorker: { controller: workerController, ready: Promise.resolve(registration) }, ...(lockManager ? { locks: lockManager } : {}) };
  const Notification = { permission: 'granted' };
  const push = loadTsCommonJs('./push.ts', {
    requireMap: {
      './native': { isTauri: false }, './api': { api },
      './authSession': {
        authSessionRevision: () => authRevision,
        persistentResumeSuppressed: () => logoutFenced,
      },
      './settings': {
        getNotificationPushPrefs: settingsProvider || (() => ({ notifMention: true, notifStream: true, notifPrivacy: 'full' })),
        authorizeNotificationPrivacySync() { privacySyncStates.push('authorized'); },
        revokeNotificationPrivacySync() { privacySyncStates.push('hidden'); },
      },
      './pushCleanup': cleanupModule,
    },
    globals: { localStorage: storage, window, navigator, Notification, AbortController, MessageChannel: FixtureMessageChannel },
  });
  return {
    push, api, registration, persisted, persistedPrefs, backendCleanups, localUnsubscribes,
    sessionStates, privacySyncStates,
    fenceLogout() { logoutFenced = true; authRevision += 1; },
    get current() { return current; }, get vapidCalls() { return vapidCalls; },
  };
}

localStorage.clear();
const keyOne = vapid(1);
const firstSub = fakeSubscription('https://push.example/existing', keyOne);
pushCleanup.rememberPushBinding('alice', firstSub.endpoint, keyOne);
const acquiredPushLocks = [];
const sameKey = pushFixture({
  key: keyOne,
  subscription: firstSub,
  lockManager: {
    async request(name, options, operation) {
      acquiredPushLocks.push({ name, mode: options.mode, hasSignal: !!options.signal });
      return operation({ name });
    },
  },
});
assert.deepEqual(plain(await sameKey.push.ensurePushSubscribed('alice')), {
  endpoint: 'https://push.example/existing', rotated: false,
});
assert.equal(sameKey.persisted.length, 1, 'UI success requires backend persistence');
assert.deepEqual(plain(sameKey.persistedPrefs[0]), { mention: true, stream: true, privacy: 'full' },
  'the backend receives privacy together with the exact subscription endpoint');
assert.deepEqual(sameKey.sessionStates, [true],
  'the worker session floor clears only after exact backend subscription persistence');
assert.deepEqual(sameKey.privacySyncStates, ['authorized']);

const rejectedSessionAckStorage = new MemoryStorage();
const rejectedSessionAckCleanup = loadTsCommonJs('./pushCleanup.ts', {
  globals: { localStorage: rejectedSessionAckStorage },
});
const rejectedSessionAck = pushFixture({
  key: keyOne,
  subscription: fakeSubscription('https://push.example/rejected-session-ack', keyOne),
  cleanupModule: rejectedSessionAckCleanup,
  storage: rejectedSessionAckStorage,
  sessionActiveAck: false,
});
await assert.rejects(rejectedSessionAck.push.ensurePushSubscribed('alice'), (error) => (
  error?.code === 'PUSH_SUBSCRIBE_FAILED'
));
assert.equal(rejectedSessionAck.privacySyncStates.includes('authorized'), false,
  'privacy remains hidden when the current worker cannot durably acknowledge active session state');
assert.deepEqual(rejectedSessionAck.sessionStates, [true, false],
  'an activation ACK failure is immediately repaired with an inactive worker floor');

const rollingLegacyStorage = new MemoryStorage();
const rollingLegacyCleanup = loadTsCommonJs('./pushCleanup.ts', {
  globals: { localStorage: rollingLegacyStorage },
});
const rollingLegacyEndpoint = 'https://push.example/rolling-legacy';
rollingLegacyCleanup.rememberPushBinding('alice', rollingLegacyEndpoint, keyOne);
let rollingLegacyLocalUnsubscribe = 0;
const rollingLegacyActivation = pushFixture({
  key: keyOne,
  subscription: fakeSubscription(rollingLegacyEndpoint, keyOne, () => { rollingLegacyLocalUnsubscribe += 1; }),
  cleanupModule: rollingLegacyCleanup,
  storage: rollingLegacyStorage,
  sessionActiveAck: null,
  sessionAckTimeoutImmediately: true,
});
assert.deepEqual(plain(await rollingLegacyActivation.push.ensurePushSubscribed('alice')), {
  endpoint: rollingLegacyEndpoint, rotated: false,
});
assert.equal(rollingLegacyLocalUnsubscribe, 0,
  'a rolling worker without the new ACK protocol keeps its live local subscription');
assert.deepEqual(rollingLegacyActivation.backendCleanups, [],
  'a rolling worker timeout cannot delete the backend endpoint during first rollout');
assert.deepEqual(rollingLegacyActivation.privacySyncStates, ['authorized'],
  'server-confirmed privacy remains available through the legacy worker protocol');

const deferredSessionAckGate = deferred();
const deferredSessionAckStorage = new MemoryStorage();
const deferredSessionAckCleanup = loadTsCommonJs('./pushCleanup.ts', {
  globals: { localStorage: deferredSessionAckStorage },
});
const logoutDuringSessionAck = pushFixture({
  key: keyOne,
  subscription: fakeSubscription('https://push.example/logout-during-session-ack', keyOne),
  cleanupModule: deferredSessionAckCleanup,
  storage: deferredSessionAckStorage,
  sessionActiveAckGate: deferredSessionAckGate,
});
const activationDuringLogout = logoutDuringSessionAck.push.ensurePushSubscribed('alice');
for (let spin = 0; spin < 20 && !logoutDuringSessionAck.sessionStates.includes(true); spin++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
logoutDuringSessionAck.fenceLogout();
deferredSessionAckGate.resolve();
await assert.rejects(activationDuringLogout);
assert.equal(logoutDuringSessionAck.privacySyncStates.includes('authorized'), false,
  'a logout that lands during the worker ACK cannot briefly re-authorize full legacy privacy');
assert.equal(logoutDuringSessionAck.sessionStates.at(-1), false);

const maintenancePrefsStorage = new MemoryStorage();
maintenancePrefsStorage.setItem('audioSettings', JSON.stringify({
  notifPrivacy: 'full', notifMention: true, notifStream: true,
}));
const maintenancePrefsTab = settingsTab(maintenancePrefsStorage);
maintenancePrefsStorage.setItem('audioSettings', JSON.stringify({
  notifPrivacy: 'hidden', notifMention: false, notifStream: true,
}));
const maintenanceCleanupStorage = new MemoryStorage();
const maintenanceCleanup = loadTsCommonJs('./pushCleanup.ts', {
  globals: { localStorage: maintenanceCleanupStorage },
});
const maintenancePrefs = pushFixture({
  key: keyOne,
  subscription: fakeSubscription('https://push.example/prefs', keyOne),
  settingsProvider: () => maintenancePrefsTab.settings.getNotificationPushPrefs(),
  cleanupModule: maintenanceCleanup,
  storage: maintenanceCleanupStorage,
});
await maintenancePrefs.push.ensurePushSubscribed('alice');
assert.deepEqual(plain(maintenancePrefs.persistedPrefs[0]), {
  mention: false, stream: true, privacy: 'hidden',
}, 'maintenance cannot re-enable a preference already disabled by another tab');

const logoutRaceGate = deferred();
const logoutRaceStorage = new MemoryStorage();
const logoutRaceCleanup = loadTsCommonJs('./pushCleanup.ts', { globals: { localStorage: logoutRaceStorage } });
const logoutRace = pushFixture({
  key: keyOne,
  subscription: fakeSubscription('https://push.example/logout-race', keyOne),
  cleanupModule: logoutRaceCleanup,
  storage: logoutRaceStorage,
  subscribeGate: logoutRaceGate,
});
const olderEnsure = logoutRace.push.ensurePushSubscribed('alice');
for (let spin = 0; spin < 8 && logoutRace.persisted.length < 1; spin++) await Promise.resolve();
const queuedLogout = logoutRace.push.unsubscribePush('alice');
for (let spin = 0; spin < 8 && logoutRace.sessionStates.length < 1; spin++) await Promise.resolve();
logoutRaceGate.resolve();
await olderEnsure;
await queuedLogout;
assert.deepEqual(logoutRace.sessionStates, [false, true, false],
  'serialized logout restores inactive after every older ensure continuation');
assert.equal(logoutRace.privacySyncStates.at(-1), 'hidden',
  'the rolling legacy worker fallback is also restored after the serialized logout tail');

const crossTabSubscribeGate = deferred();
const crossTabSubscribeStorage = new MemoryStorage();
const crossTabSubscribeCleanupA = loadTsCommonJs('./pushCleanup.ts', {
  globals: { localStorage: crossTabSubscribeStorage },
});
const crossTabSubscribeCleanupB = loadTsCommonJs('./pushCleanup.ts', {
  globals: { localStorage: crossTabSubscribeStorage },
});
const crossTabSubscribe = pushFixture({
  key: keyOne,
  cleanupModule: crossTabSubscribeCleanupA,
  storage: crossTabSubscribeStorage,
  subscribeGate: crossTabSubscribeGate,
});
const crossTabEnsure = crossTabSubscribe.push.ensurePushSubscribed('alice');
for (let spin = 0; spin < 20 && crossTabSubscribe.persisted.length < 1; spin++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(crossTabSubscribe.persisted.length, 1, 'the deferred backend subscribe request started');
const provisionalEndpoint = crossTabSubscribe.persisted[0]?.endpoint;
assert.equal(crossTabSubscribeCleanupB.readPushBinding()?.endpoint, provisionalEndpoint,
  'another tab can capture the exact provisional endpoint while subscribe is in flight');
crossTabSubscribeCleanupB.preparePushLogout('alice');
const capturedInflightPushCleanups = plain(crossTabSubscribeCleanupB.pendingPushCleanups()
  .map(({ userId, endpoint }) => ({ userId, endpoint })));
assert.deepEqual(capturedInflightPushCleanups, [{ userId: 'alice', endpoint: provisionalEndpoint }],
  'cross-tab logout includes the in-flight endpoint in its atomic server revocation body');
await crossTabSubscribe.push.setPushNotificationSessionActive(false);
crossTabSubscribe.fenceLogout();
crossTabSubscribeGate.resolve();
await assert.rejects(crossTabEnsure);
assert.equal(crossTabSubscribe.sessionStates.includes(true), false,
  'a late subscribe response cannot reactivate the logged-out worker or expose queued account push');
assert.equal(crossTabSubscribe.sessionStates.at(-1), false);

const accountSwitchStorage = new MemoryStorage();
const accountSwitchCleanup = loadTsCommonJs('./pushCleanup.ts', { globals: { localStorage: accountSwitchStorage } });
accountSwitchCleanup.rememberPushBinding('alice', 'https://push.example/alice-old', keyOne);
let removedAliceEndpoint = 0;
const accountSwitch = pushFixture({
  key: keyOne,
  subscription: fakeSubscription('https://push.example/alice-old', keyOne, () => { removedAliceEndpoint += 1; }),
  cleanupModule: accountSwitchCleanup,
  storage: accountSwitchStorage,
});
const bobState = await accountSwitch.push.ensurePushSubscribed('bob');
assert.equal(removedAliceEndpoint, 1, 'a proven old-account local endpoint is removed before account rebind');
assert.notEqual(bobState.endpoint, 'https://push.example/alice-old');
assert.equal(accountSwitchCleanup.readPushBinding().userId, 'bob');
assert.deepEqual(accountSwitch.sessionStates, [true],
  'the new account activates notifications only after rotating and persisting its fresh endpoint');
assert.deepEqual(acquiredPushLocks, [{ name: 'relay.push.mutation.v1', mode: 'exclusive', hasSignal: true }],
  'origin-wide subscription mutations are serialized across browser tabs');
assert.equal(pushCleanup.readPushBinding().userId, 'alice');

const keyTwo = vapid(20);
let rotatedOld = false;
const oldSub = fakeSubscription('https://push.example/existing', keyOne, () => { rotatedOld = true; });
const rotated = pushFixture({ key: keyTwo, subscription: oldSub });
const rotatedState = await rotated.push.ensurePushSubscribed('alice');
assert.equal(rotatedState.rotated, true);
assert.equal(rotatedOld, true, 'VAPID rotation must unsubscribe the old local endpoint');
assert.equal(rotated.persisted.length, 1);
assert.deepEqual(rotated.backendCleanups, ['https://push.example/existing'],
  'VAPID rotation must remove the old backend endpoint in the same bounded flow');
assert.equal(pushCleanup.readPushBinding().vapidKey, keyTwo);

const transient = pushFixture({ key: keyTwo, subscription: rotated.current, vapidFailureOnce: true });
await assert.rejects(transient.push.ensurePushSubscribed('alice'));
await transient.push.ensurePushSubscribed('alice');
assert.equal(transient.vapidCalls, 2, 'a transient VAPID failure must not be cached for the next retry');

localStorage.clear();
pushCleanup.clearPushBinding();
const rejected = pushFixture({ key: keyOne, subscription: firstSub, subscribeFailure: true });
await assert.rejects(rejected.push.ensurePushSubscribed('alice'));
assert.equal(pushCleanup.readPushBinding(), null, 'failed backend persistence cannot mark notifications enabled/bound');
assert.deepEqual(rejected.backendCleanups, ['https://push.example/existing', 'https://push.example/new-0'],
  'unknown legacy ownership rotates once and a response-lost replacement is also rolled back');

localStorage.clear();
pushCleanup.clearPushBinding();
pushCleanup.rememberPushBinding('alice', 'https://push.example/alice', keyOne);
let foreignLocalUnsubscribe = 0;
const foreignSub = fakeSubscription('https://push.example/alice', keyOne, () => { foreignLocalUnsubscribe += 1; });
const foreign = pushFixture({ key: keyOne, subscription: foreignSub });
assert.equal(await foreign.push.unsubscribePush('bob'), true);
assert.equal(foreignLocalUnsubscribe, 0, 'one account cannot remove another account\'s proven local binding');
assert.equal(foreign.backendCleanups.length, 0, 'one account cannot send another account\'s cleanup endpoint');

localStorage.clear();
pushCleanup.clearPushBinding();
pushCleanup.rememberPushBinding('alice', 'https://push.example/stale-owner', keyOne);
let staleOwnerLocalUnsubscribe = 0;
const staleOwnerSub = fakeSubscription('https://push.example/stale-owner', keyOne, () => { staleOwnerLocalUnsubscribe += 1; });
const staleOwner = pushFixture({
  key: keyOne,
  subscription: staleOwnerSub,
  cleanupResponse: { ok: true, removed: false, safeToUnsubscribe: false },
});
assert.equal(await staleOwner.push.unsubscribePush('alice'), true);
assert.equal(staleOwnerLocalUnsubscribe, 0,
  'a stale local binding cannot unsubscribe an endpoint now owned by another backend account');
assert.equal(pushCleanup.readPushBinding(), null,
  'the stale ownership claim is removed after the backend identifies another owner');

localStorage.clear();
pushCleanup.clearPushBinding();
pushCleanup.rememberPushBinding('alice', 'https://push.example/alice', keyOne);
pushCleanup.preparePushLogout('alice');
assert.equal(pushCleanup.pendingPushCleanups().some((record) => record.userId === 'alice'), true,
  'logout captures an account-scoped endpoint synchronously');
pushCleanup.queuePushCleanup('alice', 'https://push.example/second');
pushCleanup.clearPushCleanups('alice', ['https://push.example/alice']);
assert.deepEqual(plain(pushCleanup.pendingPushCleanups().map(({ userId, endpoint }) => ({ userId, endpoint }))), [
  { userId: 'alice', endpoint: 'https://push.example/second' },
], 'a partial server acknowledgement must retain every unacknowledged durable endpoint');

localStorage.clear();
pushCleanup.clearPushBinding();
for (const { userId, endpoint } of pushCleanup.pendingPushCleanups()) {
  pushCleanup.clearPushCleanups(userId, [endpoint]);
}
let migratedLocalUnsubscribe = 0;
const migratedSub = fakeSubscription('https://push.example/migrated', keyOne, () => { migratedLocalUnsubscribe += 1; });
const migrated = pushFixture({ key: keyOne, subscription: migratedSub });
assert.equal(await migrated.push.unsubscribePush('alice'), true);
assert.equal(migratedLocalUnsubscribe, 1,
  'a pre-metadata local subscription is removed only after backend ownership confirmation');

const throwingStorage = {
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('storage unavailable'); },
  removeItem() { throw new Error('storage unavailable'); },
};
const memoryCleanup = loadTsCommonJs('./pushCleanup.ts', { globals: { localStorage: throwingStorage } });
let lockedStorageLocalUnsubscribe = 0;
const lockedStorageSub = fakeSubscription('https://push.example/locked-storage', keyOne, () => { lockedStorageLocalUnsubscribe += 1; });
const lockedStorage = pushFixture({
  key: keyOne, subscription: lockedStorageSub, cleanupModule: memoryCleanup, storage: throwingStorage,
});
assert.equal(await lockedStorage.push.unsubscribePush('alice'), true);
assert.deepEqual(lockedStorage.backendCleanups, ['https://push.example/locked-storage'],
  'an unavailable localStorage must fall back to direct authenticated endpoint cleanup');
assert.equal(lockedStorageLocalUnsubscribe, 1,
  'the local subscription is removed after backend confirms ownership under storage failure');
assert.equal(memoryCleanup.rememberPushBinding('alice', 'https://push.example/locked-storage', keyOne), true);
memoryCleanup.preparePushLogout('alice');
assert.equal(memoryCleanup.pendingPushCleanups().length, 1,
  'the exact endpoint remains available in memory for the logout transaction when storage throws');

const writeBlockedStorage = {
  getItem() { return null; },
  setItem() { throw new Error('write unavailable'); },
  removeItem() { throw new Error('write unavailable'); },
};
const dirtyMemoryCleanup = loadTsCommonJs('./pushCleanup.ts', { globals: { localStorage: writeBlockedStorage } });
assert.equal(dirtyMemoryCleanup.rememberPushBinding('alice', 'https://push.example/write-blocked', keyOne), true);
assert.equal(dirtyMemoryCleanup.readPushBinding()?.endpoint, 'https://push.example/write-blocked',
  'a readable but unwritable storage area cannot overwrite the exact in-memory binding');
dirtyMemoryCleanup.queuePushCleanup('alice', 'https://push.example/write-blocked');
assert.equal(dirtyMemoryCleanup.pendingPushCleanups().length, 1,
  'a failed durable queue write remains available to the same-page logout transaction');
dirtyMemoryCleanup.clearPushCleanups('alice', ['https://push.example/write-blocked']);
assert.equal(dirtyMemoryCleanup.pendingPushCleanups().length, 0,
  'a backend acknowledgement cannot be resurrected from stale readable storage after remove fails');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function notificationFixture({ storage = new MemoryStorage(), ensure, now = () => Date.now() } = {}) {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const settings = { notif: false };
  const settingWrites = [];
  let ensureCalls = 0;
  const addListener = (type, listener) => {
    const values = listeners.get(type) || new Set();
    values.add(listener);
    listeners.set(type, values);
  };
  const window = {
    Notification: {}, addEventListener: addListener,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, dueAt: now() + Number(delay || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const document = {
    visibilityState: 'visible',
    addEventListener: addListener,
    hasFocus: () => false,
  };
  const navigator = { serviceWorker: { addEventListener: addListener } };
  const Notification = { permission: 'granted', async requestPermission() { return 'granted'; } };
  class FixtureDate extends Date { static now() { return now(); } }
  const notify = loadTsCommonJs('./notify.ts', {
    requireMap: {
      './native': { isTauri: false, foregroundFullscreen: async () => false },
      './settings': {
        NOTIFICATION_PUSH_PREFS_CHANGED_EVENT: 'relay-notification-push-prefs-changed',
        getSettings: () => settings,
        getNotificationPushPrefs: () => ({
          notifPrivacy: settings.notifPrivacy || 'full',
          notifMention: settings.notifMention !== false,
          notifStream: settings.notifStream !== false,
        }),
        setSettings(patch) { Object.assign(settings, patch); settingWrites.push({ ...patch }); },
      },
      './push': {
        ensurePushSubscribed: async (userId) => { ensureCalls++; return ensure ? ensure(userId, ensureCalls) : {}; },
        pushSetupErrorMessage: () => 'push failed',
        pushSupported: () => true,
        unsubscribePush: async () => true,
      },
      './sounds': { playSound() {} },
      './chatVisibility': { visibleChatServer: () => '' },
      './notificationDestination': {
        notificationDestinationFromTag: () => null,
        notificationDestinationUrl: () => '/',
        queueNotificationDestination: () => null,
        rememberNotificationDestination: () => null,
        resolveNotificationDestination: () => null,
      },
    },
    globals: { localStorage: storage, window, document, navigator, Notification, Date: FixtureDate, setTimeout, clearTimeout },
  });
  return {
    notify, settings, settingWrites,
    dispatch(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    runDueTimers() {
      const due = [...timers.entries()].filter(([, timer]) => timer.dueAt <= now());
      for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
    },
    get ensureCalls() { return ensureCalls; },
  };
}

{
  const frozenOptOutStorage = new MemoryStorage();
  const fixture = notificationFixture({ storage: frozenOptOutStorage });
  fixture.settings.notif = true;
  // Simulate another tab disabling notifications while this page is frozen and misses `storage`.
  frozenOptOutStorage.setItem('notifOptOut', '1');
  assert.equal(await fixture.notify.notify('mention', {
    title: 'Must stay hidden', body: 'Must stay silent', tag: 'mention:frozen:1',
  }), false);
  assert.equal(fixture.settings.notif, false,
    'point-of-use durable opt-out suppresses queued realtime work before pageshow reconciliation');
}

{
  const stickyOptOutStorage = new MemoryStorage();
  stickyOptOutStorage.setItem('notifOptOut', '1');
  stickyOptOutStorage.removeItem = () => { throw new Error('storage remove rejected'); };
  const fixture = notificationFixture({ storage: stickyOptOutStorage });
  fixture.settings.notif = true;
  fixture.notify.setNotificationOptOut(false);
  assert.equal(fixture.notify.notificationOptedOut(), true,
    'a failed less-restrictive enable cannot overrule a durable cross-tab opt-out');
  assert.equal(await fixture.notify.notify('mention', {
    title: 'Must remain hidden', body: 'Must remain silent', tag: 'mention:sticky:1',
  }), false);
}

// A successful long-lived browser/PWA session revalidates VAPID on its own while it remains visible;
// maintenance is not dependent on another lifecycle transition after a VAPID rotation.
{
  let clock = 10_000;
  const users = [];
  const fixture = notificationFixture({
    now: () => clock,
    ensure: (userId) => { users.push(userId); return Promise.resolve({}); },
  });
  assert.equal((await fixture.notify.initNotifications('alice')).ready, true);
  assert.equal(fixture.ensureCalls, 1);
  fixture.dispatch('visibilitychange');
  await Promise.resolve();
  assert.equal(fixture.ensureCalls, 1, 'foreground churn inside the VAPID cache window is deduplicated');
  clock += 60_001;
  fixture.runDueTimers();
  for (let spin = 0; spin < 5 && fixture.ensureCalls < 2; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 2, 'a visible long-lived session revalidates a rotated VAPID key');
  assert.deepEqual(users, ['alice', 'alice']);
  fixture.notify.setNotificationOptOut(true);
  clock += 60_001;
  fixture.runDueTimers();
  await Promise.resolve();
  assert.equal(fixture.ensureCalls, 2, 'opt-out invalidates maintenance for the exact account');
}

// A privacy/kind change updates the server row immediately instead of waiting for maintenance.
{
  let clock = 20_000;
  const users = [];
  const fixture = notificationFixture({
    now: () => clock,
    ensure: (userId) => { users.push(userId); return Promise.resolve({}); },
  });
  assert.equal((await fixture.notify.initNotifications('alice')).ready, true);
  assert.equal(fixture.ensureCalls, 1);
  fixture.dispatch('relay-notification-push-prefs-changed');
  for (let spin = 0; spin < 8 && fixture.ensureCalls < 2; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 2, 'privacy preference resync bypasses the normal maintenance cadence');
  assert.deepEqual(users, ['alice', 'alice'], 'the resync remains fenced to the exact active account');
  fixture.notify.setNotificationOptOut(true);
}

// A second settings change while the first resync is in flight must not be acknowledged by the
// stale request or delayed until the one-minute maintenance pass.
{
  let clock = 30_000;
  const pending = deferred();
  const users = [];
  const fixture = notificationFixture({
    now: () => clock,
    ensure: (userId, call) => {
      users.push(userId);
      return call === 2 ? pending.promise : Promise.resolve({});
    },
  });
  assert.equal((await fixture.notify.initNotifications('alice')).ready, true);
  fixture.dispatch('relay-notification-push-prefs-changed');
  assert.equal(fixture.ensureCalls, 2);
  fixture.dispatch('relay-notification-push-prefs-changed');
  pending.resolve({});
  for (let spin = 0; spin < 12 && fixture.ensureCalls < 3; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 3,
    'a preference generation changed during persistence is immediately sent in a fresh request');
  assert.deepEqual(users, ['alice', 'alice', 'alice']);
  fixture.notify.setNotificationOptOut(true);
}

// A staged current worker can take control while a rolling legacy maintenance request is waiting
// for its no-ACK timeout. That stale success must not defer durable current-worker activation.
{
  let clock = 35_000;
  const legacyRun = deferred();
  const fixture = notificationFixture({
    now: () => clock,
    ensure: (_userId, call) => call === 2 ? legacyRun.promise : Promise.resolve({}),
  });
  assert.equal((await fixture.notify.initNotifications('alice')).ready, true);
  clock += 60_001;
  fixture.runDueTimers();
  for (let spin = 0; spin < 8 && fixture.ensureCalls < 2; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 2);
  fixture.dispatch('controllerchange');
  legacyRun.resolve({});
  for (let spin = 0; spin < 12 && fixture.ensureCalls < 3; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 3,
    'controller replacement invalidates an in-flight legacy success and reconfirms immediately');
  fixture.notify.setNotificationOptOut(true);
}

for (const initialFlow of ['init', 'enable']) {
  let clock = 40_000;
  const pending = deferred();
  const fixture = notificationFixture({
    now: () => clock,
    ensure: (_userId, call) => call === 1 ? pending.promise : Promise.resolve({}),
  });
  const operation = initialFlow === 'init'
    ? fixture.notify.initNotifications('alice')
    : fixture.notify.enableNotifications('alice');
  for (let spin = 0; spin < 8 && fixture.ensureCalls < 1; spin++) await Promise.resolve();
  fixture.dispatch('relay-notification-push-prefs-changed');
  pending.resolve({});
  await operation;
  for (let spin = 0; spin < 8 && fixture.ensureCalls < 2; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 2,
    `${initialFlow} cannot confirm a subscription request from an older preference generation`);
  fixture.notify.setNotificationOptOut(true);
}

// A transient startup failure while already online and visible retries without requiring the user
// to hide/reopen the app or toggle the network.
{
  let clock = 50_000;
  const fixture = notificationFixture({
    now: () => clock,
    ensure: (_userId, call) => call === 1 ? Promise.reject(new Error('temporary 503')) : Promise.resolve({}),
  });
  assert.equal((await fixture.notify.initNotifications('alice')).ready, false);
  assert.equal(fixture.ensureCalls, 1);
  clock += 3_001;
  fixture.runDueTimers();
  for (let spin = 0; spin < 8; spin++) await Promise.resolve();
  assert.equal(fixture.ensureCalls, 2, 'startup push recovery owns a scheduled retry');
  assert.equal(fixture.settings.notif, true, 'the successful retry restores notification state');
  fixture.notify.setNotificationOptOut(true);
}

// A late successful subscription cannot undo an explicit opt-out made while the browser operation
// was pending (same page or another tab).
{
  const pending = deferred();
  const fixture = notificationFixture({ ensure: () => pending.promise });
  const enabling = fixture.notify.enableNotifications('alice');
  for (let spin = 0; spin < 5 && fixture.ensureCalls === 0; spin++) await Promise.resolve();
  fixture.notify.setNotificationOptOut(true);
  pending.resolve({});
  assert.equal((await enabling).enabled, false);
  assert.equal(fixture.settings.notif, false);
  assert.equal(fixture.settingWrites.at(-1)?.notif, false,
    'same-tab opt-out remains authoritative over a late enable continuation');
}

{
  const pending = deferred();
  const fixture = notificationFixture({ ensure: () => pending.promise });
  const initializing = fixture.notify.initNotifications('alice');
  for (let spin = 0; spin < 5 && fixture.ensureCalls === 0; spin++) await Promise.resolve();
  fixture.dispatch('storage', { key: 'notifOptOut', newValue: '1' });
  pending.resolve({});
  assert.deepEqual(plain(await initializing), { welcomed: false, ready: false });
  assert.equal(fixture.settings.notif, false,
    'another tab opt-out invalidates a pending startup subscription for the exact account');
}

// Recovery listeners are long-lived; their own late promise needs the same intent fence.
{
  const recovery = deferred();
  const fixture = notificationFixture({
    ensure: (_userId, call) => call === 1 ? Promise.reject(new Error('offline')) : recovery.promise,
  });
  assert.equal((await fixture.notify.enableNotifications('alice')).enabled, false);
  fixture.dispatch('online');
  for (let spin = 0; spin < 5 && fixture.ensureCalls < 2; spin++) await Promise.resolve();
  fixture.notify.setNotificationOptOut(true);
  recovery.resolve({});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.settings.notif, false,
    'a recovery started before opt-out cannot re-enable local notifications afterward');
}

const readableUnwritableOptOutStorage = {
  getItem() { return null; },
  setItem() { throw new Error('write unavailable'); },
  removeItem() { throw new Error('write unavailable'); },
};
const dirtyOptOut = notificationFixture({ storage: readableUnwritableOptOutStorage });
dirtyOptOut.notify.setNotificationOptOut(true);
assert.equal(dirtyOptOut.notify.notificationOptedOut(), true,
  'a failed opt-out write remains authoritative in memory instead of being erased by a stale readable value');

// Worker CacheStorage state is bounded and click/close delete only the matching tag.
class WorkerRequest extends Request {
  constructor(input, init) { super(typeof input === 'string' ? new URL(input, origin) : input, init); }
}
function cacheKey(value) { return new URL(typeof value === 'string' ? value : value.url, origin).toString(); }
function cacheStorage() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      let entries = stores.get(name);
      if (!entries) stores.set(name, entries = new Map());
      return {
        async match(request) { const value = entries.get(cacheKey(request)); return value?.clone(); },
        async put(request, response) { entries.set(cacheKey(request), response.clone()); },
        async delete(request) { return entries.delete(cacheKey(request)); },
        async keys() { return [...entries.keys()].map((url) => new WorkerRequest(url)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}
async function latestVersionedStateValue(cache, pathPrefix) {
  const prefix = new URL(pathPrefix, origin).toString();
  const keys = (await cache.keys())
    .filter((request) => request.url.startsWith(prefix))
    .sort((a, b) => Number(b.url.slice(prefix.length)) - Number(a.url.slice(prefix.length)));
  for (const request of keys) {
    const response = await cache.match(request);
    if (!response) continue;
    const stored = await response.json();
    if (stored && Object.prototype.hasOwnProperty.call(stored, 'value')) return stored.value;
  }
  return undefined;
}
function workerHarness({
  workerCaches = cacheStorage(), workerSetTimeout = setTimeout, workerClearTimeout = clearTimeout,
  workerWindowClients, workerMatchAll, workerOpenWindow, workerDate = Date,
} = {}) {
  const source = readSource('../public/sw.js');
  const listeners = new Map();
  const caches = workerCaches;
  const clientMessages = [];
  const notifications = [];
  class WorkerMessageChannel {
    constructor() {
      const port1 = { onmessage: null, start() {}, close() {} };
      const port2 = {
        close() {},
        postMessage(value) { Promise.resolve().then(() => port1.onmessage?.({ data: value })); },
      };
      this.port1 = port1;
      this.port2 = port2;
    }
  }
  const client = {
    postMessage(value, ports) { clientMessages.push(value); ports?.[0]?.postMessage({ ok: true }); },
    async focus() { return this; },
  };
  const self = {
    location: { origin },
    clients: {
      async matchAll() { return workerMatchAll ? workerMatchAll() : (workerWindowClients || [client]); },
      async openWindow(url) { return workerOpenWindow?.(url); },
      async claim() {},
    },
    registration: { async showNotification(title, options) { notifications.push({ title, options }); } },
    async skipWaiting() {},
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  const context = vm.createContext({
    self, caches, URL, URLSearchParams, Request: WorkerRequest, Response, Headers,
    Set, Map, Promise, Error, Date: workerDate, MessageChannel: WorkerMessageChannel,
    console, setTimeout: workerSetTimeout, clearTimeout: workerClearTimeout,
    importScripts() { self.__RELAY_PRECACHE = { version: 'test', urls: [] }; },
    fetch: async () => new Response('ok'),
  });
  vm.runInContext(source, context, { filename: 'sw.js' });
  async function dispatch(type, extra) {
    let pending;
    listeners.get(type)({ ...extra, waitUntil(value) { pending = Promise.resolve(value); } });
    if (pending) await pending;
  }
  return { caches, clientMessages, notifications, dispatch };
}

const worker = workerHarness();
for (let index = 0; index < 70; index++) {
  await worker.dispatch('message', { data: {
    type: 'remember-notification-destination', tag: `msg:s${index}:n`, destination: { serverId: `s${index}` },
  } });
}
const stateCache = await worker.caches.open('relay-notification-state-v1');
let destinationKeys = (await stateCache.keys()).filter((request) => request.url.includes('/destination/'));
assert.equal(destinationKeys.length, 64, 'worker destination cache must stay bounded');
assert.ok(await stateCache.match(origin + '/__relay-notification-state/destination/' + encodeURIComponent('msg:s69:n')),
  'same-millisecond pruning must retain the newest worker correlation');

await worker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:exact:n', destination: { serverId: 'exact', messageId: 99 },
} });
await worker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:exact:n', destination: { serverId: 'exact' },
} });
await worker.dispatch('notificationclick', {
  notification: { tag: 'msg:exact:n', data: { serverId: 'exact' }, close() {} },
});
assert.equal(worker.clientMessages.some((message) => message.type === 'open-destination' && message.messageId === 99), true,
  'worker click must retain late exact correlation before deleting its tag');
assert.equal(await stateCache.match(origin + '/__relay-notification-state/destination/' + encodeURIComponent('msg:exact:n')), undefined);

await Promise.all([
  worker.dispatch('message', { data: {
    type: 'remember-notification-destination', tag: 'msg:concurrent:n', destination: { serverId: 'concurrent', messageId: 101 },
  } }),
  worker.dispatch('message', { data: {
    type: 'remember-notification-destination', tag: 'msg:concurrent:n', destination: { serverId: 'concurrent' },
  } }),
]);
await worker.dispatch('notificationclick', {
  notification: { tag: 'msg:concurrent:n', data: { serverId: 'concurrent' }, close() {} },
});
assert.equal(worker.clientMessages.some((message) => message.type === 'open-destination' && message.messageId === 101), true,
  'concurrent server-only replacement cannot erase the exact message correlation');

const clickFallbackMessages = [];
let fallbackFocuses = 0;
let unexpectedOpen = 0;
const clickFallbackWorker = workerHarness({
  workerWindowClients: [
    { postMessage(value) { clickFallbackMessages.push(['closing', value]); }, async focus() { throw new Error('discarded'); } },
    {
      postMessage(value, ports) {
        clickFallbackMessages.push(['live', value]);
        ports?.[0]?.postMessage({ ok: true });
      },
      async focus() { fallbackFocuses += 1; return this; },
    },
  ],
  workerOpenWindow() { unexpectedOpen += 1; },
});
await clickFallbackWorker.dispatch('notificationclick', {
  notification: { tag: 'msg:fallback:n', data: { serverId: 'fallback', messageId: 102 }, close() {} },
});
assert.equal(fallbackFocuses, 1, 'a rejected focus on a discarded tab falls through to the next live client');
assert.equal(unexpectedOpen, 0);
assert.equal(clickFallbackMessages.some(([clientName, message]) => clientName === 'live'
  && message.type === 'open-destination' && message.messageId === 102), true,
'the exact notification destination is delivered to the client that was actually focused');

const neverFocused = new Promise(() => {});
let focusAfterTimeout = 0;
const focusTimeoutWorker = workerHarness({
  workerWindowClients: [
    { postMessage() {}, focus() { return neverFocused; } },
    {
      postMessage(_value, ports) { ports?.[0]?.postMessage({ ok: true }); },
      async focus() { focusAfterTimeout += 1; return this; },
    },
  ],
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await focusTimeoutWorker.dispatch('notificationclick', {
  notification: { tag: 'msg:focus-timeout:n', data: { serverId: 'focus-timeout', messageId: 104 }, close() {} },
});
assert.equal(focusAfterTimeout, 1,
  'a frozen iOS window focus is bounded and the click continues to the next usable client');

let openedFallbackUrl = '';
const openFallbackWorker = workerHarness({
  workerWindowClients: [{ postMessage() {}, async focus() { throw new Error('closing'); } }],
  workerOpenWindow(url) { openedFallbackUrl = url; },
});
await openFallbackWorker.dispatch('notificationclick', {
  notification: { tag: 'msg:open:n', data: { serverId: 'opened', messageId: 103 }, close() {} },
});
assert.equal(openedFallbackUrl, '/?server=opened&message=103',
  'when every existing tab rejects focus, the click opens the exact destination in a new window');

let openedAfterMatchTimeout = '';
const matchTimeoutWorker = workerHarness({
  workerWindowClients: new Promise(() => {}),
  workerOpenWindow(url) { openedAfterMatchTimeout = url; },
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await matchTimeoutWorker.dispatch('notificationclick', {
  notification: { tag: 'msg:match-timeout:n', data: { serverId: 'match-timeout', messageId: 105 }, close() {} },
});
assert.equal(openedAfterMatchTimeout, '/?server=match-timeout&message=105',
  'a wedged client listing falls back to a bounded exact openWindow attempt');

let stuckClientListings = 0;
const stuckClientListing = new Promise(() => {});
const sharedClientListingWorker = workerHarness({
  workerMatchAll() { stuckClientListings += 1; return stuckClientListing; },
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
for (let index = 0; index < 10; index++) {
  await sharedClientListingWorker.dispatch('push', {
    data: { json: () => ({ kind: 'mention', title: 'secret', body: 'secret', serverId: `stuck-${index}` }) },
  });
}
assert.equal(sharedClientListingWorker.notifications.length, 10,
  'a wedged client listing cannot prevent mandatory visible push notifications');
assert.equal(stuckClientListings, 1,
  'background pushes share one genuinely pending native client listing instead of retaining one each');

let coldClientNavigated = '';
let coldClientOpenedDuplicate = 0;
const coldClient = {
  postMessage() { /* main.tsx listener is not installed yet, so there is deliberately no ACK */ },
  async focus() { return this; },
  async navigate(url) { coldClientNavigated = url; return this; },
};
const coldClientWorker = workerHarness({
  workerWindowClients: [coldClient],
  workerOpenWindow() { coldClientOpenedDuplicate += 1; },
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await coldClientWorker.dispatch('notificationclick', {
  notification: { tag: 'msg:cold:n', data: { serverId: 'cold', messageId: 106 }, close() {} },
});
assert.equal(coldClientNavigated, '/?server=cold&message=106',
  'a focused uncontrolled/cold iOS page without a message listener is navigated to the exact destination');
assert.equal(coldClientOpenedDuplicate, 0, 'successful cold-client navigation does not open a duplicate tab');

await worker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:replacement:n', destination: { serverId: 'replacement', messageId: 100 },
} });
await worker.dispatch('notificationclose', {
  notification: { tag: 'msg:replacement:n', data: { serverId: 'replacement', messageId: 50 } },
});
assert.ok(await stateCache.match(origin + '/__relay-notification-state/destination/' + encodeURIComponent('msg:replacement:n')),
  'closing a replaced older banner must not erase the newer exact correlation');
await worker.dispatch('notificationclose', {
  notification: { tag: 'msg:replacement:n', data: { serverId: 'replacement', messageId: 100 } },
});
assert.equal(await stateCache.match(origin + '/__relay-notification-state/destination/' + encodeURIComponent('msg:replacement:n')), undefined);

const corruptPrivacyCaches = cacheStorage();
const corruptPrivacyCache = await corruptPrivacyCaches.open('relay-notification-state-v1');
await corruptPrivacyCache.put(origin + '/__relay-notification-state/privacy', new Response(JSON.stringify('corrupt')));
const corruptPrivacyWorker = workerHarness({ workerCaches: corruptPrivacyCaches });
await corruptPrivacyWorker.dispatch('push', {
  data: { json: () => ({ kind: 'mention', title: 'Нельзя раскрывать', body: 'Секрет', serverId: 'corrupt' }) },
});
assert.deepEqual({
  title: corruptPrivacyWorker.notifications[0].title,
  body: corruptPrivacyWorker.notifications[0].options.body,
}, { title: 'RelayApp', body: 'Новое упоминание' },
'a malformed persisted privacy value fails closed instead of exposing lock-screen content');

const privacyFloorWorker = workerHarness();
await privacyFloorWorker.dispatch('message', { data: { type: 'set-notification-session-active', active: true } });
await privacyFloorWorker.dispatch('message', { data: { type: 'set-notification-privacy', privacy: 'full' } });
await privacyFloorWorker.dispatch('push', {
  data: { json: () => ({ privacy: 'full', kind: 'mention', title: 'Алиса', body: 'Открытый текст', serverId: 'full' }) },
});
assert.deepEqual({
  title: privacyFloorWorker.notifications.at(-1).title,
  body: privacyFloorWorker.notifications.at(-1).options.body,
}, { title: 'Алиса', body: 'Открытый текст' }, 'content is visible only when both server and browser allow full privacy');
await privacyFloorWorker.dispatch('push', {
  data: { json: () => ({ kind: 'mention', title: 'Нельзя раскрывать', body: 'Секрет', serverId: 'legacy' }) },
});
assert.equal(privacyFloorWorker.notifications.at(-1).title, 'RelayApp',
  'a legacy payload without server privacy fails closed even when local state is full');
await privacyFloorWorker.dispatch('message', { data: { type: 'set-notification-privacy', privacy: 'sender' } });
await privacyFloorWorker.dispatch('push', {
  data: { json: () => ({ privacy: 'full', kind: 'mention', title: 'Алиса', body: 'Секрет', serverId: 'sender' }) },
});
assert.deepEqual({
  title: privacyFloorWorker.notifications.at(-1).title,
  body: privacyFloorWorker.notifications.at(-1).options.body,
}, { title: 'Алиса', body: '' }, 'the most restrictive browser/server privacy floor wins');
await privacyFloorWorker.dispatch('message', { data: { type: 'set-notification-privacy', privacy: 'full' } });
await privacyFloorWorker.dispatch('push', {
  data: { json: () => ({ privacy: 'hidden', kind: 'mention', title: 'Нельзя раскрывать', body: 'Секрет', serverId: 'server-hidden' }) },
});
assert.equal(privacyFloorWorker.notifications.at(-1).title, 'RelayApp',
  'server privacy remains authoritative over a less restrictive local cache');

const logoutStateCaches = cacheStorage();
const loggedInWorker = workerHarness({ workerCaches: logoutStateCaches });
await loggedInWorker.dispatch('message', { data: { type: 'set-notification-session-active', active: true } });
await loggedInWorker.dispatch('message', { data: { type: 'set-notification-privacy', privacy: 'full' } });
await loggedInWorker.dispatch('push', {
  data: { json: () => ({ privacy: 'full', kind: 'mention', title: 'Старый аккаунт', body: 'Секрет', serverId: 'logout-before' }) },
});
assert.equal(loggedInWorker.notifications.at(-1).title, 'Старый аккаунт');
await loggedInWorker.dispatch('message', { data: { type: 'set-notification-session-active', active: false } });
const restartedLoggedOutWorker = workerHarness({ workerCaches: logoutStateCaches });
await restartedLoggedOutWorker.dispatch('push', {
  data: { json: () => ({ privacy: 'full', kind: 'mention', title: 'Старый аккаунт', body: 'Секрет', serverId: 'logout-after' }) },
});
assert.deepEqual({
  title: restartedLoggedOutWorker.notifications.at(-1).title,
  body: restartedLoggedOutWorker.notifications.at(-1).options.body,
}, { title: 'RelayApp', body: 'Новое упоминание' },
'a queued old-account push remains generic after offline logout and worker restart');
assert.deepEqual(plain(restartedLoggedOutWorker.notifications.at(-1).options.data), {
  serverId: '', url: '/',
}, 'a logged-out banner cannot retain or deep-link an old account destination');
const logoutStateCache = await logoutStateCaches.open('relay-notification-state-v1');
assert.equal((await logoutStateCache.keys()).filter((request) => request.url.includes('/destination/')).length, 1,
  'the inactive push adds no second old-account destination correlation');

const never = new Promise(() => {});
let storageBlockedOpenCalls = 0;
const storageBlockedWorker = workerHarness({
  workerCaches: {
    open: () => { storageBlockedOpenCalls += 1; return never; },
    keys: async () => [],
    delete: async () => false,
  },
  // Exercise the deadline without making the test suite wait a real second.
  workerSetTimeout(callback) { Promise.resolve().then(callback); return 1; },
  workerClearTimeout() {},
});
for (let messageId = 201; messageId <= 210; messageId++) {
  await storageBlockedWorker.dispatch('push', {
    data: { json: () => ({ kind: 'mention', title: 'Секретный отправитель', body: 'Секретный текст', serverId: 'safe', messageId, tag: `msg:safe:${messageId}` }) },
  });
}
assert.equal(storageBlockedWorker.notifications.length, 10,
  'one never-settling CacheStorage operation cannot suppress this or the next mandatory push banner');
assert.equal(storageBlockedWorker.notifications.every(({ title, options }) => (
  title === 'RelayApp' && options.body === 'Новое упоминание' && options.data.serverId === ''
)), true, 'unavailable session/privacy storage fails closed without retaining account navigation data');
assert.equal(storageBlockedOpenCalls, 2,
  'all later pushes share the one stuck session read and one stuck privacy read');

const destinationRecoveryBase = cacheStorage();
let hangFirstDestinationOpen = true;
const destinationRecoveryCaches = {
  stores: destinationRecoveryBase.stores,
  open(name) {
    if (hangFirstDestinationOpen) {
      hangFirstDestinationOpen = false;
      return new Promise(() => {});
    }
    return destinationRecoveryBase.open(name);
  },
  keys: () => destinationRecoveryBase.keys(),
  delete: (name) => destinationRecoveryBase.delete(name),
};
const destinationRecoveryWorker = workerHarness({
  workerCaches: destinationRecoveryCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await destinationRecoveryWorker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:stuck:n', destination: { serverId: 'stuck', messageId: 401 },
} });
await destinationRecoveryWorker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:recovered:n', destination: { serverId: 'recovered', messageId: 402 },
} });
const destinationRecoveryCache = await destinationRecoveryBase.open('relay-notification-state-v1');
assert.ok(await destinationRecoveryCache.match(
  origin + '/__relay-notification-state/destination/' + encodeURIComponent('msg:recovered:n'),
), 'a permanently hung destination mutation cannot wedge the bounded recovery slot');

const versionRecoveryBase = cacheStorage();
const versionRecoverySeed = await versionRecoveryBase.open('relay-notification-state-v1');
await versionRecoverySeed.put(
  origin + '/__relay-notification-state/session-active',
  new Response(JSON.stringify(true)),
);
await versionRecoverySeed.put(
  origin + '/__relay-notification-state/privacy',
  new Response(JSON.stringify('full')),
);
const neverWritingState = new Promise(() => {});
let sessionVersionPuts = 0;
const versionRecoveryCaches = {
  stores: versionRecoveryBase.stores,
  async open(name) {
    const cache = await versionRecoveryBase.open(name);
    return {
      match: (request) => cache.match(request),
      async put(request, response) {
        if (String(cacheKey(request)).includes('/session-active/version/')) {
          sessionVersionPuts += 1;
          if (sessionVersionPuts <= 2) return neverWritingState;
        }
        return cache.put(request, response);
      },
      delete: (request) => cache.delete(request),
      keys: () => cache.keys(),
    };
  },
  keys: () => versionRecoveryBase.keys(),
  delete: (name) => versionRecoveryBase.delete(name),
};
const versionRecoveryWorker = workerHarness({
  workerCaches: versionRecoveryCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await assert.rejects(versionRecoveryWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: true },
}));
await versionRecoveryWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: false },
});
assert.equal(sessionVersionPuts, 3,
  'two reserved restrictive attempts persist logout after an older maintenance write hangs forever');
const restartedVersionRecoveryWorker = workerHarness({ workerCaches: versionRecoveryBase });
await restartedVersionRecoveryWorker.dispatch('push', {
  data: { json: () => ({
    privacy: 'full', kind: 'mention', title: 'OLD SECRET', body: 'old body', serverId: 'old', messageId: 403,
  }) },
});
assert.deepEqual({
  title: restartedVersionRecoveryWorker.notifications.at(-1).title,
  serverId: restartedVersionRecoveryWorker.notifications.at(-1).options.data.serverId,
}, { title: 'RelayApp', serverId: '' },
'immutable session versions prevent late/hung older writes from reviving a logged-out account');

const seedRecoveryBase = cacheStorage();
const seedRecoveryLegacy = await seedRecoveryBase.open('relay-notification-state-v1');
await seedRecoveryLegacy.put(
  origin + '/__relay-notification-state/session-active',
  new Response(JSON.stringify(true)),
);
await seedRecoveryLegacy.put(
  origin + '/__relay-notification-state/privacy',
  new Response(JSON.stringify('full')),
);
let seedRecoveryKeyScans = 0;
const seedRecoveryCaches = {
  stores: seedRecoveryBase.stores,
  async open(name) {
    const cache = await seedRecoveryBase.open(name);
    return {
      match: (request) => cache.match(request),
      put: (request, response) => cache.put(request, response),
      delete: (request) => cache.delete(request),
      keys() {
        seedRecoveryKeyScans += 1;
        if (seedRecoveryKeyScans === 1) return new Promise(() => {});
        return cache.keys();
      },
    };
  },
  keys: () => seedRecoveryBase.keys(),
  delete: (name) => seedRecoveryBase.delete(name),
};
const seedRecoveryWorker = workerHarness({
  workerCaches: seedRecoveryCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await seedRecoveryWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: false },
});
assert.ok(seedRecoveryKeyScans >= 2,
  'a second bounded seed scan recovers when the first CacheStorage keys call never settles');
const seedRecoveryRestart = workerHarness({ workerCaches: seedRecoveryBase });
await seedRecoveryRestart.dispatch('push', {
  data: { json: () => ({
    privacy: 'full', kind: 'mention', title: 'SEED SECRET', body: 'old body', serverId: 'seed-old',
  }) },
});
assert.deepEqual({
  title: seedRecoveryRestart.notifications.at(-1).title,
  serverId: seedRecoveryRestart.notifications.at(-1).options.data.serverId,
}, { title: 'RelayApp', serverId: '' },
'a recovered common revision barrier durably preserves logout across worker restart');

const rejectedSeedBase = cacheStorage();
const rejectedSeedLegacy = await rejectedSeedBase.open('relay-notification-state-v1');
await rejectedSeedLegacy.put(
  origin + '/__relay-notification-state/session-active',
  new Response(JSON.stringify(true)),
);
await rejectedSeedLegacy.put(
  origin + '/__relay-notification-state/privacy',
  new Response(JSON.stringify('full')),
);
let rejectSeedScans = true;
let rejectedSeedScanCount = 0;
const rejectedSeedCaches = {
  stores: rejectedSeedBase.stores,
  async open(name) {
    const cache = await rejectedSeedBase.open(name);
    return {
      match: (request) => cache.match(request),
      put: (request, response) => cache.put(request, response),
      delete: (request) => cache.delete(request),
      keys() {
        rejectedSeedScanCount += 1;
        if (rejectSeedScans) return Promise.reject(new Error('transient CacheStorage rejection'));
        return cache.keys();
      },
    };
  },
  keys: () => rejectedSeedBase.keys(),
  delete: (name) => rejectedSeedBase.delete(name),
};
const rejectedSeedWorker = workerHarness({
  workerCaches: rejectedSeedCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await assert.rejects(rejectedSeedWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: false },
}));
const failedSeedScanCount = rejectedSeedScanCount;
rejectSeedScans = false;
await rejectedSeedWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: false },
});
assert.ok(rejectedSeedScanCount > failedSeedScanCount,
  'a fully rejected seed batch is reset so a later logout can rescan recovered CacheStorage');
const rejectedSeedRestart = workerHarness({ workerCaches: rejectedSeedBase });
await rejectedSeedRestart.dispatch('push', {
  data: { json: () => ({
    privacy: 'full', kind: 'mention', title: 'REJECTED SEED SECRET', body: 'old body', serverId: 'reject-old',
  }) },
});
assert.deepEqual({
  title: rejectedSeedRestart.notifications.at(-1).title,
  serverId: rejectedSeedRestart.notifications.at(-1).options.data.serverId,
}, { title: 'RelayApp', serverId: '' },
'a later restrictive event persists after transient seed rejection and stays private after restart');

const rollbackClockBase = cacheStorage();
const rollbackClockCache = await rollbackClockBase.open('relay-notification-state-v1');
const futureRevision = 2_000_000_000_000_000;
await rollbackClockCache.put(
  origin + '/__relay-notification-state/session-active/version/' + futureRevision,
  new Response(JSON.stringify({ revision: futureRevision, value: true })),
);
await rollbackClockCache.put(
  origin + '/__relay-notification-state/privacy/version/' + futureRevision,
  new Response(JSON.stringify({ revision: futureRevision, value: 'full' })),
);
class RolledBackWorkerDate extends Date { static now() { return 1_000_000_000_000; } }
const rollbackClockWorker = workerHarness({ workerCaches: rollbackClockBase, workerDate: RolledBackWorkerDate });
await rollbackClockWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: false },
});
const rollbackClockRestart = workerHarness({ workerCaches: rollbackClockBase, workerDate: RolledBackWorkerDate });
await rollbackClockRestart.dispatch('push', {
  data: { json: () => ({
    privacy: 'full', kind: 'mention', title: 'CLOCK SECRET', body: 'old body', serverId: 'clock-old',
  }) },
});
assert.deepEqual({
  title: rollbackClockRestart.notifications.at(-1).title,
  serverId: rollbackClockRestart.notifications.at(-1).options.data.serverId,
}, { title: 'RelayApp', serverId: '' },
'a clock rollback after worker restart still appends logout above the durable active revision');

const corruptNewestBase = cacheStorage();
const corruptNewestCache = await corruptNewestBase.open('relay-notification-state-v1');
await corruptNewestCache.put(
  origin + '/__relay-notification-state/session-active/version/100',
  new Response(JSON.stringify({ revision: 100, value: true })),
);
await corruptNewestCache.put(
  origin + '/__relay-notification-state/session-active/version/101',
  new Response('{broken'),
);
await corruptNewestCache.put(
  origin + '/__relay-notification-state/privacy/version/100',
  new Response(JSON.stringify({ revision: 100, value: 'full' })),
);
await corruptNewestCache.put(
  origin + '/__relay-notification-state/privacy/version/101',
  new Response('{broken'),
);
const corruptNewestWorker = workerHarness({ workerCaches: corruptNewestBase });
await corruptNewestWorker.dispatch('push', {
  data: { json: () => ({
    privacy: 'full', kind: 'mention', title: 'CORRUPT SECRET', body: 'old body', serverId: 'corrupt-newest',
  }) },
});
assert.deepEqual({
  title: corruptNewestWorker.notifications.at(-1).title,
  serverId: corruptNewestWorker.notifications.at(-1).options.data.serverId,
}, { title: 'RelayApp', serverId: '' },
'a malformed newest tombstone fails closed instead of falling back to an older active/full version');

const cappedWritesBase = cacheStorage();
let permanentlyHungStateWrites = 0;
const cappedWritesCaches = {
  stores: cappedWritesBase.stores,
  async open(name) {
    const cache = await cappedWritesBase.open(name);
    return {
      match: (request) => cache.match(request),
      async put(request, response) {
        if (String(cacheKey(request)).includes('/session-active/version/')) {
          permanentlyHungStateWrites += 1;
          return new Promise(() => {});
        }
        return cache.put(request, response);
      },
      delete: (request) => cache.delete(request),
      keys: () => cache.keys(),
    };
  },
  keys: () => cappedWritesBase.keys(),
  delete: (name) => cappedWritesBase.delete(name),
};
const cappedWritesWorker = workerHarness({
  workerCaches: cappedWritesCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
for (let index = 0; index < 10; index++) {
  await assert.rejects(cappedWritesWorker.dispatch('message', {
    data: { type: 'set-notification-session-active', active: index < 5 },
  }));
}
assert.equal(permanentlyHungStateWrites, 3,
  'repeated maintenance/logout messages retain at most three unresolved native CacheStorage writes');

const isolatedBudgetsBase = cacheStorage();
const isolatedBudgetsSeed = await isolatedBudgetsBase.open('relay-notification-state-v1');
await isolatedBudgetsSeed.put(
  origin + '/__relay-notification-state/session-active',
  new Response(JSON.stringify(true)),
);
await isolatedBudgetsSeed.put(
  origin + '/__relay-notification-state/privacy',
  new Response(JSON.stringify('full')),
);
let isolatedPrivacyPuts = 0;
let isolatedSessionPuts = 0;
const isolatedBudgetsCaches = {
  stores: isolatedBudgetsBase.stores,
  async open(name) {
    const cache = await isolatedBudgetsBase.open(name);
    return {
      match: (request) => cache.match(request),
      async put(request, response) {
        const key = String(cacheKey(request));
        if (key.includes('/privacy/version/')) {
          isolatedPrivacyPuts += 1;
          return new Promise(() => {});
        }
        if (key.includes('/session-active/version/')) isolatedSessionPuts += 1;
        return cache.put(request, response);
      },
      delete: (request) => cache.delete(request),
      keys: () => cache.keys(),
    };
  },
  keys: () => isolatedBudgetsBase.keys(),
  delete: (name) => isolatedBudgetsBase.delete(name),
};
const isolatedBudgetsWorker = workerHarness({
  workerCaches: isolatedBudgetsCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await assert.rejects(isolatedBudgetsWorker.dispatch('message', {
  data: { type: 'set-notification-privacy', privacy: 'hidden' },
}));
await isolatedBudgetsWorker.dispatch('message', {
  data: { type: 'set-notification-session-active', active: false },
});
assert.deepEqual({ isolatedPrivacyPuts, isolatedSessionPuts }, {
  isolatedPrivacyPuts: 3, isolatedSessionPuts: 1,
}, 'hung privacy retries cannot consume the independent logout-session persistence budget');

const revisionOrderBase = cacheStorage();
const revisionOrderSeed = await revisionOrderBase.open('relay-notification-state-v1');
await revisionOrderSeed.put(
  origin + '/__relay-notification-state/session-active',
  new Response(JSON.stringify(true)),
);
const delayedRevisionSeed = deferred();
let delayFirstRevisionScan = true;
const revisionOrderCaches = {
  stores: revisionOrderBase.stores,
  async open(name) {
    const cache = await revisionOrderBase.open(name);
    return {
      match: (request) => cache.match(request),
      put: (request, response) => cache.put(request, response),
      delete: (request) => cache.delete(request),
      async keys() {
        if (delayFirstRevisionScan) {
          delayFirstRevisionScan = false;
          await delayedRevisionSeed.promise;
        }
        return cache.keys();
      },
    };
  },
  keys: () => revisionOrderBase.keys(),
  delete: (name) => revisionOrderBase.delete(name),
};
const revisionOrderWorker = workerHarness({
  workerCaches: revisionOrderCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await revisionOrderWorker.dispatch('message', {
  data: { type: 'set-notification-privacy', privacy: 'full' },
});
const newerHiddenIntent = revisionOrderWorker.dispatch('message', {
  data: { type: 'set-notification-privacy', privacy: 'hidden' },
});
delayedRevisionSeed.resolve();
await newerHiddenIntent;
for (let spin = 0; spin < 8; spin++) await new Promise((resolve) => setTimeout(resolve, 0));
const revisionOrderRestart = workerHarness({ workerCaches: revisionOrderBase });
await revisionOrderRestart.dispatch('push', {
  data: { json: () => ({
    privacy: 'full', kind: 'mention', title: 'OLD ORDER SECRET', body: 'old body', serverId: 'old-order',
  }) },
});
assert.equal(revisionOrderRestart.notifications.at(-1).title, 'RelayApp',
  'a delayed older full scan/write cannot receive a revision above the newer hidden intent');

const orderedBase = cacheStorage();
const delayedRead = deferred();
let delayFirstDestinationRead = true;
const orderedCaches = {
  stores: orderedBase.stores,
  async open(name) {
    const cache = await orderedBase.open(name);
    return {
      async match(request) {
        if (delayFirstDestinationRead && String(cacheKey(request)).includes('/destination/')) {
          delayFirstDestinationRead = false;
          await delayedRead.promise;
        }
        return cache.match(request);
      },
      put: (request, response) => cache.put(request, response),
      delete: (request) => cache.delete(request),
      keys: () => cache.keys(),
    };
  },
  keys: () => orderedBase.keys(),
  delete: (name) => orderedBase.delete(name),
};
const orderedWorker = workerHarness({
  workerCaches: orderedCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await orderedWorker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:late:n', destination: { serverId: 'late', messageId: 301 },
} });
await orderedWorker.dispatch('message', { data: {
  type: 'remember-notification-destination', tag: 'msg:late:n', destination: { serverId: 'late', messageId: 302 },
} });
delayedRead.resolve();
for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
const orderedCache = await orderedBase.open('relay-notification-state-v1');
const orderedResponse = await orderedCache.match(origin + '/__relay-notification-state/destination/' + encodeURIComponent('msg:late:n'));
assert.equal((await orderedResponse.json()).destination.messageId, 302,
  'a timed-out old CacheStorage continuation remains ordered before the newer exact destination');

const privacyBase = cacheStorage();
const delayedPrivacyWrite = deferred();
let delayFirstPrivacyWrite = true;
const privacyCaches = {
  stores: privacyBase.stores,
  async open(name) {
    const cache = await privacyBase.open(name);
    return {
      match: (request) => cache.match(request),
      async put(request, response) {
        if (delayFirstPrivacyWrite && String(cacheKey(request)).includes('/privacy')) {
          delayFirstPrivacyWrite = false;
          await delayedPrivacyWrite.promise;
        }
        return cache.put(request, response);
      },
      delete: (request) => cache.delete(request),
      keys: () => cache.keys(),
    };
  },
  keys: () => privacyBase.keys(),
  delete: (name) => privacyBase.delete(name),
};
const privacyWorker = workerHarness({
  workerCaches: privacyCaches,
  workerSetTimeout(callback) { return setTimeout(callback, 0); },
  workerClearTimeout: clearTimeout,
});
await privacyWorker.dispatch('message', { data: { type: 'set-notification-privacy', privacy: 'full' } });
const hiddenPrivacyWrite = privacyWorker.dispatch('message', { data: { type: 'set-notification-privacy', privacy: 'hidden' } });
let hiddenPrivacySettled = false;
void hiddenPrivacyWrite.then(() => { hiddenPrivacySettled = true; });
await Promise.resolve();
assert.equal(hiddenPrivacySettled, false,
  'a restrictive privacy message keeps waitUntil alive until its durable write completes');
await privacyWorker.dispatch('push', {
  data: { json: () => ({ privacy: 'full', kind: 'mention', title: 'Нельзя раскрывать', body: 'Скрытый текст', serverId: 'privacy', messageId: 1 }) },
});
assert.equal(privacyWorker.notifications.at(-1).title, 'RelayApp',
  'the newest in-memory privacy intent is authoritative while an older persistence write is pending');
delayedPrivacyWrite.resolve();
await hiddenPrivacyWrite;
for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 0));
const privacyCache = await privacyBase.open('relay-notification-state-v1');
assert.equal(await latestVersionedStateValue(
  privacyCache,
  '/__relay-notification-state/privacy/version/',
), 'hidden',
  'strict privacy persistence prevents a late older write from exposing notification content');

console.log('mobile push/PWA lifecycle: ok');

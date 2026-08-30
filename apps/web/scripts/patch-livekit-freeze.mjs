import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// livekit-client 2.20.0 respects disconnectOnPageLeave for pagehide/beforeunload but registers
// Page Lifecycle `freeze` unconditionally. Android Chrome/PWA uses freeze for ordinary background
// suspension, so the default handler terminally disconnects an otherwise recoverable voice room.
// Keep this small vendor patch deterministic and fail installation if the locked dependency changes
// shape: silently skipping it would reintroduce mobile voice loss.

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function replaceOne(source, vulnerable, fixed, label, legacy = []) {
  if (source.includes(fixed)) return source;
  const candidates = [vulnerable, ...legacy];
  const matches = candidates.flatMap((candidate) => Array(source.split(candidate).length - 1).fill(candidate));
  if (matches.length !== 1) throw new Error(`livekit freeze patch: expected one ${label}, found ${matches.length}`);
  return source.replace(matches[0], fixed);
}

function patchFile(relativePath, patches) {
  const path = join(webRoot, relativePath);
  let source = readFileSync(path, 'utf8');
  for (const patch of patches)
    source = replaceOne(source, patch.vulnerable, patch.fixed, patch.label, patch.legacy);
  writeFileSync(path, source);
}

const sourceAdd = {
  label: 'source freeze registration',
  vulnerable: `    if (isWeb() && this.options.disconnectOnPageLeave) {
      // capturing both 'pagehide' and 'beforeunload' to capture broadest set of browser behaviors
      window.addEventListener('pagehide', this.onPageLeave);
      window.addEventListener('beforeunload', this.onPageLeave);
    }
    if (isWeb()) {
      window.addEventListener('freeze', this.onPageLeave);
    }`,
  fixed: `    if (isWeb() && this.options.disconnectOnPageLeave) {
      // capturing pagehide, beforeunload and freeze covers browser and installed-PWA lifecycles
      window.addEventListener('pagehide', this.onPageLeave);
      window.addEventListener('beforeunload', this.onPageLeave);
      window.addEventListener('freeze', this.onPageLeave);
    }`,
};

const sourceRemove = {
  label: 'source freeze cleanup',
  vulnerable: `      if (isWeb()) {
        window.removeEventListener('beforeunload', this.onPageLeave);
        window.removeEventListener('pagehide', this.onPageLeave);
        window.removeEventListener('freeze', this.onPageLeave);
        navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChange);
      }`,
  fixed: `      if (isWeb()) {
        if (this.options.disconnectOnPageLeave) {
          window.removeEventListener('beforeunload', this.onPageLeave);
          window.removeEventListener('pagehide', this.onPageLeave);
          window.removeEventListener('freeze', this.onPageLeave);
        }
        navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChange);
      }`,
};

const esmAdd = {
  label: 'ESM freeze registration',
  vulnerable: `      if (isWeb() && this.options.disconnectOnPageLeave) {
        // capturing both 'pagehide' and 'beforeunload' to capture broadest set of browser behaviors
        window.addEventListener('pagehide', this.onPageLeave);
        window.addEventListener('beforeunload', this.onPageLeave);
      }
      if (isWeb()) {
        window.addEventListener('freeze', this.onPageLeave);
      }`,
  fixed: `      if (isWeb() && this.options.disconnectOnPageLeave) {
        // capturing pagehide, beforeunload and freeze covers browser and installed-PWA lifecycles
        window.addEventListener('pagehide', this.onPageLeave);
        window.addEventListener('beforeunload', this.onPageLeave);
        window.addEventListener('freeze', this.onPageLeave);
      }`,
};

const esmRemove = {
  label: 'ESM freeze cleanup',
  vulnerable: `      if (isWeb()) {
        window.removeEventListener('beforeunload', this.onPageLeave);
        window.removeEventListener('pagehide', this.onPageLeave);
        window.removeEventListener('freeze', this.onPageLeave);
        (_b = (_a = navigator.mediaDevices) === null || _a === void 0 ? void 0 : _a.removeEventListener) === null || _b === void 0 ? void 0 : _b.call(_a, 'devicechange', this.handleDeviceChange);
      }`,
  fixed: `      if (isWeb()) {
        if (this.options.disconnectOnPageLeave) {
          window.removeEventListener('beforeunload', this.onPageLeave);
          window.removeEventListener('pagehide', this.onPageLeave);
          window.removeEventListener('freeze', this.onPageLeave);
        }
        (_b = (_a = navigator.mediaDevices) === null || _a === void 0 ? void 0 : _a.removeEventListener) === null || _b === void 0 ? void 0 : _b.call(_a, 'devicechange', this.handleDeviceChange);
      }`,
};

const umdAdd = {
  label: 'UMD freeze registration',
  vulnerable: `_s()&&this.options.disconnectOnPageLeave&&(window.addEventListener("pagehide",this.onPageLeave),window.addEventListener("beforeunload",this.onPageLeave)),_s()&&window.addEventListener("freeze",this.onPageLeave),`,
  fixed: `_s()&&this.options.disconnectOnPageLeave&&(window.addEventListener("pagehide",this.onPageLeave),window.addEventListener("beforeunload",this.onPageLeave),window.addEventListener("freeze",this.onPageLeave)),`,
};

const umdRemove = {
  label: 'UMD freeze cleanup',
  vulnerable: `_s()&&(window.removeEventListener("beforeunload",this.onPageLeave),window.removeEventListener("pagehide",this.onPageLeave),window.removeEventListener("freeze",this.onPageLeave),`,
  fixed: `_s()&&(this.options.disconnectOnPageLeave&&(window.removeEventListener("beforeunload",this.onPageLeave),window.removeEventListener("pagehide",this.onPageLeave),window.removeEventListener("freeze",this.onPageLeave)),`,
};

// startAudio() creates the iOS silent-audio workaround lazily. Upstream 2.20.0 registers its
// anonymous visibility callback forever: Disconnected removes only the element, so every retired
// Room remains strongly reachable and runs startAudio again on every foreground. Give the callback
// an exact owner and remove it together with the dummy element.
const sourceDummyVisibility = {
  label: 'source dummy audio visibility cleanup',
  vulnerable: `        document.addEventListener('visibilitychange', () => {
          if (!dummyAudioEl) {
            return;
          }
          // set the srcObject to null on page hide in order to prevent lock screen controls to show up for it
          dummyAudioEl.srcObject = document.hidden ? null : stream;
          if (!document.hidden) {
            this.log.debug(
              'page visible again, triggering startAudio to resume playback and update playback status',
            );
            this.startAudio();
          }
        });
        document.body.append(dummyAudioEl);
        this.once(RoomEvent.Disconnected, () => {
          dummyAudioEl?.remove();
          dummyAudioEl = null;
        });`,
  fixed: `        const handleDummyAudioVisibilityChange = () => {
          if (!dummyAudioEl) {
            return;
          }
          // set the srcObject to null on page hide in order to prevent lock screen controls to show up for it
          dummyAudioEl.srcObject = document.hidden ? null : stream;
          if (!document.hidden) {
            this.log.debug(
              'page visible again, triggering startAudio to resume playback and update playback status',
            );
            this.startAudio();
          }
        };
        document.addEventListener('visibilitychange', handleDummyAudioVisibilityChange);
        document.body.append(dummyAudioEl);
        this.once(RoomEvent.Disconnected, () => {
          document.removeEventListener('visibilitychange', handleDummyAudioVisibilityChange);
          dummyAudioEl?.remove();
          dummyAudioEl = null;
        });`,
};

const esmDummyVisibility = {
  label: 'ESM dummy audio visibility cleanup',
  vulnerable: `          document.addEventListener('visibilitychange', () => {
            if (!dummyAudioEl) {
              return;
            }
            // set the srcObject to null on page hide in order to prevent lock screen controls to show up for it
            dummyAudioEl.srcObject = document.hidden ? null : stream;
            if (!document.hidden) {
              this.log.debug('page visible again, triggering startAudio to resume playback and update playback status');
              this.startAudio();
            }
          });
          document.body.append(dummyAudioEl);
          this.once(RoomEvent.Disconnected, () => {
            dummyAudioEl === null || dummyAudioEl === void 0 ? void 0 : dummyAudioEl.remove();
            dummyAudioEl = null;
          });`,
  fixed: `          const handleDummyAudioVisibilityChange = () => {
            if (!dummyAudioEl) {
              return;
            }
            // set the srcObject to null on page hide in order to prevent lock screen controls to show up for it
            dummyAudioEl.srcObject = document.hidden ? null : stream;
            if (!document.hidden) {
              this.log.debug('page visible again, triggering startAudio to resume playback and update playback status');
              this.startAudio();
            }
          };
          document.addEventListener('visibilitychange', handleDummyAudioVisibilityChange);
          document.body.append(dummyAudioEl);
          this.once(RoomEvent.Disconnected, () => {
            document.removeEventListener('visibilitychange', handleDummyAudioVisibilityChange);
            dummyAudioEl === null || dummyAudioEl === void 0 ? void 0 : dummyAudioEl.remove();
            dummyAudioEl = null;
          });`,
};

const umdDummyVisibility = {
  label: 'UMD dummy audio visibility cleanup',
  vulnerable: `document.addEventListener("visibilitychange",(()=>{i&&(i.srcObject=document.hidden?null:r,document.hidden||(this.log.debug("page visible again, triggering startAudio to resume playback and update playback status"),this.startAudio()))})),document.body.append(i),this.once(e.RoomEvent.Disconnected,(()=>{null==i||i.remove(),i=null}))`,
  legacy: [`const s=()=>{i&&(i.srcObject=document.hidden?null:r,document.hidden||(this.log.debug("page visible again, triggering startAudio to resume playback and update playback status"),this.startAudio()))};document.addEventListener("visibilitychange",s),document.body.append(i),this.once(e.RoomEvent.Disconnected,(()=>{document.removeEventListener("visibilitychange",s),null==i||i.remove(),i=null}))`],
  fixed: `(i.__livekitVisibilityHandler=()=>{i&&(i.srcObject=document.hidden?null:r,document.hidden||(this.log.debug("page visible again, triggering startAudio to resume playback and update playback status"),this.startAudio()))}),document.addEventListener("visibilitychange",i.__livekitVisibilityHandler),document.body.append(i),this.once(e.RoomEvent.Disconnected,(()=>{document.removeEventListener("visibilitychange",i.__livekitVisibilityHandler),null==i||i.remove(),i=null}))`,
};

patchFile('node_modules/livekit-client/src/room/Room.ts', [sourceAdd, sourceRemove, sourceDummyVisibility]);
patchFile('node_modules/livekit-client/dist/livekit-client.esm.mjs', [esmAdd, esmRemove, esmDummyVisibility]);
patchFile('node_modules/livekit-client/dist/livekit-client.umd.js', [umdAdd, umdRemove, umdDummyVisibility]);

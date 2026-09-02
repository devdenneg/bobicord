import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// livekit-client 2.20.0 respects disconnectOnPageLeave for pagehide/beforeunload but registers
// Page Lifecycle `freeze` unconditionally. Android Chrome/PWA uses freeze for ordinary background
// suspension, so the default handler terminally disconnects an otherwise recoverable voice room.
// Keep this small vendor patch deterministic and fail installation if the locked dependency changes
// shape: silently skipping it would reintroduce mobile voice loss.

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function replaceOne(source, vulnerable, fixed, label, legacy = [], applied = []) {
  if (source.includes(fixed) || applied.some((marker) => source.includes(marker))) return source;
  const candidates = [vulnerable, ...legacy];
  const matches = candidates.flatMap((candidate) => Array(source.split(candidate).length - 1).fill(candidate));
  if (matches.length !== 1) throw new Error(`livekit freeze patch: expected one ${label}, found ${matches.length}`);
  return source.replace(matches[0], fixed);
}

function patchFile(relativePath, patches) {
  const path = join(webRoot, relativePath);
  let source = readFileSync(path, 'utf8');
  for (const patch of patches)
    source = replaceOne(source, patch.vulnerable, patch.fixed, patch.label, patch.legacy, patch.applied);
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
  legacy: [`        const handleDummyAudioVisibilityChange = () => {
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
        });`],
  applied: [`if (dummyAudioEl === current) dummyAudioEl = null;`],
  fixed: `        const sharedDummyAudioEl = dummyAudioEl as HTMLAudioElement & {
          __livekitRoomOwners?: Set<Room>;
          __livekitVisibilityHandler?: () => void;
          __livekitStream?: MediaStream;
        };
        sharedDummyAudioEl.__livekitStream = stream;
        sharedDummyAudioEl.__livekitVisibilityHandler = () => {
          const current = document.getElementById(audioId) as typeof sharedDummyAudioEl | null;
          if (!current) {
            return;
          }
          // set the srcObject to null on page hide in order to prevent lock screen controls to show up for it
          current.srcObject = document.hidden ? null : current.__livekitStream ?? null;
          if (!document.hidden) {
            current.__livekitRoomOwners?.forEach((room) => {
              room.log.debug(
                'page visible again, triggering startAudio to resume playback and update playback status',
              );
              void room.startAudio().catch(() => {});
            });
          }
        };
        document.addEventListener('visibilitychange', sharedDummyAudioEl.__livekitVisibilityHandler);
        document.body.append(dummyAudioEl);
      }
      const sharedDummyAudioEl = dummyAudioEl as HTMLAudioElement & {
        __livekitRoomOwners?: Set<Room>;
        __livekitVisibilityHandler?: () => void;
        __livekitStream?: MediaStream;
      };
      sharedDummyAudioEl.__livekitRoomOwners ??= new Set();
      if (!sharedDummyAudioEl.__livekitRoomOwners.has(this)) {
        sharedDummyAudioEl.__livekitRoomOwners.add(this);
        this.once(RoomEvent.Disconnected, () => {
          const current = document.getElementById(audioId) as typeof sharedDummyAudioEl | null;
          if (!current) return;
          current.__livekitRoomOwners?.delete(this);
          if (current.__livekitRoomOwners?.size) return;
          if (current.__livekitVisibilityHandler) {
            document.removeEventListener('visibilitychange', current.__livekitVisibilityHandler);
          }
          current.__livekitStream?.getTracks().forEach((track) => track.stop());
          current.remove();
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
  legacy: [`          const handleDummyAudioVisibilityChange = () => {
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
          });`],
  applied: [`if (dummyAudioEl === current) dummyAudioEl = null;`],
  fixed: `          const sharedDummyAudioEl = dummyAudioEl;
          sharedDummyAudioEl.__livekitStream = stream;
          sharedDummyAudioEl.__livekitVisibilityHandler = () => {
            const current = document.getElementById(audioId);
            if (!current) {
              return;
            }
            // set the srcObject to null on page hide in order to prevent lock screen controls to show up for it
            current.srcObject = document.hidden ? null : current.__livekitStream ?? null;
            if (!document.hidden) {
              current.__livekitRoomOwners?.forEach(room => {
                room.log.debug('page visible again, triggering startAudio to resume playback and update playback status');
                void room.startAudio().catch(() => {});
              });
            }
          };
          document.addEventListener('visibilitychange', sharedDummyAudioEl.__livekitVisibilityHandler);
          document.body.append(dummyAudioEl);
        }
        const sharedDummyAudioEl = dummyAudioEl;
        sharedDummyAudioEl.__livekitRoomOwners ??= new Set();
        if (!sharedDummyAudioEl.__livekitRoomOwners.has(this)) {
          sharedDummyAudioEl.__livekitRoomOwners.add(this);
          this.once(RoomEvent.Disconnected, () => {
            const current = document.getElementById(audioId);
            if (!current) return;
            current.__livekitRoomOwners?.delete(this);
            if (current.__livekitRoomOwners?.size) return;
            if (current.__livekitVisibilityHandler) {
              document.removeEventListener('visibilitychange', current.__livekitVisibilityHandler);
            }
            current.__livekitStream?.getTracks().forEach(track => track.stop());
            current.remove();
          });`,
};

const umdDummyVisibility = {
  label: 'UMD dummy audio visibility cleanup',
  vulnerable: `document.addEventListener("visibilitychange",(()=>{i&&(i.srcObject=document.hidden?null:r,document.hidden||(this.log.debug("page visible again, triggering startAudio to resume playback and update playback status"),this.startAudio()))})),document.body.append(i),this.once(e.RoomEvent.Disconnected,(()=>{null==i||i.remove(),i=null}))`,
  legacy: [
    `const s=()=>{i&&(i.srcObject=document.hidden?null:r,document.hidden||(this.log.debug("page visible again, triggering startAudio to resume playback and update playback status"),this.startAudio()))};document.addEventListener("visibilitychange",s),document.body.append(i),this.once(e.RoomEvent.Disconnected,(()=>{document.removeEventListener("visibilitychange",s),null==i||i.remove(),i=null}))`,
    `(i.__livekitVisibilityHandler=()=>{i&&(i.srcObject=document.hidden?null:r,document.hidden||(this.log.debug("page visible again, triggering startAudio to resume playback and update playback status"),this.startAudio()))}),document.addEventListener("visibilitychange",i.__livekitVisibilityHandler),document.body.append(i),this.once(e.RoomEvent.Disconnected,(()=>{document.removeEventListener("visibilitychange",i.__livekitVisibilityHandler),null==i||i.remove(),i=null}))`,
  ],
  applied: [`i===t&&(i=null)`],
  fixed: `i.__livekitStream=r,i.__livekitVisibilityHandler=()=>{const t=document.getElementById(n);t&&(t.srcObject=document.hidden?null:null!=t.__livekitStream?t.__livekitStream:null,document.hidden||null==t.__livekitRoomOwners||t.__livekitRoomOwners.forEach((e=>{e.startAudio().catch((()=>{}))})))},document.addEventListener("visibilitychange",i.__livekitVisibilityHandler),document.body.append(i)}i.__livekitRoomOwners||(i.__livekitRoomOwners=new Set),i.__livekitRoomOwners.has(this)||(i.__livekitRoomOwners.add(this),this.once(e.RoomEvent.Disconnected,(()=>{const t=document.getElementById(n);t&&(t.__livekitRoomOwners.delete(this),t.__livekitRoomOwners.size||(t.__livekitVisibilityHandler&&document.removeEventListener("visibilitychange",t.__livekitVisibilityHandler),null==t.__livekitStream||t.__livekitStream.getTracks().forEach((e=>e.stop())),t.remove()))})))`,
};

// Release the exact local element reference after the final owner removes it. Apart from making the
// callback's ownership explicit, this prevents any late work in the retiring Room from touching the
// detached element. A later startAudio() still discovers or creates the current DOM singleton.
const sourceDummyReferenceReset = {
  label: 'source dummy audio reference reset',
  vulnerable: `          current.__livekitStream?.getTracks().forEach((track) => track.stop());
          current.remove();
        });`,
  fixed: `          current.__livekitStream?.getTracks().forEach((track) => track.stop());
          current.remove();
          if (dummyAudioEl === current) dummyAudioEl = null;
        });`,
};

const esmDummyReferenceReset = {
  label: 'ESM dummy audio reference reset',
  vulnerable: `            current.__livekitStream?.getTracks().forEach(track => track.stop());
            current.remove();
          });`,
  fixed: `            current.__livekitStream?.getTracks().forEach(track => track.stop());
            current.remove();
            if (dummyAudioEl === current) dummyAudioEl = null;
          });`,
};

const umdDummyReferenceReset = {
  label: 'UMD dummy audio reference reset',
  vulnerable: `null==t.__livekitStream||t.__livekitStream.getTracks().forEach((e=>e.stop())),t.remove()))})))`,
  legacy: [`null==t.__livekitStream||t.__livekitStream.getTracks().forEach((e=>e.stop())),t.remove(),i===t&&(i=null))))})))`],
  fixed: `null==t.__livekitStream||t.__livekitStream.getTracks().forEach((e=>e.stop())),t.remove(),i===t&&(i=null)))})))`,
};

// The upstream UMD `if(!i){...}` closing brace sits immediately after the vulnerable span. The
// ref-counted replacement closes that creation block itself, so consume the one legacy brace left
// between owner registration and `t.push(i)`. Keep this separate and exact so dependency drift
// fails installation instead of producing a subtly malformed browser bundle.
const umdDummyBlockBalance = {
  label: 'UMD dummy audio creation block balance',
  vulnerable: `i===t&&(i=null)))})))}t.push(i)}this.remoteParticipants`,
  legacy: [`i===t&&(i=null)))})))t.push(i)}this.remoteParticipants`],
  fixed: `i===t&&(i=null)))}))),t.push(i)}this.remoteParticipants`,
};

// WebKit exposes the non-standard `interrupted` state after backgrounding an installed PWA.
// LiveKit 2.20 resumes only the standard `suspended` state, so every later startAudio() can leave
// its private fallback mixer permanently silent. Resume every reusable non-running context; a
// closed context is recreated by the branch immediately above this condition.
const sourceInterruptedAudioResume = {
  label: 'source interrupted audio context resume',
  vulnerable: `    if (this.audioContext && this.audioContext.state === 'suspended') {`,
  fixed: `    if (this.audioContext && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed') {`,
};

const esmInterruptedAudioResume = {
  label: 'ESM interrupted audio context resume',
  vulnerable: `      if (this.audioContext && this.audioContext.state === 'suspended') {`,
  fixed: `      if (this.audioContext && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed') {`,
};

const umdInterruptedAudioResume = {
  label: 'UMD interrupted audio context resume',
  vulnerable: `this.audioContext&&"suspended"===this.audioContext.state`,
  fixed: `this.audioContext&&"running"!==this.audioContext.state&&"closed"!==this.audioContext.state`,
};

// RemoteAudioTrack.attach() deliberately mutes its HTML element when webAudioMix owns playback:
// MediaElementSource -> GainNode -> destination is the only audible path. Upstream startAudio()
// unconditionally unmutes every attached element again, opening a second full-volume route around
// per-user/master gain. Keep only the iOS dummy element unmuted; mixed elements still receive
// play(), so their WebAudio sources continue flowing without a parallel direct output.
const sourceMixedAudioMute = {
  label: 'source mixed audio direct-path mute',
  vulnerable: `        ...elements.map((e) => {
          e.muted = false;
          return e.play();
        }),`,
  legacy: [`        ...elements.map((e) => {
          e.muted = Boolean(this.options.webAudioMix) && e.id !== 'livekit-dummy-audio-el';
          return e.play();
        }),`],
  fixed: `        ...elements.map((e) => {
          e.muted = Boolean(this.options.webAudioMix && this.audioContext && this.audioContext.state !== 'closed')
            && e.id !== 'livekit-dummy-audio-el';
          return e.play();
        }),`,
};

const esmMixedAudioMute = {
  label: 'ESM mixed audio direct-path mute',
  vulnerable: `        yield Promise.all([this.acquireAudioContext(), ...elements.map(e => {
          e.muted = false;
          return e.play();
        })]);`,
  legacy: [`        yield Promise.all([this.acquireAudioContext(), ...elements.map(e => {
          e.muted = Boolean(this.options.webAudioMix) && e.id !== 'livekit-dummy-audio-el';
          return e.play();
        })]);`],
  fixed: `        yield Promise.all([this.acquireAudioContext(), ...elements.map(e => {
          e.muted = Boolean(this.options.webAudioMix && this.audioContext && this.audioContext.state !== 'closed')
            && e.id !== 'livekit-dummy-audio-el';
          return e.play();
        })]);`,
};

const umdMixedAudioMute = {
  label: 'UMD mixed audio direct-path mute',
  vulnerable: `...t.map((e=>(e.muted=!1,e.play())))`,
  legacy: [`...t.map((e=>(e.muted=!!this.options.webAudioMix&&"livekit-dummy-audio-el"!==e.id,e.play())))`],
  fixed: `...t.map((e=>(e.muted=!!(this.options.webAudioMix&&this.audioContext&&"closed"!==this.audioContext.state)&&"livekit-dummy-audio-el"!==e.id,e.play())))`,
};

patchFile('node_modules/livekit-client/src/room/Room.ts', [
  sourceAdd, sourceRemove, sourceDummyVisibility, sourceDummyReferenceReset,
  sourceInterruptedAudioResume, sourceMixedAudioMute,
]);
patchFile('node_modules/livekit-client/dist/livekit-client.esm.mjs', [
  esmAdd, esmRemove, esmDummyVisibility, esmDummyReferenceReset,
  esmInterruptedAudioResume, esmMixedAudioMute,
]);
patchFile('node_modules/livekit-client/dist/livekit-client.umd.js', [
  umdAdd, umdRemove, umdDummyVisibility, umdDummyReferenceReset, umdDummyBlockBalance,
  umdInterruptedAudioResume, umdMixedAudioMute,
]);

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'mobileControls.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  DelayedPrimaryPointerHold,
  PTT_TOUCH_HOLD_MS,
  PTT_TOUCH_SLOP_PX,
  PrimaryPointerHold,
  PttCompatibilityClickFence,
  isRangeAdjustmentKey,
  webScreenShareSupported,
} = await import('data:text/javascript,' + encodeURIComponent(js));

const hold = new PrimaryPointerHold();
assert.equal(hold.begin(1, false, 0), false, 'a non-primary touch cannot open PTT');
assert.equal(hold.begin(1, true, 2), false, 'a secondary mouse button cannot open PTT');
assert.equal(hold.begin(7, true, 0), true, 'the primary pointer owns PTT');
assert.equal(hold.active(), 7);
assert.equal(hold.begin(8, true, 0), false, 'a second pointer cannot steal PTT ownership');
assert.equal(hold.end(8), false, 'an unrelated pointer cannot close PTT');
assert.equal(hold.end(7), true, 'the owning pointer closes PTT exactly once');
assert.equal(hold.end(7), false, 'duplicate pointerup is ignored');
assert.equal(hold.begin(9, true, 0), true);
assert.equal(hold.cancel(), true, 'visibility/cancel releases the active PTT pointer');
assert.equal(hold.cancel(), false, 'duplicate visibility release is idempotent');

assert.equal(PTT_TOUCH_HOLD_MS, 180, 'touch PTT waits long enough to distinguish an intentional hold');
assert.equal(PTT_TOUCH_SLOP_PX, 14, 'small finger jitter is tolerated without accepting a drag as a tap');
const delayedHold = new DelayedPrimaryPointerHold();
assert.equal(delayedHold.begin(20, false, 0), false, 'a secondary touch cannot own delayed PTT');
assert.equal(delayedHold.begin(20, true, 0, 100, 100), true);
assert.equal(delayedHold.owns(20), true);
assert.equal(delayedHold.pendingTap(20), true);
assert.equal(delayedHold.tapMovedBeyond(20, 110, 100), false, 'ordinary touch jitter keeps the tap eligible');
assert.equal(delayedHold.tapMovedBeyond(20, 115, 100), true, 'a drag beyond touch slop cancels manual mute');
assert.equal(delayedHold.activate(21), false, 'another pointer cannot activate the pending hold');
assert.equal(delayedHold.end(20), 'tap', 'release before activation remains an ordinary mute tap');
assert.equal(delayedHold.begin(21, true, 0), true);
assert.equal(delayedHold.activate(21), true, 'the exact pointer becomes PTT only after the delay');
assert.equal(delayedHold.pendingTap(21), false);
assert.equal(delayedHold.tapMovedBeyond(21, 500, 500), false, 'movement never strands an already-open PTT hold');
assert.equal(delayedHold.activate(21), false, 'one hold cannot open the microphone twice');
assert.equal(delayedHold.end(21), 'hold', 'the completed PTT hold suppresses only its matching click');
assert.equal(delayedHold.end(21), null, 'duplicate pointerup cannot release or suppress again');
assert.equal(delayedHold.begin(22, true, 0), true);
assert.equal(delayedHold.activate(22), true);
assert.equal(delayedHold.cancel(23), null, 'an unrelated cancellation cannot steal ownership');
assert.equal(delayedHold.cancel(22), 'hold', 'pointercancel closes an activated PTT hold');
assert.equal(delayedHold.begin(24, true, 0), true);
assert.equal(delayedHold.cancel(), 'tap', 'pagehide cancels a pending hold without opening the gate');

const clickFence = new PttCompatibilityClickFence();
clickFence.arm(30);
assert.equal(clickFence.consume(31, 'mouse', 1, false), false, 'a hybrid mouse click never consumes a touch fence');
assert.equal(clickFence.consume(null, '', 0), false, 'keyboard/assistive click neither consumes nor clears touch state');
assert.equal(clickFence.consume(999, 'touch', 0), true,
  'WebKit touch click is consumed even with detail zero and a different synthetic pointer id');
assert.equal(clickFence.consume(30, 'touch', 1), false, 'one cancelled gesture suppresses exactly one click');
clickFence.arm(32);
clickFence.arm(32);
assert.equal(clickFence.consume(32, 'pen', 0), true, 'duplicate cancel/up paths are deduplicated by exact pointer id');
assert.equal(clickFence.consume(32, 'pen', 0), false, 'a duplicate fence cannot swallow the next physical click');
clickFence.arm(33);
assert.equal(clickFence.consume(null, '', 1), true, 'legacy WebKit touch MouseEvent fallback remains covered');
clickFence.arm(34);
assert.equal(clickFence.consume(null, '', 0, true), true, 'InputDeviceCapabilities identifies a detail-zero touch click');
clickFence.arm(35);
clickFence.clear(); // every new valid physical pointerdown does this before its own button action
assert.equal(clickFence.consume(35, 'touch', 1), false, 'an omitted old click cannot suppress the next physical gesture');

for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
  assert.equal(isRangeAdjustmentKey(key), true, `${key} adjusts a range`);
}
for (const key of ['Enter', ' ', 'Tab', 'Escape']) assert.equal(isRangeAdjustmentKey(key), false);

assert.equal(webScreenShareSupported(undefined), false);
assert.equal(webScreenShareSupported({}), false);
assert.equal(webScreenShareSupported({ getDisplayMedia: true }), false);
assert.equal(webScreenShareSupported({ getDisplayMedia() {} }), true);

const voiceDock = readFileSync(join(here, 'components', 'VoiceDock.tsx'), 'utf8');
assert.match(voiceDock, /onPointerDown=.*pointerType === 'mouse' \|\| !ptt[\s\S]*if \(!pttHoldReady\) return/s,
  'mouse click always reaches manual mute; desktop PTT stays on its configured key');
assert.match(voiceDock, /window\.setTimeout[\s\S]*activate\(pointerId\)[\s\S]*E\.pttPress\('pointer'\)[\s\S]*PTT_TOUCH_HOLD_MS/,
  'touch PTT opens only after the exact delayed hold is confirmed');
assert.match(voiceDock, /onPointerUp=.*finishPttPointer/s, 'pointerup distinguishes a short mute tap from a PTT hold');
assert.match(voiceDock, /onPointerCancel=.*cancelPttPointer/s, 'pointercancel closes the PTT gate');
assert.match(voiceDock, /onLostPointerCapture=.*cancelPttPointer/s, 'lost capture closes the PTT gate');
assert.match(voiceDock, /finishPttPointer[\s\S]*owns\(pointerId\)[\s\S]*clearPttActivation/,
  'an unrelated pointerup cannot cancel the owning touch hold timer');
assert.match(voiceDock, /cancelPttPointer[\s\S]*pointerId !== undefined[\s\S]*owns\(pointerId\)[\s\S]*clearPttActivation/,
  'an unrelated pointercancel cannot cancel the owning touch hold timer');
assert.match(voiceDock, /visibilitychange.*releaseWhenHidden/s, 'hiding a PWA closes the PTT gate');
assert.match(voiceDock, /addEventListener\('blur', releaseOnBlur\)/,
  'losing window focus cancels a pending hold before its delayed gate can open');
assert.match(voiceDock, /addEventListener\('pointerup', releaseOnWindowPointerUp, true\)/,
  'window capture still finishes the exact touch when element pointer capture is unavailable');
assert.match(voiceDock, /addEventListener\('pointercancel', cancelOnWindowPointer, true\)/,
  'a browser-owned scroll or route cancellation cannot leave PTT open');
assert.match(voiceDock, /pendingTap\(pointerId\)[\s\S]*getBoundingClientRect[\s\S]*cancelPttPointer\(pointerId, true\)/,
  'a short touch released outside the mic button is cancelled instead of unmuting');
assert.match(voiceDock, /tapMovedBeyond[\s\S]*cancelPttPointer\(event\.pointerId, true\)/,
  'dragging a pending tap beyond touch slop cannot accidentally change mute');
assert.match(voiceDock, /released === 'hold'[\s\S]*E\.pttRelease\('pointer'\)[\s\S]*pttClickFence\.current\.arm\(pointerId\)/,
  'a completed hold closes PTT and fences only its compatibility click');
assert.match(voiceDock, /event\.isPrimary && event\.button === 0[\s\S]*pttClickFence\.current\.clear\(\)[\s\S]*pointerType === 'mouse'/,
  'every new physical gesture retires an omitted old touch click before early input-mode returns');
assert.match(voiceDock, /onClick=.*pttClickFence\.current\.consume\([\s\S]*nativePointerId,[\s\S]*native\.pointerType[\s\S]*event\.detail[\s\S]*firesTouchEvents[\s\S]*void E\.toggleMic\(\)/s,
  'ordinary click owns short touch, mouse and keyboard mute without double toggling');
assert.match(voiceDock, /if \(document\.hidden\) \{ cancelPttPointer\(pointerId, true\); return; \}/,
  'a queued hold timer cannot open PTT after the page enters background');
assert.match(voiceDock, /vd-ptt-hold[\s\S]*onContextMenu=.*pttHoldReady/s,
  'a held mobile PTT owns the touch gesture and suppresses the iOS callout');
const styles = readFileSync(join(here, 'styles.css'), 'utf8');
assert.match(styles, /\.vd-btn\.vd-ptt-hold\{touch-action:none;-webkit-touch-callout:none\}/,
  'small finger movement cannot turn a held PTT into a browser scroll cancellation');
assert.match(voiceDock, /!live && !supported.*return null/s, 'unsupported web screen share is not rendered');
assert.match(voiceDock, /reapplyMic\(\).*finally\(\(\) => E\.restartLevelMeter\(\)\)/s,
  'input selection restarts the settings meter after mic reapply');
assert.match(voiceDock, /reapplyMic\('route'\).*finally.*restartLevelMeter/s,
  'mobile route selection restarts the settings meter');

const modals = readFileSync(join(here, 'components', 'Modals.tsx'), 'utf8');
assert.doesNotMatch(modals, /notifyVolume[\s\S]{0,300}onMouseUp/,
  'notification preview is no longer mouse-only');
assert.match(modals, /notifyPreviewPointer[\s\S]*onPointerUp[\s\S]*playSound\('system'\)/,
  'pointer release previews notification volume');
assert.match(modals, /isRangeAdjustmentKey[\s\S]*onKeyUp[\s\S]*playSound\('system'\)/,
  'keyboard range adjustment previews notification volume');
assert.match(modals, /meterRestartPending[\s\S]*if \(forcePermission\) meterRestartPending = true[\s\S]*!result\.permissionDenied && !result\.partial/s,
  'a successful late permission retry revives MicMeter even if re-enumeration supersedes its generation');

const engine = readFileSync(join(here, 'engine.ts'), 'utf8');
assert.match(engine, /startLevelMeter\(\)[\s\S]{0,500}automaticMicrophoneCaptureAllowed\(\)/,
  'a prior NotAllowed result suppresses automatic MicMeter permission retries');

console.log('mobile controls: ok');

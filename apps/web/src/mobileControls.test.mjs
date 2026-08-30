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
  PrimaryPointerHold,
  isRangeAdjustmentKey,
  suppressPointerToggleWhilePtt,
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

assert.equal(suppressPointerToggleWhilePtt(true, 1), true, 'touch click cannot toggle after PTT release');
assert.equal(suppressPointerToggleWhilePtt(true, 0), false, 'keyboard activation remains available');
assert.equal(suppressPointerToggleWhilePtt(false, 1), false, 'normal mic mode still toggles on tap');

for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
  assert.equal(isRangeAdjustmentKey(key), true, `${key} adjusts a range`);
}
for (const key of ['Enter', ' ', 'Tab', 'Escape']) assert.equal(isRangeAdjustmentKey(key), false);

assert.equal(webScreenShareSupported(undefined), false);
assert.equal(webScreenShareSupported({}), false);
assert.equal(webScreenShareSupported({ getDisplayMedia: true }), false);
assert.equal(webScreenShareSupported({ getDisplayMedia() {} }), true);

const voiceDock = readFileSync(join(here, 'components', 'VoiceDock.tsx'), 'utf8');
assert.match(voiceDock, /onPointerDown=.*pttHoldReady/s, 'the mic button wires pointer hold to PTT readiness');
assert.match(voiceDock, /onPointerCancel=.*releasePttPointer/s, 'pointercancel closes the PTT gate');
assert.match(voiceDock, /onLostPointerCapture=.*releasePttPointer/s, 'lost capture closes the PTT gate');
assert.match(voiceDock, /visibilitychange.*releaseWhenHidden/s, 'hiding a PWA closes the PTT gate');
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

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'micLifecycle.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  AudioUnlockGestureDeduper,
  ExactAudioContextResumeCoordinator,
  MIC_MUTED_RESTART_MS,
  VOICE_RECONNECT_VERIFY_TIMEOUT_MS,
  VoiceMicStartOwnership,
  VoiceOperationTimeoutError,
  automaticMicRecoveryAllowed,
  foregroundMicNeedsImmediateRecovery,
  isVoiceOperationTimeout,
  manualMuteIntentIsCurrent,
  microphoneCaptureBusy,
  microphoneTransportHealth,
  mutedTrackNeedsRestart,
  readStoredFlag,
  retainMicAvailabilityDuringRecovery,
  reusableMicrophoneAudioContextState,
  resumeGestureAudioContext,
  resumeSharedGestureAudioContext,
  selectedInputUnavailable,
  unavailableMicrophoneButtonAction,
  withVoiceDeadline,
  withVoiceTimeout,
  voiceWriteCommittedForCurrentIntent,
} = await import('data:text/javascript,' + encodeURIComponent(js));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

assert.equal(readStoredFlag({ getItem: () => '1' }, 'voiceMute'), true);
assert.equal(readStoredFlag({ getItem: () => '0' }, 'voiceMute'), false);
assert.equal(readStoredFlag({ getItem: () => { throw new Error('blocked'); } }, 'voiceMute'), false);

assert.equal(selectedInputUnavailable({ name: 'NotFoundError' }), true);
assert.equal(selectedInputUnavailable({ name: 'OverconstrainedError' }), true);
assert.equal(selectedInputUnavailable({ name: 'NotAllowedError' }), false);
assert.equal(selectedInputUnavailable(new Error('busy')), false);

assert.equal(unavailableMicrophoneButtonAction(false), 'retry-capture',
  'a stable listen-only button can start one explicit microphone retry');
assert.equal(unavailableMicrophoneButtonAction(true), 'toggle-mute',
  'a busy capture keeps single-flight ownership but still accepts the mute intent');
const idleCapture = {
  startOwned: false,
  recoveryOwned: false,
  voiceTransaction: false,
  foregroundPending: false,
  bootstrapWanted: false,
};
assert.equal(microphoneCaptureBusy(idleCapture), false);
for (const key of Object.keys(idleCapture)) {
  assert.equal(microphoneCaptureBusy({ ...idleCapture, [key]: true }), true,
    `${key} keeps microphone capture single-flight without disabling manual mute`);
}
{
  let manualMute = true;
  let revision = 0;
  const previous = manualMute;
  manualMute = false;
  const retryRevision = ++revision;
  manualMute = !manualMute;
  ++revision; // a second click while getUserMedia is unresolved
  if (manualMuteIntentIsCurrent(retryRevision, revision)) manualMute = previous;
  assert.equal(manualMute, true, 'a late retry result cannot undo the newer explicit mute click');

  manualMute = true;
  const retryWithoutNewerClick = ++revision;
  manualMute = false;
  if (manualMuteIntentIsCurrent(retryWithoutNewerClick, revision)) manualMute = true;
  assert.equal(manualMute, true, 'the retry may restore its own optimistic unmute after failure');
}

assert.equal(mutedTrackNeedsRestart(1000, 1000 + MIC_MUTED_RESTART_MS - 1), false);
assert.equal(mutedTrackNeedsRestart(1000, 1000 + MIC_MUTED_RESTART_MS), true);
assert.equal(mutedTrackNeedsRestart(0, 999_999), false);

{
  const coordinator = new ExactAudioContextResumeCoordinator();
  const ordinary = deferred();
  const gesture = deferred();
  const gestureRetry = deferred();
  const context = {
    state: 'suspended',
    calls: 0,
    resume() {
      this.calls++;
      return this.calls === 1 ? ordinary.promise : (this.calls === 2 ? gesture.promise : gestureRetry.promise);
    },
  };
  let gestureRecoveries = 0;
  for (let tick = 0; tick < 100; tick++) coordinator.request(context);
  assert.equal(context.calls, 1,
    '100 watchdog recoveries share one native resume while WebKit keeps it pending');
  coordinator.request(context, true, () => { gestureRecoveries++; });
  coordinator.request(context, true);
  for (let tap = 0; tap < 100; tap++) coordinator.request(context, true);
  assert.equal(context.calls, 3,
    'a second fresh tap gets one retry lane, while 100 more taps cannot exceed the absolute cap');
  gestureRetry.resolve();
  await gestureRetry.promise;
  gesture.resolve();
  await gesture.promise;
  await Promise.resolve();
  assert.equal(gestureRecoveries, 1, 'the exact gesture lane can recover the suspended context');
  ordinary.resolve();
  await ordinary.promise;
  await Promise.resolve();
  assert.equal(coordinator.request(context), true,
    'real native settlement releases the ordinary owner for a future suspension');

  const detached = deferred();
  const retired = { state: 'suspended', resume: () => detached.promise };
  let staleSuccess = 0;
  coordinator.request(retired, false, () => { staleSuccess++; });
  coordinator.forget(retired);
  detached.resolve();
  await detached.promise;
  await Promise.resolve();
  assert.equal(staleSuccess, 0, 'forget fences a late resume settlement after exact context replacement');
}

{
  const coordinator = new ExactAudioContextResumeCoordinator();
  const remoteGestures = new AudioUnlockGestureDeduper();
  const voiceGestures = new AudioUnlockGestureDeduper();
  const context = { state: 'suspended', calls: 0, resume() { this.calls++; return new Promise(() => {}); } };
  coordinator.request(context); // one stuck ordinary watchdog owner
  const unlock = (event) => {
    // The same DOM event reaches both Engine unlock consumers. Each consumer must run for its own
    // resources, but their shared exact output context still spends only one physical lane.
    if (remoteGestures.accept(event)) coordinator.request(context, true);
    if (voiceGestures.accept(event)) coordinator.request(context, true);
  };
  unlock({ type: 'touchstart', timeStamp: 1_000 });
  unlock({ type: 'pointerdown', pointerType: 'touch', timeStamp: 1_001 });
  unlock({ type: 'click', detail: 1, timeStamp: 1_010 });
  assert.equal(context.calls, 2,
    'touchstart plus its pointer/click compatibility events consumes exactly one gesture lane');
  unlock({ type: 'touchstart', timeStamp: 1_100 });
  unlock({ type: 'pointerdown', pointerType: 'touch', timeStamp: 1_101 });
  unlock({ type: 'click', detail: 1, timeStamp: 1_110 });
  assert.equal(context.calls, 3, 'a second real touch consumes the one bounded gestureRetry lane');
  assert.equal(remoteGestures.accept({ type: 'keydown', timeStamp: 2_000, repeat: false }), true);
  assert.equal(remoteGestures.accept({ type: 'keydown', timeStamp: 2_010, repeat: true }), false,
    'holding one key cannot consume another browser gesture lane');
  assert.equal(remoteGestures.accept({ type: 'click', timeStamp: 2_020, detail: 0 }), false,
    'the compatibility click generated by keyboard activation is not a second gesture');
}

// A repeated queued channel tap must spend its fresh user activation on the exact owned context.
// A suspended context is resumed in place; a closed one is replaced and resumed synchronously.
{
  let creates = 0;
  const open = { state: 'suspended', resumes: 0, resume() { this.resumes++; return Promise.resolve(); } };
  const reused = resumeGestureAudioContext(open, () => { creates++; return open; });
  assert.equal(reused, open);
  assert.equal(open.resumes, 1, 'a live queued context consumes the repeated tap immediately');
  assert.equal(creates, 0, 'a live context is not replaced');

  const closed = { state: 'closed', resumes: 0, resume() { this.resumes++; return Promise.resolve(); } };
  const replacement = { state: 'suspended', resumes: 0, resume() { this.resumes++; return Promise.resolve(); } };
  const refreshed = resumeGestureAudioContext(closed, () => { creates++; return replacement; });
  assert.equal(refreshed, replacement);
  assert.equal(replacement.resumes, 1, 'the replacement is resumed inside the same repeated tap');
  assert.equal(closed.resumes, 0, 'a terminal context is never resumed');
  assert.equal(creates, 1);
  assert.equal(resumeGestureAudioContext(closed, () => { throw new Error('audio limit'); }), null,
    'creation failure never leaves a closed context looking usable');

  for (const staleState of ['interrupted', 'future-webkit-state']) {
    const stale = {
      state: staleState,
      resumes: 0,
      closes: 0,
      resume() { this.resumes++; return Promise.resolve(); },
      close() { this.closes++; return Promise.resolve(); },
    };
    const fresh = {
      state: 'suspended',
      resumes: 0,
      resume() { this.resumes++; return Promise.resolve(); },
    };
    const recovered = resumeGestureAudioContext(stale, () => { creates++; return fresh; });
    assert.equal(recovered, fresh, `${staleState} gesture preparation creates a fresh context`);
    assert.equal(stale.resumes, 0,
      `${staleState} context never consumes the user's recovery gesture`);
    assert.equal(stale.closes, 1, `${staleState} context is retired exactly once`);
    assert.equal(fresh.resumes, 1, 'the same gesture resumes the fresh replacement synchronously');
  }

  const invalidFresh = {
    state: 'interrupted',
    resumes: 0,
    closes: 0,
    resume() { this.resumes++; return Promise.resolve(); },
    close() { this.closes++; return Promise.resolve(); },
  };
  assert.equal(resumeGestureAudioContext(null, () => invalidFresh), null,
    'a newly-created interrupted context fails closed');
  assert.equal(invalidFresh.resumes, 0, 'an invalid fresh context does not spend the gesture on resume');
  assert.equal(invalidFresh.closes, 1, 'an invalid fresh context is retired exactly once');

  const firstGesture = deferred();
  const secondGesture = deferred();
  const backgrounded = {
    state: 'suspended',
    resumes: 0,
    resume() { this.resumes++; return this.resumes === 1 ? firstGesture.promise : secondGesture.promise; },
  };
  const queuedTapGestures = new AudioUnlockGestureDeduper();
  queuedTapGestures.accept({ type: 'click', timeStamp: 3_000, detail: 1 });
  resumeGestureAudioContext(backgrounded, () => backgrounded);
  queuedTapGestures.accept({ type: 'click', timeStamp: 4_000, detail: 1 });
  resumeGestureAudioContext(backgrounded, () => backgrounded);
  for (let tap = 0; tap < 100; tap++) {
    queuedTapGestures.accept({ type: 'click', timeStamp: 5_000 + tap * 1_000, detail: 1 });
    resumeGestureAudioContext(backgrounded, () => backgrounded);
  }
  assert.equal(backgrounded.resumes, 2,
    'an immediately-backgrounded initial gesture is retried once and further queued taps stay bounded');
  secondGesture.resolve(); firstGesture.resolve();
  await Promise.all([firstGesture.promise, secondGesture.promise]);
  await Promise.resolve();
}

// Shared speaking/VAD analyser graphs cannot be migrated to a replacement AudioContext. Preserve
// an interrupted exact context and spend the gesture on resuming it; only closed/missing is rebuilt.
{
  let creates = 0;
  const interrupted = {
    state: 'interrupted',
    resumes: 0,
    closes: 0,
    resume() { this.resumes++; return Promise.resolve(); },
    close() { this.closes++; return Promise.resolve(); },
  };
  const preserved = resumeSharedGestureAudioContext(interrupted, () => {
    creates++;
    throw new Error('must preserve exact analyser graph');
  });
  assert.equal(preserved, interrupted, 'an interrupted shared analyser context keeps exact identity');
  assert.equal(interrupted.resumes, 1, 'the gesture resumes the existing shared analyser graph');
  assert.equal(interrupted.closes, 0, 'shared analyser recovery never closes an interrupted context');
  assert.equal(creates, 0, 'shared analyser recovery does not create a stranded replacement graph');

  const closed = {
    state: 'closed',
    resumes: 0,
    closes: 0,
    resume() { this.resumes++; return Promise.resolve(); },
    close() { this.closes++; return Promise.resolve(); },
  };
  const replacement = {
    state: 'suspended',
    resumes: 0,
    resume() { this.resumes++; return Promise.resolve(); },
  };
  const refreshed = resumeSharedGestureAudioContext(closed, () => { creates++; return replacement; });
  assert.equal(refreshed, replacement, 'a closed shared analyser context is replaced');
  assert.equal(closed.resumes, 0, 'a closed shared analyser context is never resumed');
  assert.equal(closed.closes, 0, 'an already-closed shared analyser context is not closed twice');
  assert.equal(replacement.resumes, 1, 'the fresh shared analyser context resumes in the same gesture');
}

assert.equal(foregroundMicNeedsImmediateRecovery(true, false, true), true,
  'a background-muted track must be recovered immediately on foreground');
assert.equal(foregroundMicNeedsImmediateRecovery(true, true, false), true,
  'a background-ended track must be recovered immediately on foreground');
assert.equal(foregroundMicNeedsImmediateRecovery(false, false, true), false,
  'an ordinary transient mute still uses the route-change grace period');
assert.equal(foregroundMicNeedsImmediateRecovery(true, false, false, true), true,
  'an owned iOS capture is reacquired after background even when WebKit leaves stale live flags');

{
  const live = () => ({ readyState: 'live', muted: false });
  assert.deepEqual(microphoneTransportHealth(live(), live(), true, false),
    { ended: false, muted: false, upstreamPaused: false },
    'raw and processed tracks plus their exact active publication form one healthy transport');
  assert.equal(microphoneTransportHealth({ ...live(), muted: true }, live(), true, false).muted, true,
    'a muted raw gUM source is unhealthy');
  assert.equal(microphoneTransportHealth(live(), { ...live(), muted: true }, true, false).muted, true,
    'a muted MediaStreamDestination is unhealthy even while raw gUM still looks live');
  assert.equal(microphoneTransportHealth(live(), { readyState: 'ended' }, true, false).ended, true,
    'an ended published destination requires a full pipeline rebuild');
  assert.equal(microphoneTransportHealth(live(), live(), false, false).ended, true,
    'a track which is no longer the exact publication is stale');
  assert.deepEqual(microphoneTransportHealth(live(), live(), true, true),
    { ended: false, muted: true, upstreamPaused: true },
    'LiveKit sender=null is an immediate transport failure even when both JS tracks look live');
}

assert.equal(retainMicAvailabilityDuringRecovery(true, false), true,
  'a previously working microphone keeps its logical unmuted intent during a bounded rebuild');
assert.equal(retainMicAvailabilityDuringRecovery(true, true), false,
  'a microphone already known unavailable stays unavailable while retrying');
assert.equal(retainMicAvailabilityDuringRecovery(false, false), false,
  'an initial bootstrap without prior capture cannot claim transient availability');

assert.equal(reusableMicrophoneAudioContextState('running'), true,
  'a running gesture-created microphone context remains reusable');
assert.equal(reusableMicrophoneAudioContextState('suspended'), true,
  'a standard suspended context remains eligible for gesture resume');
assert.equal(reusableMicrophoneAudioContextState('interrupted'), false,
  'an iOS-interrupted context is rebuilt instead of publishing a silent destination');
assert.equal(reusableMicrophoneAudioContextState('closed'), false,
  'a closed microphone context is never reused');
assert.equal(reusableMicrophoneAudioContextState(undefined), false,
  'an unknown future context state fails closed to pipeline replacement');

assert.equal(await withVoiceTimeout(Promise.resolve('ok'), 50, 'resolved operation'), 'ok');
await assert.rejects(
  withVoiceTimeout(new Promise(() => {}), 5, 'stuck operation'),
  (error) => error instanceof VoiceOperationTimeoutError && isVoiceOperationTimeout(error),
  'a stuck voice operation must reject with a typed timeout',
);
await assert.rejects(
  withVoiceDeadline(new Promise(() => {}), Date.now() - 1, 'expired operation'),
  (error) => isVoiceOperationTimeout(error),
  'an already-expired absolute voice deadline must reject',
);

// The attribute write itself may complete successfully after a second tap has
// replaced its voice intent. Its old matching payload must not authorize the
// stale continuation which starts the local timer and clears the spinner.
{
  const write = deferred();
  let current = true;
  let matches = true;
  const committed = voiceWriteCommittedForCurrentIntent(
    write.promise,
    Date.now() + 1000,
    'deferred attributes',
    () => current,
    () => matches,
  );
  current = false;
  write.resolve();
  assert.equal(await committed, false, 'a late old attribute write cannot finalize a superseded intent');

  const currentWrite = deferred();
  current = true;
  matches = true;
  const accepted = voiceWriteCommittedForCurrentIntent(
    currentWrite.promise,
    Date.now() + 1000,
    'current attributes',
    () => current,
    () => matches,
  );
  currentWrite.resolve();
  assert.equal(await accepted, true, 'the unchanged current intent may finalize after its attributes match');
}

// getUserMedia ownership is single-flight even though the underlying browser
// promise is not cancellable. A stale finally must not clear the new owner.
{
  const ownership = new VoiceMicStartOwnership();
  assert.equal(ownership.begin(1), true);
  assert.equal(ownership.begin(2), false, 'a second microphone bootstrap cannot overlap the first');
  ownership.invalidate(1);
  assert.equal(ownership.begin(2), true, 'a timed-out generation can hand ownership to the current intent');
  ownership.finish(1);
  assert.equal(ownership.owner, 2, 'the late old completion cannot clear newer ownership');
  ownership.finish(2);
  assert.equal(ownership.active, false);
}

// Deferred old-channel capture completes after a switch has already installed
// the current owner. Only the current owner may finalize, and the old finally
// must not release it.
{
  const ownership = new VoiceMicStartOwnership();
  const oldCapture = deferred();
  const currentCapture = deferred();
  const run = async (owner, capture) => {
    if (!ownership.begin(owner)) return false;
    try {
      await capture.promise;
      return ownership.owner === owner;
    } finally {
      ownership.finish(owner);
    }
  };
  const oldResult = run(10, oldCapture);
  ownership.invalidate(10);
  const currentResult = run(11, currentCapture);
  oldCapture.resolve();
  assert.equal(await oldResult, false, 'late old-channel capture cannot finalize after a switch');
  assert.equal(ownership.owner, 11, 'late old-channel finally preserves the current bootstrap owner');
  currentCapture.resolve();
  assert.equal(await currentResult, true, 'the switched current intent receives and finalizes bootstrap');
  assert.equal(ownership.active, false);
}

assert.equal(automaticMicRecoveryAllowed(true, true, false, true), false,
  'a hidden PWA never starts automatic getUserMedia');
assert.equal(automaticMicRecoveryAllowed(false, false, false, false), false,
  'an initial permission denial remains stable listen-only');
assert.equal(automaticMicRecoveryAllowed(false, false, true, false), true,
  'a pending user bootstrap may continue on the visible current intent');
assert.equal(automaticMicRecoveryAllowed(false, false, false, true), true,
  'foreground recovery is allowed exactly when the hidden lifecycle armed it');
assert.equal(automaticMicRecoveryAllowed(false, true, false, false), true,
  'a microphone which worked before remains eligible for hardware recovery');

// Pagehide while WebKit keeps the old gUM unresolved: foreground replaces the exact observed
// owner, duplicate visibility/pageshow cannot stack, and a late old rejection cannot overwrite
// the current successful listen/talk state.
{
  const ownership = new VoiceMicStartOwnership();
  let micEpoch = 1;
  let foregroundGeneration = 0;
  let noMic = true;
  let captureStarts = 0;
  const old = deferred();
  ownership.begin(micEpoch);
  captureStarts++;
  const hiddenOwner = ownership.owner;
  const oldResult = old.promise.then(
    () => ownership.owner === hiddenOwner && micEpoch === hiddenOwner,
    () => ownership.owner === hiddenOwner && micEpoch === hiddenOwner,
  );
  // pageshow: supersede exactly what pagehide observed.
  if (ownership.owner === hiddenOwner) {
    micEpoch++;
    ownership.invalidate(hiddenOwner);
    foregroundGeneration++;
  }
  const currentOwner = micEpoch;
  assert.equal(ownership.begin(currentOwner), true);
  captureStarts++;
  // paired visibilitychange/pageshow sees a current visible owner and does not add a third start.
  assert.equal(ownership.begin(currentOwner + 1), false);
  noMic = false;
  ownership.finish(currentOwner);
  old.reject(new Error('late hidden NotFound'));
  assert.equal(await oldResult, false, 'late hidden gUM no longer owns UI state');
  if (await oldResult) noMic = true;
  assert.equal(noMic, false, 'late old failure cannot overwrite foreground success');
  assert.equal(foregroundGeneration, 1);
  assert.equal(captureStarts, 2, 'one old capture and exactly one visible replacement');
}

// One continuous reconnect recovery keeps the first absolute deadline even when LiveKit emits
// several replacement Reconnected events. Each event may replace verifySeq, never the deadline.
{
  const startedAt = 10_000;
  let recovery = null;
  let verifySeq = 0;
  const begin = (now) => {
    recovery ||= { deadline: now + VOICE_RECONNECT_VERIFY_TIMEOUT_MS };
    verifySeq++;
    return { seq: verifySeq, deadline: recovery.deadline };
  };
  const first = begin(startedAt);
  const second = begin(startedAt + 5_000);
  const third = begin(startedAt + 15_000);
  assert.equal(second.deadline, first.deadline);
  assert.equal(third.deadline, first.deadline);
  assert.equal(third.deadline, startedAt + VOICE_RECONNECT_VERIFY_TIMEOUT_MS,
    'flapping cannot extend continuous fail-closed verification');
  assert.equal(third.seq > second.seq, true, 'new verifier generations still neutralize old calls');
}

// A→B→C ordering model: once C supersedes B, B's deferred failure is stale and may neither roll
// back to optimistic B nor clear C's spinner. A current C failure is fail-closed disconnected.
{
  const state = { epoch: 1, channel: 'A', media: 'A', connecting: false, inVoice: true };
  const beginSwitch = (channel) => {
    const previous = state.channel;
    const epoch = ++state.epoch;
    state.channel = channel;
    state.connecting = true;
    return { epoch, previous, channel };
  };
  const b = beginSwitch('B');
  // joinVoice sees voiceConnecting and replaces the whole pending transaction rather than treating
  // optimistic B as a confirmed switch baseline.
  const c = { epoch: ++state.epoch, channel: 'C' };
  state.channel = 'C'; state.media = null; state.connecting = true;
  const fail = (intent) => {
    if (state.epoch !== intent.epoch || state.channel !== intent.channel) return false;
    state.inVoice = false; state.channel = null; state.media = null; state.connecting = false;
    return true;
  };
  assert.equal(fail(b), false, 'B failure cannot roll current intent back to optimistic B');
  assert.deepEqual(state, { epoch: c.epoch, channel: 'C', media: null, connecting: true, inVoice: true });
  assert.equal(fail(c), true);
  assert.deepEqual(state, { epoch: c.epoch, channel: null, media: null, connecting: false, inVoice: false });
}

// Settings preview ownership model: hidden/pagehide stops capture, paired foreground events start
// once, joining cancels it, terminal cleanup restarts it only after settling, and logout fences it.
{
  const preview = { epoch: 0, owner: 0, live: false, pending: false, listeners: 1, inVoice: false, active: true, starts: 0 };
  const start = () => {
    if (!preview.active || preview.inVoice || !preview.listeners || preview.owner || preview.live) return;
    preview.owner = ++preview.epoch; preview.starts++;
  };
  const stop = (preserve = false) => {
    preview.epoch++; preview.owner = 0; preview.live = false;
    if (!preserve) preview.pending = false;
  };
  const hide = () => { preview.pending = true; stop(true); };
  const visible = () => {
    if (!preview.pending) return;
    preview.pending = false; start();
  };
  start(); preview.live = true; preview.owner = 0;
  hide();
  visible(); visible();
  assert.equal(preview.starts, 2, 'paired visible events reacquire preview exactly once');
  preview.inVoice = true; stop();
  assert.equal(preview.live, false, 'joining voice retires settings capture');
  preview.inVoice = false;
  const cleanup = deferred();
  const restartAfterCleanup = cleanup.promise.finally(() => start());
  assert.equal(preview.starts, 2, 'terminal exit waits for microphone cleanup before preview');
  cleanup.resolve(); await restartAfterCleanup;
  assert.equal(preview.starts, 3);
  stop();
  const logoutCleanup = deferred();
  const fencedRestart = logoutCleanup.promise.finally(() => start());
  preview.active = false;
  logoutCleanup.resolve(); await fencedRestart;
  assert.equal(preview.starts, 3, 'logout cannot resurrect settings capture');
}

// Behavioral foreground model: any number of hidden lifecycle/watchdog events
// perform zero capture starts; duplicate visibility/pageshow events share one
// owner and therefore perform exactly one current-intent start.
{
  const ownership = new VoiceMicStartOwnership();
  let starts = 0;
  let sequence = 0;
  const recover = (hidden, pending) => {
    if (!automaticMicRecoveryAllowed(hidden, false, false, pending)) return false;
    const owner = ++sequence;
    if (!ownership.begin(owner)) return false;
    starts++;
    return true;
  };
  for (let tick = 0; tick < 5; tick++) assert.equal(recover(true, true), false);
  assert.equal(starts, 0, 'hidden mute/watchdog events never start capture');
  assert.equal(recover(false, true), true);
  assert.equal(recover(false, true), false);
  assert.equal(starts, 1, 'visibilitychange plus pageshow still start only one recovery');
}

{
  let attempts = 0;
  // Terminal initial denial clears both bootstrapWanted and foregroundPending.
  for (let watchdog = 0; watchdog < 20; watchdog++) {
    if (automaticMicRecoveryAllowed(false, false, false, false)) attempts++;
  }
  assert.equal(attempts, 0, 'listen-only denial cannot auto-prompt on later watchdog ticks');
}

console.log('mic lifecycle: ok');

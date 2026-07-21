import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chatScroll.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  CHAT_BOTTOM_ENTER_PX,
  CHAT_BOTTOM_LEAVE_PX,
  CHAT_PHYSICAL_BOTTOM_EPSILON_PX,
  INITIAL_CHAT_TAIL_SETTLE,
  CHAT_TAIL_RESERVE_PX,
  CHAT_TAIL_MAX_WRITES,
  CHAT_TAIL_MAX_SAME_TARGET_WRITES,
  INITIAL_CHAT_PREPEND_SETTLE,
  CHAT_PREPEND_WARMUP_FRAMES,
  CHAT_SESSION_MESSAGE_LIMIT,
  advanceChatPrependSettle,
  canStartChatPrepend,
  canCorrectChatPrependAnchor,
  chatAppendFrontTrim,
  chatBottomDistance,
  classifyChatPrepend,
  classifyChatPrependLifecycle,
  chatPhysicalMaxScrollTop,
  chatPrependAnchorDelta,
  isChatPrependGeometryStable,
  isChatPrependGeometryStreakStable,
  chatRetentionLimitAfterProtectedInsert,
  chatTailIndexLocation,
  chatVirtualFirstItemIndex,
  reduceChatScrollState,
  reduceChatTailSettle,
} = await import('data:text/javascript,' + encodeURIComponent(code));

let passed = 0;
let failed = 0;

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log('  actual:', actual, '\n  expected:', expected);
  ok ? passed++ : failed++;
}

equal('distance is measured from the physical tail', chatBottomDistance({
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTop: 575,
}), 25);
equal('rubber-band overscroll is clamped', chatBottomDistance({
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTop: 604,
}), 0);
equal('physical maximum is independent from current scroll position', chatPhysicalMaxScrollTop({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 17,
}), 612);
equal('a footer measured after the first scroll exposes the exact regression gap', chatBottomDistance({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}), CHAT_TAIL_RESERVE_PX);

equal('the initial tail target covers the asynchronously measured footer',
  chatTailIndexLocation(29), {
    index: 29,
    align: 'end',
    offset: CHAT_TAIL_RESERVE_PX,
    behavior: 'auto',
  });
equal('a smooth tail jump keeps the same exact footer reserve',
  chatTailIndexLocation('LAST', 'smooth'), {
    index: 'LAST',
    align: 'end',
    offset: CHAT_TAIL_RESERVE_PX,
    behavior: 'smooth',
  });

equal('a detached reader re-arms inside the enter zone', reduceChatScrollState(
  { atBottom: false, following: false },
  CHAT_BOTTOM_ENTER_PX,
  'down',
), { atBottom: true, following: true });

equal('being just outside the enter zone does not clear unread', reduceChatScrollState(
  { atBottom: false, following: false },
  CHAT_BOTTOM_ENTER_PX + 0.1,
  'down',
), { atBottom: false, following: false });

equal('one-pixel upward movement keeps the stable tail state', reduceChatScrollState(
  { atBottom: true, following: true },
  1,
  'up',
), { atBottom: true, following: true });

equal('fractional resize inside hysteresis does not flicker', reduceChatScrollState(
  { atBottom: true, following: true },
  CHAT_BOTTOM_ENTER_PX + 0.5,
  'none',
), { atBottom: true, following: true });

equal('an intentional upward scroll beyond the leave zone detaches', reduceChatScrollState(
  { atBottom: true, following: true },
  CHAT_BOTTOM_LEAVE_PX + 1,
  'up',
), { atBottom: false, following: false });

equal('a late resize cannot detach follow intent by itself', reduceChatScrollState(
  { atBottom: true, following: true },
  500,
  'none',
), { atBottom: false, following: true });

equal('history reading remains detached away from the tail', reduceChatScrollState(
  { atBottom: false, following: false },
  500,
  'none',
), { atBottom: false, following: false });

equal('a smooth jump to history cannot re-arm on its first near-bottom frame', reduceChatScrollState(
  { atBottom: false, following: false },
  1,
  'none',
  true,
), { atBottom: false, following: false });

equal('an explicit downward intent can re-arm after the history-jump fence is cleared', reduceChatScrollState(
  { atBottom: false, following: false },
  CHAT_BOTTOM_ENTER_PX,
  'down',
  false,
), { atBottom: true, following: true });

const settleInput = (geometry, extra = {}) => ({
  geometry,
  ready: true,
  scrolling: false,
  following: true,
  direction: 'none',
  rearmBlocked: false,
  prepend: false,
  ...extra,
});

let settle = INITIAL_CHAT_TAIL_SETTLE;
let decision = reduceChatTailSettle(settle, settleInput({
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTop: 600,
}));
equal('tail settle waits for a second stable layout frame', {
  phase: decision.state.phase,
  scrollTop: decision.scrollTop,
  stableFrames: decision.state.stableFrames,
}, { phase: 'waiting', scrollTop: null, stableFrames: 1 });

settle = decision.state;
decision = reduceChatTailSettle(settle, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
equal('a newly measured footer restarts stability instead of accepting a stale bottom', {
  phase: decision.state.phase,
  scrollTop: decision.scrollTop,
  stableFrames: decision.state.stableFrames,
}, { phase: 'waiting', scrollTop: null, stableFrames: 1 });

settle = decision.state;
decision = reduceChatTailSettle(settle, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
equal('stable physical geometry emits one exact browser target', {
  phase: decision.state.phase,
  scrollTop: decision.scrollTop,
  writes: decision.state.writes,
}, { phase: 'targeting', scrollTop: 612, writes: 1 });

settle = decision.state;
decision = reduceChatTailSettle(settle, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
equal('a same-target retry waits for another stable pair', {
  scrollTop: decision.scrollTop,
  writes: decision.state.writes,
  keepSampling: decision.keepSampling,
}, { scrollTop: null, writes: 1, keepSampling: true });

settle = decision.state;
decision = reduceChatTailSettle(settle, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 612 - CHAT_PHYSICAL_BOTTOM_EPSILON_PX / 2,
}));
equal('physical confirmation permanently settles the attempt', {
  phase: decision.state.phase,
  scrollTop: decision.scrollTop,
  keepSampling: decision.keepSampling,
}, { phase: 'settled', scrollTop: null, keepSampling: false });
equal('a settled attempt ignores later frames', reduceChatTailSettle(decision.state, settleInput({
  scrollHeight: 1200,
  clientHeight: 400,
  scrollTop: 612,
})), { state: decision.state, scrollTop: null, keepSampling: false });

let beforeFooter = INITIAL_CHAT_TAIL_SETTLE;
for (let frame = 0; frame < 4; frame++) {
  beforeFooter = reduceChatTailSettle(beforeFooter, settleInput({
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  }, { ready: false })).state;
}
equal('pre-footer frames cannot settle while physical geometry is not ready', {
  phase: beforeFooter.phase,
  writes: beforeFooter.writes,
}, { phase: 'waiting', writes: 0 });
let lateFooter = reduceChatTailSettle(beforeFooter, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
lateFooter = reduceChatTailSettle(lateFooter.state, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
equal('a footer arriving after several zero-distance frames still gets an exact target', {
  phase: lateFooter.state.phase,
  scrollTop: lateFooter.scrollTop,
}, { phase: 'targeting', scrollTop: 612 });

const notReady = reduceChatTailSettle({
  ...INITIAL_CHAT_TAIL_SETTLE,
  observedMax: 612,
  stableFrames: 1,
}, settleInput({ scrollHeight: 1012, clientHeight: 400, scrollTop: 600 }, { ready: false }));
equal('an unready layout resets consecutive stability', {
  stableFrames: notReady.state.stableFrames,
  scrollTop: notReady.scrollTop,
  keepSampling: notReady.keepSampling,
}, { stableFrames: 0, scrollTop: null, keepSampling: true });
const whileScrolling = reduceChatTailSettle({
  ...INITIAL_CHAT_TAIL_SETTLE,
  observedMax: 612,
  stableFrames: 1,
}, settleInput({ scrollHeight: 1012, clientHeight: 400, scrollTop: 600 }, { scrolling: true }));
equal('active Virtuoso scrolling resets consecutive stability', {
  stableFrames: whileScrolling.state.stableFrames,
  scrollTop: whileScrolling.scrollTop,
  keepSampling: whileScrolling.keepSampling,
}, { stableFrames: 0, scrollTop: null, keepSampling: true });

for (const [name, extra] of [
  ['detached follow', { following: false }],
  ['manual upward input', { direction: 'up' }],
  ['history jump fence', { rearmBlocked: true }],
  ['history prepend', { prepend: true }],
]) {
  const blocked = reduceChatTailSettle(INITIAL_CHAT_TAIL_SETTLE, settleInput({
    scrollHeight: 1012,
    clientHeight: 400,
    scrollTop: 600,
  }, extra));
  equal(`${name} cancels tail convergence without a write`, {
    phase: blocked.state.phase,
    scrollTop: blocked.scrollTop,
    keepSampling: blocked.keepSampling,
  }, { phase: 'cancelled', scrollTop: null, keepSampling: false });
}

let targetedBeforeGuard = reduceChatTailSettle(INITIAL_CHAT_TAIL_SETTLE, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
targetedBeforeGuard = reduceChatTailSettle(targetedBeforeGuard.state, settleInput({
  scrollHeight: 1012,
  clientHeight: 400,
  scrollTop: 600,
}));
for (const [name, extra] of [
  ['detach after targeting', { following: false }],
  ['upward input after targeting', { direction: 'up' }],
  ['history fence after targeting', { rearmBlocked: true }],
  ['prepend after targeting', { prepend: true }],
]) {
  const blocked = reduceChatTailSettle(targetedBeforeGuard.state, settleInput({
    scrollHeight: 1012,
    clientHeight: 400,
    scrollTop: 612,
  }, extra));
  equal(`${name} cancels before physical confirmation`, {
    phase: blocked.state.phase,
    scrollTop: blocked.scrollTop,
  }, { phase: 'cancelled', scrollTop: null });
}

let retarget = reduceChatTailSettle(INITIAL_CHAT_TAIL_SETTLE, settleInput({
  scrollHeight: 1012, clientHeight: 400, scrollTop: 600,
}));
retarget = reduceChatTailSettle(retarget.state, settleInput({
  scrollHeight: 1012, clientHeight: 400, scrollTop: 600,
}));
retarget = reduceChatTailSettle(retarget.state, settleInput({
  scrollHeight: 1032, clientHeight: 400, scrollTop: 612,
}));
retarget = reduceChatTailSettle(retarget.state, settleInput({
  scrollHeight: 1032, clientHeight: 400, scrollTop: 612,
}));
equal('a changed physical maximum permits exactly one retarget', {
  scrollTop: retarget.scrollTop,
  writes: retarget.state.writes,
}, { scrollTop: 632, writes: 2 });
retarget = reduceChatTailSettle(retarget.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
retarget = reduceChatTailSettle(retarget.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
equal('a third unique layout growth is followed without repeating an old target', {
  phase: retarget.state.phase,
  scrollTop: retarget.scrollTop,
  writes: retarget.state.writes,
}, { phase: 'targeting', scrollTop: 652, writes: 3 });
const repeatedThirdTarget = reduceChatTailSettle(retarget.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
equal('the newest retarget is also written only once', {
  scrollTop: repeatedThirdTarget.scrollTop,
  writes: repeatedThirdTarget.state.writes,
}, { scrollTop: null, writes: 3 });

let sameTargetRetry = reduceChatTailSettle(repeatedThirdTarget.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
equal('the first delayed pullback gets a second exact target write', {
  phase: sameTargetRetry.state.phase,
  scrollTop: sameTargetRetry.scrollTop,
  targetWrites: sameTargetRetry.state.targetWrites,
}, { phase: 'targeting', scrollTop: 652, targetWrites: 2 });
sameTargetRetry = reduceChatTailSettle(sameTargetRetry.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
sameTargetRetry = reduceChatTailSettle(sameTargetRetry.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
equal('the second delayed pullback gets the final bounded repair', {
  phase: sameTargetRetry.state.phase,
  scrollTop: sameTargetRetry.scrollTop,
  targetWrites: sameTargetRetry.state.targetWrites,
}, { phase: 'targeting', scrollTop: 652, targetWrites: CHAT_TAIL_MAX_SAME_TARGET_WRITES });
const sameTargetCapState = sameTargetRetry.state;
sameTargetRetry = reduceChatTailSettle(sameTargetRetry.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 652,
}));
sameTargetRetry = reduceChatTailSettle(sameTargetRetry.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 652,
}));
equal('physical confirmation settles after repeated pullbacks', {
  phase: sameTargetRetry.state.phase,
  scrollTop: sameTargetRetry.scrollTop,
  keepSampling: sameTargetRetry.keepSampling,
}, { phase: 'settled', scrollTop: null, keepSampling: false });

let rejectedSameTarget = reduceChatTailSettle(sameTargetCapState, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
rejectedSameTarget = reduceChatTailSettle(rejectedSameTarget.state, settleInput({
  scrollHeight: 1052, clientHeight: 400, scrollTop: 632,
}));
equal('a third pullback cancels without starting a visible retry loop', {
  phase: rejectedSameTarget.state.phase,
  scrollTop: rejectedSameTarget.scrollTop,
  keepSampling: rejectedSameTarget.keepSampling,
}, { phase: 'cancelled', scrollTop: null, keepSampling: false });

let changedAfterSameTargetCap = reduceChatTailSettle(sameTargetCapState, settleInput({
  scrollHeight: 1072, clientHeight: 400, scrollTop: 652,
}));
changedAfterSameTargetCap = reduceChatTailSettle(changedAfterSameTargetCap.state, settleInput({
  scrollHeight: 1072, clientHeight: 400, scrollTop: 652,
}));
equal('new physical growth remains eligible after the old target used its repair budget', {
  phase: changedAfterSameTargetCap.state.phase,
  scrollTop: changedAfterSameTargetCap.scrollTop,
  targetWrites: changedAfterSameTargetCap.state.targetWrites,
}, { phase: 'targeting', scrollTop: 672, targetWrites: 1 });

let writeCap = reduceChatTailSettle({
  ...INITIAL_CHAT_TAIL_SETTLE,
  phase: 'targeting',
  observedMax: 612,
  targetScrollTop: 612,
  targetWrites: 1,
  writes: CHAT_TAIL_MAX_WRITES,
}, settleInput({ scrollHeight: 1032, clientHeight: 400, scrollTop: 612 }));
writeCap = reduceChatTailSettle(writeCap.state,
  settleInput({ scrollHeight: 1032, clientHeight: 400, scrollTop: 612 }));
equal('the hard write cap prevents a resize loop from becoming scroll jitter', {
  phase: writeCap.state.phase,
  scrollTop: writeCap.scrollTop,
  keepSampling: writeCap.keepSampling,
}, { phase: 'cancelled', scrollTop: null, keepSampling: false });

equal('atomic prepend keeps existing absolute indices stable', {
  before: chatVirtualFirstItemIndex(1_000_000, 30, 0) + 10,
  after: chatVirtualFirstItemIndex(1_000_000, 35, 0) + 15,
}, { before: 999980, after: 999980 });
equal('front trimming moves the virtual base forward',
  chatVirtualFirstItemIndex(1_000_000, 35, 7), 999972);
equal('prepend anchor correction preserves the viewport pixel',
  chatPrependAnchorDelta(84.5, 101.25), 16.75);
equal('invalid anchor measurements never write scroll position',
  chatPrependAnchorDelta(Number.NaN, 101.25), 0);

equal('custom prepend correction waits through both Virtuoso frames', [
  canCorrectChatPrependAnchor(0, Number.NaN),
  canCorrectChatPrependAnchor(1, Number.NaN),
  canCorrectChatPrependAnchor(CHAT_PREPEND_WARMUP_FRAMES, Number.NaN),
], [false, false, true]);
equal('an active Virtuoso deviation keeps custom correction fenced', [
  canCorrectChatPrependAnchor(CHAT_PREPEND_WARMUP_FRAMES, 18.5),
  canCorrectChatPrependAnchor(CHAT_PREPEND_WARMUP_FRAMES + 1, -0.75),
  canCorrectChatPrependAnchor(CHAT_PREPEND_WARMUP_FRAMES, 0.5001),
  canCorrectChatPrependAnchor(CHAT_PREPEND_WARMUP_FRAMES, 0.5),
  canCorrectChatPrependAnchor(CHAT_PREPEND_WARMUP_FRAMES + 1, 0),
], [false, false, false, true, true]);

const oscillatingPrevious = {
  scrollHeight: 1200, clientHeight: 500, scrollTop: 300, anchorTop: 95.5,
};
const oscillatingCurrent = {
  scrollHeight: 1200, clientHeight: 500, scrollTop: 300, anchorTop: 96.5,
};
equal('a one-pixel anchor oscillation is not stable even inside target tolerance',
  isChatPrependGeometryStable(oscillatingPrevious, oscillatingCurrent, 96), false);
equal('an unchanged anchor inside target tolerance is stable',
  isChatPrependGeometryStable(oscillatingCurrent, oscillatingCurrent, 96), true);
const driftingSamples = [96.5, 96.1, 95.7, 95.5].map((anchorTop) => ({
  scrollHeight: 1200, clientHeight: 500, scrollTop: 300, anchorTop,
}));
equal('sub-pixel drift cannot accumulate across the stable streak', [
  isChatPrependGeometryStreakStable(driftingSamples[0], driftingSamples[0], driftingSamples[1], 96),
  isChatPrependGeometryStreakStable(driftingSamples[1], driftingSamples[0], driftingSamples[2], 96),
  isChatPrependGeometryStreakStable(driftingSamples[2], driftingSamples[0], driftingSamples[3], 96),
], [true, false, false]);

let prependProgress = INITIAL_CHAT_PREPEND_SETTLE;
let prependDecision;
for (let correction = 0; correction < 5; correction++) {
  prependDecision = advanceChatPrependSettle(prependProgress, false, true);
  prependProgress = prependDecision.progress;
}
equal('a fifth prepend correction stays inside the finite settle transaction', {
  done: prependDecision.done,
  frames: prependProgress.frames,
  stableFrames: prependProgress.stableFrames,
}, { done: false, frames: 5, stableFrames: 0 });
for (let stable = 0; stable < 3; stable++) {
  prependDecision = advanceChatPrependSettle(prependProgress, true, false);
  prependProgress = prependDecision.progress;
}
equal('prepend finishes only after three stable frames following the last correction', {
  done: prependDecision.done,
  frames: prependProgress.frames,
  stableFrames: prependProgress.stableFrames,
}, { done: true, frames: 8, stableFrames: 3 });

const almostSettledPrepend = { frames: 8, stableFrames: 2 };
equal('a late correction resets an almost-settled prepend transaction',
  advanceChatPrependSettle(almostSettledPrepend, true, true), {
    progress: { frames: 9, stableFrames: 0 }, done: false,
  });
equal('an unresolved visual offset resets stability even with unchanged outer geometry',
  advanceChatPrependSettle(almostSettledPrepend, false, false), {
    progress: { frames: 9, stableFrames: 0 }, done: false,
  });
equal('the prepend frame deadline remains a hard bound', [
  advanceChatPrependSettle({ frames: 52, stableFrames: 0 }, false, true).done,
  advanceChatPrependSettle({ frames: 53, stableFrames: 0 }, false, true).done,
], [false, true]);

equal('ordinary live history keeps the normal bounded session window', [
  chatAppendFrontTrim(CHAT_SESSION_MESSAGE_LIMIT, CHAT_SESSION_MESSAGE_LIMIT),
  chatAppendFrontTrim(CHAT_SESSION_MESSAGE_LIMIT + 1, CHAT_SESSION_MESSAGE_LIMIT),
], [0, 1]);
const retainedAfterPrepend = chatRetentionLimitAfterProtectedInsert(
  CHAT_SESSION_MESSAGE_LIMIT,
  CHAT_SESSION_MESSAGE_LIMIT + 30,
  30,
  CHAT_SESSION_MESSAGE_LIMIT,
);
equal('a loaded history page reserves a full live window before any front trim', {
  limit: retainedAfterPrepend,
  firstAppendTrim: chatAppendFrontTrim(CHAT_SESSION_MESSAGE_LIMIT + 31, retainedAfterPrepend),
  lastReservedAppendTrim: chatAppendFrontTrim(CHAT_SESSION_MESSAGE_LIMIT * 2 + 30, retainedAfterPrepend),
  firstOverflowTrim: chatAppendFrontTrim(CHAT_SESSION_MESSAGE_LIMIT * 2 + 31, retainedAfterPrepend),
}, {
  limit: CHAT_SESSION_MESSAGE_LIMIT * 2 + 30,
  firstAppendTrim: 0,
  lastReservedAppendTrim: 0,
  firstOverflowTrim: 1,
});
equal('later history pages add only their own rows and keep the remaining reserve bounded',
  chatRetentionLimitAfterProtectedInsert(
    retainedAfterPrepend,
    CHAT_SESSION_MESSAGE_LIMIT + 560,
    30,
    0,
  ), CHAT_SESSION_MESSAGE_LIMIT * 2 + 60);
const reconnectRetention = chatRetentionLimitAfterProtectedInsert(
  CHAT_SESSION_MESSAGE_LIMIT,
  1040,
  0,
  CHAT_SESSION_MESSAGE_LIMIT,
);
equal('a reconnect suffix batch preserves the current anchor and receives one bounded reserve', {
  limit: reconnectRetention,
  batchTrim: chatAppendFrontTrim(1040, reconnectRetention),
  nextAppendTrim: chatAppendFrontTrim(1041, reconnectRetention),
  invalidLimitFallback: chatAppendFrontTrim(CHAT_SESSION_MESSAGE_LIMIT + 1, Number.NaN),
}, {
  limit: 2040,
  batchTrim: 0,
  nextAppendTrim: 0,
  invalidLimitFallback: 1,
});

equal('a prepend starts only when neither request nor viewport guard is active', [
  canStartChatPrepend(false, false),
  canStartChatPrepend(true, false),
  canStartChatPrepend(false, true),
  canStartChatPrepend(true, true),
], [true, false, false, false]);

const committedLifecycle = {
  serverId: 'alpha',
  historyGeneration: 7,
  committed: true,
  targetPrepended: 35,
};
equal('an exact committed prepend is ready to settle', classifyChatPrependLifecycle(
  committedLifecycle,
  { serverId: 'alpha', historyGeneration: 7, prepended: 35 },
), 'settle');
equal('a history generation change cancels before the first layout frame', classifyChatPrependLifecycle(
  committedLifecycle,
  { serverId: 'alpha', historyGeneration: 8, prepended: 0 },
), 'cancel');
equal('a server change cancels before the first layout frame', classifyChatPrependLifecycle(
  committedLifecycle,
  { serverId: 'beta', historyGeneration: 7, prepended: 35 },
), 'cancel');
equal('a mismatched committed target cancels instead of leaving a guard behind', classifyChatPrependLifecycle(
  committedLifecycle,
  { serverId: 'alpha', historyGeneration: 7, prepended: 34 },
), 'cancel');
equal('an in-scope request waits until its prepend is committed', classifyChatPrependLifecycle(
  { ...committedLifecycle, committed: false, targetPrepended: null },
  { serverId: 'alpha', historyGeneration: 7, prepended: 30 },
), 'wait');

const atomicPrepend = classifyChatPrepend({
  count: 40,
  prepended: 30,
  trimmed: 0,
  firstItemIndex: 999970,
}, {
  count: 45,
  prepended: 35,
  trimmed: 0,
  firstItemIndex: 999965,
}, 10);
equal('a single atomic prepend snapshot preserves the visible absolute item and blocks tail writes', atomicPrepend, {
  kind: 'prepend',
  inserted: 5,
  valid: true,
  anchorPreserved: true,
  allowFollow: false,
  allowTailSettle: false,
});
equal('a data-only prepend is rejected and still cannot follow the tail', classifyChatPrepend({
  count: 40,
  prepended: 30,
  trimmed: 0,
  firstItemIndex: 999970,
}, {
  count: 45,
  prepended: 30,
  trimmed: 0,
  firstItemIndex: 999970,
}, 10), {
  kind: 'prepend',
  inserted: 5,
  valid: false,
  anchorPreserved: false,
  allowFollow: false,
  allowTailSettle: false,
});

console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed ? 1 : 0);

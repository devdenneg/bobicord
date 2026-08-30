import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'rtcStatsSampler.ts'), 'utf8');
const treeSource = readFileSync(join(here, 'transport', 'treeVideo.ts'), 'utf8');
const diagSource = readFileSync(join(here, 'diag.ts'), 'utf8');
const serverViewSource = readFileSync(join(here, 'components', 'ServerView.tsx'), 'utf8');
const livekitVideoSource = readFileSync(join(here, 'transport', 'livekitVideo.ts'), 'utf8');
const probeSource = readFileSync(join(here, 'transport', 'probe.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ExactPeerStatsSampler, sampleRtcRecoveryStats } = await import('data:text/javascript,' + encodeURIComponent(js));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

// Hundreds of timer/UI/diagnostic callers over one hung native operation still create exactly one
// physical getStats request. Ownership is released only by the real browser promise settling.
{
  const sampler = new ExactPeerStatsSampler(4);
  const pending = deferred();
  const pc = {};
  let calls = 0;
  const reads = Array.from({ length: 100 }, () => sampler.sample(pc, () => { calls++; return pending.promise; }));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(sampler.activeCount, 1);
  pending.resolve('report-a');
  assert.deepEqual(await Promise.all(reads), Array(100).fill('report-a'));
  assert.equal(sampler.activeCount, 0);
  assert.equal(await sampler.sample(pc, async () => { calls++; return 'report-b'; }), 'report-b');
  assert.equal(calls, 2, 'a truly settled peer may take a fresh sample');
}

// Abandoned exact peers are globally capped. A current media session never allocates unbounded
// native promises just because several old radios ignored cancellation.
{
  const sampler = new ExactPeerStatsSampler(2);
  const a = deferred(); const b = deferred();
  let calls = 0;
  void sampler.sample({}, () => { calls++; return a.promise; });
  void sampler.sample({}, () => { calls++; return b.promise; });
  await Promise.resolve();
  const skipped = await sampler.sample({}, async () => { calls++; return 'should-not-run'; });
  assert.equal(skipped, null);
  assert.equal(calls, 2);
  a.resolve('a'); b.resolve('b');
  await Promise.all([a.promise, b.promise]);
  await Promise.resolve();
}

// Regular diagnostics cannot consume the reserved current-media recovery lane, while the absolute
// number of uncancellable browser operations remains capped across both priorities.
{
  const sampler = new ExactPeerStatsSampler(3, 1);
  const a = deferred(); const b = deferred(); const recoveryPending = deferred();
  let calls = 0;
  void sampler.sample({}, () => { calls++; return a.promise; });
  void sampler.sample({}, () => { calls++; return b.promise; });
  await Promise.resolve();
  assert.equal(await sampler.sample({}, async () => { calls++; return 'regular-overflow'; }), null);
  const recovery = sampler.request({}, () => { calls++; return recoveryPending.promise; }, 'recovery');
  assert.equal(recovery.admitted, true, 'one physical slot is reserved for media recovery');
  await Promise.resolve();
  const saturated = sampler.request({}, async () => { calls++; return 'recovery-overflow'; }, 'recovery');
  assert.equal(saturated.admitted, false, 'both lanes still obey one absolute native-call cap');
  assert.equal(await saturated.result, null);
  assert.equal(calls, 3);
  a.resolve('a'); b.resolve('b'); recoveryPending.resolve('r');
  await Promise.all([a.promise, b.promise, recovery.result]);
  await Promise.resolve();
}

// A recovery deadline settles logical detector ownership without spawning or attaching repeatedly
// to the same truly hung browser promise. Real native settlement alone permits a fresh request.
{
  const pending = deferred();
  let calls = 0;
  const pc = { getStats: () => { calls++; return pending.promise; } };
  const first = sampleRtcRecoveryStats(pc, 0);
  assert.deepEqual(await first, { report: null, unavailable: 'timeout' });
  const repeated = sampleRtcRecoveryStats(pc, 0);
  assert.equal(repeated, first, 'the exact timed-out peer reuses one settled logical view');
  assert.deepEqual(await repeated, { report: null, unavailable: 'timeout' });
  assert.equal(calls, 1, 'a timer cannot multiply the underlying native request');
  pending.resolve('late-report');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await sampleRtcRecoveryStats(pc, 50), { report: 'late-report', unavailable: null });
  assert.equal(calls, 2, 'real settlement releases exact-peer recovery ownership');
}

// Rejection is cosmetic, returns null and frees the exact slot for recovery.
{
  const sampler = new ExactPeerStatsSampler(1);
  const pc = {};
  assert.equal(await sampler.sample(pc, async () => { throw new Error('closed'); }), null);
  assert.equal(sampler.activeCount, 0);
  assert.equal(await sampler.sample(pc, async () => 'recovered'), 'recovered');
}

// Recovery cannot silently treat a repeatedly throwing current peer as a healthy empty report.
{
  const pc = { getStats: async () => { throw new Error('current peer stats failed'); } };
  assert.deepEqual(await sampleRtcRecoveryStats(pc, 50), { report: null, unavailable: 'failed' });
}

// The production wrapper exposes absolute saturation without starting a ninth browser operation,
// then admits the exact current peer after real old-peer settlement releases capacity.
{
  const blocked = Array.from({ length: 8 }, () => deferred());
  const peers = blocked.map((pending) => ({ getStats: () => pending.promise }));
  for (const peer of peers) {
    assert.deepEqual(await sampleRtcRecoveryStats(peer, 0), { report: null, unavailable: 'timeout' });
  }
  let currentCalls = 0;
  const current = { getStats: async () => { currentCalls++; return 'current-report'; } };
  assert.deepEqual(await sampleRtcRecoveryStats(current, 50), { report: null, unavailable: 'saturated' });
  assert.equal(currentCalls, 0, 'saturation fallback never exceeds the absolute native-call cap');
  blocked.forEach((pending) => pending.resolve('old-report'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await sampleRtcRecoveryStats(current, 50), { report: 'current-report', unavailable: null });
  assert.equal(currentCalls, 1, 'real settlement restores current-peer recovery admission');
}

// All consumers must use bounded samplers and fence the exact PC/session after
// await. This binds the ownership primitive above to the production mutation points.
assert.doesNotMatch(treeSource, /\.getStats\(\)/,
  'tree overlay and drop detector cannot issue independent native getStats calls');
assert.match(treeSource, /const report = await sampleRtcStats\(pc\)[\s\S]*currentWatchPc\(streamId\) !== pc/,
  'tree stats discard a late report from a replaced parent before jitter state mutation');
assert.match(treeSource, /checkStreamDrops[\s\S]*await sampleRtcRecoveryStats\(pc\)[\s\S]*currentWatchPc\(streamId\) !== pc[\s\S]*win\.push/,
  'drop self-heal/reparent state is fenced to the exact current PC');
assert.match(treeSource, /recoverFromStatsUnavailable[\s\S]*STATS_UNAVAILABLE_BACKOFF_MAX_MS[\s\S]*unwatch\(streamId, \{ keepVideo: true \}\)[\s\S]*watch\(streamId, quality, pinned\)/,
  'a saturated or timed-out recovery lane performs a bounded exact-stream re-watch');
assert.match(treeSource, /statsRecoveryBackoff[\s\S]*nextStatsUnavailableRecoveryAt/,
  'multi-stream saturation is exponentially backed off and globally staggered');
assert.match(treeSource, /clearDropState[\s\S]*dropChecks\.delete\(streamId\)/,
  'closing many unique streams releases their per-stream continuation owners');
assert.doesNotMatch(diagSource, /pc\.getStats\(\)/,
  'viewer diagnostics share the same native getStats request');
assert.match(diagSource, /const sample = await sampleInbound\(pc\)[\s\S]*sessions\.get\(k\) !== session \|\| getPc\(\) !== pc/,
  'late old-parent diagnostics cannot enter a replacement session');
assert.match(diagSource, /setTimeout[\s\S]*settle-driven/,
  'diagnostic polling schedules only after the previous browser request settles');
assert.match(serverViewSource, /if \(!statsOn\) \{ setStats\(''\); return; \}/,
  'the optional stats overlay performs no WebRTC polling while hidden');
assert.match(serverViewSource, /setTimeout[\s\S]*Schedule after real settlement/,
  'the visible overlay uses settle-driven sampling instead of an overlapping interval');
assert.match(livekitVideoSource, /localScreenStatsSampler\.sample\(track/,
  'local LiveKit screen diagnostics are also single-flight per exact publication track');
assert.match(livekitVideoSource, /const currentRoom = this\.bcRoom\(\)[\s\S]*currentRoom !== room \|\| currentPub !== pub \|\| currentPub\.track !== rawTrack[\s\S]*return null/,
  'a late local screen report cannot render after its room/publication/track was replaced');
assert.doesNotMatch(probeSource, /pc\.getStats\(\)/,
  'the bounded upload probe cannot bypass shared physical stats ownership');
assert.match(probeSource, /const exactPc = pc[\s\S]*await readAvailableOutgoing\(exactPc\)[\s\S]*pc !== exactPc/,
  'an upload sample from a replaced/closed probe PC is discarded after await');
assert.doesNotMatch(probeSource, /setInterval\(async/,
  'upload probing cannot stack async stats reads on a fixed interval');

// PC A resolves only after rewatch B has become current. The shared primitive may deliver A to its
// original waiter, but the production-style exact-PC fence makes it observational and mutates B once.
{
  const sampler = new ExactPeerStatsSampler(4);
  const aPending = deferred();
  const pcA = { name: 'A' };
  const pcB = { name: 'B' };
  let current = pcA;
  const mutations = [];
  const consume = async (pc, read) => {
    const report = await sampler.sample(pc, read);
    if (!report || current !== pc) return;
    mutations.push(report);
  };
  const lateA = consume(pcA, () => aPending.promise);
  await Promise.resolve();
  current = pcB;
  await consume(pcB, async () => 'report-b');
  aPending.resolve('report-a');
  await lateA;
  assert.deepEqual(mutations, ['report-b'], 'late PC A cannot mutate or self-heal current PC B');
}

console.log('rtc stats sampler: ok');

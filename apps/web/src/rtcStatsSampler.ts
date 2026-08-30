const DEFAULT_MAX_HUNG_PEERS = 8;
const DEFAULT_RECOVERY_RESERVED_PEERS = 4;
export const RTC_RECOVERY_STATS_TIMEOUT_MS = 5_000;

export type RtcStatsPriority = 'regular' | 'recovery';
export type RtcRecoveryStatsUnavailable = 'saturated' | 'timeout' | 'failed';

export interface ExactPeerStatsRequest<TReport> {
  /** False means no browser operation was started: the bounded lane is saturated. */
  admitted: boolean;
  result: Promise<TReport | null>;
}

export interface RtcRecoveryStatsResult<TReport> {
  report: TReport | null;
  unavailable: RtcRecoveryStatsUnavailable | null;
}

/**
 * Browser getStats() is not cancellable and can remain pending forever after a radio/page-lifecycle
 * transition. Share one physical request per exact peer until it really settles and cap abandoned
 * peers globally. Diagnostics are optional; once the cap is full media keeps working without them.
 */
export class ExactPeerStatsSampler<TPeer extends object, TReport> {
  private readonly inFlight = new WeakMap<TPeer, Promise<TReport | null>>();
  private readonly active = new Map<Promise<TReport | null>, RtcStatsPriority>();

  constructor(
    private readonly maxActive = DEFAULT_MAX_HUNG_PEERS,
    private readonly recoveryReserved = 0,
  ) {}

  get activeCount(): number { return this.active.size; }

  request(
    peer: TPeer,
    read: (current: TPeer) => PromiseLike<TReport>,
    priority: RtcStatsPriority = 'regular',
  ): ExactPeerStatsRequest<TReport> {
    const existing = this.inFlight.get(peer);
    if (existing) return { admitted: true, result: existing };

    const reserved = Math.max(0, Math.min(this.maxActive, this.recoveryReserved));
    let regularActive = 0;
    if (priority === 'regular') {
      for (const activePriority of this.active.values()) {
        if (activePriority === 'regular') regularActive++;
      }
    }
    if (this.active.size >= this.maxActive
      || (priority === 'regular' && regularActive >= this.maxActive - reserved)) {
      return { admitted: false, result: Promise.resolve(null) };
    }

    let run: Promise<TReport | null>;
    run = Promise.resolve()
      .then(() => read(peer))
      .catch(() => null)
      .finally(() => {
        if (this.inFlight.get(peer) === run) this.inFlight.delete(peer);
        this.active.delete(run);
      });
    this.inFlight.set(peer, run);
    this.active.set(run, priority);
    return { admitted: true, result: run };
  }

  sample(peer: TPeer, read: (current: TPeer) => PromiseLike<TReport>): Promise<TReport | null> {
    return this.request(peer, read).result;
  }
}

// WATCH_MAX is four. Regular diagnostics may occupy at most four abandoned requests, leaving four
// physical slots for current decoder recovery. Total uncancellable browser calls remains capped at
// eight even if both lanes encounter a WebKit lifecycle bug.
const rtcStatsSampler = new ExactPeerStatsSampler<RTCPeerConnection, RTCStatsReport>(
  DEFAULT_MAX_HUNG_PEERS,
  DEFAULT_RECOVERY_RESERVED_PEERS,
);
const recoveryWaits = new WeakMap<RTCPeerConnection, Promise<RtcRecoveryStatsResult<RTCStatsReport>>>();

export function sampleRtcStats(pc: RTCPeerConnection): Promise<RTCStatsReport | null> {
  return rtcStatsSampler.sample(pc, (current) => current.getStats());
}

/**
 * Current-media recovery gets a reserved admission lane and a logical deadline. The underlying
 * getStats() is still never duplicated or forgotten: repeated checks of the same hung peer share
 * this one settled timeout view until the real browser promise eventually releases ownership.
 */
export function sampleRtcRecoveryStats(
  pc: RTCPeerConnection,
  timeoutMs = RTC_RECOVERY_STATS_TIMEOUT_MS,
): Promise<RtcRecoveryStatsResult<RTCStatsReport>> {
  const existing = recoveryWaits.get(pc);
  if (existing) return existing;

  const request = rtcStatsSampler.request(pc, (current) => current.getStats(), 'recovery');
  if (!request.admitted) return Promise.resolve({ report: null, unavailable: 'saturated' });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = Promise.race<RtcRecoveryStatsResult<RTCStatsReport>>([
    request.result.then((report) => report
      ? { report, unavailable: null }
      : { report: null, unavailable: 'failed' }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ report: null, unavailable: 'timeout' }), Math.max(0, timeoutMs));
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
  recoveryWaits.set(pc, result);
  // A timed-out logical view remains cached for this exact peer. Only the real native settlement
  // may release it, preventing a timer tick from attaching unbounded continuations to a hung call.
  void request.result.finally(() => {
    if (recoveryWaits.get(pc) === result) recoveryWaits.delete(pc);
  });
  return result;
}

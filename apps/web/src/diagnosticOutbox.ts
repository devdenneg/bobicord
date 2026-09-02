import { isApiError } from './api';
import type { VoiceDiagnosticReport } from './types';
import { VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES } from './voiceDiagnostics';

const LEGACY_OUTBOX_KEY = 'relay.diagnostic.outbox.v1';
const OUTBOX_ENTRY_PREFIX = 'relay.diagnostic.report.v2.';
const OUTBOX_INDEX_KEY = 'relay.diagnostic.index.v2';
const OUTBOX_TTL_MS = 3 * 24 * 60 * 60_000;
const OUTBOX_MAX_REPORTS = 24;
const OUTBOX_INDEX_MAX_KEYS = OUTBOX_MAX_REPORTS * 4;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60 * 60_000;

interface StoredDiagnosticReport {
  ownerId: string;
  queuedAt: number;
  retryAt: number;
  failures: number;
  report: VoiceDiagnosticReport;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export interface DiagnosticOutboxOptions {
  storage?: StorageLike | null;
  now?: () => number;
  online?: () => boolean;
  visible?: () => boolean;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  addLifecycleListeners?: (flush: () => void) => () => void;
}

function defaultStorage(): StorageLike | null {
  // Reading localStorage itself can throw SecurityError in hardened browsers/private WebViews.
  // Diagnostics must never prevent Engine construction.
  try {
    const candidate = globalThis.localStorage as StorageLike | undefined;
    return candidate && typeof candidate.getItem === 'function'
      && typeof candidate.setItem === 'function' && typeof candidate.removeItem === 'function'
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function reportId(report: VoiceDiagnosticReport): string {
  return typeof report.clientReportId === 'string' && /^[a-f0-9]{24}$/u.test(report.clientReportId)
    ? report.clientReportId
    : '';
}

function logicalEntryKey(ownerId: string, id: string): string {
  return `${ownerId}:${id}`;
}

function opaqueStorageToken(value: string): string {
  // Deterministic 128-bit token keeps account/report identifiers out of storage key names.
  let h1 = 1_779_033_703;
  let h2 = 3_144_134_277;
  let h3 = 1_013_904_242;
  let h4 = 2_773_480_762;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597_399_067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2_869_860_233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951_274_213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2_716_044_179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179);
  const words = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1];
  return words.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

function storageEntryKey(ownerId: string, id: string): string {
  return `${OUTBOX_ENTRY_PREFIX}${opaqueStorageToken(`${ownerId}\u0000${id}`)}`;
}

function encodedBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Number.POSITIVE_INFINITY; }
}

function reportPriority(report: VoiceDiagnosticReport): number {
  if (report.incident === 'stream_watch_succeeded') return 0;
  if (report.incident === 'stream_watch_recovered') return 1;
  return 2;
}

function boundEntries(entries: StoredDiagnosticReport[]): StoredDiagnosticReport[] {
  // Failure evidence survives recovered/success controls. Within a priority class keep newest.
  return [...entries]
    .sort((a, b) => reportPriority(a.report) - reportPriority(b.report) || a.queuedAt - b.queuedAt)
    .slice(-OUTBOX_MAX_REPORTS)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

function validStoredEntry(value: unknown, now: number): value is StoredDiagnosticReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<StoredDiagnosticReport>;
  return typeof item.ownerId === 'string' && item.ownerId.length > 0 && item.ownerId.length <= 128
    && Number.isFinite(item.queuedAt) && item.queuedAt! >= now - OUTBOX_TTL_MS && item.queuedAt! <= now + 60_000
    && Number.isFinite(item.retryAt) && Number.isInteger(item.failures) && item.failures! >= 0
    && !!item.report && item.report.schemaVersion === 1 && !!reportId(item.report)
    && encodedBytes(item.report) <= VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES;
}

function retryDelay(error: unknown, failures: number): number | null {
  if (!isApiError(error)) return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 10));
  const retryable = error.code === 'NETWORK_ERROR' || error.code === 'REQUEST_TIMEOUT'
    || error.code === 'INVALID_RESPONSE' || error.status === 401 || error.status === 404
    || error.status === 405 || error.status === 408
    || error.status === 429 || error.status >= 500;
  if (!retryable) return null;
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 10));
  const requested = Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter! * 1_000) : 0;
  return Math.min(OUTBOX_TTL_MS, Math.max(backoff, requested));
}

function browserLifecycle(flush: () => void): () => void {
  if (typeof window !== 'object' || typeof document !== 'object') return () => {};
  const onVisible = () => { if (!document.hidden) flush(); };
  window.addEventListener('online', flush);
  window.addEventListener('pageshow', flush);
  window.addEventListener('storage', flush);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('online', flush);
    window.removeEventListener('pageshow', flush);
    window.removeEventListener('storage', flush);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * Account-scoped durable queue for sanitized reports. Every report owns an independent storage
 * key, so concurrent tabs never replace each other's array snapshots. Enumeration is authoritative;
 * the small index only supports Storage-like hosts which cannot enumerate. Concurrent drains are
 * safe because the server treats clientReportId idempotently.
 */
export class DiagnosticReportOutbox {
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly online: () => boolean;
  private readonly visible: () => boolean;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly addLifecycleListeners: (flush: () => void) => () => void;
  /** Entries used only when persistence is unavailable; successful writes are not cached here. */
  private readonly memory = new Map<string, StoredDiagnosticReport>();
  /** Prevent failed removeItem calls from creating a tight re-upload loop in this page. */
  private readonly ignoredStorageKeys = new Set<string>();
  private timer: unknown = null;
  private inFlight = false;
  private started = false;
  private ownerDiscarded = false;
  private removeLifecycleListeners: (() => void) | null = null;

  constructor(
    private readonly ownerId: string,
    private readonly upload: (report: VoiceDiagnosticReport) => Promise<unknown>,
    options: DiagnosticOutboxOptions = {},
  ) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.now = options.now ?? Date.now;
    this.online = options.online ?? (() => typeof navigator !== 'object' || navigator.onLine !== false);
    this.visible = options.visible ?? (() => typeof document !== 'object' || !document.hidden);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as number));
    this.addLifecycleListeners = options.addLifecycleListeners ?? browserLifecycle;
  }

  private readIndex(): string[] {
    try {
      const parsed = JSON.parse(this.storage?.getItem(OUTBOX_INDEX_KEY) || '[]');
      return Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === 'string' && key.startsWith(OUTBOX_ENTRY_PREFIX))
        : [];
    } catch {
      return [];
    }
  }

  private rememberStorageKey(key: string): void {
    if (!this.storage) return;
    try {
      const keys = this.readIndex().filter((value) => value !== key);
      keys.push(key);
      this.storage.setItem(OUTBOX_INDEX_KEY, JSON.stringify(keys.slice(-OUTBOX_INDEX_MAX_KEYS)));
    } catch { /** enumeration still discovers independently stored reports */ }
  }

  private discoverStorageKeys(): Set<string> {
    const keys = new Set(this.readIndex());
    if (!this.storage || typeof this.storage.key !== 'function') return keys;
    try {
      const length = this.storage.length;
      if (!Number.isSafeInteger(length) || length! < 0) return keys;
      // A second pass closes the common window where another tab changes length mid-enumeration.
      // A missed pass never overwrites data; a later storage event/read discovers the report.
      for (let pass = 0; pass < 2; pass += 1) {
        const count = this.storage.length;
        if (!Number.isSafeInteger(count) || count! < 0) break;
        for (let index = 0; index < count!; index += 1) {
          const key = this.storage.key(index);
          if (key?.startsWith(OUTBOX_ENTRY_PREFIX)) keys.add(key);
        }
      }
    } catch { /** blocked enumeration falls back to the best-effort index */ }
    return keys;
  }

  private persist(entry: StoredDiagnosticReport): void {
    const id = reportId(entry.report);
    const logicalKey = logicalEntryKey(entry.ownerId, id);
    const key = storageEntryKey(entry.ownerId, id);
    this.ignoredStorageKeys.delete(key);
    try {
      if (!this.storage) throw new Error('storage unavailable');
      this.storage.setItem(key, JSON.stringify(entry));
      this.memory.delete(logicalKey);
      this.rememberStorageKey(key);
    } catch {
      this.memory.set(logicalKey, entry);
    }
  }

  private remove(entry: StoredDiagnosticReport): void {
    const id = reportId(entry.report);
    const key = storageEntryKey(entry.ownerId, id);
    this.memory.delete(logicalEntryKey(entry.ownerId, id));
    this.ignoredStorageKeys.add(key);
    try {
      this.storage?.removeItem(key);
      // Standard Storage removal is synchronous. Keep the suppression only when removal throws;
      // otherwise a long-running desktop client would retain one in-memory key per sent report.
      this.ignoredStorageKeys.delete(key);
    }
    catch { /** server idempotency covers one retry after a later process restart */ }
  }

  private migrateLegacy(): StoredDiagnosticReport[] {
    if (!this.storage) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(this.storage.getItem(LEGACY_OUTBOX_KEY) || '[]'); }
    catch { return []; }
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    const now = this.now();
    const valid = parsed.filter((value): value is StoredDiagnosticReport => validStoredEntry(value, now));
    try {
      for (const value of valid) {
        const key = storageEntryKey(value.ownerId, reportId(value.report));
        this.storage.setItem(key, JSON.stringify(value));
        this.rememberStorageKey(key);
      }
      // Remove the array only after every valid entry has its own durable key.
      this.storage.removeItem(LEGACY_OUTBOX_KEY);
    } catch { /** retain the legacy array and retry migration later */ }
    // If quota/security allowed reading but blocked migration, the old durable reports remain
    // available in this process instead of disappearing until the next page load.
    return valid;
  }

  private read(): StoredDiagnosticReport[] {
    const now = this.now();
    const merged = new Map<string, StoredDiagnosticReport>();
    for (const value of this.migrateLegacy()) {
      if (this.ignoredStorageKeys.has(storageEntryKey(value.ownerId, reportId(value.report)))) continue;
      merged.set(logicalEntryKey(value.ownerId, reportId(value.report)), value);
    }
    for (const key of this.discoverStorageKeys()) {
      if (this.ignoredStorageKeys.has(key)) continue;
      try {
        const parsed: unknown = JSON.parse(this.storage?.getItem(key) || 'null');
        if (!validStoredEntry(parsed, now)) {
          this.ignoredStorageKeys.add(key);
          try { this.storage?.removeItem(key); } catch { /** retry cleanup after restart */ }
          continue;
        }
        merged.set(logicalEntryKey(parsed.ownerId, reportId(parsed.report)), parsed);
      } catch { /** one corrupt entry cannot hide the rest */ }
    }
    for (const value of this.memory.values()) {
      if (!validStoredEntry(value, now)) continue;
      merged.set(logicalEntryKey(value.ownerId, reportId(value.report)), value);
    }
    return [...merged.values()];
  }

  private prune(): StoredDiagnosticReport[] {
    const entries = this.read();
    const bounded = boundEntries(entries);
    const retained = new Set(bounded.map((entry) => logicalEntryKey(entry.ownerId, reportId(entry.report))));
    for (const entry of entries) {
      if (!retained.has(logicalEntryKey(entry.ownerId, reportId(entry.report)))) this.remove(entry);
    }
    return bounded;
  }

  start(): void {
    if (this.started || this.ownerDiscarded) return;
    this.started = true;
    this.removeLifecycleListeners = this.addLifecycleListeners(() => this.flush());
    this.prune();
    this.flush();
  }

  enqueue(report: VoiceDiagnosticReport): boolean {
    if (this.ownerDiscarded) return false;
    const id = reportId(report);
    if (!id || encodedBytes(report) > VOICE_DIAGNOSTIC_MAX_PAYLOAD_BYTES) return false;
    const duplicate = this.read().some((entry) => entry.ownerId === this.ownerId
      && reportId(entry.report) === id);
    if (!duplicate) {
      const now = this.now();
      this.persist({ ownerId: this.ownerId, queuedAt: now, retryAt: now, failures: 0, report });
      this.prune();
    }
    this.flush();
    return true;
  }

  flush(): void {
    if (!this.started || this.inFlight || !this.online() || !this.visible()) return;
    const owned = this.prune().filter((entry) => entry.ownerId === this.ownerId);
    const now = this.now();
    const next = owned.filter((entry) => entry.retryAt <= now)
      .sort((a, b) => reportPriority(b.report) - reportPriority(a.report) || a.queuedAt - b.queuedAt)[0]
      ?? owned.reduce<StoredDiagnosticReport | undefined>((earliest, entry) => (
        !earliest || entry.retryAt < earliest.retryAt ? entry : earliest
      ), undefined);
    if (!next) return;
    const waitMs = next.retryAt - now;
    if (waitMs > 0) {
      if (this.timer == null) this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, Math.min(waitMs, 2_147_000_000));
      return;
    }
    if (this.timer != null) { this.clearTimer(this.timer); this.timer = null; }
    this.inFlight = true;
    void Promise.resolve().then(() => this.upload(next.report)).then(() => {
      this.remove(next);
    }, (error) => {
      // Explicit logout revokes ownership even when a native fetch was already in flight. Its
      // late rejection must not recreate the just-purged account report.
      if (this.ownerDiscarded) {
        this.remove(next);
        return;
      }
      const failures = next.failures + 1;
      const delay = retryDelay(error, failures);
      if (delay == null) this.remove(next);
      else this.persist({ ...next, failures, retryAt: this.now() + delay });
    }).finally(() => {
      this.inFlight = false;
      this.flush();
    });
  }

  dispose(discardOwner = false): void {
    this.started = false;
    this.removeLifecycleListeners?.();
    this.removeLifecycleListeners = null;
    if (this.timer != null) { this.clearTimer(this.timer); this.timer = null; }
    if (discardOwner) {
      this.ownerDiscarded = true;
      for (const entry of this.read()) {
        if (entry.ownerId === this.ownerId) this.remove(entry);
      }
    }
  }
}

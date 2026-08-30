export interface ServerVolumeData {
  users: Record<string, number>;
  streams: Record<string, number>;
}

export interface ServerVolumeMutation {
  section: 'users' | 'streams';
  key: string;
}

export interface ServerVolumeWrite extends ServerVolumeMutation {
  value: number;
}

interface StoredServerVolumes {
  version: 2;
  revision: number;
  data: ServerVolumeData;
  dirty: { users: string[]; streams: string[] };
}

interface VolumeState {
  serverId: string;
  data: ServerVolumeData;
  revision: number;
  hasCache: boolean;
  dirtyUsers: Set<string>;
  dirtyStreams: Set<string>;
  timer: unknown;
  write: Promise<void> | null;
  retry: number;
  hydration: number;
  hydrationGeneration: number;
}

interface VolumePreferenceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  debounceMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

const EMPTY_VOLUMES = (): ServerVolumeData => ({ users: {}, streams: {} });
const MAX_VOLUME_ENTRIES = 1024;

function finiteVolume(value: unknown, maximum: number): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(maximum, number)) : null;
}

function sanitizedSection(value: unknown, maximum: number): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  let count = 0;
  for (const [rawKey, rawVolume] of Object.entries(value as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const volume = finiteVolume(rawVolume, maximum);
    if (!key || key.length > 256 || volume == null) continue;
    output[key] = volume;
    if (++count >= MAX_VOLUME_ENTRIES) break;
  }
  return output;
}

export function sanitizeServerVolumes(value: unknown): ServerVolumeData {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { users?: unknown; streams?: unknown }
    : {};
  return {
    users: sanitizedSection(record.users, 2),
    streams: sanitizedSection(record.streams, 1),
  };
}

function cloneVolumes(value: ServerVolumeData): ServerVolumeData {
  return { users: { ...value.users }, streams: { ...value.streams } };
}

function sameVolumes(a: ServerVolumeData, b: ServerVolumeData): boolean {
  for (const section of ['users', 'streams'] as const) {
    const ak = Object.keys(a[section]);
    const bk = Object.keys(b[section]);
    if (ak.length !== bk.length) return false;
    for (const key of ak) if (a[section][key] !== b[section][key]) return false;
  }
  return true;
}

function validDirtyKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 256))]
    .slice(0, MAX_VOLUME_ENTRIES);
}

/**
 * Keeps per-person volumes local-first without letting a late GET or an older PUT replace the
 * user's newest slider movement. Each server has an independent debounce and a serialized writer.
 */
export class ServerVolumePreferences {
  private readonly states = new Map<string, VolumeState>();
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly debounceMs: number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimer: (timer: unknown) => void;
  private disposed = false;

  constructor(
    private readonly userId: string,
    private readonly writer: (serverId: string, mutations: ServerVolumeWrite[]) => Promise<unknown>,
    options: VolumePreferenceOptions = {},
  ) {
    let defaultStorage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    if (options.storage === undefined) {
      try { defaultStorage = typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage; }
      catch { defaultStorage = null; }
    }
    this.storage = options.storage === undefined ? defaultStorage : options.storage;
    this.debounceMs = Math.max(0, options.debounceMs ?? 800);
    this.scheduleTimer = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.cancelTimer = options.cancel || ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  cacheKey(serverId: string): string {
    return `srvset:v2:${encodeURIComponent(this.userId)}:${encodeURIComponent(serverId)}`;
  }

  beginHydration(serverId: string): { data: ServerVolumeData | null; revision: number; token: number } {
    const state = this.state(serverId);
    const token = ++state.hydrationGeneration;
    state.hydration = token;
    if (state.timer != null) { this.cancelTimer(state.timer); state.timer = null; }
    return { data: state.hasCache ? cloneVolumes(state.data) : null, revision: state.revision, token };
  }

  acceptRemote(serverId: string, value: unknown, hydrationRevision: number, token: number): ServerVolumeData {
    const state = this.state(serverId);
    if (state.hydration !== token) return cloneVolumes(state.data);
    state.hydration = 0;
    const remote = sanitizeServerVolumes(value);
    if (state.revision === hydrationRevision && !this.isDirty(state)) {
      if (!state.hasCache || !sameVolumes(state.data, remote)) state.revision++;
      state.data = remote;
      state.hasCache = true;
      this.persist(state);
      if (this.isDirty(state)) this.scheduleWrite(state, 0);
      return cloneVolumes(state.data);
    }

    // A slider change or an unsent cache is newer than the GET. Only the exact dirty fields win;
    // unrelated fields still adopt changes made on another device.
    const merged = cloneVolumes(remote);
    state.dirtyUsers.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(state.data.users, key)) merged.users[key] = state.data.users[key];
    });
    state.dirtyStreams.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(state.data.streams, key)) merged.streams[key] = state.data.streams[key];
    });
    if (!sameVolumes(state.data, merged)) state.revision++;
    state.data = merged;
    state.hasCache = true;
    this.persist(state);
    this.scheduleWrite(state, 0);
    return cloneVolumes(state.data);
  }

  finishHydration(serverId: string, token: number): void {
    const state = this.state(serverId);
    if (state.hydration !== token) return;
    state.hydration = 0;
    if (this.isDirty(state)) this.scheduleWrite(state, 0);
  }

  update(serverId: string, value: unknown, mutation?: ServerVolumeMutation): ServerVolumeData {
    const state = this.state(serverId);
    const next = sanitizeServerVolumes(value);
    if (mutation) {
      const key = String(mutation.key || '').trim();
      if (key) (mutation.section === 'users' ? state.dirtyUsers : state.dirtyStreams).add(key);
    } else {
      for (const section of ['users', 'streams'] as const) {
        const keys = new Set([...Object.keys(state.data[section]), ...Object.keys(next[section])]);
        keys.forEach((key) => {
          if (state.data[section][key] !== next[section][key]) {
            (section === 'users' ? state.dirtyUsers : state.dirtyStreams).add(key);
          }
        });
      }
    }
    if (!sameVolumes(state.data, next) || this.isDirty(state)) state.revision++;
    state.data = next;
    state.hasCache = true;
    state.retry = 0;
    this.persist(state);
    this.scheduleWrite(state, this.debounceMs);
    return cloneVolumes(state.data);
  }

  async flush(serverId: string): Promise<void> {
    const state = this.state(serverId);
    if (state.timer != null) { this.cancelTimer(state.timer); state.timer = null; }
    await this.drain(state);
    if (state.write) await state.write;
    if (this.isDirty(state) && !this.disposed) await this.drain(state);
  }

  dispose(): void {
    this.disposed = true;
    this.states.forEach((state) => {
      if (state.timer != null) this.cancelTimer(state.timer);
      state.timer = null;
    });
  }

  private state(serverId: string): VolumeState {
    let state = this.states.get(serverId);
    if (state) return state;
    state = {
      serverId,
      data: EMPTY_VOLUMES(),
      revision: 0,
      hasCache: false,
      dirtyUsers: new Set(),
      dirtyStreams: new Set(),
      timer: null,
      write: null,
      retry: 0,
      hydration: 0,
      hydrationGeneration: 0,
    };
    try {
      const parsed = JSON.parse(this.storage?.getItem(this.cacheKey(serverId)) || 'null') as Partial<StoredServerVolumes> | null;
      if (parsed?.version === 2 && Number.isSafeInteger(parsed.revision) && Number(parsed.revision) >= 0) {
        state.data = sanitizeServerVolumes(parsed.data);
        state.revision = Number(parsed.revision);
        state.hasCache = true;
        validDirtyKeys(parsed.dirty?.users).forEach((key) => state!.dirtyUsers.add(key));
        validDirtyKeys(parsed.dirty?.streams).forEach((key) => state!.dirtyStreams.add(key));
      }
    } catch { /* malformed or unavailable storage starts clean */ }
    this.states.set(serverId, state);
    return state;
  }

  private isDirty(state: VolumeState): boolean {
    return state.dirtyUsers.size > 0 || state.dirtyStreams.size > 0;
  }

  private persist(state: VolumeState): void {
    const stored: StoredServerVolumes = {
      version: 2,
      revision: state.revision,
      data: cloneVolumes(state.data),
      dirty: { users: [...state.dirtyUsers], streams: [...state.dirtyStreams] },
    };
    try { this.storage?.setItem(this.cacheKey(state.serverId), JSON.stringify(stored)); } catch { /** memory state remains authoritative */ }
  }

  private scheduleWrite(state: VolumeState, delayMs: number): void {
    if (this.disposed || state.hydration !== 0 || !this.isDirty(state)) return;
    if (state.timer != null) this.cancelTimer(state.timer);
    state.timer = this.scheduleTimer(() => {
      state.timer = null;
      void this.drain(state);
    }, delayMs);
  }

  private drain(state: VolumeState): Promise<void> {
    if (this.disposed || state.hydration !== 0 || !this.isDirty(state)) return Promise.resolve();
    if (state.write) return state.write;
    const revision = state.revision;
    const snapshot = cloneVolumes(state.data);
    const mutations: ServerVolumeWrite[] = [];
    state.dirtyUsers.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(snapshot.users, key)) mutations.push({ section: 'users', key, value: snapshot.users[key] });
    });
    state.dirtyStreams.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(snapshot.streams, key)) mutations.push({ section: 'streams', key, value: snapshot.streams[key] });
    });
    const write = Promise.resolve()
      .then(() => this.writer(state.serverId, mutations))
      .then(() => {
        state.retry = 0;
        if (state.revision === revision && state.hydration === 0) {
          state.dirtyUsers.clear();
          state.dirtyStreams.clear();
          this.persist(state);
        }
      })
      .catch(() => {
        state.retry = Math.min(state.retry + 1, 6);
      })
      .finally(() => {
        if (state.write === write) state.write = null;
        if (this.isDirty(state) && !this.disposed) {
          const changedWhileWriting = state.revision !== revision;
          this.scheduleWrite(state, changedWhileWriting ? 0 : Math.min(30_000, 1000 * (2 ** state.retry)));
        }
      });
    state.write = write;
    return write;
  }
}

export interface NativeUpdateResource {
  version: string;
  close?: () => void | Promise<void>;
  downloadAndInstall: () => Promise<void>;
}

export interface StoredNativeUpdate<T extends NativeUpdateResource> {
  version: string;
  obj: T;
}

export interface NativeUpdateDependencies<T extends NativeUpdateResource> {
  getCurrent: () => StoredNativeUpdate<T> | null;
  setCurrent: (update: StoredNativeUpdate<T>) => void;
  checkForUpdate: () => Promise<T | null>;
  onNewVersion: (update: T) => void;
  relaunch: () => Promise<void>;
}

interface NativeUpdateOperationOptions {
  checkTimeoutMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface PhysicalCheck<T extends NativeUpdateResource> {
  generation: number;
  replaceSameVersion: boolean;
  announce: boolean;
  actual: Promise<T | null>;
  processed: Promise<boolean>;
  bounded: Promise<boolean>;
}

/**
 * Retains exactly one physical Tauri updater check until it really settles. Logical callers have
 * a deadline, so an explicit install can fall back to the already verified stored resource without
 * starting another native invoke behind a hung periodic check.
 */
export class NativeUpdateOperations<T extends NativeUpdateResource> {
  private physicalCheck: PhysicalCheck<T> | null = null;
  private applyFlight: Promise<void> | null = null;
  private applyingResource: T | null = null;
  private operationGeneration = 0;
  private committedGeneration = 0;
  private readonly checkTimeoutMs: number;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(private readonly dependencies: NativeUpdateDependencies<T>, options: NativeUpdateOperationOptions = {}) {
    this.checkTimeoutMs = options.checkTimeoutMs ?? 15_000;
    this.schedule = options.schedule || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancel = options.cancel || ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  check(): Promise<boolean> {
    // Download/install owns the resource. A timer tick during it is satisfied by the currently
    // verified banner instead of starting a plugin check that could close the installing handle.
    if (this.applyFlight) return Promise.resolve(!!this.dependencies.getCurrent());
    return this.ensurePhysicalCheck(false, true).bounded;
  }

  apply(): Promise<void> {
    if (this.applyFlight) return this.applyFlight;
    const operation = this.applyNow();
    const tracked = operation.finally(() => {
      if (this.applyFlight === tracked) this.applyFlight = null;
    });
    this.applyFlight = tracked;
    return tracked;
  }

  private close(resource: T | null | undefined): void {
    if (!resource?.close) return;
    try { void Promise.resolve(resource.close()).catch(() => {}); } catch { /** resource is already closed */ }
  }

  private install(update: T, check: PhysicalCheck<T>): T | null {
    const current = this.dependencies.getCurrent();
    if (current?.obj === update) return update;
    if (!check.replaceSameVersion && current?.version === update.version) {
      this.close(update);
      return current.obj;
    }
    if (check.generation < this.committedGeneration) {
      this.close(update);
      return current?.obj || null;
    }
    try { this.dependencies.setCurrent({ version: update.version, obj: update }); }
    catch (error) { this.close(update); throw error; }
    const installed = this.dependencies.getCurrent();
    if (installed?.obj !== update) {
      this.close(update);
      return installed?.obj || null;
    }
    this.committedGeneration = check.generation;
    if (current?.obj && current.obj !== update) this.close(current.obj);
    if (check.announce && current?.version !== update.version) {
      try { this.dependencies.onNewVersion(update); } catch { /** banner remains authoritative */ }
    }
    return update;
  }

  private ensurePhysicalCheck(replaceSameVersion: boolean, announce: boolean): PhysicalCheck<T> {
    const existing = this.physicalCheck;
    if (existing) {
      if (replaceSameVersion) existing.replaceSameVersion = true;
      existing.announce = existing.announce || announce;
      return existing;
    }

    const generation = ++this.operationGeneration;
    const actual = Promise.resolve().then(() => this.dependencies.checkForUpdate());
    const check = {
      generation, replaceSameVersion, announce, actual,
      processed: Promise.resolve(false), bounded: Promise.resolve(false),
    } as PhysicalCheck<T>;
    check.processed = actual.then(async (update) => {
      // A stored resource may already be downloading because this native check outlived its logical
      // deadline. Never close/replace that handle until the exact apply operation has settled.
      if (this.applyingResource && this.applyFlight) {
        try { await this.applyFlight; } catch { /** failed install may still be replaced afterwards */ }
      }
      if (!update) return !!this.dependencies.getCurrent();
      return !!this.install(update, check);
    }, () => !!this.dependencies.getCurrent());

    let timer: unknown;
    let boundedSettled = false;
    check.bounded = new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        if (boundedSettled) return;
        boundedSettled = true;
        this.cancel(timer);
        resolve(value);
      };
      timer = this.schedule(() => finish(!!this.dependencies.getCurrent()), this.checkTimeoutMs);
      check.processed.then(finish, () => finish(!!this.dependencies.getCurrent()));
    });
    this.physicalCheck = check;
    void check.processed.then(
      () => { if (this.physicalCheck === check) this.physicalCheck = null; },
      () => { if (this.physicalCheck === check) this.physicalCheck = null; },
    );
    return check;
  }

  private async applyNow(): Promise<void> {
    // Promote an existing periodic check to a fresh-resource check. If it already timed out but its
    // native promise is still hung, bounded is already settled and the stored handle is used now.
    const check = this.ensurePhysicalCheck(true, false);
    try { await check.bounded; } catch { /** bounded resolves fail-closed, kept for defensive callers */ }
    const target = this.dependencies.getCurrent()?.obj || null;
    if (!target) throw new Error('Обновление пока недоступно — повтори проверку позже');
    this.applyingResource = target;
    try {
      await target.downloadAndInstall();
      await this.dependencies.relaunch();
    } finally {
      if (this.applyingResource === target) this.applyingResource = null;
    }
  }
}

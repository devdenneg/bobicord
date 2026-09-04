export type NativeUpdatePhase = 'checking' | 'available' | 'downloading' | 'installing' | 'restarting' | 'error' | 'ready';
export interface NativeUpdateState {
  phase: NativeUpdatePhase;
  authAllowed: boolean;
  version: string | null;
  downloaded: number;
  total: number | null;
  error: string;
  installed: boolean;
}
export type NativeDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
export interface NativeUpdateHandle {
  version: string;
  close(): Promise<void>;
  downloadAndInstall(onEvent?: (event: NativeDownloadEvent) => void, options?: { timeout?: number }): Promise<void>;
}
interface Dependencies {
  enabled: boolean;
  check: (timeout: number) => Promise<NativeUpdateHandle | null>;
  relaunch: () => Promise<void>;
  onUpdate: (update: NativeUpdateHandle) => void;
  announce: (version: string) => void;
}

const CHECK_TIMEOUT_MS = 10000;
function bounded<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** One updater owner for startup, background polling and the existing update banners. */
export class NativeUpdateController {
  private state: NativeUpdateState;
  private listeners = new Set<() => void>();
  private target: NativeUpdateHandle | null = null;
  private checkRun: Promise<boolean> | null = null;
  private installRun: Promise<void> | null = null;
  private installTarget: NativeUpdateHandle | null = null;
  private startupWait: Promise<void> | null = null;
  private allowStartup: (() => void) | null = null;

  constructor(private readonly deps: Dependencies) {
    this.state = { phase: deps.enabled ? 'checking' : 'ready', authAllowed: !deps.enabled,
      version: null, downloaded: 0, total: null, error: '', installed: false };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private set(patch: Partial<NativeUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private allowAuth() {
    this.set({ phase: 'ready', authAllowed: true, error: '' });
    this.allowStartup?.();
    this.allowStartup = null;
  }
  private close(update: NativeUpdateHandle | null) { if (update) void update.close().catch(() => {}); }

  waitForStartup(): Promise<void> {
    if (this.state.authAllowed) return Promise.resolve();
    if (!this.startupWait) {
      this.startupWait = new Promise((resolve) => { this.allowStartup = resolve; });
      void this.retryCheck();
    }
    return this.startupWait;
  }

  continueWithoutCheck(): boolean {
    // An unavailable manifest is not evidence of an available release. A known update,
    // failed download or failed relaunch must never expose this bypass.
    if (this.state.phase !== 'error' || this.target || this.state.installed) return false;
    this.allowAuth();
    return true;
  }

  retryCheck(): Promise<boolean> {
    if (!this.deps.enabled || this.installRun || this.state.installed) return Promise.resolve(!!this.target);
    this.set({ phase: 'checking', error: '' });
    return this.check();
  }

  check(): Promise<boolean> {
    if (!this.deps.enabled) return Promise.resolve(false);
    if (this.installRun || this.state.installed) return Promise.resolve(!!this.target);
    return this.refresh();
  }

  private async refresh(): Promise<boolean> {
    if (!this.checkRun) {
      // Keep the actual request as the owner even after a UI deadline. Retrying a hung
      // IPC/import must not launch another check; a late resource is still accounted for.
      const run = Promise.resolve().then(() => this.deps.check(CHECK_TIMEOUT_MS)).then((update) => {
        if (this.installTarget || this.state.installed) { this.close(update); return !!this.target; }
        if (update) {
          if (this.target?.version === update.version && !this.installRun) { if (update !== this.target) this.close(update); }
          else {
            const old = this.target;
            this.target = update;
            this.deps.onUpdate(update);
            if (old !== update) this.close(old);
            if (this.state.authAllowed && old?.version !== update.version) this.deps.announce(update.version);
          }
        }
        if (this.target) this.set({ phase: 'available', version: this.target.version, error: '' });
        else if (!this.state.authAllowed) this.allowAuth();
        return !!this.target;
      });
      this.checkRun = run;
      void run.finally(() => { if (this.checkRun === run) this.checkRun = null; }).catch(() => {});
    }
    try { return await bounded(this.checkRun, CHECK_TIMEOUT_MS + 1000); }
    catch {
      if (!this.state.authAllowed && !this.installTarget) this.set({ phase: 'error', error: 'Не удалось проверить обновления. Проверь подключение к интернету и попробуй ещё раз.' });
      return !!this.target;
    }
  }

  apply(): Promise<void> {
    if (!this.deps.enabled) return Promise.resolve();
    if (this.installRun) return this.installRun;
    const run = Promise.resolve().then(async () => {
      if (!this.state.installed) {
        this.set({ phase: 'checking', error: '' });
        await this.refresh(); // Refresh the signed resource; a known release survives an offline check.
        const target = this.target;
        if (!target) throw new Error('Обновление пока не найдено — повтори проверку');
        this.installTarget = target;
        this.set({ phase: 'downloading', version: target.version, downloaded: 0, total: null, error: '' });
        let downloaded = 0, lastProgressAt = 0;
        try {
          await target.downloadAndInstall((event) => {
            if (this.installTarget !== target) return;
            if (event.event === 'Started') {
              const total = event.data.contentLength;
              downloaded = 0;
              this.set({ phase: 'downloading', downloaded: 0, total: total && Number.isFinite(total) && total > 0 ? total : null });
            } else if (event.event === 'Progress') {
              const chunk = event.data.chunkLength;
              if (Number.isFinite(chunk) && chunk > 0) downloaded += chunk;
              const now = Date.now();
              if (now - lastProgressAt >= 100 || (this.state.total !== null && downloaded >= this.state.total)) {
                lastProgressAt = now;
                this.set({ downloaded });
              }
            } else if (event.event === 'Finished') this.set({ phase: 'installing', downloaded });
          }, { timeout: 10 * 60_000 });
          this.set({ installed: true });
        } catch (error) {
          this.set({ phase: 'error', error: 'Не удалось скачать или установить обновление. Проверь подключение и повтори попытку.' });
          throw error;
        } finally { this.installTarget = null; }
      }
      this.set({ phase: 'restarting', error: '' });
      try { await this.deps.relaunch(); }
      catch (error) {
        this.set({ phase: 'error', error: 'Обновление установлено. Не удалось перезапустить приложение — нажми «Перезапустить» или открой его заново.' });
        throw error;
      }
    });
    this.installRun = run;
    void run.finally(() => { if (this.installRun === run) this.installRun = null; }).catch(() => {});
    return run;
  }
}

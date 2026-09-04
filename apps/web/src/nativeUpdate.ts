// Shared owner of the signed Tauri updater, available before authentication.
import { isTauri } from './native';
import { useStore } from './store';
import { playSound } from './sounds';
import { notify } from './notify';
import { NativeUpdateController } from './nativeUpdateController';

export const nativeUpdateController = new NativeUpdateController({
  enabled: isTauri,
  check: async (timeout) => {
    const { check } = await import('@tauri-apps/plugin-updater');
    return check({ timeout });
  },
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },
  onUpdate: (update) => useStore.setState({ nativeUpdate: { version: update.version, obj: update } }),
  announce: (version) => {
    playSound('system');
    notify('update', { title: 'Вышло обновление', body: `Версия ${version} готова к установке`, tag: 'update' });
  },
});

export const checkNativeUpdate = () => nativeUpdateController.check();
export const applyNativeUpdate = () => nativeUpdateController.apply();
export const waitForNativeStartup = () => nativeUpdateController.waitForStartup();

// Поллинг обновлений натива: проверка раз в intervalMs (по умолчанию 5 минут). Не
// останавливается после находки: пока баннер висит, могут выйти новые релизы —
// баннер должен показывать актуальную версию. No-op в браузере.
let pollTimer: ReturnType<typeof setTimeout> | null = null;
export function startNativeUpdatePolling(intervalMs = 5 * 60_000): void {
  if (!isTauri || pollTimer !== null) return;
  const poll = () => {
    pollTimer = setTimeout(async () => {
      await checkNativeUpdate();
      poll();
    }, intervalMs);
  };
  poll();
}

// Проверка обновлений НАТИВНОГО приложения (Tauri updater). No-op в браузере.
// Манифест отдаёт server (/api/app/latest.json), см. tauri.conf.json plugins.updater.
import { isTauri } from './native';
import { useStore } from './store';
import { playSound } from './sounds';
import { notify } from './notify';
import { NativeUpdateOperations, type NativeUpdateResource, type StoredNativeUpdate } from './nativeUpdateOperations';

type TauriUpdate = NativeUpdateResource;

const nativeUpdates = new NativeUpdateOperations<TauriUpdate>({
  getCurrent: () => useStore.getState().nativeUpdate as StoredNativeUpdate<TauriUpdate> | null,
  setCurrent: (update) => { useStore.setState({ nativeUpdate: update }); },
  checkForUpdate: async () => {
    const { check } = await import('@tauri-apps/plugin-updater');
    return await check() as TauriUpdate | null;
  },
  onNewVersion: (update) => {
    playSound('system');
    notify('update', { title: 'Вышло обновление', body: `Версия ${update.version} готова к установке`, tag: 'update' });
  },
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },
});

export async function checkNativeUpdate(): Promise<boolean> {
  if (!isTauri) return false;
  return nativeUpdates.check();
}

// Поллинг обновлений натива: проверка раз в intervalMs (по умолчанию 30с). Не
// останавливается после находки: пока баннер висит, могут выйти новые релизы —
// баннер должен показывать актуальную версию. No-op в браузере.
export function startNativeUpdatePolling(intervalMs = 5 * 60_000): void {
  if (!isTauri) return;
  // Пять минут вместо тридцати секунд: релизы выходят не чаще, а каждая проверка — это HTTP-запрос
  // за манифестом и новый Resource на стороне Rust. Задержка показа баннера роли не играет.
  setInterval(() => { void checkNativeUpdate(); }, intervalMs);
}

// Скачать + установить + перезапуститься. Вызывается по кнопке в баннере.
// Перед установкой — свежий check(): в сохранённом obj запечён URL/подпись на момент
// первой проверки, между показом баннера и кликом мог выйти новый релиз.
export async function applyNativeUpdate(): Promise<void> {
  if (!isTauri) return;
  return nativeUpdates.apply();
}

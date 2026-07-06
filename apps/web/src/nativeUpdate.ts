// Проверка обновлений НАТИВНОГО приложения (Tauri updater). No-op в браузере.
// Манифест отдаёт server (/api/app/latest.json), см. tauri.conf.json plugins.updater.
import { isTauri } from './native';
import { useStore } from './store';
import { playSound } from './sounds';

export async function checkNativeUpdate(): Promise<void> {
  if (!isTauri) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const upd = await check();
    if (upd) {
      useStore.setState({ nativeUpdate: { version: upd.version, obj: upd } });
      playSound('system');
    }
  } catch {
    /* оффлайн / манифеста ещё нет — тихо пропускаем */
  }
}

// Скачать + установить + перезапуститься. Вызывается по кнопке в баннере.
export async function applyNativeUpdate(): Promise<void> {
  const u = useStore.getState().nativeUpdate;
  if (!u) return;
  await u.obj.downloadAndInstall();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

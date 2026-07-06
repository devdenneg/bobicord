// Проверка обновлений НАТИВНОГО приложения (Tauri updater). No-op в браузере.
// Манифест отдаёт server (/api/app/latest.json), см. tauri.conf.json plugins.updater.
import { isTauri } from './native';
import { useStore } from './store';
import { playSound } from './sounds';

export async function checkNativeUpdate(): Promise<boolean> {
  if (!isTauri) return false;
  // Уже нашли — баннер висит; повторно не дёргаем (не переиграть звук, не перезаписать obj).
  if (useStore.getState().nativeUpdate) return true;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const upd = await check();
    if (upd) {
      useStore.setState({ nativeUpdate: { version: upd.version, obj: upd } });
      playSound('system');
      return true;
    }
  } catch {
    /* оффлайн / манифеста ещё нет — тихо пропускаем */
  }
  return false;
}

// Поллинг обновлений натива: проверка раз в intervalMs (по умолчанию 30с). Останавливается
// после первой находки — баннер уже показан, дальше проверять нечего. No-op в браузере.
export function startNativeUpdatePolling(intervalMs = 30_000): void {
  if (!isTauri) return;
  const timer = setInterval(async () => {
    if (await checkNativeUpdate()) clearInterval(timer);
  }, intervalMs);
}

// Скачать + установить + перезапуститься. Вызывается по кнопке в баннере.
export async function applyNativeUpdate(): Promise<void> {
  const u = useStore.getState().nativeUpdate;
  if (!u) return;
  await u.obj.downloadAndInstall();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

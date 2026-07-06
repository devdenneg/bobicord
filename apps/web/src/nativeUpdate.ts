// Проверка обновлений НАТИВНОГО приложения (Tauri updater). No-op в браузере.
// Манифест отдаёт server (/api/app/latest.json), см. tauri.conf.json plugins.updater.
import { isTauri } from './native';
import { useStore } from './store';
import { playSound } from './sounds';

export async function checkNativeUpdate(): Promise<boolean> {
  if (!isTauri) return false;
  const shown = useStore.getState().nativeUpdate;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const upd = await check();
    if (upd) {
      // Пока баннер висел, мог выйти ещё релиз — всегда перезаписываем obj свежим
      // (иначе кнопка ставила бы стейл-версию). Звук — только на новую версию.
      if (!shown || shown.version !== upd.version) {
        useStore.setState({ nativeUpdate: { version: upd.version, obj: upd } });
        playSound('system');
      }
      return true;
    }
  } catch {
    /* оффлайн / манифеста ещё нет — тихо пропускаем */
  }
  return !!shown;
}

// Поллинг обновлений натива: проверка раз в intervalMs (по умолчанию 30с). Не
// останавливается после находки: пока баннер висит, могут выйти новые релизы —
// баннер должен показывать актуальную версию. No-op в браузере.
export function startNativeUpdatePolling(intervalMs = 30_000): void {
  if (!isTauri) return;
  setInterval(() => { void checkNativeUpdate(); }, intervalMs);
}

// Скачать + установить + перезапуститься. Вызывается по кнопке в баннере.
// Перед установкой — свежий check(): в сохранённом obj запечён URL/подпись на момент
// первой проверки, между показом баннера и кликом мог выйти новый релиз.
export async function applyNativeUpdate(): Promise<void> {
  const stored = useStore.getState().nativeUpdate;
  let target = stored?.obj ?? null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const fresh = await check();
    if (fresh) {
      target = fresh;
      useStore.setState({ nativeUpdate: { version: fresh.version, obj: fresh } });
    }
  } catch {
    /* манифест недоступен — ставим то, что уже нашли */
  }
  if (!target) return;
  await target.downloadAndInstall();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

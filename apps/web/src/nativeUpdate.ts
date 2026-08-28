// Проверка обновлений НАТИВНОГО приложения (Tauri updater). No-op в браузере.
// Манифест отдаёт server (/api/app/latest.json), см. tauri.conf.json plugins.updater.
import { isTauri } from './native';
import { useStore } from './store';
import { playSound } from './sounds';
import { notify } from './notify';

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
        // Update — Resource на стороне Rust: у него есть дескриптор, который освобождается только
        // явным close(). Поллинг зовёт check() бессрочно, поэтому каждый неосвобождённый объект
        // копился бы в процессе на всю сессию. Закрываем тот, который перестаём держать.
        const previous = shown?.obj as { close?: () => Promise<void> } | undefined;
        useStore.setState({ nativeUpdate: { version: upd.version, obj: upd } });
        if (previous?.close) void previous.close().catch(() => {});
        playSound('system');
        notify('update', { title: 'Вышло обновление', body: `Версия ${upd.version} готова к установке`, tag: 'update' });
      } else {
        void upd.close().catch(() => {}); // ту же версию уже держим — этот дескриптор не нужен
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

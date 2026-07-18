import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from '../store';
import { resolveUploadUrl } from '../api';
import { Icon } from '../Icon';
import { Backdrop } from './Backdrop';
import { isTauri, openFile, revealInFolder, pathsExist } from '../native';
import { getDownloads, removeDownload, subscribeDownloads, patchDownloads, type DownloadItem } from '../downloads';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}
function fmtDate(ts: number): string {
  try { return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

// Журнал "Загрузки" (как в Chrome). Общий список для веба и натива, но действия платформенные:
// в вебе путь к файлу нам недоступен (браузер прячет его от JS) — клик по строке скачивает
// вложение заново по сохранённому url; в нативе мы сами писали байты на диск (saveFileDialog) и
// знаем путь — клик открывает файл, отдельная кнопка показывает его в проводнике с выделением.
export function DownloadsModal() {
  const close = () => useStore.getState().setModal(null);
  const toast = useStore((s) => s.toast);
  const items = useSyncExternalStore(subscribeDownloads, getDownloads);
  const [busy, setBusy] = useState<string | null>(null);

  // При каждом открытии — проверяем натив-пути разом. Файл впервые не найден -> помечаем
  // (следующее открытие покажет "Удалено" зачёркнутым); файл СНОВА не найден при повторном
  // открытии (missingSince уже стоял) -> строка убирается из списка сама (по требованию — "спустя
  // время", реализовано как "при следующем открытии"). Файл нашёлся заново -> снимаем пометку.
  useEffect(() => {
    if (!isTauri) return;
    const withPath = items.filter((d) => d.path);
    if (!withPath.length) return;
    (async () => {
      const exists = await pathsExist(withPath.map((d) => d.path!));
      const toRemove: string[] = [];
      const patch: Record<string, Partial<DownloadItem>> = {};
      withPath.forEach((d, i) => {
        if (exists[i]) { if (d.missingSince) patch[d.id] = { missingSince: undefined }; return; }
        if (d.missingSince) toRemove.push(d.id); else patch[d.id] = { missingSince: Date.now() };
      });
      if (Object.keys(patch).length) patchDownloads(patch);
      if (toRemove.length) toRemove.forEach(removeDownload);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onOpen(d: DownloadItem) {
    if (d.missingSince || busy) return;
    if (isTauri && d.path) { await openFile(d.path); return; }
    // веб (или натив-запись без пути, теоретически невозможно) — скачать заново по url
    setBusy(d.id);
    try {
      const r = await fetch(resolveUploadUrl(d.url));
      if (!r.ok) throw new Error('Ошибка ' + r.status);
      const blob = await r.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl; a.download = d.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    } catch { toast(`Не удалось скачать ${d.name}`, 'err'); }
    finally { setBusy(null); }
  }

  return (
    <Backdrop onClose={close} label="Загрузки">
      <h2><Icon name="download" />Загрузки</h2>
      <p className="msub">{isTauri ? 'Файлы, сохранённые из чата. Клик по имени — открыть, значок папки — показать в проводнике.' : 'Файлы, сохранённые из чата на этом устройстве.'}</p>
      {items.length ? (
        <div className="dl-list">
          {items.map((d) => {
            const missing = !!d.missingSince;
            return (
              <div key={d.id} className={'dl-row' + (missing ? ' missing' : '')}>
                <Icon name="file" />
                <div className="dl-main">
                  <button className="dl-name" disabled={missing || busy === d.id} onClick={() => onOpen(d)}>{d.name}</button>
                  <div className="dl-meta">{missing ? 'Удалено' : `${fmtSize(d.size)} · ${fmtDate(d.savedAt)}`}</div>
                </div>
                <div className="dl-actions">
                  {isTauri && d.path ? <button className="dl-act" aria-label={`Показать ${d.name} в папке`} disabled={missing} data-tip="Показать в папке" onClick={() => revealInFolder(d.path!)}><Icon name="folder" sm /></button> : null}
                  <button className="dl-act" aria-label={`Убрать ${d.name} из списка`} data-tip="Убрать из списка" onClick={() => removeDownload(d.id)}><Icon name="close" sm /></button>
                </div>
              </div>
            );
          })}
        </div>
      ) : <div className="dl-empty">Тут появятся файлы, которые ты сохранишь из чата.</div>}
      <button className="close" onClick={close}>Готово</button>
    </Backdrop>
  );
}

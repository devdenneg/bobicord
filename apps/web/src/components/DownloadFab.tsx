import { useEffect, useState } from 'react';
import { api } from '../api';
import { isTauri } from '../native';
import { Icon } from '../Icon';

// Карточка-промо десктоп-приложения на главной (вместо старого FAB справа-снизу). Только в браузере,
// только если на сервере есть билд. Не закрывается — всегда на виду.
export function DownloadCard() {
  const [dl, setDl] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => {
    if (isTauri) return;
    const controller = new AbortController();
    let generationCurrent = true;
    api.appLatest(controller.signal).then((value) => {
      if (generationCurrent && !controller.signal.aborted) setDl(value);
    }).catch(() => {});
    return () => { generationCurrent = false; controller.abort(); };
  }, []);
  if (isTauri || !dl) return null;
  return (
    <div className="dl-card">
      <div className="dl-ic"><Icon name="download" /></div>
      <div className="dl-txt"><b>Рилэй для рабочего стола</b></div>
      <a className="dl-btn" href={dl.url} download><Icon name="download" sm />Скачать</a>
    </div>
  );
}

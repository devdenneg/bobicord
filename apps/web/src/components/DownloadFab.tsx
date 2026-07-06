import { useEffect, useState } from 'react';
import { api } from '../api';
import { isTauri } from '../native';
import { Icon } from '../Icon';

// Плавающая кнопка скачивания десктоп-приложения (правый нижний угол).
// Показывается только на главном экране (см. App.tsx), только в браузере и если на сервере есть билд.
export function DownloadFab() {
  const [dl, setDl] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => { if (!isTauri) api.appLatest().then(setDl); }, []);
  if (!dl) return null;
  return (
    <a className="dl-fab" href={dl.url} download data-tip="DesktopApp">
      <Icon name="download" />
    </a>
  );
}

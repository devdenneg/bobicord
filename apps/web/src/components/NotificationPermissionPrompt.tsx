import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import {
  enableNotifications,
  notificationOptedOut,
  notificationPermissionGranted,
  notifPermission,
  notifSupported,
} from '../notify';
import { isTauri } from '../native';
import { useStore } from '../store';
import { iosSafariNeedsHomeScreenInstall } from '../pwaInstall';

const SNOOZE_KEY = 'relay.notifications.preprompt.snoozedUntil.v1';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function snoozed(): boolean {
  try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch { return false; }
}

export function NotificationPermissionPrompt() {
  const [visible, setVisible] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const modal = useStore((state) => state.modal);

  useEffect(() => {
    let cancelled = false;
    if (!notifSupported() || iosSafariNeedsHomeScreenInstall() || notificationOptedOut() || snoozed() || (!isTauri && notifPermission() === 'denied')) return;
    void notificationPermissionGranted().then((granted) => { if (!cancelled && !granted) setVisible(true); });
    return () => { cancelled = true; };
  }, []);

  if (!visible || modal) return null;
  const dismiss = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /**/ }
    setVisible(false);
  };
  const enable = async () => {
    setRequesting(true);
    const result = await enableNotifications(useStore.getState().me?.id || '');
    setRequesting(false);
    if (result.enabled) {
      try { localStorage.removeItem(SNOOZE_KEY); } catch { /**/ }
      setVisible(false);
      useStore.getState().toast('Уведомления включены', 'ok');
    } else {
      setVisible(false);
      useStore.getState().toast(result.error || (notifPermission() === 'denied'
        ? 'Уведомления заблокированы в настройках системы или браузера'
        : 'Не удалось включить уведомления'), 'warn');
    }
  };
  return (
    <aside className="notification-preprompt" aria-label="Включить уведомления">
      <span className="notification-preprompt-icon"><Icon name="bell" /></span>
      <div><b>Не пропускай ответы</b><p>RelayApp сможет сообщить об упоминаниях и открыть нужное сообщение. Содержимое можно скрыть в настройках.</p></div>
      <div className="notification-preprompt-actions">
        <button onClick={dismiss} disabled={requesting}>Не сейчас</button>
        <button className="primary" onClick={() => void enable()} disabled={requesting}>{requesting ? 'Запрашиваем…' : 'Включить'}</button>
      </div>
    </aside>
  );
}

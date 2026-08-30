import { useState } from 'react';
import { iosSafariNeedsHomeScreenInstall } from '../pwaInstall';

const IOS_INSTALL_SNOOZE_KEY = 'relay.ios.install.snoozed-until.v1';
const IOS_INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function installPromptSnoozed(): boolean {
  try { return Number(localStorage.getItem(IOS_INSTALL_SNOOZE_KEY) || 0) > Date.now(); }
  catch { return false; }
}

export function IosPwaInstallPrompt() {
  const [visible, setVisible] = useState(() => iosSafariNeedsHomeScreenInstall() && !installPromptSnoozed());
  if (!visible) return null;
  const dismiss = () => {
    try { localStorage.setItem(IOS_INSTALL_SNOOZE_KEY, String(Date.now() + IOS_INSTALL_SNOOZE_MS)); } catch { /**/ }
    setVisible(false);
  };
  return (
    <aside className="ios-pwa-install" aria-label="Установить RelayApp на iPhone или iPad">
      <div>
        <b>Установи RelayApp для фоновых уведомлений</b>
        <p>В Safari нажми «Поделиться» <span aria-hidden="true">□↑</span>, выбери «На экран Домой», затем открывай приложение с новой иконки. Во время разговора не сворачивай: iPhone приостанавливает микрофон в фоне.</p>
      </div>
      <button type="button" onClick={dismiss} aria-label="Напомнить об установке позже">Позже</button>
    </aside>
  );
}

import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { useEngine } from '../hooks';
import { useStore } from '../store';
import './commandOverlays.css';

export function ConnectivityBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const eng = useEngine();
  const view = useStore((s) => s.view);
  const active = useStore((s) => s.active);
  const loadingServer = useStore((s) => s.loadingServer);
  const viewServerId = useStore((s) => s.viewServerId);
  const connectServer = useStore((s) => s.connectServer);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); };
  }, []);

  const realtimeLost = online && view === 'server' && !!active && !loadingServer && viewServerId !== active.id;
  const reconnecting = online && eng.reconnecting;
  if (online && !reconnecting && !realtimeLost) return null;

  const title = !online ? 'Нет подключения к интернету' : reconnecting ? 'Связь восстанавливается…' : 'Связь с сервером прервана';
  const detail = !online ? 'Сообщения сохранятся в поле ввода. Проверь сеть — RelayApp продолжит автоматически.'
    : reconnecting ? 'Голос и сообщения временно приостановлены.' : 'Можно повторить подключение, не покидая текущий экран.';
  return (
    <div className={'connectivity-banner' + (!online || realtimeLost ? ' danger' : '')} role="status" aria-live="polite">
      <Icon name={!online || realtimeLost ? 'warn' : 'refresh'} sm />
      <span><b>{title}</b><small>{detail}</small></span>
      {realtimeLost && active ? <button onClick={() => void connectServer(active.id)}><Icon name="refresh" sm />Повторить</button> : null}
    </div>
  );
}

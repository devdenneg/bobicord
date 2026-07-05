import { useStore } from '../store';
import { Icon } from '../Icon';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const ic = (k: string) => (k === 'ok' ? 'check' : k === 'warn' ? 'warn' : k === 'err' ? 'warn' : 'info');
  return (
    <div id="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind} onClick={() => dismiss(t.id)}>
          <Icon name={ic(t.kind)} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

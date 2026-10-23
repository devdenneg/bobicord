import { useStore } from '../store';

// Тост (Paper 04 · уведомления): точка-индикатор вида + текст; ошибка — на подложке «эфира».
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div id="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind} onClick={() => dismiss(t.id)}>
          <i className="toast-dot" aria-hidden="true" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

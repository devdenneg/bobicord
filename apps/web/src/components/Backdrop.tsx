import { useEffect } from 'react';

export function Backdrop({ children, onClose, label, wide }: { children: React.ReactNode; onClose: () => void; label?: string; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="modal show" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className={'box' + (wide ? ' box-wide' : '')} role="dialog" aria-modal="true" aria-label={label}>{children}</div></div>;
}

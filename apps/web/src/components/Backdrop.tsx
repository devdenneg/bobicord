import { useEffect, useRef } from 'react';

let bodyLockDepth = 0;
let bodyOverflowBeforeDialogs = '';

export function Backdrop({ children, onClose, label, wide, boxClass }: { children: React.ReactNode; onClose: () => void; label?: string; wide?: boolean; boxClass?: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (bodyLockDepth === 0) {
      bodyOverflowBeforeDialogs = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyLockDepth += 1;
    const isTop = () => {
      const layers = document.querySelectorAll<HTMLElement>('.modal.show');
      return layers[layers.length - 1] === panel?.parentElement;
    };
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])') || []).filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0);
    const first = focusables()[0];
    const focusFrame = requestAnimationFrame(() => { if (isTop()) (first || panel)?.focus(); });
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) { e.preventDefault(); panel?.focus(); return; }
      const firstItem = items[0], lastItem = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (current === firstItem || !panel?.contains(current))) { e.preventDefault(); lastItem.focus(); }
      else if (!e.shiftKey && (current === lastItem || !panel?.contains(current))) { e.preventDefault(); firstItem.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
      bodyLockDepth = Math.max(0, bodyLockDepth - 1);
      if (bodyLockDepth === 0) document.body.style.overflow = bodyOverflowBeforeDialogs;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="modal show" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div ref={panelRef} tabIndex={-1} className={'box' + (wide ? ' box-wide' : '') + (boxClass ? ' ' + boxClass : '')} role="dialog" aria-modal="true" aria-label={label}>{children}</div></div>;
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'right' | 'bottom' | 'left';
type Tip = { target: HTMLElement; text: string; side: Side; source: 'pointer' | 'focus' };

const GAP = 10;
const EDGE = 8;

function preferredSide(target: HTMLElement): Side {
  if (target.closest('#rail') || target.classList.contains('tip-r')) return 'right';
  if (target.classList.contains('tip-b')) return 'bottom';
  if (target.classList.contains('tip-l')) return 'left';
  return 'top';
}

function targetOf(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; side: Side } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<number | undefined>(undefined);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const activeRef = useRef(false);
  const currentTargetRef = useRef<HTMLElement | null>(null);
  const describedRef = useRef<{ target: HTMLElement; previous: string | null } | null>(null);

  const clearShow = () => { if (showTimerRef.current) window.clearTimeout(showTimerRef.current); showTimerRef.current = undefined; };
  const clearHide = () => { if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); hideTimerRef.current = undefined; };
  const restoreDescription = () => {
    const described = describedRef.current;
    if (!described) return;
    if (described.previous === null) described.target.removeAttribute('aria-describedby');
    else described.target.setAttribute('aria-describedby', described.previous);
    describedRef.current = null;
  };
  const hide = () => {
    clearShow(); clearHide(); restoreDescription(); activeRef.current = false;
    currentTargetRef.current = null;
    setTip(null); setPosition(null);
  };

  useEffect(() => {
    const show = (target: HTMLElement, source: 'pointer' | 'focus') => {
      const text = target.dataset.tip?.trim();
      if (!text) return;
      clearShow(); clearHide();
      if (activeRef.current && currentTargetRef.current !== target) {
        restoreDescription();
        activeRef.current = false;
        currentTargetRef.current = null;
        setTip(null);
        setPosition(null);
      }
      showTimerRef.current = window.setTimeout(() => {
        if (!target.isConnected) return;
        restoreDescription();
        const previous = target.getAttribute('aria-describedby');
        const ids = new Set((previous || '').split(/\s+/).filter(Boolean));
        ids.add('global-tooltip');
        target.setAttribute('aria-describedby', [...ids].join(' '));
        describedRef.current = { target, previous };
        activeRef.current = true;
        currentTargetRef.current = target;
        setPosition(null);
        setTip({ target, text, side: preferredSide(target), source });
      }, source === 'focus' ? 0 : 320);
    };
    const scheduleHide = () => {
      clearHide();
      hideTimerRef.current = window.setTimeout(hide, 110);
    };
    const onOver = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('#global-tooltip')) { clearHide(); return; }
      const target = targetOf(event.target);
      if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
      show(target, 'pointer');
    };
    const onOut = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('#global-tooltip')) { scheduleHide(); return; }
      const target = targetOf(event.target);
      if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
      scheduleHide();
    };
    const onFocus = (event: FocusEvent) => { const target = targetOf(event.target); if (target) show(target, 'focus'); };
    const onBlur = (event: FocusEvent) => { const target = targetOf(event.target); if (target) hide(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activeRef.current) return;
      event.stopPropagation();
      hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearShow(); clearHide(); restoreDescription();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!tip || !box) return;
    if (!tip.target.isConnected) { hide(); return; }
    const rect = tip.target.getBoundingClientRect();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    let side = tip.side;
    if (side === 'top' && rect.top < height + GAP + EDGE) side = 'bottom';
    else if (side === 'bottom' && innerHeight - rect.bottom < height + GAP + EDGE) side = 'top';
    else if (side === 'left' && rect.left < width + GAP + EDGE) side = 'right';
    else if (side === 'right' && innerWidth - rect.right < width + GAP + EDGE) side = 'left';

    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - height - GAP;
    if (side === 'bottom') top = rect.bottom + GAP;
    if (side === 'left') { left = rect.left - width - GAP; top = rect.top + rect.height / 2 - height / 2; }
    if (side === 'right') { left = rect.right + GAP; top = rect.top + rect.height / 2 - height / 2; }
    left = Math.max(EDGE, Math.min(left, innerWidth - width - EDGE));
    top = Math.max(EDGE, Math.min(top, innerHeight - height - EDGE));
    setPosition({ left: Math.round(left), top: Math.round(top), side });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={boxRef} id="global-tooltip" className={'global-tooltip side-' + (position?.side || tip.side) + (tip.source === 'focus' ? ' from-focus' : '')} role="tooltip"
      style={position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}>
      {tip.text}
    </div>,
    document.body,
  );
}

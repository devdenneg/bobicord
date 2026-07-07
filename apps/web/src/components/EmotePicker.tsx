import { useEffect, useRef, useState, useCallback } from 'react';
import { searchEmotes, emoteUrlSm } from '../emotes';
import { useStore } from '../store';
import type { Emote } from '../types';

export function EmotePicker({ anchor, onPick, onClose, sizePicker }: { anchor: DOMRect | null; onPick: (e: Emote) => void; onClose: () => void; sizePicker?: boolean }) {
  const [items, setItems] = useState<Emote[]>([]);
  const [q, setQ] = useState('');
  const emoteSize = useStore((s) => s.emoteSize);
  const setEmoteSize = useStore((s) => s.setEmoteSize);
  const [loaded, setLoaded] = useState(false);
  const pageRef = useRef(0); const moreRef = useRef(true); const loadingRef = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (query: string, reset: boolean) => {
    if (loadingRef.current || (!reset && !moreRef.current)) return;
    loadingRef.current = true;
    const page = reset ? 1 : pageRef.current + 1;
    const res = await searchEmotes(query, page);
    loadingRef.current = false;
    moreRef.current = res.length >= 100;
    pageRef.current = page;
    setItems((prev) => (reset ? res : [...prev, ...res]));
    if (reset) setLoaded(true);
  }, []);

  useEffect(() => { moreRef.current = true; pageRef.current = 0; setItems([]); setLoaded(false); fetchPage(q, true); }, [q, fetchPage]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('#emoBtn') && !(e.target as HTMLElement).closest('.spray')) onClose();
    };
    document.addEventListener('mousedown', onDown);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const style: React.CSSProperties = anchor
    ? (() => {
        let top = anchor.top - 370; if (top < 8) top = Math.min(anchor.bottom + 8, window.innerHeight - 368);
        let left = anchor.left; if (left + 340 > window.innerWidth) left = window.innerWidth - 348;
        return { top: Math.max(8, top), left: Math.max(8, left) };
      })()
    : { right: 330, bottom: 72 };

  return (
    <div id="epick" className="show" role="dialog" aria-modal="true" aria-label="7TV эмоуты" style={style} ref={boxRef}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="epick-h">
        <input placeholder="Поиск 7TV эмоутов..." autoFocus={typeof matchMedia !== 'undefined' && matchMedia('(hover:hover) and (pointer:fine)').matches} value={q} onChange={(e) => setQ(e.target.value)} />
        <button aria-label="Закрыть" onClick={onClose}>✕</button>
      </div>
      {sizePicker ? (
        <div className="epick-size">
          <span>Размер</span>
          {(['sm', 'md', 'lg'] as const).map((s) => (
            <button key={s} className={emoteSize === s ? 'active' : ''} onClick={() => setEmoteSize(s)}>
              {s === 'sm' ? 'S' : s === 'md' ? 'M' : 'L'}
            </button>
          ))}
        </div>
      ) : null}
      <div id="epickGrid" ref={gridRef} onScroll={(e) => { const g = e.currentTarget; if (g.scrollTop + g.clientHeight >= g.scrollHeight - 100) fetchPage(q, false); }}>
        {items.length === 0 ? <div id="epickLoad">{loaded ? 'Ничего не найдено' : 'Загрузка...'}</div> :
          items.map((e) => (
            <button className="emobtn" key={e.id} title={e.name} onClick={() => onPick(e)}>
              <img src={emoteUrlSm(e.id)} alt={e.name} loading="lazy" decoding="async" />
            </button>
          ))}
      </div>
      <div id="epickHint">Powered by 7TV</div>
    </div>
  );
}

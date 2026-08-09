import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { getEngine, useStore } from '../store';
import './commandOverlays.css';

const RECENT_DESTINATIONS_KEY = 'relay.quick-switcher.recent.v1';

function readRecentDestinations(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_DESTINATIONS_KEY) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 8) : [];
  } catch { return []; }
}

export function rememberServerDestination(serverId: string) {
  try {
    const next = [serverId, ...readRecentDestinations().filter((id) => id !== serverId)].slice(0, 8);
    localStorage.setItem(RECENT_DESTINATIONS_KEY, JSON.stringify(next));
  } catch { /* storage may be unavailable */ }
}

interface Destination {
  id: string;
  label: string;
  detail: string;
  icon: string;
  kind: 'section' | 'server' | 'voice';
  keywords: string;
  action: () => void | Promise<void>;
}

export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const servers = useStore((s) => s.servers);
  const active = useStore((s) => s.active);
  const unread = useStore((s) => s.unread);
  const me = useStore((s) => s.me);
  const openServer = useStore((s) => s.openServer);
  const goHome = useStore((s) => s.goHome);
  const goAdmin = useStore((s) => s.goAdmin);
  const setModal = useStore((s) => s.setModal);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDialogKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = inputRef.current?.closest<HTMLElement>('.command-panel');
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'input,button,[href],[tabindex]:not([tabindex=-1])',
      )).filter((element) => !element.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onDialogKey);
    return () => {
      window.removeEventListener('keydown', onDialogKey);
      const opener = openerRef.current;
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
    };
  }, [open]);

  const destinations = useMemo(() => {
    const recent = readRecentDestinations();
    const recentRank = new Map(recent.map((id, index) => [id, index]));
    const items: Destination[] = [
      {
        id: 'section:home', label: 'Главная', detail: 'Обзор серверов и активности', icon: 'home', kind: 'section',
        keywords: 'главная домой home обзор', action: goHome,
      },
      {
        id: 'section:settings', label: 'Настройки', detail: 'Звук, уведомления и внешний вид', icon: 'gear', kind: 'section',
        keywords: 'настройки settings звук уведомления', action: () => setModal('settings'),
      },
    ];
    if (me?.isAdmin) items.push({
      id: 'section:admin', label: 'Админка', detail: 'Управление RelayApp', icon: 'users', kind: 'section',
      keywords: 'админка admin управление', action: goAdmin,
    });
    const rankedServers = [...servers].sort((a, b) => {
      const ar = recentRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const br = recentRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      return (unread[b.id] || 0) - (unread[a.id] || 0) || a.name.localeCompare(b.name, 'ru');
    });
    for (const server of rankedServers) items.push({
      id: `server:${server.id}`,
      label: server.name,
      detail: unread[server.id] ? `Непрочитанных: ${unread[server.id]}` : `${server.memberCount} участников`,
      icon: 'hash',
      kind: 'server',
      keywords: `${server.name} сервер server`,
      action: () => { rememberServerDestination(server.id); return openServer(server.id); },
    });
    for (const channel of active?.channels || []) items.push({
      id: `voice:${active!.id}:${channel.id}`,
      label: channel.name,
      detail: `Голосовой канал · ${active!.name}`,
      icon: 'speaker',
      kind: 'voice',
      keywords: `${channel.name} ${active!.name} голос voice`,
      action: async () => {
        rememberServerDestination(active!.id);
        await openServer(active!.id, undefined, 'channels');
        await getEngine()?.joinVoice(channel.id);
      },
    });
    return [
      ...items.filter((item) => item.kind === 'server'),
      ...items.filter((item) => item.kind === 'voice'),
      ...items.filter((item) => item.kind === 'section'),
    ];
  }, [active, goAdmin, goHome, me?.isAdmin, open, openServer, servers, setModal, unread]);

  const filtered = useMemo(() => {
    const raw = query.trim().toLocaleLowerCase('ru');
    const prefix = raw[0];
    const needle = (prefix === '*' || prefix === '!' ? raw.slice(1) : raw).trim();
    return destinations.filter((item) => {
      if (prefix === '*' && item.kind !== 'server') return false;
      if (prefix === '!' && item.kind !== 'voice') return false;
      return !needle || `${item.label} ${item.detail} ${item.keywords}`.toLocaleLowerCase('ru').includes(needle);
    }).slice(0, 14);
  }, [destinations, query]);

  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  if (!open) return null;
  const activate = (item?: Destination) => {
    if (!item) return;
    onClose();
    void item.action();
  };
  return (
    <div className="command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-panel" role="dialog" aria-modal="true" aria-label="Быстрый переход">
        <div className="command-input-wrap">
          <Icon name="search" />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Куда перейти?  * серверы · ! голосовые каналы"
            aria-label="Поиск серверов и разделов" aria-activedescendant={filtered[selected] ? `command-result-${filtered[selected].id}` : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); onClose(); }
              else if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index) => filtered.length ? (index + 1) % filtered.length : 0); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0); }
              else if (event.key === 'Enter') { event.preventDefault(); activate(filtered[selected]); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results" role="listbox" aria-label="Результаты">
          {filtered.length ? filtered.map((item, index) => (
            <button key={item.id} id={`command-result-${item.id}`} ref={index === selected ? selectedRef : undefined}
              className={'command-result' + (index === selected ? ' selected' : '')} role="option" aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)} onClick={() => activate(item)}>
              <span className="command-result-icon"><Icon name={item.icon} sm /></span>
              <span><b>{item.label}</b><small>{item.detail}</small></span>
              <em>{item.kind === 'server' ? '*' : item.kind === 'voice' ? '!' : '↵'}</em>
            </button>
          )) : <div className="command-empty">Ничего не найдено</div>}
        </div>
        <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Ctrl</kbd><kbd>/</kbd> все сочетания</span></footer>
      </section>
    </div>
  );
}

const SHORTCUTS = [
  ['Ctrl K', 'Быстрый переход'],
  ['Ctrl /', 'Показать эту справку'],
  ['Ctrl ,', 'Открыть настройки'],
  ['Alt ↑ / ↓', 'Предыдущий / следующий сервер'],
  ['Esc', 'Отметить текущий сервер прочитанным'],
  ['↑', 'Редактировать последнее сообщение в пустом поле'],
  ['Shift Enter', 'Новая строка в сообщении'],
];

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div className="command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="shortcut-panel" role="dialog" aria-modal="true" aria-label="Горячие клавиши">
        <header><span><Icon name="keyboard" /><b>Горячие клавиши</b></span><button ref={closeRef} onClick={onClose} aria-label="Закрыть"><Icon name="close" sm /></button></header>
        <div className="shortcut-list">
          {SHORTCUTS.map(([combo, label]) => <div className="shortcut-row" key={combo}><span>{label}</span><kbd>{combo}</kbd></div>)}
        </div>
      </section>
    </div>
  );
}

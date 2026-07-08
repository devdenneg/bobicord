import { useEffect, useMemo, useState } from 'react';
import { useStore, getEngine } from './store';
import { getSettings, setSettings, subscribeSettings } from './settings';
import { avColor, initial, normKey } from './util';
import { api, resolveUploadUrl } from './api';
import { Icon, IconSprite } from './Icon';
import { deriveLiveItems, rankServers, dominant, clusterOrder, type LiveItem } from './homeData';
import { Auth } from './components/Auth';
import { Toasts } from './components/Toasts';
import { ServerView } from './components/ServerView';
import { Modals } from './components/Modals';
import { DownloadFab } from './components/DownloadFab';
import { isTauri, setGlobalHotkeys, onGlobalHotkey } from './native';
import type { ServerSummary, OnlineMember, KeybindAction } from './types';
import { LogoLoader } from './components/LogoLoader';
import { initNotifications } from './notify';

function Rail() {
  const servers = useStore((s) => s.servers);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const loadingServerId = useStore((s) => s.loadingServerId);
  const connectedServerId = useStore((s) => s.connectedServerId);
  const me = useStore((s) => s.me)!;
  const openServer = useStore((s) => s.openServer);
  const goHome = useStore((s) => s.goHome);
  const setModal = useStore((s) => s.setModal);
  const unread = useStore((s) => s.unread);
  // подсвечиваем сервер только когда реально смотрим его (на главной — home активна)
  const activeId = view === 'server' ? (active?.id || loadingServerId) : null;
  return (
    <nav id="rail">
      <button className={'railbtn tip-l' + (!activeId ? ' active' : '')} data-tip="Домой" onClick={goHome}><Icon name="home" /></button>
      <div className="rail-sep" />
      {servers.map((s) => {
        const un = activeId === s.id ? 0 : (unread[s.id] || 0); // активный не бейджим (читаем его)
        return (
        <button key={s.id} className={'railbtn tip-l' + (activeId === s.id ? ' active' : '') + (connectedServerId === s.id && activeId !== s.id ? ' connected' : '') + (un ? ' unread' : '')}
          data-tip={connectedServerId === s.id && activeId !== s.id ? s.name + ' · подключён' : s.name}
          style={{ background: s.iconUrl ? '#0000' : avColor(s.name, s.iconColor) }} onClick={() => openServer(s.id)}>
          {s.iconUrl ? <img className="avimg" src={resolveUploadUrl(s.iconUrl)} alt="" /> : initial(s.name)}{s.onlineCount ? <span className="dot green" /> : null}
          {un ? <span className="rail-badge">{un > 99 ? '99+' : un}</span> : null}
        </button>
        );
      })}
      <button className="railbtn rail-add tip-l" data-tip="Создать / войти" onClick={() => setModal('create')}><Icon name="plus" /></button>
      <div className="rail-grow" />
      {/* Настройки — глобально в рейле (доступны и на главной, не только внутри сервера) */}
      <button className="railbtn rail-set tip-l" data-tip="Настройки" onClick={() => setModal('settings')}><Icon name="gear" /></button>
      <button className="railbtn rail-me tip-l" data-tip="Профиль" style={{ background: me.avatarUrl ? '#0000' : avColor(me.displayName, me.avatarColor) }} onClick={() => setModal('profile')}>{me.avatarUrl ? <img className="avimg" src={resolveUploadUrl(me.avatarUrl)} alt="" /> : initial(me.displayName)}</button>
    </nav>
  );
}

// аватар: картинка или инициал на цветном фоне (единый рендер лиц/иконок главной)
function Face({ url, name, color }: { url?: string; name: string; color: number }) {
  return url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : <>{initial(name)}</>;
}
const faceBg = (url: string | undefined, name: string, color: number) => (url ? '#0000' : avColor(name, color));

// ★ Сигнатурный примитив: перекрытые лица с кольцами-по-состоянию (стрим=красное, голос=зелёное) + «+N».
// Отрисован ИДЕНТИЧНО везде, где есть присутствие (живые карточки, серверные карточки, эфир).
function Cluster({ members, cap = 5 }: { members: OnlineMember[]; cap?: number }) {
  const ord = clusterOrder(members);
  const shown = ord.slice(0, cap);
  const extra = ord.length - shown.length;
  if (!shown.length) return null;
  return (
    <div className="cluster">
      {shown.map((m) => (
        <span key={m.username} className={'mini-av' + (m.streaming ? ' live' : m.inVoice ? ' voice' : '')}
          style={{ background: faceBg(m.avatarUrl, m.displayName, m.avatarColor) }}
          title={m.displayName + (m.streaming ? ' · трансляция' : m.inVoice ? ' · в голосе' : ' · в сети')}>
          <Face url={m.avatarUrl} name={m.displayName} color={m.avatarColor} />
        </span>
      ))}
      {extra > 0 ? <span className="more">+{extra}</span> : null}
    </div>
  );
}

// Живой кластер того, кто в сети, с раскрытием по ховеру (реюз .sc-tip) — кто и чем занят.
function PresenceRow({ on }: { on: OnlineMember[] }) {
  if (!on.length) return <div className="sc-none">тихо</div>;
  return (
    <div className="sc-online">
      <Cluster members={on} />
      <div className="sc-tip" role="tooltip">
        <div className="sc-tip-h">В сети · {on.length}</div>
        {clusterOrder(on).map((m) => (
          <div key={m.username} className="sc-tip-row">
            <span className="sc-tip-av" style={{ background: faceBg(m.avatarUrl, m.displayName, m.avatarColor) }}><Face url={m.avatarUrl} name={m.displayName} color={m.avatarColor} /></span>
            <span className="sc-tip-nm">{m.displayName}</span>
            <span className={'sc-tip-st' + (m.streaming ? ' live' : m.inVoice ? ' voice' : '')}>{m.streaming ? 'трансляция' : m.inVoice ? 'в голосе' : 'в сети'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Доминант-бейдж карточки: ровно ОДИН громкий сигнал (live > voice > unread > online > quiet).
function DominantBadge({ s, unread }: { s: ServerSummary; unread: Record<string, number> }) {
  const d = dominant(s, unread);
  if (d.kind === 'live') return <span className="dominant live"><i className="live-dot" />LIVE</span>;
  if (d.kind === 'voice') return <span className="dominant voice"><Icon name="mic-sm" sm />{d.n}</span>;
  if (d.kind === 'unread') return <span className="dominant unread" title={d.n + ' непрочитанных сообщений'}><Icon name="chat" sm />{d.n}</span>;
  if (d.kind === 'online') return <span className="dominant online"><i className="dot green" />{d.n}</span>;
  return <span className="dominant quiet">тихо</span>;
}

// Живая карточка эфира (герой S1): стрим или голос, с CTA-прыжком.
function LiveCard({ item, onOpen }: { item: LiveItem; onOpen: () => void }) {
  const s = item.server;
  if (item.kind === 'stream') {
    const m = item.member;
    const others = (s.online || []).filter((x) => x.username !== m.username);
    return (
      <div className="live-card stream">
        <div className="lc-top"><span className="live-pill"><i className="live-dot" />LIVE</span><span className="lc-srv">{s.name}</span></div>
        <div className="lc-lead">
          <span className="lc-av live" style={{ background: faceBg(m.avatarUrl, m.displayName, m.avatarColor) }}><Face url={m.avatarUrl} name={m.displayName} color={m.avatarColor} /></span>
          <div className="lc-who"><b>{m.displayName}</b><span>Трансляция{item.alsoVoice ? ' · и в голосе' : ''}</span></div>
        </div>
        <div className="lc-foot">{others.length ? <Cluster members={others} cap={6} /> : <span />}<button className="cta" onClick={onOpen}>Смотреть</button></div>
      </div>
    );
  }
  return (
    <div className="live-card voice">
      <div className="lc-top"><span className="live-pill voice-pill"><Icon name="mic-sm" sm />{item.members.length} в голосе</span><span className="lc-srv">{s.name}</span></div>
      <div className="lc-foot"><Cluster members={item.members} cap={6} /><button className="cta" onClick={onOpen}>Зайти</button></div>
    </div>
  );
}

function ServerCard({ s, unread, connected, onOpen }: { s: ServerSummary; unread: Record<string, number>; connected: boolean; onOpen: () => void }) {
  const on = s.online || [];
  const d = dominant(s, unread);
  const isLive = d.kind === 'live' || d.kind === 'voice';
  return (
    <button className={'srv-card' + (isLive ? ' is-live' : '') + (connected ? ' is-connected' : '')} onClick={onOpen}>
      <div className="sc-h">
        <div className="sc-ic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor), overflow: 'hidden' }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="sc-nm">{s.name}</div>
          <div className="sc-sub">{s.memberCount} участник(ов){s.role === 'owner' ? ' · владелец' : ''}</div>
        </div>
        <DominantBadge s={s} unread={unread} />
      </div>
      <PresenceRow on={on} />
    </button>
  );
}

function StatPill({ icon, n, label }: { icon?: 'green' | 'acc'; n: number; label: string }) {
  return <span className="stat-pill">{icon ? <i className={'dot ' + (icon === 'green' ? 'green' : 'acc')} /> : null}<b>{n}</b> {label}</span>;
}

// Главная — «пультовая»: что происходит СЕЙЧАС во всех твоих мирах (эфир) + куда прыгнуть, а не список серверов.
function Home() {
  const me = useStore((s) => s.me)!;
  const servers = useStore((s) => s.servers);
  const unread = useStore((s) => s.unread);
  const connectedId = useStore((s) => s.connectedServerId);
  const openServer = useStore((s) => s.openServer);
  const setModal = useStore((s) => s.setModal);
  const refreshServers = useStore((s) => s.refreshServers);
  const [filter, setFilter] = useState<'all' | 'unread' | 'mine'>('all');

  // Поллинг присутствия главной (мы не в комнате): держим «эфир» свежим, пока вкладка видима; мгновенно
  // на фокус/возврат вкладки. refreshServers тянет /me (свежие online[]/unread) — переиспользуем.
  useEffect(() => {
    const tick = () => { if (!document.hidden) refreshServers(); };
    const id = window.setInterval(tick, 12000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick); };
  }, [refreshServers]);

  const live = useMemo(() => deriveLiveItems(servers, unread, connectedId), [servers, unread, connectedId]);
  const ranked = useMemo(() => rankServers(servers, unread), [servers, unread]);
  const shown = useMemo(() => ranked.filter((s) => filter === 'unread' ? (unread[s.id] || 0) > 0 : filter === 'mine' ? s.role === 'owner' : true), [ranked, filter, unread]);
  const totalOnline = servers.reduce((n, s) => n + (s.onlineCount || 0), 0);
  const totalUnread = servers.reduce((n, s) => n + (unread[s.id] || 0), 0);
  const firstName = me.displayName.split(' ')[0];
  const connectedServer = connectedId ? servers.find((s) => s.id === connectedId) : null;
  const waiting = ranked.filter((s) => (unread[s.id] || 0) > 0);

  // Нет серверов — приветственный герой с двумя действиями (тот же .bigbtn).
  if (!servers.length) {
    return (
      <section id="home">
        <header className="home-hd">
          <div className="home-brand"><LogoLoader size={40} speedMs={8000} /><span>Рилэй</span></div>
          <div className="hd-actions"><button className="hd-me" onClick={() => setModal('profile')} style={{ background: faceBg(me.avatarUrl, me.displayName, me.avatarColor) }}><Face url={me.avatarUrl} name={me.displayName} color={me.avatarColor} /></button></div>
        </header>
        <div className="home-body home-welcome">
          <div className="hw-inner">
            <h1>Тут пока пусто</h1>
            <p>Создай свой мир или зайди по приглашению.</p>
            <div className="home-actions">
              <button className="bigbtn" onClick={() => setModal('create')}><div className="bi g"><Icon name="plus" /></div><div><b>Создать сервер</b><span>Свой сервер для друзей</span></div></button>
              <button className="bigbtn" onClick={() => setModal('join')}><div className="bi a"><Icon name="link" /></div><div><b>Присоединиться</b><span>По коду или ссылке-приглашению</span></div></button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="home">
      <header className="home-hd">
        <div className="home-brand"><LogoLoader size={40} speedMs={8000} /><span>Рилэй</span></div>
        <span className="hd-greet">здарова, {firstName}</span>
        <div className="stat-strip">
          <StatPill n={servers.length} label="серверов" />
          <StatPill icon="green" n={totalOnline} label="в сети" />
          {totalUnread ? <StatPill icon="acc" n={totalUnread} label="непрочитано" /> : null}
        </div>
        <div className="hd-actions">
          <button className="hd-create" onClick={() => setModal('create')}><Icon name="plus" sm />Создать</button>
          <button className="hd-join" onClick={() => setModal('join')}>Войти</button>
          <button className="hd-me" onClick={() => setModal('profile')} style={{ background: faceBg(me.avatarUrl, me.displayName, me.avatarColor) }}><Face url={me.avatarUrl} name={me.displayName} color={me.avatarColor} /></button>
        </div>
      </header>

      <div className="home-body home-enter">
        {/* Приоритет ДИНАМИЧЕСКИЙ: эфир — герой ТОЛЬКО когда он есть. Пусто → ведут «Тебя ждут» и серверы,
            а «никто не в эфире» ужимается в тонкую строку внизу (не доминирует экраном показывая ничего). */}
        {live.length ? <>
          <div className="home-sec hot">Сейчас в эфире</div>
          <div className="live-grid">{live.map((it) => <LiveCard key={it.key} item={it} onOpen={() => openServer(it.server.id)} />)}</div>
        </> : null}

        {waiting.length ? <>
          <div className="home-sec">Тебя ждут</div>
          <div className="catchup">
            {waiting.map((s) => (
              <button key={s.id} className="cu-chip" onClick={() => openServer(s.id)}>
                <span className="cu-ic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></span>
                <span className="cu-nm">{s.name}</span><b>{unread[s.id]}</b>
              </button>
            ))}
          </div>
        </> : null}

        <div className="home-sec">Твои серверы</div>
        <div className="home-chips">
          {(['all', 'unread', 'mine'] as const).map((f) => (
            <button key={f} className={'chip' + (filter === f ? ' on' : '')} onClick={() => setFilter(f)}>{f === 'all' ? 'Все' : f === 'unread' ? 'Непрочитанное' : 'Мои'}</button>
          ))}
        </div>
        <div className="srv-grid">
          {shown.length ? shown.map((s) => <ServerCard key={s.id} s={s} unread={unread} connected={connectedId === s.id} onOpen={() => openServer(s.id)} />)
            : <div className="sc-none" style={{ gridColumn: '1/-1', padding: 10 }}>Ничего не найдено по фильтру.</div>}
        </div>

        {/* нет эфира — тонкая строка-шёпот внизу, не большой пустой герой */}
        {!live.length ? (
          <div className="live-quiet">
            <span className="lq-ic"><Icon name="screen" sm /></span>
            <span className="lq-tx">Сейчас никто не в эфире</span>
            {connectedServer ? <button className="lq-cta" onClick={() => openServer(connectedServer.id)}>Вернуться в {connectedServer.name}</button> : null}
          </div>
        ) : null}

        {/* дубль действий из хедера — крупными карточками в теле (быстрый доступ, не только мелкие кнопки сверху) */}
        <div className="home-sec">Добавить сервер</div>
        <div className="home-actions">
          <button className="bigbtn" onClick={() => setModal('create')}><div className="bi g"><Icon name="plus" /></div><div><b>Создать сервер</b><span>Свой сервер для друзей</span></div></button>
          <button className="bigbtn" onClick={() => setModal('join')}><div className="bi a"><Icon name="link" /></div><div><b>Присоединиться</b><span>По коду или ссылке-приглашению</span></div></button>
        </div>
      </div>
    </section>
  );
}

// Скелетон сервера вместо блёклого спиннера: повторяет форму реального лэйаута
// (каналы · чат · участники), чтобы переход «загрузка → контент» был плавным, без прыжка.
// Ширины берём из тех же localStorage-ключей, что и настоящий ServerView (иначе колонки скакнут).
function ServerSkeleton() {
  const chW = +(localStorage.getItem('w:channels') || 290);
  const memW = +(localStorage.getItem('w:members') || 244);
  const memOpen = localStorage.getItem('membersOpen') !== '0';
  const rows = (n: number) => Array.from({ length: n });
  return (
    <div className="srv-sk" aria-busy="true" aria-label="Загрузка сервера">
      <div className="sk-col sk-ch" style={{ width: chW }}>
        <div className="sk-line sk-title" style={{ width: '55%' }} />
        <div className="sk-voicecard">
          <div className="sk-line" style={{ width: '58%' }} />
          {rows(3).map((_, i) => <div className="sk-vrow" key={i}><span className="sk-av" /><span className="sk-line" style={{ width: `${48 + (i % 3) * 14}%` }} /></div>)}
        </div>
      </div>
      <div className="sk-col sk-main">
        <div className="sk-header"><span className="sk-line" style={{ width: 90 }} /></div>
        <div className="sk-chat">
          {rows(8).map((_, i) => (
            <div className="sk-msg" key={i}>
              <span className="sk-line sk-who" style={{ width: 66 + (i % 4) * 24 }} />
              <span className="sk-bubble" style={{ width: `${36 + ((i * 41) % 46)}%` }} />
            </div>
          ))}
        </div>
        <div className="sk-composer"><span className="sk-line" /></div>
      </div>
      {memOpen ? (
        <div className="sk-col sk-mem" style={{ width: memW }}>
          <div className="sk-line sk-title" style={{ width: '45%' }} />
          {rows(7).map((_, i) => <div className="sk-vrow" key={i}><span className="sk-av" /><span className="sk-line" style={{ width: `${44 + (i % 4) * 13}%` }} /></div>)}
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const view = useStore((s) => s.view);
  const loadingServer = useStore((s) => s.loadingServer);
  const me = useStore((s) => s.me);

  // Уведомления: при первом входе (после логина) запрашиваем разрешение автоматически и
  // включаем — отключить можно в Настройках → Уведомления (там же ставится опт-аут, чтобы
  // не переспрашивать). initNotifications сам уважает опт-аут и не пристаёт повторно.
  useEffect(() => {
    if (!me) return;
    initNotifications().then((welcomed) => {
      if (welcomed) useStore.getState().toast('Уведомления включены — отключить можно в Настройках → Уведомления', 'info');
    }).catch(() => {});
  }, [me]);

  // hotkeys (мут микрофона / заглушить звук — настраиваемые комбинации из keybinds, + PTT) —
  // active while logged in. Работает ВСЕГДА, пока окно в фокусе (keydown на window иначе и не
  // придёт) — независимо от чекбокса «глобально»: нативный WH_KEYBOARD_LL-хук (см. эффект ниже)
  // сам проверяет фокус своего окна и не эмитит событие, если оно в фокусе, — так что здесь и там
  // никогда не сработает дважды на одно нажатие. PTT глобального режима не имеет — всегда тут.
  useEffect(() => {
    if (!me) return;
    const pressed = new Set<string>();
    const armed: Record<KeybindAction, boolean> = { muteMic: false, deafen: false };
    const kd = (e: KeyboardEvent) => {
      const E = getEngine(); if (!E) return;
      const t = document.activeElement as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      const s = getSettings();
      const nk = normKey(e.code);
      pressed.add(nk);
      if (E.inVoice && !typing) {
        (Object.keys(armed) as KeybindAction[]).forEach((action) => {
          const combo = s.keybinds[action].map(normKey);
          if (!armed[action] && combo.length && combo.every((c) => pressed.has(c))) {
            armed[action] = true;
            action === 'muteMic' ? E.toggleMic() : E.toggleDeaf();
          }
        });
      }
      if (s.mode === 'ptt' && !typing && e.code === s.pttKey) E.pttPress();
    };
    const ku = (e: KeyboardEvent) => {
      const E = getEngine(); if (!E) return;
      const s = getSettings();
      const nk = normKey(e.code);
      pressed.delete(nk);
      (Object.keys(armed) as KeybindAction[]).forEach((action) => { if (s.keybinds[action].map(normKey).includes(nk)) armed[action] = false; });
      if (s.mode === 'ptt' && e.code === s.pttKey) E.pttRelease();
    };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, [me]);

  // натив: держим Rust-хук (WH_KEYBOARD_LL) в курсе актуальных биндов/режима (чекбокс «отключить
  // вне приложения» = enabled false — хук вообще ничего не матчит). Хук сам не эмитит, пока наше
  // окно в фокусе (см. hotkeys.rs), поэтому событие сюда прилетает только когда фокус не у нас.
  useEffect(() => {
    if (!isTauri) return;
    const sync = () => { const s = getSettings(); setGlobalHotkeys(s.keybinds, !s.disableGlobalHotkeys); };
    sync();
    const unsubSettings = subscribeSettings(sync);
    let unlisten: (() => void) | undefined;
    onGlobalHotkey((action) => {
      const E = getEngine(); if (!E || !E.inVoice) return;
      action === 'muteMic' ? E.toggleMic() : E.toggleDeaf();
    }).then((un) => { unlisten = un; });
    return () => { unsubSettings(); unlisten?.(); };
  }, []);

  // хоткеи привязаны к аккаунту, а не к устройству/браузеру: подтягиваем при логине (можно
  // зайти под тем же аккаунтом на другой машине) и отправляем на сервер при изменении —
  // но только когда реально меняются keybinds/disableGlobalHotkeys, а не любая настройка
  // (иначе на каждый чих слайдера громкости улетал бы запрос).
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    api.getMySettings().then((d) => {
      if (cancelled) return;
      const remote = d?.data || {};
      const s = getSettings();
      const patch: Partial<ReturnType<typeof getSettings>> = {};
      if (remote.keybinds) patch.keybinds = { ...s.keybinds, ...remote.keybinds };
      if (typeof remote.disableGlobalHotkeys === 'boolean') patch.disableGlobalHotkeys = remote.disableGlobalHotkeys;
      if (Object.keys(patch).length) setSettings(patch);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const snapshot = () => JSON.stringify({ keybinds: getSettings().keybinds, disableGlobalHotkeys: getSettings().disableGlobalHotkeys });
    let last = snapshot();
    const push = () => {
      const cur = snapshot();
      if (cur === last) return;
      last = cur;
      api.putMySettings(JSON.parse(cur)).catch(() => {});
    };
    return subscribeSettings(push);
  }, [me]);

  return (
    <>
      <IconSprite />
      <Toasts />
      {view === 'loading' ? (
        <div className="overlay" style={{ background: 'var(--bg)' }}>
          <LogoLoader size={200} />
        </div>
      ) : view === 'auth' ? <Auth /> : (
        <div id="app" className="on">
          <Rail />
          {view === 'home' ? <Home /> : (loadingServer ? <ServerSkeleton /> : <ServerView />)}
        </div>
      )}
      <Modals />
      {view === 'home' ? <DownloadFab /> : null}
      <div id="audioSink" style={{ display: 'none' }} />
    </>
  );
}

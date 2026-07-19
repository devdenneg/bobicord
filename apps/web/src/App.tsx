import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, getEngine } from './store';
import { getSettings, setSettings, subscribeSettings } from './settings';
import { avColor, initial, normKey } from './util';
import { api, resolveUploadUrl } from './api';
import { Icon, IconSprite } from './Icon';
import { deriveLiveItems, deriveGames, rankServers, dominant, clusterOrder, type LiveItem, type GameGroup } from './homeData';
import { Auth } from './components/Auth';
import { AccountEmailGate } from './components/AccountEmailGate';
import { Toasts } from './components/Toasts';
import { ServerView } from './components/ServerView';
import { AdminPage } from './components/AdminPage';
import { VoiceDock } from './components/VoiceDock';
import { useEngine } from './hooks';
import { Modals } from './components/Modals';
import { DownloadCard } from './components/DownloadFab';
import { applyNativeUpdate } from './nativeUpdate';
import { isTauri, setGlobalHotkeys, onGlobalHotkey, setDetectableGames } from './native';
import type { ServerSummary, OnlineMember, KeybindAction } from './types';
import { LogoLoader } from './components/LogoLoader';
import { initNotifications } from './notify';
import { TooltipLayer } from './components/TooltipLayer';

// версия принудительного сброса хоткеев на новые дефолты — см. эффект хоткеев ниже
const HK_RESET_V = 1;

function Rail() {
  const servers = useStore((s) => s.servers);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const loadingServerId = useStore((s) => s.loadingServerId);
  const eng = useEngine();
  const me = useStore((s) => s.me)!;
  const openServer = useStore((s) => s.openServer);
  const goHome = useStore((s) => s.goHome);
  const setModal = useStore((s) => s.setModal);
  const goAdmin = useStore((s) => s.goAdmin);
  const unread = useStore((s) => s.unread);
  // подсвечиваем сервер только когда реально смотрим его (на главной — home активна)
  const activeId = view === 'server' ? (active?.id || loadingServerId) : null;
  return (
    <nav id="rail" aria-label="Серверы и разделы">
      <div className="rail-primary">
        <button className={'railbtn tip-l' + (view === 'home' ? ' active' : '')} aria-label="Домой" data-tip="Домой" onClick={goHome}><Icon name="home" /></button>
        <div className="rail-sep" />
        {servers.map((s) => {
          const un = activeId === s.id ? 0 : (unread[s.id] || 0); // активный не бейджим (читаем его)
          return (
          <button key={s.id} className={'railbtn tip-l' + (activeId === s.id ? ' active' : '') + (eng.voiceServerId === s.id && activeId !== s.id ? ' connected' : '') + (un ? ' unread' : '')}
            aria-label={s.name + (eng.voiceServerId === s.id && activeId !== s.id ? ' — вы в голосовом канале' : '')}
            data-tip={eng.voiceServerId === s.id && activeId !== s.id ? s.name + ' · в голосе' : s.name}
            style={{ background: s.iconUrl ? '#0000' : avColor(s.name, s.iconColor) }} onClick={() => openServer(s.id)}>
            {s.iconUrl ? <img className="avimg" src={resolveUploadUrl(s.iconUrl)} alt="" /> : initial(s.name)}{(s.online || []).some((m) => m.inVoice) ? <span className="dot green" /> : null}
            {un ? <span className="rail-badge">{un > 99 ? '99+' : un}</span> : null}
          </button>
          );
        })}
        <button className="railbtn rail-add tip-l" aria-label="Создать сервер или войти" data-tip="Создать / войти" onClick={() => setModal('create')}><Icon name="plus" /></button>
      </div>
      <div className="rail-grow" />
      <div className="rail-tools" role="group" aria-label="Инструменты аккаунта">
        {me.isAdmin ? <button className="railbtn rail-admin tip-l" aria-label="Админка" data-tip="Админка" onClick={goAdmin}><Icon name="users" /></button> : null}
        {/* Настройки — глобально в рейле (доступны и на главной, не только внутри сервера) */}
        <button className="railbtn rail-set tip-l" aria-label="Настройки" data-tip="Настройки" onClick={() => setModal('settings')}><Icon name="gear" /></button>
        <button className="railbtn rail-dl tip-l" aria-label="Загрузки" data-tip="Загрузки" onClick={() => setModal('downloads')}><Icon name="download" /></button>
        <button className="railbtn rail-me tip-l" aria-label="Профиль" data-tip="Профиль" style={{ background: me.avatarUrl ? '#0000' : avColor(me.displayName, me.avatarColor) }} onClick={() => setModal('profile')}>{me.avatarUrl ? <img className="avimg" src={resolveUploadUrl(me.avatarUrl)} alt="" /> : initial(me.displayName)}</button>
      </div>
    </nav>
  );
}

// аватар: картинка или инициал на цветном фоне (единый рендер лиц/иконок главной)
function Face({ url, name }: { url?: string; name: string; color: number }) {
  return url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : <>{initial(name)}</>;
}
const faceBg = (url: string | undefined, name: string, color: number) => (url ? '#0000' : avColor(name, color));
const pluralRu = (n: number, one: string, few: string, many: string) => {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  return mod100 > 10 && mod100 < 20 ? many : mod10 === 1 ? one : mod10 > 1 && mod10 < 5 ? few : many;
};

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
        <span key={m.username} className={'mini-av' + (m.streaming ? ' live' : m.inVoice ? ' voice' : m.away ? ' away' : '')}
          style={{ background: faceBg(m.avatarUrl, m.displayName, m.avatarColor) }}
          title={m.displayName + (m.streaming ? ' · трансляция' : m.inVoice ? ' · в голосе' : m.away ? ' · нет на месте' : ' · в сети')}>
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
            <span className={'sc-tip-st' + (m.streaming ? ' live' : m.inVoice ? ' voice' : m.away ? ' away' : '')}>{m.streaming ? 'трансляция' : m.inVoice ? 'в голосе' : m.away ? 'нет на месте' : 'в сети'}</span>
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

// Живая карточка эфира (герой главной): ОДНА на сервер — обложка+имя сервера, бейджи LIVE/голос,
// ведущий стример (если есть), кластер активных, CTA-прыжок.
function LiveCard({ item, onOpen }: { item: LiveItem; onOpen: () => void }) {
  const s = item.server;
  const hasStream = item.streamers.length > 0;
  const active = [...item.streamers, ...item.voice]; // все активные — для кластера лиц
  const lead = item.streamers[0];                    // ведущий стример (если стримят несколько — «+N»)
  return (
    <div className={'live-card' + (hasStream ? ' stream' : ' voice')}
      role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
      <div className="lc-top">
        <span className="lc-srvic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></span>
        <span className="lc-srv">{s.name}</span>
        <span className="lc-badges">
          {hasStream ? <span className="live-pill"><i className="live-dot" />LIVE</span> : null}
          {item.voice.length ? <span className="live-pill voice-pill"><Icon name="mic-sm" sm />{item.voice.length}</span> : null}
        </span>
      </div>
      {lead ? (
        <div className="lc-lead">
          <span className="lc-av live" style={{ background: faceBg(lead.avatarUrl, lead.displayName, lead.avatarColor) }}><Face url={lead.avatarUrl} name={lead.displayName} color={lead.avatarColor} /></span>
          <div className="lc-who"><b>{lead.displayName}{item.streamers.length > 1 ? ` +${item.streamers.length - 1}` : ''}</b><span>Трансляция{lead.inVoice ? ' · и в голосе' : ''}</span></div>
        </div>
      ) : null}
      <div className="lc-foot">
        {active.length ? <Cluster members={active} cap={6} /> : <span />}
        <span className="cta" aria-hidden="true">{hasStream ? 'Смотреть' : 'Зайти'}</span>
      </div>
    </div>
  );
}

function ServerCard({ s, unread, connected, onOpen }: { s: ServerSummary; unread: Record<string, number>; connected: boolean; onOpen: () => void }) {
  const on = s.online || [];
  const d = dominant(s, unread);
  const isLive = d.kind === 'live' || d.kind === 'voice';
  const coverUrl = s.iconUrl ? resolveUploadUrl(s.iconUrl) : ''; // обложка сервера как фон-декор карточки
  const tint = avColor(s.name, s.iconColor);                     // цвет-подложка (фолбэк без обложки + glow)
  return (
    <button className={'srv-card' + (isLive ? ' is-live' : '') + (connected ? ' is-connected' : '') + (coverUrl ? ' has-cover' : '')} aria-label={`Открыть сервер ${s.name}`} onClick={onOpen} style={{ ['--tint' as any]: tint }}>
      <span className="sc-cover" aria-hidden="true" style={coverUrl ? { ['--cover' as any]: `url("${coverUrl}")` } : undefined} />
      <div className="sc-h">
        <div className="sc-ic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor), overflow: 'hidden' }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="sc-nm">{s.name}</div>
          <div className="sc-sub">{s.memberCount} {pluralRu(s.memberCount, 'участник', 'участника', 'участников')}{s.role === 'owner' ? ' · владелец' : ''}</div>
        </div>
        <DominantBadge s={s} unread={unread} />
      </div>
      <PresenceRow on={on} />
    </button>
  );
}

// Баннер обновления (веб-рефреш ИЛИ натив-апдейт) — акцентный, для главной (в сервере свой в ServerView).
function UpdateBanner() {
  const updateReady = useStore((s) => s.updateReady);
  const nativeUpdate = useStore((s) => s.nativeUpdate);
  const toast = useStore((s) => s.toast);
  const [updating, setUpdating] = useState(false);
  if (updateReady) {
    return (
      <div className="update-bar">
        <div className="ub-ic"><Icon name="refresh" /></div>
        <div className="ub-txt"><b>Вышло обновление приложения</b><span>Обнови страницу, чтобы продолжить — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd></span></div>
        <button className="ub-btn" onClick={() => location.reload()}><Icon name="refresh" sm />Обновить</button>
      </div>
    );
  }
  if (nativeUpdate) {
    return (
      <div className="update-bar">
        <div className="ub-ic"><Icon name="refresh" /></div>
        <div className="ub-txt"><b>Доступна версия {nativeUpdate.version}</b><span>{updating ? 'Скачиваю и устанавливаю — приложение перезапустится…' : 'Обновить приложение до свежей версии'}</span></div>
        <button className="ub-btn" disabled={updating} onClick={async () => { setUpdating(true); try { await applyNativeUpdate(); } catch (e: any) { setUpdating(false); toast('Не удалось обновить: ' + (e?.message || e), 'err'); } }}>
          {updating ? <span className="spin" /> : <Icon name="refresh" sm />}Установить
        </button>
      </div>
    );
  }
  return null;
}

// «Играют сейчас» — прикольный кросс-серверный блок: карточка на игру (иконка + кластер игроков + счётчик).
function GamesNow({ games }: { games: GameGroup[] }) {
  return (
    <div className="games-grid">
      {games.map((g) => (
        <div className="game-card" key={g.name} title={g.players.map((p) => p.displayName).join(', ')}>
          <div className="gc-ic">{g.icon ? <img src={`data:image/png;base64,${g.icon}`} alt="" /> : <span className="gc-pad">🎮</span>}</div>
          <div className="gc-body">
            <div className="gc-nm">{g.name}</div>
            <div className="gc-players"><Cluster members={g.players} cap={5} /><span className="gc-count">{g.players.length}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function HomeSectionHeading({ eyebrow, title, detail, tone }: { eyebrow: string; title: string; detail?: string; tone?: 'live' | 'accent' }) {
  return (
    <div className={'home-section-head' + (tone ? ' ' + tone : '')}>
      <div><span>{eyebrow}</span><h2>{title}</h2></div>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

function HomeMetric({ icon, value, label, tone }: { icon: string; value: number; label: string; tone?: 'live' | 'green' | 'accent' }) {
  return (
    <div className={'home-metric' + (tone ? ' ' + tone : '')}>
      <span className="hm-icon"><Icon name={icon} sm /></span>
      <span><b>{value}</b><small>{label}</small></span>
    </div>
  );
}

function dayGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

// Главная — «пультовая»: что происходит СЕЙЧАС во всех твоих мирах (эфир) + куда прыгнуть, а не список серверов.
function Home() {
  const me = useStore((s) => s.me)!;
  const servers = useStore((s) => s.servers);
  const unread = useStore((s) => s.unread);
  const connectedId = useStore((s) => s.viewServerId);
  const openServer = useStore((s) => s.openServer);
  const setModal = useStore((s) => s.setModal);
  const refreshServers = useStore((s) => s.refreshServers);
  const eng = useEngine();
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
  const games = useMemo(() => deriveGames(servers), [servers]);
  const ranked = useMemo(() => rankServers(servers, unread), [servers, unread]);
  const shown = useMemo(() => ranked.filter((s) => filter === 'unread' ? (unread[s.id] || 0) > 0 : filter === 'mine' ? s.role === 'owner' : true), [ranked, filter, unread]);
  const onlineMembers = useMemo(() => {
    const unique = new Map<string, OnlineMember>();
    for (const server of servers) for (const member of server.online || []) {
      const current = unique.get(member.username);
      if (!current || (!current.streaming && member.streaming) || (!current.inVoice && member.inVoice)) unique.set(member.username, member);
    }
    return clusterOrder([...unique.values()]);
  }, [servers]);
  const totalOnline = onlineMembers.length || servers.reduce((n, s) => n + (s.onlineCount || 0), 0);
  const totalStreaming = onlineMembers.filter((m) => m.streaming).length;
  const totalInVoice = onlineMembers.filter((m) => m.inVoice).length;
  const totalUnread = servers.reduce((n, s) => n + (unread[s.id] || 0), 0);
  const firstName = me.displayName.split(' ')[0];
  const connectedServer = connectedId ? servers.find((s) => s.id === connectedId) : null;
  const voiceServer = eng.voiceServerId ? servers.find((s) => s.id === eng.voiceServerId) : null;
  const waiting = ranked.filter((s) => (unread[s.id] || 0) > 0);
  const heroServer = voiceServer || live[0]?.server || connectedServer || ranked[0] || null;
  const heroLive = heroServer ? live.find((item) => item.server.id === heroServer.id) : undefined;
  const heroMembers = heroServer?.online?.length ? heroServer.online : onlineMembers;
  const heroWatchUser = heroLive?.streamers[0]?.username;
  const heroIsCurrentVoice = Boolean(eng.inVoice && voiceServer?.id === heroServer?.id);
  const heroIsLive = Boolean(heroLive?.streamers.length);
  const heroIsVoice = heroIsCurrentVoice || Boolean(heroLive?.voice.length);
  const heroIsOnline = heroIsVoice || Boolean(heroServer && ((heroServer.online?.length || heroServer.onlineCount || 0) > 0));
  const primaryLabel = !heroServer ? 'Создать первый сервер'
    : heroIsCurrentVoice ? 'Вернуться в голос'
      : heroIsLive ? 'Смотреть эфир'
        : connectedServer?.id === heroServer.id ? 'Продолжить разговор'
          : heroLive?.voice.length ? 'Зайти к друзьям' : `Открыть ${heroServer.name}`;
  const primaryHint = !heroServer ? 'Это займёт меньше минуты'
    : heroIsCurrentVoice ? heroServer.name
      : heroIsLive ? `${heroLive!.streamers[0].displayName} уже в эфире`
        : heroLive?.voice.length ? `${heroLive.voice.length} в голосовом канале` : 'Перейти на сервер';
  const heroKicker = heroIsCurrentVoice && voiceServer ? `Ты в голосе · ${voiceServer.name}`
    : heroIsLive ? `${heroLive!.streamers.length} ${pluralRu(heroLive!.streamers.length, 'трансляция', 'трансляции', 'трансляций')} · ${heroServer!.name}`
      : heroIsVoice ? `${heroLive?.voice.length || totalInVoice} ${pluralRu(heroLive?.voice.length || totalInVoice, 'человек', 'человека', 'человек')} в голосе`
        : totalOnline ? `${totalOnline} онлайн на твоих серверах` : 'Твоя точка встречи';
  const heroText = !servers.length ? 'Создай своё пространство, позови друзей и начинай созвон без лишних экранов.'
    : heroIsCurrentVoice ? 'Разговор уже идёт — вернись в голосовой канал одним нажатием.'
      : heroIsLive ? 'Самое живое уже собрано здесь — подключайся к трансляции в один клик.'
        : heroIsVoice ? 'Друзья уже в голосе. Заходи в разговор без лишних экранов.'
        : totalUnread ? 'Новые сообщения и твои серверы собраны в одном спокойном потоке.'
          : 'Всё спокойно. Серверы, голос, чат и трансляции готовы, когда понадобятся.';
  const gamePlayers = games.reduce((n, game) => n + game.players.length, 0);
  const runPrimary = () => heroServer ? openServer(heroServer.id, heroWatchUser, heroWatchUser ? 'main' : 'channels') : setModal('create');

  return (
    <section id="home">
      <header className="home-hd">
        <div className="home-brand"><LogoLoader size={40} speedMs={8000} /><span>Рилэй</span></div>
        <div className="hd-context" aria-live="polite">
          <i className={'dot ' + (totalOnline ? 'green' : '')} />
          <span>{totalOnline ? `${totalOnline} онлайн` : 'готов к связи'}</span>
        </div>
        <div className="hd-actions">
          <button className="hd-create" aria-label="Создать сервер" onClick={() => setModal('create')}><Icon name="plus" sm /><span>Создать</span></button>
          <button className="hd-join" aria-label="Войти по приглашению" onClick={() => setModal('join')}><Icon name="link" sm /><span>Войти</span></button>
          <button className="hd-me" aria-label="Открыть профиль" onClick={() => setModal('profile')} style={{ background: faceBg(me.avatarUrl, me.displayName, me.avatarColor) }}><Face url={me.avatarUrl} name={me.displayName} color={me.avatarColor} /></button>
        </div>
      </header>

      <div className="home-body home-enter">
        <UpdateBanner />
        <DownloadCard />

        <section className={'home-hero' + (heroIsLive ? ' is-live' : heroIsVoice ? ' is-voice' : '')}>
          <div className="hero-copy">
            <div className="hero-kicker"><i className="hero-signal" /><span>{heroKicker}</span></div>
            <h1>{servers.length ? <>{dayGreeting()}, <em>{firstName}</em></> : <>Твой голос.<br /><em>Твои люди.</em></>}</h1>
            <p>{heroText}</p>
            <div className="hero-actions">
              <button className="hero-primary" onClick={runPrimary}>
                <span className="hero-action-icon"><Icon name={heroServer ? (heroLive?.streamers.length ? 'play' : 'speaker') : 'plus'} /></span>
                <span><b>{primaryLabel}</b><small>{primaryHint}</small></span>
                <Icon name="chevron" sm />
              </button>
              <button className="hero-secondary" onClick={() => setModal(heroServer ? 'create' : 'join')}>
                <Icon name={heroServer ? 'plus' : 'link'} sm />{heroServer ? 'Новый сервер' : 'Войти по приглашению'}
              </button>
            </div>
          </div>

          <div className="hero-activity" role="status" aria-label={heroKicker}>
            <div className="ha-glow" aria-hidden="true" />
            <div className="ha-top"><span>ПРЯМО СЕЙЧАС</span><i className={heroIsLive ? 'live' : heroIsOnline ? 'online' : ''}>{heroIsLive ? 'LIVE' : heroIsOnline ? 'ONLINE' : 'READY'}</i></div>
            {heroServer ? (
              <div className="ha-server">
                <span className="ha-server-icon" style={{ background: faceBg(heroServer.iconUrl, heroServer.name, heroServer.iconColor) }}><Face url={heroServer.iconUrl} name={heroServer.name} color={heroServer.iconColor} /></span>
                <span><b>{heroServer.name}</b><small>{heroLive?.streamers.length ? 'Идёт трансляция' : heroLive?.voice.length ? 'Разговор уже начался' : connectedServer?.id === heroServer.id ? 'Можно быстро вернуться' : 'Готов к созвону'}</small></span>
                {heroLive?.streamers.length ? <span className="ha-live"><i />LIVE</span> : null}
              </div>
            ) : (
              <div className="ha-empty"><span><Icon name="speaker" /></span><b>Первый созвон начинается здесь</b><small>Сервер объединит голос, чат и трансляции.</small></div>
            )}
            <div className="ha-people">
              {heroMembers.length ? <Cluster members={heroMembers} cap={7} /> : <div className="ha-orbit" aria-hidden="true"><i /><i /><i /></div>}
              <span>{heroMembers.length ? `${Math.min(heroMembers.length, 7)} ${pluralRu(Math.min(heroMembers.length, 7), 'друг онлайн', 'друга рядом', 'друзей рядом')}` : 'Место уже готово'}</span>
            </div>
            <div className="home-metrics">
              <HomeMetric icon="users" value={totalOnline} label="онлайн" tone="green" />
              <HomeMetric icon="mic-sm" value={totalInVoice} label="в голосе" tone="accent" />
              <HomeMetric icon="screen" value={totalStreaming} label="в эфире" tone="live" />
            </div>
          </div>
        </section>

        {!servers.length ? (
          <>
            <HomeSectionHeading eyebrow="Три шага" title="От тишины до разговора" detail="Без сложной настройки" />
            <div className="onboarding-grid">
              <article><span>01</span><Icon name="plus" /><div><b>Создай сервер</b><p>Одно пространство для своей компании.</p></div></article>
              <article><span>02</span><Icon name="link" /><div><b>Позови друзей</b><p>Отправь им короткую ссылку.</p></div></article>
              <article><span>03</span><Icon name="speaker" /><div><b>Начни созвон</b><p>Голос, чат и экран уже внутри.</p></div></article>
            </div>
          </>
        ) : null}

        {live.length ? <>
          <HomeSectionHeading eyebrow="Живое" title="Сейчас в эфире" detail={`${live.length} ${pluralRu(live.length, 'активный сервер', 'активных сервера', 'активных серверов')}`} tone="live" />
          <div className="live-grid">{live.map((it) => <LiveCard key={it.key} item={it} onOpen={() => openServer(it.server.id, it.streamers[0]?.username)} />)}</div>
        </> : null}

        {games.length ? <>
          <HomeSectionHeading eyebrow="Активность" title="Играют сейчас" detail={`${gamePlayers} ${pluralRu(gamePlayers, 'игрок', 'игрока', 'игроков')}`} />
          <GamesNow games={games} />
        </> : null}

        {waiting.length ? <>
          <HomeSectionHeading eyebrow="Непрочитанное" title="Тебя ждут" detail={`${totalUnread} ${pluralRu(totalUnread, 'новое сообщение', 'новых сообщения', 'новых сообщений')}`} tone="accent" />
          <div className="catchup">
            {waiting.map((s) => (
              <button key={s.id} className="cu-chip" onClick={() => openServer(s.id, undefined, 'main')}>
                <span className="cu-ic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></span>
                <span className="cu-nm">{s.name}</span><b>{unread[s.id]}</b>
              </button>
            ))}
          </div>
        </> : null}

        {servers.length ? <>
          <HomeSectionHeading eyebrow="Пространства" title="Твои серверы" detail={`${shown.length} из ${servers.length}`} />
          <div className="home-chips">
            {(['all', 'unread', 'mine'] as const).map((f) => (
              <button key={f} className={'chip' + (filter === f ? ' on' : '')} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'Все' : f === 'unread' ? 'Непрочитанное' : 'Мои'}</button>
            ))}
          </div>
          <div className="srv-grid">
            {shown.length ? shown.map((s) => <ServerCard key={s.id} s={s} unread={unread} connected={connectedId === s.id} onOpen={() => openServer(s.id)} />)
              : <div className="sc-none" style={{ gridColumn: '1/-1', padding: 10 }}>Ничего не найдено по фильтру.</div>}
          </div>
        </> : null}

        {servers.length && !live.length ? (
          <div className="live-quiet">
            <span className="lq-ic"><Icon name="screen" sm /></span>
            <span className="lq-tx">Сейчас никто не в эфире</span>
            {connectedServer ? <button className="lq-cta" onClick={() => openServer(connectedServer.id)}>Вернуться в {connectedServer.name}</button> : null}
          </div>
        ) : null}

        <HomeSectionHeading eyebrow="Быстрый старт" title={servers.length ? 'Собери своих' : 'Начни прямо сейчас'} detail="Все действия под рукой" />
        <div className="home-actions quick-actions">
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
  const entryTab = useStore((s) => s.serverEntryTab);
  const chW = +(localStorage.getItem('w:channels') || 292);
  const memW = +(localStorage.getItem('w:members') || 304);
  const singlePane = window.innerWidth <= 900;
  const compactDesktop = window.innerWidth >= 1241 && window.innerWidth <= 1360;
  const skeletonChW = compactDesktop ? Math.min(chW, 280) : chW;
  const skeletonMemW = compactDesktop ? Math.min(memW, 220) : memW;
  const chOpen = window.innerWidth <= 1240 || localStorage.getItem('channelsOpen') !== '0';
  const memOpen = localStorage.getItem('membersOpen') !== '0';
  const showChannels = singlePane ? entryTab === 'channels' : chOpen;
  const showMain = !singlePane || entryTab === 'main';
  const showMembers = singlePane ? entryTab === 'members' : memOpen;
  const rows = (n: number) => Array.from({ length: n });
  return (
    <div className="srv-sk" aria-busy="true" aria-label="Загрузка сервера">
      {showChannels ? <div className="sk-col sk-ch" style={{ width: singlePane ? '100%' : skeletonChW, display: singlePane ? 'flex' : undefined }}>
        <div className="sk-line sk-title" style={{ width: '55%' }} />
        <div className="sk-voicecard">
          <div className="sk-line" style={{ width: '58%' }} />
          {rows(3).map((_, i) => <div className="sk-vrow" key={i}><span className="sk-av" /><span className="sk-line" style={{ width: `${48 + (i % 3) * 14}%` }} /></div>)}
        </div>
      </div> : null}
      {showMain ? <div className="sk-col sk-main">
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
      </div> : null}
      {showMembers ? (
        <div className="sk-col sk-mem" style={{ width: singlePane ? '100%' : skeletonMemW, display: singlePane ? 'flex' : undefined }}>
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
  const accountGate = useStore((s) => s.accountGate);

  // Уведомления: при первом входе (после логина) запрашиваем разрешение автоматически и
  // включаем — отключить можно в Настройках → Уведомления (там же ставится опт-аут, чтобы
  // не переспрашивать). initNotifications сам уважает опт-аут и не пристаёт повторно.
  useEffect(() => {
    if (!me) return;
    initNotifications().then((welcomed) => {
      if (welcomed) useStore.getState().toast('Уведомления включены — отключить можно в Настройках → Уведомления', 'info');
    }).catch(() => {});
    // натив: подтягиваем аллоулист игр Discord (сервер дистиллирует) → Rust матчит процессы для детекта
    if (isTauri) api.detectableGames().then((d) => { if (d?.games?.length) setDetectableGames(d.games); }).catch(() => {});
  }, [me]);

  // Прямой заход по /admin (ввод URL или reload): открываем админку, если юзер админ. Иначе игнор —
  // останется home (кнопку в рейле всё равно видят только админы, серверные ручки за requireAdmin).
  useEffect(() => {
    if (me?.isAdmin && location.pathname.startsWith('/admin')) useStore.getState().goAdmin();
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
  //
  // HK_RESET_V — принудительный одноразовый сброс хоткеев на новые дефолты (пустые бинды +
  // выключенный глобальный хук): у аккаунтов, уже сохранивших старые бинды на сервере, remote
  // не совпадёт с этой версией → игнорируем remote.keybinds/disableGlobalHotkeys (локальные
  // дефолты из settings.ts уже новые) и штампуем версию обратно, чтобы сброс не повторялся на
  // каждом логине. hkResetVRef держит актуальную версию для push-эффекта ниже (иначе он перезаписал
  // бы блоб без штампа при следующем изменении бинда пользователем).
  const hkResetVRef = useRef(HK_RESET_V);
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    api.getMySettings().then((d) => {
      if (cancelled) return;
      const remote = d?.data || {};
      const needsReset = remote.hkResetV !== HK_RESET_V;
      if (!needsReset) {
        const s = getSettings();
        const patch: Partial<ReturnType<typeof getSettings>> = {};
        if (remote.keybinds) patch.keybinds = { ...s.keybinds, ...remote.keybinds };
        if (typeof remote.disableGlobalHotkeys === 'boolean') patch.disableGlobalHotkeys = remote.disableGlobalHotkeys;
        if (Object.keys(patch).length) setSettings(patch);
      } else {
        // локальные дефолты (settings.ts) уже пустые бинды + disableGlobalHotkeys:true — просто фиксируем версию на сервере
        api.putMySettings({ keybinds: getSettings().keybinds, disableGlobalHotkeys: getSettings().disableGlobalHotkeys, hkResetV: HK_RESET_V }).catch(() => {});
      }
      hkResetVRef.current = HK_RESET_V;
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
      api.putMySettings({ ...JSON.parse(cur), hkResetV: hkResetVRef.current }).catch(() => {});
    };
    return subscribeSettings(push);
  }, [me]);

  return (
    <>
      <IconSprite />
      <Toasts />
      <TooltipLayer />
      {accountGate ? <AccountEmailGate /> : view === 'loading' ? (
        <div className="overlay" style={{ background: 'var(--bg)' }}>
          <LogoLoader size={200} />
        </div>
      ) : view === 'auth' ? <Auth /> : (
        <>
          <div id="app" className="on">
            <Rail />
            {view === 'admin' ? <AdminPage /> : view === 'home' ? <Home /> : (loadingServer ? <ServerSkeleton /> : <ServerView />)}
          </div>
          {/* На сервере голос-панель живёт ВНУТРИ колонки каналов (ServerView, адаптируется по ширине).
              На главной — компактный плавающий док в левом нижнем углу. */}
          {view === 'home' || view === 'admin' ? <VoiceDock variant="floating" /> : null}
        </>
      )}
      <Modals />
      <div id="audioSink" style={{ display: 'none' }} />
    </>
  );
}

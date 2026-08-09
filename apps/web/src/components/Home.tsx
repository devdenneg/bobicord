import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial } from '../util';
import { resolveUploadUrl } from '../api';
import { deriveLiveItems, deriveGames, rankServers, dominant, clusterOrder, type LiveItem, type GameGroup } from '../homeData';
import type { ServerSummary, OnlineMember } from '../types';
import { LogoLoader } from './LogoLoader';
import { DownloadCard } from './DownloadFab';
import { applyNativeUpdate } from '../nativeUpdate';
import './home.css';

// Редизайн главной («пультовая»): вверху — присутствие («что можно сделать сейчас»), затем активность,
// затем плотный список серверов, второстепенное свёрнуто. Большое приветствие — только в first-run.
// Каждый живой объект показан РОВНО один раз, действие живёт на его карточке (см. ресёрч-синтез).

const faceBg = (url: string | undefined, name: string, color: number) => (url ? '#0000' : avColor(name, color));
const pluralRu = (n: number, one: string, few: string, many: string) => {
  const mod100 = Math.abs(n) % 100; const mod10 = mod100 % 10;
  return mod100 > 10 && mod100 < 20 ? many : mod10 === 1 ? one : mod10 > 1 && mod10 < 5 ? few : many;
};
// картинка или инициал на цветном фоне
function Face({ url, name }: { url?: string; name: string; color: number }) {
  return url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : <>{initial(name)}</>;
}

// перекрытые лица с кольцами по состоянию (стрим=красное, голос=зелёное, отошёл=жёлтое) + «+N»
function Cluster({ members, cap = 5 }: { members: OnlineMember[]; cap?: number }) {
  const ord = clusterOrder(members);
  const shown = ord.slice(0, cap);
  const extra = ord.length - shown.length;
  if (!shown.length) return null;
  return (
    <div className="nh-cluster">
      {shown.map((m) => (
        <span key={m.username} className={'nh-face' + (m.streaming ? ' live' : m.inVoice ? ' voice' : m.away ? ' away' : '')}
          style={{ background: faceBg(m.avatarUrl, m.displayName, m.avatarColor) }}
          title={m.displayName + (m.streaming ? ' · трансляция' : m.inVoice ? ' · в голосе' : m.away ? ' · нет на месте' : ' · в сети')}>
          <Face url={m.avatarUrl} name={m.displayName} color={m.avatarColor} />
        </span>
      ))}
      {extra > 0 ? <span className="more">+{extra}</span> : null}
    </div>
  );
}

// ровно один доминирующий сигнал карточки сервера
function DominantBadge({ s, unread }: { s: ServerSummary; unread: Record<string, number> }) {
  const d = dominant(s, unread);
  if (d.kind === 'live') return <span className="nh-badge live"><i className="live-dot" />LIVE</span>;
  if (d.kind === 'voice') return <span className="nh-badge voice"><Icon name="mic-sm" sm />{d.n}</span>;
  if (d.kind === 'unread') return <span className="nh-badge unread" title={d.n + ' непрочитанных'}><Icon name="chat" sm />{d.n}</span>;
  if (d.kind === 'online') return <span className="nh-badge online"><i className="dot-green" />{d.n}</span>;
  return <span className="nh-badge quiet">тихо</span>;
}

// живая карточка эфира: одно действие (Смотреть/Зайти) прямо на карточке
function LiveCard({ item, onOpen }: { item: LiveItem; onOpen: () => void }) {
  const s = item.server;
  const hasStream = item.streamers.length > 0;
  const active = [...item.streamers, ...item.voice];
  const lead = item.streamers[0];
  return (
    <div className={'nh-card' + (hasStream ? ' stream' : '')}
      role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
      <div className="nh-ct">
        <span className="nh-srvic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></span>
        <span className="nh-srvnm">{s.name}</span>
        <span className="nh-pills">
          {hasStream ? <span className="nh-pill live"><i className="live-dot" />LIVE</span> : null}
          {item.voice.length ? <span className="nh-pill voice"><Icon name="mic-sm" sm />{item.voice.length}</span> : null}
        </span>
      </div>
      {lead ? (
        <div className="nh-lead">
          <span className="nh-lead-av" style={{ background: faceBg(lead.avatarUrl, lead.displayName, lead.avatarColor) }}><Face url={lead.avatarUrl} name={lead.displayName} color={lead.avatarColor} /></span>
          <div className="nh-lead-who"><b>{lead.displayName}{item.streamers.length > 1 ? ` +${item.streamers.length - 1}` : ''}</b><span>Трансляция{lead.inVoice ? ' · и в голосе' : ''}</span></div>
        </div>
      ) : null}
      <div className="nh-cf">
        {active.length ? <Cluster members={active} cap={6} /> : <span />}
        <span className="nh-cta" aria-hidden="true"><Icon name={hasStream ? 'play' : 'speaker'} sm />{hasStream ? 'Смотреть' : 'Зайти'}</span>
      </div>
    </div>
  );
}

// плотная карточка сервера: один бейдж-сигнал + кластер присутствия
function ServerCard({ s, unread, connected, onOpen }: { s: ServerSummary; unread: Record<string, number>; connected: boolean; onOpen: () => void }) {
  const on = s.online || [];
  const d = dominant(s, unread);
  const isLive = d.kind === 'live' || d.kind === 'voice';
  return (
    <button className={'nh-srv' + (isLive ? ' live' : '') + (connected ? ' connected' : '')} aria-label={`Открыть сервер ${s.name}`} onClick={onOpen}>
      <div className="nh-sh">
        <div className="nh-sic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></div>
        <div className="nh-smeta">
          <div className="nh-snm">{s.name}</div>
          <div className="nh-ssub">{s.memberCount} {pluralRu(s.memberCount, 'участник', 'участника', 'участников')}{s.role === 'owner' ? ' · владелец' : ''}</div>
        </div>
        <DominantBadge s={s} unread={unread} />
      </div>
      <div className="nh-spres">{on.length ? <Cluster members={on} cap={7} /> : <span className="quiet">тихо</span>}</div>
    </button>
  );
}

// баннер обновления (веб-рефреш ИЛИ натив-апдейт)
function UpdateBanner() {
  const updateReady = useStore((s) => s.updateReady);
  const nativeUpdate = useStore((s) => s.nativeUpdate);
  const toast = useStore((s) => s.toast);
  const [updating, setUpdating] = useState(false);
  if (updateReady) return (
    <div className="nh-update">
      <div className="ui"><Icon name="refresh" /></div>
      <div className="ut"><b>Вышло обновление</b><span>Обнови страницу — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd></span></div>
      <button className="ub" onClick={() => location.reload()}><Icon name="refresh" sm />Обновить</button>
    </div>
  );
  if (nativeUpdate) return (
    <div className="nh-update">
      <div className="ui"><Icon name="refresh" /></div>
      <div className="ut"><b>Доступна версия {nativeUpdate.version}</b><span>{updating ? 'Устанавливаю — приложение перезапустится…' : 'Обновить до свежей версии'}</span></div>
      <button className="ub" disabled={updating} onClick={async () => { setUpdating(true); try { await applyNativeUpdate(); } catch (e: any) { setUpdating(false); toast('Не удалось обновить: ' + (e?.message || e), 'err'); } }}>
        {updating ? <span className="spin" /> : <Icon name="refresh" sm />}Установить
      </button>
    </div>
  );
  return null;
}

function SectionHead({ eyebrow, title, detail, tone }: { eyebrow: string; title: string; detail?: string; tone?: 'live' | 'accent' }) {
  return (
    <div className={'nh-sec-h' + (tone ? ' ' + tone : '')}>
      <div><span className="eye">{eyebrow}</span><h2>{title}</h2></div>
      {detail ? <span className="detail">{detail}</span> : null}
    </div>
  );
}

export function Home() {
  const me = useStore((s) => s.me)!;
  const servers = useStore((s) => s.servers);
  const unread = useStore((s) => s.unread);
  const connectedId = useStore((s) => s.viewServerId);
  const openServer = useStore((s) => s.openServer);
  const setModal = useStore((s) => s.setModal);
  const refreshServers = useStore((s) => s.refreshServers);
  const eng = useEngine();
  const [filter, setFilter] = useState<'all' | 'unread' | 'mine'>('all');

  // Поллинг присутствия (мы не в комнате): держим «эфир» свежим, пока вкладка видима; мгновенно на фокус.
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
  const totalOnline = useMemo(() => {
    const uniq = new Set<string>();
    for (const s of servers) for (const m of s.online || []) uniq.add(m.username);
    return uniq.size || servers.reduce((n, s) => n + (s.onlineCount || 0), 0);
  }, [servers]);
  const totalUnread = servers.reduce((n, s) => n + (unread[s.id] || 0), 0);
  const totalLiveServers = servers.filter((s) => (s.online || []).some((m) => m.streaming || m.inVoice)).length; // без кэпа 8 (live обрезан для показа)
  const gamePlayers = games.reduce((n, g) => n + g.players.length, 0);
  const waiting = ranked.filter((s) => (unread[s.id] || 0) > 0);
  const voiceServer = eng.voiceServerId ? servers.find((s) => s.id === eng.voiceServerId) : null;
  const connectedServer = connectedId ? servers.find((s) => s.id === connectedId) : null;
  const recent = ranked.slice(0, 3);
  const firstName = me.displayName.split(' ')[0];

  const header = (
    <header className="nh-hd">
      <div className="nh-brand"><LogoLoader size={36} speedMs={8000} /><span>Рилэй</span></div>
      <div className={'nh-online' + (totalOnline ? ' live' : '')} aria-live="polite"><i className="nh-dot" />{totalOnline ? `${totalOnline} онлайн` : 'готов к связи'}</div>
      <div className="nh-actions">
        <button className="nh-btn primary" aria-label="Создать сервер" onClick={() => setModal('create')}><Icon name="plus" sm /><span>Создать</span></button>
        <button className="nh-btn" aria-label="Войти по приглашению" onClick={() => setModal('join')}><Icon name="link" sm /><span>Войти</span></button>
        <button className="nh-me" aria-label="Профиль" onClick={() => setModal('profile')} style={{ background: faceBg(me.avatarUrl, me.displayName, me.avatarColor) }}><Face url={me.avatarUrl} name={me.displayName} color={me.avatarColor} /></button>
      </div>
    </header>
  );

  // ---------- Первый запуск: единственное место, где уместно большое приветствие ----------
  if (!servers.length) {
    return (
      <section className="nh">
        {header}
        <div className="nh-body"><div className="nh-inner nh-enter">
          <UpdateBanner />
          <div className="nh-first">
            <div>
              <h1>Привет, {firstName}.<br />Твой голос. <em>Твои люди.</em></h1>
              <p className="sub">Создай своё пространство, позови друзей и начинай созвон без лишних экранов.</p>
            </div>
            <div className="nh-steps">
              <div className="nh-step"><span className="snum">01</span><span className="sic"><Icon name="plus" /></span><b>Создай сервер</b><p>Одно пространство для своей компании.</p></div>
              <div className="nh-step"><span className="snum">02</span><span className="sic"><Icon name="link" /></span><b>Позови друзей</b><p>Отправь им короткую ссылку.</p></div>
              <div className="nh-step"><span className="snum">03</span><span className="sic"><Icon name="speaker" /></span><b>Начни созвон</b><p>Голос, чат и экран уже внутри.</p></div>
            </div>
            <div className="cta-row">
              <button className="nh-btn primary" onClick={() => setModal('create')}><Icon name="plus" sm /><span>Создать сервер</span></button>
              <button className="nh-btn" onClick={() => setModal('join')}><Icon name="link" sm /><span>Войти по приглашению</span></button>
            </div>
          </div>
          <DownloadCard />
        </div></div>
      </section>
    );
  }

  // ---------- Возвращающийся пользователь ----------
  return (
    <section className="nh">
      {header}
      <div className="nh-body"><div className="nh-inner nh-enter">
        <UpdateBanner />

        {eng.inVoice && voiceServer ? (
          <button className="nh-resume" onClick={() => openServer(voiceServer.id)}>
            <i className="nh-dot" />Вернуться в голос · {voiceServer.name}
          </button>
        ) : null}

        {live.length ? (
          <section className="nh-sec">
            <SectionHead eyebrow="Живое" title="Сейчас в эфире" tone="live" detail={`${totalLiveServers} ${pluralRu(totalLiveServers, 'активный сервер', 'активных сервера', 'активных серверов')}`} />
            <div className="nh-live">{live.map((it) => <LiveCard key={it.key} item={it} onOpen={() => openServer(it.server.id, it.streamers[0]?.username)} />)}</div>
          </section>
        ) : (
          <div className="nh-quiet">
            <span className="nh-qic"><Icon name="screen" sm /></span>
            <span>Сейчас никто не в эфире. <b>Тихо и спокойно.</b></span>
            {connectedServer ? <span className="nh-recent"><button className="nh-chip" onClick={() => openServer(connectedServer.id)}><i className="nh-dot" style={{ background: 'var(--accent)' }} />Вернуться в {connectedServer.name}</button></span>
              : recent.length ? <span className="nh-recent">{recent.map((s) => <button key={s.id} className="nh-chip" onClick={() => openServer(s.id)}><span className="nh-ci" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></span>{s.name}</button>)}</span> : null}
          </div>
        )}

        {waiting.length ? (
          <section className="nh-sec">
            <SectionHead eyebrow="Непрочитанное" title="Тебя ждут" tone="accent" detail={`${totalUnread} ${pluralRu(totalUnread, 'новое сообщение', 'новых сообщения', 'новых сообщений')}`} />
            <div className="nh-wait">
              {waiting.map((s) => (
                <button key={s.id} className="nh-chip" onClick={() => openServer(s.id, undefined, 'main')}>
                  <span className="nh-ci" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} color={s.iconColor} /></span>
                  {s.name}<span className="nh-cnum">{unread[s.id]}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="nh-sec">
          <SectionHead eyebrow="Пространства" title="Твои серверы" detail={`${shown.length} из ${servers.length}`} />
          <div className="nh-filters">
            {(['all', 'unread', 'mine'] as const).map((f) => (
              <button key={f} className={'nh-fchip' + (filter === f ? ' on' : '')} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'Все' : f === 'unread' ? 'Непрочитанное' : 'Мои'}</button>
            ))}
          </div>
          <div className="nh-grid">
            {shown.length ? shown.map((s) => <ServerCard key={s.id} s={s} unread={unread} connected={connectedId === s.id} onOpen={() => openServer(s.id)} />)
              : <div className="nh-empty">
                <span className="nh-eic"><Icon name="search" /></span>
                <div role="status"><b>{filter === 'unread' ? 'Всё прочитано' : filter === 'mine' ? 'Своих серверов нет' : 'Серверов пока нет'}</b><p>{filter === 'unread' ? 'Новых сообщений сейчас нет.' : 'Создай сервер — он появится здесь.'}</p></div>
                <button type="button" onClick={() => setFilter('all')}>Показать все</button>
              </div>}
          </div>
        </section>

        {games.length ? (
          <details className="nh-games">
            <summary><Icon name="screen" sm />Играют сейчас<span className="gcount"> · {gamePlayers} {pluralRu(gamePlayers, 'игрок', 'игрока', 'игроков')}</span><span className="chev"><Icon name="chevron" sm /></span></summary>
            <div className="nh-gamesgrid">
              {games.map((g: GameGroup) => (
                <div className="nh-game" key={g.name} title={g.players.map((p) => p.displayName).join(', ')}>
                  <div className="gi">{g.icon ? <img src={`data:image/png;base64,${g.icon}`} alt="" /> : '🎮'}</div>
                  <div className="gb"><div className="gn">{g.name}</div><div className="gp"><Cluster members={g.players} cap={5} /><span className="gcnt">{g.players.length}</span></div></div>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <DownloadCard />
      </div></div>
    </section>
  );
}

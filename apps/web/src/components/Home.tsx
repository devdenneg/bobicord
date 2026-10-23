import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useStore } from '../store';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial, initials2, plural } from '../util';
import { resolveUploadUrl } from '../api';
import { deriveLiveItems, deriveGames, rankServers, clusterOrder, type LiveItem, type GameGroup } from '../homeData';
import type { ServerSummary, OnlineMember } from '../types';
import { DownloadCard } from './DownloadFab';
import { applyNativeUpdate } from '../nativeUpdate';
import './home.css';

// Главная: заголовок с действиями, «Сейчас в эфире» (эфир — большой карточкой, голос — рядом),
// сетка серверов с колонкой «Играют сейчас», внизу — загрузка приложения. Каждый живой объект
// показан ровно один раз, действие живёт на его карточке.

const faceBg = (url: string | undefined, name: string, color: number) => (url ? 'transparent' : avColor(name, color));
const tint = (name: string, color?: number) => ({ '--tint': avColor(name, color) } as CSSProperties);
const onKeyOpen = (open: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
};

function Face({ url, name, two }: { url?: string; name: string; two?: boolean }) {
  return url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : <>{two ? initials2(name) : initial(name)}</>;
}

function memberTitle(m: OnlineMember) {
  return m.displayName + (m.streaming ? ' · в эфире' : m.inVoice ? ' · в голосе' : m.away ? ' · нет на месте' : ' · в сети');
}

// перекрытые лица; размер задаёт класс контейнера
function Stack({ members, cap, className }: { members: OnlineMember[]; cap: number; className: string }) {
  const ord = clusterOrder(members);
  const shown = ord.slice(0, cap);
  const extra = ord.length - shown.length;
  if (!shown.length) return <span />;
  return (
    <span className={'hm-stack ' + className}>
      {shown.map((m) => (
        <span key={m.username} className="hm-face" title={memberTitle(m)} style={{ background: faceBg(m.avatarUrl, m.displayName, m.avatarColor) }}>
          <Face url={m.avatarUrl} name={m.displayName} />
        </span>
      ))}
      {extra > 0 ? <span className="hm-more">+{extra}</span> : null}
    </span>
  );
}

// эфир: превью-зона (своего кадра у главной нет — тон и лицо ведущего), под ней кто и где
function StreamCard({ item, onOpen }: { item: LiveItem; onOpen: () => void }) {
  const s = item.server;
  const lead = item.streamers[0];
  const more = item.streamers.length - 1;
  const title = lead.displayName + (lead.game ? ' играет в ' + lead.game : ' в эфире');
  const sub = [s.name, more > 0 ? `ещё ${more} в эфире` : '', item.voice.length ? `${item.voice.length} в голосе` : ''].filter(Boolean).join(' · ');
  return (
    <div className="hm-stream" role="button" tabIndex={0} aria-label={`Смотреть: ${title}, ${s.name}`}
      onClick={onOpen} onKeyDown={onKeyOpen(onOpen)} style={tint(lead.displayName, lead.avatarColor)}>
      <div className="hm-thumb">
        <span className="hm-thumb-face" style={{ background: faceBg(lead.avatarUrl, lead.displayName, lead.avatarColor) }}>
          <Face url={lead.avatarUrl} name={lead.displayName} />
        </span>
        <span className="hm-tag">Эфир</span>
        {item.streamers.length > 1 ? <span className="hm-thumb-n"><Icon name="screen" sm />{item.streamers.length}</span> : null}
        {lead.game ? (
          <span className="hm-thumb-game">
            {lead.gicon ? <img src={`data:image/png;base64,${lead.gicon}`} alt="" /> : <Icon name="gamepad" sm />}
            {lead.game}
          </span>
        ) : null}
      </div>
      <div className="hm-stream-foot">
        <span className="hm-av36" style={{ background: faceBg(lead.avatarUrl, lead.displayName, lead.avatarColor) }}>
          <Face url={lead.avatarUrl} name={lead.displayName} />
        </span>
        <span className="hm-stream-meta"><b>{title}</b><span>{sub}</span></span>
        <span className="hm-btn primary sm" aria-hidden="true">Смотреть</span>
      </div>
    </div>
  );
}

// голос без эфира: сервер, кто говорит, войти
function VoiceCard({ item, onOpen }: { item: LiveItem; onOpen: () => void }) {
  const s = item.server;
  const n = item.voice.length;
  const names = item.voice.slice(0, 3).map((m) => m.displayName).join(', ') + (n > 3 ? ` и ещё ${n - 3}` : '');
  return (
    <div className="hm-voicecard" role="button" tabIndex={0} aria-label={`Зайти в голос: ${s.name}`}
      onClick={onOpen} onKeyDown={onKeyOpen(onOpen)}>
      <div className="hm-vc-top">
        <span className="hm-vc-eye"><Icon name="speaker" sm />Голос · {n} {plural(n, ['участник', 'участника', 'участников'])}</span>
        <b>{s.name}</b>
        <span className="hm-vc-names">{names}</span>
      </div>
      <div className="hm-vc-foot">
        <Stack members={item.voice} cap={5} className="s40" />
        <span className="hm-btn panel sm" aria-hidden="true">Зайти</span>
      </div>
    </div>
  );
}

function serverSub(s: ServerSummary, connected: boolean): { text: string; tone?: 'accent' | 'live' } {
  const on = s.online || [];
  const str = on.filter((m) => m.streaming).length;
  const vc = on.filter((m) => m.inVoice && !m.streaming).length;
  if (connected) return { text: 'Ты здесь' + (str ? ' · эфир' : vc ? ' · голос' : ''), tone: 'accent' };
  if (str) return { text: str > 1 ? `эфир · ${str}` : 'эфир', tone: 'live' };
  if (vc) return { text: `голос · ${vc}` };
  return { text: 'тихо' };
}

function ServerCard({ s, unread, connected, onOpen }: { s: ServerSummary; unread: number; connected: boolean; onOpen: () => void }) {
  const on = s.online || [];
  const onlineN = s.onlineCount ?? on.length;
  const sub = serverSub(s, connected);
  return (
    <button className={'hm-srv' + (connected ? ' on' : '')} aria-label={`Открыть сервер ${s.name}`} onClick={onOpen}>
      <span className="hm-srv-top">
        <span className="hm-srv-ic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} two /></span>
        <span className="hm-srv-meta">
          <b>{s.name}</b>
          <span className={sub.tone ? 't-' + sub.tone : undefined}>{sub.text}</span>
        </span>
        {unread > 0 ? <span className="hm-unread" title={`${unread} ${plural(unread, ['непрочитанное', 'непрочитанных', 'непрочитанных'])}`}>{unread > 99 ? '99+' : unread}</span> : null}
      </span>
      <span className="hm-srv-foot">
        <Stack members={on} cap={6} className="s24" />
        <span className="hm-srv-on">{onlineN ? `${onlineN} в сети` : 'никого в сети'}</span>
      </span>
    </button>
  );
}

function GameRow({ g }: { g: GameGroup }) {
  const names = g.players.slice(0, 3).map((p) => p.displayName).join(', ') + (g.players.length > 3 ? ` и ещё ${g.players.length - 3}` : '');
  return (
    <div className="hm-game" title={g.players.map((p) => p.displayName).join(', ')} style={tint(g.name)}>
      <span className="hm-game-ic">{g.icon ? <img src={`data:image/png;base64,${g.icon}`} alt="" /> : <Icon name="gamepad" />}</span>
      <span className="hm-game-meta"><b>{g.name}</b><span>{names}</span></span>
      <span className="hm-game-n">{g.players.length}</span>
    </div>
  );
}

// баннер обновления (веб-рефреш ИЛИ натив-апдейт)
function UpdateBanner() {
  const updateReady = useStore((s) => s.updateReady);
  const nativeUpdate = useStore((s) => s.nativeUpdate);
  const toast = useStore((s) => s.toast);
  const [updating, setUpdating] = useState(false);
  if (updateReady) return (
    <div className="hm-banner">
      <span className="hm-banner-ic"><Icon name="refresh" /></span>
      <span className="hm-banner-txt"><b>Вышло обновление</b><span>Обнови страницу — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd></span></span>
      <button className="hm-btn primary" onClick={() => location.reload()}><Icon name="refresh" sm />Обновить</button>
    </div>
  );
  if (nativeUpdate) return (
    <div className="hm-banner">
      <span className="hm-banner-ic"><Icon name="refresh" /></span>
      <span className="hm-banner-txt"><b>Доступна версия {nativeUpdate.version}</b><span>{updating ? 'Устанавливаю — приложение перезапустится…' : 'Обновить до свежей версии'}</span></span>
      <button className="hm-btn primary" disabled={updating} onClick={async () => { setUpdating(true); try { await applyNativeUpdate(); } catch (e: any) { setUpdating(false); toast('Не удалось обновить: ' + (e?.message || e), 'err'); } }}>
        {updating ? <span className="spin" /> : <Icon name="refresh" sm />}Установить
      </button>
    </div>
  );
  return null;
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
  const liveServers = servers.filter((s) => (s.online || []).some((m) => m.streaming || m.inVoice)).length; // без кэпа 8
  const voiceServer = eng.inVoice && eng.voiceServerId ? servers.find((s) => s.id === eng.voiceServerId) : null;
  const connectedServer = connectedId ? servers.find((s) => s.id === connectedId) : null;
  const recent = connectedServer ? [connectedServer] : ranked.slice(0, 3);

  const head = (title: string) => (
    <header className="hm-head">
      <h1>{title}</h1>
      <div className="hm-head-actions">
        {voiceServer ? (
          <button className="hm-btn voice" onClick={() => openServer(voiceServer.id)} aria-label={`Вернуться в голос: ${voiceServer.name}`}>
            <i className="hm-dot" /><span>Ты в голосе · {voiceServer.name}</span>
          </button>
        ) : null}
        <button className="hm-btn" onClick={() => setModal('join')} aria-label="Войти по приглашению"><Icon name="link" sm /><span>По приглашению</span></button>
        <button className="hm-btn primary" onClick={() => setModal('create')} aria-label="Создать сервер"><Icon name="plus" sm /><span>Создать сервер</span></button>
        <button className="hm-me" aria-label="Профиль" onClick={() => setModal('profile')} style={{ background: faceBg(me.avatarUrl, me.displayName, me.avatarColor) }}>
          <Face url={me.avatarUrl} name={me.displayName} />
        </button>
      </div>
    </header>
  );

  // ---------- Первый запуск ----------
  if (!servers.length) {
    return (
      <section className="hm first">
        <UpdateBanner />
        <div className="hm-first">
          <h1>Серверов пока нет</h1>
          <p>Создай сервер или войди по приглашению.</p>
          <div className="hm-first-cta">
            <button className="hm-btn primary lg" onClick={() => setModal('create')}><Icon name="plus" sm /><span>Создать сервер</span></button>
            <button className="hm-btn lg" onClick={() => setModal('join')}><Icon name="link" sm /><span>Войти по приглашению</span></button>
          </div>
        </div>
      </section>
    );
  }

  const emptyCopy = filter === 'unread'
    ? { t: 'Всё прочитано', d: 'Новых сообщений нет.' }
    : filter === 'mine' ? { t: 'Своих серверов нет', d: 'Создай сервер — он появится здесь.' } : { t: 'Серверов нет', d: 'Создай сервер или войди по приглашению.' };

  return (
    <section className="hm">
      {head('Главная')}
      <UpdateBanner />

      {live.length ? (
        <section className="hm-sec">
          <div className="hm-sec-h"><h2>Сейчас в эфире</h2><span>{liveServers} {plural(liveServers, ['активный сервер', 'активных сервера', 'активных серверов'])}</span></div>
          <div className="hm-live">
            {live.map((it) => it.streamers.length
              ? <StreamCard key={it.key} item={it} onOpen={() => openServer(it.server.id, it.streamers[0]?.username)} />
              : <VoiceCard key={it.key} item={it} onOpen={() => openServer(it.server.id)} />)}
          </div>
        </section>
      ) : (
        <div className="hm-quiet">
          <span className="hm-quiet-ic"><Icon name="screen" /></span>
          <span className="hm-quiet-txt"><b>Сейчас никто не в эфире</b>{recent.length ? <span>{connectedServer ? 'Вернуться:' : 'Недавние:'}</span> : null}</span>
          {recent.length ? (
            <span className="hm-quiet-chips">
              {recent.map((s) => (
                <button key={s.id} className="hm-chip" onClick={() => openServer(s.id)}>
                  <span className="hm-chip-ic" style={{ background: faceBg(s.iconUrl, s.name, s.iconColor) }}><Face url={s.iconUrl} name={s.name} two /></span>
                  {s.name}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      )}

      <div className={'hm-split' + (games.length ? ' has-games' : '')}>
        <section className="hm-sec hm-servers">
          <div className="hm-sec-h">
            <h2>Твои серверы</h2>
            <div className="hm-seg" role="radiogroup" aria-label="Фильтр серверов">
              {(['all', 'unread', 'mine'] as const).map((f) => (
                <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : undefined} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'Все' : f === 'unread' ? 'Непрочитанное' : 'Мои'}
                </button>
              ))}
            </div>
          </div>
          {shown.length ? (
            <div className="hm-grid">
              {shown.map((s) => <ServerCard key={s.id} s={s} unread={unread[s.id] || 0} connected={connectedId === s.id} onOpen={() => openServer(s.id)} />)}
            </div>
          ) : (
            <div className="hm-empty" role="status">
              <span className="hm-empty-ic"><Icon name={filter === 'unread' ? 'check' : 'search'} /></span>
              <b>{emptyCopy.t}</b>
              <span>{emptyCopy.d}</span>
              <button type="button" className="hm-btn" onClick={() => setFilter('all')}>Показать все серверы</button>
            </div>
          )}
        </section>

        {games.length ? (
          <section className="hm-sec hm-games-col">
            <div className="hm-sec-h"><h2>Играют сейчас</h2></div>
            <div className="hm-games">{games.map((g) => <GameRow key={g.name} g={g} />)}</div>
          </section>
        ) : null}
      </div>

      <DownloadCard />
    </section>
  );
}

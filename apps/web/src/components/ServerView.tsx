import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useStore, getEngine } from '../store';
import { api, resolveUploadUrl } from '../api';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial, prefersReducedMotion, downscaleImage } from '../util';
import { emoteMap } from '../emotes';
import { EmoteImg } from './EmoteImg';
import { EmotePicker } from './EmotePicker';
import { ExternalLink } from './ExternalLink';
import { VoiceDock, VoiceControls } from './VoiceDock';
import { StreamerWidget } from './StreamerWidget';
import { normalizeProfileBanner, ProfileBannerMedia } from './ProfileBanner';
import { getSettings, setSettings } from '../settings';
import { fmtDuration, levelProgress } from '../leveling';
import { playSound } from '../sounds';
import { applyNativeUpdate } from '../nativeUpdate';
import { isTauri, saveFileDialog, openFile, pathsExist } from '../native';
import { getDownloads, addDownload, subscribeDownloads, type DownloadItem } from '../downloads';
import { sendActiveChat } from '../notifyws';
import { linkifyHttpUrls } from '../linkify';
import { fetchTitle, parseYouTubeVideo, type YouTubeVideoRef } from '../youtube';
import {
  CHAT_BOTTOM_ENTER_PX,
  CHAT_BOTTOM_LEAVE_PX,
  CHAT_PHYSICAL_BOTTOM_EPSILON_PX,
  CHAT_TAIL_RESERVE_PX,
  INITIAL_CHAT_TAIL_SETTLE,
  canStartChatPrepend,
  canCorrectChatPrependAnchor,
  chatBottomDistance,
  classifyChatPrepend,
  classifyChatPrependLifecycle,
  chatPrependAnchorDelta,
  chatTailIndexLocation,
  chatVirtualFirstItemIndex,
  reduceChatScrollState,
  reduceChatTailSettle,
  type ChatScrollDirection,
  type ChatTailSettleState,
} from '../chatScroll';
import type { Attachment, ChatMessage, Emote, Leaderboard, Member, MemberStats, ReleaseNote, ReplyRef, Role } from '../types';
import { PERM, hasPerm } from '../types';

const MAX_ATTACH = 5;
const MAX_ATTACH_SIZE = 10 * 1024 * 1024;

// человекочитаемый размер файла для чипа вложения
function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

// один вложенный в стейджинг файл: пока грузится — preview/локальный File, после — готовый Attachment
interface StagedAttachment {
  key: number;
  kind: 'image' | 'file';
  name: string;
  size: number;
  previewUrl?: string; // objectURL для картинок — превью до и во время аплоада
  status: 'uploading' | 'ready' | 'error';
  attachment?: Attachment;
}
let stageSeq = 1;

const profileStatsCache = new Map<string, { until: number; data: Leaderboard }>();
const profileStatsPending = new Map<string, Promise<Leaderboard>>();
function loadProfileStats(serverId: string): Promise<Leaderboard> {
  const cached = profileStatsCache.get(serverId);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.data);
  const pending = profileStatsPending.get(serverId);
  if (pending) return pending;
  const request = api.getLeaderboard(serverId).then((data) => {
    profileStatsCache.set(serverId, { until: Date.now() + 30_000, data });
    return data;
  }).finally(() => profileStatsPending.delete(serverId));
  profileStatsPending.set(serverId, request);
  return request;
}

function memberStatsFromLeaderboard(data: Leaderboard, member: Member): MemberStats | null {
  if (data.enabled === false) return null;
  const levelRow = data.categories?.level?.find((row) => row.uid === member.id);
  const voiceRow = data.categories?.voice?.find((row) => row.uid === member.id);
  const streamRow = data.categories?.stream?.find((row) => row.uid === member.id);
  if (!levelRow && !voiceRow && !streamRow) return null;
  const xp = levelRow?.value || 0;
  const progress = levelProgress(xp);
  return {
    voiceSec: voiceRow?.value || 0,
    streamSec: streamRow?.value || 0,
    messages: 0,
    xp,
    level: levelRow?.level ?? progress.level,
    progress,
  };
}

function Avatar({ name, ci, url, size = 32, dot, live }: { name: string; ci: number; url?: string; size?: number; dot?: string; live?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [url]);
  const showImage = !!url && !imageFailed;
  return (
    <div className={'av' + (live ? ' live' : '')} aria-label={name}
      style={{ width: size, height: size, fontSize: size * 0.44, background: showImage ? '#0000' : avColor(name, ci) }}>
      {showImage ? <img className="avimg" src={resolveUploadUrl(url!)} alt="" onError={() => setImageFailed(true)} /> : initial(name)}
      {dot && !live ? <span className={'sdot ' + dot} /> : null}
      {live ? <span className="av-live" aria-hidden="true">LIVE</span> : null}
    </div>
  );
}

/* ---------- Profile hover card ---------- */
function useHoverCard() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useRef<number | undefined>(undefined);
  const closeT = useRef<number | undefined>(undefined);
  const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(hover:none)').matches;
  const cancelClose = () => { if (closeT.current) window.clearTimeout(closeT.current); closeT.current = undefined; };
  const scheduleClose = () => { cancelClose(); closeT.current = window.setTimeout(() => setRect(null), 180); };
  const openNow = () => {
    cancelClose();
    window.clearTimeout(t.current);
    if (ref.current) setRect(ref.current.getBoundingClientRect());
  };
  const closeNow = () => {
    window.clearTimeout(t.current);
    cancelClose();
    setRect(null);
  };
  const onEnter = () => { if (isTouch) return; cancelClose(); window.clearTimeout(t.current); t.current = window.setTimeout(() => { if (ref.current) setRect(ref.current.getBoundingClientRect()); }, 320); };
  const onLeave = () => { if (isTouch) return; window.clearTimeout(t.current); scheduleClose(); };
  const onCardEnter = () => { if (!isTouch) cancelClose(); };
  const onCardLeave = () => { if (!isTouch) scheduleClose(); };
  const onFocus = () => { if (!isTouch) openNow(); };
  const onBlur = () => { if (!isTouch) scheduleClose(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { setRect(null); return; }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setRect((current) => current ? null : (ref.current ? ref.current.getBoundingClientRect() : null));
  };
  // Явный клик работает на любом устройстве; hover остаётся быстрым desktop-preview.
  const onToggle = () => {
    if (!isTouch) { openNow(); return; }
    setRect((r) => (r ? null : (ref.current ? ref.current.getBoundingClientRect() : null)));
  };
  useEffect(() => () => { window.clearTimeout(t.current); window.clearTimeout(closeT.current); }, []);
  // тач-дисмисс открытой карточки: тап вне / скролл / ресайз
  useEffect(() => {
    if (!isTouch || !rect) return;
    const close = () => setRect(null);
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.pcard')) return;
      close();
    };
    const closeOnScroll = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.pcard'))) close(); };
    const id = window.setTimeout(() => { document.addEventListener('pointerdown', closeOutside); window.addEventListener('scroll', closeOnScroll, true); window.addEventListener('resize', close); }, 0);
    return () => { window.clearTimeout(id); document.removeEventListener('pointerdown', closeOutside); window.removeEventListener('scroll', closeOnScroll, true); window.removeEventListener('resize', close); };
  }, [isTouch, rect]);
  return { ref, rect, close: closeNow, onEnter, onLeave, onToggle, onFocus, onBlur, onKeyDown, onCardEnter, onCardLeave };
}

function ProfileCard({ m, rect, onEnter, onLeave }: { m: Member; rect: DOMRect; onEnter?: () => void; onLeave?: () => void }) {
  const me = useStore((s) => s.me);
  const active = useStore((s) => s.active);
  const eng = useEngine();
  const E = getEngine();
  const [fallbackStats, setFallbackStats] = useState<MemberStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [statsEmpty, setStatsEmpty] = useState(false);
  const pr = eng.presence[m.username];
  const streaming = !!pr?.streaming;
  const streamMeta = streaming ? E?.getStreamAppMeta(m.username) : null;
  const streamName = pr?.game?.name || streamMeta?.appName || 'Трансляция';
  const streamIcon = pr?.game?.icon || streamMeta?.appIcon;
  const showSeparateCapture = !!(streaming && streamMeta?.appName && pr?.game?.name
    && streamMeta.appName.toLocaleLowerCase() !== pr.game.name.toLocaleLowerCase());
  const presence = streaming ? 'В эфире' : pr?.inVoice ? 'В голосовом канале' : pr?.away ? 'Отошёл' : pr?.online ? 'В сети' : 'Не в сети';
  const presenceClass = streaming ? 'live' : pr?.online ? 'online' : 'offline';
  const bio = ((me && m.username === me.username ? (me.bio || m.bio) : m.bio) || '').trim();
  const profileBannerUrl = normalizeProfileBanner(me && m.username === me.username ? me.profileBannerUrl : m.profileBannerUrl);
  useEffect(() => {
    if (!active?.statsEnabled || m.stats) { setFallbackStats(null); setStatsFailed(false); setStatsEmpty(false); return; }
    let alive = true;
    setStatsFailed(false); setStatsEmpty(false);
    loadProfileStats(active.id)
      .then((data) => { if (alive) { const value = memberStatsFromLeaderboard(data, m); setFallbackStats(value); setStatsEmpty(!value); } })
      .catch(() => { if (alive) setStatsFailed(true); });
    return () => { alive = false; };
  }, [active?.id, active?.statsEnabled, m]);
  const onRight = rect.left < window.innerWidth / 2;
  const statsData = m.stats || fallbackStats;
  const statsEnabled = !!active?.statsEnabled;
  const hasStats = !!(statsEnabled && statsData);
  const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - (statsEnabled ? 480 : 370)));
  const progress = statsData?.progress;
  const progressPct = progress?.span ? Math.max(0, Math.min(100, progress.into / progress.span * 100)) : 0;
  const preferredLeft = onRight ? rect.right + 10 : rect.left - 306;
  const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - 304));
  const style: CSSProperties = { left, top };
  return (
    <div className={'pcard' + (streaming ? ' is-live' : '')} style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className={'pcard-cover' + (profileBannerUrl ? ' has-media' : '')} aria-hidden="true">
        <ProfileBannerMedia value={profileBannerUrl} className="pcard-cover-banner" />
      </div>
      <div className="pcard-head">
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} size={78} live={streaming} dot={pr?.online ? 'online' : 'offline'} />
        <span className={'pcard-presence ' + presenceClass}><i />{presence}</span>
      </div>
      <div className="pcard-identity">
        <div className="pcard-name">{m.displayName}{m.role === 'owner' ? <span className="rl" title="Владелец">👑</span> : null}</div>
        <div className="pcard-user">@{m.username}</div>
      </div>
      {streaming ? <div className="pcard-activity live">
        <span className="pcard-activity-icon">{streamIcon ? <img src={`data:image/png;base64,${streamIcon}`} alt="" /> : <Icon name="screen" sm />}</span>
        <span><b>В эфире</b><i>{streamName}</i></span>
      </div> : pr?.game ? <div className="pcard-activity game">
        <span className="pcard-activity-icon">{pr.game.icon ? <img src={`data:image/png;base64,${pr.game.icon}`} alt="" /> : '🎮'}</span>
        <span><b>Играет</b><i>{pr.game.name}</i></span>
      </div> : null}
      {showSeparateCapture && streamMeta?.appName ? <div className="pcard-secondary-activity">Трансляция · {streamMeta.appName}</div> : null}
      {m.roles && m.roles.length ? (<>
        <div className="pcard-label">Роли</div>
        <div className="pcard-roles">{m.roles.map((r) => <RoleBadge r={r} key={r.id} />)}</div>
      </>) : null}
      {hasStats && statsData ? <>
        <div className="pcard-label pcard-level-label"><span>Активность</span><b>Уровень {statsData.level}</b></div>
        <div className="pcard-xp">
          <div className="pcard-xp-meta"><span>{progress?.into.toLocaleString('ru-RU')} XP</span><span>{progress?.span.toLocaleString('ru-RU')} XP</span></div>
          <div className="pcard-xp-track"><i style={{ width: `${progressPct}%` }} /></div>
        </div>
        <div className="pcard-stats">
          <div><Icon name="speaker" sm /><span>В голосе</span><b>{fmtDuration(statsData.voiceSec)}</b></div>
          <div><Icon name="screen" sm /><span>В эфире</span><b>{fmtDuration(statsData.streamSec)}</b></div>
          {m.stats ? <div><Icon name="chat" sm /><span>Сообщения</span><b>{statsData.messages.toLocaleString('ru-RU')}</b></div> : null}
          <div><Icon name="trophy" sm /><span>Всего XP</span><b>{statsData.xp.toLocaleString('ru-RU')}</b></div>
        </div>
      </> : statsEnabled ? <div className={'pcard-stats-state' + (statsFailed ? ' failed' : '')}>{statsEmpty ? 'Активность ещё не накоплена' : statsFailed ? 'Статистика временно недоступна' : <><span className="spin" /> Загружаю активность…</>}</div> : null}
      <div className="pcard-label">О себе</div>
      <div className={'pcard-bio' + (bio ? '' : ' empty')}>{bio || 'Ничего не указано'}</div>
    </div>
  );
}

// цвет ника по высшей роли (роли отсортированы по position DESC на сервере)
function roleColorOf(m: Member): string | undefined {
  const r = (m.roles || []).find((x) => x.color);
  return r?.color || undefined;
}

/* ---------- Voice channel participant row (LEFT, with controls) ---------- */
// анимация появления/ухода строк списка: enter (новые) / exit (ghost'ы, схлопываются со сдвигом).
// ключ по username; ghost вставляется на свою бывшую позицию. Возвращает элементы + класс анимации.
function useRowTransition<T extends { username: string }>(items: T[], dur = 660): { item: T; anim: string }[] {
  const [enter, setEnter] = useState<Set<string>>(() => new Set());
  const [exit, setExit] = useState<Map<string, { item: T; idx: number }>>(() => new Map());
  const prev = useRef<Map<string, T> | null>(null);
  const timers = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const cur = new Map(items.map((i) => [i.username, i] as [string, T]));
    if (prev.current === null) { prev.current = cur; return; }
    const was = prev.current, wasKeys = [...was.keys()];
    const added: string[] = [], removed: string[] = [];
    cur.forEach((_v, u) => { if (!was.has(u)) added.push(u); });
    was.forEach((_v, u) => { if (!cur.has(u)) removed.push(u); });
    prev.current = cur;
    if ((!added.length && !removed.length) || added.length + removed.length > 8) return;
    if (added.length) setEnter((p) => { const n = new Set(p); added.forEach((u) => n.add(u)); return n; });
    if (removed.length) setExit((p) => { const n = new Map(p); removed.forEach((u) => n.set(u, { item: was.get(u)!, idx: wasKeys.indexOf(u) })); return n; });
    [...added, ...removed].forEach((u) => {
      const old = timers.current.get(u); if (old) clearTimeout(old);
      timers.current.set(u, window.setTimeout(() => {
        setEnter((p) => { const n = new Set(p); n.delete(u); return n; });
        setExit((p) => { const n = new Map(p); n.delete(u); return n; });
        timers.current.delete(u);
      }, dur));
    });
  }, [items]);
  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); }, []);
  const curSet = new Set(items.map((i) => i.username));
  const out: { item: T; anim: string }[] = items.map((i) => ({ item: i, anim: enter.has(i.username) ? 'vrow-enter' : '' }));
  [...exit.entries()].filter(([u]) => !curSet.has(u)).sort((a, b) => a[1].idx - b[1].idx)
    .forEach(([, g]) => out.splice(Math.min(g.idx, out.length), 0, { item: g.item, anim: 'vrow-exit' }));
  return out;
}

function VoiceParticipantRow({ m, anim }: { m: Member; anim?: string }) {
  const eng = useEngine();
  const E = getEngine()!;
  const me = useStore((s) => s.me)!;
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const pr = eng.presence[m.username];
  const speaking = eng.speaking[m.username];
  const streaming = pr?.streaming;
  const isLocal = m.username === me.username;
  const remote = !isLocal;
  const profileBannerUrl = normalizeProfileBanner(isLocal ? me.profileBannerUrl : m.profileBannerUrl);
  const watching = !!eng.watching[m.username];
  const pending = !!eng.pending[m.username];
  const [vol, setVol] = useState(() => Math.round(E.userVolOf(m.username) * 100));
  const talking = speaking && !pr?.micMuted;
  const connecting = isLocal && eng.voiceConnecting;
  const rowId = `vc-${m.username}`;
  const hc = useHoverCard();
  const streamMeta = streaming ? E.getStreamAppMeta(m.username) : null;
  const activityName = streaming ? (pr?.game?.name || streamMeta?.appName || 'Трансляция') : pr?.game?.name;
  const activityIcon = streaming ? (pr?.game?.icon || streamMeta?.appIcon) : pr?.game?.icon;
  const armAutoClose = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      const controls = rowRef.current?.querySelector('.exp-surface');
      const restoreFocus = document.activeElement instanceof Node && !!controls?.contains(document.activeElement);
      setOpen(false);
      if (restoreFocus) window.requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('.head')?.focus());
    }, 5_000);
  };
  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('.head')?.focus());
  };
  const toggleOpen = () => {
    if (!open) {
      const row = rowRef.current?.getBoundingClientRect();
      const scroller = rowRef.current?.closest('.ch-body')?.getBoundingClientRect();
      const lowerEdge = Math.min(window.innerHeight - 8, (scroller?.bottom || window.innerHeight) - 8);
      setOpenUp(!!row && row.bottom + 108 > lowerEdge && row.top - 108 > (scroller?.top || 0));
      window.dispatchEvent(new CustomEvent('voice-participant-open', { detail: m.username }));
    }
    setOpen((value) => !value);
  };
  useEffect(() => {
    const closeOther = (event: Event) => { if ((event as CustomEvent<string>).detail !== m.username) setOpen(false); };
    window.addEventListener('voice-participant-open', closeOther);
    return () => window.removeEventListener('voice-participant-open', closeOther);
  }, [m.username]);
  useEffect(() => {
    if (!open) return;
    armAutoClose();
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Node && !rowRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    };
  }, [open]);
  return (
    <div ref={rowRef} className={'pi' + (remote ? ' clickable' : '') + (streaming ? ' streaming' : '') + (talking ? ' speaking' : '') + (open ? ' open' : '') + (openUp ? ' popover-up' : '') + (connecting ? ' connecting' : '') + (anim ? ' ' + anim : '')} data-spk={m.username}>
      <div className={'head' + (profileBannerUrl ? ' has-profile-banner' : '')}
        ref={hc.ref} onMouseEnter={hc.onEnter} onMouseLeave={hc.onLeave}
        onFocus={remote ? undefined : hc.onFocus} onBlur={remote ? undefined : hc.onBlur}
        role="button" tabIndex={0}
        aria-label={remote ? `Настройки громкости и профиль ${m.displayName}` : `Профиль ${m.displayName}`}
        aria-expanded={remote ? open : undefined} aria-controls={remote ? rowId : undefined}
        onClick={() => { if (remote) { hc.close(); toggleOpen(); } else hc.onToggle(); }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (remote && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); hc.close(); toggleOpen(); }
          else { if (remote && e.key === 'Escape') setOpen(false); hc.onKeyDown(e); }
        }}>
        <ProfileBannerMedia value={profileBannerUrl} className="member-row-banner" compact />
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} size={30} live={!!streaming} />
        <div className="vc-id">
          <div className="nm" title={m.displayName}>{m.displayName}{isLocal && !connecting ? ' (ты)' : ''}</div>
          {connecting ? <span className="vc-connecting">подключение…</span> : null}
          {!connecting && activityName ? <span className={'vc-activity ' + (streaming ? 'is-live' : 'is-game')} title={(streaming ? 'В эфире: ' : 'Играет: ') + activityName}>
            <span className="vc-activity-icon">{activityIcon ? <img src={`data:image/png;base64,${activityIcon}`} alt="" /> : streaming ? <Icon name="screen" sm /> : '🎮'}</span>
            <b>{streaming ? 'LIVE' : 'Игра'}</b><span>· {activityName}</span>
          </span> : null}
        </div>
        {/* Правый статус-блок: фикс-колонки [watch][game][mic][chev]. game стоит вплотную к
            зарезервированным mic(visibility:hidden)+chev → игро-иконки всех рядов в одной вертикали
            (не пляшут по длине ника); watch-кнопка — отдельная ячейка слева, стример видит И игру, И «зайти». */}
        {remote && streaming ? (
          <button className={'watchbtn' + (watching ? ' on' : '')} disabled={pending}
            aria-label={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
            data-tip={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
            onClick={(e) => { e.stopPropagation(); watching ? E.closeWatch(m.username) : E.watch(m.username); }}>
            {pending ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name={watching ? 'eye-off' : 'eye'} />}
          </button>
        ) : null}
        {connecting
          ? <span className="spin" style={{ margin: 0, width: 14, height: 14 }} aria-label="Подключение" />
          : <div className={'micst' + (pr?.micMuted ? ' off' : '')} aria-label={pr?.micMuted ? (pr?.deafened ? 'Оглох' : 'Микрофон выключен') : undefined}><Icon name={pr?.deafened ? 'head-off' : 'mic-off'} /></div>}
        {remote ? <div className="chev" aria-hidden="true"><Icon name="chevron" sm /></div> : <div className="chev chev-pad" aria-hidden="true" />}
      </div>
      {remote ? (
        <div className="exp-wrap" id={rowId} aria-hidden={!open}>
          <div className="exp">
            <div className="exp-surface" onPointerDown={armAutoClose} onFocusCapture={armAutoClose} onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeAndRestoreFocus();
              } else {
                armAutoClose();
              }
            }}>
              <div className="exp-title"><span><Icon name="speaker" sm />Личная громкость</span><strong>{vol}%</strong></div>
              <div className="exp-controls">
                <input type="range" min={0} max={200} value={vol} tabIndex={open ? 0 : -1} aria-label={`Громкость: ${m.displayName}`}
                  style={{ ['--volume' as string]: `${vol / 2}%` } as CSSProperties}
                  onChange={(e) => { armAutoClose(); let v = +e.target.value; if (Math.abs(v - 100) < 4) v = 100; setVol(v); E.setUserVol(m.username, v / 100); }}
                  onDoubleClick={() => { setVol(100); E.setUserVol(m.username, 1); }} />
                <button className={'mut' + (E.isMutedFor(m.username) ? ' on' : '')} tabIndex={open ? 0 : -1}
                  aria-pressed={E.isMutedFor(m.username)}
                  aria-label={E.isMutedFor(m.username) ? `Снова слышать ${m.displayName}` : `Заглушить у себя ${m.displayName}`}
                  data-tip={E.isMutedFor(m.username) ? 'Снова слышать этого человека' : 'Не слышать этого человека'}
                  onClick={(e) => { e.stopPropagation(); E.toggleUserMute(m.username); }}><Icon name="volume-off" sm /></button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {hc.rect ? <ProfileCard m={m} rect={hc.rect} onEnter={hc.onCardEnter} onLeave={hc.onCardLeave} /> : null}
    </div>
  );
}

/* ---------- Voice channels (несколько голосовых каналов на сервер) ---------- */
function VoiceChannels() {
  const eng = useEngine();
  const E = getEngine()!;
  const active = useStore((s) => s.active)!;
  const members = useStore((s) => s.members);
  const channels = active.channels || [];
  const canManage = hasPerm(active.myPerms || 0, PERM.MANAGE_CHANNELS);
  const myVc = eng.myVoiceChannel;
  // список каналов относится к СМОТРИМОМУ серверу; мой голосовой может быть на ДРУГОМ (после расцепа
  // голос/просмотр). auto-leave/подсветка .mine валидны лишь когда смотрю свой голосовой сервер —
  // иначе myVc не найдётся в channels чужого сервера и leaveVoice ложно уронил бы живой голос.
  const onVoiceServer = eng.voiceServerId === active.id;

  // мой голосовой канал удалили (админом) — аккуратно выходим из голосового
  useEffect(() => {
    if (onVoiceServer && myVc && channels.length && !channels.some((c) => c.id === myVc)) E.leaveVoice();
  }, [onVoiceServer, myVc, channels, E]);

  return (
    <div className="vchans">
      <div className="vchans-h">
        <span>Голосовые каналы</span>
        <span className="vchans-count">{channels.length}/5</span>
      </div>
      {channels.map((c) => (
        <VoiceChannelItem key={c.id} channel={c} canManage={canManage} canDelete={canManage && channels.length > 1} mine={onVoiceServer && myVc === c.id}
          membersInChannel={members.filter((m) => eng.voiceChannels[m.username] === c.id)} activeSince={eng.channelActiveSince[c.id]} />
      ))}
      {canManage && channels.length > 0 && channels.length < 5 ? <CreateChannelRow /> : null}
    </div>
  );
}

// Таймер занятости канала (как в Discord): идёт с момента первого захода в ПУСТОЙ канал, не сбрасывается
// при перестановках участников, гаснет только когда канал полностью опустеет (activeSince пропадает).
// Пишем в DOM напрямую через ref (не setState) — тикает раз в секунду, лишний ре-рендер тут не нужен.
function VoiceChannelTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const fmt = () => {
      const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      const txt = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
      if (ref.current) ref.current.textContent = txt;
    };
    fmt();
    const id = window.setInterval(fmt, 1000);
    return () => window.clearInterval(id);
  }, [since]);
  return <span className="vchan-timer" ref={ref} />;
}

function VoiceChannelItem({ channel, membersInChannel, canManage, canDelete, mine, activeSince }: { channel: { id: string; name: string }; membersInChannel: Member[]; canManage: boolean; canDelete: boolean; mine: boolean; activeSince?: number }) {
  const E = getEngine()!;
  const renameChannel = useStore((s) => s.renameChannel);
  const deleteChannel = useStore((s) => s.deleteChannel);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(channel.name);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { setName(channel.name); }, [channel.name]);

  const rows = useRowTransition(membersInChannel);
  const join = () => { if (!mine) E.joinVoice(channel.id); };
  const submitRename = () => { const n = name.trim(); if (n && n !== channel.name) renameChannel(channel.id, n); setEditing(false); };

  return (
    <div className={'vchan' + (mine ? ' mine' : '')}>
      <div className="vchan-h" role="button" tabIndex={editing ? -1 : 0} data-tip={mine ? undefined : 'Зайти в канал'}
        onClick={editing ? undefined : join}
        onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); join(); } }}>
        <Icon name="speaker" sm />
        {editing ? (
          <input className="vchan-edit" autoFocus value={name} maxLength={24}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') { setName(channel.name); setEditing(false); } }}
            onBlur={submitRename} />
        ) : (
          <span className="vchan-nm" title={channel.name}>{channel.name}</span>
        )}
        {!editing && activeSince ? <VoiceChannelTimer since={activeSince} /> : null}
        {!editing && membersInChannel.length ? <span className="vchan-n">{membersInChannel.length}</span> : null}
        {canManage && !editing ? (
          <span className="vchan-actions" onClick={(e) => e.stopPropagation()}>
            <button className="vchan-act" aria-label={`Переименовать канал ${channel.name}`} data-tip="Переименовать" onClick={() => setEditing(true)}><Icon name="edit" sm /></button>
            {canDelete ? <button className="vchan-act del" aria-label={`Удалить канал ${channel.name}`} data-tip="Удалить канал" onClick={() => setConfirmDel(true)}><Icon name="trash" sm /></button> : null}
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <div className="vchan-list">{rows.map(({ item, anim }) => <VoiceParticipantRow m={item} anim={anim} key={item.username} />)}</div>
      ) : null}
      {confirmDel ? (
        <div className="vchan-confirm">
          <span>Удалить «{channel.name}»?</span>
          <div className="vchan-confirm-btns">
            <button className="vc-del-no" onClick={() => setConfirmDel(false)}>Отмена</button>
            <button className="vc-del-yes" onClick={() => { setConfirmDel(false); deleteChannel(channel.id); }}>Удалить</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CreateChannelRow() {
  const createChannel = useStore((s) => s.createChannel);
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim(); if (!n || busy) return;
    setBusy(true);
    try { await createChannel(n); setName(''); setOpen(false); }
    catch (e: any) { toast(e?.message || 'Не удалось создать канал', 'err'); }
    finally { setBusy(false); }
  };
  if (!open) return <button className="vchan-add" onClick={() => setOpen(true)}><Icon name="plus" sm />Создать канал</button>;
  return (
    <div className="vchan-create">
      <Icon name="speaker" sm />
      <input autoFocus placeholder="Название канала" maxLength={24} value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setName(''); setOpen(false); } }} />
      <button className="vchan-create-ok" aria-label="Создать голосовой канал" disabled={!name.trim() || busy} data-tip="Создать" onClick={submit}>{busy ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name="check" sm />}</button>
      <button className="vchan-create-x" aria-label="Отменить создание канала" data-tip="Отмена" onClick={() => { setName(''); setOpen(false); }}><Icon name="close" sm /></button>
    </div>
  );
}

// VoiceControls / ShareButton / NativeBroadcastButton вынесены в components/VoiceDock.tsx —
// персистентный голос-док на уровне App (виден на всех экранах, пока ты в голосовом).

// роли сразу за ником; что не влезло — сворачиваем в «+N» с тултипом всех ролей
function roleBadge(r: Role) {
  return <span key={r.id} className="role-badge" style={{ ['--role-color' as string]: r.color || 'var(--muted)' } as CSSProperties}><i className="role-dot" /><span className="rb-t">{r.name}</span></span>;
}
function RoleBadge({ r }: { r: Role }) {
  return (
    <span className="role-badge" style={{ ['--role-color' as string]: r.color || 'var(--muted)' } as CSSProperties} data-tip={r.name}>
      <i className="role-dot" /><span className="rb-t">{r.name}</span>
    </span>
  );
}
function MemberRoles({ roles }: { roles: Role[] }) {
  const visRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [visN, setVisN] = useState(roles.length);
  useLayoutEffect(() => {
    const vis = visRef.current, ghost = ghostRef.current; if (!vis || !ghost) return;
    const compute = () => {
      const cw = vis.clientWidth; if (cw <= 0) return;
      const badges = Array.from(ghost.children) as HTMLElement[];
      const gap = 5, moreW = 34;
      let used = 0, n = 0;
      for (let i = 0; i < badges.length; i++) {
        const add = badges[i].offsetWidth + (i > 0 ? gap : 0);
        const budget = cw - (i < badges.length - 1 ? moreW + gap : 0);
        if (used + add <= budget) { used += add; n++; } else break;
      }
      setVisN((p) => (p === n ? p : n));
    };
    compute();
    const ro = new ResizeObserver(compute); ro.observe(vis);
    return () => ro.disconnect();
  }, [roles]);
  const hidden = roles.length - visN;
  return (
    <div className="mrow-roles" ref={visRef}>
      {roles.slice(0, visN).map((r) => <RoleBadge r={r} key={r.id} />)}
      {hidden > 0 ? <span className="role-more" data-tip={roles.map((r) => r.name).join(', ')}>+{hidden}</span> : null}
      <div className="mrow-roles-ghost" ref={ghostRef} aria-hidden="true">{roles.map(roleBadge)}</div>
    </div>
  );
}

/* ---------- Member list (right) — только инфо/статусы, без контролов ---------- */
function MemberRow({ m, anim }: { m: Member; anim?: string }) {
  const eng = useEngine();
  const E = getEngine()!;
  const me = useStore((s) => s.me)!;
  const active = useStore((s) => s.active);
  const toast = useStore((s) => s.toast);
  const refreshMembers = useStore((s) => s.refreshMembers);
  const pr = eng.presence[m.username];
  const st = pr?.inVoice ? 'voice' : pr?.away ? 'away' : pr?.online ? 'online' : 'offline';
  const streaming = pr?.streaming;
  const self = m.username === me.username;
  const profileBannerUrl = normalizeProfileBanner(self ? me.profileBannerUrl : m.profileBannerUrl);
  const watching = !!eng.watching[m.username];
  const pending = !!eng.pending[m.username];
  const canKick = !!active && active.ownerId === me.id && !self && m.role !== 'owner';
  const hc = useHoverCard();
  const streamMeta = streaming ? E.getStreamAppMeta(m.username) : null;
  const activityName = streaming ? (pr?.game?.name || streamMeta?.appName || 'Трансляция') : pr?.game?.name;
  const activityIcon = streaming ? (pr?.game?.icon || streamMeta?.appIcon) : pr?.game?.icon;
  async function kick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!active) return;
    if (!window.confirm(`Выгнать ${m.displayName} с сервера?`)) return;
    try { await api.kickMember(active.id, m.id); toast(`${m.displayName} выгнан`, 'ok'); refreshMembers(); }
    catch (err: any) { toast(err?.message || 'Не удалось выгнать', 'err'); }
  }
  return (
    <div className={'pi ' + st + (streaming ? ' streaming' : '') + (anim ? ' ' + anim : '')} data-spk={m.username}>
      <div className={'head' + (profileBannerUrl ? ' has-profile-banner' : '')} ref={hc.ref} role="button" tabIndex={0} aria-label={`Профиль ${m.displayName}`}
        onClick={hc.onToggle} onMouseEnter={hc.onEnter} onMouseLeave={hc.onLeave}
        onFocus={hc.onFocus} onBlur={hc.onBlur} onKeyDown={(event) => { if (event.target === event.currentTarget) hc.onKeyDown(event); }}>
        <ProfileBannerMedia value={profileBannerUrl} className="member-row-banner" compact />
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} size={36} dot={st} live={!!streaming} />
        <div className="pi-main">
          <div className="pi-l1">
            <div className="nm" style={roleColorOf(m) ? { color: roleColorOf(m) } : undefined}>{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{self ? ' (ты)' : ''}</div>
          </div>
          {activityName || (m.roles && m.roles.length > 0) ? (
            <div className="pi-l2">
              {activityName ? <span className={'pi-activity ' + (streaming ? 'is-live' : 'is-game')} data-tip={(streaming ? 'В эфире: ' : 'Играет: ') + activityName}>
                <span className="pi-activity-icon">{activityIcon ? <img src={`data:image/png;base64,${activityIcon}`} alt="" /> : streaming ? <Icon name="screen" sm /> : '🎮'}</span>
                <b>{streaming ? 'LIVE' : 'Игра'}</b><span className="pi-activity-name">· {activityName}</span>
              </span> : null}
              {m.roles && m.roles.length > 0 ? <MemberRoles roles={m.roles} /> : null}
            </div>
          ) : null}
        </div>
        <div className="pi-ctl">
          {!self && streaming ? (
            <button className={'watchbtn' + (watching ? ' on' : '')} disabled={pending}
              aria-label={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
              data-tip={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
              onClick={(e) => { e.stopPropagation(); watching ? E.closeWatch(m.username) : E.watch(m.username); }}>
              {pending ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name={watching ? 'eye-off' : 'eye'} />}
            </button>
          ) : null}
          {canKick ? <button className="mkick" aria-label={`Выгнать ${m.displayName}`} data-tip="Выгнать" onClick={kick}><Icon name="close" sm /></button> : null}
        </div>
      </div>
      {hc.rect ? <ProfileCard m={m} rect={hc.rect} onEnter={hc.onCardEnter} onLeave={hc.onCardLeave} /> : null}
    </div>
  );
}

function Members() {
  const eng = useEngine();
  const members = useStore((s) => s.members);
  const active = useStore((s) => s.active);
  const setModal = useStore((s) => s.setModal);
  const online = members.filter((m) => eng.presence[m.username]?.online);
  const offline = members.filter((m) => !eng.presence[m.username]?.online);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const matchesQuery = (m: Member) => !normalizedQuery
    || m.displayName.toLocaleLowerCase('ru-RU').includes(normalizedQuery)
    || m.username.toLocaleLowerCase('ru-RU').includes(normalizedQuery);

  // анимация смены online<->offline: строка уезжает вправо из старой секции (ghost, схлопывается)
  // и въезжает справа в новую. enter — юзеры с анимацией входа; exit — ghost'ы в покидаемой секции.
  const [enter, setEnter] = useState<Set<string>>(() => new Set());
  const [exit, setExit] = useState<Map<string, 'on' | 'off'>>(() => new Map());
  const prevOn = useRef<Set<string> | null>(null);
  const timers = useRef<Map<string, number>>(new Map());
  // useLayoutEffect (не useEffect): стейт входа/выхода ставим ДО paint, иначе мелькнёт
  // промежуточный кадр (строка исчезла из старой секции раньше, чем появился ghost)
  useLayoutEffect(() => {
    const onSet = new Set(online.map((m) => m.username));
    if (prevOn.current === null) { prevOn.current = onSet; return; } // первый маунт — без анимации
    const was = prevOn.current, cur = new Set(members.map((m) => m.username));
    const flips: { u: string; toOnline: boolean }[] = [];
    onSet.forEach((u) => { if (!was.has(u)) flips.push({ u, toOnline: true }); });
    was.forEach((u) => { if (!onSet.has(u) && cur.has(u)) flips.push({ u, toOnline: false }); });
    prevOn.current = onSet;
    if (!flips.length || flips.length > 6) return; // >6 = массовая смена (переключение сервера) — без анимации
    setEnter((p) => { const n = new Set(p); flips.forEach((f) => n.add(f.u)); return n; });
    setExit((p) => { const n = new Map(p); flips.forEach((f) => n.set(f.u, f.toOnline ? 'off' : 'on')); return n; });
    flips.forEach((f) => {
      const old = timers.current.get(f.u); if (old) clearTimeout(old);
      timers.current.set(f.u, window.setTimeout(() => {
        setEnter((p) => { const n = new Set(p); n.delete(f.u); return n; });
        setExit((p) => { const n = new Map(p); n.delete(f.u); return n; });
        timers.current.delete(f.u);
      }, 660));
    });
  }, [online, offline, members]);
  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); }, []);

  const onSet = new Set(online.map((m) => m.username));
  const onlineRender = members.filter((m) => onSet.has(m.username) || exit.get(m.username) === 'on');
  const offlineRender = members.filter((m) => !onSet.has(m.username) || exit.get(m.username) === 'off');
  const visibleOnline = onlineRender.filter(matchesQuery);
  const visibleOffline = offlineRender.filter(matchesQuery);
  const animOf = (m: Member, sectionOnline: boolean): string => {
    const isNow = sectionOnline ? onSet.has(m.username) : !onSet.has(m.username);
    if (!isNow) return 'mrow-exit';                                  // ghost в покидаемой секции
    return enter.has(m.username) ? 'mrow-enter' : '';
  };

  return (
    <aside id="members">
      <header className="members-head">
        <div className="members-title"><span>Участники</span><b>{members.length}</b></div>
        {active?.statsEnabled ? <button className="m-trophy tip-b" aria-label="Рейтинг и уровни" data-tip="Рейтинг и уровни" onClick={() => setModal('leaderboard')}><Icon name="trophy" sm /></button> : null}
      </header>
      <div className="members-search" role="search">
        <Icon name="search" sm />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти участника" aria-label="Найти участника" />
        {query ? <button aria-label="Очистить поиск" onClick={() => setQuery('')}><Icon name="close" sm /></button> : null}
      </div>
      <div id="mlist">
        {visibleOnline.length ? <div className="m-sec">В сети <span>{visibleOnline.length}</span></div> : null}
        {visibleOnline.map((m) => <MemberRow m={m} anim={animOf(m, true)} key={m.username} />)}
        {visibleOffline.length ? <div className="m-sec">Не в сети <span>{visibleOffline.length}</span></div> : null}
        {visibleOffline.map((m) => <MemberRow m={m} anim={animOf(m, false)} key={m.username} />)}
        {normalizedQuery && !visibleOnline.length && !visibleOffline.length ? (
          <div className="members-empty"><Icon name="search" /><b>Никого не нашли</b><span>Попробуй другой ник или логин.</span></div>
        ) : null}
      </div>
    </aside>
  );
}

/* ---------- Chat ---------- */
type RichPart = string | { emo: string; name: string } | { link: string; label: string } | { mention: string };
// сначала вырезаем упоминания (в т.ч. многословные ники по списку известных имён), остальное токенизируем
function renderRich(text: string, names?: Set<string>): RichPart[] {
  const out: RichPart[] = [];
  const tokenize = (chunk: string) => {
    for (const tok of chunk.split(/(\s+)/)) {
      if (!tok) continue;
      if (emoteMap.has(tok)) out.push({ emo: emoteMap.get(tok)!, name: tok });
      else if (/https?:\/\//i.test(tok)) {
        const linkParts = linkifyHttpUrls(tok);
        const foundLink = linkParts.some((part) => typeof part !== 'string');
        if (foundLink) {
          for (const part of linkParts) {
            if (typeof part === 'string') out.push(part);
            else out.push({ link: part.href, label: part.label });
          }
        } else {
          out.push(tok);
        }
      }
      else if ((!names || names.size === 0) && /^@[^\s@]{1,32}$/.test(tok)) out.push({ mention: tok });
      else out.push(tok);
    }
  };
  let last = 0;
  if (names && names.size) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '@') continue;
      if (i > 0 && !/\s/.test(text[i - 1])) continue; // @ только в начале токена
      const rest = text.slice(i + 1).toLowerCase();
      let best = 0;
      for (const nm of names) {
        if (nm && nm.length > best && rest.startsWith(nm)) {
          const nx = rest[nm.length];
          if (nx === undefined || /[\s.,!?:;)»"']/.test(nx)) best = nm.length;
        }
      }
      if (best > 0) {
        if (i > last) tokenize(text.slice(last, i));
        out.push({ mention: text.slice(i, i + 1 + best) });
        last = i + 1 + best; i = last - 1;
      }
    }
  }
  tokenize(text.slice(last));
  return out;
}

function YouTubePreview({ video }: { video: YouTubeVideoRef }) {
  const [title, setTitle] = useState('Видео на YouTube');
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setTitle('Видео на YouTube');
    setThumbnailFailed(false);
    void fetchTitle(video.videoId).then((nextTitle) => {
      if (active && nextTitle && nextTitle !== video.videoId) setTitle(nextTitle);
    });
    return () => { active = false; };
  }, [video.videoId]);

  return (
    <ExternalLink href={video.canonicalUrl} className="yt-preview" aria-label={`Открыть видео «${title}» на YouTube во внешнем браузере`}>
      <span className={'yt-preview-media' + (thumbnailFailed ? ' failed' : '')}>
        {!thumbnailFailed ? (
          <img src={video.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbnailFailed(true)} />
        ) : null}
        <span className="yt-preview-play" aria-hidden="true"><Icon name="play" /></span>
      </span>
      <span className="yt-preview-copy">
        <span className="yt-preview-topline">
          <span className="yt-preview-service">YouTube</span>
          <span className="yt-preview-open" aria-hidden="true">Открыть <Icon name="open-in" sm /></span>
        </span>
        <span className="yt-preview-title" title={title}>{title}</span>
      </span>
    </ExternalLink>
  );
}
function fmtTime(ts?: number): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

const RELEASE_PREVIEW_LIMIT = 6;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

function safeIsoTime(ts?: number): string | null {
  if (!Number.isFinite(ts) || !ts || ts < 0 || ts > MAX_DATE_TIMESTAMP) return null;
  try { return new Date(ts).toISOString(); } catch { return null; }
}

function ReleasePatchCard({ release, ts }: { release: ReleaseNote; ts?: number }) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, release.notes.length - RELEASE_PREVIEW_LIMIT);
  const notes = expanded ? release.notes : release.notes.slice(0, RELEASE_PREVIEW_LIMIT);
  const version = release.version
    ? (/^v/i.test(release.version) ? release.version : `v${release.version}`)
    : null;
  const dateTime = safeIsoTime(ts);
  return (
    <div className="virt-row release-row">
      <article className="release-card" data-chat-visual-anchor="" aria-label={`Обновление: ${release.title}`}>
        <span className="release-announcer" role="status" aria-live="polite" aria-atomic="true">
          {`${release.title}. ${release.notes.join('. ')}`}
        </span>
        <span className="release-mark" aria-hidden="true"><Icon name="download" /></span>
        <div className="release-copy">
          <header className="release-head">
            <span className="release-kicker"><span className="release-pulse" />Обновление</span>
            {dateTime ? <time dateTime={dateTime}>{fmtTime(ts)}</time> : null}
          </header>
          <h3>{release.title}</h3>
          <ul>{notes.map((note, index) => <li key={`${index}:${note}`}><span>{note}</span></li>)}</ul>
          {version || hiddenCount ? (
            <footer>
              {version ? <span className="release-version">{version}</span> : null}
              {hiddenCount ? (
                <button type="button" className="release-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                  {expanded ? 'Свернуть' : `Показать ещё ${hiddenCount}`}
                </button>
              ) : null}
            </footer>
          ) : null}
        </div>
      </article>
    </div>
  );
}
// Единая логика "сохранить вложение" — общая для чипов файлов в чате и кнопки в лайтбоксе
// картинки. В нативе (Tauri) — настоящий системный диалог «Сохранить как» (plugin-dialog +
// запись байт через plugin-fs). В вебе — fetch() в Blob + локальная blob:-ссылка (a.click(),
// same-document, без навигации/нового окна — <a target="_blank"> на внешний https:// origin в
// нативе молча блокируется, нет плагина shell/opener). "Умная кнопка" (натив): если вложение уже
// скачано и файл всё ещё на месте — ОТКРЫВАЕТ его с диска вместо повторного скачивания.
// Возвращает true, если состоялось реальное скачивание (для тоста "Сохранено"), false — если
// просто открыли уже существующий файл.
async function saveAttachment(f: Attachment, downloads: DownloadItem[]): Promise<boolean> {
  if (isTauri) {
    const rec = downloads.find((d) => d.url === f.url && d.path);
    if (rec?.path) {
      const [exists] = await pathsExist([rec.path]);
      if (exists) { await openFile(rec.path); return false; }
    }
  }
  const r = await fetch(resolveUploadUrl(f.url));
  if (!r.ok) throw new Error('Ошибка ' + r.status);
  const blob = await r.blob();
  if (isTauri) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await saveFileDialog(bytes, f.name);
    if (path) addDownload({ url: f.url, name: f.name, size: f.size, mime: f.mime, savedAt: Date.now(), path });
    return !!path;
  }
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl; a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
  addDownload({ url: f.url, name: f.name, size: f.size, mime: f.mime, savedAt: Date.now() });
  return true;
}

function ImageLightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const downloads = useSyncExternalStore(subscribeDownloads, getDownloads);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const url = resolveUploadUrl(attachment.url);
  async function onDownload() {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveAttachment(attachment, downloads);
      if (saved) toast(`Сохранено: ${attachment.name}`, 'ok');
    } catch { toast(`Не удалось скачать ${attachment.name}`, 'err'); }
    finally { setBusy(false); }
  }
  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lb-close" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
      <button className="lb-dl" aria-label="Скачать" disabled={busy} onClick={(e) => { e.stopPropagation(); onDownload(); }}>
        {busy ? <span className="spin" style={{ margin: 0, width: 16, height: 16 }} /> : <Icon name="download" />}
      </button>
      <a className="lb-open" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Открыть оригинал</a>
      <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// вложения сообщения: картинки — грид миниатюр (клик → лайтбокс), остальные файлы — чипы со
// скачиванием (форс-download на сервере, см. GET /api/files/:name — не инлайн, любое расширение).
function messageImageStyle(file?: Pick<Attachment, 'width' | 'height'>, compact = false): CSSProperties {
  const maxWidth = compact ? 180 : 340;
  const maxHeight = compact ? 180 : 300;
  const width = Number(file?.width);
  const height = Number(file?.height);
  if (!(width > 0 && height > 0)) {
    return { width: `min(${maxWidth}px, 100%)`, aspectRatio: compact ? '1 / 1' : '4 / 3' };
  }
  // Keep hostile/corrupt metadata from creating a thousands-of-pixels-tall row.
  // The image itself remains fully visible through object-fit inside this safe frame.
  const ratio = Math.max(.2, Math.min(5, width / height));
  const displayWidth = Math.min(maxWidth, width, maxHeight * ratio);
  return {
    width: `min(${Math.max(1, Math.round(displayWidth))}px, 100%)`,
    aspectRatio: String(ratio),
  };
}

function MessageAttachments({ files, onImageClick }: { files: Attachment[]; onImageClick: (a: Attachment) => void }) {
  const toast = useStore((s) => s.toast);
  const downloads = useSyncExternalStore(subscribeDownloads, getDownloads);
  const images = files.filter((f) => f.kind === 'image');
  const others = files.filter((f) => f.kind === 'file');
  const [downloading, setDownloading] = useState<number | null>(null);
  async function downloadFile(i: number, f: Attachment) {
    if (downloading != null) return;
    setDownloading(i);
    try {
      const saved = await saveAttachment(f, downloads);
      if (saved) toast(`Сохранено: ${f.name}`, 'ok');
    } catch { toast(`Не удалось скачать ${f.name}`, 'err'); }
    finally { setDownloading(null); }
  }
  return (
    <div className="msg-files">
      {images.length ? (
        <div className="msg-img-grid">
          {images.map((f, i) => (
            <button key={i} className="msg-img-wrap" style={messageImageStyle(f, true)} onClick={() => onImageClick(f)}>
              <img className="msg-img" src={resolveUploadUrl(f.url)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
      {others.map((f, i) => {
        const already = isTauri && downloads.some((d) => d.url === f.url && d.path);
        return (
          <button key={i} className="msg-file" disabled={downloading === i} onClick={() => downloadFile(i, f)}>
            <Icon name="file" sm />
            <span className="mf-name">{f.name}</span>
            <span className="mf-size">{fmtSize(f.size)}</span>
            {downloading === i ? <span className="spin" style={{ margin: 0, width: 14, height: 14 }} /> : <Icon name={already ? 'open-in' : 'download'} sm />}
          </button>
        );
      })}
    </div>
  );
}

const COMMANDS: { name: string; desc: string }[] = [
  { name: 'clear', desc: 'Очистить чат (нужна модерация)' },
  { name: 'help', desc: 'Список команд' },
];

// Базовый индекс для virtuoso firstItemIndex: при догрузке старых сообщений его уменьшаем
// на кол-во добавленных сверху — так virtuoso держит якорь скролла на месте (prepend-паттерн).
const VIRT_BASE_INDEX = 1_000_000;
const CHAT_PREPEND_MAX_CORRECTIONS = 4;

interface ChatPrependTransaction {
  requestSeq: number;
  serverId: string;
  historyGeneration: number;
  committed: boolean;
  targetPrepended: number | null;
  anchorAbsoluteIndex: number | null;
  anchorTop: number;
  anchorVisualOffset: number;
  visualOffsetRemaining: number | null;
  visualOffsetCorrected: boolean;
  restoreTail: boolean;
}

function chatVisualAnchor(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('[data-chat-visual-anchor]') || row;
}

// Шапка списка чата: спиннер во время догрузки старых сообщений / метка начала истории.
// Определена на уровне модуля (стабильная ссылка) — иначе virtuoso ремонтит её на каждый рендер.
// Лоадер догрузки вынесен из хедера в absolute-оверлей (#chat) — иначе смена высоты хедера в потоке
// списка дёргала якорь virtuoso (прыжок). Здесь остаётся только фикс-высокая метка «начало истории».
function ChatOlderHeader({ context }: { context?: ChatVirtuosoContext }) {
  return (
    <div className="virt-head">
      {context && !context.hasMore ? <span className="virt-head-end">Начало истории</span> : null}
    </div>
  );
}
type ChatVirtuosoContext = {
  hasMore?: boolean;
  tailRef?: (node: HTMLDivElement | null) => void;
};

function ChatFooter({ context }: { context?: ChatVirtuosoContext }) {
  return <div ref={context?.tailRef} className="chat-tail-sentinel" style={{ height: CHAT_TAIL_RESERVE_PX }} />;
}

const CHAT_VIRTUOSO_COMPONENTS = {
  Header: ChatOlderHeader,
  Footer: ChatFooter,
};

// Группировка подряд идущих сообщений одного автора (как в Telegram): шапка (имя/время) —
// только у первого сообщения группы. Группу разрывают: смена автора, системное сообщение,
// ответ (reply) и пауза > 5 минут.
const GROUP_GAP_MS = 5 * 60 * 1000;
function isGroupStart(m: ChatMessage, prev?: ChatMessage): boolean {
  if (m.sys || !prev || prev.sys) return true;
  if (prev.who !== m.who || prev.mine !== m.mine) return true;
  if (m.reply) return true;
  if (m.ts && prev.ts && m.ts - prev.ts > GROUP_GAP_MS) return true;
  return false;
}

function Chat() {
  const eng = useEngine();
  const E = getEngine()!;
  const [text, setText] = useState('');
  // Черновики per-server: недописанное сообщение не теряется при переходе между серверами (localStorage).
  const textRef = useRef(text); textRef.current = text;
  const prevActive = useRef<string | undefined>(undefined);
  const DRAFT_KEY = 'chatDraft:';
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [pickAnchor, setPickAnchor] = useState<DOMRect | null | undefined>(undefined);
  const emoBtnRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachFileRef = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const stagedRef = useRef<StagedAttachment[]>([]);
  stagedRef.current = staged;
  // юзер нажал «Отправить»/Enter, пока вложение ещё грузится — не просто тост в пустоту (выглядит
  // как «зависло»), а ставим в очередь: кнопка отправки показывает спиннер, реальная отправка уходит
  // автоматически как только все загрузки завершатся (см. эффект ниже send()).
  const [sendQueued, setSendQueued] = useState(false);
  const toast = useStore((s) => s.toast);
  const updateReady = useStore((s) => s.updateReady);
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const activeId = useStore((s) => s.active?.id);
  // Черновики per-server: сохранить при уходе, восстановить при входе. (refs объявлены выше.)
  useEffect(() => {
    const prev = prevActive.current;
    if (prev && prev !== activeId) {
      if (textRef.current.trim()) localStorage.setItem(DRAFT_KEY + prev, textRef.current);
      else localStorage.removeItem(DRAFT_KEY + prev);
    }
    prevActive.current = activeId;
    setText((activeId && localStorage.getItem(DRAFT_KEY + activeId)) || '');
    return () => { const a = prevActive.current; if (a) { if (textRef.current.trim()) localStorage.setItem(DRAFT_KEY + a, textRef.current); else localStorage.removeItem(DRAFT_KEY + a); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  const nativeUpdate = useStore((s) => s.nativeUpdate);
  const [updating, setUpdating] = useState(false);
  const messages = eng.messages;
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null); // на какое сообщение отвечаем
  const [flashId, setFlashId] = useState<number | null>(null);      // подсветка оригинала при переходе по цитате
  const [reactTarget, setReactTarget] = useState<{ target: { id: number; sid?: number | null }; anchor: DOMRect } | null>(null); // 7TV-пикер для реакции
  const [editing, setEditing] = useState<{ id: number; sid: number } | null>(null); // инлайн-редактирование
  const [editText, setEditText] = useState('');
  const [actionsFor, setActionsFor] = useState<number | null>(null); // touch: явное меню действий сообщения

  useEffect(() => {
    if (actionsFor == null) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest('.msg-actions,.msg-more')) setActionsFor(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [actionsFor]);
  const markReadStore = useStore((s) => s.markRead);
  const bumpUnreadStore = useStore((s) => s.bumpUnread);
  const unreadServer = useStore((s) => s.unread[activeId || ''] || 0);
  const lastRead = useStore((s) => s.lastRead[activeId || ''] || 0);
  const historyUnreadCandidate = unreadServer > 0
    ? messages.findIndex((m) => m.sid != null && m.sid > lastRead && !m.mine && !m.sys)
    : -1;
  const historyUnreadCandidateId = historyUnreadCandidate >= 0 ? messages[historyUnreadCandidate].id : null;
  // Граница фиксируется на конкретном сообщении на всё время просмотра сервера. markRead больше
  // не удаляет divider из уже измеренной строки, а новый append не может вставить его перед старым
  // сообщением из-за устаревшего baseline.
  const [unreadBoundary, setUnreadBoundary] = useState<{ serverId?: string; id: number | null }>({ id: null });
  // Разделители дней: id первого сообщения каждой календарной даты (сравниваем локальный день с предыдущим).
  const dayFirst = useMemo(() => {
    const s = new Map<number, number>(); // msg.id -> ts начала дня
    let prevDay = '';
    for (const m of messages) {
      if (!m.ts) continue;
      const d = new Date(m.ts); const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      if (key !== prevDay) { s.set(m.id, m.ts); prevDay = key; }
    }
    return s;
  }, [messages]);
  const fmtDay = (ts: number) => {
    const d = new Date(ts), now = new Date();
    const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Сегодня';
    if (sameDay(d, yest)) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  };

  // --- виртуальный список чата (react-virtuoso) ---
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const detachScrollerRef = useRef<(() => void) | null>(null);
  const tailElementRef = useRef<HTMLDivElement | null>(null);
  const tailObserverRef = useRef<IntersectionObserver | null>(null);
  const bottomSnapFrameRef = useRef<number | null>(null);
  const bottomSnapBehaviorRef = useRef<'auto' | 'smooth'>('auto');
  const tailSettleFrameRef = useRef<number | null>(null);
  const tailSettleTokenRef = useRef(0);
  const tailSettleStateRef = useRef<ChatTailSettleState>(INITIAL_CHAT_TAIL_SETTLE);
  const virtuosoScrollingRef = useRef(false);
  const geometryFrameRef = useRef<number | null>(null);
  const userDirectionRef = useRef<ChatScrollDirection>('none');
  const userDirectionTimerRef = useRef<number | null>(null);
  const ownSendPendingRef = useRef(false);
  const ownSendNeedsSemanticRef = useRef(false);
  const initialBottomPendingRef = useRef(unreadServer === 0);
  const initialSemanticIssuedRef = useRef(false);
  const initialGeometryPendingRef = useRef(true);
  const smoothJumpPendingRef = useRef(false);
  const bottomRearmBlockedRef = useRef(false);
  const prependGuardRef = useRef(false);
  const prependTransactionRef = useRef<ChatPrependTransaction | null>(null);
  const prependSettleFrameRef = useRef<number | null>(null);
  const prependSettleTokenRef = useRef(0);
  const [prependGuardActive, setPrependGuardActive] = useState(false);
  const [pill, setPill] = useState(0);            // счётчик непрочитанных (пока не внизу)
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // Геометрия и follow-intent намеренно разделены: atBottom управляет read/unread, а follow
  // только решает, должен ли новый хвост автоматически оставаться в поле зрения.
  const bottomFollowIntentRef = useRef(unreadServer === 0);
  const [followingTail, setFollowingTail] = useState(unreadServer === 0);
  const bottomFollowServerRef = useRef(activeId);
  const appendCursorRef = useRef<{ serverId?: string; historyGeneration: number | null; tailId: number | null; count: number }>({ historyGeneration: null, tailId: null, count: 0 });
  const loadOlderRef = useRef<(() => Promise<void>) | null>(null);
  const [dividerFade, setDividerFade] = useState(false);
  const [focusTick, setFocusTick] = useState(0); // тикает на focus/blur/visibility — «увидел глазами» зависит от фокуса окна
  // Якорь virtuoso DERIVED из engine-стейта (prepend/срез) — меняется ВМЕСТЕ с messages (один emit),
  // поэтому Virtuoso всегда видит согласованные data+firstItemIndex → чат НЕ прыгает при пагинации.
  // (Раньше был component-state + отдельные setFirstItemIndex → два источника, рассинхрон, прыжок.)
  const firstItemIndex = chatVirtualFirstItemIndex(VIRT_BASE_INDEX, eng.chatPrepended, eng.chatTrimmed);
  const [olderBusy, setOlderBusy] = useState(false); // идёт догрузка старых
  const loadingOlder = useRef(false);                // защита от повторного startReached
  const olderRequestSeq = useRef(0);
  const olderReady = useRef(false);                  // гейт: не грузить старое, пока вход не устаканился
  const lastAckedRef = useRef<number | null>(null);   // последний месседж (local id), для которого послан readAll — не спамим POST
  const lastTagAt = useRef(0);                         // троттл звука-пинга сообщений (не в фокусе) — не строчить пулемётом
  // автокомплит упоминаний (@ник)
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mIdx, setMIdx] = useState(0);
  const popRef = useRef<HTMLDivElement>(null); // контейнер попапа автокомплита — для скролла выделения

  // Классифицируем только настоящий suffix-append. Локальные id живут стабильно всю сессию:
  // - prepend оставляет прежний хвост последним;
  // - delete хвоста делает прежний id отсутствующим;
  // - CAP/trim срезает начало, но прежний хвост остаётся и новые элементы идут после него.
  // Поэтому ни пагинация, ни delete, ни replace истории больше не выглядят как новое сообщение.
  const appendCursor = appendCursorRef.current;
  const historyGeneration = E.chatHistoryGeneration;
  const activeIdRef = useRef(activeId);
  const historyGenerationRef = useRef(historyGeneration);
  activeIdRef.current = activeId;
  historyGenerationRef.current = historyGeneration;
  const sameAppendSource = appendCursor.serverId === activeId && appendCursor.historyGeneration === historyGeneration;
  let appendedMessages: ChatMessage[] = [];
  if (sameAppendSource) {
    if (appendCursor.tailId == null) {
      if (appendCursor.count === 0 && messages.length > 0) appendedMessages = messages;
    } else {
      const previousTailIndex = messages.findIndex((m) => m.id === appendCursor.tailId);
      if (previousTailIndex >= 0 && previousTailIndex < messages.length - 1) appendedMessages = messages.slice(previousTailIndex + 1);
    }
  }
  const isSuffixAppend = appendedMessages.length > 0;
  const ownExplicitAppend = isSuffixAppend && ownSendPendingRef.current && appendedMessages.some((message) => message.mine);
  const initialPinnedHydration = messages.length > 0
    && initialBottomPendingRef.current
    && !initialSemanticIssuedRef.current
    && bottomFollowIntentRef.current;
  // Только authoritative pin/локальный send могут подхватить append. `mine` не подходит:
  // своё сообщение с другой вкладки не должно вырывать текущую вкладку из читаемой истории.
  const prependKeepsTailIntent = !prependGuardActive
    || prependTransactionRef.current?.restoreTail === true;
  const shouldFollowAppend = isSuffixAppend
    && bottomFollowIntentRef.current
    && prependKeepsTailIntent;
  // У realtime-сообщения sid появится позже. Если пользователь читает историю, ставим границу
  // сразу на первый фактически добавленный row в том же render, а не отдельным кадром после bumpUnread.
  const liveUnreadCandidateId = isSuffixAppend && !shouldFollowAppend
    ? appendedMessages.find((message) => !message.mine && !message.sys)?.id ?? null
    : null;
  const storedUnreadId = unreadBoundary.serverId === activeId
    && unreadBoundary.id != null
    && messages.some((message) => message.id === unreadBoundary.id)
    ? unreadBoundary.id
    : null;
  const firstUnreadId = storedUnreadId ?? liveUnreadCandidateId ?? historyUnreadCandidateId;
  const firstUnread = firstUnreadId == null
    ? -1
    : messages.findIndex((message) => message.id === firstUnreadId);
  useLayoutEffect(() => {
    setUnreadBoundary((current) => current.serverId === activeId && current.id === firstUnreadId
      ? current
      : { serverId: activeId, id: firstUnreadId });
  }, [activeId, firstUnreadId]);
  const followOutputEnabled = !prependGuardActive && (bottomFollowServerRef.current !== activeId
    ? unreadServer === 0
    : followingTail);
  // Собственный optimistic append должен закрепиться в том же commit: откладывание единственного
  // semantic scroll до следующего RAF само создаёт видимый кадр со старым scrollTop.
  const nativeFollowOutputEnabled = !prependGuardActive
    && (followOutputEnabled || ownExplicitAppend)
    && !initialPinnedHydration;

  const setFollowIntent = useCallback((next: boolean) => {
    bottomFollowServerRef.current = activeId;
    bottomFollowIntentRef.current = next;
    setFollowingTail((current) => current === next ? current : next);
  }, [activeId]);
  const commitAtBottom = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom((current) => current === next ? current : next);
    if (next) setPill((current) => current === 0 ? current : 0);
  }, []);
  const cancelBottomSnap = useCallback(() => {
    if (bottomSnapFrameRef.current != null) window.cancelAnimationFrame(bottomSnapFrameRef.current);
    bottomSnapFrameRef.current = null;
    bottomSnapBehaviorRef.current = 'auto';
  }, []);
  const cancelTailSettle = useCallback(() => {
    ++tailSettleTokenRef.current;
    if (tailSettleFrameRef.current != null) window.cancelAnimationFrame(tailSettleFrameRef.current);
    tailSettleFrameRef.current = null;
    tailSettleStateRef.current = {
      ...tailSettleStateRef.current,
      phase: 'cancelled',
      stableFrames: 0,
    };
  }, []);
  const armTailSettle = useCallback((force = false) => {
    if (!bottomFollowIntentRef.current || bottomRearmBlockedRef.current
      || userDirectionRef.current === 'up' || prependGuardRef.current) return;
    const currentScroller = scrollerElementRef.current;
    if (!force && !initialBottomPendingRef.current && currentScroller
      && chatBottomDistance(currentScroller) <= CHAT_PHYSICAL_BOTTOM_EPSILON_PX) return;

    // A running transaction consumes fresh geometry itself. Do not restart its deadline or
    // forget the already-written target when another ResizeObserver callback arrives.
    if (tailSettleFrameRef.current != null) return;

    const token = ++tailSettleTokenRef.current;
    const deadline = window.performance.now() + 2400;
    tailSettleStateRef.current = { ...INITIAL_CHAT_TAIL_SETTLE };

    const tick = () => {
      if (token !== tailSettleTokenRef.current) return;
      const scroller = scrollerElementRef.current;
      const tail = tailElementRef.current;
      const geometry = scroller ? {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
      } : { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
      const waitingForSmoothArrival = smoothJumpPendingRef.current
        && chatBottomDistance(geometry) > CHAT_BOTTOM_ENTER_PX;
      const decision = reduceChatTailSettle(tailSettleStateRef.current, {
        geometry,
        ready: !!scroller && !!tail && tail.isConnected
          && tail.getBoundingClientRect().height >= CHAT_TAIL_RESERVE_PX - 0.5
          && !initialGeometryPendingRef.current
          && !waitingForSmoothArrival,
        scrolling: virtuosoScrollingRef.current,
        following: bottomFollowIntentRef.current,
        direction: userDirectionRef.current,
        rearmBlocked: bottomRearmBlockedRef.current,
        prepend: prependGuardRef.current,
      });
      tailSettleStateRef.current = decision.state;

      if (decision.scrollTop != null) {
        // `scrollToIndex` is semantic and can use a size estimate. This final write targets the
        // browser's measured maximum. The reducer permits one bounded retry of the same target,
        // caps total writes, and the caller bounds the whole transaction with a hard deadline.
        if (virtuosoRef.current) virtuosoRef.current.scrollTo({ top: decision.scrollTop, behavior: 'auto' });
        else scroller?.scrollTo({ top: decision.scrollTop, behavior: 'auto' });
      }

      if (decision.state.phase === 'settled') {
        initialBottomPendingRef.current = false;
        smoothJumpPendingRef.current = false;
        tailSettleFrameRef.current = null;
        return;
      }
      if (!decision.keepSampling || window.performance.now() >= deadline) {
        tailSettleStateRef.current = { ...decision.state, phase: 'cancelled' };
        tailSettleFrameRef.current = null;
        return;
      }
      tailSettleFrameRef.current = window.requestAnimationFrame(tick);
    };
    tailSettleFrameRef.current = window.requestAnimationFrame(tick);
  }, []);
  const scheduleBottomSnap = useCallback((
    behavior: 'auto' | 'smooth' = 'auto',
    forcePhysicalVerification = false,
  ) => {
    if (!bottomFollowIntentRef.current || prependGuardRef.current) return;
    if (behavior === 'smooth') bottomSnapBehaviorRef.current = 'smooth';
    if (bottomSnapFrameRef.current != null) return;
    bottomSnapFrameRef.current = window.requestAnimationFrame(() => {
      bottomSnapFrameRef.current = null;
      if (!bottomFollowIntentRef.current || prependGuardRef.current) return;
      const nextBehavior = bottomSnapBehaviorRef.current;
      bottomSnapBehaviorRef.current = 'auto';
      // Virtuoso performs the semantic jump first. The finite physical transaction below waits
      // until its scrolling/measurement pass ends and verifies the real DOM maximum.
      virtuosoRef.current?.scrollToIndex(chatTailIndexLocation('LAST', nextBehavior));
      armTailSettle(forcePhysicalVerification);
    });
  }, [armTailSettle]);
  const sampleScrollGeometry = useCallback(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller || initialGeometryPendingRef.current || prependGuardRef.current) return;
    const distance = chatBottomDistance(scroller);
    const next = reduceChatScrollState({
      atBottom: atBottomRef.current,
      following: bottomFollowIntentRef.current,
    }, distance, userDirectionRef.current, bottomRearmBlockedRef.current);
    if (next.following !== bottomFollowIntentRef.current) {
      setFollowIntent(next.following);
      if (!next.following) {
        initialBottomPendingRef.current = false;
        smoothJumpPendingRef.current = false;
        cancelBottomSnap();
        cancelTailSettle();
      }
    }
    if (next.atBottom) smoothJumpPendingRef.current = false;
    commitAtBottom(next.atBottom);
  }, [cancelBottomSnap, cancelTailSettle, commitAtBottom, setFollowIntent]);
  const scheduleGeometrySample = useCallback(() => {
    if (geometryFrameRef.current != null) return;
    geometryFrameRef.current = window.requestAnimationFrame(() => {
      geometryFrameRef.current = null;
      sampleScrollGeometry();
    });
  }, [sampleScrollGeometry]);
  const clearUserDirection = useCallback(() => {
    if (userDirectionTimerRef.current != null) window.clearTimeout(userDirectionTimerRef.current);
    userDirectionTimerRef.current = null;
    userDirectionRef.current = 'none';
  }, []);
  const noteUserDirection = useCallback((direction: Exclude<ChatScrollDirection, 'none'>) => {
    if (direction === 'down') bottomRearmBlockedRef.current = false;
    else {
      const cancellingPinnedArrival = initialBottomPendingRef.current || smoothJumpPendingRef.current;
      cancelTailSettle();
      if (cancellingPinnedArrival) {
        initialBottomPendingRef.current = false;
        smoothJumpPendingRef.current = false;
        bottomRearmBlockedRef.current = true;
        setFollowIntent(false);
        commitAtBottom(false);
      }
      const prependTransaction = prependTransactionRef.current;
      if (prependTransaction) prependTransaction.restoreTail = false;
      if (prependGuardRef.current) setFollowIntent(false);
    }
    userDirectionRef.current = direction;
    if (userDirectionTimerRef.current != null) window.clearTimeout(userDirectionTimerRef.current);
    // Direction is evidence of manual intent only for the current input burst. Keeping an
    // old "up" marker around would mistake a later image resize for another manual scroll.
    userDirectionTimerRef.current = window.setTimeout(() => {
      userDirectionTimerRef.current = null;
      userDirectionRef.current = 'none';
    }, 180);
    scheduleGeometrySample();
  }, [cancelTailSettle, commitAtBottom, scheduleGeometrySample, setFollowIntent]);
  const detachBottomFollow = useCallback(() => {
    initialBottomPendingRef.current = false;
    smoothJumpPendingRef.current = false;
    bottomRearmBlockedRef.current = true;
    setFollowIntent(false);
    cancelBottomSnap();
    cancelTailSettle();
    commitAtBottom(false);
  }, [cancelBottomSnap, cancelTailSettle, commitAtBottom, setFollowIntent]);
  const scrollToBottom = useCallback(() => {
    setFollowIntent(true);
    noteUserDirection('down');
    const scroller = scrollerElementRef.current;
    const distance = scroller ? chatBottomDistance(scroller) : Number.POSITIVE_INFINITY;
    if (distance <= CHAT_PHYSICAL_BOTTOM_EPSILON_PX) {
      sampleScrollGeometry();
      return;
    }
    const behavior = prefersReducedMotion() || distance <= CHAT_BOTTOM_ENTER_PX ? 'auto' : 'smooth';
    smoothJumpPendingRef.current = behavior === 'smooth';
    scheduleBottomSnap(behavior, true);
  }, [noteUserDirection, sampleScrollGeometry, scheduleBottomSnap, setFollowIntent]);

  const rebindTailObserver = useCallback(() => {
    tailObserverRef.current?.disconnect();
    tailObserverRef.current = null;
    const root = scrollerElementRef.current;
    const tail = tailElementRef.current;
    if (!root || !tail || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry && entry.intersectionRatio < 1 && bottomFollowIntentRef.current
        && userDirectionRef.current !== 'up'
        && !smoothJumpPendingRef.current && !initialGeometryPendingRef.current
        && !prependGuardRef.current) {
        // The full sentinel must be visible. A low threshold used to accept almost its entire
        // 12px height as "bottom" and left exactly the small gap visible in the scrollbar.
        armTailSettle();
      }
    }, { root, threshold: 1 });
    observer.observe(tail);
    tailObserverRef.current = observer;
  }, [armTailSettle]);
  const bindTail = useCallback((node: HTMLDivElement | null) => {
    tailElementRef.current = node;
    rebindTailObserver();
  }, [rebindTailObserver]);
  const virtuosoContext = useMemo<ChatVirtuosoContext>(() => ({
    hasMore: eng.chatHasMore,
    tailRef: bindTail,
  }), [bindTail, eng.chatHasMore]);
  const onTotalListHeightChanged = useCallback((height: number) => {
    if (!(height > 0) || messages.length === 0) return;
    const wasInitialGeometryPending = initialGeometryPendingRef.current;
    initialGeometryPendingRef.current = false;
    if (wasInitialGeometryPending) rebindTailObserver();
    scheduleGeometrySample();
    // This is also the wake-up that an initial IntersectionObserver event could previously lose.
    // The finite settle verifies physical geometry and becomes inert after confirmation.
    if (bottomFollowIntentRef.current && !prependGuardRef.current) armTailSettle();
  }, [armTailSettle, messages.length, rebindTailObserver, scheduleGeometrySample]);
  const onAtBottom = useCallback((_reportedBottom: boolean) => {
    // Virtuoso's callback is a scheduling signal; one DOM geometry classifier owns the truth.
    // This also accepts a short unread list whose final rows are all physically visible.
    scheduleGeometrySample();
  }, [scheduleGeometrySample]);
  const onVirtuosoScrolling = useCallback((scrolling: boolean) => {
    virtuosoScrollingRef.current = scrolling;
    if (!scrolling) {
      smoothJumpPendingRef.current = false;
      if (bottomFollowIntentRef.current && !prependGuardRef.current) armTailSettle();
    }
  }, [armTailSettle]);

  const releaseOlderRequest = useCallback((requestSeq: number) => {
    if (olderRequestSeq.current !== requestSeq) return;
    loadingOlder.current = false;
    setOlderBusy(false);
  }, []);

  const finishPrependGuard = useCallback((requestSeq: number, restoreTail: boolean) => {
    const transaction = prependTransactionRef.current;
    if (!transaction || transaction.requestSeq !== requestSeq) return;
    ++prependSettleTokenRef.current;
    if (prependSettleFrameRef.current != null) window.cancelAnimationFrame(prependSettleFrameRef.current);
    prependSettleFrameRef.current = null;
    prependTransactionRef.current = null;
    prependGuardRef.current = false;
    setPrependGuardActive(false);
    releaseOlderRequest(requestSeq);
    scheduleGeometrySample();
    if (restoreTail && bottomFollowIntentRef.current && !bottomRearmBlockedRef.current) {
      scheduleBottomSnap('auto');
    }
  }, [releaseOlderRequest, scheduleBottomSnap, scheduleGeometrySample]);

  const beginPrependGuard = useCallback((
    requestSeq: number,
    serverId: string,
    requestHistoryGeneration: number,
  ) => {
    if (prependGuardRef.current || prependTransactionRef.current) return false;
    cancelBottomSnap();
    cancelTailSettle();
    ++prependSettleTokenRef.current;
    if (prependSettleFrameRef.current != null) window.cancelAnimationFrame(prependSettleFrameRef.current);
    prependSettleFrameRef.current = null;
    prependGuardRef.current = true;
    setPrependGuardActive(true);
    const scroller = scrollerElementRef.current;
    const restoreTail = bottomFollowIntentRef.current
      && !!scroller
      && chatBottomDistance(scroller) <= CHAT_BOTTOM_ENTER_PX;
    prependTransactionRef.current = {
      requestSeq,
      serverId,
      historyGeneration: requestHistoryGeneration,
      committed: false,
      targetPrepended: null,
      anchorAbsoluteIndex: null,
      anchorTop: 0,
      anchorVisualOffset: 0,
      visualOffsetRemaining: null,
      visualOffsetCorrected: false,
      restoreTail,
    };
    if (!restoreTail) {
      setFollowIntent(false);
      commitAtBottom(false);
    }
    return true;
  }, [cancelBottomSnap, cancelTailSettle, commitAtBottom, setFollowIntent]);

  const capturePrependAnchor = useCallback((requestSeq: number, targetPrepended: number) => {
    const transaction = prependTransactionRef.current;
    const scroller = scrollerElementRef.current;
    if (!transaction || transaction.requestSeq !== requestSeq) return false;
    transaction.targetPrepended = targetPrepended;
    transaction.committed = true;
    if (!scroller) return true;
    const viewport = scroller.getBoundingClientRect();
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>(
      '[data-testid="virtuoso-item-list"] > [data-item-index]',
    ));
    const visibleRows = rows.filter((row) => {
      const bounds = chatVisualAnchor(row).getBoundingClientRect();
      return bounds.bottom > viewport.top + 0.5 && bounds.top < viewport.bottom - 0.5;
    });
    // The old first item is the only ordinary seam row whose day/group decoration can change.
    // Prefer the next visible row; a giant single row still uses the partial-correction fallback.
    const anchor = visibleRows.find((row) => Number(row.dataset.itemIndex) !== firstItemIndex)
      || visibleRows[0]
      || rows.find((row) => row.getBoundingClientRect().bottom > viewport.top + 0.5)
      || rows[0];
    const visualAnchor = anchor ? chatVisualAnchor(anchor) : null;
    const anchorIndex = Number(anchor?.dataset.itemIndex);
    transaction.anchorAbsoluteIndex = Number.isFinite(anchorIndex) ? anchorIndex : null;
    const rowTop = anchor ? anchor.getBoundingClientRect().top - viewport.top : 0;
    transaction.anchorTop = visualAnchor ? visualAnchor.getBoundingClientRect().top - viewport.top : rowTop;
    transaction.anchorVisualOffset = transaction.anchorTop - rowTop;
    transaction.restoreTail = transaction.restoreTail && bottomFollowIntentRef.current;
    return true;
  }, [firstItemIndex]);

  const settlePrependAnchor = useCallback((requestSeq: number) => {
    const transaction = prependTransactionRef.current;
    if (!transaction || transaction.requestSeq !== requestSeq || !transaction.committed) return;
    if (prependSettleFrameRef.current != null) return;
    if (transaction.anchorAbsoluteIndex == null) {
      finishPrependGuard(requestSeq, transaction.restoreTail);
      return;
    }

    const token = ++prependSettleTokenRef.current;
    let frames = 0;
    let stableFrames = 0;
    let corrections = 0;
    let previousGeometry: { scrollHeight: number; clientHeight: number; scrollTop: number; anchorTop: number } | null = null;
    const correctVisualOffset = () => {
      const current = prependTransactionRef.current;
      const scroller = scrollerElementRef.current;
      if (!current || current.requestSeq !== requestSeq || current.visualOffsetCorrected || !scroller) return;
      const row = scroller.querySelector<HTMLElement>(
        `[data-testid="virtuoso-item-list"] > [data-item-index="${current.anchorAbsoluteIndex}"]`,
      );
      if (!row) return;
      const visualAnchor = chatVisualAnchor(row);
      const rowTop = row.getBoundingClientRect().top;
      const visualOffset = visualAnchor.getBoundingClientRect().top - rowTop;
      if (current.visualOffsetRemaining == null) {
        current.visualOffsetRemaining = chatPrependAnchorDelta(current.anchorVisualOffset, visualOffset);
      }
      const offsetDelta = current.visualOffsetRemaining;
      // This write compensates only decoration that changed *inside* the stable item (day/group
      // header). Virtuoso remains the sole owner of the outer prepend distance.
      if (Math.abs(offsetDelta) <= 0.5) {
        current.visualOffsetCorrected = true;
        return;
      }
      const before = scroller.scrollTop;
      scroller.scrollTop += offsetDelta;
      current.visualOffsetRemaining -= scroller.scrollTop - before;
      current.visualOffsetCorrected = Math.abs(current.visualOffsetRemaining) <= 0.5;
    };
    // React has committed the new seam geometry, so the internal offset can be restored before
    // paint without touching Virtuoso's still-running outer deviation.
    correctVisualOffset();
    const tick = () => {
      if (token !== prependSettleTokenRef.current) return;
      // The scheduled callback owns no pending frame once it starts. Clearing here prevents a
      // stale request from poisoning the single RAF slot used by the next valid transaction.
      prependSettleFrameRef.current = null;
      const current = prependTransactionRef.current;
      const scroller = scrollerElementRef.current;
      if (!current || current.requestSeq !== requestSeq || !prependGuardRef.current) return;
      if (!scroller) {
        finishPrependGuard(requestSeq, false);
        return;
      }
      const currentEngine = getEngine();
      if (current.serverId !== activeIdRef.current
        || current.historyGeneration !== historyGenerationRef.current
        || currentEngine !== E
        || currentEngine?.chatHistoryGeneration !== current.historyGeneration) {
        finishPrependGuard(requestSeq, false);
        return;
      }
      correctVisualOffset();
      const itemList = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
      const deviation = Number.parseFloat(itemList?.style.marginTop || '');
      if (!canCorrectChatPrependAnchor(frames, deviation)) {
        frames += 1;
        if (frames >= 54) finishPrependGuard(requestSeq, current.restoreTail);
        else prependSettleFrameRef.current = window.requestAnimationFrame(tick);
        return;
      }

      const row = scroller.querySelector<HTMLElement>(
        `[data-testid="virtuoso-item-list"] > [data-item-index="${current.anchorAbsoluteIndex}"]`,
      );
      if (!row) {
        if (++frames >= 54) finishPrependGuard(requestSeq, current.restoreTail);
        else prependSettleFrameRef.current = window.requestAnimationFrame(tick);
        return;
      }
      const anchor = chatVisualAnchor(row);

      const viewportTop = scroller.getBoundingClientRect().top;
      let anchorTop = anchor.getBoundingClientRect().top - viewportTop;
      const delta = chatPrependAnchorDelta(current.anchorTop, anchorTop);
      if (Math.abs(delta) > 0.5) {
        if (corrections >= CHAT_PREPEND_MAX_CORRECTIONS) {
          finishPrependGuard(requestSeq, current.restoreTail);
          return;
        }
        // Date/group decoration of the seam row can change after prepend. Restore the stable
        // message content marker only after Virtuoso has completed its own two-frame deviation.
        scroller.scrollTop += delta;
        corrections += 1;
        anchorTop = anchor.getBoundingClientRect().top - viewportTop;
        stableFrames = 0;
      }

      const geometry = {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        anchorTop,
      };
      const stable = previousGeometry
        && Math.abs(previousGeometry.scrollHeight - geometry.scrollHeight) <= 0.5
        && Math.abs(previousGeometry.clientHeight - geometry.clientHeight) <= 0.5
        && Math.abs(previousGeometry.scrollTop - geometry.scrollTop) <= 0.5
        && Math.abs(geometry.anchorTop - current.anchorTop) <= 0.5;
      stableFrames = stable ? stableFrames + 1 : 0;
      previousGeometry = geometry;
      frames += 1;

      if (stableFrames >= 3 || frames >= 54) {
        prependSettleFrameRef.current = null;
        finishPrependGuard(requestSeq, current.restoreTail);
        return;
      }
      prependSettleFrameRef.current = window.requestAnimationFrame(tick);
    };
    // Virtuoso owns the first two prepend frames. Starting asynchronously prevents the custom
    // residual correction from fighting its deviation/scrollBy transaction.
    prependSettleFrameRef.current = window.requestAnimationFrame(tick);
  }, [E, finishPrependGuard]);

  const cancelPrependRestoreForInput = useCallback(() => {
    const transaction = prependTransactionRef.current;
    if (transaction?.committed) finishPrependGuard(transaction.requestSeq, false);
  }, [finishPrependGuard]);

  const bindScroller = useCallback((ref: HTMLElement | null | Window) => {
    detachScrollerRef.current?.();
    detachScrollerRef.current = null;
    scrollerElementRef.current = null;
    virtuosoScrollingRef.current = false;
    const el = ref instanceof HTMLElement ? ref : null;
    if (!el) {
      const transaction = prependTransactionRef.current;
      if (transaction) finishPrependGuard(transaction.requestSeq, false);
      return;
    }
    scrollerElementRef.current = el;
    let touchY: number | null = null;
    let scrollbarDrag = false;
    let directScrollInput = false;
    let directScrollTimer: number | null = null;
    let lastScrollTop = el.scrollTop;
    const extendDirectScrollInput = () => {
      directScrollInput = true;
      if (directScrollTimer != null) window.clearTimeout(directScrollTimer);
      // Momentum keeps emitting scroll events after touchend. Extend the fence from every
      // physical delta so inertia cannot outlive the evidence that the user moved the list.
      directScrollTimer = window.setTimeout(() => {
        directScrollTimer = null;
        directScrollInput = false;
      }, 240);
    };
    const armDirectScrollInput = () => {
      cancelTailSettle();
      cancelPrependRestoreForInput();
      extendDirectScrollInput();
    };
    const onScrollerScroll = () => {
      if (scrollbarDrag || directScrollInput) {
        if (el.scrollTop < lastScrollTop - 0.5) noteUserDirection('up');
        else if (el.scrollTop > lastScrollTop + 0.5) noteUserDirection('down');
        // Momentum/programmatic compensation may emit more scroll events while the input fence
        // is active. Extend only the timer here; cancellation belongs to actual input handlers.
        if (directScrollInput) extendDirectScrollInput();
      }
      lastScrollTop = el.scrollTop;
      scheduleGeometrySample();
    };
    const onWheel = (event: WheelEvent) => {
      armDirectScrollInput();
      if (event.deltaY < 0) noteUserDirection('up');
      else if (event.deltaY > 0) noteUserDirection('down');
    };
    const onTouchStart = (event: TouchEvent) => { armDirectScrollInput(); touchY = event.touches[0]?.clientY ?? null; };
    const onTouchMove = (event: TouchEvent) => {
      armDirectScrollInput();
      const nextY = event.touches[0]?.clientY ?? null;
      if (touchY != null && nextY != null) {
        if (nextY > touchY + 2) noteUserDirection('up');
        else if (nextY < touchY - 2) noteUserDirection('down');
      }
      touchY = nextY;
    };
    const onTouchEnd = () => { touchY = null; };
    const onPointerDown = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const scrollbarGutter = Math.max(14, el.offsetWidth - el.clientWidth + 4);
      if (event.target === el && event.clientX >= rect.right - scrollbarGutter) {
        scrollbarDrag = true;
        armDirectScrollInput();
        lastScrollTop = el.scrollTop;
      }
    };
    const onPointerUp = () => {
      if (!scrollbarDrag) return;
      scrollbarDrag = false;
      scheduleGeometrySample();
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (!['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End'].includes(event.key)) return;
      armDirectScrollInput();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) noteUserDirection('up');
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) noteUserDirection('down');
    };
    el.addEventListener('scroll', onScrollerScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('keydown', onKey);
    rebindTailObserver();
    scheduleGeometrySample();
    detachScrollerRef.current = () => {
      el.removeEventListener('scroll', onScrollerScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKey);
      if (directScrollTimer != null) window.clearTimeout(directScrollTimer);
      tailObserverRef.current?.disconnect();
      tailObserverRef.current = null;
      if (scrollerElementRef.current === el) scrollerElementRef.current = null;
    };
  }, [cancelPrependRestoreForInput, cancelTailSettle, finishPrependGuard, noteUserDirection, rebindTailObserver, scheduleGeometrySample]);
  useEffect(() => () => {
    detachScrollerRef.current?.();
    tailObserverRef.current?.disconnect();
    cancelBottomSnap();
    cancelTailSettle();
    if (geometryFrameRef.current != null) window.cancelAnimationFrame(geometryFrameRef.current);
    geometryFrameRef.current = null;
    ++prependSettleTokenRef.current;
    if (prependSettleFrameRef.current != null) window.cancelAnimationFrame(prependSettleFrameRef.current);
    prependSettleFrameRef.current = null;
    prependTransactionRef.current = null;
    prependGuardRef.current = false;
    clearUserDirection();
  }, [cancelBottomSnap, cancelTailSettle, clearUserDirection]);

  useLayoutEffect(() => {
    appendCursorRef.current = {
      serverId: activeId,
      historyGeneration,
      tailId: messages.length ? messages[messages.length - 1].id : null,
      count: messages.length,
    };
    if (bottomFollowServerRef.current !== activeId) return;
    if (initialPinnedHydration) {
      initialSemanticIssuedRef.current = true;
      ownSendPendingRef.current = false;
      ownSendNeedsSemanticRef.current = false;
      scheduleBottomSnap('auto', true);
    } else if (ownExplicitAppend) {
      ownSendPendingRef.current = false;
      const needsSemantic = ownSendNeedsSemanticRef.current;
      ownSendNeedsSemanticRef.current = false;
      // followOutput владеет semantic scroll в data commit; здесь остаётся только конечная
      // проверка физического хвоста. Если send начался из истории, даём один sync fallback.
      if (needsSemantic && !prependGuardRef.current) {
        virtuosoRef.current?.scrollToIndex(chatTailIndexLocation('LAST'));
      }
      armTailSettle(true);
    }
  }, [activeId, historyGeneration, messages, armTailSettle, initialPinnedHydration, ownExplicitAppend, scheduleBottomSnap]);

  // смена сервера: сброс состояния виртуального списка (Virtuoso ремонтится по key={activeId})
  useLayoutEffect(() => {
    // firstItemIndex теперь DERIVED (сбрасывается engine.loadHistory: chatPrepended/Trimmed=0) — руками не трогаем.
    // на входе: если есть непрочитанные — сеем счётчик jump-кнопки и стартуем НЕ внизу (позиция у
    // дивайдера, см. initialTopMostItemIndex), иначе внизу
    const unreadHere = unreadServer > 0 ? messages.filter((m) => m.sid != null && m.sid > lastRead && !m.mine && !m.sys).length : 0;
    // История может приехать уже ПОСЛЕ activeId. Решение о pin принимаем по серверному unread,
    // а не по пока ещё пустому messages, иначе первый history batch ошибочно утащит чат вниз.
    const startPinned = unreadServer === 0;
    cancelBottomSnap();
    cancelTailSettle();
    ++prependSettleTokenRef.current;
    if (prependSettleFrameRef.current != null) window.cancelAnimationFrame(prependSettleFrameRef.current);
    prependSettleFrameRef.current = null;
    prependTransactionRef.current = null;
    prependGuardRef.current = false;
    setPrependGuardActive(false);
    if (geometryFrameRef.current != null) window.cancelAnimationFrame(geometryFrameRef.current);
    geometryFrameRef.current = null;
    clearUserDirection();
    ownSendPendingRef.current = false;
    ownSendNeedsSemanticRef.current = false;
    initialBottomPendingRef.current = startPinned;
    initialSemanticIssuedRef.current = false;
    initialGeometryPendingRef.current = true;
    virtuosoScrollingRef.current = false;
    smoothJumpPendingRef.current = false;
    bottomRearmBlockedRef.current = false;
    bottomFollowServerRef.current = activeId;
    setPill(unreadServer > 0 ? Math.max(unreadHere, unreadServer) : 0);
    setFollowIntent(startPinned);
    commitAtBottom(startPinned);
    setReplyTo(null);
    // сброс стейджинга вложений при смене сервера — не тащим прикреплённые файлы между чатами
    setStaged((s) => { s.forEach((it) => it.previewUrl && URL.revokeObjectURL(it.previewUrl)); return []; });
    setSendQueued(false);
    lastAckedRef.current = null; ++olderRequestSeq.current; loadingOlder.current = false; setOlderBusy(false);
    // не даём startReached стрельнуть догрузкой прямо на маунте (пока идёт scroll-to-bottom и оседание)
    olderReady.current = false;
    setDividerFade(false);
    const t = window.setTimeout(() => {
      olderReady.current = true;
      // A short first page can be non-scrollable. Virtuoso may have emitted startReached while
      // the mount gate was still closed and will not repeat it for the same start index.
      const scroller = scrollerElementRef.current;
      if (E.chatHasMore && scroller && scroller.scrollTop <= 1) void loadOlderRef.current?.();
    }, 700);
    // InitialTopMostItemIndex задаёт семантическую позицию, а один scrollToIndex страхует
    // первичное измерение footer. Дальше tail sentinel реагирует только на реальную потерю хвоста.
    if (startPinned && messages.length > 0) {
      initialSemanticIssuedRef.current = true;
      scheduleBottomSnap('auto', true);
    }
    return () => {
      initialBottomPendingRef.current = false;
      initialSemanticIssuedRef.current = false;
      bottomFollowIntentRef.current = false;
      smoothJumpPendingRef.current = false;
      bottomRearmBlockedRef.current = false;
      cancelBottomSnap();
      cancelTailSettle();
      clearTimeout(t);
    };
  }, [activeId, cancelBottomSnap, cancelTailSettle, clearUserDirection, commitAtBottom, scheduleBottomSnap, setFollowIntent]);

  useLayoutEffect(() => {
    const transaction = prependTransactionRef.current;
    if (!transaction) return;
    if (getEngine() !== E) {
      finishPrependGuard(transaction.requestSeq, false);
      return;
    }
    const decision = classifyChatPrependLifecycle(transaction, {
      serverId: activeId,
      historyGeneration,
      prepended: eng.chatPrepended,
    });
    if (decision === 'cancel') finishPrependGuard(transaction.requestSeq, false);
    else if (decision === 'settle') settlePrependAnchor(transaction.requestSeq);
  }, [E, activeId, eng.chatPrepended, finishPrependGuard, historyGeneration, settlePrependAnchor]);

  // focus/blur/visibility окна → пере-триггер эффекта прочтения (вернулся в окно внизу чата = прочитал)
  useEffect(() => {
    const onFocusChange = () => setFocusTick((t) => t + 1);
    window.addEventListener('focus', onFocusChange);
    window.addEventListener('blur', onFocusChange);
    document.addEventListener('visibilitychange', onFocusChange);
    return () => {
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
      document.removeEventListener('visibilitychange', onFocusChange);
    };
  }, []);

  // Только настоящий suffix-append влияет на pill/unread. Батч после reconnect учитывается целиком;
  // delete/prepend/status/edit не создают ложные сообщения и звуки.
  useEffect(() => {
    if (!isSuffixAppend) return;
    const incoming = appendedMessages.filter((m) => !m.mine && !m.sys);
    if (!incoming.length) return;
    if (!shouldFollowAppend) setPill((p) => p + incoming.length);
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    if ((!focused || !shouldFollowAppend) && activeId) bumpUnreadStore(activeId, incoming.length);
    // Меншены уже имеют свой notify-звук. Для reconnect-батча обычных сообщений — один tag,
    // а не пулемёт из N звуков.
    if (!document.hasFocus() && incoming.some((m) => !m.mention)) {
      const now = Date.now();
      if (now - lastTagAt.current > 900) { lastTagAt.current = now; playSound('tag'); }
    }
  }, [messages, activeId, bumpUnreadStore, isSuffixAppend, shouldFollowAppend]);
  // Сначала гасим только opacity — высота измеренной строки не меняется во время transition.
  // Физически убираем divider уже в закреплённом хвосте и повторно подтверждаем настоящий bottom.
  useEffect(() => {
    if (firstUnreadId == null) { setDividerFade(false); return; }
    setDividerFade(false);
  }, [activeId, firstUnreadId]);
  useEffect(() => {
    if (!atBottom && dividerFade) setDividerFade(false);
  }, [atBottom, dividerFade]);
  useEffect(() => {
    if (dividerFade || firstUnreadId == null || unreadServer > 0 || !atBottom
      || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const timer = window.setTimeout(() => setDividerFade(true), 4500);
    return () => window.clearTimeout(timer);
  }, [atBottom, dividerFade, firstUnreadId, focusTick, unreadServer]);
  useEffect(() => {
    if (!dividerFade || firstUnreadId == null || !atBottom) return;
    const boundaryId = firstUnreadId;
    const timer = window.setTimeout(() => {
      setUnreadBoundary((current) => current.serverId === activeId && current.id === boundaryId
        ? { serverId: activeId, id: null }
        : current);
      setDividerFade(false);
      if (bottomFollowIntentRef.current) scheduleBottomSnap('auto');
    }, 360);
    return () => window.clearTimeout(timer);
  }, [activeId, atBottom, dividerFade, firstUnreadId, scheduleBottomSnap]);
  // Внизу чата + окно В ФОКУСЕ/видимо → «прочитать всё» (реально увидел). Не в фокусе — НЕ читаем:
  // непрочитанное копится, пока не вернёшься в окно (focusTick пере-триггерит). Живые сообщения не имеют
  // серверного sid (узнаются лишь через refetch) → шлём all:true, сервер выставит last_read=MAX id.
  // Иначе прочитанное живое считалось бы непрочитанным на главной/др. устройстве. lastAckedRef — один
  // POST на последний месседж (не спамим на каждый ре-рендер).
  useEffect(() => {
    if (!atBottom || !bottomFollowIntentRef.current || !activeId) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return; // не в фокусе — не прочитано
    const scroller = scrollerElementRef.current;
    if (scroller && chatBottomDistance(scroller) > CHAT_BOTTOM_LEAVE_PX) return;
    const lastLocalId = messages.length ? messages[messages.length - 1].id : null;
    if (lastLocalId == null || lastAckedRef.current === lastLocalId) return; // этот последний месседж уже отмечен
    lastAckedRef.current = lastLocalId;
    let lastSid: number | undefined;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].sid != null) { lastSid = messages[i].sid!; break; } }
    markReadStore(activeId, lastSid ?? (useStore.getState().lastRead[activeId] || 0), true);
  }, [atBottom, messages, activeId, markReadStore, focusTick]);


  // догрузка более старых сообщений при скролле к верху (курсорная пагинация)
  const loadOlder = useCallback(async () => {
    if (!canStartChatPrepend(loadingOlder.current, prependGuardRef.current)
      || !olderReady.current || !E.chatHasMore) return;
    const cursor = E.chatOldestCursor;
    const reqId = activeId;
    if (cursor == null || !reqId) return;
    const historyGeneration = E.chatHistoryGeneration;
    const requestSeq = ++olderRequestSeq.current;
    loadingOlder.current = true; setOlderBusy(true);
    if (!beginPrependGuard(requestSeq, reqId, historyGeneration)) {
      releaseOlderRequest(requestSeq);
      return;
    }
    try {
      const h = await api.getMessages(reqId, cursor, 30);
      // за время запроса могли переключить сервер — не вклеиваем чужую страницу в чужой чат
      if (useStore.getState().active?.id !== reqId || getEngine() !== E) return;
      if (E.chatHistoryGeneration !== historyGeneration || E.chatOldestCursor !== cursor) return;
      // prependHistory растит messages И chatPrepended в ОДНОМ emit → firstItemIndex (derived) сдвигается
      // атомарно с данными, virtuoso держит позицию на прежнем сообщении (без прыжка). Отдельный
      // setFirstItemIndex больше не нужен (был вторым источником и давал рассинхрон/прыжок).
      const beforeState = E.getSnapshot();
      const beforeVirtual = {
        count: beforeState.messages.length,
        prepended: beforeState.chatPrepended,
        trimmed: beforeState.chatTrimmed,
        firstItemIndex: chatVirtualFirstItemIndex(
          VIRT_BASE_INDEX,
          beforeState.chatPrepended,
          beforeState.chatTrimmed,
        ),
      };
      if (!capturePrependAnchor(requestSeq, beforeState.chatPrepended + h.messages.length)) return;
      E.prependHistory(h.messages, h.hasMore);
      if (!h.messages.length) finishPrependGuard(requestSeq, false);
      else {
        const afterState = E.getSnapshot();
        const transition = classifyChatPrepend(beforeVirtual, {
          count: afterState.messages.length,
          prepended: afterState.chatPrepended,
          trimmed: afterState.chatTrimmed,
          firstItemIndex: chatVirtualFirstItemIndex(
            VIRT_BASE_INDEX,
            afterState.chatPrepended,
            afterState.chatTrimmed,
          ),
        }, 0);
        if (!transition.valid || !transition.anchorPreserved) {
          finishPrependGuard(requestSeq, prependTransactionRef.current?.restoreTail === true);
        }
      }
    } catch {
      if (prependTransactionRef.current?.requestSeq === requestSeq) {
        finishPrependGuard(requestSeq, false);
      }
    }
    finally {
      const transaction = prependTransactionRef.current;
      if (transaction?.requestSeq === requestSeq && !transaction.committed) {
        finishPrependGuard(requestSeq, false);
      } else if (!transaction || transaction.requestSeq !== requestSeq) {
        releaseOlderRequest(requestSeq);
      }
    }
  }, [E, activeId, beginPrependGuard, capturePrependAnchor, finishPrependGuard, releaseOlderRequest]);
  loadOlderRef.current = loadOlder;

  // --- reply (ответ на сообщение) ---
  const buildReplyRef = (m: ChatMessage): ReplyRef => {
    const imgUrl = m.img || m.files?.find((f) => f.kind === 'image')?.url;
    return {
      author: m.who || '', text: (m.text || '').slice(0, 160), uid: m.uid, sid: m.sid,
      img: !!imgUrl, hasFile: !!m.files?.some((f) => f.kind === 'file'),
      thumb: imgUrl ? resolveUploadUrl(imgUrl) : undefined,
    };
  };
  // текстовый сниппет цитаты, когда исходное сообщение без текста (только вложения)
  const replySnippet = (r: ReplyRef): string => r.text || (r.img && r.hasFile ? '🖼📎 Вложения' : r.img ? '🖼 Изображение' : r.hasFile ? '📎 Файл' : '');
  const startReply = useCallback((m: ChatMessage) => {
    setReplyTo(m);
    requestAnimationFrame(() => document.getElementById('msgIn')?.focus());
  }, []);
  // переход к оригиналу по клику на цитату (если он сейчас загружен) + короткая подсветка
  const jumpToReply = useCallback((r: ReplyRef) => {
    if (r.sid == null) { useStore.getState().toast('Оригинал ещё синхронизируется — секунду', 'warn'); return; }
    const idx = messages.findIndex((mm) => mm.sid === r.sid);
    // Оригинал вне загруженного окна — не молчим (был «мёртвый клик»): подсказываем прокрутить/догрузить.
    if (idx < 0) { useStore.getState().toast('Сообщение выше — прокрути вверх, чтобы догрузить', 'warn'); return; }
    detachBottomFollow();
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    setFlashId(messages[idx].id);
  }, [detachBottomFollow, messages]);
  useEffect(() => { if (flashId == null) return; const t = window.setTimeout(() => setFlashId(null), 1300); return () => clearTimeout(t); }, [flashId]);
  const reactTo = useCallback((target: { id: number; sid?: number | null }, emote: { id: string; name: string }) => {
    E.toggleMessageReaction(target, emote);
  }, [E]);
  async function runCommand(raw: string) {
    const active = useStore.getState().active;
    const [cmd] = raw.slice(1).split(/\s+/);
    const c = (cmd || '').toLowerCase();
    const canMod = !!active && (active.myRole === 'owner' || hasPerm(active.myPerms || 0, PERM.MANAGE_MESSAGES));
    if (c === 'help') {
      E.sysMsg('Команды: /clear — очистить чат (нужна модерация), /help — эта справка. Упоминание: @ник (или @all).');
    } else if (c === 'clear') {
      if (!active || !canMod) { toast('Нет прав на очистку чата', 'warn'); return; }
      try { await api.clearChat(active.id); E.clearMessages(me.displayName); } catch (e: any) { toast(e?.message || 'Ошибка', 'err'); }
    } else {
      E.sysMsg(`Неизвестная команда: /${c}. Напиши /help для списка.`);
    }
  }
  // Прикрепление вложений: пользователь ВЫБИРАЕТ файл(ы) → сразу появляются в панели превью
  // над инпутом (стейджинг), аплоад стартует в фоне, но сообщение НЕ уходит, пока не нажат
  // «Отправить». Картинки идут через существующий /api/upload (даунскейл в WebP + инлайн-показ),
  // остальные расширения — через /api/upload-file (форс-скачивание, без сжатия). До MAX_ATTACH штук.
  function stageFiles(files: File[], kind: 'image' | 'file') {
    const room = MAX_ATTACH - stagedRef.current.length;
    if (room <= 0) { toast(`Максимум ${MAX_ATTACH} вложений`, 'warn'); return; }
    if (files.length > room) toast(`Максимум ${MAX_ATTACH} вложений — добавлены первые ${room}`, 'warn');
    for (const f of files.slice(0, room)) {
      if (f.size > MAX_ATTACH_SIZE) { toast(`${f.name}: больше 10 МБ`, 'warn'); continue; }
      const key = stageSeq++;
      const previewUrl = kind === 'image' ? URL.createObjectURL(f) : undefined;
      setStaged((s) => [...s, { key, kind, name: f.name, size: f.size, previewUrl, status: 'uploading' }]);
      (async () => {
        try {
          let attachment: Attachment;
          if (kind === 'image') {
            const small = await downscaleImage(f);
            const { url, width, height } = await api.uploadImage(small);
            attachment = { url, name: small.name, size: small.size, mime: small.type, kind: 'image', width, height };
          } else {
            const { url, name, size } = await api.uploadFile(f);
            attachment = { url, name, size, mime: f.type, kind: 'file' };
          }
          setStaged((s) => s.map((it) => (it.key === key ? { ...it, status: 'ready', attachment } : it)));
        } catch (e: any) {
          setStaged((s) => s.map((it) => (it.key === key ? { ...it, status: 'error' } : it)));
          toast(e?.message || `Не удалось загрузить ${f.name}`, 'err');
        }
      })();
    }
  }
  function removeStaged(key: number) {
    setStaged((s) => {
      const it = s.find((x) => x.key === key);
      if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
      return s.filter((x) => x.key !== key);
    });
  }
  useEffect(() => () => { stagedRef.current.forEach((it) => it.previewUrl && URL.revokeObjectURL(it.previewUrl)); }, []);

  function send() {
    const t = text.trim();
    const pending = staged.some((s) => s.status === 'uploading');
    if (pending) {
      if (t || staged.length) setSendQueued(true); // отправится сама, см. эффект ниже
      return;
    }
    setSendQueued(false);
    const ready = staged.filter((s) => s.status === 'ready' && s.attachment).map((s) => s.attachment!);
    if (!t && !ready.length) return;
    if (t.startsWith('/')) { runCommand(t); setText(''); return; }
    // Ставим intent ДО синхронного optimistic push в engine: собственный append обязан дойти
    // до true bottom, даже если пользователь перед отправкой читал историю.
    bottomRearmBlockedRef.current = false;
    ownSendNeedsSemanticRef.current = !bottomFollowIntentRef.current || !atBottomRef.current;
    clearUserDirection();
    setFollowIntent(true);
    const prependTransaction = prependTransactionRef.current;
    if (prependTransaction) prependTransaction.restoreTail = true;
    ownSendPendingRef.current = true;
    smoothJumpPendingRef.current = false;
    const em: Record<string, string> = {};
    t.split(/\s+/).forEach((w) => { if (emoteMap.has(w)) em[w] = emoteMap.get(w)!; });
    E.sendChatWithEmotes(t, em, undefined, replyTo ? buildReplyRef(replyTo) : undefined, ready.length ? ready : undefined);
    staged.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
    setText(''); setReplyTo(null); setStaged([]);
    if (activeId) localStorage.removeItem(DRAFT_KEY + activeId); // отправлено — черновик снят
    // Реальный доскролл выполняет suffix-append layout effect уже после появления сообщения в data.
  }
  // очередь на отправку: как только последнее вложение долилось (успешно или с ошибкой — send()
  // сам отфильтрует неудачные), стреляем реальной отправкой без повторного нажатия юзером.
  useEffect(() => {
    if (!sendQueued) return;
    if (staged.some((s) => s.status === 'uploading')) return;
    send();
  }, [staged, sendQueued]);

  // slash-команды (только в начале строки, пока нет пробела)
  const slashMode = /^\/[a-zа-я]*$/i.test(text);
  const cmdQuery = slashMode ? text.slice(1).toLowerCase() : '';
  const cmdCands = slashMode ? COMMANDS.filter((c) => c.name.startsWith(cmdQuery)) : [];
  const mCands: { username: string; displayName: string; avatarColor: number; avatarUrl?: string; everyone?: boolean }[] = (() => {
    if (!mention || slashMode) return [];
    const q = mention.q.toLowerCase();
    const list = members
      .filter((x) => x.username !== me.username && (x.username.toLowerCase().includes(q) || x.displayName.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((x) => ({ username: x.username, displayName: x.displayName, avatarColor: x.avatarColor, avatarUrl: x.avatarUrl, everyone: false }));
    if (q === '' || ['все', 'all', 'everyone'].some((w) => w.startsWith(q))) list.unshift({ username: 'все', displayName: 'Все участники', avatarColor: 0, avatarUrl: undefined, everyone: true });
    return list.slice(0, 8);
  })();
  const acLen = slashMode ? cmdCands.length : mCands.length;
  const acOpen = acLen > 0;
  // при навигации стрелками держим выделенную строку в видимой части попапа (он скроллится)
  useEffect(() => {
    if (!acOpen) return;
    popRef.current?.querySelector<HTMLElement>('.mpop-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [mIdx, acOpen]);
  function detectMention(value: string, caret: number) {
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,32})$/);
    return m ? { q: m[1], start: caret - m[1].length - 1 } : null;
  }
  function insertMention(uname: string) {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.q.length);
    const inserted = before + '@' + uname + ' ';
    setText(inserted + after); setMention(null); setMIdx(0);
    focusEnd(inserted.length);
  }
  function insertCommand(name: string) {
    const inserted = '/' + name + ' ';
    setText(inserted); setMIdx(0);
    focusEnd(inserted.length);
  }
  function focusEnd(pos: number) {
    requestAnimationFrame(() => { const el = document.getElementById('msgIn') as HTMLInputElement | null; if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  }
  // тегаем по Нику (displayName), а не по логину; для @everyone — служебный токен 'все'
  const mentionToken = (x: { username: string; displayName: string; everyone?: boolean }) => (x.everyone ? x.username : x.displayName);
  function acceptAc(i: number) { if (slashMode) insertCommand(cmdCands[i].name); else insertMention(mentionToken(mCands[i])); }
  function onComposerKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMIdx((i) => (i + 1) % acLen); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMIdx((i) => (i - 1 + acLen) % acLen); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(Math.min(mIdx, acLen - 1)); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); setText((t) => (slashMode ? t + ' ' : t)); return; }
    }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); setReplyTo(null); return; }
    if (e.key === 'Enter') send();
  }

  const mentionNames = (() => { const s = new Set<string>(); for (const mm of members) { s.add(mm.username.toLowerCase()); s.add(mm.displayName.toLowerCase()); } ['все', 'all', 'everyone'].forEach((w) => s.add(w)); return s; })();
  const byName = new Map(members.map((mm) => [mm.displayName, mm] as const));
  const byUid = new Map(members.map((mm) => [mm.id, mm] as const)); // стабильный резолв автора реплая по user id (не по нику)

  // начало группы (Telegram-style): шапка/аватар только у первого сообщения серии одного автора.
  // Граница зависит только от соседних сообщений. Лимит по количеству делал оформление старых
  // строк зависимым от размера догруженной страницы и сдвигал их после короткого prepend.
  const groupStart = useMemo(() => {
    const map = new Map<number, boolean>();
    for (let i = 0; i < messages.length; i++) {
      const start = isGroupStart(messages[i], messages[i - 1]);
      map.set(messages[i].id, start);
    }
    return map;
  }, [messages]);

  // рендер одного сообщения (itemContent virtuoso). Чужие — слева с аватаром, свои — справа без.
  const renderMessage = (m: typeof messages[number]) => {
    // Патчноут — системное сообщение с фиксированной геометрией: без аватара, реакций,
    // reply/action-bar и прочих пользовательских affordance. Так поздний realtime-патчноут
    // не маскируется под сообщение участника и не создаёт лишних интерактивных состояний.
    if (m.kind === 'release' && m.release) {
      return <ReleasePatchCard release={m.release} ts={m.ts} />;
    }
    // Карточка достижения уровня (рейтинг-фича) — своя вёрстка, не обычный пузырь
    if (m.kind === 'levelup') {
      const lvAuthor = m.who ? byName.get(m.who) : undefined;
      return (
        <div className="virt-row">
          <div className="lvlup-card" data-chat-visual-anchor="">
            <span className="lvlup-badge">{m.level ?? '?'}</span>
            <Avatar name={m.who || ''} ci={m.color ?? 0} url={lvAuthor?.avatarUrl} size={30} />
            <div className="lvlup-txt"><b>{m.who}</b><span>{m.level}-й уровень! 🎉</span></div>
            <Icon name="trophy" />
          </div>
        </div>
      );
    }
    const cont = groupStart.get(m.id) === false; // продолжение группы того же автора
    const parts = m.sys ? null : renderRich(m.text, mentionNames);
    const emoCount = parts ? parts.filter((p) => typeof p === 'object' && 'emo' in p).length : 0;
    const hasLink = parts ? parts.some((p) => typeof p === 'object' && 'link' in p) : false;
    const youtubePreviews: YouTubeVideoRef[] = [];
    if (parts) {
      const seenVideoIds = new Set<string>();
      for (const part of parts) {
        if (typeof part === 'string' || !('link' in part)) continue;
        const video = parseYouTubeVideo(part.link);
        if (!video || seenVideoIds.has(video.videoId)) continue;
        seenVideoIds.add(video.videoId);
        youtubePreviews.push(video);
        if (youtubePreviews.length >= 4) break;
      }
    }
    const big = !!parts && !hasLink && emoCount >= 1 && emoCount <= 3 && parts.every((p) => typeof p !== 'string' || !p.trim());
    const author = m.who ? byName.get(m.who) : undefined;
    const aRoles = author?.roles || [];
    const nameColor = (author && roleColorOf(author)) || avColor(m.who || '', m.color);
    // цитата исходного сообщения (reply) — над автором, кликабельна если оригинал загружен
    let replyQuote: JSX.Element | null = null;
    if (m.reply) {
      const rAuthor = (m.reply.uid && byUid.get(m.reply.uid)) || byName.get(m.reply.author);
      const rColor = (rAuthor && roleColorOf(rAuthor)) || avColor(m.reply.author, rAuthor?.avatarColor ?? 0);
      const rep = m.reply;
      replyQuote = (
        <button className="reply-quote jumpable" onClick={() => jumpToReply(rep)}
          title={rep.author + ': ' + replySnippet(rep)}>
          <span className="rq-hook" style={{ borderColor: rColor }} />
          <Avatar name={rep.author} ci={rAuthor?.avatarColor ?? 0} url={rAuthor?.avatarUrl} size={16} />
          <span className="rq-author" style={{ color: rColor }}>{rep.author}</span>
          {rep.thumb ? <img className="rq-thumb" src={rep.thumb} alt="" loading="lazy" /> : null}
          <span className="rq-text">{replySnippet(rep)}</span>
        </button>
      );
    }
    // сообщения с вложениями визуально «тяжелее» простого текста — при плотной Telegram-группировке
    // (cont, 2px между сообщениями одного автора) несколько подряд идущих превью сливаются в кашу.
    // Добавляем чуть больше воздуха сверху именно таким продолжениям, не трогая обычный текст.
    const hasMedia = youtubePreviews.length > 0 || !!m.img || !!(m.files && m.files.length);
    const canReact = m.sid != null || !!m.mkey;
    const reactionTarget = { id: m.id, sid: m.sid };
    return (
      <div className={'virt-row' + (m.sys ? ' sys-row' : '') + (cont ? ' cont' : '') + (cont && hasMedia ? ' cont-media' : '')}>
        <div className={'msg' + (m.sys ? ' sys' : '') + (m.kind === 'stream-state' ? ' stream-state' : '') + (m.mine ? ' me' : '') + (m.mention ? ' mentioned' : '') + (m.id === flashId ? ' flash' : '') + (m.status === 'failed' ? ' failed' : '')}>
          {!m.sys ? <div className="msg-av">{!cont ? <Avatar name={m.who || ''} ci={m.color ?? 0} url={author?.avatarUrl} size={36} /> : null}</div> : null}
          <div className="msg-body">
            {replyQuote}
            {!m.sys && !cont ? <div className="who" style={{ color: nameColor }}>{m.who}{aRoles.length ? <span className="who-roles">{aRoles.map((r) => <span key={r.id} className="who-role" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>)}</span> : null}{m.ts ? <span className="mtime">{fmtTime(m.ts)}</span> : null}</div> : null}
            <div className="msg-main">
              <div className="msg-content" data-chat-visual-anchor="">
                {editing?.id === m.id ? (
                  <div className="msg-edit">
                    <input autoFocus value={editText} onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (m.sid != null && editText.trim()) E.editChat(m.sid, editText); setEditing(null); } else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }} />
                    <div className="msg-edit-hint">Enter — сохранить · Esc — отмена</div>
                  </div>
                ) : m.sys || m.text ? (
                  <div className={'tx' + (big ? ' big' : '')}>
                    {m.sys ? (m.kind === 'stream-state' ? <><Icon name="screen" sm /><span>{m.text}</span></> : m.text) : parts!.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : 'link' in p ? <ExternalLink key={i} className="msg-link" href={p.link} aria-label={`${p.label} — открыть во внешнем браузере`}>{p.label}</ExternalLink> : 'mention' in p ? <span key={i} className="mention-tag">{p.mention}</span> : <EmoteImg key={i} className="emo" id={p.emo} alt={p.name} title={p.name} />))}
                    {m.edited && !m.sys ? <span className="medit" title="Изменено">(изменено)</span> : null}
                  </div>
                ) : null}
                {youtubePreviews.length ? (
                  <div className="yt-previews">
                    {youtubePreviews.map((video) => <YouTubePreview key={video.videoId} video={video} />)}
                  </div>
                ) : null}
                {m.img ? <button className="msg-img-wrap" style={messageImageStyle()} onClick={() => setLightbox({ url: m.img!, name: m.img!.split('/').pop() || 'image', size: 0, mime: 'image/*', kind: 'image' })}><img className="msg-img" src={resolveUploadUrl(m.img)} alt="" loading="lazy" /></button> : null}
                {m.files && m.files.length ? <MessageAttachments files={m.files} onImageClick={setLightbox} /> : null}
                {m.status === 'failed' ? <div className="msg-failed"><Icon name="warn" sm />Не отправлено<button onClick={() => getEngine()?.retrySend(m.id)}>Повторить</button></div> : null}
                {(() => { const reacts = E.getReactions(m.sid, m.id); return reacts.length ? (
                  <div className="msg-reacts">
                    {reacts.map((r) => <button key={r.id} className={'react-pill' + (r.mine ? ' mine' : '')} title={r.name} onClick={() => canReact && reactTo(reactionTarget, { id: r.id, name: r.name })}><EmoteImg id={r.id} alt={r.name} /><b>{r.count}</b></button>)}
                    {canReact ? <button className="react-add" aria-label="Добавить реакцию" data-tip="Добавить реакцию" onClick={(e) => setReactTarget({ target: reactionTarget, anchor: e.currentTarget.getBoundingClientRect() })}><Icon name="react" sm /></button> : null}
                  </div>
                ) : null; })()}
              </div>
              {!m.sys && editing?.id !== m.id ? <>
                <button className="msg-more" aria-label="Действия с сообщением" aria-expanded={actionsFor === m.id} aria-controls={`msg-actions-${m.id}`} onClick={(e) => { e.stopPropagation(); setActionsFor((id) => id === m.id ? null : m.id); }}><Icon name="more" sm /></button>
                <div id={`msg-actions-${m.id}`} className={'msg-actions' + (actionsFor === m.id ? ' open' : '')} onMouseDown={(e) => e.preventDefault()}>
                  {canReact ? <button className="msg-act" aria-label="Добавить реакцию" data-tip="Реакция" onClick={(e) => { setReactTarget({ target: reactionTarget, anchor: e.currentTarget.getBoundingClientRect() }); setActionsFor(null); }}><Icon name="react" sm /></button> : null}
                  <button className="msg-act" aria-label="Ответить" data-tip="Ответить" onClick={() => { startReply(m); setActionsFor(null); }}><Icon name="reply" sm /></button>
                  {m.text ? <button className="msg-act" aria-label="Копировать текст" data-tip="Копировать текст" onClick={() => { navigator.clipboard?.writeText(m.text!).then(() => useStore.getState().toast('Скопировано', 'ok')).catch(() => {}); setActionsFor(null); }}><Icon name="copy" sm /></button> : null}
                  {m.mine && m.text && m.sid != null ? <button className="msg-act" aria-label="Изменить сообщение" data-tip="Изменить" onClick={() => { setEditing({ id: m.id, sid: m.sid! }); setEditText(m.text); setActionsFor(null); }}><Icon name="edit" sm /></button> : null}
                  {m.mine && m.sid != null ? <button className="msg-act danger" aria-label="Удалить сообщение" data-tip="Удалить" onClick={() => { setActionsFor(null); if (window.confirm('Удалить сообщение?')) E.deleteChat(m.sid!); }}><Icon name="delete" sm /></button> : null}
                </div>
              </> : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div id="chat">
      <div className="chat-feed">
        {messages.length === 0 ? (
          <div id="msgs"><div className="msgs-inner"><div id="chatEmpty"><span className="chat-empty-icon"><Icon name="chat" /></span><b>Начало общего чата</b><span>Здесь можно писать, отвечать, делиться файлами и реакциями.</span></div></div></div>
        ) : (
          <Virtuoso
            key={activeId}
            ref={virtuosoRef}
            scrollerRef={bindScroller}
            className="virt-msgs"
            data={messages}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={firstUnread >= 0
              ? { index: firstUnread, align: 'start' }
              : chatTailIndexLocation(Math.max(0, messages.length - 1))}
            alignToBottom
            startReached={loadOlder}
            // Важно передавать именно false, когда читается история: Virtuoso трактует саму
            // callback-функцию как включённый follow при уменьшении viewport (reply/keyboard).
            followOutput={nativeFollowOutputEnabled ? 'auto' : false}
            // Align Virtuoso's internal followOutput classifier with our hysteresis leave-zone.
            // Otherwise 33–64px became a dead zone: unread stayed suppressed while auto-follow
            // silently stopped because Virtuoso already considered the list detached.
            atBottomThreshold={CHAT_BOTTOM_LEAVE_PX}
            atBottomStateChange={onAtBottom}
            isScrolling={onVirtuosoScrolling}
            totalListHeightChanged={onTotalListHeightChanged}
            increaseViewportBy={{ top: 600, bottom: 400 }}
            computeItemKey={(_, m) => m.id}
            context={virtuosoContext}
            components={CHAT_VIRTUOSO_COMPONENTS}
            itemContent={(_, m) => {
              const dayTs = dayFirst.get(m.id);
              const dayDiv = dayTs != null ? <div className="msg-daydiv"><span>{fmtDay(dayTs)}</span></div> : null;
              if (m.id === firstUnreadId) return <>{dayDiv}<div className="msg-newwrap"><div className={'msg-newdiv' + (dividerFade ? ' faded' : '')}><span>Новые сообщения</span></div>{renderMessage(m)}</div></>;
              return dayDiv ? <>{dayDiv}{renderMessage(m)}</> : renderMessage(m);
            }}
          />
        )}
        {olderBusy ? <div className="chat-load-top"><span className="chat-load"><span className="spin" style={{ width: 14, height: 14, margin: 0 }} />Загрузка сообщений…</span></div> : null}
        {!atBottom ? <button id="scrollbtn" aria-label="Прокрутить вниз" data-tip="К последним" onClick={scrollToBottom}><Icon name="chevron" />{pill > 0 ? <span className="sb-badge">{pill > 99 ? '99+' : pill}</span> : null}</button> : null}
      </div>
      <div className="chat-bottom">
      {acOpen ? (
        <div className={'mention-pop' + (replyTo ? ' with-reply' : '')} role="listbox" ref={popRef}>
          <div className="mpop-h">{slashMode ? 'Команды' : 'Упомянуть'}</div>
          {slashMode
            ? cmdCands.map((c, i) => (
              <button key={c.name} className={'mpop-row' + (i === mIdx ? ' sel' : '')} onMouseDown={(e) => { e.preventDefault(); insertCommand(c.name); }} onMouseEnter={() => setMIdx(i)}>
                <span className="mpop-cmd">/{c.name}</span><span className="mpop-desc">{c.desc}</span>
              </button>))
            : mCands.map((x, i) => (
              <button key={x.username} className={'mpop-row' + (i === mIdx ? ' sel' : '')} onMouseDown={(e) => { e.preventDefault(); insertMention(mentionToken(x)); }} onMouseEnter={() => setMIdx(i)}>
                <span className="mpop-av" style={{ background: x.everyone ? 'var(--accent)' : (x.avatarUrl ? '#0000' : avColor(x.displayName, x.avatarColor)) }}>
                  {x.everyone ? '@' : x.avatarUrl ? <img className="avimg" src={resolveUploadUrl(x.avatarUrl)} alt="" /> : initial(x.displayName)}
                </span>
                <span className="mpop-nm">{x.displayName}</span>
                {!x.everyone && x.username.toLowerCase() !== x.displayName.toLowerCase() ? <span className="mpop-u">@{x.username}</span> : null}
              </button>))}
        </div>
      ) : null}
      {/* лейн печатающих зарезервирован всегда (min-height) — badge не наслаивается на последнее сообщение */}
      <div className="typing-ind" aria-live="polite">
        {eng.typing.length > 0 ? (
          <>
            <span className="tdots"><i /><i /><i /></span>
            {eng.typing.length === 1 ? `${eng.typing[0]} печатает…`
              : eng.typing.length === 2 ? `${eng.typing[0]} и ${eng.typing[1]} печатают…`
                : 'Несколько человек печатают…'}
          </>
        ) : null}
      </div>
      {updateReady ? (
        <div className="update-bar">
          <div className="ub-ic"><Icon name="refresh" /></div>
          <div className="ub-txt"><b>Вышло обновление приложения</b><span>Обнови страницу, чтобы продолжить — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd></span></div>
          <button className="ub-btn" onClick={() => location.reload()}><Icon name="refresh" sm />Обновить</button>
        </div>
      ) : null}
      {nativeUpdate ? (
        <div className="update-bar">
          <div className="ub-ic"><Icon name="refresh" /></div>
          <div className="ub-txt"><b>Доступна версия {nativeUpdate.version}</b><span>{updating ? 'Скачиваю и устанавливаю — приложение перезапустится…' : 'Обновить нативное приложение до свежей версии'}</span></div>
          <button className="ub-btn" disabled={updating} onClick={async () => { setUpdating(true); try { await applyNativeUpdate(); } catch (e: any) { setUpdating(false); toast('Не удалось обновить: ' + (e?.message || e), 'err'); } }}>
            {updating ? <span className="spin" /> : <Icon name="refresh" sm />}Установить
          </button>
        </div>
      ) : null}
      <div className="composer-shell">
      {replyTo ? (
        <div className="reply-bar">
          <Icon name="reply" sm />
          <span className="rb-to">Ответ <b style={{ color: (byName.get(replyTo.who || '') && roleColorOf(byName.get(replyTo.who || '')!)) || avColor(replyTo.who || '', replyTo.color) }}>{replyTo.who}</b></span>
          <span className="rb-text">{replySnippet(buildReplyRef(replyTo))}</span>
          <button className="rb-close" aria-label="Отменить ответ" data-tip="Отменить · Esc" onClick={() => setReplyTo(null)}><Icon name="close" sm /></button>
        </div>
      ) : null}
      {staged.length ? (
        <div className="attach-panel">
          {staged.map((s) => (
            <div key={s.key} className={'attach-chip' + (s.status === 'error' ? ' err' : '')}>
              {s.kind === 'image' ? <img className="attach-thumb" src={s.previewUrl} alt="" /> : <div className="attach-file-ic"><Icon name="file" /></div>}
              <div className="attach-meta">
                <span className="attach-name">{s.name}</span>
                <span className="attach-size">{s.status === 'error' ? 'Ошибка загрузки' : fmtSize(s.size)}</span>
              </div>
              {s.status === 'uploading' ? <span className="spin" /> : null}
              <button className="attach-remove" aria-label={`Убрать вложение ${s.name}`} data-tip="Убрать" onClick={() => removeStaged(s.key)}><Icon name="close" sm /></button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="chat-in">
        <button id="emoBtn" ref={emoBtnRef} className={'emo-toggle' + (pickAnchor !== undefined ? ' on' : '')} aria-label="Открыть 7TV эмоуты" aria-expanded={pickAnchor !== undefined} data-tip="7TV эмоуты"
          onClick={() => setPickAnchor((a) => (a === undefined ? emoBtnRef.current!.getBoundingClientRect() : undefined))}><Icon name="smile" /></button>
        <button className="emo-toggle" aria-label="Прикрепить картинку" data-tip="Прикрепить картинку (или Ctrl+V)" onClick={() => fileRef.current?.click()}><Icon name="image" /></button>
        <button className="emo-toggle" aria-label="Прикрепить файл" data-tip="Прикрепить файл" onClick={() => attachFileRef.current?.click()}><Icon name="attach" /></button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple style={{ display: 'none' }} onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) stageFiles(files, 'image'); e.target.value = ''; }} />
        <input ref={attachFileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) stageFiles(files, 'file'); e.target.value = ''; }} />
        <input id="msgIn" placeholder="Написать в #общий" aria-label="Сообщение в общий чат" maxLength={1000} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} name="chat-message" value={text}
          onPaste={(e) => {
            const items = e.clipboardData?.items; if (!items) return;
            const imgs: File[] = [];
            for (let i = 0; i < items.length; i++) { if (items[i].type.startsWith('image/')) { const f = items[i].getAsFile(); if (f) imgs.push(f); } }
            if (imgs.length) { e.preventDefault(); stageFiles(imgs, 'image'); }
          }}
          onChange={(e) => { const v = e.target.value; setText(v); if (v.trim()) E.sendTyping(); setMention(detectMention(v, e.target.selectionStart ?? v.length)); setMIdx(0); }} onKeyDown={onComposerKey} />
        <button id="sendBtn" className={(text.trim() || staged.some((s) => s.status !== 'error')) ? '' : 'empty'} aria-label={sendQueued ? 'Сообщение отправится после загрузки вложений' : 'Отправить сообщение'} data-tip={sendQueued ? 'Отправится, как только вложения загрузятся' : 'Отправить · Enter'} onClick={send}>
          {sendQueued ? <span className="spin" style={{ margin: 0, width: 14, height: 14 }} /> : <Icon name="send" />}
        </button>
      </div>
      </div>
      </div>
      {pickAnchor !== undefined ? <EmotePicker anchor={pickAnchor} onClose={() => setPickAnchor(undefined)}
        onPick={(e: Emote) => { setText((t) => t + (t && !t.endsWith(' ') ? ' ' : '') + e.name + ' '); }} /> : null}
      {reactTarget ? <EmotePicker anchor={reactTarget.anchor} onClose={() => setReactTarget(null)}
        onPick={(e: Emote) => { reactTo(reactTarget.target, e); setReactTarget(null); }} /> : null}
      {lightbox ? <ImageLightbox attachment={lightbox} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}

/* ---------- Stream stage ---------- */
function StreamTile({ streamKey, identity, isLocal, appName, appIcon }: { streamKey: string; identity: string; isLocal: boolean; appName?: string; appIcon?: string }) {
  const E = getEngine()!;
  const eng = useEngine();
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const emoteSize = useStore((s) => s.emoteSize);
  const vidRef = useRef<HTMLVideoElement>(null);
  const [floats, setFloats] = useState<{ id: number; emoteId: string; by: string; x: number; size?: string }[]>([]);
  const [stats, setStats] = useState('');
  const [statsOn, setStatsOn] = useState(true);
  const [wOpen, setWOpen] = useState(false); // тач: «кто смотрит» по тапу
  const [treeOpen, setTreeOpen] = useState(false);
  const [qualOpen, setQualOpen] = useState(false); // Д4: меню качества
  const [pickAnchor, setPickAnchor] = useState<DOMRect | null | undefined>(undefined);
  const sprayRef = useRef<HTMLButtonElement>(null);
  // контролы прячутся не только при уходе мыши с плитки (:hover в CSS), но и если мышь
  // осталась над плиткой, но не двигалась 5с — как в видеоплеерах. idle-класс перебивает :hover.
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const resetIdle = () => {
    setIdle(false);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 5000);
  };
  useEffect(() => () => { if (idleTimer.current) window.clearTimeout(idleTimer.current); }, []);
  const floatSeq = useRef(1);
  const name = members.find((m) => m.username === identity)?.displayName || identity;

  useEffect(() => {
    const track = E.getVideoTrack(streamKey); if (!track || !vidRef.current) return;
    const v = vidRef.current;
    (track as any).attach(v); v.muted = isLocal;
    const ready = () => v.classList.add('ready'); v.addEventListener('loadeddata', ready, { once: true });
    return () => { try { (track as any).detach(v); } catch { /**/ } };
  }, [streamKey, isLocal, E]);

  useEffect(() => E.onEmote((sid, emoteId, by, x, size) => {
    if (sid !== identity) return;
    const id = floatSeq.current++;
    setFloats((f) => [...f.slice(-23), { id, emoteId, by, x, size }]);
    setTimeout(() => setFloats((f) => f.filter((e) => e.id !== id)), 2800);
  }), [identity, E]);

  useEffect(() => {
    if (isLocal) {
      const t = setInterval(async () => { const s = await E.getScreenStats(); setStats(s || ''); }, 1500);
      return () => clearInterval(t);
    }
    // Зритель (лист/ретранслятор дерева, Э2.1): разрешение+fps+dropped из RTP-статистики
    // входящего трека, позиция в дереве — из tree-info с сервера (см. treeVideo.ts).
    const t = setInterval(async () => {
      const rtp = await E.getWatchRtpStats(identity);
      const tree = E.getTreeInfo(identity);
      if (!rtp && !tree) { setStats(''); return; }
      const parts: string[] = [];
      if (rtp) parts.push(`${rtp.width}×${rtp.height} · ${rtp.fps.toFixed(0)} fps · дропы ${rtp.framesDropped}`);
      // Оценка задержки: сеть = сумма rtt/2 по цепочке хопов до вещателя (rtt линков
      // сервер собирает в топологию из RTCP-отчётов родителей) + локальный джиттер-буфер
      // декодера. Энкод/декод не учтены — это нижняя оценка, не точное e2e.
      const topo = E.getStreamTopology(identity);
      let netMs = 0;
      if (topo?.you) {
        let cur = topo.nodes.find((n) => n.id === topo.you);
        let hops = 0;
        while (cur && !cur.broadcaster && hops++ < 8) {
          netMs += (cur.rtt || 0) / 2;
          cur = cur.parentId ? topo.nodes.find((n) => n.id === cur!.parentId) : undefined;
        }
      }
      const latency = Math.round(netMs + (rtp?.jitterBufferMs || 0));
      if (latency > 0) parts.push(`задержка ≈${latency} мс (сеть ${Math.round(netMs)} + буфер ${Math.round(rtp?.jitterBufferMs || 0)})`);
      if (tree) parts.push(`дерево: глубина ${tree.myDepth}${tree.children ? `, ретранслируешь на ${tree.children}` : ''}`);
      setStats(parts.join('<br>'));
    }, 2000);
    return () => clearInterval(t);
  }, [isLocal, identity, E]);

  const watchers = eng.watchers[identity] || [];
  const [svol, setSvol] = useState(() => Math.round(E.streamVolOf(identity) * 100));
  const wrapRef = useRef<HTMLDivElement>(null);
  const [prevVol, setPrevVol] = useState(100);
  const setVol = (v: number) => { setSvol(v); E.setStreamVol(identity, v / 100); };
  const toggleMute = () => { if (svol > 0) { setPrevVol(svol); setVol(0); } else setVol(prevVol || 100); };

  // Звук p2p-трансляции (Э5) идёт прямо в тег <video> (единый MediaStream от
  // transport'а), отдельного <audio>-элемента для него, в отличие от LiveKit-пути
  // (screenAudioEls), нет — громкость/мут крутим на самом видео-элементе.
  useEffect(() => {
    const v = vidRef.current; if (!v) return;
    v.muted = isLocal || eng.deafened || svol === 0;
    v.volume = svol / 100;
  }, [svol, isLocal, eng.deafened, streamKey]);
  const toggleFs = () => { document.fullscreenElement ? document.exitFullscreen() : wrapRef.current?.requestFullscreen().catch(() => {}); };
  const togglePip = () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); else vidRef.current?.requestPictureInPicture().catch(() => {}); };

  return (
    <div className={'vwrap' + (idle ? ' idle' : '')} ref={wrapRef} onDoubleClick={toggleFs} onMouseMove={resetIdle} onMouseEnter={resetIdle}>
      <video ref={vidRef} autoPlay playsInline />
      <div className="lbl" title={appName ? `${name} · ${appName}` : name}>
        {appIcon
          ? <img src={`data:image/png;base64,${appIcon}`} width={16} height={16} style={{ borderRadius: 3, verticalAlign: 'text-bottom', marginRight: 4, objectFit: 'contain' }} alt="" />
          : '🖥 '}
        {name}{isLocal ? ' (ты)' : ''}
      </div>
      {!isLocal ? <StreamSourceBadge identity={identity} /> : null}
      <div className="emolayer">
        {floats.map((f) => (
          <div className={'floatEmo em-' + (f.size || 'md')} key={f.id} style={{ left: Math.max(2, Math.min(92, f.x * 100)) + '%' }}>
            <EmoteImg id={f.emoteId} /><div className="ftag">{f.by}</div>
          </div>
        ))}
      </div>
      <div className={'watchers' + (wOpen ? ' open' : '')} role="button" tabIndex={0} aria-label={`Смотрят трансляцию: ${watchers.length}`} aria-expanded={wOpen} onClick={(e) => { e.stopPropagation(); setWOpen((v) => !v); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setWOpen((v) => !v); } }}>
        {watchers.slice(0, 4).map((w, i) => <div className="wa" key={i} style={{ background: w.avatarUrl ? '#0000' : avColor(w.name, w.color) }} title={w.name}>{w.avatarUrl ? <img className="avimg" src={resolveUploadUrl(w.avatarUrl)} alt="" /> : initial(w.name)}</div>)}
        <div className="wc"><Icon name="eye" sm />{watchers.length}</div>
        {watchers.length ? (
          <div className="wtip">
            <div className="wtip-h">Смотрят · {watchers.length}</div>
            {watchers.map((w, i) => <div className="wtip-row" key={i}><span className="wtip-av" style={{ background: w.avatarUrl ? '#0000' : avColor(w.name, w.color) }}>{w.avatarUrl ? <img className="avimg" src={resolveUploadUrl(w.avatarUrl)} alt="" /> : initial(w.name)}</span>{w.name}</div>)}
          </div>
        ) : null}
      </div>
      <button className="spray" ref={sprayRef} aria-label="Кинуть эмоут в трансляцию" data-tip="Кинуть эмоут — увидят все зрители"
        onClick={(e) => { e.stopPropagation(); setPickAnchor((a) => (a === undefined ? sprayRef.current!.getBoundingClientRect() : undefined)); }}><Icon name="smile" sm /></button>
      <div className="vbar" role="toolbar" aria-label="Управление трансляцией" onDoubleClick={(e) => e.stopPropagation()}>
        {!isLocal ? (
          <>
            <button className="vb-btn" aria-label={svol === 0 ? 'Включить звук трансляции' : 'Заглушить трансляцию'} data-tip={svol === 0 ? 'Включить звук' : 'Заглушить'} onClick={toggleMute}><Icon name={svol === 0 ? 'volume-off' : 'speaker'} sm /></button>
            <input className="vb-vol" aria-label="Громкость трансляции" type="range" min={0} max={100} value={svol} onChange={(e) => setVol(+e.target.value)} />
            <span className="vb-pct">{svol}%</span>
          </>
        ) : <span className="vb-lbl">🖥 Твоя трансляция</span>}
        <div className="vb-sp" />
        {!isLocal ? <button className={'vb-btn' + (qualOpen ? ' active' : '')} aria-label="Выбрать качество трансляции" aria-expanded={qualOpen} data-tip="Качество" onClick={() => setQualOpen((v) => !v)}><Icon name="gear" sm /></button> : null}
        {!isLocal ? <button className={'vb-btn' + (treeOpen ? ' active' : '')} aria-label="Открыть дерево трансляции" aria-expanded={treeOpen} data-tip="Дерево трансляции — выбрать пира" onClick={() => setTreeOpen((v) => !v)}><Icon name="users" sm /></button> : null}
        <button className="vb-btn" aria-label="Открыть картинку в картинке" data-tip="Картинка-в-картинке" onClick={togglePip}><Icon name="pip" sm /></button>
        <button className="vb-btn" aria-label="Открыть на весь экран" data-tip="Во весь экран" onClick={toggleFs}><Icon name="fullscreen" sm /></button>
        {!isLocal ? <button className="vb-btn danger" aria-label="Закрыть трансляцию" data-tip="Закрыть трансляцию" onClick={() => E.closeWatch(identity)}><Icon name="close" sm /></button> : null}
      </div>
      {!isLocal && treeOpen ? <TreePeerPanel identity={identity} onClose={() => setTreeOpen(false)} /> : null}
      {!isLocal && qualOpen ? <QualityMenu identity={identity} onClose={() => setQualOpen(false)} /> : null}
      <div className="statsbox">
        <button className="stats-toggle" aria-label={statsOn ? 'Скрыть статистику трансляции' : 'Показать статистику трансляции'} aria-pressed={statsOn} data-tip={statsOn ? 'Скрыть статистику' : 'Показать статистику'} onClick={(e) => { e.stopPropagation(); setStatsOn((v) => !v); }}><Icon name="info" sm /></button>
        {statsOn && stats ? <div className="stats" dangerouslySetInnerHTML={{ __html: stats }} /> : null}
      </div>
      {pickAnchor !== undefined ? <EmotePicker anchor={pickAnchor} sizePicker onClose={() => setPickAnchor(undefined)} onPick={(em) => E.fling(identity, em, emoteSize)} /> : null}
    </div>
  );
}

/* Э8: бейдж «откуда идёт поток» + панель дерева с ручным выбором пира. Топология
   приходит из tree-topology (браузер — по ws; натив — из Rust через IPC, см. treeVideo). */
function StreamSourceBadge({ identity }: { identity: string }) {
  useEngine(); // ре-рендер при смене топологии (engine.onTopology -> emit)
  const E = getEngine()!;
  const members = useStore((s) => s.members);
  const topo = E.getStreamTopology(identity);
  if (!topo || !topo.you) return null;
  const you = topo.nodes.find((n) => n.id === topo.you);
  if (!you) return null;
  const parent = you.parentId ? topo.nodes.find((n) => n.id === you.parentId) : null;
  const label = !parent ? 'подключение…' : parent.broadcaster ? 'напрямую от вещателя' : (parent.virtual || parent.server) ? 'через сервер' : (members.find((m) => m.username === parent.identity)?.displayName || parent.identity);
  return (
    <div className="srcbadge" style={{ position: 'absolute', top: 8, right: 8, display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, fontSize: 11, background: 'rgba(0,0,0,.55)', color: '#fff', pointerEvents: 'none' }}>
      <Icon name="link" sm />источник: {label}{you.children ? ` · ретрансляция ×${you.children}` : ''}
    </div>
  );
}

function TreePeerPanel({ identity, onClose }: { identity: string; onClose: () => void }) {
  useEngine();
  const E = getEngine()!;
  const members = useStore((s) => s.members);
  const topo = E.getStreamTopology(identity);
  const nameOf = (n: { broadcaster: boolean; virtual?: boolean; identity: string }) => n.broadcaster ? '📡 вещатель' : n.virtual ? '🖥 Сервер' : (members.find((m) => m.username === n.identity)?.displayName || n.identity);
  const youNode = topo?.nodes.find((n) => n.id === topo.you);
  // Потомки твоего узла: репарент под собственного потомка = цикл (сервер отклонит) — «взять» на них не даём.
  const youDesc = (() => {
    const set = new Set<string>();
    if (!topo) return set;
    const byParent = new Map<string, string[]>();
    topo.nodes.forEach((n) => { if (n.parentId) { const a = byParent.get(n.parentId) || []; a.push(n.id); byParent.set(n.parentId, a); } });
    const stack = [topo.you];
    while (stack.length) { const cur = stack.pop()!; for (const c of byParent.get(cur) || []) if (!set.has(c)) { set.add(c); stack.push(c); } }
    return set;
  })();
  return (
    <div className="treepanel" role="dialog" aria-label="Дерево трансляции" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 62, width: 'min(280px, calc(100% - 24px))', maxHeight: 320, overflow: 'auto', background: 'rgba(20,22,28,.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12, padding: 10, zIndex: 7, color: '#fff', fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <b>Дерево трансляции</b>
        <button className="vb-btn" aria-label="Закрыть дерево трансляции" onClick={onClose}><Icon name="close" sm /></button>
      </div>
      {!topo || !topo.nodes.length ? <div style={{ opacity: .6 }}>Нет данных о дереве</div> : <>
        {(() => {
          // Кнопка «взять» есть только у узлов со свободным слотом. Когда их нет вовсе, панель
          // раньше молча показывала «0/0» — юзер видел список и не понимал, почему подключиться
          // к ретранслятору нельзя. Объясняем причину: браузеры — всегда листья (ёмкость 0 по
          // инварианту), а нативный зритель получает слоты только при достаточном upload
          // (tree.js::dynamicCapacity: нужен битрейт стрима × 1.3 на каждого ребёнка).
          const anyPickable = topo.nodes.some((n) => n.id !== topo.you && n.id !== youNode?.parentId && !youDesc.has(n.id) && n.children < n.capacity);
          if (anyPickable) return null;
          const others = topo.nodes.filter((n) => n.id !== topo.you && !n.broadcaster && !n.virtual);
          const allBrowsers = others.length > 0 && others.every((n) => !n.native);
          return (
            <div style={{ opacity: .6, lineHeight: 1.4, marginBottom: 6, fontSize: 11 }}>
              {others.length === 0
                ? 'Других зрителей нет — ретранслировать некому.'
                : allBrowsers
                  ? 'Зрители в браузере не ретранслируют (всегда листья дерева).'
                  : 'Ни у кого нет свободных слотов: для ретрансляции нужен upload ≥ битрейта стрима.'}
            </div>
          );
        })()}
        {[...topo.nodes].sort((a, b) => a.depth - b.depth).map((n) => {
          const isYou = n.id === topo.you;
          const isParent = youNode?.parentId === n.id;
          const pickable = !isYou && !isParent && !youDesc.has(n.id) && n.children < n.capacity;
          return (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', paddingLeft: n.depth * 10, borderBottom: '1px solid rgba(255,255,255,.05)' }}>
              <span style={{ flex: 1, fontWeight: isYou ? 700 : 400, color: isParent ? '#8fd3ff' : '#fff' }}>
                {nameOf(n)}{isYou ? ' (ты)' : ''}{isParent ? ' · источник' : ''}
              </span>
              <span style={{ opacity: .6, fontSize: 11 }}>гл.{n.depth} · {n.children}/{n.capacity}{n.native ? '' : ' 🌐'}</span>
              {pickable ? <button className="primary" style={{ margin: 0, padding: '2px 8px', fontSize: 11 }} onClick={() => E.requestReparent(identity, n.id)}>взять</button> : <span style={{ width: 44 }} />}
            </div>
          );
        })}
        <button className="ghost" style={{ margin: '8px 0 0', width: '100%' }} onClick={() => E.requestReparent(identity, null)}>Авто: лучший пир</button>
        {/* Э9: ручной фолбэк — сервер поднимет виртуальный relay (если агент запущен) и
            пересадит нас под него; выбор запинен от авто-дренажа, пока не уйдём сами. */}
        {!youNode || !topo.nodes.find((n) => n.id === youNode.parentId)?.virtual
          ? <button className="ghost" style={{ margin: '6px 0 0', width: '100%' }} onClick={() => E.requestReparent(identity, 'vrelay')}>🖥 Через сервер</button>
          : null}
      </>}
    </div>
  );
}

// Д4: меню качества у зрителя (Авто / Source / 1080 / 720 / 480 / 360). Активно ТОЛЬКО когда
// смотрим через сервер (родитель = vrelay/рендишн-корень, topology virtual|server). Под живым
// пиром — задизейблено с подсказкой «качество наследуется от родителя». Пункты — из реальной
// лестницы stream-live.renditions (не хардкод). Ключ — базовый identity (Д3-инвариант).
function QualityMenu({ identity, onClose }: { identity: string; onClose: () => void }) {
  useEngine(); // ре-рендер при смене топологии/качества
  const E = getEngine()!;
  const viaServer = E.isStreamViaServer(identity);
  const mode = E.getStreamQualityMode(identity);
  const renditions = E.getStreamRenditions(identity) || ['source'];
  // Д-фикс: сервер без транскода (VRELAY_MAX_TRANSCODES=0 / нет агента) объявляет ТОЛЬКО ['source'].
  // Пункт «Авто» тогда бессмыслен (двигать некуда) — прячем его и показываем внятную подсказку.
  const onlySource = renditions.length === 1 && renditions[0] === 'source';
  const label: Record<string, string> = { source: 'Исходное (source)', '1080': '1080p', '720': '720p', '480': '480p', '360': '360p' };
  const items = onlySource ? ['source'] : ['auto', ...renditions];
  return (
    <div className="qualpanel" role="dialog" aria-label="Качество трансляции" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 62, width: 'min(220px, calc(100% - 24px))', background: 'rgba(20,22,28,.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12, padding: 10, zIndex: 7, color: '#fff', fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <b>Качество</b>
        <button className="vb-btn" aria-label="Закрыть выбор качества" onClick={onClose}><Icon name="close" sm /></button>
      </div>
      {!viaServer ? (
        <div style={{ opacity: .6, lineHeight: 1.4 }}>Качество наследуется от родителя — выбор доступен только при просмотре через сервер.</div>
      ) : onlySource ? (
        <div style={{ opacity: .6, lineHeight: 1.4 }}>Транскод на сервере отключён — доступно только исходное качество.</div>
      ) : items.map((it) => {
        const active = mode === it;
        return (
          <button key={it} className="ghost" disabled={active}
            style={{ margin: '2px 0', width: '100%', textAlign: 'left', fontWeight: active ? 700 : 400, color: active ? '#8fd3ff' : '#fff', opacity: 1 }}
            onClick={() => { E.setStreamQuality(identity, it); onClose(); }}>
            {it === 'auto' ? 'Авто' : (label[it] || `${it}p`)}{active ? ' ·' : ''}
          </button>
        );
      })}
    </div>
  );
}

function Stage({ minimized, setMin }: { minimized: boolean; setMin: (v: boolean) => void }) {
  const eng = useEngine();
  const streams = eng.streams;
  // Грид: 1 плитка — на всю; 2 — 1×2; 3-4 — 2×2; 5+ (свой стрим + 4 чужих) — 2×N с автопереносом.
  const gridCls = streams.length >= 5 ? 'n4' : streams.length >= 3 ? 'n' + streams.length : streams.length === 2 ? 'n2' : '';
  const grid = (
    <div id="grid" className={gridCls} style={{ display: streams.length ? 'grid' : 'none' }}>
      {streams.map((s) => <StreamTile key={s.key} streamKey={s.key} identity={s.identity} isLocal={s.isLocal} appName={s.appName} appIcon={s.appIcon} />)}
    </div>
  );
  if (minimized) {
    return <div id="mini" className="show"><div className="mini-h"><span>Трансляция</span><button onClick={() => setMin(false)}>Развернуть ⌃</button></div>{grid}</div>;
  }
  return (
    <div id="stage" style={{ display: streams.length ? 'flex' : 'none' }}>
      {grid}
      <button id="stageMin" className="tip-b" data-tip="Свернуть в мини-окно" onClick={() => setMin(true)}>Свернуть ⌄</button>
    </div>
  );
}

/* ---------- Channels sidebar (left) ---------- */
function Channels() {
  const active = useStore((s) => s.active)!;
  const setModal = useStore((s) => s.setModal);
  return (
    <div id="channels">
      <header className="ch-header">
        <button className="ch-server-main" aria-label={`Открыть меню сервера ${active.name}`} onClick={() => setModal('srvmenu')}>
          <span className="ch-server-mark" style={{ background: active.iconUrl ? '#0000' : avColor(active.name, active.iconColor) }}>
            {active.iconUrl ? <img className="avimg" src={resolveUploadUrl(active.iconUrl)} alt="" /> : initial(active.name)}
          </span>
          <span className="ch-server-copy"><span className="chn">{active.name}</span><span className="ch-server-meta">{active.memberCount} участников</span></span>
          <span className="ch-menu" aria-hidden="true"><Icon name="chevron" sm /></span>
        </button>
      </header>
      <div className="ch-body"><VoiceChannels /></div>
      <StreamerWidget />
      <VoiceDock variant="inline" />
      {/* Компактный ряд голосовых контролов. Профиль уже доступен в глобальном rail. */}
      <div className="user-panel">
        <VoiceControls up />
      </div>
    </div>
  );
}

function useResizable(key: string, def: number, min: number, max: number, edge: 'right' | 'left') {
  const [w, setW] = useState<number>(() => {
    const s = Number(localStorage.getItem(key));
    return s >= min && s <= max ? s : def;
  });
  useEffect(() => { localStorage.setItem(key, String(w)); }, [key, w]);
  const onDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const sx = e.clientX, sw = w;
    const move = (ev: MouseEvent) => {
      const d = edge === 'right' ? ev.clientX - sx : sx - ev.clientX;
      setW(Math.min(max, Math.max(min, sw + d)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.classList.add('resizing');
  };
  return { w, onDown };
}

export function ServerView() {
  const eng = useEngine();
  const active = useStore((s) => s.active)!;
  const setModal = useStore((s) => s.setModal);
  const entryTab = useStore((s) => s.serverEntryTab);
  const [minimized, setMin] = useState(false);
  const [mtab, setMtab] = useState<'channels' | 'main' | 'members'>(() => entryTab);
  const hasStreams = eng.streams.length > 0;
  const split = hasStreams && !minimized;
  useEffect(() => { if (!hasStreams) setMin(false); }, [hasStreams]);
  // CTA «Смотреть» с главной сначала подключает транспорт, затем добавляет stream в snapshot.
  // На телефоне сразу показываем сцену, а не оставляем пользователя на вкладке «Голос».
  useEffect(() => { if (hasStreams) setMtab('main'); }, [hasStreams]);
  const chan = useResizable('w:channels', 292, 264, 360, 'right');
  const mem = useResizable('w:members', 304, 264, 360, 'left');
  const chatW = useResizable('w:chat', 340, 260, 640, 'left');
  const [membersOpen, setMembersOpen] = useState(() => localStorage.getItem('membersOpen') !== '0');
  useEffect(() => { localStorage.setItem('membersOpen', membersOpen ? '1' : '0'); }, [membersOpen]);
  const [supportOpen, setSupportOpen] = useState(false);
  const [mediumWorkspace, setMediumWorkspace] = useState(() => window.innerWidth > 900 && window.innerWidth <= 1240);
  useEffect(() => {
    const mq = window.matchMedia('(min-width:901px) and (max-width:1240px)');
    const sync = () => { setMediumWorkspace(mq.matches); if (!mq.matches) setSupportOpen(false); };
    sync(); mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const [channelsOpen, setChannelsOpen] = useState(() => localStorage.getItem('channelsOpen') !== '0');
  useEffect(() => { localStorage.setItem('channelsOpen', channelsOpen ? '1' : '0'); }, [channelsOpen]);
  const [showChat, setShowChat] = useState(false);
  useEffect(() => { if (!split) setShowChat(false); }, [split]);
  const [singlePaneWorkspace, setSinglePaneWorkspace] = useState(() => window.matchMedia('(max-width:900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width:900px)');
    const sync = () => setSinglePaneWorkspace(mq.matches);
    sync(); mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const chatVisible = (!singlePaneWorkspace || mtab === 'main') && (!split || showChat);
  useEffect(() => {
    sendActiveChat(chatVisible ? active.id : null);
    return () => sendActiveChat(null);
  }, [active.id, chatVisible]);
  // В split-режиме stage обязан сохранить рабочую ширину: правая панель чата и участники
  // взаимоисключаются. Иначе сохранённые пользователем ширины могут полностью зажать видео.
  const toggleSplitChat = () => setShowChat((open) => { const next = !open; if (next) { setMembersOpen(false); setSupportOpen(false); } return next; });
  const toggleMembers = () => {
    if (mediumWorkspace) { setSupportOpen((open) => { const next = !open; if (next) setShowChat(false); return next; }); return; }
    setMembersOpen((open) => { const next = !open; if (next) setShowChat(false); return next; });
  };
  const membersVisible = mediumWorkspace ? supportOpen : membersOpen;
  // трансляция открылась → сразу прячем участников (место под видео); закрылась → возвращаем, если прятали сами
  const prevSplit = useRef(false);
  const autoHidMembers = useRef(false);
  useEffect(() => {
    if (split === prevSplit.current) return;
    if (split) {
      setSupportOpen(false);
      if (membersOpen) { autoHidMembers.current = true; setMembersOpen(false); }
    }
    else if (autoHidMembers.current) { autoHidMembers.current = false; setMembersOpen(true); }
    prevSplit.current = split;
  }, [split, membersOpen]);

  return (
    <>
      <section id="server" className={'on' + (mtab !== 'main' ? ' tab-' + mtab : '') + (channelsOpen ? '' : ' ch-collapsed') + (membersOpen ? '' : ' mem-collapsed') + (supportOpen ? ' support-open' : '')} style={{ '--ch-w': (channelsOpen ? chan.w : 0) + 'px', '--ch-open': chan.w + 'px', '--mem-w': (membersOpen ? mem.w : 0) + 'px', '--mem-open': mem.w + 'px' } as CSSProperties}>
        <Channels />
        <div id="main">
          <div className="srv-header">
            <button className={'hbtn pane-toggle channels-toggle' + (channelsOpen ? ' on' : '')} aria-label={channelsOpen ? 'Скрыть каналы' : 'Показать каналы'} aria-pressed={channelsOpen} data-tip={channelsOpen ? 'Скрыть каналы' : 'Показать каналы'} onClick={() => setChannelsOpen((open) => !open)}><Icon name="menu" sm /></button>
            <div className="hn"><span className="channel-mark"><Icon name="hash" sm /></span><span className="channel-copy"><b>общий</b><small>{active.description || 'Общий чат сервера'}</small></span></div>
            <div className="srv-actions">
              {split ? <button className={'hbtn' + (showChat ? ' on' : '')} aria-label={showChat ? 'Скрыть чат' : 'Показать чат'} aria-pressed={showChat} data-tip={showChat ? 'Скрыть чат' : 'Показать чат'} onClick={toggleSplitChat}><Icon name="chat" sm /></button> : null}
              <button className={'hbtn mob-hide' + (membersVisible ? ' on' : '')} aria-label={membersVisible ? 'Скрыть участников' : 'Показать участников'} aria-pressed={membersVisible} data-tip={membersVisible ? 'Скрыть участников' : 'Показать участников'} onClick={toggleMembers}><Icon name="users" sm /></button>
              <button className="hbtn" aria-label="Пригласить на сервер" data-tip="Пригласить" onClick={() => setModal('invite')}><Icon name="link" sm /></button>
              <button className="hbtn mob-only" aria-label="Открыть настройки" data-tip="Настройки" onClick={() => setModal('settings')}><Icon name="gear" sm /></button>
            </div>
          </div>
          <div id="content" className={(split ? 'split' : '') + (split && showChat ? ' show-chat' : '')} style={{ '--chat-w': chatW.w + 'px' } as CSSProperties}>
            <Stage minimized={minimized} setMin={setMin} />
            {split && showChat ? <div className="rz rz-chat" onMouseDown={chatW.onDown} title="Потяни — ширина чата" /> : null}
            <Chat />
            {split ? <button className="mob-chat-toggle" onClick={toggleSplitChat}><Icon name={showChat ? 'screen' : 'chat'} sm />{showChat ? 'К трансляции' : 'Открыть чат'}</button> : null}
          </div>
        </div>
        <Members />
        <div className="rz rz-ch" onMouseDown={chan.onDown} title="Потяни, чтобы изменить ширину" />
        {membersOpen ? <div className="rz rz-mem" onMouseDown={mem.onDown} title="Потяни, чтобы изменить ширину" /> : null}
      </section>
      <nav id="mtabs" aria-label="Разделы сервера">
        <button className={mtab === 'channels' ? 'active' : ''} aria-label="Голосовые каналы" aria-current={mtab === 'channels' ? 'page' : undefined} onClick={() => setMtab('channels')}><Icon name="speaker" />Каналы</button>
        <button className={mtab === 'main' ? 'active' : ''} aria-label={hasStreams ? 'Трансляция и чат' : 'Чат'} aria-current={mtab === 'main' ? 'page' : undefined} onClick={() => setMtab('main')}><Icon name={hasStreams ? 'screen' : 'chat'} />{hasStreams ? 'Эфир' : 'Чат'}</button>
        <button className={mtab === 'members' ? 'active' : ''} aria-label="Участники" aria-current={mtab === 'members' ? 'page' : undefined} onClick={() => setMtab('members')}><Icon name="users" />Участники</button>
      </nav>
    </>
  );
}

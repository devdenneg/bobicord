import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useStore, getEngine } from '../store';
import { api, resolveUploadUrl } from '../api';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial, prefersReducedMotion, downscaleImage } from '../util';
import { emoteMap, emoteUrl } from '../emotes';
import { EmotePicker } from './EmotePicker';
import { VoiceDock, VoiceControls } from './VoiceDock';
import { StreamerWidget } from './StreamerWidget';
import { getSettings, setSettings } from '../settings';
import { playSound } from '../sounds';
import { applyNativeUpdate } from '../nativeUpdate';
import { isTauri, saveFileDialog, openFile, pathsExist } from '../native';
import { getDownloads, addDownload, subscribeDownloads, type DownloadItem } from '../downloads';
import type { Attachment, ChatMessage, Emote, Member, ReplyRef, Role } from '../types';
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

function Avatar({ name, ci, url, size = 32, dot, live, liveApp }: { name: string; ci: number; url?: string; size?: number; dot?: string; live?: boolean; liveApp?: { appName?: string; appIcon?: string } | null }) {
  return (
    <div className={'av' + (live ? ' live' : '')} style={{ width: size, height: size, fontSize: size * 0.44, background: url ? '#0000' : avColor(name, ci) }}>
      {url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : initial(name)}
      {dot ? <span className={'sdot ' + dot} /> : null}
      {live ? <span className="av-live" title={liveApp?.appName ? `Стримит ${liveApp.appName}` : 'В эфире'}>LIVE</span> : null}
      {/* иконка игры — наверх-вправо: низ по центру занимает LIVE-бейдж (иначе наслаиваются) */}
      {live && liveApp?.appIcon ? <img src={`data:image/png;base64,${liveApp.appIcon}`} alt="" title={liveApp.appName ? `Стримит ${liveApp.appName}` : undefined} style={{ position: 'absolute', right: -3, top: -3, width: 14, height: 14, borderRadius: 3, border: '2px solid var(--bg-alt, #111)', objectFit: 'contain' }} /> : null}
    </div>
  );
}

/* ---------- Profile hover card ---------- */
function useHoverCard() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useRef<number | undefined>(undefined);
  const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(hover:none)').matches;
  const onEnter = () => { if (isTouch) return; t.current = window.setTimeout(() => { if (ref.current) setRect(ref.current.getBoundingClientRect()); }, 320); };
  const onLeave = () => { if (isTouch) return; window.clearTimeout(t.current); setRect(null); };
  // тач: открыть/закрыть карточку по тапу (на десктопе no-op — работает hover)
  const onTap = () => { if (!isTouch) return; setRect((r) => (r ? null : (ref.current ? ref.current.getBoundingClientRect() : null))); };
  useEffect(() => () => window.clearTimeout(t.current), []);
  // тач-дисмисс открытой карточки: тап вне / скролл / ресайз
  useEffect(() => {
    if (!isTouch || !rect) return;
    const close = () => setRect(null);
    const id = window.setTimeout(() => { document.addEventListener('pointerdown', close); window.addEventListener('scroll', close, true); window.addEventListener('resize', close); }, 0);
    return () => { window.clearTimeout(id); document.removeEventListener('pointerdown', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [isTouch, rect]);
  return { ref, rect, onEnter, onLeave, onTap };
}

function ProfileCard({ m, rect }: { m: Member; rect: DOMRect }) {
  const me = useStore((s) => s.me);
  const bio = ((me && m.username === me.username ? (me.bio || m.bio) : m.bio) || '').trim();
  const onRight = rect.left < window.innerWidth / 2;
  const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - 260));
  const style: CSSProperties = onRight ? { left: rect.right + 10, top } : { right: window.innerWidth - rect.left + 10, top };
  return (
    <div className="pcard" style={style}>
      <div className="pcard-av" style={{ background: m.avatarUrl ? '#0000' : avColor(m.displayName, m.avatarColor) }}>
        {m.avatarUrl ? <img className="avimg" src={resolveUploadUrl(m.avatarUrl)} alt="" /> : initial(m.displayName)}
      </div>
      <div className="pcard-name">{m.displayName}{m.role === 'owner' ? <span className="rl" title="Владелец">👑</span> : null}</div>
      <div className="pcard-user">@{m.username}</div>
      {m.roles && m.roles.length ? (<>
        <div className="pcard-label">Роли</div>
        <div className="pcard-roles">{m.roles.map((r) => <span key={r.id} className="role-badge" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>)}</div>
      </>) : null}
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
  const pr = eng.presence[m.username];
  const speaking = eng.speaking[m.username];
  const streaming = pr?.streaming;
  const isLocal = m.username === me.username;
  const remote = !isLocal;
  const watching = !!eng.watching[m.username];
  const pending = !!eng.pending[m.username];
  const [vol, setVol] = useState(() => Math.round(E.userVolOf(m.username) * 100));
  const talking = speaking && !pr?.micMuted;
  const connecting = isLocal && eng.voiceConnecting;
  const rowId = `vc-${m.username}`;
  const hc = useHoverCard();
  return (
    <div className={'pi' + (remote ? ' clickable' : '') + (streaming ? ' streaming' : '') + (talking ? ' speaking' : '') + (open ? ' open' : '') + (connecting ? ' connecting' : '') + (anim ? ' ' + anim : '')} data-spk={m.username}>
      <div className="head"
        ref={hc.ref} onMouseEnter={remote ? hc.onEnter : undefined} onMouseLeave={remote ? hc.onLeave : undefined}
        role={remote ? 'button' : undefined} tabIndex={remote ? 0 : undefined}
        aria-expanded={remote ? open : undefined} aria-controls={remote ? rowId : undefined}
        onClick={() => remote && setOpen((v) => !v)}
        onKeyDown={(e) => { if (remote && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((v) => !v); } }}>
        <div className={'av' + (streaming ? ' live' : '')} style={{ background: m.avatarUrl ? '#0000' : avColor(m.displayName, m.avatarColor) }}>
          {m.avatarUrl ? <img className="avimg" src={resolveUploadUrl(m.avatarUrl)} alt="" /> : initial(m.displayName)}
          {streaming ? (() => { const meta = E.getStreamAppMeta(m.username); const gname = meta?.appName || pr?.game?.name; return <span className="av-live" title={gname ? `Стримит ${gname}` : 'В эфире'}>LIVE</span>; })() : null}
        </div>
        <div className="vc-id">
          <div className="nm" title={m.displayName}>{m.displayName}{isLocal && !connecting ? ' (ты)' : ''}</div>
          {connecting ? <span className="vc-connecting">подключение…</span> : null}
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
        {pr?.game ? (
          <span className="vcg" data-tip={'Играет в ' + pr.game.name}>{pr.game.icon ? <img src={`data:image/png;base64,${pr.game.icon}`} alt="" /> : <span className="gpad">🎮</span>}</span>
        ) : null}
        {connecting
          ? <span className="spin" style={{ margin: 0, width: 14, height: 14 }} aria-label="Подключение" />
          : <div className={'micst' + (pr?.micMuted ? ' off' : '')} aria-label={pr?.micMuted ? (pr?.deafened ? 'Оглох' : 'Микрофон выключен') : undefined}><Icon name={pr?.deafened ? 'head-off' : 'mic-off'} /></div>}
        {remote ? <div className="chev" aria-hidden="true"><Icon name="chevron" sm /></div> : <div className="chev chev-pad" aria-hidden="true" />}
      </div>
      {remote ? (
        <div className="exp" id={rowId}>
          <Icon name="speaker" sm />
          <input type="range" min={0} max={200} value={vol} aria-label={`Громкость: ${m.displayName}`}
            onChange={(e) => { let v = +e.target.value; if (Math.abs(v - 100) < 4) v = 100; setVol(v); E.setUserVol(m.username, v / 100); }}
            onDoubleClick={() => { setVol(100); E.setUserVol(m.username, 1); }} />
          <span className="vlbl">{vol}%</span>
          <button className={'mut' + (E.isMutedFor(m.username) ? ' on' : '')} aria-label="Заглушить у себя" data-tip="Не слышать этого человека" onClick={(e) => { e.stopPropagation(); E.toggleUserMute(m.username); }}><Icon name="volume-off" sm /></button>
        </div>
      ) : null}
      {remote && hc.rect ? <ProfileCard m={m} rect={hc.rect} /> : null}
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
            <button className="vchan-act" data-tip="Переименовать" onClick={() => setEditing(true)}><Icon name="edit" sm /></button>
            {canDelete ? <button className="vchan-act del" data-tip="Удалить канал" onClick={() => setConfirmDel(true)}><Icon name="trash" sm /></button> : null}
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
      <button className="vchan-create-ok" disabled={!name.trim() || busy} data-tip="Создать" onClick={submit}>{busy ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name="check" sm />}</button>
      <button className="vchan-create-x" data-tip="Отмена" onClick={() => { setName(''); setOpen(false); }}><Icon name="close" sm /></button>
    </div>
  );
}

// VoiceControls / ShareButton / NativeBroadcastButton вынесены в components/VoiceDock.tsx —
// персистентный голос-док на уровне App (виден на всех экранах, пока ты в голосовом).

// роли сразу за ником; что не влезло — сворачиваем в «+N» с тултипом всех ролей
function roleBadge(r: Role) {
  return <span key={r.id} className="role-badge" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>;
}
// бейдж роли: если имя не влезает в max-width — пускаем бегущую строку (ping-pong), иначе обычный ellipsis
function RoleBadge({ r }: { r: Role }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current; if (!o || !i) return;
    const compute = () => {
      const cs = getComputedStyle(o);
      const avail = o.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const over = i.scrollWidth - avail;
      setShift(over > 1 ? over : 0);
    };
    compute();
    const ro = new ResizeObserver(compute); ro.observe(o);
    return () => ro.disconnect();
  }, [r.name]);
  const marq = shift > 0 && !prefersReducedMotion();
  const style: CSSProperties = { background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' };
  const innerStyle: CSSProperties | undefined = marq ? { ['--marq' as string]: -shift + 'px', animationDuration: (2 + shift / 28).toFixed(2) + 's' } as CSSProperties : undefined;
  return (
    <span ref={outer} key={r.id} className={'role-badge' + (marq ? ' marquee' : '')} style={style} data-tip={shift > 0 ? r.name : undefined}>
      <span ref={inner} className="rb-t" style={innerStyle}>{r.name}</span>
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
  const watching = !!eng.watching[m.username];
  const pending = !!eng.pending[m.username];
  const canKick = !!active && active.ownerId === me.id && !self && m.role !== 'owner';
  const hc = useHoverCard();
  // Стример: игру показываем ТОЛЬКО оверлеем на аватаре (LIVE + иконка игры) — отдельная гейм-пилюля
  // была бы дублем (очевидно, стримит то, во что играет). Оверлею даём фолбэк pr.game (мета-иконка
  // стрима бывает пустой). Не-стример игрок → обычная гейм-пилюля ниже.
  const liveApp = streaming ? (() => { const meta = E.getStreamAppMeta(m.username); return { appName: meta?.appName || pr?.game?.name, appIcon: meta?.appIcon || pr?.game?.icon }; })() : null;
  const showGamePill = !!pr?.game && !streaming;
  async function kick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!active) return;
    if (!window.confirm(`Выгнать ${m.displayName} с сервера?`)) return;
    try { await api.kickMember(active.id, m.id); toast(`${m.displayName} выгнан`, 'ok'); refreshMembers(); }
    catch (err: any) { toast(err?.message || 'Не удалось выгнать', 'err'); }
  }
  return (
    <div className={'pi ' + st + (streaming ? ' streaming' : '') + (anim ? ' ' + anim : '')} data-spk={m.username}>
      <div className="head" ref={hc.ref} onClick={self ? undefined : hc.onTap} onMouseEnter={self ? undefined : hc.onEnter} onMouseLeave={self ? undefined : hc.onLeave}>
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} dot={st} live={streaming} liveApp={liveApp} />
        <div className="pi-main">
          {/* нет игры → роли ИНЛАЙН сразу после ника (одна строка). Есть игра → ник ↑, игра+роли ↓. */}
          <div className="pi-l1">
            <div className="nm" style={roleColorOf(m) ? { color: roleColorOf(m) } : undefined}>{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{self ? ' (ты)' : ''}</div>
            {!showGamePill && m.roles && m.roles.length > 0 ? <MemberRoles roles={m.roles} /> : null}
          </div>
          {pr?.game && !streaming ? (
            <div className="pi-l2">
              <span className="pi-game mem" data-tip={'Играет в ' + pr.game.name}>
                {pr.game.icon ? <img src={`data:image/png;base64,${pr.game.icon}`} alt="" /> : <span className="gpad">🎮</span>}
                <span className="pg-nm">{pr.game.name}</span>
              </span>
              {m.roles && m.roles.length > 0 ? <MemberRoles roles={m.roles} /> : null}
            </div>
          ) : null}
        </div>
        <div className="pi-ctl">
          {!self && streaming && !pr?.inVoice ? (
            <button className={'watchbtn' + (watching ? ' on' : '')} disabled={pending}
              aria-label={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
              data-tip={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
              onClick={(e) => { e.stopPropagation(); watching ? E.closeWatch(m.username) : E.watch(m.username); }}>
              {pending ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name={watching ? 'eye-off' : 'eye'} />}
            </button>
          ) : null}
          {canKick ? <button className="mkick" data-tip="Выгнать" onClick={kick}><Icon name="close" sm /></button> : null}
        </div>
      </div>
      {!self && hc.rect ? <ProfileCard m={m} rect={hc.rect} /> : null}
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
  const animOf = (m: Member, sectionOnline: boolean): string => {
    const isNow = sectionOnline ? onSet.has(m.username) : !onSet.has(m.username);
    if (!isNow) return 'mrow-exit';                                  // ghost в покидаемой секции
    return enter.has(m.username) ? 'mrow-enter' : '';
  };

  return (
    <aside id="members">
      <div className="m-sec" style={{ borderBottom: '1px solid var(--line-2)', height: 50, display: 'flex', alignItems: 'center', gap: 6 }}>Участники · <span>{members.length}</span>
        {active?.statsEnabled ? <button className="m-trophy tip-b" data-tip="Рейтинг и уровни" onClick={() => setModal('leaderboard')}><Icon name="trophy" sm /></button> : null}
      </div>
      <div id="mlist">
        {online.length ? <div className="m-sec" style={{ padding: '10px 8px 4px' }}>В сети — {online.length}</div> : null}
        {onlineRender.map((m) => <MemberRow m={m} anim={animOf(m, true)} key={m.username} />)}
        {offline.length ? <div className="m-sec" style={{ padding: '10px 8px 4px' }}>Не в сети — {offline.length}</div> : null}
        {offlineRender.map((m) => <MemberRow m={m} anim={animOf(m, false)} key={m.username} />)}
      </div>
    </aside>
  );
}

/* ---------- Chat ---------- */
type RichPart = string | { emo: string; name: string } | { link: string } | { mention: string };
// сначала вырезаем упоминания (в т.ч. многословные ники по списку известных имён), остальное токенизируем
function renderRich(text: string, names?: Set<string>): RichPart[] {
  const out: RichPart[] = [];
  const tokenize = (chunk: string) => {
    for (const tok of chunk.split(/(\s+)/)) {
      if (!tok) continue;
      if (emoteMap.has(tok)) out.push({ emo: emoteMap.get(tok)!, name: tok });
      else if (/^https?:\/\/[^\s]+$/i.test(tok)) out.push({ link: tok });
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
function fmtTime(ts?: number): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
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
            <button key={i} className="msg-img-wrap" onClick={() => onImageClick(f)}>
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

// Шапка списка чата: спиннер во время догрузки старых сообщений / метка начала истории.
// Определена на уровне модуля (стабильная ссылка) — иначе virtuoso ремонтит её на каждый рендер.
// Лоадер догрузки вынесен из хедера в absolute-оверлей (#chat) — иначе смена высоты хедера в потоке
// списка дёргала якорь virtuoso (прыжок). Здесь остаётся только фикс-высокая метка «начало истории».
function ChatOlderHeader({ context }: { context?: { busy?: boolean; hasMore?: boolean } }) {
  return (
    <div className="virt-head">
      {context && !context.hasMore ? <span className="virt-head-end">Начало истории</span> : null}
    </div>
  );
}
function ChatFooter() { return <div style={{ height: 12 }} />; }

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
  const [reactTarget, setReactTarget] = useState<{ sid: number; anchor: DOMRect } | null>(null); // 7TV-пикер для реакции
  const [editing, setEditing] = useState<{ id: number; sid: number } | null>(null); // инлайн-редактирование
  const [editText, setEditText] = useState('');
  const markReadStore = useStore((s) => s.markRead);
  const bumpUnreadStore = useStore((s) => s.bumpUnread);
  // базовая линия «прочитано до» (id) — замораживается при входе на сервер; дивайдер «новые» рисуется
  // перед первым сообщением НОВЕЕ неё (чужим). При повторном входе lastRead уже сдвинут → дивайдера нет.
  const baseline = useMemo(() => useStore.getState().lastRead[activeId || ''] || 0, [activeId]);
  // Сервер (read_state) — источник правды по «есть ли непрочитанное». baseline (lastRead) может ОТСТАВАТЬ
  // от него и давать ложный firstUnread у верха истории: (1) свежевступивший в сессии сервер —
  // refreshServers/mergeUnread сеют unread, но НЕ lastRead → baseline=0 → sid>0 у первого чужого сообщения;
  // (2) baseline — снимок useMemo по [activeId], не обновляется после долёта /me. Когда сервер говорит
  // «0 непрочитанных» — дивайдера нет и вход СТРОГО в низ (иначе чат открывается у верха истории при
  // отсутствии новых). При unread>0 позиционируем по baseline как раньше.
  const unreadServer = useStore((s) => s.unread[activeId || ''] || 0);
  const firstUnread = unreadServer > 0 ? messages.findIndex((m) => m.sid != null && m.sid > baseline && !m.mine) : -1;
  const firstUnreadId = firstUnread >= 0 ? messages[firstUnread].id : null;
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
  const [pill, setPill] = useState(0);            // счётчик непрочитанных (пока не внизу)
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [dividerFade, setDividerFade] = useState(false); // дивайдер «Новые сообщения» гаснет, когда юзер увидел границу
  const [focusTick, setFocusTick] = useState(0); // тикает на focus/blur/visibility — «увидел глазами» зависит от фокуса окна
  // Якорь virtuoso DERIVED из engine-стейта (prepend/срез) — меняется ВМЕСТЕ с messages (один emit),
  // поэтому Virtuoso всегда видит согласованные data+firstItemIndex → чат НЕ прыгает при пагинации.
  // (Раньше был component-state + отдельные setFirstItemIndex → два источника, рассинхрон, прыжок.)
  const firstItemIndex = VIRT_BASE_INDEX - eng.chatPrepended + eng.chatTrimmed;
  const [olderBusy, setOlderBusy] = useState(false); // идёт догрузка старых
  const loadingOlder = useRef(false);                // защита от повторного startReached
  const olderReady = useRef(false);                  // гейт: не грузить старое, пока вход не устаканился
  const prevLastId = useRef<number | null>(null);    // id последнего сообщения — детект append vs prepend
  const lastAckedRef = useRef<number | null>(null);   // последний месседж (local id), для которого послан readAll — не спамим POST
  const lastTagAt = useRef(0);                         // троттл звука-пинга сообщений (не в фокусе) — не строчить пулемётом
  // автокомплит упоминаний (@ник)
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mIdx, setMIdx] = useState(0);
  const popRef = useRef<HTMLDivElement>(null); // контейнер попапа автокомплита — для скролла выделения

  const onAtBottom = useCallback((b: boolean) => { atBottomRef.current = b; setAtBottom(b); }, []);
  const scrollToBottom = useCallback(() => {
    setPill(0);
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
  }, []);

  // смена сервера: сброс состояния виртуального списка (Virtuoso ремонтится по key={activeId})
  useLayoutEffect(() => {
    // firstItemIndex теперь DERIVED (сбрасывается engine.loadHistory: chatPrepended/Trimmed=0) — руками не трогаем.
    // на входе: если есть непрочитанные — сеем счётчик jump-кнопки и стартуем НЕ внизу (позиция у
    // дивайдера, см. initialTopMostItemIndex), иначе внизу
    const unreadHere = unreadServer > 0 ? messages.filter((m) => m.sid != null && m.sid > baseline && !m.mine).length : 0;
    setPill(unreadHere); setAtBottom(unreadHere === 0); atBottomRef.current = unreadHere === 0; setReplyTo(null);
    // сброс стейджинга вложений при смене сервера — не тащим прикреплённые файлы между чатами
    setStaged((s) => { s.forEach((it) => it.previewUrl && URL.revokeObjectURL(it.previewUrl)); return []; });
    setSendQueued(false);
    prevLastId.current = null; lastAckedRef.current = null; loadingOlder.current = false; setOlderBusy(false);
    // не даём startReached стрельнуть догрузкой прямо на маунте (пока идёт scroll-to-bottom и оседание)
    olderReady.current = false;
    setDividerFade(false);
    const t = window.setTimeout(() => { olderReady.current = true; }, 700);
    // низ «оседает» уже ПОСЛЕ маунта (высоты картинок/эмодзи приходят позже) → если непрочитанного нет,
    // добиваем скролл к последнему несколько раз, пока не уплыли от низа. Гард atBottomRef — не дёргаем,
    // если юзер успел проскроллить вверх.
    const settle: number[] = [];
    if (unreadHere === 0) for (const d of [90, 320, 750]) settle.push(window.setTimeout(() => { if (atBottomRef.current) virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' }); }, d));
    return () => { clearTimeout(t); settle.forEach((s) => clearTimeout(s)); };
  }, [activeId]);

  // «Увидел своими глазами» = чат этого сервера открыт, проскроллен ВНИЗ И окно В ФОКУСЕ/видимо.
  // Только тогда новое сообщение прочитано. Свернул окно / ушёл в игру / проскроллил вверх — чужие
  // сообщения копятся в непрочитанное, даже если чат формально открыт (главное правило: не увидел → +1).
  const seenNow = () => atBottomRef.current && document.visibilityState === 'visible' && document.hasFocus();

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

  // append нового сообщения: pill (⌄) растёт по СКРОЛЛУ (есть сообщения ниже), непрочитанное — по
  // ФОКУСУ. prepend старых меняет messages[0], но не последний id → ничего не трогает.
  useEffect(() => {
    const lastMsg = messages.length ? messages[messages.length - 1] : null;
    const last = lastMsg ? lastMsg.id : null;
    // !lastMsg.sys — системные события (стрим начал/закончил) НЕ считаются непрочитанным чатом.
    if (prevLastId.current !== null && last !== prevLastId.current && lastMsg && !lastMsg.mine && !lastMsg.sys) {
      if (!atBottomRef.current) setPill((p) => p + 1);       // индикатор скролла: есть сообщения ниже
      if (!seenNow() && activeId) bumpUnreadStore(activeId);  // непрочитанное: не в фокусе или не внизу
      // Discord-стиль: апп свёрнут/не в фокусе, но ты на сервере → пинг на КАЖДОЕ сообщение (звук тега).
      // Меншены исключаем — у них свой пинг из notify (иначе двойной звук). Троттл — не строчить пулемётом.
      if (!document.hasFocus() && !lastMsg.mention) { const now = Date.now(); if (now - lastTagAt.current > 900) { lastTagAt.current = now; playSound('tag'); } }
    }
    prevLastId.current = last;
  }, [messages, activeId, bumpUnreadStore]);
  useEffect(() => { if (atBottom) setPill(0); }, [atBottom]);
  // Дивайдер «Новые сообщения» не висит вечно: как юзер добрался до низа и увидел границу (окно видимо),
  // через ~4.5с плавно гасим его (CSS-transition). Сброс — в entry-эффекте при смене сервера.
  useEffect(() => {
    if (dividerFade || !atBottom || document.visibilityState !== 'visible') return;
    const t = window.setTimeout(() => setDividerFade(true), 4500);
    return () => clearTimeout(t);
  }, [atBottom, dividerFade, focusTick]);
  // Внизу чата + окно В ФОКУСЕ/видимо → «прочитать всё» (реально увидел). Не в фокусе — НЕ читаем:
  // непрочитанное копится, пока не вернёшься в окно (focusTick пере-триггерит). Живые сообщения не имеют
  // серверного sid (узнаются лишь через refetch) → шлём all:true, сервер выставит last_read=MAX id.
  // Иначе прочитанное живое считалось бы непрочитанным на главной/др. устройстве. lastAckedRef — один
  // POST на последний месседж (не спамим на каждый ре-рендер).
  useEffect(() => {
    if (!atBottom || !activeId) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return; // не в фокусе — не прочитано
    const lastLocalId = messages.length ? messages[messages.length - 1].id : null;
    if (lastLocalId == null || lastAckedRef.current === lastLocalId) return; // этот последний месседж уже отмечен
    lastAckedRef.current = lastLocalId;
    let lastSid: number | undefined;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].sid != null) { lastSid = messages[i].sid!; break; } }
    markReadStore(activeId, lastSid ?? (useStore.getState().lastRead[activeId] || 0), true);
  }, [atBottom, messages, activeId, markReadStore, focusTick]);


  // догрузка более старых сообщений при скролле к верху (курсорная пагинация)
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !olderReady.current || !E.chatHasMore) return;
    const cursor = E.chatOldestCursor;
    const reqId = activeId;
    if (cursor == null || !reqId) return;
    loadingOlder.current = true; setOlderBusy(true);
    try {
      const h = await api.getMessages(reqId, cursor, 30);
      // за время запроса могли переключить сервер — не вклеиваем чужую страницу в чужой чат
      if (useStore.getState().active?.id !== reqId) return;
      // prependHistory растит messages И chatPrepended в ОДНОМ emit → firstItemIndex (derived) сдвигается
      // атомарно с данными, virtuoso держит позицию на прежнем сообщении (без прыжка). Отдельный
      // setFirstItemIndex больше не нужен (был вторым источником и давал рассинхрон/прыжок).
      E.prependHistory(h.messages, h.hasMore);
    } catch { /**/ }
    finally { loadingOlder.current = false; setOlderBusy(false); }
  }, [E, activeId]);

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
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    setFlashId(messages[idx].id);
  }, [messages]);
  useEffect(() => { if (flashId == null) return; const t = window.setTimeout(() => setFlashId(null), 1300); return () => clearTimeout(t); }, [flashId]);
  // реакция + доскролл: пилюля растит высоту последнего сообщения — если я внизу, держим его в поле зрения
  const reactTo = useCallback((sid: number, emote: { id: string; name: string }) => {
    E.toggleReaction(sid, emote);
    const last = messages.length ? messages[messages.length - 1] : null;
    if (last && last.sid === sid && atBottomRef.current) requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' }));
  }, [E, messages]);

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
            const { url } = await api.uploadImage(small);
            attachment = { url, name: small.name, size: small.size, mime: small.type, kind: 'image' };
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
    const em: Record<string, string> = {};
    t.split(/\s+/).forEach((w) => { if (emoteMap.has(w)) em[w] = emoteMap.get(w)!; });
    E.sendChatWithEmotes(t, em, undefined, replyTo ? buildReplyRef(replyTo) : undefined, ready.length ? ready : undefined);
    setText(''); setReplyTo(null); setStaged([]);
    if (activeId) localStorage.removeItem(DRAFT_KEY + activeId); // отправлено — черновик снят
    scrollToBottom(); // req: после отправки всегда показываем конец
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
  // Группа ограничена 10 сообщениями — после этого начинается заново даже у того же автора.
  const groupStart = useMemo(() => {
    const map = new Map<number, boolean>();
    let count = 0;
    for (let i = 0; i < messages.length; i++) {
      const start = isGroupStart(messages[i], messages[i - 1]) || count >= 10;
      map.set(messages[i].id, start);
      count = start ? 1 : count + 1;
    }
    return map;
  }, [messages]);

  // рендер одного сообщения (itemContent virtuoso). Чужие — слева с аватаром, свои — справа без.
  const renderMessage = (m: typeof messages[number]) => {
    // Карточка достижения уровня (рейтинг-фича) — своя вёрстка, не обычный пузырь
    if (m.kind === 'levelup') {
      const lvAuthor = m.who ? byName.get(m.who) : undefined;
      return (
        <div className="virt-row">
          <div className="lvlup-card">
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
    const hasMedia = !!m.img || !!(m.files && m.files.length);
    return (
      <div className={'virt-row' + (cont ? ' cont' : '') + (cont && hasMedia ? ' cont-media' : '')}>
        <div className={'msg' + (m.sys ? ' sys' : '') + (m.mine ? ' me' : '') + (m.mention ? ' mentioned' : '') + (m.id === flashId ? ' flash' : '') + (m.status === 'failed' ? ' failed' : '')}>
          {!m.sys ? <div className="msg-av">{!cont ? <Avatar name={m.who || ''} ci={m.color ?? 0} url={author?.avatarUrl} size={36} /> : null}</div> : null}
          <div className="msg-body">
            {replyQuote}
            {!m.sys && !cont ? <div className="who" style={{ color: nameColor }}>{m.who}{aRoles.length ? <span className="who-roles">{aRoles.map((r) => <span key={r.id} className="who-role" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>)}</span> : null}{m.ts ? <span className="mtime">{fmtTime(m.ts)}</span> : null}</div> : null}
            <div className="msg-main">
              <div className="msg-content">
                {editing?.id === m.id ? (
                  <div className="msg-edit">
                    <input autoFocus value={editText} onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (m.sid != null && editText.trim()) E.editChat(m.sid, editText); setEditing(null); } else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); } }} />
                    <div className="msg-edit-hint">Enter — сохранить · Esc — отмена</div>
                  </div>
                ) : m.sys || m.text ? (
                  <div className={'tx' + (big ? ' big' : '')}>
                    {m.sys ? m.text : parts!.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : 'link' in p ? <a key={i} className="msg-link" href={p.link} target="_blank" rel="noreferrer">{p.link}</a> : 'mention' in p ? <span key={i} className="mention-tag">{p.mention}</span> : <img key={i} className="emo" src={emoteUrl(p.emo)} alt={p.name} title={p.name} loading="lazy" decoding="async" />))}
                    {m.edited && !m.sys ? <span className="medit" title="Изменено">(изменено)</span> : null}
                  </div>
                ) : null}
                {m.img ? <button className="msg-img-wrap" onClick={() => setLightbox({ url: m.img!, name: m.img!.split('/').pop() || 'image', size: 0, mime: 'image/*', kind: 'image' })}><img className="msg-img" src={resolveUploadUrl(m.img)} alt="" loading="lazy" /></button> : null}
                {m.files && m.files.length ? <MessageAttachments files={m.files} onImageClick={setLightbox} /> : null}
                {m.status === 'failed' ? <div className="msg-failed"><Icon name="warn" sm />Не отправлено<button onClick={() => getEngine()?.retrySend(m.id)}>Повторить</button></div> : null}
                {(() => { const reacts = m.sid != null ? E.getReactions(m.sid) : []; return reacts.length ? (
                  <div className="msg-reacts">
                    {reacts.map((r) => <button key={r.id} className={'react-pill' + (r.mine ? ' mine' : '')} title={r.name} onClick={() => m.sid != null && reactTo(m.sid, { id: r.id, name: r.name })}><img src={emoteUrl(r.id)} alt={r.name} loading="lazy" /><b>{r.count}</b></button>)}
                    <button className="react-add" data-tip="Добавить реакцию" onClick={(e) => m.sid != null && setReactTarget({ sid: m.sid, anchor: e.currentTarget.getBoundingClientRect() })}><Icon name="react" sm /></button>
                  </div>
                ) : null; })()}
              </div>
              {!m.sys && editing?.id !== m.id ? <div className="msg-actions" onMouseDown={(e) => e.preventDefault()}>
                {m.sid != null ? <button className="msg-act" data-tip="Реакция" onClick={(e) => setReactTarget({ sid: m.sid!, anchor: e.currentTarget.getBoundingClientRect() })}><Icon name="react" sm /></button> : null}
                <button className="msg-act" data-tip="Ответить" onClick={() => startReply(m)}><Icon name="reply" sm /></button>
                {m.text ? <button className="msg-act" data-tip="Копировать текст" onClick={() => { navigator.clipboard?.writeText(m.text!).then(() => useStore.getState().toast('Скопировано', 'ok')).catch(() => {}); }}><Icon name="copy" sm /></button> : null}
                {m.mine && m.text && m.sid != null ? <button className="msg-act" data-tip="Изменить" onClick={() => { setEditing({ id: m.id, sid: m.sid! }); setEditText(m.text); }}><Icon name="edit" sm /></button> : null}
                {m.mine && m.sid != null ? <button className="msg-act danger" data-tip="Удалить" onClick={() => { if (window.confirm('Удалить сообщение?')) E.deleteChat(m.sid!); }}><Icon name="delete" sm /></button> : null}
              </div> : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div id="chat">
      {messages.length === 0 ? (
        <div id="msgs"><div className="msgs-inner"><div id="chatEmpty">Общий чат сервера. Пиши сюда — видят все участники онлайн.</div></div></div>
      ) : (
        <Virtuoso
          key={activeId}
          ref={virtuosoRef}
          className="virt-msgs"
          data={messages}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={firstUnread >= 0 ? { index: firstUnread, align: 'start' } : { index: Math.max(0, messages.length - 1), align: 'end' }}
          alignToBottom
          startReached={loadOlder}
          followOutput={(bottom) => (bottom ? 'auto' : false)}
          atBottomThreshold={120}
          atBottomStateChange={onAtBottom}
          increaseViewportBy={{ top: 600, bottom: 400 }}
          computeItemKey={(_, m) => m.id}
          context={{ busy: olderBusy, hasMore: eng.chatHasMore }}
          components={{ Header: ChatOlderHeader, Footer: ChatFooter }}
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
      {replyTo ? (
        <div className="reply-bar">
          <Icon name="reply" sm />
          <span className="rb-to">Ответ <b style={{ color: (byName.get(replyTo.who || '') && roleColorOf(byName.get(replyTo.who || '')!)) || avColor(replyTo.who || '', replyTo.color) }}>{replyTo.who}</b></span>
          <span className="rb-text">{replySnippet(buildReplyRef(replyTo))}</span>
          <button className="rb-close" data-tip="Отменить · Esc" onClick={() => setReplyTo(null)}><Icon name="close" sm /></button>
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
              <button className="attach-remove" data-tip="Убрать" onClick={() => removeStaged(s.key)}><Icon name="close" sm /></button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="chat-in">
        <button id="emoBtn" ref={emoBtnRef} className={'emo-toggle' + (pickAnchor !== undefined ? ' on' : '')} data-tip="7TV эмоуты"
          onClick={() => setPickAnchor((a) => (a === undefined ? emoBtnRef.current!.getBoundingClientRect() : undefined))}><Icon name="smile" /></button>
        <button className="emo-toggle" data-tip="Прикрепить картинку (или Ctrl+V)" onClick={() => fileRef.current?.click()}><Icon name="image" /></button>
        <button className="emo-toggle" data-tip="Прикрепить файл" onClick={() => attachFileRef.current?.click()}><Icon name="attach" /></button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple style={{ display: 'none' }} onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) stageFiles(files, 'image'); e.target.value = ''; }} />
        <input ref={attachFileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) stageFiles(files, 'file'); e.target.value = ''; }} />
        <input id="msgIn" placeholder="Сообщение..." maxLength={1000} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} name="chat-message" value={text}
          onFocus={() => { if (!atBottomRef.current) scrollToBottom(); }}
          onPaste={(e) => {
            const items = e.clipboardData?.items; if (!items) return;
            const imgs: File[] = [];
            for (let i = 0; i < items.length; i++) { if (items[i].type.startsWith('image/')) { const f = items[i].getAsFile(); if (f) imgs.push(f); } }
            if (imgs.length) { e.preventDefault(); stageFiles(imgs, 'image'); }
          }}
          onChange={(e) => { const v = e.target.value; setText(v); if (v.trim()) E.sendTyping(); setMention(detectMention(v, e.target.selectionStart ?? v.length)); setMIdx(0); }} onKeyDown={onComposerKey} />
        <button id="sendBtn" className={(text.trim() || staged.some((s) => s.status !== 'error')) ? '' : 'empty'} data-tip={sendQueued ? 'Отправится, как только вложения загрузятся' : 'Отправить · Enter'} onClick={send}>
          {sendQueued ? <span className="spin" style={{ margin: 0, width: 14, height: 14 }} /> : <Icon name="send" />}
        </button>
      </div>
      {pickAnchor !== undefined ? <EmotePicker anchor={pickAnchor} onClose={() => setPickAnchor(undefined)}
        onPick={(e: Emote) => { setText((t) => t + (t && !t.endsWith(' ') ? ' ' : '') + e.name + ' '); }} /> : null}
      {reactTarget ? <EmotePicker anchor={reactTarget.anchor} onClose={() => setReactTarget(null)}
        onPick={(e: Emote) => { reactTo(reactTarget.sid, e); setReactTarget(null); }} /> : null}
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
  const [floats, setFloats] = useState<{ id: number; url: string; by: string; x: number; size?: string }[]>([]);
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
    setFloats((f) => [...f.slice(-23), { id, url: emoteUrl(emoteId), by, x, size }]);
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
            <img src={f.url} alt="" decoding="async" /><div className="ftag">{f.by}</div>
          </div>
        ))}
      </div>
      <div className={'watchers' + (wOpen ? ' open' : '')} onClick={(e) => { e.stopPropagation(); setWOpen((v) => !v); }}>
        {watchers.slice(0, 4).map((w, i) => <div className="wa" key={i} style={{ background: w.avatarUrl ? '#0000' : avColor(w.name, w.color) }} title={w.name}>{w.avatarUrl ? <img className="avimg" src={resolveUploadUrl(w.avatarUrl)} alt="" /> : initial(w.name)}</div>)}
        <div className="wc"><Icon name="eye" sm />{watchers.length}</div>
        {watchers.length ? (
          <div className="wtip">
            <div className="wtip-h">Смотрят · {watchers.length}</div>
            {watchers.map((w, i) => <div className="wtip-row" key={i}><span className="wtip-av" style={{ background: w.avatarUrl ? '#0000' : avColor(w.name, w.color) }}>{w.avatarUrl ? <img className="avimg" src={resolveUploadUrl(w.avatarUrl)} alt="" /> : initial(w.name)}</span>{w.name}</div>)}
          </div>
        ) : null}
      </div>
      <button className="spray" ref={sprayRef} data-tip="Кинуть эмоут — увидят все зрители"
        onClick={(e) => { e.stopPropagation(); setPickAnchor((a) => (a === undefined ? sprayRef.current!.getBoundingClientRect() : undefined)); }}><Icon name="smile" sm /></button>
      <div className="vbar" onDoubleClick={(e) => e.stopPropagation()}>
        {!isLocal ? (
          <>
            <button className="vb-btn" data-tip={svol === 0 ? 'Включить звук' : 'Заглушить'} onClick={toggleMute}><Icon name={svol === 0 ? 'volume-off' : 'speaker'} sm /></button>
            <input className="vb-vol" type="range" min={0} max={100} value={svol} onChange={(e) => setVol(+e.target.value)} />
            <span className="vb-pct">{svol}%</span>
          </>
        ) : <span className="vb-lbl">🖥 Твоя трансляция</span>}
        <div className="vb-sp" />
        {!isLocal ? <button className={'vb-btn' + (qualOpen ? ' active' : '')} data-tip="Качество" onClick={() => setQualOpen((v) => !v)}><Icon name="gear" sm /></button> : null}
        {!isLocal ? <button className={'vb-btn' + (treeOpen ? ' active' : '')} data-tip="Дерево трансляции — выбрать пира" onClick={() => setTreeOpen((v) => !v)}><Icon name="users" sm /></button> : null}
        <button className="vb-btn" data-tip="Картинка-в-картинке" onClick={togglePip}><Icon name="pip" sm /></button>
        <button className="vb-btn" data-tip="Во весь экран" onClick={toggleFs}><Icon name="fullscreen" sm /></button>
        {!isLocal ? <button className="vb-btn danger" data-tip="Закрыть трансляцию" onClick={() => E.closeWatch(identity)}><Icon name="close" sm /></button> : null}
      </div>
      {!isLocal && treeOpen ? <TreePeerPanel identity={identity} onClose={() => setTreeOpen(false)} /> : null}
      {!isLocal && qualOpen ? <QualityMenu identity={identity} onClose={() => setQualOpen(false)} /> : null}
      <div className="statsbox">
        <button className="stats-toggle" data-tip={statsOn ? 'Скрыть статистику' : 'Показать статистику'} onClick={(e) => { e.stopPropagation(); setStatsOn((v) => !v); }}><Icon name="info" sm /></button>
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
    <div className="treepanel" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 62, width: 'min(280px, calc(100% - 24px))', maxHeight: 320, overflow: 'auto', background: 'rgba(20,22,28,.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12, padding: 10, zIndex: 7, color: '#fff', fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <b>Дерево трансляции</b>
        <button className="vb-btn" onClick={onClose}><Icon name="close" sm /></button>
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
    <div className="qualpanel" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 62, width: 'min(220px, calc(100% - 24px))', background: 'rgba(20,22,28,.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12, padding: 10, zIndex: 7, color: '#fff', fontSize: 12, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <b>Качество</b>
        <button className="vb-btn" onClick={onClose}><Icon name="close" sm /></button>
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
  const me = useStore((s) => s.me)!;
  const setModal = useStore((s) => s.setModal);
  const eng = useEngine();
  const muted = eng.localMicMuted;
  const deaf = eng.deafened;
  // статус под ником: пред-установка/состояние мика видны ещё ДО входа в канал (Discord-стиль)
  const statusText = eng.micUnavailable ? 'Микрофон недоступен' : deaf ? 'Звук выключен' : muted ? 'Микрофон выключен' : 'В сети';
  return (
    <div id="channels">
      <div className="ch-header" role="button" tabIndex={0} data-tip="Меню сервера" onClick={() => setModal('srvmenu')}>
        <span className="chn">{active.name}</span><Icon name="info" sm />
      </div>
      <div className="ch-body"><VoiceChannels /></div>
      <StreamerWidget />
      <VoiceDock variant="inline" />
      {/* нижняя аккаунт-панель (всегда): полный ряд контролов (mic▾ / наушники▾ / трансляция / настройки).
          Работают и ВНЕ голоса — выбор устройства + пред-установка мута/оглушения до входа (Discord-стиль). */}
      <div className="user-panel">
        <div className="up-i" onClick={() => setModal('profile')}><b>{me.displayName}</b><span>{statusText}</span></div>
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
  const setModal = useStore((s) => s.setModal);
  const [minimized, setMin] = useState(false);
  const [mtab, setMtab] = useState<'channels' | 'main' | 'members'>('channels'); // мобилка: по умолчанию вкладка «Голос»
  const hasStreams = eng.streams.length > 0;
  const split = hasStreams && !minimized;
  useEffect(() => { if (!hasStreams) setMin(false); }, [hasStreams]);
  const chan = useResizable('w:channels', 290, 270, 440, 'right');
  const mem = useResizable('w:members', 244, 216, 400, 'left');
  const chatW = useResizable('w:chat', 340, 260, 640, 'left');
  const [membersOpen, setMembersOpen] = useState(() => localStorage.getItem('membersOpen') !== '0');
  useEffect(() => { localStorage.setItem('membersOpen', membersOpen ? '1' : '0'); }, [membersOpen]);
  const [showChat, setShowChat] = useState(false);
  useEffect(() => { if (!split) setShowChat(false); }, [split]);
  // трансляция открылась → сразу прячем участников (место под видео); закрылась → возвращаем, если прятали сами
  const prevSplit = useRef(false);
  const autoHidMembers = useRef(false);
  useEffect(() => {
    if (split === prevSplit.current) return;
    if (split) { if (membersOpen) { autoHidMembers.current = true; setMembersOpen(false); } }
    else if (autoHidMembers.current) { autoHidMembers.current = false; setMembersOpen(true); }
    prevSplit.current = split;
  }, [split, membersOpen]);

  return (
    <>
      <section id="server" className={'on' + (mtab !== 'main' ? ' tab-' + mtab : '')} style={{ '--ch-w': chan.w + 'px', '--mem-w': (membersOpen ? mem.w : 0) + 'px', '--mem-open': mem.w + 'px' } as CSSProperties}>
        <Channels />
        <div id="main">
          <div className="srv-header">
            <div className="hn"><Icon name="hash" sm /><span>общий</span></div>
            {split ? <button className={'hbtn' + (showChat ? ' on' : '')} data-tip={showChat ? 'Скрыть чат' : 'Показать чат'} onClick={() => setShowChat((v) => !v)}><Icon name="chat" sm /></button> : null}
            <button className={'hbtn mob-hide' + (membersOpen ? ' on' : '')} data-tip={membersOpen ? 'Скрыть участников' : 'Показать участников'} onClick={() => setMembersOpen((v) => !v)}><Icon name="users" sm /></button>
            <button className="hbtn" data-tip="Пригласить" onClick={() => setModal('invite')}><Icon name="link" sm /></button>
            <button className="hbtn mob-only" data-tip="Настройки" onClick={() => setModal('settings')}><Icon name="gear" sm /></button>
          </div>
          <div id="content" className={(split ? 'split' : '') + (split && showChat ? ' show-chat' : '')} style={{ '--chat-w': chatW.w + 'px' } as CSSProperties}>
            <Stage minimized={minimized} setMin={setMin} />
            {split && showChat ? <div className="rz rz-chat" onMouseDown={chatW.onDown} title="Потяни — ширина чата" /> : null}
            <Chat />
            {split ? <button className="mob-chat-toggle" onClick={() => setShowChat((v) => !v)}><Icon name={showChat ? 'screen' : 'chat'} sm />{showChat ? 'К трансляции' : 'Открыть чат'}</button> : null}
          </div>
        </div>
        <Members />
        <div className="rz rz-ch" onMouseDown={chan.onDown} title="Потяни, чтобы изменить ширину" />
        {membersOpen ? <div className="rz rz-mem" onMouseDown={mem.onDown} title="Потяни, чтобы изменить ширину" /> : null}
      </section>
      <div id="mtabs">
        <button className={mtab === 'channels' ? 'active' : ''} onClick={() => setMtab('channels')}><Icon name="speaker" />Голос</button>
        <button className={mtab === 'main' ? 'active' : ''} onClick={() => setMtab('main')}><Icon name="chat" />Чат</button>
        <button className={mtab === 'members' ? 'active' : ''} onClick={() => setMtab('members')}><Icon name="users" />Люди</button>
      </div>
    </>
  );
}

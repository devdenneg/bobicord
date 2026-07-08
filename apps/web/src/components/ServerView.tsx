import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useStore, getEngine } from '../store';
import { api, resolveUploadUrl } from '../api';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial, prefersReducedMotion } from '../util';
import { emoteMap, emoteUrl } from '../emotes';
import { EmotePicker } from './EmotePicker';
import { getSettings, setSettings } from '../settings';
import { applyNativeUpdate } from '../nativeUpdate';
import type { ChatMessage, Emote, Member, ReplyRef, Role } from '../types';
import { PERM, hasPerm } from '../types';

function Avatar({ name, ci, url, size = 32, dot, live, liveApp }: { name: string; ci: number; url?: string; size?: number; dot?: string; live?: boolean; liveApp?: { appName?: string; appIcon?: string } | null }) {
  return (
    <div className={'av' + (live ? ' live' : '')} style={{ width: size, height: size, fontSize: size * 0.44, background: url ? '#0000' : avColor(name, ci) }}>
      {url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : initial(name)}
      {dot ? <span className={'sdot ' + dot} /> : null}
      {live ? <span className="av-live" title={liveApp?.appName ? `Стримит ${liveApp.appName}` : 'В эфире'}>LIVE</span> : null}
      {live && liveApp?.appIcon ? <img src={`data:image/png;base64,${liveApp.appIcon}`} alt="" title={liveApp.appName ? `Стримит ${liveApp.appName}` : undefined} style={{ position: 'absolute', right: -3, bottom: -3, width: 14, height: 14, borderRadius: 3, border: '2px solid var(--bg-alt, #111)', objectFit: 'contain' }} /> : null}
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
          {(() => { const meta = streaming ? E.getStreamAppMeta(m.username) : null; return <>
            {streaming ? <span className="av-live" title={meta?.appName ? `Стримит ${meta.appName}` : 'В эфире'}>LIVE</span> : null}
            {streaming && meta?.appIcon ? <img src={`data:image/png;base64,${meta.appIcon}`} alt="" title={meta.appName ? `Стримит ${meta.appName}` : undefined} style={{ position: 'absolute', right: -3, bottom: -3, width: 14, height: 14, borderRadius: 3, border: '2px solid var(--bg-alt, #111)', objectFit: 'contain' }} /> : null}
          </>; })()}
        </div>
        <div className="vc-id">
          <div className="nm" title={m.displayName}>{m.displayName}{isLocal && !connecting ? ' (ты)' : ''}</div>
          {connecting ? <span className="vc-connecting">подключение…</span> : null}
          {pr?.game ? <span className="pi-game vc" data-tip={'Играет в ' + pr.game.name}>{pr.game.icon ? <img src={`data:image/png;base64,${pr.game.icon}`} alt="" /> : <span className="gpad">🎮</span>}<span className="pg-nm">{pr.game.name}</span></span> : null}
        </div>
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
        {remote ? <div className="chev" aria-hidden="true"><Icon name="chevron" sm /></div> : null}
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
          membersInChannel={members.filter((m) => eng.voiceChannels[m.username] === c.id)} />
      ))}
      {canManage && channels.length > 0 && channels.length < 5 ? <CreateChannelRow /> : null}
    </div>
  );
}

function VoiceChannelItem({ channel, membersInChannel, canManage, canDelete, mine }: { channel: { id: string; name: string }; membersInChannel: Member[]; canManage: boolean; canDelete: boolean; mine: boolean }) {
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
  const st = pr?.inVoice ? 'voice' : pr?.online ? 'online' : 'offline';
  const streaming = pr?.streaming;
  const self = m.username === me.username;
  const watching = !!eng.watching[m.username];
  const pending = !!eng.pending[m.username];
  const canKick = !!active && active.ownerId === me.id && !self && m.role !== 'owner';
  const hc = useHoverCard();
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
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} dot={st} live={streaming} liveApp={streaming ? E.getStreamAppMeta(m.username) : null} />
        <div className="pi-main">
          {/* нет игры → роли ИНЛАЙН сразу после ника (одна строка). Есть игра → ник ↑, игра+роли ↓. */}
          <div className="pi-l1">
            <div className="nm" style={roleColorOf(m) ? { color: roleColorOf(m) } : undefined}>{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{self ? ' (ты)' : ''}</div>
            {!pr?.game && m.roles && m.roles.length > 0 ? <MemberRoles roles={m.roles} /> : null}
          </div>
          {pr?.game ? (
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
      <div className="m-sec" style={{ borderBottom: '1px solid var(--line-2)', height: 50, display: 'flex', alignItems: 'center' }}>Участники · <span>{members.length}</span></div>
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
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const url = resolveUploadUrl(src);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lb-close" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
      <a className="lb-open" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Открыть оригинал</a>
      <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
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
function ChatOlderHeader({ context }: { context?: { busy?: boolean; hasMore?: boolean } }) {
  return (
    <div className="virt-head">
      {context?.busy ? <span className="spin" style={{ width: 16, height: 16, margin: 0 }} />
        : context && !context.hasMore ? <span className="virt-head-end">Начало истории</span> : null}
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
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [pickAnchor, setPickAnchor] = useState<DOMRect | null | undefined>(undefined);
  const emoBtnRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const toast = useStore((s) => s.toast);
  const updateReady = useStore((s) => s.updateReady);
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const activeId = useStore((s) => s.active?.id);
  const nativeUpdate = useStore((s) => s.nativeUpdate);
  const [updating, setUpdating] = useState(false);
  const messages = eng.messages;
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null); // на какое сообщение отвечаем
  const [flashId, setFlashId] = useState<number | null>(null);      // подсветка оригинала при переходе по цитате
  const markReadStore = useStore((s) => s.markRead);
  const bumpUnreadStore = useStore((s) => s.bumpUnread);
  // базовая линия «прочитано до» (id) — замораживается при входе на сервер; дивайдер «новые» рисуется
  // перед первым сообщением НОВЕЕ неё (чужим). При повторном входе lastRead уже сдвинут → дивайдера нет.
  const baseline = useMemo(() => useStore.getState().lastRead[activeId || ''] || 0, [activeId]);
  const firstUnread = messages.findIndex((m) => m.sid != null && m.sid > baseline && !m.mine);
  const firstUnreadId = firstUnread >= 0 ? messages[firstUnread].id : null;

  // --- виртуальный список чата (react-virtuoso) ---
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [pill, setPill] = useState(0);            // счётчик непрочитанных (пока не внизу)
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [focusTick, setFocusTick] = useState(0); // тикает на focus/blur/visibility — «увидел глазами» зависит от фокуса окна
  const [firstItemIndex, setFirstItemIndex] = useState(VIRT_BASE_INDEX); // якорь для prepend
  const [olderBusy, setOlderBusy] = useState(false); // идёт догрузка старых
  const loadingOlder = useRef(false);                // защита от повторного startReached
  const olderReady = useRef(false);                  // гейт: не грузить старое, пока вход не устаканился
  const prevLastId = useRef<number | null>(null);    // id последнего сообщения — детект append vs prepend
  const prevTrim = useRef(0);                         // сколько среза уже учтено в firstItemIndex
  const lastAckedRef = useRef<number | null>(null);   // последний месседж (local id), для которого послан readAll — не спамим POST
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
    setFirstItemIndex(VIRT_BASE_INDEX);
    // на входе: если есть непрочитанные — сеем счётчик jump-кнопки и стартуем НЕ внизу (позиция у
    // дивайдера, см. initialTopMostItemIndex), иначе внизу
    const unreadHere = messages.filter((m) => m.sid != null && m.sid > baseline && !m.mine).length;
    setPill(unreadHere); setAtBottom(unreadHere === 0); atBottomRef.current = unreadHere === 0; setReplyTo(null);
    prevLastId.current = null; prevTrim.current = 0; lastAckedRef.current = null; loadingOlder.current = false; setOlderBusy(false);
    // не даём startReached стрельнуть догрузкой прямо на маунте (пока идёт scroll-to-bottom и оседание)
    olderReady.current = false;
    const t = window.setTimeout(() => { olderReady.current = true; }, 700);
    return () => clearTimeout(t);
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
    }
    prevLastId.current = last;
  }, [messages, activeId, bumpUnreadStore]);
  useEffect(() => { if (atBottom) setPill(0); }, [atBottom]);
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

  // срез сообщений с начала (кап памяти в engine) сдвигает данные вперёд — поднимаем firstItemIndex
  // на столько же, иначе якорь virtuoso рассинхронится. useLayoutEffect — до отрисовки, без мелькания.
  useLayoutEffect(() => {
    const t = eng.chatTrimmed;
    if (t !== prevTrim.current) { setFirstItemIndex((f) => f + (t - prevTrim.current)); prevTrim.current = t; }
  }, [eng.chatTrimmed]);

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
      const count = h.messages.length;
      // сначала сдвигаем базовый индекс, затем растим данные — оба апдейта в одном тике
      // (React 18 батчит), virtuoso держит позицию скролла на прежнем сообщении.
      if (count > 0) setFirstItemIndex((f) => f - count);
      E.prependHistory(h.messages, h.hasMore);
    } catch { /**/ }
    finally { loadingOlder.current = false; setOlderBusy(false); }
  }, [E, activeId]);

  // --- reply (ответ на сообщение) ---
  const buildReplyRef = (m: ChatMessage): ReplyRef => ({ author: m.who || '', text: (m.text || '').slice(0, 160), uid: m.uid, sid: m.sid, img: !!m.img });
  const startReply = useCallback((m: ChatMessage) => {
    setReplyTo(m);
    requestAnimationFrame(() => document.getElementById('msgIn')?.focus());
  }, []);
  // переход к оригиналу по клику на цитату (если он сейчас загружен) + короткая подсветка
  const jumpToReply = useCallback((r: ReplyRef) => {
    if (r.sid == null) return;
    const idx = messages.findIndex((mm) => mm.sid === r.sid);
    if (idx < 0) return;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    setFlashId(messages[idx].id);
  }, [messages]);
  useEffect(() => { if (flashId == null) return; const t = window.setTimeout(() => setFlashId(null), 1300); return () => clearTimeout(t); }, [flashId]);

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
  function send() {
    const t = text.trim(); if (!t) return;
    if (t.startsWith('/')) { runCommand(t); setText(''); return; }
    const em: Record<string, string> = {};
    t.split(/\s+/).forEach((w) => { if (emoteMap.has(w)) em[w] = emoteMap.get(w)!; });
    E.sendChatWithEmotes(t, em, undefined, replyTo ? buildReplyRef(replyTo) : undefined);
    setText(''); setReplyTo(null);
    scrollToBottom(); // req: после отправки всегда показываем конец
  }

  async function sendImage(file: File) {
    if (!file.type.startsWith('image/')) { toast('Можно только картинки', 'warn'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('Картинка больше 10 МБ', 'warn'); return; }
    setUploading(true);
    try {
      const { url } = await api.uploadImage(file);
      const t = text.trim();
      const em: Record<string, string> = {};
      t.split(/\s+/).forEach((w) => { if (emoteMap.has(w)) em[w] = emoteMap.get(w)!; });
      E.sendChatWithEmotes(t, em, url, replyTo ? buildReplyRef(replyTo) : undefined);
      setText(''); setReplyTo(null);
      scrollToBottom();
    } catch (e: any) { toast(e?.message || 'Не удалось загрузить', 'err'); }
    finally { setUploading(false); }
  }

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
      const rAuthor = byName.get(m.reply.author);
      const rColor = (rAuthor && roleColorOf(rAuthor)) || avColor(m.reply.author, rAuthor?.avatarColor ?? 0);
      const jumpable = m.reply.sid != null;
      const rep = m.reply;
      replyQuote = (
        <button className={'reply-quote' + (jumpable ? ' jumpable' : '')} disabled={!jumpable} onClick={jumpable ? () => jumpToReply(rep) : undefined}
          title={rep.author + ': ' + (rep.text || (rep.img ? 'изображение' : ''))}>
          <span className="rq-bar" style={{ background: rColor }} />
          <span className="rq-author" style={{ color: rColor }}>{rep.author}</span>
          <span className="rq-text">{rep.text || (rep.img ? '🖼 Изображение' : '')}</span>
        </button>
      );
    }
    return (
      <div className={'virt-row' + (cont ? ' cont' : '')}>
        <div className={'msg' + (m.sys ? ' sys' : '') + (m.mine ? ' me' : '') + (m.mention ? ' mentioned' : '') + (m.id === flashId ? ' flash' : '') + (m.status === 'failed' ? ' failed' : '')}>
          {!m.sys ? <div className="msg-av">{!cont ? <Avatar name={m.who || ''} ci={m.color ?? 0} url={author?.avatarUrl} size={36} /> : null}</div> : null}
          <div className="msg-body">
            {replyQuote}
            {!m.sys && !cont ? <div className="who" style={{ color: nameColor }}>{m.who}{aRoles.length ? <span className="who-roles">{aRoles.map((r) => <span key={r.id} className="who-role" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>)}</span> : null}{m.ts ? <span className="mtime">{fmtTime(m.ts)}</span> : null}</div> : null}
            <div className="msg-main">
              <div className="msg-content">
                {m.sys || m.text ? (
                  <div className={'tx' + (big ? ' big' : '')}>
                    {m.sys ? m.text : parts!.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : 'link' in p ? <a key={i} className="msg-link" href={p.link} target="_blank" rel="noreferrer">{p.link}</a> : 'mention' in p ? <span key={i} className="mention-tag">{p.mention}</span> : <img key={i} className="emo" src={emoteUrl(p.emo)} alt={p.name} title={p.name} loading="lazy" decoding="async" />))}
                  </div>
                ) : null}
                {m.img ? <button className="msg-img-wrap" onClick={() => setLightbox(m.img!)}><img className="msg-img" src={resolveUploadUrl(m.img)} alt="" loading="lazy" /></button> : null}
                {m.status === 'failed' ? <div className="msg-failed"><Icon name="warn" sm />Не отправлено<button onClick={() => getEngine()?.retrySend(m.id)}>Повторить</button></div> : null}
              </div>
              {!m.sys ? <button className="msg-reply-btn" data-tip="Ответить" onMouseDown={(e) => e.preventDefault()} onClick={() => startReply(m)}><Icon name="reply" sm /></button> : null}
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
          initialTopMostItemIndex={firstUnread >= 0 ? { index: firstUnread, align: 'start' } : messages.length - 1}
          alignToBottom
          startReached={loadOlder}
          followOutput={(bottom) => (bottom ? 'auto' : false)}
          atBottomThreshold={120}
          atBottomStateChange={onAtBottom}
          increaseViewportBy={{ top: 600, bottom: 400 }}
          computeItemKey={(_, m) => m.id}
          context={{ busy: olderBusy, hasMore: eng.chatHasMore }}
          components={{ Header: ChatOlderHeader, Footer: ChatFooter }}
          itemContent={(_, m) => (m.id === firstUnreadId
            ? <div className="msg-newwrap"><div className="msg-newdiv"><span>Новые сообщения</span></div>{renderMessage(m)}</div>
            : renderMessage(m))}
        />
      )}
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
          <span className="rb-text">{replyTo.text || (replyTo.img ? '🖼 изображение' : '')}</span>
          <button className="rb-close" data-tip="Отменить · Esc" onClick={() => setReplyTo(null)}><Icon name="close" sm /></button>
        </div>
      ) : null}
      <div className="chat-in">
        <button id="emoBtn" ref={emoBtnRef} className={'emo-toggle' + (pickAnchor !== undefined ? ' on' : '')} data-tip="7TV эмоуты"
          onClick={() => setPickAnchor((a) => (a === undefined ? emoBtnRef.current!.getBoundingClientRect() : undefined))}><Icon name="smile" /></button>
        <button className="emo-toggle" data-tip="Прикрепить картинку (или Ctrl+V)" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <span className="spin" /> : <Icon name="image" />}</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = ''; }} />
        <input id="msgIn" placeholder="Сообщение..." maxLength={1000} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} name="chat-message" value={text}
          onFocus={() => { if (!atBottomRef.current) scrollToBottom(); }}
          onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; for (let i = 0; i < items.length; i++) { if (items[i].type.startsWith('image/')) { const f = items[i].getAsFile(); if (f) { e.preventDefault(); sendImage(f); } break; } } }}
          onChange={(e) => { const v = e.target.value; setText(v); if (v.trim()) E.sendTyping(); setMention(detectMention(v, e.target.selectionStart ?? v.length)); setMIdx(0); }} onKeyDown={onComposerKey} />
        <button id="sendBtn" className={text.trim() ? '' : 'empty'} data-tip="Отправить · Enter" onClick={send}><Icon name="send" /></button>
      </div>
      {pickAnchor !== undefined ? <EmotePicker anchor={pickAnchor} onClose={() => setPickAnchor(undefined)}
        onPick={(e: Emote) => { setText((t) => t + (t && !t.endsWith(' ') ? ' ' : '') + e.name + ' '); }} /> : null}
      {lightbox ? <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} /> : null}
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
        {!isLocal ? <button className={'vb-btn' + (treeOpen ? ' active' : '')} data-tip="Дерево трансляции — выбрать пира" onClick={() => setTreeOpen((v) => !v)}><Icon name="users" sm /></button> : null}
        <button className="vb-btn" data-tip="Картинка-в-картинке" onClick={togglePip}><Icon name="pip" sm /></button>
        <button className="vb-btn" data-tip="Во весь экран" onClick={toggleFs}><Icon name="fullscreen" sm /></button>
        {!isLocal ? <button className="vb-btn danger" data-tip="Закрыть трансляцию" onClick={() => E.closeWatch(identity)}><Icon name="close" sm /></button> : null}
      </div>
      {!isLocal && treeOpen ? <TreePeerPanel identity={identity} onClose={() => setTreeOpen(false)} /> : null}
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
  const label = !parent ? 'подключение…' : parent.broadcaster ? 'напрямую от вещателя' : parent.virtual ? 'через сервер (fallback)' : (members.find((m) => m.username === parent.identity)?.displayName || parent.identity);
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
      style={{ position: 'absolute', right: 8, bottom: 52, width: 280, maxHeight: 320, overflow: 'auto', background: 'rgba(20,22,28,.96)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 10, padding: 10, zIndex: 5, color: '#fff', fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <b>Дерево трансляции</b>
        <button className="vb-btn" onClick={onClose}><Icon name="close" sm /></button>
      </div>
      {!topo || !topo.nodes.length ? <div style={{ opacity: .6 }}>Нет данных о дереве</div> : <>
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
          ? <button className="ghost" style={{ margin: '6px 0 0', width: '100%' }} onClick={() => E.requestReparent(identity, 'vrelay')}>🖥 Через сервер (fallback)</button>
          : null}
      </>}
    </div>
  );
}

function Stage({ minimized, setMin }: { minimized: boolean; setMin: (v: boolean) => void }) {
  const eng = useEngine();
  const streams = eng.streams;
  const cls = 'n' + Math.min(streams.length, 2);
  const grid = (
    <div id="grid" className={streams.length >= 2 ? 'n2' : ''} style={{ display: streams.length ? 'grid' : 'none' }}>
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
  return (
    <div id="channels">
      <div className="ch-header" role="button" tabIndex={0} data-tip="Меню сервера" onClick={() => setModal('srvmenu')}>
        <span className="chn">{active.name}</span><Icon name="info" sm />
      </div>
      <div className="ch-body"><VoiceChannels /></div>
      <div className="user-panel">
        <div className="up-i" onClick={() => setModal('profile')}><b>{me.displayName}</b><span>В сети</span></div>
        <button className="up-btn" data-tip="Настройки звука" onClick={() => setModal('settings')}><Icon name="gear" sm /></button>
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
  const [mtab, setMtab] = useState<'channels' | 'main' | 'members'>('main');
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

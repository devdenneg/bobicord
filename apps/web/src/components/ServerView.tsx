import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useStore, getEngine } from '../store';
import { api, resolveUploadUrl } from '../api';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial, prefersReducedMotion } from '../util';
import { emoteMap, emoteUrl } from '../emotes';
import { EmotePicker } from './EmotePicker';
import { getSettings, setSettings } from '../settings';
import { isTauri, onBroadcastStopped, stopNativeBroadcast } from '../native';
import { applyNativeUpdate } from '../nativeUpdate';
import type { Emote, Member, Role } from '../types';
import { PERM, hasPerm } from '../types';

function Avatar({ name, ci, url, size = 32, dot }: { name: string; ci: number; url?: string; size?: number; dot?: string }) {
  return (
    <div className="av" style={{ width: size, height: size, fontSize: size * 0.44, background: url ? '#0000' : avColor(name, ci) }}>
      {url ? <img className="avimg" src={resolveUploadUrl(url)} alt="" /> : initial(name)}
      {dot ? <span className={'sdot ' + dot} /> : null}
    </div>
  );
}

/* ---------- Profile hover card ---------- */
function useHoverCard() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useRef<number | undefined>(undefined);
  const onEnter = () => { t.current = window.setTimeout(() => { if (ref.current) setRect(ref.current.getBoundingClientRect()); }, 320); };
  const onLeave = () => { window.clearTimeout(t.current); setRect(null); };
  useEffect(() => () => window.clearTimeout(t.current), []);
  return { ref, rect, onEnter, onLeave };
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
function VoiceParticipantRow({ m }: { m: Member }) {
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
  const rowId = `vc-${m.username}`;
  const hc = useHoverCard();
  return (
    <div className={'pi' + (remote ? ' clickable' : '') + (streaming ? ' streaming' : '') + (talking ? ' speaking' : '') + (open ? ' open' : '')} data-spk={m.username}>
      <div className="head"
        ref={hc.ref} onMouseEnter={remote ? hc.onEnter : undefined} onMouseLeave={remote ? hc.onLeave : undefined}
        role={remote ? 'button' : undefined} tabIndex={remote ? 0 : undefined}
        aria-expanded={remote ? open : undefined} aria-controls={remote ? rowId : undefined}
        onClick={() => remote && setOpen((v) => !v)}
        onKeyDown={(e) => { if (remote && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((v) => !v); } }}>
        <div className="av" style={{ background: m.avatarUrl ? '#0000' : avColor(m.displayName, m.avatarColor) }}>
          {m.avatarUrl ? <img className="avimg" src={resolveUploadUrl(m.avatarUrl)} alt="" /> : initial(m.displayName)}
        </div>
        <div className="nm" title={m.displayName}>{m.displayName}{isLocal ? ' (ты)' : ''}</div>
        {streaming ? <span className="livepill">LIVE</span> : null}
        {remote && streaming ? (
          <button className={'watchbtn' + (watching ? ' on' : '')} disabled={pending}
            aria-label={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
            data-tip={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
            onClick={(e) => { e.stopPropagation(); watching ? E.closeWatch(m.username) : E.watch(m.username); }}>
            {pending ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name={watching ? 'eye-off' : 'eye'} />}
          </button>
        ) : null}
        <div className={'micst' + (pr?.micMuted ? ' off' : '')} aria-label={pr?.micMuted ? 'Микрофон выключен' : undefined}><Icon name="mic-off" /></div>
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

/* ---------- Voice channel card ---------- */
function VoiceCard() {
  const eng = useEngine();
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.me)!;
  const E = getEngine()!;
  const inVoice = eng.inVoice;
  const inVoiceMembers = members.filter((m) => eng.presence[m.username]?.inVoice);

  return (
    <div className="voice-card">
      <div className="vc-h"><Icon name="speaker" />Голосовой канал</div>
      <div className="vc-list">
        {inVoiceMembers.map((m) => <VoiceParticipantRow m={m} key={m.username} />)}
      </div>
      {inVoiceMembers.length === 0 ? <div className="vc-empty">Никого в голосовом</div> : null}
      {!inVoice
        ? <button className="vc-join" onClick={() => E.joinVoice()}><Icon name="mic" sm />Подключиться</button>
        : null}
    </div>
  );
}

/* Вещание — только из нативного клиента (Evolution-TZ Э5 / CLAUDE.md инвариант 2).
   В браузере эта кнопка не рендерится вовсе. Конфиг источника/разрешения/битрейта
   и живая дебаг-статистика — в BroadcastModal (открывается по клику, живёт в
   глобальном сторе modal/broadcastLive, т.к. должна остаться открытой между
   ре-рендерами и переживать переключение вкладок сервера). */
function NativeBroadcastButton() {
  const eng = useEngine();
  const live = useStore((s) => s.broadcastLive);

  // Слушаем и когда модалка со статистикой закрыта — трансляция может
  // завершиться сама (например источник-окно закрыли, или энкодер/захват упали
  // фатально — mod.rs теперь шлёт это событие и в таких случаях тоже). Дополнительно
  // форсируем stop_broadcast: он же снимает Tauri-состояние (BroadcastState),
  // без этого повторный старт вечно отвечал бы «уже вещаем», даже когда трансляция
  // уже мертва.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onBroadcastStopped((info) => {
      useStore.getState().setBroadcastLive(false);
      // reason == null — штатный стоп по кнопке, тост не нужен. Иначе трансляция
      // умерла сама (энкодер/захват/сигналинг) — раньше это било молча, юзер видел
      // только откат в форму настроек без объяснения.
      if (info.reason) useStore.getState().toast('Трансляция остановлена: ' + info.reason, 'err');
      stopNativeBroadcast().catch(() => {});
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  if (!eng.inVoice) return null;
  return (
    <button className={'cbtn' + (live ? ' danger-on' : '')} aria-pressed={live}
      data-tip={live ? 'Трансляция идёт' : 'Начать трансляцию экрана'}
      onClick={() => useStore.getState().setModal('broadcast')}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

/* Веб-вещание — старый LiveKit-путь (VP8, через SFU), оставлен параллельно с
   нативным P2P-деревом (см. CLAUDE.md инвариант 2 / docs/Evolution-TZ.md, решение
   2026-07-06). Зритель сам определяет транспорт при `watch()` — тут ничего не меняем. */
function ShareButton() {
  const eng = useEngine();
  const E = getEngine()!;
  const me = useStore((s) => s.me)!;
  if (!eng.inVoice) return null;
  const live = !!eng.presence[me.username]?.streaming;
  return (
    <button className={'cbtn' + (live ? ' danger-on' : '')} aria-pressed={live}
      data-tip={live ? 'Трансляция идёт' : 'Транслировать экран'}
      onClick={() => E.share()}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

function VoiceControls() {
  const eng = useEngine();
  const E = getEngine()!;
  const mode = getSettings().mode;
  const muted = eng.localMicMuted;
  const ptt = mode === 'ptt' && !eng.deafened;
  const micClass = 'cbtn' + (muted && !ptt ? ' danger-on' : '') + (muted && ptt && !eng.pttDown ? ' ptt-idle' : '') + (eng.pttDown ? ' ptt-live' : '');
  return (
    <div className="vc-controls">
      <button className={micClass} aria-pressed={muted} data-tip="Микрофон · M" onClick={() => E.toggleMic()}><Icon name={muted ? 'mic-off' : 'mic'} sm /></button>
      <button className={'cbtn' + (eng.deafened ? ' danger-on' : '')} aria-pressed={eng.deafened} data-tip="Заглушить · D" onClick={() => E.toggleDeaf()}><Icon name={eng.deafened ? 'head-off' : 'head'} sm /></button>
      {isTauri ? <NativeBroadcastButton /> : <ShareButton />}
      <button className="cbtn leave-v" data-tip="Выйти из голосового" onClick={() => E.leaveVoice()}><Icon name="leave" sm /></button>
    </div>
  );
}

// роли сразу за ником; что не влезло — сворачиваем в «+N» с тултипом всех ролей
function roleBadge(r: Role) {
  return <span key={r.id} className="role-badge" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>;
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
      {roles.slice(0, visN).map(roleBadge)}
      {hidden > 0 ? <span className="role-more" data-tip={roles.map((r) => r.name).join(', ')}>+{hidden}</span> : null}
      <div className="mrow-roles-ghost" ref={ghostRef} aria-hidden="true">{roles.map(roleBadge)}</div>
    </div>
  );
}

/* ---------- Member list (right) — только инфо/статусы, без контролов ---------- */
function MemberRow({ m }: { m: Member }) {
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
    <div className={'pi ' + st + (streaming ? ' streaming' : '')} data-spk={m.username}>
      <div className="head" ref={hc.ref} onMouseEnter={self ? undefined : hc.onEnter} onMouseLeave={self ? undefined : hc.onLeave}>
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} dot={st} />
        <div className="nm" style={roleColorOf(m) ? { color: roleColorOf(m) } : undefined}>{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{self ? ' (ты)' : ''}</div>
        <MemberRoles roles={m.roles || []} />
        {!self && streaming && !pr?.inVoice ? (
          <button className={'watchbtn' + (watching ? ' on' : '')} disabled={pending}
            aria-label={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
            data-tip={watching ? 'Закрыть трансляцию' : 'Смотреть трансляцию'}
            onClick={(e) => { e.stopPropagation(); watching ? E.closeWatch(m.username) : E.watch(m.username); }}>
            {pending ? <span className="spin" style={{ margin: 0, width: 13, height: 13 }} /> : <Icon name={watching ? 'eye-off' : 'eye'} />}
          </button>
        ) : null}
        {canKick ? <button className="mkick" data-tip="Выгнать" onClick={kick}><Icon name="close" sm /></button> : null}
        {streaming ? <span className="livepill">LIVE</span> : null}
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
  return (
    <aside id="members">
      <div className="m-sec" style={{ borderBottom: '1px solid var(--line-2)', height: 50, display: 'flex', alignItems: 'center' }}>Участники · <span>{members.length}</span></div>
      <div id="mlist">
        {online.length ? <div className="m-sec" style={{ padding: '10px 8px 4px' }}>В сети — {online.length}</div> : null}
        {online.map((m) => <MemberRow m={m} key={m.username} />)}
        {offline.length ? <div className="m-sec" style={{ padding: '10px 8px 4px' }}>Не в сети — {offline.length}</div> : null}
        {offline.map((m) => <MemberRow m={m} key={m.username} />)}
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

function Chat() {
  const eng = useEngine();
  const E = getEngine()!;
  const [text, setText] = useState('');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [pickAnchor, setPickAnchor] = useState<DOMRect | null | undefined>(undefined);
  const msgsRef = useRef<HTMLDivElement>(null);
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
  const [pill, setPill] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const settleRef = useRef(0); // до этого времени игнорим scroll-события и жёстко держим низ
  const setBottom = (v: boolean) => { atBottomRef.current = v; setAtBottom(v); };
  // автокомплит упоминаний (@ник)
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mIdx, setMIdx] = useState(0);

  const pinBottom = useCallback(() => { const el = msgsRef.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  const scrollToBottom = useCallback(() => {
    pinBottom(); atBottomRef.current = true; setAtBottom(true); setPill(0);
  }, [pinBottom]);

  // новые сообщения: если внизу — доскроллить, иначе счётчик непрочитанных
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
    else setPill((p) => p + 1);
  }, [eng.messages.length, scrollToBottom]);

  // открытие/смена сервера: прижать к низу и «оседать» 1.8с, пока догружаются
  // картинки/link-превью (иначе layout-сдвиг ставит atBottom=false раньше, чем добьём вниз)
  useLayoutEffect(() => {
    settleRef.current = Date.now() + 1800;
    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  }, [activeId, scrollToBottom]);

  // ResizeObserver: пока внизу ИЛИ идёт «оседание» — до-прижимаем к низу при любом росте высоты
  useLayoutEffect(() => {
    const inner = msgsRef.current?.querySelector('.msgs-inner');
    if (!inner) return;
    const ro = new ResizeObserver(() => { if (atBottomRef.current || Date.now() < settleRef.current) pinBottom(); });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [pinBottom]);

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
    E.sendChatWithEmotes(t, em);
    setText('');
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
      E.sendChatWithEmotes(t, em, url);
      setText('');
    } catch (e: any) { toast(e?.message || 'Не удалось загрузить', 'err'); }
    finally { setUploading(false); }
  }

  // slash-команды (только в начале строки, пока нет пробела)
  const slashMode = /^\/[a-zа-я]*$/i.test(text);
  const cmdQuery = slashMode ? text.slice(1).toLowerCase() : '';
  const cmdCands = slashMode ? COMMANDS.filter((c) => c.name.startsWith(cmdQuery)) : [];
  const mCands: { username: string; displayName: string; avatarColor: number; everyone?: boolean }[] = (() => {
    if (!mention || slashMode) return [];
    const q = mention.q.toLowerCase();
    const list = members
      .filter((x) => x.username !== me.username && (x.username.toLowerCase().includes(q) || x.displayName.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((x) => ({ username: x.username, displayName: x.displayName, avatarColor: x.avatarColor, everyone: false }));
    if (q === '' || ['все', 'all', 'everyone'].some((w) => w.startsWith(q))) list.unshift({ username: 'все', displayName: 'Все участники', avatarColor: 0, everyone: true });
    return list.slice(0, 8);
  })();
  const acLen = slashMode ? cmdCands.length : mCands.length;
  const acOpen = acLen > 0;
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
  function acceptAc(i: number) { if (slashMode) insertCommand(cmdCands[i].name); else insertMention(mCands[i].username); }
  function onComposerKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMIdx((i) => (i + 1) % acLen); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMIdx((i) => (i - 1 + acLen) % acLen); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(Math.min(mIdx, acLen - 1)); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); setText((t) => (slashMode ? t + ' ' : t)); return; }
    }
    if (e.key === 'Enter') send();
  }

  const mentionNames = (() => { const s = new Set<string>(); for (const mm of members) { s.add(mm.username.toLowerCase()); s.add(mm.displayName.toLowerCase()); } ['все', 'all', 'everyone'].forEach((w) => s.add(w)); return s; })();
  const byName = new Map(members.map((mm) => [mm.displayName, mm] as const));

  return (
    <div id="chat">
      <div id="msgs" ref={msgsRef} onScroll={(e) => { if (Date.now() < settleRef.current) return; const m = e.currentTarget; const b = m.scrollTop + m.clientHeight >= m.scrollHeight - 120; setBottom(b); if (b) setPill(0); }}>
        <div className="msgs-inner">
          {eng.messages.length === 0 ? <div id="chatEmpty">Общий чат сервера. Пиши сюда — видят все участники онлайн.</div> : null}
          {eng.messages.map((m) => {
            const parts = m.sys ? null : renderRich(m.text, mentionNames);
            const emoCount = parts ? parts.filter((p) => typeof p === 'object' && 'emo' in p).length : 0;
            const hasLink = parts ? parts.some((p) => typeof p === 'object' && 'link' in p) : false;
            const big = !!parts && !hasLink && emoCount >= 1 && emoCount <= 3 && parts.every((p) => typeof p !== 'string' || !p.trim());
            const author = m.who ? byName.get(m.who) : undefined;
            const aRoles = author?.roles || [];
            const nameColor = (author && roleColorOf(author)) || avColor(m.who || '', m.color);
            return (
              <div className={'msg' + (m.sys ? ' sys' : '') + (m.mine ? ' me' : '') + (m.mention ? ' mentioned' : '')} key={m.id}>
                {!m.sys ? <div className="who" style={{ color: nameColor }}>{m.who}{aRoles.length ? <span className="who-roles">{aRoles.map((r) => <span key={r.id} className="who-role" style={{ background: (r.color || 'var(--panel3)') + '22', color: r.color || 'var(--muted)', borderColor: (r.color || 'var(--line-2)') + '55' }}>{r.name}</span>)}</span> : null}{m.ts ? <span className="mtime">{fmtTime(m.ts)}</span> : null}</div> : null}
                {m.sys || m.text ? (
                  <div className={'tx' + (big ? ' big' : '')}>
                    {m.sys ? m.text : parts!.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : 'link' in p ? <a key={i} className="msg-link" href={p.link} target="_blank" rel="noreferrer">{p.link}</a> : 'mention' in p ? <span key={i} className="mention-tag">{p.mention}</span> : <img key={i} className="emo" src={emoteUrl(p.emo)} alt={p.name} title={p.name} loading="lazy" decoding="async" />))}
                  </div>
                ) : null}
                {m.img ? <button className="msg-img-wrap" onClick={() => setLightbox(m.img!)}><img className="msg-img" src={resolveUploadUrl(m.img)} alt="" loading="lazy" onLoad={() => { const el = msgsRef.current; if (el && (atBottomRef.current || Date.now() < settleRef.current)) el.scrollTop = el.scrollHeight; }} /></button> : null}
              </div>
            );
          })}
        </div>
      </div>
      {!atBottom ? <button id="scrollbtn" aria-label="Прокрутить вниз" data-tip="К последним" onClick={scrollToBottom}><Icon name="chevron" />{pill > 0 ? <span className="sb-badge">{pill > 99 ? '99+' : pill}</span> : null}</button> : null}
      {eng.typing.length > 0 ? (
        <div className="typing-ind">
          <span className="tdots"><i /><i /><i /></span>
          {eng.typing.length === 1 ? `${eng.typing[0]} печатает…`
            : eng.typing.length === 2 ? `${eng.typing[0]} и ${eng.typing[1]} печатают…`
              : 'Несколько человек печатают…'}
        </div>
      ) : null}
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
        <div className="mention-pop" role="listbox">
          <div className="mpop-h">{slashMode ? 'Команды' : 'Упомянуть'}</div>
          {slashMode
            ? cmdCands.map((c, i) => (
              <button key={c.name} className={'mpop-row' + (i === mIdx ? ' sel' : '')} onMouseDown={(e) => { e.preventDefault(); insertCommand(c.name); }} onMouseEnter={() => setMIdx(i)}>
                <span className="mpop-cmd">/{c.name}</span><span className="mpop-desc">{c.desc}</span>
              </button>))
            : mCands.map((x, i) => (
              <button key={x.username} className={'mpop-row' + (i === mIdx ? ' sel' : '')} onMouseDown={(e) => { e.preventDefault(); insertMention(x.username); }} onMouseEnter={() => setMIdx(i)}>
                <span className="mpop-av" style={{ background: x.everyone ? 'var(--accent)' : avColor(x.displayName, x.avatarColor) }}>{x.everyone ? '@' : initial(x.displayName)}</span>
                <span className="mpop-nm">{x.displayName}</span>{!x.everyone ? <span className="mpop-u">@{x.username}</span> : null}
              </button>))}
        </div>
      ) : null}
      <div className="chat-in">
        <button id="emoBtn" ref={emoBtnRef} className={'emo-toggle' + (pickAnchor !== undefined ? ' on' : '')} data-tip="7TV эмоуты"
          onClick={() => setPickAnchor((a) => (a === undefined ? emoBtnRef.current!.getBoundingClientRect() : undefined))}><Icon name="smile" /></button>
        <button className="emo-toggle" data-tip="Прикрепить картинку (или Ctrl+V)" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <span className="spin" /> : <Icon name="image" />}</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = ''; }} />
        <input id="msgIn" placeholder="Сообщение..." maxLength={1000} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} name="chat-message" value={text}
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
function StreamTile({ streamKey, identity, isLocal }: { streamKey: string; identity: string; isLocal: boolean }) {
  const E = getEngine()!;
  const eng = useEngine();
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const emoteSize = useStore((s) => s.emoteSize);
  const vidRef = useRef<HTMLVideoElement>(null);
  const [floats, setFloats] = useState<{ id: number; url: string; by: string; x: number; size?: string }[]>([]);
  const [stats, setStats] = useState('');
  const [statsOn, setStatsOn] = useState(true);
  const [treeOpen, setTreeOpen] = useState(false);
  const [pickAnchor, setPickAnchor] = useState<DOMRect | null | undefined>(undefined);
  const sprayRef = useRef<HTMLButtonElement>(null);
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
    <div className="vwrap" ref={wrapRef} onDoubleClick={toggleFs}>
      <video ref={vidRef} autoPlay playsInline />
      <div className="lbl">🖥 {name}{isLocal ? ' (ты)' : ''}</div>
      {!isLocal ? <StreamSourceBadge identity={identity} /> : null}
      <div className="emolayer">
        {floats.map((f) => (
          <div className={'floatEmo em-' + (f.size || 'md')} key={f.id} style={{ left: Math.max(2, Math.min(92, f.x * 100)) + '%' }}>
            <img src={f.url} alt="" decoding="async" /><div className="ftag">{f.by}</div>
          </div>
        ))}
      </div>
      <div className="watchers">
        {watchers.slice(0, 4).map((w, i) => <div className="wa" key={i} style={{ background: avColor(w.name) }} title={w.name}>{initial(w.name)}</div>)}
        <div className="wc"><Icon name="eye" sm />{watchers.length}</div>
        {watchers.length ? (
          <div className="wtip">
            <div className="wtip-h">Смотрят · {watchers.length}</div>
            {watchers.map((w, i) => <div className="wtip-row" key={i}><span className="wtip-av" style={{ background: avColor(w.name) }}>{initial(w.name)}</span>{w.name}</div>)}
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
  const label = !parent ? 'подключение…' : parent.broadcaster ? 'напрямую от вещателя' : (members.find((m) => m.username === parent.identity)?.displayName || parent.identity);
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
  const nameOf = (n: { broadcaster: boolean; identity: string }) => n.broadcaster ? '📡 вещатель' : (members.find((m) => m.username === n.identity)?.displayName || n.identity);
  const youNode = topo?.nodes.find((n) => n.id === topo.you);
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
          const pickable = !isYou && !isParent && n.children < n.capacity;
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
      {streams.map((s) => <StreamTile key={s.key} streamKey={s.key} identity={s.identity} isLocal={s.isLocal} />)}
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
  const eng = useEngine();
  const active = useStore((s) => s.active)!;
  const me = useStore((s) => s.me)!;
  const setModal = useStore((s) => s.setModal);
  return (
    <div id="channels">
      <div className="ch-header" role="button" tabIndex={0} data-tip="Меню сервера" onClick={() => setModal('srvmenu')}>
        <span className="chn">{active.name}</span><Icon name="info" sm />
      </div>
      <div className="ch-body"><VoiceCard /></div>
      {eng.inVoice ? <div className="voice-bar"><VoiceControls /></div> : null}
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

  return (
    <>
      <section id="server" className={'on' + (mtab !== 'main' ? ' tab-' + mtab : '')} style={{ '--ch-w': chan.w + 'px', '--mem-w': (membersOpen ? mem.w : 0) + 'px' } as CSSProperties}>
        <Channels />
        <div id="main">
          <div className="srv-header">
            <div className="hn"><Icon name="hash" sm /><span>общий</span></div>
            <button className={'hbtn' + (membersOpen ? ' on' : '')} data-tip={membersOpen ? 'Скрыть участников' : 'Показать участников'} onClick={() => setMembersOpen((v) => !v)}><Icon name="users" sm /></button>
            <button className="hbtn" data-tip="Пригласить" onClick={() => setModal('invite')}><Icon name="link" sm /></button>
          </div>
          <div id="content" className={(split ? 'split' : '') + (split && showChat ? ' show-chat' : '')} style={{ '--chat-w': chatW.w + 'px' } as CSSProperties}>
            <Stage minimized={minimized} setMin={setMin} />
            {split ? <div className="rz rz-chat" onMouseDown={chatW.onDown} title="Потяни — ширина чата" /> : null}
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

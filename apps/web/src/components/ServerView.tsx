import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useStore, getEngine } from '../store';
import { api } from '../api';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial, prefersReducedMotion } from '../util';
import { emoteMap, emoteUrl } from '../emotes';
import { EmotePicker } from './EmotePicker';
import { getSettings, setSettings } from '../settings';
import type { Emote, Member } from '../types';

function Avatar({ name, ci, url, size = 32, dot, live }: { name: string; ci: number; url?: string; size?: number; dot?: string; live?: boolean }) {
  return (
    <div className="av" style={{ width: size, height: size, fontSize: size * 0.44, background: url ? '#0000' : avColor(name, ci) }}>
      {url ? <img className="avimg" src={url} alt="" /> : initial(name)}
      {dot ? <span className={'sdot ' + dot} /> : null}
      {live ? <span className="livebadge" /> : null}
    </div>
  );
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
  return (
    <div className={'pi' + (remote ? ' clickable' : '') + (streaming ? ' streaming' : '') + (speaking ? ' speaking' : '') + (open ? ' open' : '')} data-spk={m.username}>
      <div className="head" style={{ padding: '5px 6px' }} onClick={() => remote && setOpen((v) => !v)}>
        <div className="av" style={{ width: 28, height: 28, fontSize: 12, background: m.avatarUrl ? '#0000' : avColor(m.displayName, m.avatarColor) }}>{m.avatarUrl ? <img className="avimg" src={m.avatarUrl} alt="" /> : initial(m.displayName)}</div>
        <div className="nm" style={{ fontSize: 13 }}>{m.displayName}{isLocal ? ' (ты)' : ''}</div>
        {remote ? <div className="chev">⌄</div> : null}
        <div className={'micst' + (pr?.micMuted ? ' off' : '')}><Icon name={pr?.micMuted ? 'mic-off' : 'mic'} /></div>
      </div>
      {remote ? (
        <div className="exp" style={{ display: open ? 'flex' : 'none', padding: '2px 6px 8px 44px' }}>
          <input type="range" min={0} max={200} value={vol} aria-label="Громкость"
            onChange={(e) => { let v = +e.target.value; if (Math.abs(v - 100) < 4) v = 100; setVol(v); E.setUserVol(m.username, v / 100); }}
            onDoubleClick={() => { setVol(100); E.setUserVol(m.username, 1); }} />
          <span className="vlbl">{vol}%</span>
          <button className={'mut' + (E.isMutedFor(m.username) ? ' on' : '')} aria-label="Заглушить" onClick={(e) => { e.stopPropagation(); E.toggleUserMute(m.username); }}><Icon name="mic-off" sm /></button>
        </div>
      ) : null}
      {remote && streaming ? (
        <div className="watchrow" style={{ display: 'block', padding: '4px 8px 8px 8px' }}>
          <button className={'wbtn' + (watching ? ' open' : '')} disabled={pending}
            onClick={(e) => { e.stopPropagation(); watching ? E.closeWatch(m.username) : E.watch(m.username); }}>
            {pending ? <><span className="spin" />...</> : watching ? '◼ Закрыть трансляцию' : '▶ Смотреть трансляцию'}
          </button>
        </div>
      ) : null}
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
      <button className={'cbtn' + (E.isSharing() ? ' good-on' : '')} data-tip="Трансляция экрана" onClick={() => E.share()}><Icon name={E.isSharing() ? 'screen-stop' : 'screen'} sm /></button>
      <button className="cbtn leave-v" data-tip="Выйти из голосового" onClick={() => E.leaveVoice()}><Icon name="leave" sm /></button>
    </div>
  );
}

/* ---------- Member list (right) — только инфо/статусы, без контролов ---------- */
function MemberRow({ m }: { m: Member }) {
  const eng = useEngine();
  const me = useStore((s) => s.me)!;
  const pr = eng.presence[m.username];
  const st = pr?.inVoice ? 'voice' : pr?.online ? 'online' : 'offline';
  const streaming = pr?.streaming;
  return (
    <div className={'pi ' + st + (streaming ? ' streaming' : '')} data-spk={m.username}>
      <div className="head">
        <Avatar name={m.displayName} ci={m.avatarColor} url={m.avatarUrl} dot={st} live={streaming} />
        <div className="nm">{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{m.username === me.username ? ' (ты)' : ''}</div>
      </div>
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
function renderRich(text: string): (string | { emo: string; name: string })[] {
  return text.split(/(\s+)/).map((tok) => (emoteMap.has(tok) ? { emo: emoteMap.get(tok)!, name: tok } : tok));
}
function Chat() {
  const eng = useEngine();
  const E = getEngine()!;
  const [text, setText] = useState('');
  const [pickAnchor, setPickAnchor] = useState<DOMRect | null | undefined>(undefined);
  const msgsRef = useRef<HTMLDivElement>(null);
  const emoBtnRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const toast = useStore((s) => s.toast);
  const [pill, setPill] = useState(0);
  const atBottomRef = useRef(true);

  useLayoutEffect(() => {
    const el = msgsRef.current; if (!el) return;
    if (atBottomRef.current) { el.scrollTop = el.scrollHeight; setPill(0); }
    else setPill((p) => p + 1);
  }, [eng.messages.length]);

  function send() {
    const t = text.trim(); if (!t) return;
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

  return (
    <div id="chat">
      <div id="msgs" ref={msgsRef} onScroll={(e) => { const m = e.currentTarget; atBottomRef.current = m.scrollTop + m.clientHeight >= m.scrollHeight - 120; if (atBottomRef.current) setPill(0); }}>
        <div className="msgs-inner">
          {eng.messages.length === 0 ? <div id="chatEmpty">Общий чат сервера. Пиши сюда — видят все участники онлайн.</div> : null}
          {eng.messages.map((m) => {
            const parts = m.sys ? null : renderRich(m.text);
            const big = parts ? parts.every((p) => typeof p !== 'string' || !p.trim()) && parts.filter((p) => typeof p !== 'string').length <= 3 && parts.some((p) => typeof p !== 'string') : false;
            return (
              <div className={'msg' + (m.sys ? ' sys' : '') + (m.mine ? ' me' : '')} key={m.id}>
                {!m.sys ? <div className="who" style={{ color: avColor(m.who || '', m.color) }}>{m.who}</div> : null}
                {m.sys || m.text ? (
                  <div className={'tx' + (big ? ' big' : '')}>
                    {m.sys ? m.text : parts!.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <img key={i} className="emo" src={emoteUrl(p.emo)} alt={p.name} title={p.name} loading="lazy" decoding="async" />))}
                  </div>
                ) : null}
                {m.img ? <a className="msg-img-wrap" href={m.img} target="_blank" rel="noreferrer"><img className="msg-img" src={m.img} alt="" loading="lazy" /></a> : null}
              </div>
            );
          })}
        </div>
      </div>
      {pill > 0 ? <button id="newpill" className="show" onClick={() => { const m = msgsRef.current!; m.scrollTop = m.scrollHeight; setPill(0); atBottomRef.current = true; }}>↓ Новые сообщения ({pill})</button> : null}
      <div className="chat-in">
        <button id="emoBtn" ref={emoBtnRef} className={'emo-toggle' + (pickAnchor !== undefined ? ' on' : '')} data-tip="7TV эмоуты"
          onClick={() => setPickAnchor((a) => (a === undefined ? emoBtnRef.current!.getBoundingClientRect() : undefined))}><Icon name="smile" /></button>
        <button className="emo-toggle" data-tip="Прикрепить картинку (или Ctrl+V)" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <span className="spin" /> : <Icon name="image" />}</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = ''; }} />
        <input id="msgIn" placeholder="Сообщение..." maxLength={1000} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} name="chat-message" value={text}
          onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; for (let i = 0; i < items.length; i++) { if (items[i].type.startsWith('image/')) { const f = items[i].getAsFile(); if (f) { e.preventDefault(); sendImage(f); } break; } } }}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button id="sendBtn" className={text.trim() ? '' : 'empty'} data-tip="Отправить · Enter" onClick={send}><Icon name="send" /></button>
      </div>
      {pickAnchor !== undefined ? <EmotePicker anchor={pickAnchor} onClose={() => setPickAnchor(undefined)}
        onPick={(e: Emote) => { setText((t) => t + (t && !t.endsWith(' ') ? ' ' : '') + e.name + ' '); }} /> : null}
    </div>
  );
}

/* ---------- Stream stage ---------- */
function StreamTile({ streamKey, identity, isLocal }: { streamKey: string; identity: string; isLocal: boolean }) {
  const E = getEngine()!;
  const eng = useEngine();
  const me = useStore((s) => s.me)!;
  const members = useStore((s) => s.members);
  const vidRef = useRef<HTMLVideoElement>(null);
  const [floats, setFloats] = useState<{ id: number; url: string; by: string; x: number }[]>([]);
  const [stats, setStats] = useState('');
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

  useEffect(() => E.onEmote((sid, emoteId, by, x) => {
    if (sid !== identity) return;
    const id = floatSeq.current++;
    setFloats((f) => [...f.slice(-23), { id, url: emoteUrl(emoteId), by, x }]);
    setTimeout(() => setFloats((f) => f.filter((e) => e.id !== id)), 2800);
  }), [identity, E]);

  useEffect(() => {
    if (!isLocal) return;
    const t = setInterval(async () => { const s = await E.getScreenStats(); setStats(s || ''); }, 1500);
    return () => clearInterval(t);
  }, [isLocal, E]);

  const watchers = eng.watchers[identity] || [];
  const [svol, setSvol] = useState(() => Math.round(E.streamVolOf(identity) * 100));

  return (
    <div className="vwrap" onDoubleClick={(e) => { const w = e.currentTarget; document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen().catch(() => {}); }}>
      <video ref={vidRef} autoPlay playsInline />
      <div className="lbl">🖥 {name}{isLocal ? ' (ты)' : ''}</div>
      <div className="emolayer">
        {floats.map((f) => (
          <div className="floatEmo" key={f.id} style={{ left: Math.max(2, Math.min(92, f.x * 100)) + '%' }}>
            <img src={f.url} alt="" decoding="async" /><div className="ftag">{f.by}</div>
          </div>
        ))}
      </div>
      <div className="watchers">
        {watchers.slice(0, 4).map((w, i) => <div className="wa" key={i} style={{ background: avColor(w.name) }} title={w.name}>{initial(w.name)}</div>)}
        <div className="wc"><Icon name="eye" sm />{watchers.length}</div>
      </div>
      <button className="spray" ref={sprayRef} data-tip="Кинуть эмоут — увидят все зрители"
        onClick={(e) => { e.stopPropagation(); setPickAnchor((a) => (a === undefined ? sprayRef.current!.getBoundingClientRect() : undefined)); }}><Icon name="smile" sm /></button>
      {!isLocal ? (
        <>
          <div className="vvol">🔊 <input type="range" min={0} max={100} value={svol} onChange={(e) => { setSvol(+e.target.value); E.setStreamVol(identity, +e.target.value / 100); }} /><span style={{ minWidth: 30, textAlign: 'right' }}>{svol}%</span></div>
          <button className="vclose" title="Закрыть трансляцию" onClick={() => E.closeWatch(identity)}>✕</button>
        </>
      ) : null}
      {isLocal && stats ? <div id="stats" style={{ display: 'block' }} dangerouslySetInnerHTML={{ __html: stats }} /> : null}
      {pickAnchor !== undefined ? <EmotePicker anchor={pickAnchor} onClose={() => setPickAnchor(undefined)} onPick={(em) => E.fling(identity, em)} /> : null}
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
        <div className="up-av" onClick={() => setModal('profile')} style={{ background: me.avatarUrl ? '#0000' : avColor(me.displayName, me.avatarColor) }}>{me.avatarUrl ? <img className="avimg" src={me.avatarUrl} alt="" /> : initial(me.displayName)}</div>
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

  return (
    <>
      <section id="server" className={'on' + (mtab !== 'main' ? ' tab-' + mtab : '')} style={{ '--ch-w': chan.w + 'px', '--mem-w': mem.w + 'px' } as CSSProperties}>
        <Channels />
        <div id="main">
          <div className="srv-header">
            <div className="hn"><Icon name="hash" sm /><span>общий</span></div>
            <button className="hbtn" data-tip="Пригласить" onClick={() => setModal('invite')}><Icon name="link" sm /></button>
          </div>
          <div id="content" className={split ? 'split' : ''}>
            <Stage minimized={minimized} setMin={setMin} />
            <Chat />
          </div>
        </div>
        <Members />
        <div className="rz rz-ch" onMouseDown={chan.onDown} title="Потяни, чтобы изменить ширину" />
        <div className="rz rz-mem" onMouseDown={mem.onDown} title="Потяни, чтобы изменить ширину" />
      </section>
      <div id="mtabs">
        <button className={mtab === 'channels' ? 'active' : ''} onClick={() => setMtab('channels')}><Icon name="speaker" />Голос</button>
        <button className={mtab === 'main' ? 'active' : ''} onClick={() => setMtab('main')}><Icon name="chat" />Чат</button>
        <button className={mtab === 'members' ? 'active' : ''} onClick={() => setMtab('members')}><Icon name="users" />Люди</button>
      </div>
    </>
  );
}

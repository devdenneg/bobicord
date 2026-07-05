import { useEffect } from 'react';
import { useStore, getEngine } from './store';
import { getSettings } from './settings';
import { avColor, initial } from './util';
import { Icon, IconSprite } from './Icon';
import { Auth } from './components/Auth';
import { Toasts } from './components/Toasts';
import { ServerView } from './components/ServerView';
import { Modals } from './components/Modals';
import type { ServerSummary } from './types';

function Rail() {
  const servers = useStore((s) => s.servers);
  const active = useStore((s) => s.active);
  const loadingServerId = useStore((s) => s.loadingServerId);
  const me = useStore((s) => s.me)!;
  const openServer = useStore((s) => s.openServer);
  const goHome = useStore((s) => s.goHome);
  const setModal = useStore((s) => s.setModal);
  const activeId = active?.id || loadingServerId;
  return (
    <nav id="rail">
      <button className={'railbtn tip-l' + (!activeId ? ' active' : '')} data-tip="Домой" onClick={goHome}><Icon name="home" /></button>
      <div className="rail-sep" />
      {servers.map((s) => (
        <button key={s.id} className={'railbtn tip-l' + (activeId === s.id ? ' active' : '')} data-tip={s.name}
          style={{ background: avColor(s.name, s.iconColor) }} onClick={() => openServer(s.id)}>
          {initial(s.name)}{s.onlineCount ? <span className="dot green" /> : null}
        </button>
      ))}
      <button className="railbtn rail-add tip-l" data-tip="Создать / войти" onClick={() => setModal('create')}><Icon name="plus" /></button>
      <button className="railbtn rail-me tip-l" data-tip="Профиль" style={{ background: me.avatarUrl ? '#0000' : avColor(me.displayName, me.avatarColor) }} onClick={() => setModal('profile')}>{me.avatarUrl ? <img className="avimg" src={me.avatarUrl} alt="" /> : initial(me.displayName)}</button>
    </nav>
  );
}

function ServerCard({ s, onOpen }: { s: ServerSummary; onOpen: () => void }) {
  const on = s.online || [];
  return (
    <button className="srv-card" onClick={onOpen}>
      <div className="sc-h">
        <div className="sc-ic" style={{ background: avColor(s.name, s.iconColor) }}>{initial(s.name)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="sc-nm">{s.name}</div>
          <div className="sc-sub">{s.memberCount} участник(ов){s.role === 'owner' ? ' · владелец' : ''}</div>
        </div>
      </div>
      <div className="sc-online">
        {on.length ? (
          <>
            {on.slice(0, 5).map((u, i) => <div className="mini-av" key={i} style={{ background: avColor(u) }}>{initial(u)}</div>)}
            <span className="more" style={{ marginLeft: 12 }}>{on.length > 5 ? '+' + (on.length - 5) : on.length + ' в сети'}</span>
          </>
        ) : <span className="sc-none">Сейчас никого нет в сети</span>}
      </div>
    </button>
  );
}

function Home() {
  const me = useStore((s) => s.me)!;
  const servers = useStore((s) => s.servers);
  const openServer = useStore((s) => s.openServer);
  const setModal = useStore((s) => s.setModal);
  return (
    <section id="home">
      <div className="home-top"><h1>Здарова, {me.displayName}!</h1>
        <button className="hbtn" style={{ background: 'var(--panel2)', padding: '8px 14px' }} onClick={() => setModal('profile')}>Профиль</button></div>
      <div className="home-inner">
        <div className="home-actions">
          <button className="bigbtn" onClick={() => setModal('create')}><div className="bi g"><Icon name="plus" /></div><div><b>Создать сервер</b><span>Свой сервер для друзей</span></div></button>
          <button className="bigbtn" onClick={() => setModal('join')}><div className="bi a"><Icon name="link" /></div><div><b>Присоединиться</b><span>По коду или ссылке-приглашению</span></div></button>
        </div>
        <div className="home-sec">Серверы, где ты есть</div>
        <div className="srv-grid">
          {servers.length ? servers.map((s) => <ServerCard s={s} key={s.id} onOpen={() => openServer(s.id)} />)
            : <div style={{ color: 'var(--muted)', fontSize: 14, gridColumn: '1/-1', padding: 10 }}>У тебя пока нет серверов. Создай свой или войди по приглашению 👆</div>}
        </div>
      </div>
    </section>
  );
}

function ServerLoader() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--bg2)' }}><img src="/icon.png" alt="" className="pulse-logo" /></div>;
}

export function App() {
  const view = useStore((s) => s.view);
  const loadingServer = useStore((s) => s.loadingServer);
  const me = useStore((s) => s.me);

  // hotkeys (M / D / PTT) — active while logged in
  useEffect(() => {
    if (!me) return;
    const kd = (e: KeyboardEvent) => {
      const E = getEngine(); if (!E) return;
      const t = document.activeElement as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      const s = getSettings();
      if (E.inVoice && !typing) { if (e.code === 'KeyM') { E.toggleMic(); return; } if (e.code === 'KeyD') { E.toggleDeaf(); return; } }
      if (s.mode === 'ptt' && !typing && e.code === s.pttKey) E.pttPress();
    };
    const ku = (e: KeyboardEvent) => { const E = getEngine(); if (!E) return; const s = getSettings(); if (s.mode === 'ptt' && e.code === s.pttKey) E.pttRelease(); };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, [me]);

  return (
    <>
      <IconSprite />
      <Toasts />
      {view === 'loading' ? (
        <div className="overlay" style={{ background: 'var(--bg)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px -6px rgba(99,102,241,.6)' }}><Icon name="mic" /></div>
            <span className="spin" style={{ width: 22, height: 22, margin: 0 }} />
          </div>
        </div>
      ) : view === 'auth' ? <Auth /> : (
        <div id="app" className="on">
          <Rail />
          {view === 'home' ? <Home /> : (loadingServer ? <ServerLoader /> : <ServerView />)}
        </div>
      )}
      <Modals />
      <div id="audioSink" style={{ display: 'none' }} />
    </>
  );
}

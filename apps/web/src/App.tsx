import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, getEngine } from './store';
import { getSettings, setSettings, subscribeSettings } from './settings';
import { avColor, initial, normKey } from './util';
import { api, resolveUploadUrl } from './api';
import { Icon, IconSprite } from './Icon';
import { Home } from './components/Home';
import { Auth } from './components/Auth';
import { AccountEmailGate } from './components/AccountEmailGate';
import { Toasts } from './components/Toasts';
import { ServerView } from './components/ServerView';
import { AdminPage } from './components/AdminPage';
import { VoiceDock } from './components/VoiceDock';
import { useEngine } from './hooks';
import { Modals } from './components/Modals';
import { isTauri, setGlobalHotkeys, onGlobalHotkey, setDetectableGames } from './native';
import type { ServerSummary, OnlineMember, KeybindAction } from './types';
import { LogoLoader } from './components/LogoLoader';
import { initNotifications } from './notify';
import { TooltipLayer } from './components/TooltipLayer';
import { ConnectivityBanner } from './components/ConnectivityBanner';
import { NotificationPermissionPrompt } from './components/NotificationPermissionPrompt';
import { IosPwaInstallPrompt } from './components/IosPwaInstallPrompt';
import { QuickSwitcher, ShortcutHelp, rememberServerDestination } from './components/CommandOverlays';
import { safeLocalStorageGet } from './safeStorage';

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
  const modal = useStore((s) => s.modal);
  const goAdmin = useStore((s) => s.goAdmin);
  const unread = useStore((s) => s.unread);
  const releaseUnread = useStore((s) => s.releaseUnread);
  const [draftServers, setDraftServers] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const scan = () => {
      const next = new Set<string>();
      for (const server of servers) {
        try {
          const hasText = (localStorage.getItem('chatDraft:' + server.id) || '').trim();
          const hasReply = localStorage.getItem('chatDraftReply:' + server.id);
          if (hasText || hasReply) next.add(server.id);
        } catch { /* storage may be unavailable */ }
      }
      setDraftServers(next);
    };
    const onDraftChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ serverId?: string; hasDraft?: boolean }>).detail;
      if (!detail?.serverId) { scan(); return; }
      const serverId = detail.serverId;
      setDraftServers((current) => {
        const next = new Set(current);
        if (detail.hasDraft) next.add(serverId); else next.delete(serverId);
        return next;
      });
    };
    scan();
    window.addEventListener('relay:drafts-changed', onDraftChanged);
    window.addEventListener('storage', scan);
    return () => { window.removeEventListener('relay:drafts-changed', onDraftChanged); window.removeEventListener('storage', scan); };
  }, [servers]);
  // подсвечиваем сервер только когда реально смотрим его (на главной — home активна)
  const activeId = view === 'server' ? (active?.id || loadingServerId) : null;
  return (
    <nav id="rail" aria-label="Серверы и разделы">
      <div className="rail-primary">
        <button className={'railbtn tip-l' + (view === 'home' ? ' active' : '')} aria-label="Домой" aria-current={view === 'home' ? 'page' : undefined} data-tip="Домой" onClick={goHome}><Icon name="home" /></button>
        <div className="rail-sep" />
        {servers.map((s) => {
          const un = activeId === s.id ? 0 : (unread[s.id] || 0); // активный не бейджим (читаем его)
          return (
          <button key={s.id} className={'railbtn tip-l' + (activeId === s.id ? ' active' : '') + (eng.voiceServerId === s.id && activeId !== s.id ? ' connected' : '') + (un ? ' unread' : '') + (s.iconUrl ? '' : ' av-fill')}
            aria-label={s.name + (eng.voiceServerId === s.id && activeId !== s.id ? ' — вы в голосовом канале' : '') + (draftServers.has(s.id) ? ' — есть черновик' : '')}
            aria-current={activeId === s.id ? 'page' : undefined}
            data-tip={eng.voiceServerId === s.id && activeId !== s.id ? s.name + ' · в голосе' : s.name}
            style={{ background: s.iconUrl ? '#0000' : avColor(s.name, s.iconColor) }} onClick={() => openServer(s.id)}>
            {s.iconUrl ? <img className="avimg" src={resolveUploadUrl(s.iconUrl)} alt="" /> : initial(s.name)}{(s.online || []).some((m) => m.inVoice) ? <span className="dot green" /> : null}
            {un ? <span className="rail-badge">{un > 99 ? '99+' : un}</span> : null}
            {draftServers.has(s.id) ? <span className={'rail-draft-dot'} aria-hidden={true} /> : null}
          </button>
          );
        })}
        <button className={'railbtn rail-add tip-l' + (modal === 'create' || modal === 'join' ? ' active' : '')} aria-label="Создать сервер или войти" aria-pressed={modal === 'create' || modal === 'join'} data-tip="Создать / войти" onClick={() => setModal('create')}><Icon name="plus" /></button>
      </div>
      <div className="rail-grow" />
      <div className="rail-tools" role="group" aria-label="Инструменты аккаунта">
        {me.isAdmin ? <button className={'railbtn rail-admin tip-l' + (view === 'admin' ? ' active' : '')} aria-label="Админка" aria-current={view === 'admin' ? 'page' : undefined} data-tip="Админка" onClick={goAdmin}><Icon name="users" /></button> : null}
        <button className={'railbtn rail-updates tip-l' + (modal === 'releaseHistory' ? ' active' : '') + (releaseUnread ? ' has-unread' : '')}
          aria-label={releaseUnread ? `Что нового — непрочитанных обновлений: ${releaseUnread}` : 'Что нового'}
          aria-pressed={modal === 'releaseHistory'} data-tip={releaseUnread ? `Что нового · ${releaseUnread}` : 'Что нового'}
          onClick={() => setModal('releaseHistory')}>
          <Icon name="updates" />
          {releaseUnread ? <span className="rail-badge rail-release-badge" aria-hidden="true">{releaseUnread}</span> : null}
        </button>
        {/* Настройки — глобально в рейле (доступны и на главной, не только внутри сервера) */}
        <button className={'railbtn rail-set tip-l' + (modal === 'settings' ? ' active' : '')} aria-label="Настройки" aria-pressed={modal === 'settings'} data-tip="Настройки" onClick={() => setModal('settings')}><Icon name="gear" /></button>
        <button className={'railbtn rail-dl tip-l' + (modal === 'downloads' ? ' active' : '')} aria-label="Загрузки" aria-pressed={modal === 'downloads'} data-tip="Загрузки" onClick={() => setModal('downloads')}><Icon name="download" /></button>
        <button className={'railbtn rail-me tip-l' + (modal === 'profile' ? ' active' : '') + (me.avatarUrl ? '' : ' av-fill')} aria-label="Профиль" aria-pressed={modal === 'profile'} data-tip="Профиль" style={{ background: me.avatarUrl ? '#0000' : avColor(me.displayName, me.avatarColor) }} onClick={() => setModal('profile')}>{me.avatarUrl ? <img className="avimg" src={resolveUploadUrl(me.avatarUrl)} alt="" /> : initial(me.displayName)}</button>
      </div>
    </nav>
  );
}

// Скелетон сервера вместо блёклого спиннера: повторяет форму реального лэйаута
// (каналы · чат · участники), чтобы переход «загрузка → контент» был плавным, без прыжка.
// Ширины берём из тех же localStorage-ключей, что и настоящий ServerView (иначе колонки скакнут).
function ServerSkeleton() {
  const entryTab = useStore((s) => s.serverEntryTab);
  const storedChW = Number(safeLocalStorageGet('w:channels'));
  const storedMemW = Number(safeLocalStorageGet('w:members'));
  const chW = storedChW >= 264 && storedChW <= 360 ? storedChW : 292;
  const memW = storedMemW >= 264 && storedMemW <= 360 ? storedMemW : 304;
  const singlePane = window.innerWidth <= 900;
  const compactDesktop = window.innerWidth >= 1241 && window.innerWidth <= 1360;
  const skeletonChW = compactDesktop ? Math.min(chW, 280) : chW;
  const skeletonMemW = compactDesktop ? Math.min(memW, 220) : memW;
  const chOpen = window.innerWidth <= 1240 || safeLocalStorageGet('channelsOpen') !== '0';
  const memOpen = safeLocalStorageGet('membersOpen') !== '0';
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
  const activeServerId = useStore((s) => s.active?.id || null);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  useEffect(() => { if (activeServerId) rememberServerDestination(activeServerId); }, [activeServerId]);

  // При запуске лишь подхватываем уже выданное разрешение. Системный prompt открывается
  // только после явного действия в нашем предварительном запросе или в настройках.
  useEffect(() => {
    if (!me) return;
    initNotifications(me.id).then((result) => {
      if (result.welcomed) useStore.getState().toast('Уведомления включены — отключить можно в Настройках → Уведомления', 'info');
    }).catch(() => {});
    // натив: подтягиваем аллоулист игр Discord (сервер дистиллирует) → Rust матчит процессы для детекта
    if (isTauri) api.detectableGames().then((d) => { if (d?.games?.length) setDetectableGames(d.games); }).catch(() => {});
  }, [me]);

  // Прямой заход по /admin (ввод URL или reload): открываем админку, если юзер админ. Иначе игнор —
  // останется home (кнопку в рейле всё равно видят только админы, серверные ручки за requireAdmin).
  useEffect(() => {
    if (me?.isAdmin && location.pathname.startsWith('/admin')) useStore.getState().goAdmin();
  }, [me]);

  // Навигационные сочетания одинаковы в web и desktop и не зависят от голосовых биндов.
  useEffect(() => {
    if (!me) return;
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const primary = event.ctrlKey || event.metaKey;
      if (primary && !event.altKey && event.code === 'KeyK') {
        event.preventDefault();
        setShortcutHelpOpen(false);
        setQuickSwitcherOpen((open) => !open);
        return;
      }
      if (primary && !event.altKey && event.code === 'Slash') {
        event.preventDefault();
        setQuickSwitcherOpen(false);
        setShortcutHelpOpen((open) => !open);
        return;
      }
      if (primary && !event.altKey && event.code === 'Comma') {
        event.preventDefault();
        setQuickSwitcherOpen(false);
        setShortcutHelpOpen(false);
        useStore.getState().setModal('settings');
        return;
      }
      if (quickSwitcherOpen || shortcutHelpOpen) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || useStore.getState().modal) return;
      if (event.altKey && !primary && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const state = useStore.getState();
        if (!state.servers.length) return;
        event.preventDefault();
        const current = state.active?.id;
        const currentIndex = state.servers.findIndex((server) => server.id === current);
        const index = currentIndex >= 0 ? currentIndex : (event.key === 'ArrowDown' ? -1 : 0);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = state.servers[(index + delta + state.servers.length) % state.servers.length];
        if (next) void state.openServer(next.id);
        return;
      }
      if (event.key === 'Escape') {
        const state = useStore.getState();
        if (state.view !== 'server' || !state.active) return;
        const lastSid = [...(getEngine()?.getSnapshot().messages || [])].reverse().find((message) => message.sid != null)?.sid || 0;
        event.preventDefault();
        state.markRead(state.active.id, lastSid, true);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [me, quickSwitcherOpen, shortcutHelpOpen]);

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
    const releasePtt = () => {
      pressed.clear();
      (Object.keys(armed) as KeybindAction[]).forEach((action) => { armed[action] = false; });
      getEngine()?.forcePttRelease();
    };
    const onVisibility = () => { if (document.visibilityState !== 'visible') releasePtt(); };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    window.addEventListener('blur', releasePtt); document.addEventListener('visibilitychange', onVisibility);
    return () => {
      releasePtt();
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', releasePtt); document.removeEventListener('visibilitychange', onVisibility);
    };
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
      {me ? <ConnectivityBanner /> : null}
      {me ? <IosPwaInstallPrompt /> : null}
      {me ? <NotificationPermissionPrompt /> : null}
      {me ? <QuickSwitcher open={quickSwitcherOpen} onClose={() => setQuickSwitcherOpen(false)} /> : null}
      {me ? <ShortcutHelp open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} /> : null}
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

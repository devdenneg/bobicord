import { create } from 'zustand';
import { api, setToken } from './api';
import { Engine } from './engine';
import { emoteMap } from './emotes';
import { setSettings } from './settings';
import { notifPermission } from './notify';
import { ensurePushSubscribed, unsubscribePush } from './push';
import { connectNotifyWs, disconnectNotifyWs } from './notifyws';
import { startIdleWatch } from './idle';
import { initMusic } from './music';
import { preloadSounds } from './sounds';
import { isTauri, stopNativeBroadcast } from './native';
import { endAnyBroadcasterSession, flushPendingDiag } from './diag';
import type { User, ServerSummary, Member, ServerDetail, Toast, ToastKind } from './types';

let engine: Engine | null = null;
export const getEngine = () => engine;

let saveTimer: number | null = null;

interface AppState {
  view: 'loading' | 'auth' | 'home' | 'server' | 'admin';
  me: User | null;
  servers: ServerSummary[];
  active: ServerDetail | null;
  members: Member[];
  loadingServer: boolean;
  loadingServerId: string | null;
  // сервер, к которому реально подключены (комната/чат/голос). Переживает уход на главную —
  // соединение НЕ рвём, пока не переключишься на другой сервер или не выйдешь.
  viewServerId: string | null;
  // Какой мобильный экран открыть после перехода с главной: голос, чат/эфир или люди.
  // Это только UI-intent, на соединение и медиа-движок не влияет.
  serverEntryTab: 'channels' | 'main' | 'members';
  pendingSwitchId: string | null; // цель для модалки подтверждения переключения сервера
  updateReady: boolean;
  // доступное обновление НАТИВА (Tauri updater); obj — Update из @tauri-apps/plugin-updater
  nativeUpdate: { version: string; obj: any } | null;
  emoteSize: 'sm' | 'md' | 'lg';
  toasts: Toast[];
  modal: null | 'create' | 'join' | 'profile' | 'srvmenu' | 'invite' | 'srvsettings' | 'settings' | 'broadcast' | 'switchServer' | 'downloads' | 'leaderboard';
  joinPrefill: string;
  broadcastLive: boolean;
  unread: Record<string, number>; // непрочитанные по серверам (бейдж в рейле/таскбаре)
  lastRead: Record<string, number>; // id последнего прочитанного (базовая линия дивайдера «новые»)

  toast: (text: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;
  setModal: (m: AppState['modal'], prefill?: string) => void;
  setBroadcastLive: (v: boolean) => void;

  afterAuth: (user: User) => Promise<void>;
  loadMe: () => Promise<void>;
  logout: () => void;
  openServer: (id: string, watchUser?: string, entryTab?: 'channels' | 'main' | 'members') => Promise<void>; // watchUser — авто-запуск просмотра стримера после входа (CTA «Смотреть» с главной)
  watchAfterEnter: (serverId: string, username: string) => void;
  connectServer: (id: string) => Promise<void>;       // фактический (ре)коннект к серверу
  showConnectedServer: (id: string) => Promise<void>; // показать уже подключённый сервер без реконнекта
  confirmSwitchServer: () => void;                     // подтверждение модалки переключения
  exitServer: () => void;                              // полное отключение от сервера + на главную (leave/delete/ошибка)
  goHome: () => void;
  goAdmin: () => void;                                 // открыть админ-панель (/admin, только для админов)
  refreshServers: () => Promise<void>;
  markRead: (serverId: string, lastId: number, all?: boolean) => void;   // отметить прочитанным (в самом низу чата); all — «прочитать всё» (сервер last_read=MAX)
  bumpUnread: (serverId: string, n?: number) => void;     // +новое (чат/системное) когда не читаем сервер
  applyRemoteRead: (serverId: string, lastRead: number) => void; // прочитано на ДРУГОМ устройстве (notify-WS)
  refreshMembers: () => Promise<void>;
  refreshServer: () => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  renameChannel: (cid: string, name: string) => Promise<void>;
  deleteChannel: (cid: string) => Promise<void>;
  setMe: (u: User) => void;
  setEmoteSize: (s: 'sm' | 'md' | 'lg') => void;
}

let memberTimer: number | null = null;
// Эпоха соединения: инкрементится каждый раз, когда engine-коннект РВЁТСЯ или ЗАМЕНЯЕТСЯ
// (connectServer/exitServer/logout). Фоновые async-хвосты (connect IIFE, member-poll) захватывают
// эпоху на старте и сверяют перед записью в стор/engine — иначе протухший хвост прошлого сервера
// пишет своё состояние поверх текущего или рвёт живую комнату. goHome НЕ бампит (соединение живёт).
let viewEpoch = 0;
// Каждый новый presence-poll делает все более ранние ответы неактуальными. Одного viewEpoch
// недостаточно: два запроса одного и того же сервера могут завершиться в обратном порядке.
let memberPollRequestSeq = 0;

// поллинг состава/пресенса активного сервера (5с). Работает только пока смотрим этот сервер.
function startMemberPoll(id: string) {
  if (memberTimer) clearInterval(memberTimer);
  memberPollRequestSeq++; // инвалидировать уже летящий poll, даже если сервер и epoch не сменились
  const epoch = viewEpoch;
  const poll = async () => {
    const st = useStore.getState();
    if (st.view !== 'server' || st.viewServerId !== id || viewEpoch !== epoch) return;
    const requestSeq = ++memberPollRequestSeq;
    try {
      const [srv, prs] = await Promise.all([api.getServer(id), api.presence(id)]);
      // повторный гард ПОСЛЕ await: за время сети юзер мог переключить/покинуть сервер — иначе
      // протухший ответ пишет состав/пресенс чужого сервера в стор и engine (чинилось только 5с спустя)
      const st2 = useStore.getState();
      if (st2.view !== 'server' || st2.viewServerId !== id || viewEpoch !== epoch || requestSeq !== memberPollRequestSeq) return;
      // Обновляем и СВОИ роль/права (myRole/myPerms), не только channels: раньше спред ...st2.active
      // сохранял старые myRole/myPerms → выданные владельцем роль/права не появлялись до F5/реконнекта
      // (getServer их отдаёт, но поллер выбрасывал). Плюс имя/роли сервера — на случай их правки.
      useStore.setState({ members: srv.members, active: st2.active && st2.active.id === id ? { ...st2.active, ...srv.server, myRole: srv.myRole, myPerms: srv.myPerms } : st2.active });
      engine?.setMembers(srv.members); engine?.setOnlineHint(prs.online); engine?.setAwayHint(prs.away || []); engine?.setVoiceHint(prs.voice || {});
    } catch { /**/ }
  };
  memberTimer = window.setInterval(poll, 5000);
}

// Бейдж на иконке приложения (таскбар PWA / dock) — сумма непрочитанных + флаг обновления.
// App Badging API: в установленной PWA на Windows рисует бейдж на иконке в таскбаре.
// В НАТИВЕ (Tauri) App Badging в WebView2 на таскбаре не рисует → отдельно ставим Windows
// overlay-иконку (setOverlayIcon) — красный кружок с числом в углу иконки, как у Discord/Telegram.
function updateAppBadge() {
  try {
    const st = useStore.getState();
    let total = st.updateReady ? 1 : 0;
    for (const k in st.unread) total += st.unread[k] || 0;
    const n: any = navigator as any;
    if (total > 0) n.setAppBadge?.(total); else n.clearAppBadge?.();
    if (isTauri) setNativeBadge(total);
  } catch { /**/ }
}
// Windows overlay-иконка таскбара (натив). Перерисовываем PNG только при СМЕНЕ числа (updateAppBadge
// дёргается на каждое сообщение). undefined снимает оверлей.
let lastNativeBadge = -1;
async function setNativeBadge(total: number) {
  if (total === lastNativeBadge) return;
  lastNativeBadge = total;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (total <= 0) { await win.setOverlayIcon(undefined); return; }
    const png = await badgePng(total);
    if (png) await win.setOverlayIcon(png); else await win.setOverlayIcon(undefined);
  } catch { /**/ }
}
// Рисуем бейдж (красный кружок + число, «9+» при >9) в PNG-байты для setOverlayIcon.
function badgePng(nRaw: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    try {
      const S = 32; // Windows скалит оверлей до 16×16 — рисуем крупнее для чёткости
      const c = document.createElement('canvas'); c.width = S; c.height = S;
      const g = c.getContext('2d'); if (!g) { resolve(null); return; }
      const label = nRaw > 9 ? '9+' : String(nRaw);
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2); g.fillStyle = '#ed4245'; g.fill();
      g.fillStyle = '#fff'; g.font = `bold ${label.length > 1 ? 17 : 22}px "Segoe UI", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, S / 2, S / 2 + 1);
      c.toBlob((b) => {
        if (!b) { resolve(null); return; }
        b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(() => resolve(null));
      }, 'image/png');
    } catch { resolve(null); }
  });
}
// Слить серверные счётчики непрочитанного. Поллингом НЕ трогаем ТОЛЬКО сервер, чат которого сейчас
// РЕАЛЬНО открыт (view==='server' && active===id) — там unread ведёт смонтированный ServerView
// (bumpUnread/markRead по факту чтения), иначе моргнёт до долёта markRead. На главной / другом сервере
// ServerView размонтирован → его сервер надо считать поллингом сервер-авторитетно (иначе, оставаясь
// «подключённым» после goHome, он бы навсегда завис на старом счётчике — новые сообщения не считались).
function mergeUnread(map: Record<string, number>) {
  const st = useStore.getState();
  const viewing = st.view === 'server' ? st.active?.id : undefined;
  const next = { ...st.unread };
  for (const id in map) if (id !== viewing) next[id] = map[id];
  useStore.setState({ unread: next });
  updateAppBadge();
}
let unreadTimer: number | null = null;

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  view: 'loading', me: null, servers: [], active: null, members: [], loadingServer: false, loadingServerId: null, viewServerId: null, serverEntryTab: 'channels', pendingSwitchId: null, updateReady: false, nativeUpdate: null, emoteSize: (localStorage.getItem('emoteSize') as 'sm' | 'md' | 'lg') || 'md', toasts: [], modal: null, joinPrefill: '', broadcastLive: false, unread: {}, lastRead: {},

  toast: (text, kind) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind: kind || 'info' }].slice(-3) }));
    setTimeout(() => get().dismissToast(id), 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setModal: (m, prefill) => set({ modal: m, joinPrefill: prefill ?? get().joinPrefill }),
  setBroadcastLive: (v) => set({ broadcastLive: v }),

  setMe: (u) => { engine?.setMe(u); set({ me: u }); },
  setEmoteSize: (s) => { localStorage.setItem('emoteSize', s); set({ emoteSize: s }); },

  afterAuth: async (user) => {
    // Досылаем диаг-сессии, не ушедшие в прошлый раз (сеть моргнула / апп закрыли на
    // остановке стрима). Именно здесь: токен уже есть, иначе сервер вернул бы 401 и
    // очередь очистилась бы впустую. Фоном — стартовать приложение это не задерживает.
    flushPendingDiag().catch(() => {});
    engine = new Engine(user, {
      toast: (t, k) => get().toast(t, k),
      saveSettings: (serverId, vols) => {
        if (!serverId) return;
        localStorage.setItem('srvset:' + serverId, JSON.stringify(vols));
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => { api.putSettings(serverId, vols).catch(() => {}); }, 800);
      },
      peerJoined: (id) => { if (!get().members.some((m) => m.username === id)) get().refreshMembers(); },
      persistMessage: (text, em, image, reply, localId, key, files, kind, level) => {
        const a = get().active;
        if (!a) { engine?.markSendResult(localId, false); return; }
        api.postMessage(a.id, text, em, image, reply, key, files, kind, level)
          .then((r) => engine?.markSendResult(localId, true, r?.id))
          .catch(() => engine?.markSendResult(localId, false));
      },
      refetchChat: (sid) => {
        const a = get().active; if (!a) return;
        const id = a.id, epoch = viewEpoch, targetEngine = engine;
        const exactCursor = sid != null && Number.isSafeInteger(sid) ? sid + 1 : undefined;
        api.getMessages(id, exactCursor, exactCursor == null ? 30 : 1).then((d) => {
          const current = get();
          if (viewEpoch !== epoch || current.viewServerId !== id || current.active?.id !== id || engine !== targetEngine) return;
          targetEngine?.mergeRecent(d.messages);
        }).catch(() => {});
      },
      // Let the engine observe failures so it can roll optimistic state back.
      reactMessage: (serverId, sid, emoteId, emoteName, add) => api.reactMessage(serverId, sid, emoteId, emoteName, add).then(() => undefined),
      editMessage: (serverId, sid, text) => { api.editMessage(serverId, sid, text).catch(() => {}); },
      deleteMessage: (serverId, sid) => { api.deleteMessage(serverId, sid).catch(() => {}); },
      // выход из голосового → гасим нативную трансляцию (Rust-дерево) + сбрасываем флаг (browser-share гасит engine.stopShare)
      endBroadcast: () => { if (isTauri) stopNativeBroadcast().catch(() => {}).finally(() => endAnyBroadcasterSession()); get().setBroadcastLive(false); },
      connectionLost: (serverId, _voiceChannel, wasViewing) => {
        // Terminal LiveKit disconnect уже не восстановится внутренним reconnect. Если это открытый
        // сервер — получаем свежий token через штатный retry connectServer; голос не захватываем
        // автоматически, чтобы старый ПК после offline не выбил активный телефон.
        if (wasViewing && get().viewServerId === serverId && get().view === 'server') void get().connectServer(serverId);
      },
    });
    engine.onEmoteResolve = (name, id) => emoteMap.set(name, id);
    set({ me: user });
    await get().loadMe();
    set({ view: 'home' });
    // Web-push: перепривязываем подписку к ТЕКУЩЕМУ аккаунту (endpoint переживает смену юзера/reload,
    // на сервере ON CONFLICT перезапишет user_id). Зовём НАПРЯМУЮ, минуя глобальный notifOptOut-гейт
    // initNotifications — иначе опт-аут прошлого юзера навсегда лишал бы нового push. Только при уже
    // выданном разрешении; master включаем, т.к. на этом устройстве уведомления уже разрешены.
    if (notifPermission() === 'granted') { setSettings({ notif: true }); localStorage.removeItem('notifOptOut'); ensurePushSubscribed(); }
    connectNotifyWs(); // глобальный live-канал уведомлений (любой сервер, даже не подключённый)
    startIdleWatch();  // away-детект: апп давно не трогали → жёлтый статус (шлётся по notify-WS)
    initMusic();       // совместное прослушивание: подписка на music-синк по data-каналу голосовой
    preloadSounds(); // прогреть звуки (fetch+decode+нормализация громкости) — первый проигрыш без задержки
    const pend = sessionStorage.getItem('pendingInvite');
    if (pend) { sessionStorage.removeItem('pendingInvite'); set({ modal: 'join', joinPrefill: pend }); }
  },

  loadMe: async () => {
    const d = await api.me();
    engine?.setMe(d.user);
    set((st) => { const lr = { ...st.lastRead }; for (const s of d.servers) if (lr[s.id] === undefined) lr[s.id] = s.lastRead || 0; return { me: d.user, servers: d.servers, lastRead: lr }; });
    mergeUnread(Object.fromEntries(d.servers.map((s) => [s.id, s.unread || 0])));
    // лёгкий поллинг непрочитанного по всем серверам (для НЕ активных — активный ведёт клиент)
    if (unreadTimer) clearInterval(unreadTimer);
    unreadTimer = window.setInterval(async () => { try { mergeUnread(await api.getUnread()); } catch { /**/ } }, 30000);
  },
  refreshServers: async () => { try { const d = await api.me(); set({ servers: d.servers }); mergeUnread(Object.fromEntries(d.servers.map((s) => [s.id, s.unread || 0]))); } catch { /**/ } },
  markRead: (serverId, lastId, all) => {
    set((s) => ({ lastRead: { ...s.lastRead, [serverId]: Math.max(s.lastRead[serverId] || 0, lastId) } }));
    const hadUnread = (get().unread[serverId] || 0) > 0;
    if (hadUnread) { set((s) => ({ unread: { ...s.unread, [serverId]: 0 } })); updateAppBadge(); }
    // POST: при all — ВСЕГДА (двигаем серверный last_read за живые sid-less сообщения, даже когда локально
    // unread уже 0 — иначе прочитанное живое считается непрочитанным на главной/др. устройстве); иначе —
    // только если было что чистить (не спамим). Ответ несёт актуальный серверный last_read → синкаем.
    if (!all && !hadUnread) return;
    api.markRead(serverId, lastId, all).then((r) => {
      if (r?.lastRead) set((s) => ({ lastRead: { ...s.lastRead, [serverId]: Math.max(s.lastRead[serverId] || 0, r.lastRead) } }));
    }).catch(() => {});
  },
  bumpUnread: (serverId, n = 1) => { set((s) => ({ unread: { ...s.unread, [serverId]: (s.unread[serverId] || 0) + n } })); updateAppBadge(); },
  // кросс-девайс: прочитано на ДРУГОМ устройстве (notify-WS t:read, БД read_state — источник правды) →
  // сбрасываем unread локально и двигаем базовую линию дивайдера. Работает И для ПОДКЛЮЧЁННОГО сервера
  // (mergeUnread его пропускает — клиент ведёт unread сам, поэтому без этого badge завис бы до реконнекта).
  applyRemoteRead: (serverId, lastRead) => {
    set((s) => ({ unread: { ...s.unread, [serverId]: 0 }, lastRead: { ...s.lastRead, [serverId]: Math.max(s.lastRead[serverId] || 0, lastRead) } }));
    updateAppBadge();
  },
  refreshMembers: async () => {
    const a = get().active; if (!a) return;
    const id = a.id, epoch = viewEpoch, targetEngine = engine;
    try {
      const d = await api.getServer(id);
      const current = get();
      if (viewEpoch !== epoch || current.viewServerId !== id || current.active?.id !== id || engine !== targetEngine) return;
      set({ members: d.members });
      targetEngine?.setMembers(d.members);
    } catch { /**/ }
  },
  refreshServer: async () => {
    const a = get().active; if (!a) return;
    const id = a.id, epoch = viewEpoch, targetEngine = engine;
    try {
      const d = await api.getServer(id);
      const current = get();
      if (viewEpoch !== epoch || current.viewServerId !== id || current.active?.id !== id || engine !== targetEngine) return;
      set({ members: d.members, active: { ...d.server, myRole: d.myRole, myPerms: d.myPerms } });
      targetEngine?.setMembers(d.members);
    } catch { /**/ }
  },

  createChannel: async (name) => {
    const a = get().active; if (!a) return;
    const d = await api.createChannel(a.id, name); // ошибка (лимит/права) пробрасывается — форма покажет
    const cur = get().active; if (cur && cur.id === a.id) set({ active: { ...cur, channels: d.channels } });
  },
  renameChannel: async (cid, name) => {
    const a = get().active; if (!a) return;
    try { const d = await api.renameChannel(a.id, cid, name); const cur = get().active; if (cur && cur.id === a.id) set({ active: { ...cur, channels: d.channels } }); }
    catch (e: any) { get().toast(e.message, 'err'); }
  },
  deleteChannel: async (cid) => {
    const a = get().active; if (!a) return;
    try { const d = await api.deleteChannel(a.id, cid); const cur = get().active; if (cur && cur.id === a.id) set({ active: { ...cur, channels: d.channels } }); }
    catch (e: any) { get().toast(e.message, 'err'); }
  },

  logout: async () => {
    viewEpoch++; engine?.disconnect();
    // отписываем web-push ПОКА токен ещё текущего юзера (api.pushUnsubscribe шлёт Bearer) —
    // иначе endpoint остаётся привязан к нему на сервере и его push летели бы следующему юзеру.
    // cap 2с, чтобы разлогин не подвисал на мёртвой сети.
    try { await Promise.race([unsubscribePush(), new Promise((r) => setTimeout(r, 2000))]); } catch { /**/ }
    disconnectNotifyWs();
    setToken(null); location.reload();
  },

  // Точка входа по клику на сервер. Просмотр СВОБОДНЫЙ (голос не рвём, модалки переключения больше нет):
  // уже смотрю → no-op; смотримая комната уже на id (вернулся с главной) → мгновенный показ; иначе — вход
  // (connectServer сам решит: реюз живой голосовой комнаты или новый view-коннект).
  openServer: async (id, watchUser, entryTab) => {
    // Стрим всегда открываем сразу на сцене; обычный вход — в голосе, если вызывающий не уточнил intent.
    set({ serverEntryTab: entryTab || (watchUser ? 'main' : 'channels') });
    const s = get();
    if (s.loadingServerId === id) return;                     // уже открываем этот сервер
    if (s.view === 'server' && s.active?.id === id) { if (watchUser) get().watchAfterEnter(id, watchUser); return; } // уже смотрим его
    if (s.viewServerId === id) { await get().showConnectedServer(id); if (watchUser) get().watchAfterEnter(id, watchUser); return; } // смотримая комната уже на id
    await get().connectServer(id);
    if (watchUser) get().watchAfterEnter(id, watchUser);
  },

  // Авто-просмотр после входа (CTA «Смотреть» с главной): ждём, пока discovery объявит стрим (тогда
  // transportFor выберет верный транспорт), затем engine.watch. Гард по viewServerId — уход с сервера
  // отменяет. Стрим не появился за окно → стример ушёл офлайн, тихий тост.
  watchAfterEnter: (serverId, username) => {
    if (username === get().me?.username) return; // ведущий стример — я сам: свой стрим не смотрим
    const deadline = Date.now() + 12000;
    const tick = () => {
      if (get().viewServerId !== serverId || get().view !== 'server') return; // ушли — отмена
      if (engine?.isStreamLive(username)) { engine.watch(username); return; }
      if (Date.now() > deadline) { get().toast('Трансляция уже завершилась', 'info'); return; }
      setTimeout(tick, 400);
    };
    tick();
  },

  // Показать сервер, к которому уже подключены (вернулись с главной) — мгновенно, без реконнекта.
  showConnectedServer: async (id) => {
    // active/members уже в сторе (сохранены при уходе на главную) → показываем сразу, без скелетона
    set({ view: 'server', loadingServer: false, loadingServerId: null });
    startMemberPoll(id);
    // подтянуть свежий состав/пресенс (соединение и история уже живые)
    try {
      const [srv, pres] = await Promise.all([api.getServer(id), api.presence(id).catch(() => null)]);
      if (get().viewServerId !== id || get().view !== 'server') return;
      set({ members: srv.members, active: { ...srv.server, myRole: srv.myRole, myPerms: srv.myPerms } });
      engine?.setMembers(srv.members); if (pres) { engine?.setOnlineHint(pres.online); engine?.setAwayHint(pres.away || []); engine?.setVoiceHint(pres.voice || {}); }
    } catch { /**/ }
  },

  // Фактический (ре)коннект: рвём прошлое соединение и поднимаем новое.
  connectServer: async (id) => {
    const myEpoch = ++viewEpoch; // новый коннект — предыдущие async-хвосты устаревают
    if (memberTimer) clearInterval(memberTimer);
    // Вход на СВОЙ голосовой сервер → реюз живой голосовой комнаты как смотримой (без 2-го коннекта к тому же
    // srv = без само-дубля/эха). Иначе — отцепляем прежнюю смотримую; голос НЕ трогаем (браузинг больше не рвёт голос).
    const reuse = !!engine && engine.getSnapshot().voiceServerId === id;
    if (reuse) engine?.reuseVoiceAsView(); else engine?.detachView();
    set({ view: 'server', loadingServer: true, loadingServerId: id, active: null, members: [], viewServerId: id });
    try {
      // сохранённые громкости из localStorage — синхронно, до сети (иначе слайдеры = 100%)
      const cache = JSON.parse(localStorage.getItem('srvset:' + id) || 'null');
      if (cache) engine?.setVols(id, cache);
      // КРИТИЧНОЕ для первой отрисовки — параллельно; тяжёлый WebRTC-connect уходит в фон (ниже).
      const [d, hist, settings, pres] = await Promise.all([
        api.getServer(id),
        api.getMessages(id, undefined, 30).catch(() => ({ messages: [], hasMore: false })),
        api.getSettings(id).catch(() => null),
        api.presence(id).catch(() => null),
      ]);
      if (viewEpoch !== myEpoch || get().loadingServerId !== id) return; // юзер уже переключился/перезапустил этот же connect
      const active: ServerDetail = { ...d.server, myRole: d.myRole, myPerms: d.myPerms };
      if (settings?.data && (settings.data.users || settings.data.streams)) engine?.setVols(id, settings.data);
      engine?.setMembers(d.members);
      if (pres) { engine?.setOnlineHint(pres.online); engine?.setAwayHint(pres.away || []); engine?.setVoiceHint(pres.voice || {}); }
      engine?.loadHistory(hist.messages, hist.hasMore);
      if (hist.messages.length === 0) engine?.sysMsg('Ты на сервере «' + active.name + '». Чат доступен сразу — голос по кнопке «Подключиться».');
      // ВСЁ критичное готово → показываем сервер немедленно (не ждём комнату)
      set({ active, members: d.members, loadingServer: false, loadingServerId: null });
      if (!localStorage.getItem('onboardedSrv')) {
        localStorage.setItem('onboardedSrv', '1');
        engine?.sysMsg('👋 Ты в чате, но НЕ в голосовом. Нажми «Подключиться», чтобы говорить. Справа — кто в сети и кто в голосовом.');
      }
      // WebRTC-коннект к НОВОЙ смотримой комнате — В ФОНЕ; гард по эпохе (переживает уход на главную через
      // goHome, который эпоху не бампит). Эпоха сменилась (свитч/выход) — НЕ рвём engine: им уже владеет
      // новый connectServer. При РЕЮЗЕ (вход на свой голосовой сервер) коннект НЕ нужен — комната уже живая.
      if (!reuse) (async () => {
        // Ретрай с backoff: одиночная транзиентная осечка (сетевой блип, таймаут WS-handshake
        // LiveKit, пересборка контейнеров при деплое) НЕ должна сразу пугать тостом и рвать
        // соединение — почти всегда лечится повтором. Тост только если все попытки провалились.
        const delays = [1500, 3000, 5000]; // паузы ПОСЛЕ 1-й, 2-й, 3-й неудачи; 4 попытки, ~9.5с суммарно
        for (let i = 0; i <= delays.length; i++) {
          if (viewEpoch !== myEpoch) return; // устарели — engine уже принадлежит новому connect
          try {
            const tk = await api.serverToken(id);
            if (viewEpoch !== myEpoch) return;
            await engine?.connect(tk.url, tk.token, id, tk.sessionId);
            return; // успех
          } catch {
            if (viewEpoch !== myEpoch) return; // устарели во время попытки
            if (i < delays.length) { await new Promise((r) => setTimeout(r, delays[i])); continue; }
          }
        }
        // все попытки провалились: сбрасываем viewServerId, иначе повторный клик уходит в
        // showConnectedServer (без реконнекта) и realtime мёртв до F5. Теперь клик = полный вход.
        if (viewEpoch === myEpoch && get().viewServerId === id) {
          set({ viewServerId: null });
          get().toast('Realtime-связь не поднялась — зайди на сервер заново', 'warn');
        }
      })();
      startMemberPoll(id);
    } catch (e: any) {
      // Ошибка старого A-connect не имеет права закрыть уже открываемый B (или более свежий retry A).
      if (viewEpoch !== myEpoch) return;
      get().toast(e.message, 'err'); get().exitServer();
    }
  },

  // Подтверждение модалки переключения: рвём текущее соединение и коннектимся к цели.
  confirmSwitchServer: () => {
    const target = get().pendingSwitchId;
    set({ modal: null, pendingSwitchId: null });
    if (target) get().connectServer(target);
  },

  // Полное отключение от сервера + на главную (выход/удаление сервера/ошибка коннекта).
  exitServer: () => {
    viewEpoch++; // in-flight connect/poll прошлого сервера устаревают
    if (memberTimer) clearInterval(memberTimer);
    // Покидаю СМОТРИМЫЙ сервер (leave/delete/ошибка). Если я в голосе ИМЕННО на нём — выхожу и из голоса
    // (полный teardown); иначе голос на другом сервере — оставляем, отцепляем только просмотр.
    const voiceSrv = engine?.getSnapshot().voiceServerId;
    if (voiceSrv && voiceSrv === get().viewServerId) engine?.disconnect(); else engine?.detachView();
    set({ active: null, members: [], loadingServer: false, loadingServerId: null, viewServerId: null, view: 'home' });
    get().refreshServers();
  },

  // На главную БЕЗ отключения от сервера — соединение (чат/голос/пресенс) живёт, возврат мгновенный.
  goHome: () => { if (memberTimer) clearInterval(memberTimer); if (location.pathname !== '/') history.replaceState({}, '', '/'); set({ view: 'home' }); get().refreshServers(); },
  goAdmin: () => { if (location.pathname !== '/admin') history.pushState({}, '', '/admin'); set({ view: 'admin' }); },
}));

// доступное обновление тоже добавляет +1 к бейджу таскбара
useStore.subscribe((s, prev) => { if (s.updateReady !== prev.updateReady) updateAppBadge(); });

export function orderedMembers(members: Member[], presence: Record<string, { online: boolean }>): { online: Member[]; offline: Member[] } {
  const online: Member[] = [], offline: Member[] = [];
  for (const m of members) (presence[m.username]?.online ? online : offline).push(m);
  return { online, offline };
}

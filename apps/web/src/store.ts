import { create } from 'zustand';
import { api, setToken } from './api';
import { Engine } from './engine';
import { emoteMap } from './emotes';
import type { User, ServerSummary, Member, ServerDetail, Toast, ToastKind } from './types';

let engine: Engine | null = null;
export const getEngine = () => engine;

let saveTimer: number | null = null;

interface AppState {
  view: 'loading' | 'auth' | 'home' | 'server';
  me: User | null;
  servers: ServerSummary[];
  active: ServerDetail | null;
  members: Member[];
  loadingServer: boolean;
  loadingServerId: string | null;
  // сервер, к которому реально подключены (комната/чат/голос). Переживает уход на главную —
  // соединение НЕ рвём, пока не переключишься на другой сервер или не выйдешь.
  connectedServerId: string | null;
  pendingSwitchId: string | null; // цель для модалки подтверждения переключения сервера
  updateReady: boolean;
  // доступное обновление НАТИВА (Tauri updater); obj — Update из @tauri-apps/plugin-updater
  nativeUpdate: { version: string; obj: any } | null;
  emoteSize: 'sm' | 'md' | 'lg';
  toasts: Toast[];
  modal: null | 'create' | 'join' | 'profile' | 'srvmenu' | 'invite' | 'srvsettings' | 'settings' | 'broadcast' | 'switchServer';
  joinPrefill: string;
  broadcastLive: boolean;

  toast: (text: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;
  setModal: (m: AppState['modal'], prefill?: string) => void;
  setBroadcastLive: (v: boolean) => void;

  afterAuth: (user: User) => Promise<void>;
  loadMe: () => Promise<void>;
  logout: () => void;
  openServer: (id: string) => Promise<void>;
  connectServer: (id: string) => Promise<void>;       // фактический (ре)коннект к серверу
  showConnectedServer: (id: string) => Promise<void>; // показать уже подключённый сервер без реконнекта
  confirmSwitchServer: () => void;                     // подтверждение модалки переключения
  exitServer: () => void;                              // полное отключение от сервера + на главную (leave/delete/ошибка)
  goHome: () => void;
  refreshServers: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  refreshServer: () => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  renameChannel: (cid: string, name: string) => Promise<void>;
  deleteChannel: (cid: string) => Promise<void>;
  setMe: (u: User) => void;
  setEmoteSize: (s: 'sm' | 'md' | 'lg') => void;
}

let memberTimer: number | null = null;

// поллинг состава/пресенса активного сервера (5с). Работает только пока смотрим этот сервер.
function startMemberPoll(id: string) {
  if (memberTimer) clearInterval(memberTimer);
  const poll = async () => {
    const st = useStore.getState();
    if (st.view !== 'server' || st.connectedServerId !== id) return;
    try {
      const [srv, prs] = await Promise.all([api.getServer(id), api.presence(id)]);
      const cur = useStore.getState().active;
      useStore.setState({ members: srv.members, active: cur && cur.id === id ? { ...cur, channels: srv.server.channels } : cur });
      engine?.setMembers(srv.members); engine?.setOnlineHint(prs.online);
    } catch { /**/ }
  };
  memberTimer = window.setInterval(poll, 5000);
}

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  view: 'loading', me: null, servers: [], active: null, members: [], loadingServer: false, loadingServerId: null, connectedServerId: null, pendingSwitchId: null, updateReady: false, nativeUpdate: null, emoteSize: (localStorage.getItem('emoteSize') as 'sm' | 'md' | 'lg') || 'md', toasts: [], modal: null, joinPrefill: '', broadcastLive: false,

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
    engine = new Engine(user, {
      toast: (t, k) => get().toast(t, k),
      saveSettings: (vols) => {
        const a = get().active; if (!a) return;
        localStorage.setItem('srvset:' + a.id, JSON.stringify(vols));
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => { api.putSettings(a.id, vols).catch(() => {}); }, 800);
      },
      peerJoined: (id) => { if (!get().members.some((m) => m.username === id)) get().refreshMembers(); },
      persistMessage: (text, em, image, reply) => { const a = get().active; if (a) api.postMessage(a.id, text, em, image, reply).catch(() => {}); },
    });
    engine.onEmoteResolve = (name, id) => emoteMap.set(name, id);
    set({ me: user });
    await get().loadMe();
    set({ view: 'home' });
    const pend = sessionStorage.getItem('pendingInvite');
    if (pend) { sessionStorage.removeItem('pendingInvite'); set({ modal: 'join', joinPrefill: pend }); }
  },

  loadMe: async () => {
    const d = await api.me();
    engine?.setMe(d.user);
    set({ me: d.user, servers: d.servers });
  },
  refreshServers: async () => { try { const d = await api.me(); set({ servers: d.servers }); } catch { /**/ } },
  refreshMembers: async () => { const a = get().active; if (!a) return; try { const d = await api.getServer(a.id); set({ members: d.members }); engine?.setMembers(d.members); } catch { /**/ } },
  refreshServer: async () => { const a = get().active; if (!a) return; try { const d = await api.getServer(a.id); set({ members: d.members, active: { ...d.server, myRole: d.myRole, myPerms: d.myPerms } }); engine?.setMembers(d.members); } catch { /**/ } },

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

  logout: () => { engine?.disconnect(); setToken(null); location.reload(); },

  // Точка входа по клику на сервер. Решает: показать уже подключённый / предупредить о переключении / коннектить.
  openServer: async (id) => {
    const s = get();
    if (s.loadingServerId === id) return;                     // уже открываем этот сервер
    if (s.view === 'server' && s.active?.id === id) return;    // уже смотрим его
    if (s.connectedServerId === id) { await get().showConnectedServer(id); return; } // подключены → показать без реконнекта
    if (s.connectedServerId) { set({ modal: 'switchServer', pendingSwitchId: id }); return; } // подключены к другому → модалка
    await get().connectServer(id);                            // ни к чему не подключены → полный вход
  },

  // Показать сервер, к которому уже подключены (вернулись с главной) — мгновенно, без реконнекта.
  showConnectedServer: async (id) => {
    // active/members уже в сторе (сохранены при уходе на главную) → показываем сразу, без скелетона
    set({ view: 'server', loadingServer: false, loadingServerId: null });
    startMemberPoll(id);
    // подтянуть свежий состав/пресенс (соединение и история уже живые)
    try {
      const [srv, pres] = await Promise.all([api.getServer(id), api.presence(id).catch(() => null)]);
      if (get().connectedServerId !== id || get().view !== 'server') return;
      set({ members: srv.members, active: { ...srv.server, myRole: srv.myRole, myPerms: srv.myPerms } });
      engine?.setMembers(srv.members); if (pres) engine?.setOnlineHint(pres.online);
    } catch { /**/ }
  },

  // Фактический (ре)коннект: рвём прошлое соединение и поднимаем новое.
  connectServer: async (id) => {
    if (memberTimer) clearInterval(memberTimer);
    engine?.disconnect();
    set({ view: 'server', loadingServer: true, loadingServerId: id, active: null, members: [], connectedServerId: id });
    try {
      // сохранённые громкости из localStorage — синхронно, до сети (иначе слайдеры = 100%)
      const cache = JSON.parse(localStorage.getItem('srvset:' + id) || 'null');
      if (cache) engine?.setVols(cache);
      // КРИТИЧНОЕ для первой отрисовки — параллельно; тяжёлый WebRTC-connect уходит в фон (ниже).
      const [d, hist, settings, pres] = await Promise.all([
        api.getServer(id),
        api.getMessages(id, undefined, 30).catch(() => ({ messages: [], hasMore: false })),
        api.getSettings(id).catch(() => null),
        api.presence(id).catch(() => null),
      ]);
      if (get().loadingServerId !== id) return; // юзер уже переключился
      const active: ServerDetail = { ...d.server, myRole: d.myRole, myPerms: d.myPerms };
      if (settings?.data && (settings.data.users || settings.data.streams)) engine?.setVols(settings.data);
      engine?.setMembers(d.members);
      if (pres) engine?.setOnlineHint(pres.online);
      engine?.loadHistory(hist.messages, hist.hasMore);
      if (hist.messages.length === 0) engine?.sysMsg('Ты на сервере «' + active.name + '». Чат доступен сразу — голос по кнопке «Подключиться».');
      // ВСЁ критичное готово → показываем сервер немедленно (не ждём комнату)
      set({ active, members: d.members, loadingServer: false, loadingServerId: null });
      if (!localStorage.getItem('onboardedSrv')) {
        localStorage.setItem('onboardedSrv', '1');
        engine?.sysMsg('👋 Ты в чате, но НЕ в голосовом. Нажми «Подключиться», чтобы говорить. Справа — кто в сети и кто в голосовом.');
      }
      // WebRTC-коннект к комнате — В ФОНЕ; guard по connectedServerId (переживает уход на главную)
      (async () => {
        try {
          const tk = await api.serverToken(id);
          if (get().connectedServerId !== id) return; // уже переключились на другой сервер
          await engine?.connect(tk.url, tk.token, id);
          if (get().connectedServerId !== id) engine?.disconnect();
        } catch {
          if (get().connectedServerId === id) get().toast('Realtime-связь не поднялась — обнови страницу', 'warn');
        }
      })();
      startMemberPoll(id);
    } catch (e: any) { get().toast(e.message, 'err'); get().exitServer(); }
  },

  // Подтверждение модалки переключения: рвём текущее соединение и коннектимся к цели.
  confirmSwitchServer: () => {
    const target = get().pendingSwitchId;
    set({ modal: null, pendingSwitchId: null });
    if (target) get().connectServer(target);
  },

  // Полное отключение от сервера + на главную (выход/удаление сервера/ошибка коннекта).
  exitServer: () => {
    if (memberTimer) clearInterval(memberTimer);
    engine?.disconnect();
    set({ active: null, members: [], loadingServer: false, loadingServerId: null, connectedServerId: null, view: 'home' });
    get().refreshServers();
  },

  // На главную БЕЗ отключения от сервера — соединение (чат/голос/пресенс) живёт, возврат мгновенный.
  goHome: () => { if (memberTimer) clearInterval(memberTimer); set({ view: 'home' }); get().refreshServers(); },
}));

export function orderedMembers(members: Member[], presence: Record<string, { online: boolean }>): { online: Member[]; offline: Member[] } {
  const online: Member[] = [], offline: Member[] = [];
  for (const m of members) (presence[m.username]?.online ? online : offline).push(m);
  return { online, offline };
}

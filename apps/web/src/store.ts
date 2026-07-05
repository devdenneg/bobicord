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
  toasts: Toast[];
  modal: null | 'create' | 'join' | 'profile' | 'srvmenu' | 'invite' | 'settings' | 'broadcast';
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
  goHome: () => void;
  refreshServers: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  setMe: (u: User) => void;
}

let memberTimer: number | null = null;

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  view: 'loading', me: null, servers: [], active: null, members: [], loadingServer: false, loadingServerId: null, toasts: [], modal: null, joinPrefill: '', broadcastLive: false,

  toast: (text, kind) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind: kind || 'info' }].slice(-3) }));
    setTimeout(() => get().dismissToast(id), 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setModal: (m, prefill) => set({ modal: m, joinPrefill: prefill ?? get().joinPrefill }),
  setBroadcastLive: (v) => set({ broadcastLive: v }),

  setMe: (u) => { engine?.setMe(u); set({ me: u }); },

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
      persistMessage: (text, em) => { const a = get().active; if (a) api.postMessage(a.id, text, em).catch(() => {}); },
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

  logout: () => { engine?.disconnect(); setToken(null); location.reload(); },

  openServer: async (id) => {
    if (get().active?.id === id && !get().loadingServer) return;
    if (memberTimer) clearInterval(memberTimer);
    engine?.disconnect();
    // показываем лоадер (рейл остаётся), ничего частичного не рисуем
    set({ view: 'server', loadingServer: true, loadingServerId: id, active: null, members: [] });
    try {
      const d = await api.getServer(id);
      const active: ServerDetail = d.server;
      // грузим сохранённые громкости ДО показа (иначе слайдеры = 100%)
      const cache = JSON.parse(localStorage.getItem('srvset:' + id) || 'null');
      if (cache) engine?.setVols(cache);
      try { const s = await api.getSettings(id); if (s.data && (s.data.users || s.data.streams)) engine?.setVols(s.data); } catch { /**/ }
      engine?.setMembers(d.members);
      const tk = await api.serverToken(id);
      await engine?.connect(tk.url, tk.token);
      // актуальный онлайн ДО показа
      try { const pres = await api.presence(id); engine?.setOnlineHint(pres.online); } catch { /**/ }
      // история чата (7 дней) ДО показа
      let hist: import('./types').HistoryMessage[] = [];
      try { const h = await api.getMessages(id); hist = h.messages; } catch { /**/ }
      if (get().loadingServerId !== id) return; // юзер уже переключился
      engine?.loadHistory(hist);
      if (hist.length === 0) engine?.sysMsg('Ты на сервере «' + active.name + '». Чат доступен сразу — голос по кнопке «Подключиться».');
      // ВСЁ загружено → показываем сервер
      set({ active, members: d.members, loadingServer: false, loadingServerId: null });
      const poll = async () => {
        if (get().active?.id !== id) return;
        try {
          const [srv, pres] = await Promise.all([api.getServer(id), api.presence(id)]);
          set({ members: srv.members }); engine?.setMembers(srv.members); engine?.setOnlineHint(pres.online);
        } catch { /**/ }
      };
      memberTimer = window.setInterval(poll, 5000);
      if (!localStorage.getItem('onboardedSrv')) {
        localStorage.setItem('onboardedSrv', '1');
        engine?.sysMsg('👋 Ты в чате, но НЕ в голосовом. Нажми «Подключиться», чтобы говорить. Справа — кто в сети и кто в голосовом.');
      }
    } catch (e: any) { set({ loadingServer: false, loadingServerId: null }); get().toast(e.message, 'err'); get().goHome(); }
  },

  goHome: () => { if (memberTimer) clearInterval(memberTimer); engine?.disconnect(); set({ active: null, members: [], loadingServer: false, loadingServerId: null, view: 'home' }); get().refreshServers(); },
}));

export function orderedMembers(members: Member[], presence: Record<string, { online: boolean }>): { online: Member[]; offline: Member[] } {
  const online: Member[] = [], offline: Member[] = [];
  for (const m of members) (presence[m.username]?.online ? online : offline).push(m);
  return { online, offline };
}

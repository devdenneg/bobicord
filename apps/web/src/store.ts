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
  updateReady: boolean;
  // доступное обновление НАТИВА (Tauri updater); obj — Update из @tauri-apps/plugin-updater
  nativeUpdate: { version: string; obj: any } | null;
  emoteSize: 'sm' | 'md' | 'lg';
  toasts: Toast[];
  modal: null | 'create' | 'join' | 'profile' | 'srvmenu' | 'invite' | 'srvsettings' | 'settings' | 'broadcast';
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
  refreshServer: () => Promise<void>;
  setMe: (u: User) => void;
  setEmoteSize: (s: 'sm' | 'md' | 'lg') => void;
}

let memberTimer: number | null = null;

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  view: 'loading', me: null, servers: [], active: null, members: [], loadingServer: false, loadingServerId: null, updateReady: false, nativeUpdate: null, emoteSize: (localStorage.getItem('emoteSize') as 'sm' | 'md' | 'lg') || 'md', toasts: [], modal: null, joinPrefill: '', broadcastLive: false,

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

  logout: () => { engine?.disconnect(); setToken(null); location.reload(); },

  openServer: async (id) => {
    if (get().active?.id === id && !get().loadingServer) return;
    if (memberTimer) clearInterval(memberTimer);
    engine?.disconnect();
    // показываем лоадер (рейл остаётся), ничего частичного не рисуем
    set({ view: 'server', loadingServer: true, loadingServerId: id, active: null, members: [] });
    try {
      // сохранённые громкости из localStorage — синхронно, до сети (иначе слайдеры = 100%)
      const cache = JSON.parse(localStorage.getItem('srvset:' + id) || 'null');
      if (cache) engine?.setVols(cache);
      // КРИТИЧНОЕ для первой отрисовки — параллельно (один round-trip вместо цепочки):
      // инфо сервера + история чата (страница) + громкости + онлайн. Тяжёлый WebRTC-connect
      // к комнате НЕ здесь — он уходит в фон после показа (см. ниже).
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
      // WebRTC-коннект к комнате (realtime-чат/голос/пресенс) — В ФОНЕ, не блокирует отрисовку
      (async () => {
        try {
          const tk = await api.serverToken(id);
          if (get().active?.id !== id) return; // уже ушли с сервера
          await engine?.connect(tk.url, tk.token, id);
          if (get().active?.id !== id) engine?.disconnect(); // успели уйти, пока коннектились
        } catch {
          if (get().active?.id === id) get().toast('Realtime-связь не поднялась — обнови страницу', 'warn');
        }
      })();
      const poll = async () => {
        if (get().active?.id !== id) return;
        try {
          const [srv, prs] = await Promise.all([api.getServer(id), api.presence(id)]);
          set({ members: srv.members }); engine?.setMembers(srv.members); engine?.setOnlineHint(prs.online);
        } catch { /**/ }
      };
      memberTimer = window.setInterval(poll, 5000);
    } catch (e: any) { set({ loadingServer: false, loadingServerId: null }); get().toast(e.message, 'err'); get().goHome(); }
  },

  goHome: () => { if (memberTimer) clearInterval(memberTimer); engine?.disconnect(); set({ active: null, members: [], loadingServer: false, loadingServerId: null, view: 'home' }); get().refreshServers(); },
}));

export function orderedMembers(members: Member[], presence: Record<string, { online: boolean }>): { online: Member[]; offline: Member[] } {
  const online: Member[] = [], offline: Member[] = [];
  for (const m of members) (presence[m.username]?.online ? online : offline).push(m);
  return { online, offline };
}

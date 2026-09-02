import { create } from 'zustand';
import { api, isTerminalSessionError } from './api';
import {
  AUTH_BOOTSTRAP_RETRY_DELAYS_MS,
  isRecoverableAcceptedSessionBootstrapError,
} from './authBootstrap';
import { isWindowIdle, onWindowIdle } from './windowIdle';
import { Engine } from './engine';
import { ServerVolumePreferences } from './volumePreferences';
import { emoteMap } from './emotes';
import { setSettings } from './settings';
import { setPushNotificationSessionActive, unsubscribePush } from './push';
import { preparePushLogout } from './pushCleanup';
import { suspendNotificationPushRecovery } from './notify';
import { closeShownPushNotifications } from './notificationBanners';
import {
  acknowledgeReleaseMerge,
  connectNotifyWs,
  disconnectNotifyWs,
  pauseNotifyWsReconnect,
  resumeNotifyWsReconnect,
  sendConnectedChatPresence,
} from './notifyws';
import { startIdleWatch } from './idle';
import { preloadSounds } from './sounds';
import { isTauri, stopNativeBroadcastBounded } from './native';
import { endAnyBroadcasterSession, flushPendingDiag } from './diag';
import { OwnedLatestRefresh } from './serverListRefresh';
import { clearTerminalAuthSession, getAccessToken } from './authSession';
import type { User, ServerSummary, Member, ServerDetail, Toast, ToastKind, AccountStatus, ReleaseHistoryItem } from './types';

let engine: Engine | null = null;
let volumePreferences: ServerVolumePreferences | null = null;
export const getEngine = () => engine;
export const PASSWORD_RESET_STORAGE_KEY = 'relay.auth.password-reset.v1';
const RELEASE_HISTORY_SEEN_PREFIX = 'relay.release-history.seen.v1:';
const RELEASE_SHA_RE = /^[0-9a-f]{40}$/u;

function safeLocalGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalSet(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function safeSessionGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function safeSessionRemove(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /** unavailable storage is optional */ }
}
let pendingInviteMemory = '';
let pendingOpenServerMemory = '';
export function rememberPendingInvite(value: string): void {
  pendingInviteMemory = value;
  try { sessionStorage.setItem('pendingInvite', value); } catch { /** in-memory intent stays live */ }
}
export function rememberPendingOpenServer(value: string): void {
  pendingOpenServerMemory = value;
  try { sessionStorage.setItem('pendingOpenServer', value); } catch { /** in-memory intent stays live */ }
}
function takePendingEntryIntent(): { invite: string; openServer: string } {
  const invite = pendingInviteMemory || safeSessionGet('pendingInvite') || '';
  const openServer = pendingOpenServerMemory || safeSessionGet('pendingOpenServer') || '';
  pendingInviteMemory = '';
  pendingOpenServerMemory = '';
  safeSessionRemove('pendingInvite');
  safeSessionRemove('pendingOpenServer');
  return { invite, openServer };
}
function storedEmoteSize(): 'sm' | 'md' | 'lg' {
  const value = safeLocalGet('emoteSize');
  return value === 'sm' || value === 'lg' ? value : 'md';
}

function releaseHistorySeenKey(userId: string) {
  return RELEASE_HISTORY_SEEN_PREFIX + encodeURIComponent(userId);
}

function releaseShas(releases: ReleaseHistoryItem[]) {
  const seen = new Set<string>();
  const shas: string[] = [];
  for (const release of releases.slice(0, 10)) {
    const sha = String(release?.sha || '').trim().toLowerCase();
    if (!RELEASE_SHA_RE.test(sha) || seen.has(sha)) continue;
    seen.add(sha);
    shas.push(sha);
  }
  return shas;
}

function storedReleaseHistoryMarker(userId: string) {
  try {
    const marker = String(localStorage.getItem(releaseHistorySeenKey(userId)) || '').trim().toLowerCase();
    return RELEASE_SHA_RE.test(marker) ? marker : '';
  } catch { return ''; }
}

function countUnreadReleases(userId: string, releases: ReleaseHistoryItem[]) {
  const shas = releaseShas(releases);
  if (!shas.length) return 0;
  const marker = storedReleaseHistoryMarker(userId);
  if (!marker) return shas.length;
  const markerIndex = shas.indexOf(marker);
  // История ограничена десятью релизами. Если старый маркер уже выпал из окна,
  // все доступные записи честно считаются непрочитанными.
  return markerIndex < 0 ? shas.length : markerIndex;
}

interface AppState {
  view: 'loading' | 'auth' | 'home' | 'server' | 'admin';
  me: User | null;
  pendingUser: User | null;
  accountGate: AccountStatus | null;
  passwordResetToken: string | null;
  sessionError: string;
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
  modal: null | 'create' | 'join' | 'profile' | 'srvmenu' | 'invite' | 'srvsettings' | 'settings' | 'broadcast' | 'switchServer' | 'downloads' | 'leaderboard' | 'releaseHistory';
  joinPrefill: string;
  broadcastLive: boolean;
  unread: Record<string, number>; // непрочитанные по серверам (бейдж в рейле/таскбаре)
  lastRead: Record<string, number>; // id последнего прочитанного (базовая линия дивайдера «новые»)
  releaseUnread: number; // непрочитанные записи «Что нового» (последние 10, отдельно для аккаунта)

  toast: (text: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;
  setModal: (m: AppState['modal'], prefill?: string) => void;
  setBroadcastLive: (v: boolean) => void;

  acceptSession: (user: User, account?: AccountStatus) => Promise<void>;
  setAccountGate: (account: AccountStatus | null) => void;
  setPasswordResetToken: (token: string | null) => void;
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
  refreshServers: (signal?: AbortSignal) => Promise<void>;
  markRead: (serverId: string, lastId: number, all?: boolean) => void;   // отметить прочитанным (в самом низу чата); all — «прочитать всё» (сервер last_read=MAX)
  bumpUnread: (serverId: string, n?: number) => void;     // +новое (чат/системное) когда не читаем сервер
  applyRemoteRead: (serverId: string, lastRead: number) => void; // прочитано на ДРУГОМ устройстве (notify-WS)
  refreshReleaseHistoryUnread: () => Promise<ReleaseHistoryItem[]>;
  markReleaseHistoryRead: (releases: ReleaseHistoryItem[]) => void;
  refreshMembers: () => Promise<void>;
  refreshServer: () => Promise<void>;
  createChannel: (name: string) => Promise<void>;
  renameChannel: (cid: string, name: string) => Promise<void>;
  deleteChannel: (cid: string) => Promise<void>;
  setMe: (u: User) => void;
  setEmoteSize: (s: 'sm' | 'md' | 'lg') => void;
}

let memberTimer: number | null = null;
let memberPollGeneration = 0;
let memberPollKick: (() => void) | null = null;
let authSessionHandoffGeneration = 0;
let activeAuthSessionHandoffGeneration: number | null = null;

function authSessionHandoffActive() {
  return activeAuthSessionHandoffGeneration != null;
}

// Пользовательская навигация сильнее фонового восстановления после ротации JWT. Инвалидация
// не трогает engine напрямую: следующий connectServer уже оградит старые сетевые хвосты viewEpoch,
// а существующий голос по правилам приложения может продолжать жить при просмотре другого сервера.
function invalidateAuthSessionHandoff(resumeNotify = true) {
  if (activeAuthSessionHandoffGeneration == null) return;
  activeAuthSessionHandoffGeneration = null;
  authSessionHandoffGeneration += 1;
  if (resumeNotify) resumeNotifyWsReconnect();
}
// Эпоха соединения: инкрементится каждый раз, когда engine-коннект РВЁТСЯ или ЗАМЕНЯЕТСЯ
// (connectServer/exitServer/logout). Фоновые async-хвосты (connect IIFE, member-poll) захватывают
// эпоху на старте и сверяют перед записью в стор/engine — иначе протухший хвост прошлого сервера
// пишет своё состояние поверх текущего или рвёт живую комнату. goHome НЕ бампит (соединение живёт).
let viewEpoch = 0;
const MEMBER_POLL_MS = 5000;
const IDLE_MEMBER_POLL_MS = 30000;

function stopMemberPoll() {
  memberPollGeneration += 1;
  memberPollKick = null;
  if (memberTimer !== null) clearTimeout(memberTimer);
  memberTimer = null;
}

function kickMemberPoll() {
  memberPollKick?.();
}

// Поллинг состава/пресенса активного сервера. Следующий запрос ставится только в finally
// предыдущего: медленный мобильный ответ не обесценивается новым 5-секундным тиком и всё равно
// применяется, если пользователь остаётся на том же сервере и в той же view-эпохе.
function startMemberPoll(id: string) {
  stopMemberPoll();
  const generation = memberPollGeneration;
  const epoch = viewEpoch;
  let inFlight = false;
  let kickAfterFlight = false;
  const isCurrent = () => {
    const st = useStore.getState();
    return memberPollGeneration === generation && viewEpoch === epoch
      && st.view === 'server' && st.viewServerId === id;
  };
  const schedule = (delay: number) => {
    if (!isCurrent()) return;
    if (memberTimer !== null) clearTimeout(memberTimer);
    memberTimer = window.setTimeout(() => { memberTimer = null; void poll(); }, delay);
  };
  const poll = async () => {
    if (!isCurrent()) return;
    if (inFlight) { kickAfterFlight = true; return; }
    inFlight = true;
    try {
      const [srv, prs] = await Promise.all([api.getServer(id), api.presence(id)]);
      // Медленный ответ остаётся валидным, пока generation/epoch/server те же. Смена сервера или
      // stopMemberPoll инвалидируют поколение и не дают старому HTTP-хвосту переписать новый UI.
      if (!isCurrent()) return;
      const st2 = useStore.getState();
      useStore.setState({ members: srv.members, active: st2.active && st2.active.id === id ? { ...st2.active, ...srv.server, myRole: srv.myRole, myPerms: srv.myPerms } : st2.active });
      engine?.setMembers(srv.members); engine?.setOnlineHint(prs.online); engine?.setAwayHint(prs.away || []); engine?.setVoiceHint(prs.voice || {});
    } catch { /** Следующий рекурсивный тик повторит transient failure. */ }
    finally {
      inFlight = false;
      if (!isCurrent()) return;
      const delay = kickAfterFlight ? 0 : (isWindowIdle() ? IDLE_MEMBER_POLL_MS : MEMBER_POLL_MS);
      kickAfterFlight = false;
      schedule(delay);
    }
  };
  memberPollKick = () => {
    if (!isCurrent()) return;
    if (inFlight) { kickAfterFlight = true; return; }
    schedule(0);
  };
  schedule(isWindowIdle() ? IDLE_MEMBER_POLL_MS : MEMBER_POLL_MS);
}

// Возврат PWA из background и восстановление сети должны обновлять состав немедленно, не ждать
// ни throttled timeout, ни следующего 30-секундного idle-цикла.
onWindowIdle((idle) => { if (!idle) kickMemberPoll(); });
window.addEventListener('online', kickMemberPoll);
window.addEventListener('pageshow', kickMemberPoll);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') kickMemberPoll();
});

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
let releaseHistoryTimer: number | null = null;
let releaseHistoryRequest = 0;
let onboardedServerInMemory = false;
type MeSnapshot = { user: User; servers: ServerSummary[] };
const serverListRefresh = new OwnedLatestRefresh<MeSnapshot>();
let authBootstrapRetryTimer: number | null = null;
let authBootstrapRetryGeneration = 0;

function cancelAuthBootstrapRetry() {
  authBootstrapRetryGeneration += 1;
  if (authBootstrapRetryTimer !== null) window.clearTimeout(authBootstrapRetryTimer);
  authBootstrapRetryTimer = null;
}

function scheduleAuthBootstrapRetry(userId: string) {
  cancelAuthBootstrapRetry();
  const generation = authBootstrapRetryGeneration;
  let attempt = 0;
  const schedule = () => {
    if (attempt >= AUTH_BOOTSTRAP_RETRY_DELAYS_MS.length) return;
    const delay = AUTH_BOOTSTRAP_RETRY_DELAYS_MS[attempt++];
    authBootstrapRetryTimer = window.setTimeout(async () => {
      authBootstrapRetryTimer = null;
      const state = useStore.getState();
      if (generation !== authBootstrapRetryGeneration || state.me?.id !== userId) return;
      try {
        await state.loadMe();
        if (generation === authBootstrapRetryGeneration) cancelAuthBootstrapRetry();
      } catch (error) {
        if (generation !== authBootstrapRetryGeneration || useStore.getState().me?.id !== userId) return;
        if (isTerminalSessionError(error)) {
          cancelAuthBootstrapRetry();
          if (getAccessToken()) clearTerminalAuthSession();
          viewEpoch++;
          stopMemberPoll();
          serverListRefresh.invalidate();
          engine?.disconnect(true);
          engine = null;
          volumePreferences?.dispose();
          volumePreferences = null;
          disconnectNotifyWs();
          if (unreadTimer !== null) window.clearInterval(unreadTimer);
          unreadTimer = null;
          if (releaseHistoryTimer !== null) window.clearInterval(releaseHistoryTimer);
          releaseHistoryTimer = null;
          useStore.setState({
            view: 'auth', me: null, pendingUser: null, accountGate: null,
            sessionError: error.message, servers: [], active: null, members: [],
            loadingServer: false, loadingServerId: null, viewServerId: null, releaseUnread: 0,
          });
          return;
        }
        if (isRecoverableAcceptedSessionBootstrapError(error)) schedule();
      }
    }, delay);
  };
  schedule();
}

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  view: 'loading', me: null, pendingUser: null, accountGate: null, passwordResetToken: null, sessionError: '', servers: [], active: null, members: [], loadingServer: false, loadingServerId: null, viewServerId: null, serverEntryTab: 'channels', pendingSwitchId: null, updateReady: false, nativeUpdate: null, emoteSize: storedEmoteSize(), toasts: [], modal: null, joinPrefill: '', broadcastLive: false, unread: {}, lastRead: {}, releaseUnread: 0,

  toast: (text, kind) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind: kind || 'info' }].slice(-3) }));
    setTimeout(() => get().dismissToast(id), 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setModal: (m, prefill) => set({ modal: m, joinPrefill: prefill ?? get().joinPrefill }),
  setBroadcastLive: (v) => set({ broadcastLive: v }),
  setAccountGate: (account) => set({ accountGate: account, modal: null }),
  setPasswordResetToken: (passwordResetToken) => {
    try {
      if (passwordResetToken) sessionStorage.setItem(PASSWORD_RESET_STORAGE_KEY, passwordResetToken);
      else sessionStorage.removeItem(PASSWORD_RESET_STORAGE_KEY);
    } catch { /* an unavailable sessionStorage must not break recovery */ }
    set({ passwordResetToken });
  },

  setMe: (u) => { engine?.setMe(u); set({ me: u }); },
  setEmoteSize: (s) => { safeLocalSet('emoteSize', s); set({ emoteSize: s }); },

  acceptSession: async (user, account = { state: 'ready' }) => {
    if (account.state !== 'ready') {
      set({
        view: 'auth', me: null, pendingUser: user, accountGate: account,
        sessionError: '', modal: null, active: null, members: [], loadingServer: false,
        loadingServerId: null, viewServerId: null, releaseUnread: 0,
      });
      return;
    }
    cancelAuthBootstrapRetry();
    set({ pendingUser: null, accountGate: null, sessionError: '', view: 'loading', modal: null });
    try { await get().afterAuth(user); }
    catch (error) {
      engine?.disconnect(true); engine = null;
      volumePreferences?.dispose(); volumePreferences = null;
      set({
        view: 'auth', me: null, pendingUser: null, accountGate: null,
        sessionError: error instanceof Error ? error.message : 'Не удалось загрузить аккаунт', releaseUnread: 0,
      });
      throw error;
    }
  },

  afterAuth: async (user) => {
    // Досылаем диаг-сессии, не ушедшие в прошлый раз (сеть моргнула / апп закрыли на
    // остановке стрима). Именно здесь: токен уже есть, иначе сервер вернул бы 401 и
    // очередь очистилась бы впустую. Фоном — стартовать приложение это не задерживает.
    flushPendingDiag().catch(() => {});
    volumePreferences?.dispose();
    const accountVolumePreferences = new ServerVolumePreferences(
      user.id,
      async (serverId, mutations) => {
        // Field-level server mutations are atomic across tabs and physical devices. A whole-map PUT
        // would let the last device silently erase every person changed by another one.
        for (const mutation of mutations) await api.patchSettings(serverId, mutation);
      },
    );
    volumePreferences = accountVolumePreferences;
    engine = new Engine(user, {
      toast: (t, k) => get().toast(t, k),
      saveSettings: (serverId, vols, mutation) => {
        if (!serverId) return;
        accountVolumePreferences.update(serverId, vols, mutation);
      },
      peerJoined: (id) => { if (!get().members.some((m) => m.username === id)) get().refreshMembers(); },
      persistMessage: (text, em, image, reply, localId, key, files, kind, level, canonicalTransport = false) => {
        const a = get().active;
        if (!a) { engine?.markSendResult(localId, false); return; }
        api.postMessage(a.id, text, em, image, reply, key, files, kind, level, canonicalTransport)
          .then((r) => engine?.markSendResult(localId, true, r?.id, r?.revision))
          .catch(() => engine?.markSendResult(localId, false));
      },
      fetchChatSnapshot: (serverId) => api.getMessages(serverId, undefined, 30),
      refetchChat: (sid, expectedServerId, awaitRelease) => {
        const a = get().active; if (!a) return;
        const id = expectedServerId || a.id;
        if (a.id !== id) return;
        const epoch = viewEpoch, targetEngine = engine, startedAt = Date.now();
        const exactCursor = sid != null && Number.isSafeInteger(sid) ? sid + 1 : undefined;
        const stillCurrent = () => {
          const current = get();
          return viewEpoch === epoch && current.active?.id === id
            && targetEngine?.connectedChatServerId() === id && engine === targetEngine;
        };
        const scheduleRetry = (attempt: number) => {
          // Ретрай-цикл существует ради release-записи, которую сервер мог ещё не записать. Для любого
          // другого sid условие «дождаться kind === 'release'» не выполнится никогда, поэтому цикл
          // крутился все 15 минут (~90 запросов на одну неудачную реакцию), а merge не применялся.
          if (!awaitRelease || exactCursor == null || !stillCurrent() || Date.now() - startedAt >= 15 * 60_000) return;
          const delay = Math.min(10_000, 600 * (2 ** Math.min(attempt, 5)));
          window.setTimeout(() => { if (stillCurrent()) fetchRecent(attempt + 1); }, delay);
        };
        const fetchRecent = (attempt = 0) => {
          api.getMessages(id, exactCursor, exactCursor == null ? 30 : 1).then((d) => {
            if (!stillCurrent()) return;
            const exactRelease = sid != null && d.messages.some((message) => message.id === sid && message.kind === 'release');
            if (awaitRelease && sid != null && !exactRelease) { scheduleRetry(attempt); return; }
            targetEngine?.mergeRecent(d.messages);
            if (exactRelease) acknowledgeReleaseMerge();
          }).catch(() => scheduleRetry(attempt));
        };
        fetchRecent();
      },
      // Let the engine observe failures so it can roll optimistic state back.
      reactMessage: (serverId, sid, emoteId, emoteName, add, canonicalTransport) => api.reactMessage(serverId, sid, emoteId, emoteName, add, canonicalTransport).then((result) => ({
        // Old servers did not return changed; they still rely on the confirmed
        // participant packet. A marked canonical mutation fails closed and lets
        // the Engine snapshot reconcile if the new field is unexpectedly absent.
        changed: typeof result.changed === 'boolean' ? result.changed : !canonicalTransport,
      })),
      editMessage: (serverId, sid, text, canonicalTransport) => api.editMessage(serverId, sid, text, canonicalTransport).then(() => undefined),
      deleteMessage: (serverId, sid, canonicalTransport) => api.deleteMessage(serverId, sid, canonicalTransport).then(() => undefined),
      chatConnectionChanged: sendConnectedChatPresence,
      // выход из голосового → гасим нативную трансляцию (Rust-дерево) + сбрасываем флаг (browser-share гасит engine.stopShare)
      endBroadcast: () => { if (isTauri) void stopNativeBroadcastBounded().finally(() => endAnyBroadcasterSession()); get().setBroadcastLive(false); },
      connectionLost: (serverId, _voiceChannel, wasViewing) => {
        // Terminal LiveKit disconnect уже не восстановится внутренним reconnect. Если это открытый
        // сервер — получаем свежий token через штатный retry connectServer; голос не захватываем
        // автоматически, чтобы старый ПК после offline не выбил активный телефон.
        // Во время ротации JWT сервер намеренно закрывает старые realtime-сессии до выдачи
        // нового токена. Автоматический retry здесь успел бы запросить LiveKit-token со старым
        // JWT. Handoff сам восстановит нужные комнаты после setToken(newJwt).
        if (authSessionHandoffActive() || !wasViewing || get().viewServerId !== serverId) return;
        if (get().view === 'server') { void get().connectServer(serverId); return; }
        // Мы ушли на главную (goHome намеренно не рвёт соединение), и оно умерло уже там. Реконнект в
        // фоне не нужен, но и мёртвый viewServerId оставлять нельзя: повторный клик по серверу уходит
        // в showConnectedServer (store.ts:500) — «показать без реконнекта», — и сервер открывается с
        // мёртвым realtime до перезагрузки страницы. Сбрасываем, тогда клик = полноценный вход.
        set({ viewServerId: null });
      },
      connectionLossExpected: authSessionHandoffActive,
    });
    engine.onEmoteResolve = (name, id) => emoteMap.set(name, id);
    // Publish the account only after the browser master is fail-closed. Otherwise App's `me` effect
    // can confirm push while loadMe is pending, then this handoff would overwrite true back to false.
    if (!isTauri) setSettings({ notif: false });
    set({ me: user, pendingUser: null, accountGate: null, sessionError: '', releaseUnread: 0 });
    let retryBootstrap = false;
    try { await get().loadMe(); }
    catch (error) {
      if (!isRecoverableAcceptedSessionBootstrapError(error)) throw error;
      retryBootstrap = true;
    }
    set({ view: 'home' });
    connectNotifyWs(); // глобальный live-канал уведомлений (любой сервер, даже не подключённый)
    startIdleWatch();  // away-детект: апп давно не трогали → жёлтый статус (шлётся по notify-WS)
    preloadSounds(); // прогреть звуки (fetch+decode+нормализация громкости) — первый проигрыш без задержки
    if (retryBootstrap) {
      get().toast('Связь с сервером временно недоступна — аккаунт сохранён, повторяем подключение', 'warn');
      scheduleAuthBootstrapRetry(user.id);
    }
    const { invite: pend, openServer: pendingOpenServer } = takePendingEntryIntent();
    if (pend) {
      set({ modal: 'join', joinPrefill: pend });
    } else if (pendingOpenServer) {
      void get().openServer(pendingOpenServer);
    }
  },

  loadMe: async () => {
    const userId = get().me?.id || '';
    const targetEngine = engine;
    // Creating/joining/leaving is an authoritative server-list boundary. Any Home request that
    // started before it must be aborted and, even if fetch ignores abort, fenced by this revision.
    serverListRefresh.invalidate();
    await serverListRefresh.run({
      owner: userId,
      load: (signal) => api.me(signal),
      isOwnerCurrent: (owner) => get().me?.id === owner && engine === targetEngine,
      commit: (d) => {
        if (d.user.id !== userId) return;
        targetEngine?.setMe(d.user);
        set((st) => { const lr = { ...st.lastRead }; for (const s of d.servers) if (lr[s.id] === undefined) lr[s.id] = s.lastRead || 0; return { me: d.user, servers: d.servers, lastRead: lr }; });
        mergeUnread(Object.fromEntries(d.servers.map((s) => [s.id, s.unread || 0])));
      },
    });
    // лёгкий поллинг непрочитанного по всем серверам (для НЕ активных — активный ведёт клиент)
    if (unreadTimer) clearInterval(unreadTimer);
    unreadTimer = window.setInterval(async () => { try { mergeUnread(await api.getUnread()); } catch { /**/ } }, 30000);
    if (releaseHistoryTimer) clearInterval(releaseHistoryTimer);
    void get().refreshReleaseHistoryUnread().catch(() => {});
    releaseHistoryTimer = window.setInterval(() => { void get().refreshReleaseHistoryUnread().catch(() => {}); }, 60000);
  },
  refreshServers: async (signal) => {
    const userId = get().me?.id || '';
    if (!userId || signal?.aborted) return;
    try {
      await serverListRefresh.run({
        owner: userId,
        signal,
        load: (requestSignal) => api.me(requestSignal),
        isOwnerCurrent: (owner) => get().me?.id === owner,
        commit: (d) => {
          if (d.user.id !== userId) return;
          set({ servers: d.servers });
          mergeUnread(Object.fromEntries(d.servers.map((s) => [s.id, s.unread || 0])));
        },
      });
    } catch { /** foreground/focus polling retries on the next bounded trigger */ }
  },
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
  refreshReleaseHistoryUnread: async () => {
    const userId = get().me?.id;
    if (!userId) return [];
    const request = ++releaseHistoryRequest;
    const response = await api.releaseHistory();
    const releases = Array.isArray(response.releases) ? response.releases.slice(0, 10) : [];
    // Ответ прошлого аккаунта/запроса не должен перезаписать бейдж после relogin.
    if (request === releaseHistoryRequest && get().me?.id === userId) {
      set({ releaseUnread: countUnreadReleases(userId, releases) });
      updateAppBadge();
    }
    return releases;
  },
  markReleaseHistoryRead: (releases) => {
    const userId = get().me?.id;
    const latestSha = releaseShas(releases)[0];
    if (!userId) return;
    // Не даём более раннему фоновому запросу вернуть бейдж сразу после прочтения.
    releaseHistoryRequest++;
    if (!latestSha) {
      set({ releaseUnread: 0 });
      updateAppBadge();
      return;
    }
    try { localStorage.setItem(releaseHistorySeenKey(userId), latestSha); } catch { /**/ }
    set({ releaseUnread: 0 });
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
    const logoutUserId = get().me?.id || get().pendingUser?.id || '';
    // Capture the exact provisional endpoint first, then publish the shared logout fence before
    // any asynchronous worker/network operation. An in-flight ensure in another tab reads this
    // durable marker directly and therefore cannot post a later active=true after our false floor.
    preparePushLogout(logoutUserId);
    try { await api.beginLogout(); }
    catch (error) {
      get().toast(error instanceof Error ? error.message : 'Не удалось безопасно завершить сессию', 'err');
      return;
    }
    // Start immediately while the page still owns its ServiceWorker. This is independent from
    // subscription cleanup and bounded, so a broken browser API cannot hold explicit logout.
    const closePushBanners = closeShownPushNotifications();
    const hideFuturePush = setPushNotificationSessionActive(false);
    const stopNativeCapture = isTauri
      ? stopNativeBroadcastBounded().finally(() => endAnyBroadcasterSession())
      : Promise.resolve();
    set({ broadcastLive: false });
    suspendNotificationPushRecovery(logoutUserId);
    cancelAuthBootstrapRetry();
    invalidateAuthSessionHandoff(false);
    viewEpoch++; stopMemberPoll(); engine?.disconnect(true);
    volumePreferences?.dispose(); volumePreferences = null;
    // A retained offline endpoint may still receive already queued account pushes. Persist the
    // worker's logged-out floor before cleanup/reload so those mandatory banners stay generic.
    try { await Promise.race([hideFuturePush, new Promise((r) => setTimeout(r, 1500))]); } catch { /**/ }
    // отписываем web-push ПОКА токен ещё текущего юзера (api.pushUnsubscribe шлёт Bearer) —
    // иначе endpoint остаётся привязан к нему на сервере и его push летели бы следующему юзеру.
    // cap 2с, чтобы разлогин не подвисал на мёртвой сети.
    try { await Promise.race([unsubscribePush(logoutUserId), new Promise((r) => setTimeout(r, 2000))]); } catch { /**/ }
    disconnectNotifyWs();
    // The local logout fence is installed before this request. Even if the
    // network is offline or the 2s cap wins, reload cannot restore the HttpOnly
    // refresh cookie; online/next boot will finish server revocation.
    try { await Promise.race([api.logoutSession(), new Promise((r) => setTimeout(r, 2000))]); } catch { /**/ }
    await Promise.all([closePushBanners, stopNativeCapture]);
    location.reload();
  },

  // Точка входа по клику на сервер. Просмотр СВОБОДНЫЙ (голос не рвём, модалки переключения больше нет):
  // уже смотрю → no-op; смотримая комната уже на id (вернулся с главной) → мгновенный показ; иначе — вход
  // (connectServer сам решит: реюз живой голосовой комнаты или новый view-коннект).
  openServer: async (id, watchUser, entryTab) => {
    invalidateAuthSessionHandoff();
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
    // подтянуть свежий состав/пресенс (соединение и история уже живые)
    try {
      const [srv, pres] = await Promise.all([api.getServer(id), api.presence(id).catch(() => null)]);
      if (get().viewServerId !== id || get().view !== 'server') return;
      set({ members: srv.members, active: { ...srv.server, myRole: srv.myRole, myPerms: srv.myPerms } });
      engine?.setMembers(srv.members); if (pres) { engine?.setOnlineHint(pres.online); engine?.setAwayHint(pres.away || []); engine?.setVoiceHint(pres.voice || {}); }
    } catch { /**/ }
    finally {
      // Первый refresh и рекурсивный poll не должны дублировать друг друга на медленной сети.
      if (get().viewServerId === id && get().view === 'server') startMemberPoll(id);
    }
  },

  // Фактический (ре)коннект: рвём прошлое соединение и поднимаем новое.
  connectServer: async (id) => {
    const myEpoch = ++viewEpoch; // новый коннект — предыдущие async-хвосты устаревают
    stopMemberPoll();
    // Вход на СВОЙ голосовой сервер → реюз живой голосовой комнаты как смотримой (без 2-го коннекта к тому же
    // srv = без само-дубля/эха). Иначе — отцепляем прежнюю смотримую; голос НЕ трогаем (браузинг больше не рвёт голос).
    const reuse = !!engine && engine.getSnapshot().voiceServerId === id;
    if (reuse) engine?.reuseVoiceAsView(); else engine?.detachView(id);
    set({ view: 'server', loadingServer: true, loadingServerId: id, active: null, members: [], viewServerId: id });
    engine?.beginChatView(id);
    // Fence persisted dirty values against the in-flight GET. The release in finally also covers
    // offline/stale loads, so a failed hydration cannot block retrying those exact fields forever.
    const hydrationOwner = volumePreferences;
    const hydrationEngine = engine;
    const hydration = hydrationOwner?.beginHydration(id) || { data: null, revision: 0, token: 0 };
    if (hydration.data) hydrationEngine?.setVols(id, hydration.data);
    try {
      // КРИТИЧНОЕ для первой отрисовки — параллельно; тяжёлый WebRTC-connect уходит в фон (ниже).
      const [d, chatCount, settings, pres] = await Promise.all([
        api.getServer(id),
        engine?.synchronizeChat(id).catch(() => 0) || Promise.resolve(0),
        api.getSettings(id).catch(() => null),
        api.presence(id).catch(() => null),
      ]);
      if (viewEpoch !== myEpoch || get().loadingServerId !== id) return; // юзер уже переключился/перезапустил этот же connect
      const active: ServerDetail = { ...d.server, myRole: d.myRole, myPerms: d.myPerms };
      if (settings && hydrationOwner && volumePreferences === hydrationOwner && engine === hydrationEngine) {
        const effectiveVolumes = hydrationOwner.acceptRemote(id, settings.data, hydration.revision, hydration.token);
        hydrationEngine?.setVols(id, effectiveVolumes);
      }
      engine?.setMembers(d.members);
      if (pres) { engine?.setOnlineHint(pres.online); engine?.setAwayHint(pres.away || []); engine?.setVoiceHint(pres.voice || {}); }
      if (chatCount === 0) engine?.sysMsg('Ты на сервере «' + active.name + '». Чат доступен сразу — голос по кнопке «Подключиться».');
      // ВСЁ критичное готово → показываем сервер немедленно (не ждём комнату)
      set({ active, members: d.members, loadingServer: false, loadingServerId: null });
      if (!onboardedServerInMemory && safeLocalGet('onboardedSrv') !== '1') {
        onboardedServerInMemory = true;
        safeLocalSet('onboardedSrv', '1');
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
          engine?.cancelPendingVoiceJoin(id);
          set({ viewServerId: null });
          get().toast('Realtime-связь не поднялась — зайди на сервер заново', 'warn');
        }
      })();
      startMemberPoll(id);
    } catch (e: any) {
      // Ошибка старого A-connect не имеет права закрыть уже открываемый B (или более свежий retry A).
      if (viewEpoch !== myEpoch) return;
      get().toast(e.message, 'err'); get().exitServer();
    } finally {
      hydrationOwner?.finishHydration(id, hydration.token);
    }
  },

  // Подтверждение модалки переключения: рвём текущее соединение и коннектимся к цели.
  confirmSwitchServer: () => {
    invalidateAuthSessionHandoff();
    const target = get().pendingSwitchId;
    set({ modal: null, pendingSwitchId: null });
    if (target) get().connectServer(target);
  },

  // Полное отключение от сервера + на главную (выход/удаление сервера/ошибка коннекта).
  exitServer: () => {
    invalidateAuthSessionHandoff();
    viewEpoch++; // in-flight connect/poll прошлого сервера устаревают
    stopMemberPoll();
    // Exit is also the post-commit path for leave/delete. Never coalesce that authoritative refresh
    // with a list snapshot that may have started before the membership mutation completed.
    serverListRefresh.invalidate();
    // Покидаю СМОТРИМЫЙ сервер (leave/delete/ошибка). Если я в голосе ИМЕННО на нём — выхожу и из голоса
    // (полный teardown); иначе голос на другом сервере — оставляем, отцепляем только просмотр.
    const voiceSrv = engine?.getSnapshot().voiceServerId;
    if (voiceSrv && voiceSrv === get().viewServerId) engine?.disconnect(); else engine?.detachView();
    set({ active: null, members: [], loadingServer: false, loadingServerId: null, viewServerId: null, view: 'home' });
    get().refreshServers();
  },

  // На главную БЕЗ отключения от сервера — соединение (чат/голос/пресенс) живёт, возврат мгновенный.
  goHome: () => { invalidateAuthSessionHandoff(); stopMemberPoll(); if (location.pathname !== '/') history.replaceState({}, '', '/'); set({ view: 'home' }); get().refreshServers(); },
  goAdmin: () => { invalidateAuthSessionHandoff(); stopMemberPoll(); if (location.pathname !== '/admin') history.pushState({}, '', '/admin'); set({ view: 'admin' }); },
}));

export interface AuthSessionHandoff {
  generation: number;
  userId: string;
  originalView: AppState['view'];
  viewedServerId: string | null;
  voiceServerId: string | null;
  voiceChannelId: string | null;
}

// Фиксируем realtime-intent ДО запроса смены пароля. Notify-сокет закрывается сразу и не может
// переподключиться со старым JWT; LiveKit остаётся жить до ответа, чтобы неверный текущий пароль
// не создавал пользователю лишний разрыв голоса.
export function beginAuthSessionHandoff(): AuthSessionHandoff {
  const state = useStore.getState();
  const snapshot = engine?.getSnapshot();
  const generation = ++authSessionHandoffGeneration;
  activeAuthSessionHandoffGeneration = generation;
  pauseNotifyWsReconnect();
  return {
    generation,
    userId: state.me?.id || '',
    originalView: state.view,
    viewedServerId: state.loadingServerId || state.viewServerId || state.active?.id || null,
    voiceServerId: snapshot?.voiceServerId || null,
    voiceChannelId: snapshot?.myVoiceChannel || null,
  };
}

// Вызывать только после установки нового JWT (tokenChanged=true) либо после окончательной ошибки
// запроса (false). Функция не бросает исключений: пароль уже мог быть изменён, поэтому сбой
// восстановления realtime не должен превращаться в ложную ошибку смены пароля.
export async function completeAuthSessionHandoff(plan: AuthSessionHandoff, tokenChanged: boolean): Promise<void> {
  const stillCurrent = () => activeAuthSessionHandoffGeneration === plan.generation
    && useStore.getState().me?.id === plan.userId;
  try {
    if (!stillCurrent()) return;
    const currentSnapshot = engine?.getSnapshot();
    const viewStillAlive = !plan.viewedServerId
      || (useStore.getState().viewServerId === plan.viewedServerId && !!currentSnapshot?.connected);
    const voiceStillAlive = !plan.voiceChannelId
      || (currentSnapshot?.voiceServerId === plan.voiceServerId && currentSnapshot.myVoiceChannel === plan.voiceChannelId);
    const reconnectView = Boolean(plan.viewedServerId) && (tokenChanged || !viewStillAlive);
    const voiceNeedsManualReconnect = Boolean(plan.voiceChannelId) && (tokenChanged || !voiceStillAlive);

    if (tokenChanged) {
      if (!stillCurrent()) return;
      // Даже если событие серверного disconnect ещё стоит в очереди, старую комнату больше не
      // переиспользуем: создаём её заново только после того, как api.ts уже видит новый JWT.
      viewEpoch++;
      stopMemberPoll();
      engine?.disconnect();
    }

    if (!stillCurrent()) return;
    resumeNotifyWsReconnect();
    if (!tokenChanged && viewStillAlive && voiceStillAlive) return;

    // Handoff восстанавливает только просматриваемую LiveKit-комнату. Новый voice claim
    // всегда требует свежего клика: за время ротации/обрыва владельцем могло стать другое
    // устройство, и автоматический mint/claim без жеста вытеснил бы его.
    if (reconnectView && plan.viewedServerId) {
      if (!stillCurrent()) return;
      await useStore.getState().connectServer(plan.viewedServerId);
    }
    if (!stillCurrent()) return;

    const recoveredSnapshot = engine?.getSnapshot();
    const voiceRecoveredExplicitly = recoveredSnapshot?.voiceServerId === plan.voiceServerId
      && recoveredSnapshot.myVoiceChannel === plan.voiceChannelId;
    if (voiceNeedsManualReconnect && !voiceRecoveredExplicitly) {
      useStore.getState().toast('Голосовая связь отключена — подключись к каналу снова', 'warn');
    }

    if (plan.originalView === 'home') {
      stopMemberPoll();
      if (location.pathname !== '/') history.replaceState({}, '', '/');
      useStore.setState({ view: 'home' });
      void useStore.getState().refreshServers();
    }
    else if (plan.originalView === 'admin') {
      stopMemberPoll();
      useStore.setState({ view: 'admin' });
    }
  } catch {
    if (!stillCurrent()) return;
    resumeNotifyWsReconnect();
    useStore.getState().toast('Сеанс обновлён, realtime-связь восстановится при повторном входе на сервер', 'warn');
  } finally {
    if (activeAuthSessionHandoffGeneration === plan.generation) activeAuthSessionHandoffGeneration = null;
  }
}

// Доступное обновление тоже добавляет +1 к бейджу таскбара.
// Presence видимого чата ведёт ServerView: только он знает mobile-tab и скрыта ли панель эфиром.
useStore.subscribe((s, prev) => { if (s.updateReady !== prev.updateReady) updateAppBadge(); });

// История читается локально, но строго в пространстве текущего account ID. Синхронизируем
// вкладки через storage и сразу сверяемся при возврате в приложение; серверный 60-секундный
// poll остаётся страховкой для долго открытого окна во время нового деплоя.
function refreshReleaseHistoryOnReturn() {
  if (!useStore.getState().me) return;
  void useStore.getState().refreshReleaseHistoryUnread().catch(() => {});
}
window.addEventListener('focus', refreshReleaseHistoryOnReturn);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshReleaseHistoryOnReturn();
});
window.addEventListener('storage', (event) => {
  const userId = useStore.getState().me?.id;
  if (userId && event.key === releaseHistorySeenKey(userId)) refreshReleaseHistoryOnReturn();
});

export function orderedMembers(members: Member[], presence: Record<string, { online: boolean }>): { online: Member[]; offline: Member[] } {
  const online: Member[] = [], offline: Member[] = [];
  for (const m of members) (presence[m.username]?.online ? online : offline).push(m);
  return { online, offline };
}

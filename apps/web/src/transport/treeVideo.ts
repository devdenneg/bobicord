import type { Room } from 'livekit-client';
import type { VideoTransport, TreeInfo, RtpStats, TreeTopology } from './videoTransport';
import { MediaStreamVideoHandle } from './videoTransport';
import type { StreamInfo } from '../engine';
import { isTerminalSessionError } from '../api';
import {
  isTauri, isTerminalNativeTreeStartError, startNativeWatch, stopNativeWatch,
  nativeWatchAnswer, nativeWatchIce, nativeWatchReparent,
  onNativeWatchOffer, onNativeWatchIce, onNativeTopology, onNativeWatchEnded,
} from '../native';
import { freshTreeWsUrl, markTreeAccessRejected } from '../treeAuth';
import { nextNativeWatchGeneration } from '../nativeWatchGeneration';
import { DropWindow, shouldReparentOnDrops, DROP_COOLDOWN_MS } from './dropDetector';
import { newStallState, shouldSelfHeal, STALL_COOLDOWN_MS, STALL_MS, type StallState } from './stallDetector';
import { startViewerSession, endViewerSession } from '../diag';
import { sampleRtcRecoveryStats, sampleRtcStats, type RtcRecoveryStatsUnavailable } from '../rtcStatsSampler';

// Ёмкость нативного relay (passthrough) — сколько зрителей он ретранслирует. Rust держит
// upstream+фанаут; webview только рендерит. Больше браузерного (транскод дорог, натив нет).
const NATIVE_RELAY_CAPACITY = 4;
const DISCOVERY_CONNECT_TIMEOUT_MS = 15_000;
const DISCOVERY_DEAD_AFTER_MS = 30_000;
const DISCOVERY_HELLO_INTERVAL_MS = 10_000;
const STATS_UNAVAILABLE_BACKOFF_BASE_MS = 30_000;
const STATS_UNAVAILABLE_BACKOFF_MAX_MS = 5 * 60_000;
const STATS_UNAVAILABLE_GLOBAL_GAP_MS = 3_000;

interface NativeWatchState {
  generation: number;            // exact async start/stop owner; Rust rejects stale generations
  pc: RTCPeerConnection | null; // локальный показ: webview answerer к Rust-offerer
  unlisten: Array<() => void>;
  closed: boolean;
  stopped: boolean;              // exact Rust tombstone is issued at most once for this owner
  pendingIce: any[];
  quality: string;              // Д3: рендишн, который смотрим (дефолт 'source')
  pinned: boolean;              // Д4: ручной выбор качества (авто-ABR не трогает)
}

/** Метаданные приложения вещателя (окно): доходят в stream-live/бэклоге. */
export interface StreamMeta {
  appName?: string;
  appIcon?: string;
  /** Д3 (задел Д4): доступные рендишны стрима из stream-live. Пока всегда ['source']. */
  renditions?: string[];
}

/**
 * P2P relay-tree implementation of VideoTransport (Roadmap-flow-стриминга Д0: browser is
 * strictly a leaf again — the Э8 browser transcode-relay fallback has been removed).
 *
 * The browser NEVER broadcasts (native-only, invariant 2) — `startBroadcast` throws.
 * It also never relays: a browser viewer always joins with `maxChildren:0`. In Tauri,
 * relay is done by Rust (native passthrough); the browser JS path never serves children.
 *
 * Signaling: WS to `/tree` (apps/server/tree.js). Two kinds of connection:
 *  - one long-lived "discovery" socket (no `join`) that listens for
 *    `stream-live`/`stream-end` announcements (live badge without watching yet);
 *  - one dedicated socket per actively-watched `streamId`, joined as
 *    `role:'viewer', native:false, maxChildren`. The parent is always the SDP offerer
 *    (it holds media, we answer); to OUR children WE are the offerer.
 *
 * H.264-only (invariant 4): `setCodecPreferences` forces H.264 both when answering the
 * parent and when offering to children.
 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

interface WatchState {
  ws: WebSocket;
  pc: RTCPeerConnection | null;   // upstream (к родителю) — мы answerer
  parentId: string | null;
  closed: boolean;
  iceServers: RTCIceServer[];
  maxChildren: number;
  joined: boolean;                // join уже отправлен (шлём после welcome — см. sendWatchJoin)
  quality: string;                // Д3: рендишн-дерево, в которое джойнимся (дефолт 'source')
  pinned: boolean;                // Д4: ручной выбор качества (авто-ABR не трогает)
  pendingIce: Array<{ parentId: string; parentGeneration: number; candidate: any }>;
  parentGeneration: number;       // assign-parent владеет ICE, включая ICE-before-offer
  offerGeneration: number;        // новый offer навсегда инвалидирует async-работу старого
  joinFallbackTimer: number | null;
  reparentTimer: number | null;
}


// Приёмный буфер зрителя (дефолт Chrome ~50мс). NACK-ретрансмит УЖЕ работает (webrtc-rs
// configure_nack активен на всех H.264-легах — верифицировано), но опоздавший за буфер пакет
// декодер выбрасывает и фризит до keyframe. Буфер АДАПТИВНЫЙ по rtt апстрима: один NACK-цикл
// ≈ NACK_GENERATOR_INTERVAL(50мс) + rtt, берём ТРИ цикла → target = 3×(50 + rtt) = 150 + 3·rtt,
// клампим в [500, 1000]. rtt берём из ТОПОЛОГИИ сервера (TreeNode.rtt = n.linkRtt, RR-замер
// РОДИТЕЛЯ о линке до нас): для веба это parent↔viewer, для натива — vrelay↔Rust (webview-PC
// лупбек, свой candidate-pair rtt≈0 тут бесполезен). Ставим на ОБА приёмника (audio+video):
// буфер только у видео развёл бы губы со звуком.
//
// Почему пределы подняты с [300, 600] и цикл с двух до трёх: задержка признана НЕ дорогой
// (до секунды приемлемо, инвариант «видео < 2с» цел — сам буфер это его основная статья),
// а фриз до GOP-IDR стоит 4с. Асимметрия платежа однозначная. До 2026-08-02 буфер был
// единственным рычагом и его двигали в обе стороны (350 → 500 → 300 → адаптивный 300-600),
// потому что настоящую причину — окно anti-replay SRTP в 64 пакета, выбрасывавшее пришедший
// ретрансмит, — искали не там (см. link.rs, SRTP_REPLAY_WINDOW). Теперь буфер не затыкает
// дыру, а честно покрывает три попытки ретрансмита.
const JITTER_MIN_MS = 500;
const JITTER_MAX_MS = 1000;
function jitterTargetForRtt(rttMs: number): number {
  const t = 150 + 3 * Math.max(0, rttMs || 0); // 3×(NACK_GENERATOR_INTERVAL + rtt)
  return Math.min(JITTER_MAX_MS, Math.max(JITTER_MIN_MS, t));
}
function applyJitterTarget(r: RTCRtpReceiver | null | undefined, targetMs: number) {
  if (!r) return;
  const rr = r as any;
  try { rr.jitterBufferTarget = targetMs; } catch { /**/ }        // стандарт (мс)
  try { rr.playoutDelayHint = targetMs / 1000; } catch { /**/ }   // legacy-имя Chrome (сек)
}

// Форс H.264 (инвариант 4) на видео-трансивере PC при приёме от родителя (receiver.track video).
function preferH264(pc: RTCPeerConnection) {
  const caps = (window as any).RTCRtpReceiver?.getCapabilities?.('video');
  const h264 = (caps?.codecs || []).filter((c: any) => c.mimeType.toLowerCase() === 'video/h264');
  if (!h264.length) return; // browser too old / no capability introspection — negotiate whatever the offer had
  pc.getTransceivers().forEach((t) => {
    const isVideo = t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video';
    if (!isVideo) return;
    try { t.setCodecPreferences(h264); } catch { /**/ }
  });
}

export class TreeVideoTransport implements VideoTransport {
  private me = '';
  private serverId = '';
  private closed = false;
  private discoveryWs: WebSocket | null = null;
  private helloTimer: number | null = null; // периодический ре-hello: самолечение пропущенных stream-live
  private discoveryRetryTimer: number | null = null;
  private discoveryConnectTimer: number | null = null;
  private discoveryBacklogTimer: number | null = null;
  private discoveryConnectStartedAt = 0;
  private discoveryLastRxAt = 0;
  private discoveryLifecycleAttached = false;
  // `freshTreeWsUrl()` may remain pending across a detach/attach (sleep, account/server switch).
  // A boolean would make the new lifecycle wait for that abandoned promise. The exact owner is
  // invalidated synchronously by both attach and detach, so a replacement lifecycle can open now
  // and a late predecessor cannot construct a socket or mutate retry state.
  private discoveryLifecycleGeneration = 0;
  private discoveryOpening: { generation: number; token: symbol } | null = null;
  private dropTimer: number | null = null;   // Д7: 1с-опрос дропов кадров (общий на все watch'и)
  private dropChecks = new Map<string, { pc: RTCPeerConnection; run: Promise<void> }>();
  private statsUnavailable = new Map<string, { pc: RTCPeerConnection; since: number }>();
  // Survives an internal keepVideo re-watch, otherwise a permanently wedged browser stats engine
  // would churn every stream every few seconds. A real report resets it; final unwatch deletes it.
  private statsRecoveryBackoff = new Map<string, { attempts: number; notBefore: number }>();
  private nextStatsUnavailableRecoveryAt = 0;
  // Д7: скользящее окно дропов + клиентский cooldown на стрим (ключ — базовый streamId).
  private dropWindows = new Map<string, DropWindow>();
  private dropCooldownUntil = new Map<string, number>();
  // Self-heal (диаг фризов): framesDecoded замер при live-стриме → авто re-watch (см. stallDetector).
  private stallStates = new Map<string, StallState>();
  private healCooldownUntil = new Map<string, number>();
  /** Живые стримы гильдии + метаданные приложения из stream-live (иконка/имя — Э-icon). */
  private liveStreams = new Map<string, StreamMeta>();
  private watches = new Map<string, WatchState>();
  // Browser watch has an async auth-refresh gate before WebSocket construction. The owner token
  // prevents a late refresh from resurrecting a watch which the user already closed/replaced.
  private browserWatchStarts = new Map<string, symbol>();
  // One reconnect owner per logical stream. Old browser/native generations must not leave a pile
  // of delayed callbacks which can all wake after a mobile radio/VPN flap and race to resurrect
  // the stream with stale quality settings.
  private watchRetryTimers = new Map<string, number>();
  // Намерение смотреть стрим — отдельно от живого WatchState. WatchState исчезает и при обрыве
  // сокета (перед ре-watch), поэтому «нет записи в watches» не отличало «переподключаемся» от
  // «пользователь закрыл». Ре-watch сверяется именно с этим набором.
  private intended = new Set<string>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;

  private videoTracks = new Map<string, MediaStreamVideoHandle>();
  // Бесшовная смена качества/reparent/reconnect: контейнер-MediaStream на streamId живёт
  // ПОВЕРХ PC. ontrack не создаёт новый handle, а подменяет треки ВНУТРИ контейнера
  // (removeTrack старого kind + addTrack) — <video>.srcObject остаётся тем же объектом,
  // плитка (StreamTile, эффект по streamKey) не размонтируется, фуллскрин живёт.
  private containers = new Map<string, MediaStream>();
  // Failsafe бесшовного переключения: трек не приехал за N с → честный delVideo + тост
  // (иначе вечный замороженный кадр). Снимается приходом видео-трека (upsertTrack).
  private videoFailsafe = new Map<string, number>();
  private switchFailedCbs = new Set<(streamId: string) => void>();
  private streamInfoByKey = new Map<string, StreamInfo>();
  private treeInfoByStream = new Map<string, TreeInfo>();
  /** Прошлые кумулятивные jitterBufferDelay/Count по стриму — для дельты в getRtpStats. */
  private lastJb = new Map<string, { delay: number; count: number }>();
  private topologyByStream = new Map<string, TreeTopology>();
  private reWatchAttempts = new Map<string, number>(); // неудачные круги переустановки просмотра подряд
  private webReconnectAttempts = new Map<string, number>();
  private topologyCbs = new Set<(streamId: string) => void>();
  private reparentDeniedCbs = new Set<(streamId: string, reason: string) => void>();
  private renditionUnavailableCbs = new Set<(streamId: string, rendition: string, reason: string) => void>();
  // Грид: watch-слот на каждый стрим (Rust WatchState = HashMap по stream_id). stopNativeWatch(streamId)
  // адресный — teardown одного стрима не трогает остальные плитки.
  private nativeWatches = new Map<string, NativeWatchState>();

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: MediaStreamVideoHandle, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();

  /* ---------- lifecycle ---------- */
  private readonly onDiscoveryReturn = () => { this.kickDiscovery(); };
  private readonly onDiscoveryVisibility = () => {
    if (document.visibilityState === 'visible') this.kickDiscovery();
  };

  private attachDiscoveryLifecycle() {
    if (this.discoveryLifecycleAttached) return;
    this.discoveryLifecycleAttached = true;
    window.addEventListener('online', this.onDiscoveryReturn);
    window.addEventListener('pageshow', this.onDiscoveryReturn);
    document.addEventListener('visibilitychange', this.onDiscoveryVisibility);
  }

  private detachDiscoveryLifecycle() {
    if (!this.discoveryLifecycleAttached) return;
    this.discoveryLifecycleAttached = false;
    window.removeEventListener('online', this.onDiscoveryReturn);
    window.removeEventListener('pageshow', this.onDiscoveryReturn);
    document.removeEventListener('visibilitychange', this.onDiscoveryVisibility);
  }

  private clearDiscoveryConnectDeadline() {
    if (this.discoveryConnectTimer !== null) clearTimeout(this.discoveryConnectTimer);
    this.discoveryConnectTimer = null;
    this.discoveryConnectStartedAt = 0;
  }

  private clearDiscoveryBacklogDeadline() {
    if (this.discoveryBacklogTimer !== null) clearTimeout(this.discoveryBacklogTimer);
    this.discoveryBacklogTimer = null;
  }

  private clearWatchRetry(streamId: string) {
    const timer = this.watchRetryTimers.get(streamId);
    if (timer !== undefined) clearTimeout(timer);
    this.watchRetryTimers.delete(streamId);
  }

  private scheduleWatchRetry(streamId: string, delay: number, retry: () => void) {
    this.clearWatchRetry(streamId);
    const timer = window.setTimeout(() => {
      if (this.watchRetryTimers.get(streamId) !== timer) return;
      this.watchRetryTimers.delete(streamId);
      retry();
    }, delay);
    this.watchRetryTimers.set(streamId, timer);
  }

  private clearWatchStateTimers(st: WatchState) {
    if (st.joinFallbackTimer !== null) clearTimeout(st.joinFallbackTimer);
    if (st.reparentTimer !== null) clearTimeout(st.reparentTimer);
    st.joinFallbackTimer = null;
    st.reparentTimer = null;
  }

  private armWatchJoinFallback(streamId: string, st: WatchState) {
    if (st.joinFallbackTimer !== null) clearTimeout(st.joinFallbackTimer);
    const timer = window.setTimeout(() => {
      if (st.joinFallbackTimer !== timer) return;
      st.joinFallbackTimer = null;
      if (!st.closed && this.watches.get(streamId) === st) this.sendWatchJoin(streamId, st);
    }, 1500);
    st.joinFallbackTimer = timer;
  }

  private clearWatchReparentTimer(st: WatchState) {
    if (st.reparentTimer !== null) clearTimeout(st.reparentTimer);
    st.reparentTimer = null;
  }

  private scheduleDiscoveryReconnect(delay = 3000) {
    if (this.closed || this.discoveryRetryTimer !== null) return;
    this.discoveryRetryTimer = window.setTimeout(() => {
      this.discoveryRetryTimer = null;
      this.openDiscovery();
    }, delay);
  }

  private retireDiscoverySocket(current: WebSocket, reconnectDelay: number | null = 3000): boolean {
    if (this.discoveryWs !== current) return false;
    this.discoveryWs = null;
    this.discoveryLastRxAt = 0;
    this.clearDiscoveryConnectDeadline();
    this.clearDiscoveryBacklogDeadline();
    try { current.close(); } catch { /**/ }
    if (reconnectDelay !== null) this.scheduleDiscoveryReconnect(reconnectDelay);
    return true;
  }

  private sendDiscoveryHello(current: WebSocket) {
    if (this.discoveryWs !== current || current.readyState !== WebSocket.OPEN) return;
    try { current.send(JSON.stringify({ t: 'hello', serverId: this.serverId })); }
    catch { this.retireDiscoverySocket(current, 0); }
  }

  private discoveryHeartbeatTick() {
    const current = this.discoveryWs;
    if (!current || current.readyState !== WebSocket.OPEN) return;
    if (this.discoveryLastRxAt && Date.now() - this.discoveryLastRxAt > DISCOVERY_DEAD_AFTER_MS) {
      this.retireDiscoverySocket(current, 0);
      return;
    }
    this.sendDiscoveryHello(current);
  }

  private kickDiscovery() {
    if (this.closed) return;
    if (this.discoveryRetryTimer !== null) {
      clearTimeout(this.discoveryRetryTimer);
      this.discoveryRetryTimer = null;
    }
    const current = this.discoveryWs;
    if (current?.readyState === WebSocket.CONNECTING) {
      if (this.discoveryConnectStartedAt
        && Date.now() - this.discoveryConnectStartedAt >= DISCOVERY_CONNECT_TIMEOUT_MS) {
        this.retireDiscoverySocket(current, null);
        this.openDiscovery();
      }
      return;
    }
    if (current?.readyState === WebSocket.OPEN) {
      if (this.discoveryLastRxAt && Date.now() - this.discoveryLastRxAt > DISCOVERY_DEAD_AFTER_MS) {
        this.retireDiscoverySocket(current, null);
        this.openDiscovery();
        return;
      }
      this.sendDiscoveryHello(current);
      return;
    }
    if (current) this.retireDiscoverySocket(current, null);
    this.openDiscovery();
  }

  attach(_room: Room, ctx: { me: string; serverId: string }) {
    this.discoveryLifecycleGeneration += 1;
    this.discoveryOpening = null;
    this.me = ctx.me;
    this.serverId = ctx.serverId;
    this.closed = false;
    this.attachDiscoveryLifecycle();
    this.openDiscovery();
    // Самолечение: периодически шлём hello по живому сокету. onHello на сервере идемпотентен —
    // на каждый hello переотдаёт бэклог живых стримов (tree.js), а клиентский fresh-гард в
    // stream-live не даёт дублей. Так пропущенный stream-live (полуоткрытый WS / микрообрыв /
    // сон вкладки) подхватывается за ≤15с, а не «висит до F5». LiveKit-путь так самолечится
    // сам (живой опрос комнаты 3с-таймером) — уравниваем tree.
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = window.setInterval(() => this.discoveryHeartbeatTick(), DISCOVERY_HELLO_INTERVAL_MS);
    // Д7: единый 1с-таймер детектора дропов на все watch'и (один таймер, а не per-watch —
    // per-watch таймеры в этом файле уже были источником утечек). Отбраковка плохого родителя.
    if (this.dropTimer) clearInterval(this.dropTimer);
    this.dropTimer = window.setInterval(() => this.dropDetectorTick(), 1000);
  }
  onRoomConnected() { /* discovery socket already syncs live-stream backlog on connect */ }
  detach() {
    this.discoveryLifecycleGeneration += 1;
    this.discoveryOpening = null;
    this.closed = true;
    this.detachDiscoveryLifecycle();
    if (this.helloTimer) { clearInterval(this.helloTimer); this.helloTimer = null; }
    if (this.discoveryRetryTimer !== null) { clearTimeout(this.discoveryRetryTimer); this.discoveryRetryTimer = null; }
    this.clearDiscoveryConnectDeadline();
    this.clearDiscoveryBacklogDeadline();
    this.discoveryLastRxAt = 0;
    if (this.dropTimer) { clearInterval(this.dropTimer); this.dropTimer = null; }
    this.dropWindows.clear();
    this.dropCooldownUntil.clear();
    this.dropChecks.clear();
    if (this.discoveryWs) { try { this.discoveryWs.close(); } catch { /**/ } this.discoveryWs = null; }
    this.watches.forEach((_w, streamId) => this.unwatch(streamId));
    this.watches.clear();
    // Pending browser starts are not in `watches` yet, but already own a diagnostic session and
    // intent. Finish them through the same path before dropping their owner tokens.
    for (const streamId of [...this.browserWatchStarts.keys()]) this.unwatch(streamId);
    this.browserWatchStarts.clear();
    this.watchRetryTimers.forEach((timer) => clearTimeout(timer));
    this.watchRetryTimers.clear();
    this.nativeWatches.forEach((st, streamId) => this.nativeUnwatch(streamId, st));
    this.nativeWatches.clear();
    this.intended.clear();
    this.liveStreams.clear();
    this.videoTracks.clear();
    this.containers.clear();
    this.videoFailsafe.forEach((t) => clearTimeout(t));
    this.videoFailsafe.clear();
    this.streamInfoByKey.clear();
    this.topologyByStream.clear();
    this.reWatchAttempts.clear();
  }

  private async openDiscovery() {
    if (this.closed) return;
    if (this.discoveryRetryTimer !== null) { clearTimeout(this.discoveryRetryTimer); this.discoveryRetryTimer = null; }
    // Повторный lifecycle-kick не создаёт второй handshake поверх живого. Закрытый объект
    // снимаем адресно, чтобы его поздний onclose не мог затронуть новый сокет.
    if (this.discoveryWs?.readyState === WebSocket.OPEN
      || this.discoveryWs?.readyState === WebSocket.CONNECTING) return;
    if (this.discoveryOpening?.generation === this.discoveryLifecycleGeneration) return;
    if (this.discoveryWs) this.retireDiscoverySocket(this.discoveryWs, null);
    const opening = { generation: this.discoveryLifecycleGeneration, token: Symbol('discovery') };
    this.discoveryOpening = opening;
    const ownsOpening = () => !this.closed
      && this.discoveryLifecycleGeneration === opening.generation
      && this.discoveryOpening === opening;
    let wsUrl: string;
    try {
      // Persistent access JWTs are short-lived. A reconnect after sleep/network loss must refresh
      // before constructing the socket instead of looping 401 with the old in-memory token.
      wsUrl = await freshTreeWsUrl();
    } catch (error) {
      if (!ownsOpening()) return;
      this.discoveryOpening = null;
      if (!isTerminalSessionError(error)) this.scheduleDiscoveryReconnect();
      return;
    }
    // detach/attach may have replaced this exact lifecycle while auth refresh was pending. Check
    // before both WebSocket construction and every shared-state write below.
    if (!ownsOpening()) return;
    this.discoveryOpening = null;
    if (this.closed || this.discoveryLifecycleGeneration !== opening.generation
      || this.discoveryWs?.readyState === WebSocket.OPEN
      || this.discoveryWs?.readyState === WebSocket.CONNECTING) return;
    let ws: WebSocket;
    // throw конструктора (битый URL/CSP/токен на миг) раньше делал голый return без ретрая —
    // onclose не будет (сокет не создан), discovery умирал НАВСЕГДА до F5. Планируем ретрай.
    try { ws = new WebSocket(wsUrl); } catch { this.scheduleDiscoveryReconnect(); return; }
    this.discoveryWs = ws;
    this.discoveryConnectStartedAt = Date.now();
    this.discoveryConnectTimer = window.setTimeout(() => {
      if (this.discoveryWs !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      this.retireDiscoverySocket(ws, 0);
    }, DISCOVERY_CONNECT_TIMEOUT_MS);
    // Сверка после (ре)коннекта: stream-end, пришедший пока сокет лежал (окно реконнекта),
    // потерян — бэклог при re-hello объявляет только ЖИВЫЕ стримы. Что не переобъявлено за 4с
    // после hello, считаем закончившимся. НО активные watch не трогаем: при медленном бэклоге
    // (сеть уже деградировала) реальный стрим мог опоздать >окна — снос вышибал бы зрителя из
    // живого стрима навсегда (unwatch → st.closed, авто-ре-watch не срабатывает). Их teardown —
    // только по явному stream-end.
    const announced = new Set<string>();
    ws.onopen = () => {
      if (this.discoveryWs !== ws) { try { ws.close(); } catch { /**/ } return; }
      this.clearDiscoveryConnectDeadline();
      this.discoveryLastRxAt = Date.now();
      this.sendDiscoveryHello(ws);
      if (this.discoveryWs !== ws) return;
      this.clearDiscoveryBacklogDeadline();
      const backlogTimer = window.setTimeout(() => {
        if (this.discoveryBacklogTimer !== backlogTimer) return;
        this.discoveryBacklogTimer = null;
        if (this.closed || this.discoveryWs !== ws) return;
        for (const identity of [...this.liveStreams.keys()]) {
          if (announced.has(identity)) continue;
          if (this.watches.has(identity) || this.nativeWatches.has(identity)) continue; // активный просмотр — не сносим по таймауту
          this.liveStreams.delete(identity);
          this.streamStopCbs.forEach((cb) => cb(identity));
        }
      }, 7000);
      this.discoveryBacklogTimer = backlogTimer;
      // Окно бэклога: 4с рвало ЖИВОЙ стрим при медленном re-hello (badge/watch чужого стрима
      // пропадал — «стоп одного рубит другие»); 7с + периодический re-hello подхватят обратно.
    };
    // Сервер узнаёт, в каком сервере (гильдии) мы сидим, только из hello —
    // до него бэклог живых стримов не шлётся (см. tree.js onHello), а после join'а
    // вещателя используется, чтобы не разослать stream-live/stream-end в чужие серверы.
    ws.onmessage = (ev) => {
      if (this.discoveryWs !== ws) return;
      this.discoveryLastRxAt = Date.now(); // welcome, hello-ack и stream-события одинаково доказывают живость
      let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'welcome') {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) this.iceServers = msg.iceServers;
      } else if (msg.t === 'hello-ack') {
        // quiet discovery socket: application-level ACK is visible to browser JS, unlike WS pong
      } else if (msg.t === 'stream-live') {
        announced.add(msg.identity);
        const fresh = !this.liveStreams.has(msg.identity);
        // meta обновляем и для уже известного стрима — повторный announce после rejoin вещателя.
        // Д3 (задел Д4): renditions[] сохраняем, пока не используем (UI-выбор качества — Д4).
        this.liveStreams.set(msg.identity, { appName: msg.appName || undefined, appIcon: msg.appIcon || undefined, renditions: Array.isArray(msg.renditions) ? msg.renditions : undefined });
        if (fresh) this.streamStartCbs.forEach((cb) => cb(msg.identity, !!msg.initial));
      } else if (msg.t === 'stream-end') {
        // unwatch ДО удаления из liveStreams: engine.onStreamStop роутит unwatch через
        // transportFor → isRemoteBroadcasting; если запись уже удалена, он уйдёт в LiveKit
        // (no-op) и tree-watch (PC/relay) останется жить с повисшим кадром. Сносим свой
        // watch сами — teardown не зависит от порядка колбэков (idempotent, no-op если
        // не смотрели; в Tauri уходит в nativeUnwatch → Rust close_all).
        this.unwatch(msg.identity);
        // Гард по факту удаления: тот же конец стрима может прийти и по discovery-stream-end,
        // и по relay-watch-ended (натив) — без гарда «закончил трансляцию» напечаталось бы дважды.
        if (this.liveStreams.delete(msg.identity)) this.streamStopCbs.forEach((cb) => cb(msg.identity));
      }
    };
    // Реконнект планирует ТОЛЬКО текущий сокет: иначе закрытие прежнего (в начале openDiscovery)
    // или осиротевшего сокета зациклило бы переоткрытие каждые 3с.
    ws.onclose = (ev) => {
      if (this.discoveryWs !== ws) return;
      if (ev.code === 4001) markTreeAccessRejected(wsUrl);
      this.discoveryWs = null;
      this.discoveryLastRxAt = 0;
      this.clearDiscoveryConnectDeadline();
      this.clearDiscoveryBacklogDeadline();
      this.scheduleDiscoveryReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /**/ } };
  }

  /* ---------- broadcasting (browser never broadcasts — native-only, CLAUDE.md invariant 2) ---------- */
  async startBroadcast(_streamId: string, _source: MediaStream): Promise<void> {
    throw new Error('Вещание доступно только из нативного приложения');
  }
  async stopBroadcast(_streamId: string): Promise<void> { /* no-op: nothing was ever started */ }
  isBroadcasting(_streamId: string) { return false; }
  isRemoteBroadcasting(identity: string) { return this.liveStreams.has(identity); }
  async getScreenStats(_streamId: string): Promise<string | null> { return null; }

  /* ---------- watching (remote, leaf) ---------- */
  // Д3: UI-ключ у зрителя — базовый streamId; `quality` выбирает рендишн-дерево
  // (`streamId::quality` на сервере). Дефолт 'source' → поведение как «до». Смена
  // качества = unwatch()+watch() (Д4 добавит меню).
  watch(streamId: string, quality: string = 'source', pinned: boolean = false) {
    if (this.watches.has(streamId) || this.nativeWatches.has(streamId) || this.browserWatchStarts.has(streamId)) return;
    this.clearWatchRetry(streamId);
    this.intended.add(streamId); // намерение смотреть живёт ОТДЕЛЬНО от сокета (см. intended)
    // Диагностика просмотра (diag.ts): freezeCount/потери раз в 2с, сдаётся на сервер в
    // unwatch. PC берём лениво — он появится позже (после assign-parent / offer от Rust),
    // и у нативного зрителя это другой объект (лупбек webview↔Rust).
    startViewerSession(streamId, () => this.watches.get(streamId)?.pc ?? this.nativeWatches.get(streamId)?.pc ?? null);
    // В Tauri видео/relay держит Rust (native passthrough): webview не джойнится в дерево
    // сам, а получает поток от локального Rust-пира через IPC (см. nativeWatch).
    if (isTauri) { this.nativeWatch(streamId, quality, pinned); return; }
    const owner = Symbol(streamId);
    this.browserWatchStarts.set(streamId, owner);
    void this.openBrowserWatch(streamId, quality, pinned, owner);
  }

  private async openBrowserWatch(streamId: string, quality: string, pinned: boolean, owner: symbol) {
    let wsUrl: string;
    try {
      wsUrl = await freshTreeWsUrl();
    } catch (error) {
      if (isTerminalSessionError(error)) {
        // A terminal refresh owns the same cleanup as an explicit cancellation: no orphan intent
        // or diagnostic timer may survive after the account session is gone.
        if (this.browserWatchStarts.get(streamId) === owner) this.unwatch(streamId);
      } else {
        this.scheduleBrowserWatchStartRetry(streamId, quality, pinned, owner);
      }
      return;
    }
    // unwatch/account/server teardown can win while native/browser auth refresh is in flight.
    if (this.closed || !this.intended.has(streamId) || this.browserWatchStarts.get(streamId) !== owner) return;
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); }
    catch {
      this.scheduleBrowserWatchStartRetry(streamId, quality, pinned, owner);
      return;
    }
    const st: WatchState = {
      ws, pc: null, parentId: null, closed: false, iceServers: this.iceServers, pendingIce: [],
      maxChildren: 0, joined: false, quality, pinned, parentGeneration: 0, offerGeneration: 0,
      joinFallbackTimer: null, reparentTimer: null,
    };
    if (this.browserWatchStarts.get(streamId) !== owner) { try { ws.close(); } catch { /**/ } return; }
    this.browserWatchStarts.delete(streamId);
    this.watches.set(streamId, st);

    // join шлём НЕ в onopen, а после welcome (см. sendWatchJoin): welcome несёт актуальные
    // iceServers для создаваемого затем peer connection.
    // Fallback: если welcome не пришёл за 1.5с — джойнимся всё равно (guard не даст дубль).
    ws.onopen = () => {
      if (!st.closed && this.watches.get(streamId) === st) this.armWatchJoinFallback(streamId, st);
    };
    ws.onmessage = (ev) => this.onWatchMessage(streamId, st, ev);
    ws.onclose = (ev) => {
      if (st.closed) return;
      if (ev.code === 4001) markTreeAccessRejected(wsUrl);
      // Стрим ещё жив → бесшовный реконнект: плитку держим (keepVideo), взводим failsafe.
      // Стрим кончился → полный снос (discovery уже снял liveStreams).
      const live = !this.closed && this.liveStreams.has(streamId);
      this.teardownWatch(streamId, st, live);
      // Ре-watch: сокет оборвался (сеть/рестарт/heartbeat-terminate), но стрим ещё жив —
      // переподключаемся. Дискавери-сокет снимет liveStreams при stream-end, тогда ретрай
      // сам заглохнет (guard). Не дублируем, если watch уже пересоздан.
      if (live) {
        this.armVideoFailsafe(streamId, 15000); // реконнект (сеть) медленнее смены качества
        const attempt = this.webReconnectAttempts.get(streamId) || 0;
        this.webReconnectAttempts.set(streamId, attempt + 1);
        const delay = Math.min(30_000, 1500 * 2 ** Math.min(attempt, 5));
        this.scheduleWatchRetry(streamId, delay, () => {
          if (!this.closed && this.intended.has(streamId) && !this.watches.has(streamId) && !this.nativeWatches.has(streamId) && this.liveStreams.has(streamId)) this.watch(streamId, st.quality, st.pinned);
        });
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /**/ } };
  }

  private scheduleBrowserWatchStartRetry(streamId: string, quality: string, pinned: boolean, owner: symbol) {
    if (this.closed || !this.intended.has(streamId) || this.browserWatchStarts.get(streamId) !== owner) return;
    const attempt = this.webReconnectAttempts.get(streamId) || 0;
    this.webReconnectAttempts.set(streamId, attempt + 1);
    const delay = Math.min(30_000, 1500 * 2 ** Math.min(attempt, 5));
    this.scheduleWatchRetry(streamId, delay, () => {
      if (this.closed || !this.intended.has(streamId)
        || this.browserWatchStarts.get(streamId) !== owner) return;
      if (!this.liveStreams.has(streamId)) { this.unwatch(streamId); return; }
      void this.openBrowserWatch(streamId, quality, pinned, owner);
    });
  }

  // Отправка join после welcome (Roadmap Д0: браузер снова строго лист — maxChildren всегда 0,
  // никакого re-serve детям). Web-лист всегда отправляет symmetricNat:false: NAT-диагностика
  // не влияет на его нулевую relay-ёмкость и никогда не должна держать первый кадр в ожидании STUN.
  // Д3: quality выбирает рендишн-дерево (дефолт 'source').
  private sendWatchJoin(streamId: string, st: WatchState) {
    if (st.joinFallbackTimer !== null) {
      clearTimeout(st.joinFallbackTimer);
      st.joinFallbackTimer = null;
    }
    if (st.joined || st.closed) return;
    st.joined = true;
    st.maxChildren = 0;
    try { st.ws.send(JSON.stringify({ t: 'join', streamId, quality: st.quality, pinned: st.pinned, role: 'viewer', native: false, maxChildren: st.maxChildren, identity: this.me, symmetricNat: false, serverId: this.serverId })); } catch { /**/ }
  }

  // opts.keepVideo — бесшовный режим (смена качества/self-heal/reconnect): watch сносится,
  // но плитка живёт на последнем кадре (контейнер/handle не трогаем) до нового трека.
  // Вызывающий обязан взвести armVideoFailsafe — иначе при провале переключения кадр
  // замёрзнет навсегда.
  unwatch(streamId: string, opts?: { keepVideo?: boolean }) {
    const keep = !!opts?.keepVideo;
    // Снятие намерения — ДО любых ранних выходов. Иначе отмена, пришедшая в окно между обрывом
    // сокета (teardownWatch уже убрал запись из watches) и срабатыванием таймера ре-watch, терялась:
    // unwatch выходил на `if (!st) return`, а ретрай видел «меня нет в watches» и воскрешал просмотр —
    // видео грузилось навсегда и невидимо. keepVideo — бесшовный путь (смена качества/реконнект),
    // там намерение как раз сохраняется.
    if (!keep) {
      this.intended.delete(streamId);
      this.statsUnavailable.delete(streamId);
      this.statsRecoveryBackoff.delete(streamId);
      this.clearWatchRetry(streamId);
    }
    // Cancel a socket that is still behind the async access-refresh gate. The exact owner check in
    // openBrowserWatch prevents its late completion from resurrecting a user-cancelled tile.
    if (this.browserWatchStarts.delete(streamId)) {
      endViewerSession(streamId);
      this.topologyByStream.delete(streamId);
      if (!keep) {
        this.lastJb.delete(streamId);
        this.clearDropState(streamId);
        this.dropVideo(streamId);
      }
      return;
    }
    const nst = this.nativeWatches.get(streamId);
    if (nst) { this.nativeUnwatch(streamId, nst, keep); return; }
    const st = this.watches.get(streamId);
    if (!st) {
      // Записи уже нет (снёс teardownWatch при обрыве ws, а ре-watch не состоялся) — но диаг-сессия
      // зрителя живёт отдельно и осталась бы висеть до закрытия вкладки вместе со своим тиком.
      endViewerSession(streamId);
      this.topologyByStream.delete(streamId);
      if (!keep) {
        this.lastJb.delete(streamId);
        this.clearDropState(streamId);
        this.dropVideo(streamId);
      }
      return;
    }
    // Сессия закрывается ЗДЕСЬ, а не в teardownWatch: тот зовётся и при обрыве ws с
    // последующим ре-watch — сдавали бы огрызок на каждый реконнект.
    endViewerSession(streamId);
    st.closed = true;
    this.clearWatchStateTimers(st);
    try { st.ws.send(JSON.stringify({ t: 'leave' })); } catch { /**/ }
    try { st.ws.close(); } catch { /**/ }
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.topologyByStream.delete(streamId); // как в nativeUnwatch: устаревшая топология правит jitter-буфер
    this.lastJb.delete(streamId);
    this.clearDropState(streamId);
    if (!keep) this.dropVideo(streamId);
  }
  private teardownWatch(streamId: string, st: WatchState, keepVideo = false) {
    st.closed = true;
    this.clearWatchStateTimers(st);
    if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; }
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    if (!keepVideo) this.topologyByStream.delete(streamId);
    this.lastJb.delete(streamId);
    this.clearDropState(streamId);
    if (!keepVideo) this.dropVideo(streamId);
  }
  // Полный снос видео-стороны: плитка, контейнер, failsafe. Единственный путь удаления
  // контейнера — иначе застрявший failsafe/повторный teardown работают по мусору.
  private dropVideo(streamId: string) {
    this.reWatchAttempts.delete(streamId);
    this.webReconnectAttempts.delete(streamId);
    this.statsRecoveryBackoff.delete(streamId);
    this.clearVideoFailsafe(streamId);
    this.containers.delete(streamId);
    this.delVideo(streamId);
  }
  // Д7: чистим окно/cooldown детектора дропов (утечка таймеров/окон — известная категория багов тут).
  private clearDropState(streamId: string) {
    this.dropWindows.delete(streamId); this.dropCooldownUntil.delete(streamId);
    this.stallStates.delete(streamId); this.healCooldownUntil.delete(streamId);
    this.statsUnavailable.delete(streamId);
    // The browser operation itself remains bounded by rtcStatsSampler until real settlement, but a
    // closed unique stream id must not stay strongly retained by the per-stream continuation fence.
    this.dropChecks.delete(streamId);
  }

  /** Последний известный tree-info (позиция в дереве) для смотрибельного стрима. */
  getTreeInfo(streamId: string): TreeInfo | null {
    const ti = this.treeInfoByStream.get(streamId);
    if (ti) return ti;
    // Натив-путь (Tauri): tree-info приходит на Rust-сокет и в webview не пробрасывается —
    // считаем позицию из топологии (relay-topology доходит по IPC). Без этого у зрителя
    // в приложении панель показателей была пустой.
    const topo = this.topologyByStream.get(streamId);
    if (!topo || !topo.you) return null;
    const you = topo.nodes.find((n) => n.id === topo.you);
    if (!you) return null;
    let treeDepth = 0;
    for (const n of topo.nodes) if (n.depth > treeDepth) treeDepth = n.depth;
    return { myDepth: you.depth, treeDepth, children: you.children, health: 'ok' };
  }

  /** Живая RTP-статистика входящего видео (Э2.1 — дебаг-панель зрителя). `null`,
   * если сейчас не смотрим этот стрим или ещё нет отчёта. */
  private currentWatchPc(streamId: string): RTCPeerConnection | null {
    return this.watches.get(streamId)?.pc ?? this.nativeWatches.get(streamId)?.pc ?? null;
  }

  async getRtpStats(streamId: string): Promise<RtpStats | null> {
    // Натив-путь: смотрим через локальный webview-PC (Rust passthrough-ит RTP как есть —
    // разрешение/fps настоящие, framesDropped локального хопа). Раньше читались только
    // браузерные watches — у зрителя в приложении статов не было вовсе.
    const pc = this.currentWatchPc(streamId);
    if (!pc) return null;
    const report = await sampleRtcStats(pc);
    if (!report || this.closed || this.currentWatchPc(streamId) !== pc) return null;
    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        // Джиттер-буфер: дельта кумулятивных счётчиков между опросами — средняя задержка
        // буфера за интервал (lifetime-среднее врало бы после смены условий сети).
        const prev = this.lastJb.get(streamId);
        const delay = stat.jitterBufferDelay || 0;
        const count = stat.jitterBufferEmittedCount || 0;
        this.lastJb.set(streamId, { delay, count });
        const dCount = prev ? count - prev.count : count;
        const dDelay = prev ? delay - prev.delay : delay;
        const jitterBufferMs = dCount > 0 ? (dDelay / dCount) * 1000 : 0;
        return {
          width: stat.frameWidth || 0,
          height: stat.frameHeight || 0,
          fps: stat.framesPerSecond || 0,
          framesDropped: stat.framesDropped || 0,
          packetsLost: stat.packetsLost || 0,
          jitterBufferMs,
        };
      }
    }
    return null;
  }

  /* ---------- Д7: детектор дропов кадров (отбраковка плохого родителя) ---------- */
  // Общий 1с-тик для ОБОИХ путей: у браузерного зрителя watch.pc — реальный upstream к
  // родителю (видит сетевые потери), у нативного nativeWatch.pc — ЛОКАЛЬНЫЙ лупбек webview↔Rust
  // (packetsLost там ~0, реальные потери на upstream Rust↔родитель). Поэтому детектор ЕСТЕСТВЕННО
  // молчит для натива (второй сигнал packetsLost не набирается — рендерные дропы слабого ПК не
  // мигрируют), а отбраковку плохого родителя у нативного зрителя делает СЕРВЕР по upstream
  // loss + framesDroppedPct (tree.js frameDropReparent) — так натив не слепой (см. отчёт Д7).
  private dropDetectorTick() {
    if (this.closed) return;
    // Собираем стримы, которые сейчас смотрим (браузер + натив); ключ — базовый streamId.
    const ids = new Set<string>([...this.watches.keys(), ...this.nativeWatches.keys()]);
    for (const streamId of ids) {
      const pc = this.currentWatchPc(streamId);
      if (!pc) continue;
      const existing = this.dropChecks.get(streamId);
      if (existing?.pc === pc) continue;
      const run = this.checkStreamDrops(streamId, pc);
      const owner = { pc, run };
      this.dropChecks.set(streamId, owner);
      void run.finally(() => {
        if (this.dropChecks.get(streamId) === owner) this.dropChecks.delete(streamId);
      });
    }
  }

  private recoverFromStatsUnavailable(
    streamId: string,
    pc: RTCPeerConnection,
    reason: RtcRecoveryStatsUnavailable,
  ) {
    if (this.closed || this.currentWatchPc(streamId) !== pc || !this.liveStreams.has(streamId)) {
      this.statsUnavailable.delete(streamId);
      return;
    }
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) { this.statsUnavailable.delete(streamId); return; }

    const now = Date.now();
    let unavailable = this.statsUnavailable.get(streamId);
    if (!unavailable || unavailable.pc !== pc) {
      unavailable = { pc, since: now };
      this.statsUnavailable.set(streamId, unavailable);
    }
    // Saturation can be caused by abandoned historical peers while current media is still healthy.
    // Require the same exact current PC to remain without recovery stats for the normal stall window.
    if (now - unavailable.since < STALL_MS) return;

    const backoff = this.statsRecoveryBackoff.get(streamId);
    if ((backoff?.notBefore ?? 0) > now || this.nextStatsUnavailableRecoveryAt > now) return;
    const attempts = (backoff?.attempts ?? 0) + 1;
    const delay = Math.min(
      STATS_UNAVAILABLE_BACKOFF_MAX_MS,
      STATS_UNAVAILABLE_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 4),
    );
    this.statsRecoveryBackoff.set(streamId, { attempts, notBefore: now + delay });
    this.nextStatsUnavailableRecoveryAt = now + STATS_UNAVAILABLE_GLOBAL_GAP_MS;

    const current = this.watches.get(streamId) || this.nativeWatches.get(streamId);
    const quality = current?.quality ?? 'source';
    const pinned = current?.pinned ?? false;
    console.warn(`[tree] self-heal: RTC stats ${reason} — re-watch ${streamId}`);
    this.unwatch(streamId, { keepVideo: true });
    this.watch(streamId, quality, pinned);
    this.armVideoFailsafe(streamId);
  }

  private async checkStreamDrops(streamId: string, pc: RTCPeerConnection): Promise<void> {
    let win = this.dropWindows.get(streamId);
    if (!win) { win = new DropWindow(); this.dropWindows.set(streamId, win); }
    // Скрытая вкладка легитимно дропает кадры — сбрасываем окно, чтобы не тащить фоновые дельты
    // в момент возврата в visible. И stall-прогресс двигаем: фоновый декод — не заморозка.
    const hiddenBefore = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hiddenBefore) {
      win.reset(); const ss = this.stallStates.get(streamId); if (ss) ss.lastProgressAt = Date.now();
      return;
    }
    const recoverySample = await sampleRtcRecoveryStats(pc);
    // A late report from an old parent/rewatch is observational only. It must not touch the new
    // drop window, trigger self-heal, request reparent or move cooldowns for the replacement PC.
    if (this.closed || this.currentWatchPc(streamId) !== pc) return;
    if (recoverySample.unavailable) {
      this.recoverFromStatsUnavailable(streamId, pc, recoverySample.unavailable);
      return;
    }
    const report = recoverySample.report;
    if (!report) return;
    this.statsUnavailable.delete(streamId);
    this.statsRecoveryBackoff.delete(streamId);
    const now = Date.now();
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) {
      win.reset(); const ss = this.stallStates.get(streamId); if (ss) ss.lastProgressAt = now;
      return;
    }
    let sample: { framesDropped: number; framesDecoded: number; packetsLost: number } | null = null;
    for (const stat of report.values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        sample = { framesDropped: stat.framesDropped || 0, framesDecoded: stat.framesDecoded || 0, packetsLost: stat.packetsLost || 0 };
        break;
      }
    }
    if (!sample) return;
    win.push({ t: now, ...sample });
    // Self-heal: декодер заклинил (framesDecoded замер) при живом стриме → бесшовный re-watch.
    // Проверяем ДО reparent-решения (у которого свои ранние return), иначе на «спокойных» тиках
    // (нет дропов) self-heal никогда не дошёл бы. Гейт liveStreams — не хилим кончившийся стрим.
    if (this.liveStreams.has(streamId)) {
      let ss = this.stallStates.get(streamId);
      if (!ss) { ss = newStallState(now); this.stallStates.set(streamId, ss); }
      const healCd = this.healCooldownUntil.get(streamId) || 0;
      if (shouldSelfHeal(ss, sample.framesDecoded, now, { hidden, cooldownUntil: healCd })) {
        this.healCooldownUntil.set(streamId, now + STALL_COOLDOWN_MS);
        const cur = this.watches.get(streamId) || this.nativeWatches.get(streamId);
        const q = cur?.quality ?? 'source'; const p = cur?.pinned ?? false;
        console.warn(`[tree] self-heal: framesDecoded замер — re-watch ${streamId}`);
        this.unwatch(streamId, { keepVideo: true });
        this.watch(streamId, q, p);
        this.armVideoFailsafe(streamId);
        return; // PC этого стрима снесён — дальнейший reparent-путь не про него
      }
    }
    const cooldownUntil = this.dropCooldownUntil.get(streamId) || 0;
    if (!shouldReparentOnDrops({ deltas: win.deltas(), hidden, now, cooldownUntil })) return;
    // Прямой ребёнок СЕРВЕРНОГО узла (vrelay/рендишн-корень): pickParent лучшего не найдёт
    // (сервер и так лучший) → reparent зациклился бы «тот же родитель». Правильная реакция —
    // понижение рендишна (Д4 perViewerAbr на сервере). Не мигрируем, ждём сервер.
    if (this.parentIsServer(streamId)) { this.dropCooldownUntil.set(streamId, now + DROP_COOLDOWN_MS); win.reset(); return; }
    this.dropCooldownUntil.set(streamId, now + DROP_COOLDOWN_MS);
    win.reset();
    this.requestReparent(streamId, null, 'frame-drops');
  }
  // Родитель этого стрима — серверный узел (vrelay/рендишн-корень)? Читаем из топологии.
  private parentIsServer(streamId: string): boolean {
    const topo = this.topologyByStream.get(streamId);
    if (!topo || !topo.you) return false;
    const you = topo.nodes.find((n) => n.id === topo.you);
    if (!you || !you.parentId) return false;
    const parent = topo.nodes.find((n) => n.id === you.parentId);
    return !!(parent && (parent.server || parent.virtual));
  }

  private onWatchMessage(streamId: string, st: WatchState, ev: MessageEvent) {
    if (st.closed || this.watches.get(streamId) !== st) return;
    let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case 'welcome': {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) st.iceServers = msg.iceServers;
        this.sendWatchJoin(streamId, st); // join только теперь — знаем iceServers (есть ли TURN)
        break;
      }
      case 'assign-parent': {
        // Reparent: старый upstream-PC закрываем, но плитку ДЕРЖИМ (контейнер живёт) — новый
        // offer от нового родителя приведёт трек в тот же <video> (upsertTrack). Failsafe
        // страхует, если новый родитель не подаёт трек. Раньше delVideo здесь ронял окно на
        // каждый reparent (чёрный пропад, вылет из фуллскрина).
        this.clearWatchReparentTimer(st);
        st.parentGeneration += 1;
        st.offerGeneration += 1;
        if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; this.armVideoFailsafe(streamId); }
        st.parentId = msg.parentId || null;
        st.pendingIce.length = 0;
        break;
      }
      case 'assign-child': {
        // Roadmap Д0: браузер — строго лист (maxChildren:0 в join), сервер никогда не должен
        // назначить нам ребёнка. Безопасный no-op-лог на случай старого закэшированного бандла
        // сервера/старой сессии — не дёргаем удалённый re-serve путь.
        if (msg.childId) console.warn(`[tree] assign-child проигнорирован (браузер — лист): ${msg.childId}`);
        break;
      }
      case 'sdp': {
        // Единственный upstream — от родителя (мы всегда лист, детей не обслуживаем).
        if (msg.from === st.parentId && msg.type === 'offer') { this.onParentOffer(streamId, st, msg.sdp); }
        break;
      }
      case 'ice': {
        if (!msg.candidate) return;
        const parentId = st.parentId;
        if (!parentId || msg.from !== parentId) return;
        const pc = st.pc;
        const parentGeneration = st.parentGeneration;
        if (pc && pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => {});
        else if (st.pendingIce.length < 128) st.pendingIce.push({ parentId, parentGeneration, candidate: msg.candidate });
        break;
      }
      case 'drop-peer': {
        // Мы всегда лист — это может быть только наш родитель (в т.ч. корень-вещатель), пропавший.
        // Если дерево ещё живо, следом придёт 'assign-parent' с новым родителем — тот хендлер
        // закроет старый PC. Если это конец вещания целиком, сервер шлёт то же сообщение каждому
        // зрителю — закрываем watch-сокет сразу (onclose делает полный teardown), иначе <video>
        // застревает на последнем кадре навсегда.
        if (msg.peerId === st.parentId) { try { st.ws.close(); } catch { /**/ } }
        break;
      }
      case 'stream-end': {
        // Ремень-и-подтяжки: при обрушении дерева сервер шлёт stream-end и в watch-сокеты
        // (drop-peer выше ловит только глубину 1 — parentId зрителя глубже это id relay-узла,
        // не вещателя). onclose сделает полный teardown.
        // ГАРД по streamId: тот же тип летит discovery-broadcast'ом по всему серверу (конец ЛЮБОГО
        // стрима) — без сверки конец ЧУЖОГО стрима закрывал бы наш watch-сокет → авто-ре-watch
        // (баг: «выключение одного стрима реконнектит другой»). Реагируем только на конец СВОЕГО.
        if (msg.streamId && msg.streamId !== streamId) break;
        try { st.ws.close(); } catch { /**/ }
        break;
      }
      case 'tree-info': {
        this.treeInfoByStream.set(streamId, {
          myDepth: msg.myDepth ?? 0,
          treeDepth: msg.depth ?? 0,
          children: msg.children ?? 0,
          health: msg.health || 'ok',
        });
        break;
      }
      case 'tree-topology': {
        this.setTopology(streamId, { you: msg.you ?? null, nodes: msg.nodes || [] });
        break;
      }
      case 'reparent-denied': {
        // Ручной выбор родителя не прошёл (нет ёмкости / агент vrelay не поднят / гонка) — тост зрителю.
        this.reparentDeniedCbs.forEach((cb) => cb(streamId, msg.reason || ''));
        break;
      }
      case 'rendition-unavailable': {
        // Д4: рендишн не поднять (кап транскодов / апскейл / нет агента) — сообщаем наверх
        // (тост + фолбэк на source в engine).
        this.renditionUnavailableCbs.forEach((cb) => cb(streamId, msg.rendition || '', msg.reason || ''));
        break;
      }
    }
  }

  /* ---------- quality (Д4) ---------- */
  // Меню Авто/Source/1080/720/480/360 → смена = unwatch+watch(quality, pinned). Ключ — базовый
  // streamId (составной ключ живёт на сервере). 'auto' = снять pin (сервер адаптирует ABR).
  setQuality(streamId: string, mode: string) {
    const pinned = mode !== 'auto';
    const quality = mode === 'auto' ? 'source' : mode;
    const cur = this.watches.get(streamId) || this.nativeWatches.get(streamId);
    if (cur && cur.quality === quality && cur.pinned === pinned) return; // уже в этом режиме
    // Смена ОДНОГО pin при том же качестве не требует пересоздания watch. Раньше сюда попадал
    // фолбэк «вернул на source», когда зритель УЖЕ был на source (pinned=false → true): watch
    // сносился и поднимался заново, а у натива watch-слот один глобальный → стрим закрывался
    // (прод, 2026-07-09). Дерево не меняется — правим pin на месте.
    if (cur && cur.quality === quality) { cur.pinned = pinned; return; }
    // Бесшовно: сносим watch, но контейнер/handle держим — <video> продолжает показывать
    // последний кадр, пока новый трек не приедет в тот же srcObject. Failsafe снимет плитку,
    // если трек так и не пришёл (рендишн не поднялся / оборвался).
    this.unwatch(streamId, { keepVideo: true });
    this.watch(streamId, quality, pinned);
    this.armVideoFailsafe(streamId);
  }
  // Текущий режим для подсветки пункта меню. pinned → рендишн; иначе 'auto' (сервер мог
  // авто-двигать между деревьями — в auto показываем «Авто», реальный рендишн прозрачен).
  getQualityMode(streamId: string): string {
    const st = this.watches.get(streamId) || this.nativeWatches.get(streamId);
    if (!st) return 'auto';
    return st.pinned ? st.quality : 'auto';
  }
  onRenditionUnavailable(cb: (streamId: string, rendition: string, reason: string) => void) { this.renditionUnavailableCbs.add(cb); return () => { this.renditionUnavailableCbs.delete(cb); }; }

  private async onParentOffer(streamId: string, st: WatchState, sdp: string) {
    if (st.closed || this.watches.get(streamId) !== st) return;
    const parentId = st.parentId;
    if (!parentId) return;
    const parentGeneration = st.parentGeneration;
    const offerGeneration = ++st.offerGeneration;
    this.clearWatchReparentTimer(st);
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    const pc = new RTCPeerConnection({ iceServers: st.iceServers.length ? st.iceServers : DEFAULT_ICE_SERVERS });
    st.pc = pc;
    const ownsOffer = () => !st.closed && this.watches.get(streamId) === st && st.pc === pc
      && st.parentId === parentId && st.parentGeneration === parentGeneration
      && st.offerGeneration === offerGeneration;
    pc.onicecandidate = (e) => {
      if (!e.candidate || !ownsOffer()) return;
      try { st.ws.send(JSON.stringify({ t: 'ice', streamId, to: parentId, candidate: e.candidate })); } catch { /**/ }
    };
    // Обрыв upstream при живом WS: сервер об этом не узнает, картинка фризит. Просим
    // reparent — сервер даст другого родителя или реаттачит к тому же (свежий PC). failed
    // сразу; disconnected может само восстановиться (ICE), даём 5с.
    pc.onconnectionstatechange = () => {
      if (!ownsOffer()) return;
      if (pc.connectionState === 'failed') {
        this.clearWatchReparentTimer(st);
        this.requestReparent(streamId, null);
      }
      else if (pc.connectionState === 'disconnected') {
        // `disconnected` may flap repeatedly before the server assigns a replacement parent. Keep
        // one exact-PC deadline; a recovered/retired peer cancels it instead of leaving a batch of
        // stale callbacks which can all request reparent after the next radio outage.
        if (st.reparentTimer !== null) return;
        const timer = window.setTimeout(() => {
          if (st.reparentTimer !== timer) return;
          st.reparentTimer = null;
          if (ownsOffer() && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed'))
            this.requestReparent(streamId, null);
        }, 5000);
        st.reparentTimer = timer;
      } else this.clearWatchReparentTimer(st);
    };
    pc.ontrack = (e) => {
      if (!ownsOffer()) return;
      this.webReconnectAttempts.delete(streamId);
      this.applyJitter(streamId);
      // Оба kind в контейнер: аудио стрима едет тем же <video> (см. upsertTrack).
      this.upsertTrack(streamId, e.track);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      if (!ownsOffer()) return;
      const pendingIce = st.pendingIce.splice(0)
        .filter((entry) => entry.parentId === parentId && entry.parentGeneration === parentGeneration);
      for (const entry of pendingIce) {
        await pc.addIceCandidate(entry.candidate).catch(() => {});
        if (!ownsOffer()) return;
      }
      preferH264(pc);
      const answer = await pc.createAnswer();
      if (!ownsOffer()) return;
      await pc.setLocalDescription(answer);
      if (!ownsOffer()) return;
      st.ws.send(JSON.stringify({ t: 'sdp', streamId, to: parentId, type: 'answer', sdp: pc.localDescription!.sdp }));
    } catch { /**/ }
  }

  /* ---------- native watch (Tauri: Rust держит upstream+relay, webview рендерит) ---------- */
  private async nativeWatch(streamId: string, quality: string = 'source', pinned: boolean = false) {
    const st: NativeWatchState = {
      generation: nextNativeWatchGeneration(),
      pc: null, unlisten: [], closed: false, stopped: false, pendingIce: [], quality, pinned,
    };
    this.nativeWatches.set(streamId, st);
    const offCb = (sid: string, generation: number, sdp: string) => {
      if (sid === streamId && generation === st.generation && !st.closed) this.onNativeOffer(streamId, st, sdp);
    };
    const iceCb = (sid: string, generation: number, candidate: any) => {
      if (sid !== streamId || generation !== st.generation || !candidate || st.closed) return;
      if (st.pc && st.pc.remoteDescription) st.pc.addIceCandidate(candidate).catch(() => {});
      else if (st.pendingIce.length < 128) st.pendingIce.push(candidate);
    };
    const topoCb = (payload: any) => {
      if (payload && payload.streamId === streamId && payload.generation === st.generation && !st.closed) {
        this.setTopology(streamId, { you: payload.you ?? null, nodes: payload.nodes || [] });
      }
    };
    // onNativeWatchEnded может прийти СПУРИОЗНО: остановка СВОЕЙ трансляции (или свитч) сбрасывает
    // общий Rust relay-core и рвёт АКТИВНЫЙ watch чужого стрима. Поэтому тут НЕ удаляем стрим из
    // liveStreams и НЕ объявляем «конец» (иначе у зрителя пропадал чужой стрим + ложное «закончил»,
    // пока re-hello его не вернёт). Авторитет конца — discovery (stream-end) + re-hello. Рвём лишь
    // мёртвый локальный watch; если стрим по discovery ещё жив — тут же переустанавливаем (авто-recovery).
    const endCb = (sid: string, generation: number) => {
      if (sid !== streamId || generation !== st.generation || st.closed) return;
      // Стрим по discovery ещё жив → бесшовно (плитку держим, тут же переустановим watch).
      const live = !this.closed && this.liveStreams.has(streamId);
      this.unwatch(streamId, { keepVideo: live });
      if (live) this.armVideoFailsafe(streamId);
      // Бэкофф вместо фиксированных 1.5с. Если стрим на самом деле кончился, а запись в liveStreams
      // залипла (полуоткрытый discovery-сокет), круг «watch → сразу ended → watch» повторялся бы
      // бесконечно с постоянной частотой, каждый раз поднимая нативный watch-слот и сессию заново.
      // Счётчик сбрасывается, как только приезжает трек, то есть успешный просмотр историю обнуляет.
      this.scheduleNativeWatchRetry(streamId, st.quality, st.pinned);
    };
    const ownsStream = () => !st.closed && this.nativeWatches.get(streamId) === st;
    const retainListener = async (pending: Promise<() => void>): Promise<boolean> => {
      const unlisten = await pending;
      // An explicit unwatch or a newer quality generation may win while Tauri registers the
      // listener. Release the just-created native listener immediately; nativeUnwatch releases
      // the earlier listeners and fences a partially started Rust generation.
      if (!ownsStream()) {
        try { unlisten(); } catch { /**/ }
        this.nativeUnwatch(streamId, st, true);
        return false;
      }
      st.unlisten.push(unlisten);
      return true;
    };
    try {
      // Offer, ICE and ended are not optional: starting Rust without any one of them creates an
      // unanswerable or immortal watch. Topology shares the same all-or-nothing attempt so a
      // partial listener set never leaks into the next generation.
      if (!await retainListener(onNativeWatchOffer(offCb))) return;
      if (!await retainListener(onNativeWatchIce(iceCb))) return;
      if (!await retainListener(onNativeTopology(topoCb))) return;
      if (!await retainListener(onNativeWatchEnded(endCb))) return;
    } catch {
      const current = ownsStream();
      const live = current && !this.closed && this.intended.has(streamId)
        && this.liveStreams.has(streamId);
      this.nativeUnwatch(streamId, st, live);
      if (live) {
        this.armVideoFailsafe(streamId, 15_000);
        this.scheduleNativeWatchRetry(streamId, st.quality, st.pinned);
      }
      return;
    }
    if (!ownsStream()) { this.nativeUnwatch(streamId, st, true); return; }
    // Грид: Rust держит watch-слот НА КАЖДЫЙ стрим (WatchState = HashMap по stream_id). Стартуем
    // независимо — чужие слоги не трогаем, стоп идёт по этому же streamId (см. nativeUnwatch).
    // Roadmap-flow-стриминга Д6: реальный upload зрителя из Д5-probe-кэша (тот же механизм, что
    // мерил вещатель — webrtc-rs BWE незрел, Chromium GCC надёжнее). Есть свежий кэш → отдаём
    // серверу (он решит ёмкость: запас upload → ветвление 1→2). Нет кэша → фоновый замер прогреет
    // его к следующему watch/reconnect (в текущую сессию не вносим — RelayConfig берёт значение
    // при старте; активный замер не блокирует картину). 0 = не измерен → сервер даёт ёмкость 1.
    let availableOutgoing = 0;
    try {
      const { getCachedProbe, measureUpload } = await import('./probe');
      const cached = getCachedProbe();
      // Кормим сервер ТОЛЬКО достоверным замером. Правило Д6 (tree.js::dynamicCapacity)
      // трактует `0 < out < br×1.3` как ДОКАЗАННО слабый upload и режет ёмкость в 0 — зритель
      // перестаёт быть ретранслятором, к нему нельзя подключиться. Скармливать туда результат,
      // который probe сам пометил «возможно занижено», — значит доказывать слабость числом,
      // которому сам не веришь. Занижают: симметричный NAT (замер шёл через TURN-relay) и
      // DataChannel-фолбэк (goodput SCTP << BWE). Такие отдаём как 0 = «не измерен» → сервер
      // даст консервативную ёмкость 1 (та же политика, что у зрителя вообще без кэша).
      // Иначе получалась перверсия: НЕ замерил — ретранслируешь; замерил плохо — не можешь сутки
      // (TTL кэша). Ёмкость 2 требует 2×br×1.3 и всё равно недостижима на таком линке.
      const trusted = !!cached && cached.bweKbps > 0 && !cached.symmetricNat && cached.method !== 'datachannel';
      if (trusted) availableOutgoing = Math.round(cached!.bweKbps * 1000);
      else if (!cached) void measureUpload().catch(() => {}); // прогрев кэша, fire-and-forget
    } catch { /**/ }
    try {
      await startNativeWatch(streamId, st.generation, this.me, this.serverId, NATIVE_RELAY_CAPACITY, st.quality, st.pinned, availableOutgoing);
      // unwatch/quality switch may win at any await above. Rust's generation tombstone prevents the
      // late command from creating a slot; this owner fence prevents stale JS continuation work.
      if (st.closed || this.nativeWatches.get(streamId) !== st) return;
    }
    catch (error) {
      const ownsStream = this.nativeWatches.get(streamId) === st;
      if (!ownsStream) {
        // A newer quality/watch owner replaced us while auth/start was pending. Only release this
        // exact generation; shared viewer state and retry ownership belong to the replacement.
        this.nativeUnwatch(streamId, st, true);
        return;
      }
      const terminal = isTerminalSessionError(error) || isTerminalNativeTreeStartError(error);
      const live = !terminal && !this.closed && this.intended.has(streamId)
        && this.liveStreams.has(streamId);
      if (terminal) this.intended.delete(streamId);
      this.nativeUnwatch(streamId, st, live);
      if (live) {
        this.armVideoFailsafe(streamId, 15_000);
        this.scheduleNativeWatchRetry(streamId, st.quality, st.pinned);
      }
    }
  }

  private scheduleNativeWatchRetry(streamId: string, quality: string, pinned: boolean) {
    const attempt = this.reWatchAttempts.get(streamId) || 0;
    this.reWatchAttempts.set(streamId, attempt + 1);
    const delay = Math.min(30_000, 1500 * 2 ** Math.min(attempt, 5));
    this.scheduleWatchRetry(streamId, delay, () => {
      if (!this.closed && this.intended.has(streamId) && this.liveStreams.has(streamId)
        && !this.nativeWatches.has(streamId) && !this.watches.has(streamId)) {
        this.watch(streamId, quality, pinned);
      }
    });
  }
  private async onNativeOffer(streamId: string, st: NativeWatchState, sdp: string) {
    if (st.closed || this.nativeWatches.get(streamId) !== st) return;
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers.length ? this.iceServers : DEFAULT_ICE_SERVERS });
    st.pc = pc;
    const ownsOffer = () => !st.closed && this.nativeWatches.get(streamId) === st && st.pc === pc;
    pc.onicecandidate = (e) => {
      if (e.candidate && ownsOffer()) {
        nativeWatchIce(streamId, st.generation, e.candidate).catch(() => {});
      }
    };
    pc.ontrack = (e) => {
      if (!ownsOffer()) return;
      this.reWatchAttempts.delete(streamId); // картинка пошла — прошлые неудачные круги не в счёт
      this.applyJitter(streamId);
      this.upsertTrack(streamId, e.track);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      // Another offer from the same still-live Rust watch may already own st.pc. The retired
      // continuation must stop before it drains ICE queued for that replacement peer.
      if (!ownsOffer()) return;
      const pendingIce = st.pendingIce.splice(0);
      for (const candidate of pendingIce) {
        await pc.addIceCandidate(candidate).catch(() => {});
        if (!ownsOffer()) return;
      }
      preferH264(pc);
      const answer = await pc.createAnswer();
      if (!ownsOffer()) return;
      await pc.setLocalDescription(answer);
      if (!ownsOffer()) return;
      await nativeWatchAnswer(streamId, st.generation, pc.localDescription!.sdp);
    } catch { /**/ }
  }
  private nativeUnwatch(streamId: string, st: NativeWatchState, keepVideo = false) {
    const ownsStream = this.nativeWatches.get(streamId) === st;
    st.closed = true;
    // Drain ownership before invoking callbacks: a listener registration may settle late and call
    // this exact teardown again. Native unlisten functions are not required to tolerate duplicates.
    st.unlisten.splice(0).forEach((u) => { try { u(); } catch { /**/ } });
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    // Exact-generation stop is always safe and ensures a partially/late-started Rust command is
    // fenced. A stale owner must not delete diagnostics/topology/video owned by its replacement.
    if (!st.stopped) {
      st.stopped = true;
      stopNativeWatch(streamId, st.generation).catch(() => {});
    }
    if (!ownsStream) return;
    endViewerSession(streamId);
    this.nativeWatches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.lastJb.delete(streamId);
    this.topologyByStream.delete(streamId);
    this.clearDropState(streamId);
    if (!keepVideo) this.dropVideo(streamId);
    // Rust-стоп адресный (по stream_id) — гасит только слот ЭТОГО стрима, прочие плитки грида целы.
  }

  /* ---------- topology / manual peer pick ---------- */
  private setTopology(streamId: string, topo: TreeTopology) {
    this.topologyByStream.set(streamId, topo);
    // Свежий rtt апстрима → переподстраиваем приёмный буфер (дальнему зрителю больше запаса на
    // ретрансмит, близкому — минимум). Топология приходит регулярно (health/abr-тик сервера).
    this.applyJitter(streamId);
    this.topologyCbs.forEach((cb) => cb(streamId));
  }
  // Адаптивный jitter-буфер: target из rtt СВОЕГО узла в топологии (RR-замер родителя о линке до
  // нас). Применяем ко ВСЕМ приёмникам PC (audio+video — иначе рассинхрон губ). Идемпотентно:
  // зовётся на ontrack (первичное) и на каждый setTopology (rtt-обновление). Нет топологии/rtt=0 →
  // минимум 300 (прежнее плоское поведение, безопасный дефолт до первого RR).
  private applyJitter(streamId: string) {
    const pc = this.watches.get(streamId)?.pc ?? this.nativeWatches.get(streamId)?.pc ?? null;
    if (!pc) return;
    const topo = this.topologyByStream.get(streamId);
    const you = topo?.you ? topo.nodes.find((n) => n.id === topo.you) : null;
    const target = jitterTargetForRtt(you?.rtt ?? 0);
    for (const r of pc.getReceivers()) applyJitterTarget(r, target);
  }
  getTopology(streamId: string): TreeTopology | null { return this.topologyByStream.get(streamId) || null; }
  getParentId(streamId: string): string | null {
    const topo = this.topologyByStream.get(streamId);
    if (!topo || !topo.you) return null;
    return topo.nodes.find((n) => n.id === topo.you)?.parentId ?? null;
  }
  requestReparent(streamId: string, targetId: string | null, reason?: string) {
    // Натив: reason в IPC не пробрасывается (нативную отбраковку по дропам делает сервер —
    // frameDropReparent); тут только ручной/ICE-fail reparent через Rust.
    const native = this.nativeWatches.get(streamId);
    if (native) { nativeWatchReparent(streamId, native.generation, targetId).catch(() => {}); return; }
    const st = this.watches.get(streamId);
    if (st) { try { st.ws.send(JSON.stringify({ t: 'request-reparent', streamId, targetParentId: targetId, reason })); } catch { /**/ } }
  }
  onTopology(cb: (streamId: string) => void) { this.topologyCbs.add(cb); return () => { this.topologyCbs.delete(cb); }; }
  onReparentDenied(cb: (streamId: string, reason: string) => void) { this.reparentDeniedCbs.add(cb); return () => { this.reparentDeniedCbs.delete(cb); }; }

  /* ---------- track registry ---------- */
  getVideoTrack(key: string) { return this.videoTracks.get(key); }
  getStreams(): StreamInfo[] {
    const out: StreamInfo[] = [];
    this.videoTracks.forEach((_t, key) => { const info = this.streamInfoByKey.get(key); if (info) out.push(info); });
    return out;
  }
  /** Метаданные приложения вещателя (из stream-live); null для незнакомого identity. */
  getStreamMeta(identity: string): StreamMeta | null { return this.liveStreams.get(identity) || null; }
  private addVideo(key: string, handle: MediaStreamVideoHandle, identity: string, isLocal: boolean) {
    const meta = this.liveStreams.get(identity);
    this.videoTracks.set(key, handle);
    this.streamInfoByKey.set(key, { key, identity, isLocal, appName: meta?.appName, appIcon: meta?.appIcon });
    this.videoTrackCbs.forEach((cb) => cb(key, handle, identity, isLocal));
  }
  /** ontrack обоих путей (браузер/натив): кладёт трек в контейнер стрима, подменяя прежний
   *  того же kind. Handle создаётся ОДИН раз на контейнер — повторные треки (смена качества,
   *  reparent, reconnect) переключаются внутри того же srcObject, плитка не пересоздаётся. */
  private upsertTrack(streamId: string, track: MediaStreamTrack) {
    let c = this.containers.get(streamId);
    if (!c) { c = new MediaStream(); this.containers.set(streamId, c); }
    for (const old of c.getTracks()) if (old.kind === track.kind && old !== track) c.removeTrack(old);
    if (!c.getTracks().includes(track)) c.addTrack(track);
    if (track.kind === 'video') {
      this.clearVideoFailsafe(streamId);
      // Audio can arrive first on mobile WebRTC. A watch is complete only when
      // an actual video track exists; otherwise the engine would stop its
      // deadline and render a permanently audio-only black tile.
      if (!this.videoTracks.has(streamId)) this.addVideo(streamId, new MediaStreamVideoHandle(c), streamId, false);
    }
  }
  /** Взвести failsafe бесшовного переключения: трек не пришёл за ms → снос плитки + тост
   *  (иначе вечный замороженный кадр). Перевзводится на каждый вызов; снимает upsertTrack. */
  private armVideoFailsafe(streamId: string, ms = 10_000) {
    this.clearVideoFailsafe(streamId);
    this.videoFailsafe.set(streamId, window.setTimeout(() => {
      this.videoFailsafe.delete(streamId);
      if (!this.videoTracks.has(streamId)) return; // плитки уже нет — нечего сносить
      this.containers.delete(streamId);
      this.delVideo(streamId);
      this.switchFailedCbs.forEach((cb) => cb(streamId));
    }, ms));
  }
  private clearVideoFailsafe(streamId: string) {
    const t = this.videoFailsafe.get(streamId);
    if (t != null) { clearTimeout(t); this.videoFailsafe.delete(streamId); }
  }
  /** Failsafe сработал: бесшовное переключение не доехало, плитка закрыта (для тоста). */
  onSeamlessSwitchFailed(cb: (streamId: string) => void) { this.switchFailedCbs.add(cb); return () => { this.switchFailedCbs.delete(cb); }; }
  private delVideo(key: string) {
    if (!this.videoTracks.has(key)) return;
    this.videoTracks.delete(key);
    this.streamInfoByKey.delete(key);
    this.videoTrackRemovedCbs.forEach((cb) => cb(key));
  }

  /* ---------- event registration ---------- */
  onStreamStart(cb: (identity: string, silent: boolean) => void) { this.streamStartCbs.add(cb); return () => { this.streamStartCbs.delete(cb); }; }
  onStreamStop(cb: (identity: string) => void) { this.streamStopCbs.add(cb); return () => { this.streamStopCbs.delete(cb); }; }
  onVideoTrack(cb: (key: string, track: MediaStreamVideoHandle, identity: string, isLocal: boolean) => void) { this.videoTrackCbs.add(cb); return () => { this.videoTrackCbs.delete(cb); }; }
  onVideoTrackRemoved(cb: (key: string) => void) { this.videoTrackRemovedCbs.add(cb); return () => { this.videoTrackRemovedCbs.delete(cb); }; }
}

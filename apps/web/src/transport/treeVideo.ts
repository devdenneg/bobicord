import type { Room } from 'livekit-client';
import type { VideoTransport, TreeInfo, RtpStats, TreeTopology } from './videoTransport';
import { MediaStreamVideoHandle } from './videoTransport';
import type { StreamInfo } from '../engine';
import { getToken } from '../api';
import { detectSymmetricNat, stunUrlsByHost } from './natDetect';
import {
  isTauri, startNativeWatch, stopNativeWatch, nativeWatchAnswer, nativeWatchIce, nativeWatchReparent,
  onNativeWatchOffer, onNativeWatchIce, onNativeTopology, onNativeWatchEnded,
} from '../native';
import { DropWindow, shouldReparentOnDrops, DROP_COOLDOWN_MS } from './dropDetector';
import { startViewerSession, endViewerSession } from '../diag';

// Ёмкость нативного relay (passthrough) — сколько зрителей он ретранслирует. Rust держит
// upstream+фанаут; webview только рендерит. Больше браузерного (транскод дорог, натив нет).
const NATIVE_RELAY_CAPACITY = 4;

interface NativeWatchState {
  pc: RTCPeerConnection | null; // локальный показ: webview answerer к Rust-offerer
  unlisten: Array<() => void>;
  closed: boolean;
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
}


function treeWsUrl(): string {
  const override = (import.meta as any).env?.VITE_TREE_WS_URL as string | undefined;
  // В нативе location.host = tauri.localhost (bundle без reverse-proxy) — фолбэк на прод-сервер,
  // тот же, что nativeWsUrl в native.ts. Без него discovery/viewer-сокеты webview шли бы в
  // tauri.localhost → liveStreams пуст → активные стримы и LIVE-бейджи не видны в натив-приложении.
  const nativeDefault = isTauri ? 'wss://reelay.online/tree' : null;
  const base = override || nativeDefault || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
  const token = getToken() || '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

// Приёмный буфер зрителя 300мс (дефолт Chrome ~50мс). NACK-ретрансмит УЖЕ работает (webrtc-rs
// configure_nack активен на всех H.264-легах — верифицировано), но опоздавший за буфер пакет
// декодер выбрасывает и фризит до keyframe. Один NACK-цикл ≈ 50-100мс (тик Generator) + RTT
// (RU↔Москва ~10-40мс); двойной ≈ 150-200мс. 300мс покрывают двойной цикл, оставаясь терпимой
// задержкой (было 500 — многовато для чистых зрителей; слабым потери компенсирует авто-понижение
// рендишна). Цена — +~0.3с (бюджет инварианта — «видео < 2с»). Ставим на ОБА приёмника
// (audio+video): буфер только у видео развёл бы губы со звуком.
const JITTER_TARGET_MS = 300;
function bufferReceiver(r: RTCRtpReceiver | null | undefined) {
  if (!r) return;
  const rr = r as any;
  try { rr.jitterBufferTarget = JITTER_TARGET_MS; } catch { /**/ }        // стандарт (мс)
  try { rr.playoutDelayHint = JITTER_TARGET_MS / 1000; } catch { /**/ }   // legacy-имя Chrome (сек)
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
  private dropTimer: number | null = null;   // Д7: 1с-опрос дропов кадров (общий на все watch'и)
  // Д7: скользящее окно дропов + клиентский cooldown на стрим (ключ — базовый streamId).
  private dropWindows = new Map<string, DropWindow>();
  private dropCooldownUntil = new Map<string, number>();
  /** Живые стримы гильдии + метаданные приложения из stream-live (иконка/имя — Э-icon). */
  private liveStreams = new Map<string, StreamMeta>();
  private watches = new Map<string, WatchState>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private natProbe: Promise<boolean> = Promise.resolve(false);

  private videoTracks = new Map<string, MediaStreamVideoHandle>();
  private streamInfoByKey = new Map<string, StreamInfo>();
  private treeInfoByStream = new Map<string, TreeInfo>();
  /** Прошлые кумулятивные jitterBufferDelay/Count по стриму — для дельты в getRtpStats. */
  private lastJb = new Map<string, { delay: number; count: number }>();
  private topologyByStream = new Map<string, TreeTopology>();
  private topologyCbs = new Set<(streamId: string) => void>();
  private reparentDeniedCbs = new Set<(streamId: string, reason: string) => void>();
  private renditionUnavailableCbs = new Set<(streamId: string, rendition: string, reason: string) => void>();
  private nativeWatches = new Map<string, NativeWatchState>();
  // Rust держит ОДИН watch-слот, stopNativeWatch() ГЛОБАЛЕН. Трекаем, какой стрим реально в слоте —
  // чтобы стоп/teardown ЧУЖОГО стрима не рубил активный просмотр (bug: «стоп одного стрима гасит другой»).
  private currentNativeWatch: string | null = null;

  private streamStartCbs = new Set<(identity: string, silent: boolean) => void>();
  private streamStopCbs = new Set<(identity: string) => void>();
  private videoTrackCbs = new Set<(key: string, track: MediaStreamVideoHandle, identity: string, isLocal: boolean) => void>();
  private videoTrackRemovedCbs = new Set<(key: string) => void>();

  /* ---------- lifecycle ---------- */
  attach(_room: Room, ctx: { me: string; serverId: string }) {
    this.me = ctx.me;
    this.serverId = ctx.serverId;
    this.closed = false;
    this.natProbe = detectSymmetricNat();
    this.openDiscovery();
    // Самолечение: периодически шлём hello по живому сокету. onHello на сервере идемпотентен —
    // на каждый hello переотдаёт бэклог живых стримов (tree.js), а клиентский fresh-гард в
    // stream-live не даёт дублей. Так пропущенный stream-live (полуоткрытый WS / микрообрыв /
    // сон вкладки) подхватывается за ≤15с, а не «висит до F5». LiveKit-путь так самолечится
    // сам (живой опрос комнаты 3с-таймером) — уравниваем tree.
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = window.setInterval(() => {
      const ws = this.discoveryWs;
      if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ t: 'hello', serverId: this.serverId })); } catch { /**/ } }
    }, 10000);
    // Д7: единый 1с-таймер детектора дропов на все watch'и (один таймер, а не per-watch —
    // per-watch таймеры в этом файле уже были источником утечек). Отбраковка плохого родителя.
    if (this.dropTimer) clearInterval(this.dropTimer);
    this.dropTimer = window.setInterval(() => this.dropDetectorTick(), 1000);
  }
  onRoomConnected() { /* discovery socket already syncs live-stream backlog on connect */ }
  detach() {
    this.closed = true;
    if (this.helloTimer) { clearInterval(this.helloTimer); this.helloTimer = null; }
    if (this.dropTimer) { clearInterval(this.dropTimer); this.dropTimer = null; }
    this.dropWindows.clear();
    this.dropCooldownUntil.clear();
    if (this.discoveryWs) { try { this.discoveryWs.close(); } catch { /**/ } this.discoveryWs = null; }
    this.watches.forEach((_w, streamId) => this.unwatch(streamId));
    this.watches.clear();
    this.nativeWatches.forEach((st, streamId) => this.nativeUnwatch(streamId, st));
    this.nativeWatches.clear();
    this.liveStreams.clear();
    this.videoTracks.clear();
    this.streamInfoByKey.clear();
    this.topologyByStream.clear();
  }

  private openDiscovery() {
    if (this.closed) return;
    // прежний сокет закрываем, чтобы не осиротить его (утечка + двойная обработка stream-live/end)
    if (this.discoveryWs) { try { this.discoveryWs.close(); } catch { /**/ } this.discoveryWs = null; }
    let ws: WebSocket;
    // throw конструктора (битый URL/CSP/токен на миг) раньше делал голый return без ретрая —
    // onclose не будет (сокет не создан), discovery умирал НАВСЕГДА до F5. Планируем ретрай.
    try { ws = new WebSocket(treeWsUrl()); } catch { if (!this.closed) setTimeout(() => this.openDiscovery(), 3000); return; }
    this.discoveryWs = ws;
    // Сверка после (ре)коннекта: stream-end, пришедший пока сокет лежал (окно реконнекта),
    // потерян — бэклог при re-hello объявляет только ЖИВЫЕ стримы. Что не переобъявлено за 4с
    // после hello, считаем закончившимся. НО активные watch не трогаем: при медленном бэклоге
    // (сеть уже деградировала) реальный стрим мог опоздать >окна — снос вышибал бы зрителя из
    // живого стрима навсегда (unwatch → st.closed, авто-ре-watch не срабатывает). Их teardown —
    // только по явному stream-end.
    const announced = new Set<string>();
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ t: 'hello', serverId: this.serverId })); } catch { /**/ }
      setTimeout(() => {
        if (this.closed || this.discoveryWs !== ws) return;
        for (const identity of [...this.liveStreams.keys()]) {
          if (announced.has(identity)) continue;
          if (this.watches.has(identity) || this.nativeWatches.has(identity)) continue; // активный просмотр — не сносим по таймауту
          this.liveStreams.delete(identity);
          this.streamStopCbs.forEach((cb) => cb(identity));
        }
      }, 7000); // окно бэклога: 4с рвало ЖИВОЙ стрим при медленном re-hello (badge/watch чужого стрима
                // пропадал — «стоп одного рубит другие»); 7с + периодический re-hello подхватят обратно
    };
    // Сервер узнаёт, в каком сервере (гильдии) мы сидим, только из hello —
    // до него бэклог живых стримов не шлётся (см. tree.js onHello), а после join'а
    // вещателя используется, чтобы не разослать stream-live/stream-end в чужие серверы.
    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'welcome') {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) this.iceServers = msg.iceServers;
        // Перезапускаем NAT-пробу на STUN-серверах, которые прислал сервер: там наш coturn
        // и Google — два РАЗНЫХ хоста, а значит два разных адресата, как и требует детект.
        // Проба из attach() стартовала до welcome на фолбэк-списке; welcome обычно успевает
        // раньше первого watch (join шлётся уже после него), так что гонки за natProbe нет.
        const stun = stunUrlsByHost(this.iceServers);
        if (stun.length >= 2) this.natProbe = detectSymmetricNat(stun);
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
    ws.onclose = () => { if (this.discoveryWs !== ws) return; this.discoveryWs = null; if (!this.closed) setTimeout(() => this.openDiscovery(), 3000); };
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
    if (this.watches.has(streamId) || this.nativeWatches.has(streamId)) return;
    // Диагностика просмотра (diag.ts): freezeCount/потери раз в 2с, сдаётся на сервер в
    // unwatch. PC берём лениво — он появится позже (после assign-parent / offer от Rust),
    // и у нативного зрителя это другой объект (лупбек webview↔Rust).
    startViewerSession(streamId, () => this.watches.get(streamId)?.pc ?? this.nativeWatches.get(streamId)?.pc ?? null);
    // В Tauri видео/relay держит Rust (native passthrough): webview не джойнится в дерево
    // сам, а получает поток от локального Rust-пира через IPC (см. nativeWatch).
    if (isTauri) { this.nativeWatch(streamId, quality, pinned); return; }
    let ws: WebSocket;
    try { ws = new WebSocket(treeWsUrl()); } catch { return; }
    const st: WatchState = {
      ws, pc: null, parentId: null, closed: false, iceServers: this.iceServers,
      maxChildren: 0, joined: false, quality, pinned,
    };
    this.watches.set(streamId, st);

    // join шлём НЕ в onopen, а после welcome (см. sendWatchJoin): welcome несёт актуальные
    // iceServers, и только зная, есть ли TURN, можно решить ёмкость relay при симметричном NAT.
    // Fallback: если welcome не пришёл за 1.5с — джойнимся всё равно (guard не даст дубль).
    ws.onopen = () => { setTimeout(() => this.sendWatchJoin(streamId, st), 1500); };
    ws.onmessage = (ev) => this.onWatchMessage(streamId, st, ev);
    ws.onclose = () => {
      if (st.closed) return;
      this.teardownWatch(streamId, st);
      // Ре-watch: сокет оборвался (сеть/рестарт/heartbeat-terminate), но стрим ещё жив —
      // переподключаемся. Дискавери-сокет снимет liveStreams при stream-end, тогда ретрай
      // сам заглохнет (guard). Не дублируем, если watch уже пересоздан.
      if (!this.closed && this.liveStreams.has(streamId)) {
        setTimeout(() => {
          if (!this.closed && !this.watches.has(streamId) && !this.nativeWatches.has(streamId) && this.liveStreams.has(streamId)) this.watch(streamId, st.quality, st.pinned);
        }, 3000);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /**/ } };
  }

  // Отправка join после welcome (Roadmap Д0: браузер снова строго лист — maxChildren всегда 0,
  // никакого re-serve детям). symmetricNat/serverId остаются — сервер их применяет и для листьев
  // (диагностика NAT, discovery по гильдии). Д3: quality выбирает рендишн-дерево (дефолт 'source').
  private async sendWatchJoin(streamId: string, st: WatchState) {
    if (st.joined || st.closed) return;
    st.joined = true;
    const symmetricNat = await this.natProbe.catch(() => false);
    if (st.closed) return;
    st.maxChildren = 0;
    try { st.ws.send(JSON.stringify({ t: 'join', streamId, quality: st.quality, pinned: st.pinned, role: 'viewer', native: false, maxChildren: st.maxChildren, identity: this.me, symmetricNat, serverId: this.serverId })); } catch { /**/ }
  }

  unwatch(streamId: string) {
    const nst = this.nativeWatches.get(streamId);
    if (nst) { this.nativeUnwatch(streamId, nst); return; }
    const st = this.watches.get(streamId);
    if (!st) return;
    // Сессия закрывается ЗДЕСЬ, а не в teardownWatch: тот зовётся и при обрыве ws с
    // последующим ре-watch — сдавали бы огрызок на каждый реконнект.
    endViewerSession(streamId);
    st.closed = true;
    try { st.ws.send(JSON.stringify({ t: 'leave' })); } catch { /**/ }
    try { st.ws.close(); } catch { /**/ }
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.lastJb.delete(streamId);
    this.clearDropState(streamId);
    this.delVideo(streamId);
  }
  private teardownWatch(streamId: string, st: WatchState) {
    if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; }
    this.watches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.lastJb.delete(streamId);
    this.clearDropState(streamId);
    this.delVideo(streamId);
  }
  // Д7: чистим окно/cooldown детектора дропов (утечка таймеров/окон — известная категория багов тут).
  private clearDropState(streamId: string) { this.dropWindows.delete(streamId); this.dropCooldownUntil.delete(streamId); }

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
  async getRtpStats(streamId: string): Promise<RtpStats | null> {
    // Натив-путь: смотрим через локальный webview-PC (Rust passthrough-ит RTP как есть —
    // разрешение/fps настоящие, framesDropped локального хопа). Раньше читались только
    // браузерные watches — у зрителя в приложении статов не было вовсе.
    const pc = this.watches.get(streamId)?.pc ?? this.nativeWatches.get(streamId)?.pc ?? null;
    if (!pc) return null;
    let report: RTCStatsReport;
    try { report = await pc.getStats(); } catch { return null; }
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
  private async dropDetectorTick() {
    if (this.closed) return;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const now = Date.now();
    // Собираем стримы, которые сейчас смотрим (браузер + натив); ключ — базовый streamId.
    const ids = new Set<string>([...this.watches.keys(), ...this.nativeWatches.keys()]);
    for (const streamId of ids) {
      const pc = this.watches.get(streamId)?.pc ?? this.nativeWatches.get(streamId)?.pc ?? null;
      if (!pc) continue;
      let win = this.dropWindows.get(streamId);
      if (!win) { win = new DropWindow(); this.dropWindows.set(streamId, win); }
      // Скрытая вкладка легитимно дропает кадры — сбрасываем окно, чтобы не тащить фоновые дельты
      // в момент возврата в visible (роадмап: «при возврате в visible — сбросить окно»).
      if (hidden) { win.reset(); continue; }
      let report: RTCStatsReport;
      try { report = await pc.getStats(); } catch { continue; }
      let sample: { framesDropped: number; framesDecoded: number; packetsLost: number } | null = null;
      for (const stat of report.values()) {
        if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
          sample = { framesDropped: stat.framesDropped || 0, framesDecoded: stat.framesDecoded || 0, packetsLost: stat.packetsLost || 0 };
          break;
        }
      }
      if (!sample) continue;
      win.push({ t: now, ...sample });
      const cooldownUntil = this.dropCooldownUntil.get(streamId) || 0;
      if (!shouldReparentOnDrops({ deltas: win.deltas(), hidden, now, cooldownUntil })) continue;
      // Прямой ребёнок СЕРВЕРНОГО узла (vrelay/рендишн-корень): pickParent лучшего не найдёт
      // (сервер и так лучший) → reparent зациклился бы «тот же родитель». Правильная реакция —
      // понижение рендишна (Д4 perViewerAbr на сервере). Не мигрируем, ждём сервер.
      if (this.parentIsServer(streamId)) { this.dropCooldownUntil.set(streamId, now + DROP_COOLDOWN_MS); win.reset(); continue; }
      this.dropCooldownUntil.set(streamId, now + DROP_COOLDOWN_MS);
      win.reset();
      this.requestReparent(streamId, null, 'frame-drops');
    }
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
    let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case 'welcome': {
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) st.iceServers = msg.iceServers;
        this.sendWatchJoin(streamId, st); // join только теперь — знаем iceServers (есть ли TURN)
        break;
      }
      case 'assign-parent': {
        if (st.pc) { try { st.pc.close(); } catch { /**/ } st.pc = null; this.delVideo(streamId); }
        st.parentId = msg.parentId || null;
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
        if (msg.from === st.parentId && st.pc) st.pc.addIceCandidate(msg.candidate).catch(() => {});
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
    this.unwatch(streamId);
    this.watch(streamId, quality, pinned);
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
    const pc = new RTCPeerConnection({ iceServers: st.iceServers.length ? st.iceServers : DEFAULT_ICE_SERVERS });
    st.pc = pc;
    pc.onicecandidate = (e) => {
      if (!e.candidate || !st.parentId) return;
      try { st.ws.send(JSON.stringify({ t: 'ice', streamId, to: st.parentId, candidate: e.candidate })); } catch { /**/ }
    };
    // Обрыв upstream при живом WS: сервер об этом не узнает, картинка фризит. Просим
    // reparent — сервер даст другого родителя или реаттачит к тому же (свежий PC). failed
    // сразу; disconnected может само восстановиться (ICE), даём 5с.
    pc.onconnectionstatechange = () => {
      if (st.closed || st.pc !== pc) return;
      if (pc.connectionState === 'failed') this.requestReparent(streamId, null);
      else if (pc.connectionState === 'disconnected') {
        setTimeout(() => {
          if (!st.closed && st.pc === pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed'))
            this.requestReparent(streamId, null);
        }, 5000);
      }
    };
    pc.ontrack = (e) => {
      bufferReceiver(e.receiver);
      if (e.track.kind !== 'video') return;
      const handle = new MediaStreamVideoHandle(e.streams[0] || new MediaStream([e.track]));
      this.addVideo(streamId, handle, streamId, false);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      preferH264(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      st.ws.send(JSON.stringify({ t: 'sdp', streamId, to: st.parentId, type: 'answer', sdp: pc.localDescription!.sdp }));
    } catch { /**/ }
  }

  /* ---------- native watch (Tauri: Rust держит upstream+relay, webview рендерит) ---------- */
  private async nativeWatch(streamId: string, quality: string = 'source', pinned: boolean = false) {
    const st: NativeWatchState = { pc: null, unlisten: [], closed: false, quality, pinned };
    this.nativeWatches.set(streamId, st);
    const offCb = (sid: string, sdp: string) => { if (sid === streamId && !st.closed) this.onNativeOffer(streamId, st, sdp); };
    const iceCb = (sid: string, candidate: any) => { if (sid === streamId && st.pc && candidate) st.pc.addIceCandidate(candidate).catch(() => {}); };
    const topoCb = (payload: any) => { if (payload && payload.streamId === streamId) this.setTopology(streamId, { you: payload.you ?? null, nodes: payload.nodes || [] }); };
    // onNativeWatchEnded может прийти СПУРИОЗНО: остановка СВОЕЙ трансляции (или свитч) сбрасывает
    // общий Rust relay-core и рвёт АКТИВНЫЙ watch чужого стрима. Поэтому тут НЕ удаляем стрим из
    // liveStreams и НЕ объявляем «конец» (иначе у зрителя пропадал чужой стрим + ложное «закончил»,
    // пока re-hello его не вернёт). Авторитет конца — discovery (stream-end) + re-hello. Рвём лишь
    // мёртвый локальный watch; если стрим по discovery ещё жив — тут же переустанавливаем (авто-recovery).
    const endCb = (sid: string) => {
      if (sid !== streamId || st.closed) return;
      this.unwatch(streamId);
      setTimeout(() => {
        if (!this.closed && this.liveStreams.has(streamId) && !this.nativeWatches.has(streamId) && !this.watches.has(streamId)) this.watch(streamId, st.quality, st.pinned);
      }, 1500);
    };
    try {
      st.unlisten.push(await onNativeWatchOffer(offCb));
      st.unlisten.push(await onNativeWatchIce(iceCb));
      st.unlisten.push(await onNativeTopology(topoCb));
      st.unlisten.push(await onNativeWatchEnded(endCb));
    } catch { /**/ }
    if (st.closed) { st.unlisten.forEach((u) => { try { u(); } catch { /**/ } }); return; }
    // Rust держит ОДИН watch-слот (WatchState). Явно останавливаем прошлый ПЕРЕД стартом нового
    // и ждём — иначе fire-and-forget stopNativeWatch предыдущего стрима мог прийти на Rust ПОСЛЕ
    // start нового и снести уже его (гонка при переключении A→B). Первый watch: слот пуст, no-op.
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
      await stopNativeWatch().catch(() => {});
      await startNativeWatch(streamId, this.me, this.serverId, NATIVE_RELAY_CAPACITY, st.quality, st.pinned, availableOutgoing);
      this.currentNativeWatch = streamId; // этот стрим теперь в Rust-слоте
    }
    catch { this.nativeUnwatch(streamId, st); }
  }
  private async onNativeOffer(streamId: string, st: NativeWatchState, sdp: string) {
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers.length ? this.iceServers : DEFAULT_ICE_SERVERS });
    st.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) nativeWatchIce(e.candidate).catch(() => {}); };
    pc.ontrack = (e) => {
      bufferReceiver(e.receiver);
      if (e.track.kind !== 'video') return;
      const handle = new MediaStreamVideoHandle(e.streams[0] || new MediaStream([e.track]));
      this.addVideo(streamId, handle, streamId, false);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      preferH264(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await nativeWatchAnswer(pc.localDescription!.sdp);
    } catch { /**/ }
  }
  private nativeUnwatch(streamId: string, st: NativeWatchState) {
    endViewerSession(streamId);
    st.closed = true;
    st.unlisten.forEach((u) => { try { u(); } catch { /**/ } });
    if (st.pc) { try { st.pc.close(); } catch { /**/ } }
    this.nativeWatches.delete(streamId);
    this.treeInfoByStream.delete(streamId);
    this.lastJb.delete(streamId);
    this.topologyByStream.delete(streamId);
    this.clearDropState(streamId);
    this.delVideo(streamId);
    // ГЛОБАЛЬНЫЙ Rust-стоп — ТОЛЬКО если рубим стрим, реально сидящий в слоте. Иначе teardown чужого
    // (по discovery stream-end / реконсиляру / гонке) сносил бы АКТИВНЫЙ просмотр другого стрима.
    if (this.currentNativeWatch === streamId) { this.currentNativeWatch = null; stopNativeWatch().catch(() => {}); }
  }

  /* ---------- topology / manual peer pick ---------- */
  private setTopology(streamId: string, topo: TreeTopology) {
    this.topologyByStream.set(streamId, topo);
    this.topologyCbs.forEach((cb) => cb(streamId));
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
    if (this.nativeWatches.has(streamId)) { nativeWatchReparent(targetId).catch(() => {}); return; }
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

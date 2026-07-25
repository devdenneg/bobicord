// Диагностика сессии стрима: собираем данные у ВСЕХ участников и сдаём на сервер по
// окончании (POST /api/diag/session).
//
// Зачем. Жалоба «картинка подвисает» приходит от зрителей, а числа есть у вещателя.
// Разобрать её можно только имея обе стороны с общей шкалой времени: бывает, что захват
// и энкодер вещателя идеальны (accepted=30.0, ни одного дропа), а зрители всё равно
// фризят — тогда виноват участок ПОСЛЕ энкодера (потери на аплинке, TURN, сервер).
//
// Ключевая метрика зрителя — `freezeCount`/`totalFreezesDuration` из inbound-rtp: это
// буквально «сколько раз и на сколько замирала картинка», а не косвенные потери пакетов.
//
// Лимиты обязательны на каждом уровне: сессия живёт часами, а webrtc-rs на плохой сети
// сыплет тысячи строк. Здесь режем по числу семплов/строк и по итоговому размеру тела;
// сервер режет ещё раз (express.json limit + slice в роуте).

import { api, diagSessionKeepalive } from './api';
import { diagHwInfo, diagTakeLog, isTauri, onBroadcastStats, type BroadcastStats } from './native';

const CLIENT: 'native' | 'web' = isTauri ? 'native' : 'web';

/** Подставляется Vite (`define` в vite.config.ts). Для натива версию перекрывает hwinfo.rs. */
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** 2с × 2000 ≈ 66 минут сессии. Дальше вытесняем старые семплы: интересен хвост — то,
 *  что было перед жалобой и остановкой. */
const MAX_SAMPLES = 2000;
const MAX_LINES = 20_000;
/** Тело запроса. Сервер принимает 2 МБ — берём с запасом на JSON-оверхед. */
const MAX_BODY_BYTES = 1_500_000;
const SAMPLE_INTERVAL_MS = 2000;
/** Суммарный лимит тела keepalive-запросов в браузере — 64 КБ. Держимся ниже. */
const KEEPALIVE_MAX_BYTES = 50_000;
/** Неотправленное переживает перезапуск. Квота localStorage ~5 МБ на весь апп — диагу
 *  отдаём малую часть, иначе вытесним чат/конфиг. */
const PENDING_KEY = 'diagPending';
const PENDING_MAX = 3;
const PENDING_MAX_BYTES = 250_000;

type Role = 'broadcaster' | 'viewer';

/* ---------- профиль машины (один раз за процесс) ---------- */

/** Что за машина у участника. Те же цифры захвата (cb 15мс при бюджете 16.7) на
 *  16-ядерном десктопе значат «запас есть», а на 4-ядерном ноутбуке — «на грани»;
 *  без этого блока диаг заставлял угадывать. Нативная часть приходит из hwinfo.rs
 *  (CPU/GPU/RAM/билд Windows), браузерная — из того, что отдаёт сам движок.
 *  Собираем только технические характеристики: ни имён устройств, ни IP (последние и
 *  так есть в ICE-строках лога, диаг доступен только админу). */
let envCache: Record<string, unknown> | null = null;
async function collectEnv(): Promise<Record<string, unknown>> {
  if (envCache) return envCache;
  const nav = navigator as any;
  const env: Record<string, unknown> = {
    client: CLIENT,
    // hardwareConcurrency у Chromium — логические ядра; deviceMemory округлён до 0.5-8 ГБ
    // и есть не везде (в Firefox нет вовсе) — отсюда ?? null, а не 0: «не знаем» ≠ «ноль».
    cores: nav.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    screen: typeof screen !== 'undefined' ? `${screen.width}x${screen.height}@${window.devicePixelRatio ?? 1}x` : null,
    // Тип сети — почему у зрителя рвётся линк: wifi/4g против ethernet.
    netType: nav.connection?.effectiveType ?? null,
    netDownlinkMbps: nav.connection?.downlink ?? null,
    platform: nav.userAgentData?.platform ?? nav.platform ?? null,
  };
  if (CLIENT === 'native') {
    const hw = await diagHwInfo();
    if (hw) {
      env.cpu = hw.cpu;
      env.cpuCores = hw.cores;
      env.ramMb = hw.ramMb;
      env.gpus = hw.gpus;
      env.os = hw.os;
      env.appVersion = hw.appVersion;
    }
  }
  envCache = env;
  return env;
}

interface Session {
  streamId: string;
  role: Role;
  startedAt: number;
  samples: unknown[];
  /** Снять периодический сбор (интервал у зрителя, unlisten у вещателя). */
  stop: () => void;
}

/** Ключ — роль+стрим: нативный вещатель может одновременно смотреть чужой стрим. */
const sessions = new Map<string, Session>();
const key = (role: Role, streamId: string) => `${role}:${streamId}`;

function pushSample(s: Session, sample: unknown) {
  s.samples.push(sample);
  if (s.samples.length > MAX_SAMPLES) s.samples.splice(0, s.samples.length - MAX_SAMPLES);
}

/* ---------- зритель: getStats раз в 2с ---------- */

/** Снимок входящего видео. Числа кумулятивные (кроме fps/размера) — дельты считаем при
 *  разборе, здесь важнее не потерять абсолютные значения на границах окна. */
async function sampleInbound(pc: RTCPeerConnection): Promise<unknown | null> {
  let report: RTCStatsReport;
  try { report = await pc.getStats(); } catch { return null; }
  let v: any = null;
  let pair: any = null;
  const byId = new Map<string, any>();
  for (const stat of report.values() as any) {
    byId.set(stat.id, stat);
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') v = stat;
    // Номинированная пара важнее просто succeeded: по ней реально идёт медиа.
    else if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || !pair)) pair = stat;
  }
  if (!v) return null;
  // Раньше в семпл писался `localCandidateId` — сырой id вида «ICWQ0zvB», по которому
  // после выгрузки уже ничего не восстановить. Нужен ТИП пары: relay = медиа идёт через
  // coturn (лишний хоп и полоса сервера), host/srflx = напрямую.
  const lc = pair ? byId.get(pair.localCandidateId) : null;
  const rc = pair ? byId.get(pair.remoteCandidateId) : null;
  return {
    t: Date.now(),
    // Прямая мера симптома: сколько раз картинка замирала и суммарно на сколько.
    freezeCount: v.freezeCount ?? 0,
    freezeMs: Math.round((v.totalFreezesDuration ?? 0) * 1000),
    packetsLost: v.packetsLost ?? 0,
    packetsReceived: v.packetsReceived ?? 0,
    jitterMs: Math.round((v.jitter ?? 0) * 1000),
    framesDecoded: v.framesDecoded ?? 0,
    framesDropped: v.framesDropped ?? 0,
    keyFramesDecoded: v.keyFramesDecoded ?? 0,
    // Мы их шлём вверх по дереву; всплеск = мы теряем пакеты и просим IDR.
    pliSent: v.pliCount ?? 0,
    nackSent: v.nackCount ?? 0,
    fps: v.framesPerSecond ?? 0,
    w: v.frameWidth ?? 0,
    h: v.frameHeight ?? 0,
    bytesReceived: v.bytesReceived ?? 0,
    // Джиттер-буфер. Кумулятивные секунды/счётчик — фактическая задержка буфера считается
    // при разборе как дельта delay/count (lifetime-среднее врёт после смены условий сети,
    // ср. treeVideo.getRtpStats). Без этих полей эффект адаптивного target (JITTER_MIN_MS/
    // JITTER_MAX_MS в treeVideo.ts) виден только глазами в UI-оверлее: в сессии его не было,
    // то есть регрессию задержки нельзя было ни поймать, ни доказать по данным.
    jbDelayS: v.jitterBufferDelay ?? 0,
    jbCount: v.jitterBufferEmittedCount ?? 0,
    // Куда буфер ЦЕЛИТСЯ (наш jitterBufferTarget) против того, где он реально стоит.
    // Расхождение target vs факт и отвечает на «фикс поднял задержку или опустил».
    jbTargetS: v.jitterBufferTargetDelay ?? 0,
    jbMinimumS: v.jitterBufferMinimumDelay ?? 0,
    rttMs: pair ? Math.round((pair.currentRoundTripTime ?? 0) * 1000) : null,
    // Тип пары (host/srflx/prflx/relay) — relay значит, что медиа идёт через coturn.
    // Адреса НЕ пишем: тип отвечает на вопрос о маршруте, IP для этого не нужен.
    candLocal: lc?.candidateType ?? null,
    candRemote: rc?.candidateType ?? null,
    candProto: lc?.protocol ?? null,
    /** udp/tcp/tls, только когда пара relay — какой транспорт до TURN. */
    relayProto: lc?.relayProtocol ?? null,
    availableInBps: pair?.availableIncomingBitrate ?? null,
    /** Сколько пакетов реально восстановил NACK. Прямой ответ на «ретрансмит успевает
     *  или опаздывает за буфер»: если растёт вместе с freezeCount — приходит, но поздно. */
    retransmittedPackets: v.retransmittedPacketsReceived ?? 0,
    framesReceived: v.framesReceived ?? 0,
    /** Кумулятивные секунды декодирования: /framesDecoded даёт мс на кадр. Слабый ПК или
     *  софтверный декодер видно здесь, а не в потерях. */
    decodeTimeS: v.totalDecodeTime ?? 0,
    /** Полный путь пакет→кадр на приёме (jitter-буфер + декод + рендер-очередь). */
    processingDelayS: v.totalProcessingDelay ?? 0,
    /** Сборка кадра из пакетов — растёт, когда пакеты приходят вразнобой. */
    assemblyTimeS: v.totalAssemblyTime ?? 0,
    assembledFrames: v.framesAssembledFromMultiplePackets ?? 0,
    /** «ExternalDecoder»/«libvpx»/«FFmpeg» и флаг энергоэффективности — софтверный декод
     *  на слабой машине сам по себе даёт framesDropped без единой потери пакета. */
    decoder: v.decoderImplementation ?? null,
    decoderPowerEfficient: v.powerEfficientDecoder ?? null,
    /** Пауза ≠ фриз: трек остановлен (свёрнутое окно, скрытый таб), кадров не ждут. */
    pauseCount: v.pauseCount ?? 0,
    pauseMs: Math.round((v.totalPausesDuration ?? 0) * 1000),
  };
}

/** Стартует запись сессии просмотра. `getPc` вызывается на каждом тике: у браузерного
 *  зрителя это upstream к родителю, у нативного — локальный лупбек webview↔Rust (там
 *  packetsLost≈0, но freezeCount честный: он про то, что видит глаз). */
export function startViewerSession(streamId: string, getPc: () => RTCPeerConnection | null) {
  const k = key('viewer', streamId);
  if (sessions.has(k)) return;
  hookUnload();
  // Прогрев кэша: на `pagehide` ждать IPC нельзя, а env хочется и в keepalive-теле.
  void collectEnv().catch(() => null);
  const timer = window.setInterval(async () => {
    const s = sessions.get(k);
    if (!s) return;
    const pc = getPc();
    if (!pc) return;
    const sample = await sampleInbound(pc);
    if (sample) pushSample(s, sample);
  }, SAMPLE_INTERVAL_MS);
  sessions.set(k, { streamId, role: 'viewer', startedAt: Date.now(), samples: [], stop: () => window.clearInterval(timer) });
}

export function endViewerSession(streamId: string) {
  void finish('viewer', streamId);
}

/* ---------- вещатель: подписка на relay-broadcast-stats (тот же 2с-тик, что и в Rust) ---------- */

export function startBroadcasterSession(streamId: string) {
  const k = key('broadcaster', streamId);
  if (sessions.has(k)) return;
  hookUnload();
  // Прогрев кэша: на `pagehide` ждать IPC нельзя, а env хочется и в keepalive-теле.
  void collectEnv().catch(() => null);
  let unlisten: (() => void) | null = null;
  let disposed = false;
  const session: Session = {
    streamId, role: 'broadcaster', startedAt: Date.now(), samples: [],
    stop: () => { disposed = true; unlisten?.(); },
  };
  sessions.set(k, session);
  onBroadcastStats((stats: BroadcastStats) => {
    const s = sessions.get(k);
    if (!s || stats.streamId !== streamId) return;
    pushSample(s, { t: Date.now(), ...stats });
  }).then((un) => {
    // Сессия могла закончиться, пока резолвился listen() — иначе слушатель повиснет навсегда.
    if (disposed) un(); else unlisten = un;
  }).catch(() => {});
}

export function endBroadcasterSession(streamId: string) {
  void finish('broadcaster', streamId);
}

/** Останавливает вещательскую сессию, не зная streamId (стоп приходит из нескольких мест:
 *  кнопка, store.endBroadcast, событие relay-broadcast-stopped). */
export function endAnyBroadcasterSession() {
  for (const s of [...sessions.values()]) if (s.role === 'broadcaster') void finish('broadcaster', s.streamId);
}

/* ---------- отправка ---------- */

/** Режет тело до `maxBytes`, выбрасывая САМЫЕ СТАРЫЕ строки лога, а если их не хватило —
 *  и старые семплы. Конец сессии — тот момент, ради которого её и собирали. */
function fitBody(payload: any, maxBytes: number): any {
  const size = () => JSON.stringify(payload).length;
  while (size() > maxBytes && payload.lines.length) {
    payload.lines = payload.lines.slice(Math.ceil(payload.lines.length / 4));
    payload.truncated = true;
  }
  while (size() > maxBytes && payload.samples.length > 1) {
    payload.samples = payload.samples.slice(Math.ceil(payload.samples.length / 4));
    payload.truncated = true;
  }
  return payload;
}

function buildPayload(s: Session, lines: string[], env?: Record<string, unknown> | null) {
  return {
    streamId: s.streamId, role: s.role, client: CLIENT,
    startedAt: s.startedAt,
    endedAt: Date.now(),
    // Сервер пишет appVersion отдельным полем и раньше получал пустую строку — клиент его
    // просто не слал, поэтому НИ ОДНА сессия не привязывалась к версии бандла.
    appVersion: (env?.appVersion as string | undefined) ?? APP_VERSION,
    env: env ?? envCache ?? null,
    samples: s.samples.slice(),
    lines,
  };
}

/* ---------- неотправленное переживает перезапуск ---------- */

function readPending(): any[] {
  try { const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

/** Ретраить есть смысл только сетевые сбои и 5xx. 4xx (кроме 401 — токен протухнет и
 *  обновится) означает, что сервер это тело не примет никогда: очередь бы им забилась. */
function worthRetry(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^Ошибка (\d{3})$/.exec(msg);
  if (!m) return true; // таймаут / «Сеть недоступна» — сеть, ретраим
  const code = Number(m[1]);
  return code === 401 || code >= 500;
}

/** Кладёт payload в очередь ретрая. Крупные сессии ужимаются: терять весь лог из-за
 *  квоты localStorage хуже, чем сдать усечённый. */
function savePending(payload: any) {
  try {
    const queue = readPending();
    queue.push(fitBody(payload, PENDING_MAX_BYTES));
    localStorage.setItem(PENDING_KEY, JSON.stringify(queue.slice(-PENDING_MAX)));
  } catch { /* квота/приватный режим — теряем, не падаем */ }
}

/** Дослать всё, что не ушло в прошлый раз (сеть моргнула, апп закрыли). Зовётся после
 *  авторизации: без токена сервер вернёт 401 и очередь очистилась бы впустую. */
export async function flushPendingDiag() {
  const queue = readPending();
  if (!queue.length) return;
  const left: any[] = [];
  for (const payload of queue) {
    try { await api.diagSession(payload); }
    catch (e) { if (worthRetry(e)) left.push(payload); } // нет сети — оставляем до следующего раза
  }
  try {
    if (left.length) localStorage.setItem(PENDING_KEY, JSON.stringify(left));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /**/ }
}

/* ---------- выгрузка страницы: вкладку закрыли, не нажав «стоп» ---------- */

let unloadHooked = false;
function hookUnload() {
  if (unloadHooked || typeof window === 'undefined') return;
  unloadHooked = true;
  // pagehide, не beforeunload: срабатывает и на мобильных, и при переходе в bfcache.
  // Обычный fetch документ убьёт вместе с собой — нужен keepalive, а у него тело 64 КБ.
  window.addEventListener('pagehide', () => {
    for (const s of sessions.values()) {
      if (!s.samples.length) continue;
      // Лог из Rust здесь не забрать: diagTakeLog асинхронный, страница не дождётся.
      diagSessionKeepalive(fitBody(buildPayload(s, []), KEEPALIVE_MAX_BYTES));
    }
  });
}

async function finish(role: Role, streamId: string) {
  const k = key(role, streamId);
  const s = sessions.get(k);
  if (!s) return;
  sessions.delete(k);
  s.stop();

  // Rust-лог общий на процесс: если натив одновременно вещал и смотрел, обе сессии
  // претендуют на одни строки — заберёт та, что закончилась первой. Дублировать буфер
  // ради этого редкого случая не стоит.
  const lines = CLIENT === 'native' ? (await diagTakeLog()).slice(-MAX_LINES) : [];
  if (!s.samples.length && !lines.length) return; // нечего сдавать (сессия оборвалась сразу)

  // Профиль машины — на выгрузке, не на старте: собирать его при каждом старте сессии
  // незачем (значения статичны, кэш в envCache и в Rust), а на пути остановки стрима
  // лишняя IPC-задержка не мешает — сдача и так асинхронная.
  const env = await collectEnv().catch(() => null);
  const payload = fitBody(buildPayload(s, lines, env), MAX_BODY_BYTES);
  // Диагностика не должна мешать остановке стрима и не должна всплывать ошибкой юзеру.
  // Но и терять её не хочется: не ушло — ляжет в очередь до следующего запуска.
  try { await api.diagSession(payload); } catch (e) { if (worthRetry(e)) savePending(payload); }
}

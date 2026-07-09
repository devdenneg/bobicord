// Roadmap-flow-стриминга Д5: preflight WebRTC-probe замера upload вещателя.
//
// Ключевое решение (роадмап «Принятые решения» п.4): меряем ИЗ webview вещателя (Chromium
// GCC-BWE надёжнее незрелого BWE у webrtc-rs). Поднимаем RTCPeerConnection к vrelay-агенту
// (probe-приёмник, дропает трек), гоним синтетический canvas-трек 60fps с maxBitrate 15 Мбит
// и 4с читаем candidate-pair.availableOutgoingBitrate; берём медиану последних 2с (первая 1с —
// прогрев, отбрасывается). Фолбэк — throughput по DataChannel. Кэш в localStorage (TTL сутки).
//
// Сигналинг probe идёт по выделенному WS к /tree: probe-start будит приёмник, probe-offer/
// answer/ice — SDP/ICE (tree.js релеит вещатель↔сервер↔агент).

import { getToken } from '../api';
import { detectSymmetricNat } from './natDetect';
import { isTauri } from '../native';

const CACHE_KEY = 'probeUpload';
const CACHE_TTL_MS = 24 * 3600 * 1000; // сутки
const PROBE_MAX_BITRATE = 15_000_000;  // потолок трека — чтобы BWE было куда разгоняться
// Chromium GCC стартует с ~300 кбит/с и разгоняется мультипликативно. Без подсказки стартового
// битрейта за 3с он до плато не доходит — замер занижал вдвое (живьём: 5.3 против реальных
// 9.6 Мбит/с). Лечим тремя вещами: (1) x-google-start-bitrate в SDP — стартуем сразу высоко;
// (2) длиннее окно; (3) плато (p90 хвоста), а не медиана разгона — см. plateau().
const PROBE_START_KBPS = 8000;         // x-google-start-bitrate: с чего GCC начинает
const PROBE_MIN_KBPS = 1000;           // x-google-min-bitrate: не проваливаться на старте
const WARMUP_MS = 1500;                // прогрев: холодный старт probe-сессии + первый разгон
const MEASURE_MS = 7000;               // общий бюджет замера (кэш суточный — 7с терпимо)
const SAMPLE_MS = 200;                 // период чтения getStats

export interface ProbeResult {
  /** Измеренный доступный исходящий битрейт, кбит/с. */
  bweKbps: number;
  method: 'bwe' | 'datachannel';
  /** Вещатель за симметричным NAT — probe мог занизить (шёл через TURN-relay). */
  symmetricNat: boolean;
  at: number; // timestamp замера
}

export function getCachedProbe(): ProbeResult | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (raw && typeof raw.bweKbps === 'number' && Date.now() - raw.at < CACHE_TTL_MS) return raw as ProbeResult;
  } catch { /**/ }
  return null;
}
export function clearCachedProbe() { try { localStorage.removeItem(CACHE_KEY); } catch { /**/ } }
function cacheProbe(r: ProbeResult) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(r)); } catch { /**/ } }

function treeWsUrl(): string {
  const override = (import.meta as any).env?.VITE_TREE_WS_URL as string | undefined;
  const nativeDefault = isTauri ? 'wss://138-16-170-21.sslip.io/tree' : null;
  const base = override || nativeDefault || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
  const token = getToken() || '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Оценка ПЛАТО ряда BWE. Медиана тут систематически занижает: ряд имеет форму «разгон →
 *  плато», и её значение садится в середину разгона (живьём: 5.3 при реальных ~9.6 Мбит/с).
 *  p90 живёт в плато, но устойчив к единичному выбросу availableOutgoingBitrate. */
export function plateau(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

/** Вписывает x-google-start/min/max-bitrate в fmtp видео-секции offer'а. Chromium читает их и
 *  стартует GCC с указанного битрейта вместо ~300 кбит/с — иначе за окно probe разгон не
 *  успевает дойти до плато. Если подходящего fmtp нет — возвращает SDP как есть (безопасно). */
export function mungeStartBitrate(sdp: string, startKbps: number, minKbps: number, maxKbps: number): string {
  const lines = sdp.split(/\r\n|\n/);
  const mIdx = lines.findIndex((l) => l.startsWith('m=video'));
  if (mIdx < 0) return sdp;
  const pts = lines[mIdx].split(' ').slice(3); // payload types видео-секции
  let touched = false;
  for (let i = mIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('m=')) break; // следующая секция — выходим
    const m = /^a=fmtp:(\d+) (.*)$/.exec(lines[i]);
    if (!m || !pts.includes(m[1])) continue;
    if (m[2].includes('x-google-start-bitrate')) { touched = true; continue; }
    lines[i] = `a=fmtp:${m[1]} ${m[2]};x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;
    touched = true;
  }
  return touched ? lines.join('\r\n') : sdp;
}

/** Синтетический высокоэнтропийный canvas-трек 60fps: гоняем шум, чтобы энкодер не сжимал
 *  контент в ноль и BWE было что разгонять до maxBitrate. Возвращает трек + стоп-функцию. */
function makeCanvasTrack(): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(60);
  const track = stream.getVideoTracks()[0];
  let raf = 0;
  const draw = () => {
    // Много случайных прямоугольников = высокая энтропия кадра (кодек не схлопнет в 0 бит).
    for (let i = 0; i < 240; i++) {
      ctx.fillStyle = `rgb(${(Math.random() * 255) | 0},${(Math.random() * 255) | 0},${(Math.random() * 255) | 0})`;
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 80, 80);
    }
    raf = requestAnimationFrame(draw);
  };
  draw();
  return { track, stop: () => { cancelAnimationFrame(raf); try { track.stop(); } catch { /**/ } } };
}

/** Читает candidate-pair.availableOutgoingBitrate (бит/с) из активной пары; null если нет. */
async function readAvailableOutgoing(pc: RTCPeerConnection): Promise<number | null> {
  let report: RTCStatsReport;
  try { report = await pc.getStats(); } catch { return null; }
  let aob: number | null = null;
  report.forEach((s: any) => {
    if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && typeof s.availableOutgoingBitrate === 'number') {
      aob = s.availableOutgoingBitrate;
    }
  });
  return aob;
}

/**
 * Замер upload. Порядок: probe-start → offer(canvas-трек) → answer → ICE → 4с чтения BWE.
 * Медиана BWE последних 2с (кбит/с). Фолбэк на DataChannel-throughput, если BWE недоступен/ноль.
 */
export async function measureUpload(opts?: { onPhase?: (p: string) => void }): Promise<ProbeResult> {
  const onPhase = opts?.onPhase || (() => {});
  const symmetricNat = await detectSymmetricNat().catch(() => false);
  onPhase('connect');

  let ws: WebSocket;
  try { ws = new WebSocket(treeWsUrl()); } catch { throw new Error('probe: не удалось открыть сокет'); }

  const cleanups: Array<() => void> = [];
  const cleanup = () => { for (const c of cleanups) { try { c(); } catch { /**/ } } };

  try {
    const result = await new Promise<ProbeResult>((resolve, reject) => {
      let settled = false;
      const done = (r: ProbeResult) => { if (!settled) { settled = true; resolve(r); } };
      const fail = (e: any) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };

      const overallTimeout = window.setTimeout(() => fail(new Error('probe: таймаут')), MEASURE_MS + 8000);
      cleanups.push(() => clearTimeout(overallTimeout));

      let iceServers: RTCIceServer[] = DEFAULT_ICE;
      let pc: RTCPeerConnection | null = null;
      let dc: RTCDataChannel | null = null;
      const canvas = makeCanvasTrack();
      cleanups.push(canvas.stop);

      ws.onerror = () => fail(new Error('probe: ошибка сокета'));
      ws.onclose = () => { if (!settled) fail(new Error('probe: сокет закрыт')); };

      const send = (o: any) => { try { ws.send(JSON.stringify(o)); } catch { /**/ } };

      const startPc = async () => {
        onPhase('measure');
        pc = new RTCPeerConnection({ iceServers: iceServers.length ? iceServers : DEFAULT_ICE });
        cleanups.push(() => { try { pc?.close(); } catch { /**/ } });
        pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'probe-ice', candidate: e.candidate }); };
        // Фолбэк-канал throughput: считаем реально ушедшие байты (bufferedAmount дренаж).
        dc = pc.createDataChannel('probe', { ordered: false, maxRetransmits: 0 });
        // sendonly видео с потолком maxBitrate — чтобы BWE разгонялось.
        pc.addTransceiver(canvas.track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: PROBE_MAX_BITRATE }] });
        try {
          const offer = await pc.createOffer();
          // Стартовый битрейт GCC: без него разгон с ~300 кбит/с не доходит до плато за окно.
          offer.sdp = mungeStartBitrate(offer.sdp!, PROBE_START_KBPS, PROBE_MIN_KBPS, Math.round(PROBE_MAX_BITRATE / 1000));
          await pc.setLocalDescription(offer);
          send({ t: 'probe-offer', sdp: pc.localDescription!.sdp });
        } catch (e) { fail(e); return; }
        runMeasurement();
      };

      const runMeasurement = () => {
        const t0 = Date.now();
        const samples: Array<{ t: number; v: number }> = [];
        const iv = window.setInterval(async () => {
          if (!pc || settled) return;
          const aob = await readAvailableOutgoing(pc);
          if (aob != null && aob > 0) samples.push({ t: Date.now() - t0, v: aob });
          if (Date.now() - t0 >= MEASURE_MS) {
            clearInterval(iv);
            // Плато (p90) хвоста после прогрева. Медиана давала середину разгона — занижение ~×2.
            const tail = samples.filter((s) => s.t >= WARMUP_MS).map((s) => s.v);
            const bwe = plateau(tail.length ? tail : samples.map((s) => s.v));
            if (bwe > 0) {
              done({ bweKbps: Math.round(bwe / 1000), method: 'bwe', symmetricNat, at: Date.now() });
            } else {
              // BWE не поднялось (нет transport-cc / трек не разогнался) — фолбэк на DataChannel.
              measureDataChannel();
            }
          }
        }, SAMPLE_MS);
        cleanups.push(() => clearInterval(iv));
      };

      // Фолбэк: пушим в DataChannel, держа bufferedAmount около cap, и меряем goodput.
      const measureDataChannel = () => {
        if (!dc || dc.readyState !== 'open') { done({ bweKbps: 0, method: 'datachannel', symmetricNat, at: Date.now() }); return; }
        const CHUNK = new Uint8Array(16 * 1024);
        const CAP = 1 << 20; // 1 МБ буфер
        let sent = 0;
        const t0 = Date.now();
        const pump = window.setInterval(() => {
          if (!dc || dc.readyState !== 'open') { clearInterval(pump); return; }
          while (dc.bufferedAmount < CAP) { try { dc.send(CHUNK); sent += CHUNK.byteLength; } catch { break; } }
          if (Date.now() - t0 >= 2500) {
            clearInterval(pump);
            const secs = (Date.now() - t0) / 1000;
            const kbps = Math.round((sent * 8) / secs / 1000);
            done({ bweKbps: kbps, method: 'datachannel', symmetricNat, at: Date.now() });
          }
        }, 50);
        cleanups.push(() => clearInterval(pump));
      };

      ws.onmessage = (ev) => {
        let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.t) {
          case 'welcome':
            if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
            send({ t: 'probe-start' });
            startPc();
            break;
          case 'probe-answer':
            if (pc && msg.sdp) pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(fail);
            break;
          case 'probe-ice':
            if (pc && msg.candidate) pc.addIceCandidate(msg.candidate).catch(() => {});
            break;
          case 'probe-unavailable':
            fail(new Error('probe: сервер недоступен для замера (нет агента)'));
            break;
        }
      };
    });

    cacheProbe(result);
    return result;
  } finally {
    cleanup();
    try { ws.close(); } catch { /**/ }
  }
}

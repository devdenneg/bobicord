// Юнит-тест чистых функций probe.ts (plateau / mungeStartBitrate).
// Запуск: node apps/web/src/transport/probe.test.mjs
// TS не компилируем — дублируем реализацию 1:1 (как dropDetector.test.mjs).
// При правке probe.ts синхронизировать обе копии.

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`PASS: ${name}`); } else { fail++; console.error(`FAIL: ${name}`); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${a}, want ${b})`);

const PROBE_MAX_KBPS = 15000;

function plateau(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

function mungeStartBitrate(sdp, startKbps, minKbps, maxKbps) {
  const lines = sdp.split(/\r\n|\n/);
  const mIdx = lines.findIndex((l) => l.startsWith('m=video'));
  if (mIdx < 0) return sdp;
  const pts = lines[mIdx].split(' ').slice(3);
  let touched = false;
  for (let i = mIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('m=')) break;
    const m = /^a=fmtp:(\d+) (.*)$/.exec(lines[i]);
    if (!m || !pts.includes(m[1])) continue;
    if (m[2].includes('x-google-start-bitrate')) { touched = true; continue; }
    lines[i] = `a=fmtp:${m[1]} ${m[2]};x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;
    touched = true;
  }
  return touched ? lines.join('\r\n') : sdp;
}

/* ---------- plateau: главный баг — медиана садилась в середину разгона ---------- */

// Форма ряда как в проде: окно 3с при SAMPLE_MS=200 -> ~15 точек, GCC почти всё окно РАЗГОНЯЕТСЯ
// и выходит на плато ~9600 кбит/с лишь к концу. Именно поэтому медиана давала ~5.3 Мбит/с
// при реальных ~9.6 (замер 2026-07-09: машина -> прод VPS = 9.6 Мбит/с).
const ramp = [900, 1500, 2200, 3100, 4000, 4800, 5400, 5900, 6500, 7200, 8000, 8800, 9300, 9600, 9600];
const medianOf = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const med = medianOf(ramp);
ok(med < 6500, `медиана разгона занижает — старый баг (median=${med}, плато 9600)`);
ok(med / 9600 < 0.7, 'занижение медианой сопоставимо с наблюдённым в проде (5.3/9.6 ≈ 0.55)');
ok(plateau(ramp) >= 9300, 'plateau попадает в плато, а не в разгон');
eq(plateau(ramp), 9600, 'plateau(ramp) == плато');

// Устойчивость к единичному выбросу вверх (availableOutgoingBitrate иногда «стреляет»).
const spike = [...ramp, 40000];
ok(plateau(spike) <= 9600, 'p90 гасит одиночный выброс (не берём max)');

// Плоский ряд.
eq(plateau([5000, 5000, 5000]), 5000, 'плоский ряд');
// Пустой.
eq(plateau([]), 0, 'пустой ряд -> 0');
// Один элемент.
eq(plateau([1234]), 1234, 'один элемент');
// Индекс не выходит за границы на коротких рядах.
eq(plateau([1, 2]), 2, 'два элемента -> верхний');

/* ---------- mungeStartBitrate ---------- */

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 max-fs=12288',
  'a=rtpmap:97 H264/90000',
  'a=fmtp:97 packetization-mode=1',
].join('\r\n');

const out = mungeStartBitrate(SDP, 8000, 1000, PROBE_MAX_KBPS);
ok(out.includes('a=fmtp:96 max-fs=12288;x-google-start-bitrate=8000;x-google-min-bitrate=1000;x-google-max-bitrate=15000'), 'munge: видео fmtp 96 дополнен');
ok(out.includes('a=fmtp:97 packetization-mode=1;x-google-start-bitrate=8000'), 'munge: видео fmtp 97 дополнен');
ok(out.includes('a=fmtp:111 minptime=10;useinbandfec=1') && !out.includes('a=fmtp:111 minptime=10;useinbandfec=1;x-google'), 'munge: АУДИО fmtp не тронут');

// Идемпотентность: повторный munge не дублирует параметры.
const twice = mungeStartBitrate(out, 8000, 1000, PROBE_MAX_KBPS);
eq((twice.match(/x-google-start-bitrate/g) || []).length, 2, 'munge идемпотентен (2 видео-fmtp, без дублей)');

// Нет видео-секции -> SDP как есть.
const audioOnly = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fmtp:111 minptime=10';
eq(mungeStartBitrate(audioOnly, 8000, 1000, PROBE_MAX_KBPS), audioOnly, 'нет m=video -> SDP не изменён');

// Видео-секция без fmtp -> SDP как есть (не ломаем).
const noFmtp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000';
eq(mungeStartBitrate(noFmtp, 8000, 1000, PROBE_MAX_KBPS), noFmtp, 'нет fmtp -> SDP не изменён');

// fmtp чужой payload (не из m=video) не трогается.
const alien = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=fmtp:96 x=1', 'm=application 9 DTLS/SCTP 5000', 'a=fmtp:5000 y=2'].join('\r\n');
const am = mungeStartBitrate(alien, 8000, 1000, PROBE_MAX_KBPS);
ok(am.includes('a=fmtp:5000 y=2') && !am.includes('a=fmtp:5000 y=2;x-google'), 'munge останавливается на следующей m=-секции');

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Разбор диагностических сессий стрима (см. apps/web/src/diag.ts, POST /api/diag/session).
//
// Зачем отдельный инструмент. Сессия вещателя — это до 20k строк лога (2 МБ), сессия
// зрителя — сотни семплов getStats. Читать это глазами (или скармливать модели) нельзя.
// Но и не нужно: вопрос всегда один — «в момент, когда у зрителя замерла картинка, что
// происходило у вещателя?». Сводим стороны на общую шкалу epoch-ms и печатаем только
// те окна, где что-то случилось.
//
// Авторизация: RELAY_TOKEN (session-JWT), либо RELAY_USER + RELAY_PASS (сделаем /login).
// Эндпоинты списка/выгрузки — только для админа.
//
//   node scripts/diag.mjs list                    список сессий на сервере
//   node scripts/diag.mjs pull --stream=denis     скачать сессии стрима в .diag/
//   node scripts/diag.mjs pull --all --limit=20
//   node scripts/diag.mjs report .diag/*.json     сводка (принимает и один файл)
//
// Переменные: RELAY_API (по умолчанию https://reelay.online), RELAY_TOKEN | RELAY_USER/RELAY_PASS.

import fs from 'node:fs';
import path from 'node:path';

const API = process.env.RELAY_API || 'https://reelay.online';
const OUT_DIR = '.diag';
/** Тик статистики и у вещателя (Rust stats_tick), и у зрителя (diag.ts) — 2с. */
const BUCKET_MS = 2000;

/* ---------------- HTTP ---------------- */

let cachedToken = null;
async function token() {
  if (cachedToken) return cachedToken;
  if (process.env.RELAY_TOKEN) return (cachedToken = process.env.RELAY_TOKEN);
  const username = process.env.RELAY_USER;
  const password = process.env.RELAY_PASS;
  if (!username || !password) die('Нужен RELAY_TOKEN, либо RELAY_USER + RELAY_PASS.');
  const r = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) die(`login: ${r.status} ${await r.text()}`);
  return (cachedToken = (await r.json()).token);
}

async function apiGet(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + (await token()) } });
  if (r.status === 403) die('403: нужен админский аккаунт (в логах ICE-кандидаты = IP участников).');
  if (!r.ok) die(`GET ${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

const die = (m) => { console.error(m); process.exit(1); };

/* ---------------- команды ---------------- */

async function cmdList() {
  const list = await apiGet('/api/diag/sessions');
  if (!list.length) return console.log('сессий нет');
  for (const s of list) {
    console.log(`${new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 19)}  ${(s.size / 1024).toFixed(0).padStart(6)} КБ  ${s.name}`);
  }
}

async function cmdPull(args) {
  const stream = argVal(args, '--stream');
  const limit = Number(argVal(args, '--limit') || 50);
  const all = args.includes('--all');
  if (!stream && !all) die('Укажи --stream=<streamId> или --all.');

  let list = await apiGet('/api/diag/sessions');
  // Имя файла: <endedAt>-<streamId>-<role>-<username>.json (см. index.js).
  if (stream) list = list.filter((s) => s.name.split('-').slice(1, -2).join('-') === stream);
  list = list.slice(0, limit);
  if (!list.length) return console.log('нечего качать');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const s of list) {
    const dest = path.join(OUT_DIR, s.name);
    if (fs.existsSync(dest)) { console.log(`= ${s.name}`); continue; }
    const body = await apiGet('/api/diag/sessions/' + encodeURIComponent(s.name));
    fs.writeFileSync(dest, JSON.stringify(body));
    console.log(`+ ${s.name}`);
  }
  console.log(`\n${OUT_DIR}/ готов. Дальше: node scripts/diag.mjs report ${OUT_DIR}/*.json`);
}

/* ---------------- разбор лога вещателя ---------------- */

// Строки из diag.rs: "<epoch_ms> [LEVEL][target] сообщение"
const LINE_RE = /^(\d{10,})\s+\[(\w+)\]\[([^\]]+)\]\s+(.*)$/;

// timing: cb 3.7/7.3 мс (avg/max) = readback 0.8 + convert 2.9 | encode 1.0/1.7 | write 0.5 | drops +0 (всего 0)
const TIMING_RE = /timing: cb ([\d.]+)\/([\d.]+).*?readback ([\d.]+) \+ convert ([\d.]+).*?encode ([\d.]+)\/([\d.]+).*?write ([\d.]+).*?drops \+(\d+)/;
// net: детей 1 | <id> loss=0.0% rtt=12мс | битрейт 5.8/6.0 Мбит (факт/цель) | PLI +0 | IDR +0 (форс +0)
// «(форс +N)» опционально (старые бинари без него) — не якорим, чтобы парсились оба формата.
const NET_RE = /net: детей (\d+) \| (.*?) \| битрейт ([\d.]+)\/([\d.]+).*?PLI \+(\d+) \| IDR \+(\d+)(?: \(форс \+(\d+)\))?/;
const LINK_RE = /(\S+) loss=([\d.]+)% rtt=(\d+)/g;

function parseBroadcaster(session) {
  const ticks = new Map(); // bucket -> данные
  const events = [];       // WARN/ERROR и прочие «не периодические» строки

  for (const raw of session.lines || []) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const [, tsStr, level, target, msg] = m;
    const ts = Number(tsStr);
    const b = bucket(ts);

    const tm = TIMING_RE.exec(msg);
    if (tm) {
      upsert(ticks, b).timing = {
        cbAvg: +tm[1], cbMax: +tm[2], readback: +tm[3], convert: +tm[4],
        encAvg: +tm[5], encMax: +tm[6], write: +tm[7], drops: +tm[8],
      };
      continue;
    }
    const nm = NET_RE.exec(msg);
    if (nm) {
      const links = [...nm[2].matchAll(LINK_RE)].map((l) => ({ id: l[1], loss: +l[2], rtt: +l[3] }));
      upsert(ticks, b).net = { children: +nm[1], links, actualMbit: +nm[3], targetMbit: +nm[4], pli: +nm[5], idr: +nm[6], idrForced: nm[7] != null ? +nm[7] : null };
      continue;
    }
    // Всё остальное на INFO — это capture/encoder fps и служебные строки; в сводке
    // они шум. Держим WARN/ERROR (ICE, TURN, отказ энкодера) и наши `net:`-события.
    if (level === 'WARN' || level === 'ERROR' || /ladder|переиниц|снизил цель|stream|drop frame/i.test(msg)) {
      events.push({ ts, level, target, msg });
    }
  }
  return { ticks, events };
}

const bucket = (ts) => Math.floor(ts / BUCKET_MS) * BUCKET_MS;
function upsert(map, k) {
  if (!map.has(k)) map.set(k, {});
  return map.get(k);
}

/* ---------------- разбор семплов зрителя ---------------- */

/** Кумулятивные счётчики -> дельты по окнам. Абсолютные значения на клиенте не
 *  обнуляются (getStats их не сбрасывает), поэтому разность считаем здесь. */
function parseViewer(session) {
  const ticks = new Map();
  let prev = null;
  const first = (session.samples || [])[0] || null;
  for (const s of session.samples || []) {
    const b = bucket(s.t);
    if (prev) {
      // Джиттер-буфер: средняя задержка ЗА ОКНО = дельта секунд / дельта кадров. Lifetime-
      // среднее (delay/count от начала сессии) сглаживает ровно то, что интересно — как
      // буфер повёл себя в окне с фризами. Старые сессии полей не имеют -> null, печатаем
      // пусто вместо нулей (ноль читался бы как «буфера нет»).
      const dJbCount = (s.jbCount ?? 0) - (prev.jbCount ?? 0);
      const dJbDelay = (s.jbDelayS ?? 0) - (prev.jbDelayS ?? 0);
      const jbMs = s.jbCount != null && dJbCount > 0 ? (dJbDelay / dJbCount) * 1000 : null;
      const dTgtCount = (s.jbCount ?? 0) - (prev.jbCount ?? 0);
      const dTgt = (s.jbTargetS ?? 0) - (prev.jbTargetS ?? 0);
      const jbTargetMs = s.jbTargetS != null && dTgtCount > 0 ? (dTgt / dTgtCount) * 1000 : null;
      upsert(ticks, b).v = {
        freezes: Math.max(0, (s.freezeCount ?? 0) - (prev.freezeCount ?? 0)),
        freezeMs: Math.max(0, (s.freezeMs ?? 0) - (prev.freezeMs ?? 0)),
        lost: Math.max(0, (s.packetsLost ?? 0) - (prev.packetsLost ?? 0)),
        pliSent: Math.max(0, (s.pliSent ?? 0) - (prev.pliSent ?? 0)),
        keyframes: Math.max(0, (s.keyFramesDecoded ?? 0) - (prev.keyFramesDecoded ?? 0)),
        fps: s.fps ?? 0,
        rttMs: s.rttMs,
        jitterMs: s.jitterMs ?? 0,
        jbMs,
        jbTargetMs,
        // Восстановленное NACK'ом за окно. Растёт вместе с фризами = ретрансмит приходит,
        // но опаздывает за буфер (тогда лечит JITTER_TARGET, а не борьба с потерями).
        retrans: Math.max(0, (s.retransmittedPackets ?? 0) - (prev.retransmittedPackets ?? 0)),
        // мс на кадр декодирования: софтверный декодер на слабой машине даёт дропы кадров
        // без единой потери пакета — это не сеть и не вещатель.
        decodeMs: dJbCount > 0 && s.decodeTimeS != null
          ? ((s.decodeTimeS - (prev.decodeTimeS ?? 0)) / Math.max(1, (s.framesDecoded ?? 0) - (prev.framesDecoded ?? 0))) * 1000
          : null,
        pauses: Math.max(0, (s.pauseCount ?? 0) - (prev.pauseCount ?? 0)),
      };
    }
    prev = s;
  }
  return { ticks, first, last: prev, meta: lastMeta(session) };
}

/** Статичные за сессию поля последнего семпла: декодер, тип ICE-пары. Меняются редко,
 *  в таблицу по окнам их тащить незачем — печатаем строкой в итоге по зрителю. */
function lastMeta(session) {
  const s = (session.samples || []).at(-1);
  if (!s) return null;
  const route = [s.candLocal, s.candRemote].filter(Boolean).join('/');
  return {
    decoder: s.decoder ?? null,
    powerEfficient: s.decoderPowerEfficient ?? null,
    route: route || null,
    proto: s.relayProto || s.candProto || null,
  };
}

/* ---------------- сводка ---------------- */

function cmdReport(files) {
  if (!files.length) die('Укажи файлы: node scripts/diag.mjs report .diag/*.json');
  const sessions = files.map((f) => ({ file: path.basename(f), ...JSON.parse(fs.readFileSync(f, 'utf8')) }));

  const broadcasters = sessions.filter((s) => s.role === 'broadcaster');
  const viewers = sessions.filter((s) => s.role === 'viewer');
  const streams = [...new Set(sessions.map((s) => s.streamId))];
  console.log(`Стримы: ${streams.join(', ')}  |  вещателей: ${broadcasters.length}, зрителей: ${viewers.length}\n`);

  // Машины участников. Одни и те же тайминги на 16-ядерном десктопе и 4-ядерном ноутбуке
  // читаются по-разному, а имя GPU объясняет выбор MFT у вещателя (encoder.rs).
  const envLines = [];
  for (const s of sessions) {
    if (!s.env) continue;
    const e = s.env;
    const hw = [
      e.cpu && `${e.cpu}${e.cpuCores ? ` (${e.cpuCores} потоков)` : ''}`,
      !e.cpu && e.cores && `${e.cores} потоков`,
      e.ramMb && `${(e.ramMb / 1024).toFixed(0)} ГБ RAM`,
      e.deviceMemoryGb && !e.ramMb && `~${e.deviceMemoryGb} ГБ RAM`,
      Array.isArray(e.gpus) && e.gpus.length && e.gpus.join(' + '),
      e.os || e.platform,
      e.screen,
      e.netType && `сеть ${e.netType}${e.netDownlinkMbps ? ` ~${e.netDownlinkMbps} Мбит` : ''}`,
      e.appVersion && `v${e.appVersion}`,
    ].filter(Boolean).join(', ');
    const line = `  ${s.username || s.file} (${s.role}, ${s.client}): ${hw}`;
    if (!envLines.includes(line)) envLines.push(line);
  }
  if (envLines.length) console.log('Машины:\n' + envLines.join('\n') + '\n');

  const bc = broadcasters[0] ? parseBroadcaster(broadcasters[0]) : { ticks: new Map(), events: [] };
  const vw = viewers.map((v) => ({ name: v.username || v.file, client: v.client, ...parseViewer(v) }));

  // Общая шкала: объединение всех окон обеих сторон.
  const allBuckets = [...new Set([...bc.ticks.keys(), ...vw.flatMap((v) => [...v.ticks.keys()])])].sort((a, b) => a - b);
  if (!allBuckets.length) return console.log('нет данных');
  const t0 = allBuckets[0];

  // Печатаем только «интересные» окна: где кто-то фризил, терял пакеты, слал PLI,
  // ронял кадры — плюс одно окно контекста вокруг. Иначе часовая сессия = 1800 строк.
  const interesting = new Set();
  for (const b of allBuckets) {
    const t = bc.ticks.get(b) || {};
    const bad =
      (t.timing?.drops ?? 0) > 0 ||
      (t.net?.pli ?? 0) > 0 ||
      (t.net?.links ?? []).some((l) => l.loss > 0) ||
      vw.some((v) => { const s = v.ticks.get(b)?.v; return s && (s.freezes > 0 || s.lost > 0); });
    if (bad) { interesting.add(b - BUCKET_MS); interesting.add(b); interesting.add(b + BUCKET_MS); }
  }

  const rows = allBuckets.filter((b) => interesting.has(b));
  if (!rows.length) {
    console.log('Ни одного окна с фризами/потерями/дропами. Стрим шёл чисто.\n');
  } else {
    console.log(`Окна с проблемами (${rows.length} из ${allBuckets.length}). t — секунды от начала.\n`);
    const head = ['t', 'drops', 'PLI', 'IDR', 'loss%', 'rtt', 'Мбит'];
    for (const v of vw) head.push(`${short(v.name)}:фриз`, `${short(v.name)}:мс`, `${short(v.name)}:lost`, `${short(v.name)}:буф`);
    console.log(head.join('\t'));
    for (const b of rows) {
      const t = bc.ticks.get(b) || {};
      const worst = (t.net?.links ?? []).reduce((a, l) => (l.loss > (a?.loss ?? -1) ? l : a), null);
      const row = [
        ((b - t0) / 1000).toFixed(0),
        t.timing?.drops ?? '',
        t.net?.pli ?? '',
        t.net?.idr ?? '',
        worst ? worst.loss.toFixed(1) : '',
        worst ? worst.rtt : '',
        t.net ? t.net.actualMbit.toFixed(1) : '',
      ];
      for (const v of vw) {
        const s = v.ticks.get(b)?.v;
        row.push(s?.freezes ?? '', s?.freezeMs ?? '', s?.lost ?? '', s?.jbMs != null ? s.jbMs.toFixed(0) : '');
      }
      console.log(row.join('\t'));
    }
    console.log('');
  }

  // Итоги по зрителям: фризы — это и есть жалоба. Потери считаем В ДОЛЯХ: абсолютное
  // число пакетов ничего не говорит без знания, сколько их пришло.
  let worstViewerLoss = 0;
  for (const v of vw) {
    let freezes = 0, freezeMs = 0, lost = 0, pli = 0;
    const jbs = [], jbTargets = [];
    for (const [, x] of v.ticks) {
      freezes += x.v.freezes; freezeMs += x.v.freezeMs; lost += x.v.lost; pli += x.v.pliSent;
      if (x.v.jbMs != null) jbs.push(x.v.jbMs);
      if (x.v.jbTargetMs != null) jbTargets.push(x.v.jbTargetMs);
    }
    const a = v.first, z = v.last;
    const recv = a && z ? (z.packetsReceived ?? 0) - (a.packetsReceived ?? 0) : 0;
    const lossPct = lost + recv > 0 ? (lost * 100) / (lost + recv) : 0;
    const dur = a && z ? (z.t - a.t) / 1000 : 0;
    const fps = a && z && dur > 0 ? ((z.framesDecoded ?? 0) - (a.framesDecoded ?? 0)) / dur : 0;
    worstViewerLoss = Math.max(worstViewerLoss, lossPct);
    console.log(
      `зритель ${v.name} (${v.client}): фризов ${freezes} / ${(freezeMs / 1000).toFixed(0)}с, потери ${lossPct.toFixed(1)}% (${lost} пакетов), декодировано ${fps.toFixed(1)} fps, PLI ${pli}`,
    );
    // Буфер: медиана — где он стоял обычно, p95 — насколько уезжал в плохих окнах.
    // Уехавший ВЫШЕ цели факт = adaptive-эвристика Chrome перебила наш target (то есть
    // задержку создаёт восстановление после потерь, а не сам target).
    if (jbs.length) {
      const med = pct(jbs, 0.5), p95 = pct(jbs, 0.95);
      const tgt = jbTargets.length ? `, цель ${pct(jbTargets, 0.5).toFixed(0)}мс` : '';
      console.log(`  буфер: медиана ${med.toFixed(0)}мс, p95 ${p95.toFixed(0)}мс${tgt}`);
    }
    // Восстановление и декод: разделяют «потери» (сеть), «поздний ретрансмит» (буфер) и
    // «не тянет декодер» (машина зрителя). Раньше в диаге не было ни одного из трёх.
    let retrans = 0, pauses = 0;
    const decodeMs = [];
    for (const [, x] of v.ticks) {
      retrans += x.v.retrans ?? 0;
      pauses += x.v.pauses ?? 0;
      if (x.v.decodeMs != null && Number.isFinite(x.v.decodeMs)) decodeMs.push(x.v.decodeMs);
    }
    const parts = [];
    if (retrans) parts.push(`восстановлено NACK ${retrans} пакетов`);
    if (decodeMs.length) parts.push(`декод ${pct(decodeMs, 0.5).toFixed(1)}/${pct(decodeMs, 0.95).toFixed(1)}мс (мед/p95)`);
    if (pauses) parts.push(`пауз ${pauses}`);
    if (v.meta?.decoder) parts.push(`${v.meta.decoder}${v.meta.powerEfficient === false ? ' (не энергоэффективный)' : ''}`);
    if (v.meta?.route) parts.push(`ICE ${v.meta.route}${v.meta.proto ? `/${v.meta.proto}` : ''}`);
    if (parts.length) console.log(`  ${parts.join(', ')}`);
  }

  // Сводка вещателя. Времена сравниваем с БЮДЖЕТОМ КАДРА (1000/fps), а не с константой.
  let drops = 0, pli = 0, idr = 0, idrForced = 0, idrForcedKnown = false, cbMax = 0, maxLoss = 0, dropWindows = 0, targetFps = 30;
  const cbAvgs = [];
  for (const [, x] of bc.ticks) {
    drops += x.timing?.drops ?? 0;
    if ((x.timing?.drops ?? 0) > 0) dropWindows++;
    pli += x.net?.pli ?? 0;
    idr += x.net?.idr ?? 0;
    if (x.net?.idrForced != null) { idrForced += x.net.idrForced; idrForcedKnown = true; }
    cbMax = Math.max(cbMax, x.timing?.cbMax ?? 0);
    if (x.timing?.cbAvg != null) cbAvgs.push(x.timing.cbAvg);
    for (const l of x.net?.links ?? []) maxLoss = Math.max(maxLoss, l.loss);
  }
  if (broadcasters[0]?.samples?.length) targetFps = broadcasters[0].samples[0].targetFps || 30;
  const windows = bc.ticks.size || 1;
  const budgetMs = 1000 / targetFps;
  // p95 окон, а не единственный выброс за сессию. cbMax — максимум ПО ОКНАМ, то есть один
  // залипший кадр (GC, свёрнутое окно, реинит MFT) задирает его на порядок при полностью
  // здоровом захвате: у leva 07-22 avg 3.4мс / p95 4.5мс при cbMax 118мс — прежний гейт
  // `cbMax > budgetMs` объявлял «вещатель не успевал» на каждой такой сессии.
  const cbP95 = cbAvgs.length ? pct(cbAvgs, 0.95) : 0;
  const idrRate = (idr / windows) / (BUCKET_MS / 1000); // IDR в секунду
  if (bc.ticks.size) {
    console.log(
      `\nвещатель: дропов захвата ${drops} (в ${dropWindows} окнах из ${windows}), cb p95 ${cbP95.toFixed(1)}мс / max ${cbMax.toFixed(1)}мс при бюджете ${budgetMs.toFixed(1)}мс,` +
      ` PLI получено ${pli}, IDR отдано ${idr} (${idrRate.toFixed(2)}/с), худший loss линка ${maxLoss.toFixed(1)}%`,
    );
  }
  // CPU системы и размер бёрста — из семплов вещателя (BroadcastStats, тот же 2с-тик).
  // Загрузка машины ЦЕЛИКОМ отвечает на «захват не успевал потому, что игра съела CPU»;
  // размер IDR — на «фризы без потерь»: 300 КБ это ~170 пакетов залпом.
  const bs = broadcasters[0]?.samples || [];
  if (bs.length) {
    const cpu = bs.map((s) => s.cpuSystemPercent).filter((n) => Number.isFinite(n));
    const keyKb = bs.map((s) => (s.keyBytesMax || 0) / 1024).filter((n) => n > 0);
    const frameKb = bs.map((s) => (s.frameBytesMax || 0) / 1024).filter((n) => n > 0);
    const bits = [];
    if (cpu.length) bits.push(`CPU системы ${pct(cpu, 0.5).toFixed(0)}/${pct(cpu, 0.95).toFixed(0)}% (мед/p95)`);
    if (keyKb.length) bits.push(`IDR до ${Math.max(...keyKb).toFixed(0)} КБ (медиана окон ${pct(keyKb, 0.5).toFixed(0)})`);
    if (frameKb.length) bits.push(`кадр до ${Math.max(...frameKb).toFixed(0)} КБ`);
    if (bits.length) console.log(`  ${bits.join(', ')}`);
  }

  // Вердикт. Пороговые доли, не абсолюты: 55 дропов за 10 минут — шум инициализации,
  // а не перегрузка, и раньше этот вердикт ошибочно винил захват.
  const anyFreeze = vw.some((v) => [...v.ticks.values()].some((x) => x.v.freezes > 0));
  if (anyFreeze) {
    const captureBad = dropWindows / windows > 0.1 || cbP95 > budgetMs;
    if (captureBad) console.log('\n=> Вещатель не успевал (дропы в >10% окон / колбэк длиннее бюджета кадра). Смотри CPU-путь: capture.rs.');
    else if (maxLoss > 2) console.log('\n=> Захват чист, сыпется линк вещатель->прямой ребёнок. Смотри аплинк вещателя, coturn.');
    else if (worstViewerLoss > 2) console.log('\n=> Захват и аплинк вещателя чисты, а зрители теряют пакеты. Виноват узел ниже (vrelay) или линк зрителя.\n   Дальше: docker compose logs vrelay | grep ingest   и   logs token | grep health');
    else console.log('\n=> Ни захват, ни линки не объясняют фризы. Смотри WARN/ERROR ниже.');
    // IDR-шторм усиливает любую потерю: каждый keyframe — крупный бурст. С форс/периодика
    // (новые бинари) различаем источник: форс≈0 при шторме = энкодер печёт IDR сам (GOP=fps),
    // а не петля PLI — это разные фиксы (GOP-атрибут MFT vs rate-limit форса).
    if (idrRate > 0.5) {
      console.log(`   ВНИМАНИЕ: IDR ${idrRate.toFixed(2)}/с — это шторм. Ожидаемая частота при GOP=4с — 0.25/с.`);
      if (idrForcedKnown && idr > 0) {
        const forcedPct = idrForced / idr;
        if (forcedPct < 0.2) console.log(`   форс всего ${idrForced}/${idr} (${(forcedPct * 100).toFixed(0)}%) — IDR печёт САМ ЭНКОДЕР (дефолтный GOP=fps), не петля PLI. Фикс: GOP-атрибут MFT (encoder.rs).`);
        else console.log(`   форс ${idrForced}/${idr} (${(forcedPct * 100).toFixed(0)}%) — петля PLI: зрители теряют -> PLI -> корень форсит IDR -> бурст пробивает линк -> снова потери.`);
      } else {
        console.log('   (форс/периодика неизвестна — старый бинарь; обнови для разбивки источника шторма) петля PLI ИЛИ GOP энкодера.');
      }
    }
  }

  if (bc.events.length) {
    console.log(`\nСобытия вещателя (${bc.events.length}):`);
    // Схлопываем повторы: ICE умеет сыпать одно и то же сотнями строк.
    const seen = new Map();
    for (const e of bc.events) {
      const k = e.msg.replace(/\d+/g, '#').slice(0, 90);
      if (!seen.has(k)) seen.set(k, { first: e.ts, n: 0, sample: e });
      seen.get(k).n++;
    }
    for (const { first, n, sample } of [...seen.values()].sort((a, b) => a.first - b.first)) {
      const t = ((first - t0) / 1000).toFixed(0);
      console.log(`  +${t}с [${sample.level}] ${sample.msg.slice(0, 120)}${n > 1 ? `  (×${n})` : ''}`);
    }
  }
}

const short = (n) => String(n).slice(0, 8);
/** Перцентиль по копии массива (nearest-rank). Пустой массив -> 0. */
const pct = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const argVal = (args, k) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };

/* ---------------- main ---------------- */

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'list') await cmdList();
else if (cmd === 'pull') await cmdPull(rest);
else if (cmd === 'report') cmdReport(rest.filter((a) => !a.startsWith('--')));
else {
  console.log(`Разбор диагностических сессий стрима.

  node scripts/diag.mjs list
  node scripts/diag.mjs pull --stream=<streamId> [--limit=N]
  node scripts/diag.mjs pull --all [--limit=N]
  node scripts/diag.mjs report ${OUT_DIR}/*.json

Авторизация: RELAY_TOKEN=<jwt>  либо  RELAY_USER=<логин> RELAY_PASS=<пароль>
Сервер:      RELAY_API (по умолчанию ${API})`);
}

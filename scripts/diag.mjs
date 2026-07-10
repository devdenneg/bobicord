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
// net: детей 1 | <id> loss=0.0% rtt=12мс | битрейт 5.8/6.0 Мбит (факт/цель) | PLI +0 | IDR +0
const NET_RE = /net: детей (\d+) \| (.*?) \| битрейт ([\d.]+)\/([\d.]+).*?PLI \+(\d+) \| IDR \+(\d+)/;
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
      upsert(ticks, b).net = { children: +nm[1], links, actualMbit: +nm[3], targetMbit: +nm[4], pli: +nm[5], idr: +nm[6] };
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
      upsert(ticks, b).v = {
        freezes: Math.max(0, (s.freezeCount ?? 0) - (prev.freezeCount ?? 0)),
        freezeMs: Math.max(0, (s.freezeMs ?? 0) - (prev.freezeMs ?? 0)),
        lost: Math.max(0, (s.packetsLost ?? 0) - (prev.packetsLost ?? 0)),
        pliSent: Math.max(0, (s.pliSent ?? 0) - (prev.pliSent ?? 0)),
        keyframes: Math.max(0, (s.keyFramesDecoded ?? 0) - (prev.keyFramesDecoded ?? 0)),
        fps: s.fps ?? 0,
        rttMs: s.rttMs,
        jitterMs: s.jitterMs ?? 0,
      };
    }
    prev = s;
  }
  return { ticks, first, last: prev };
}

/* ---------------- сводка ---------------- */

function cmdReport(files) {
  if (!files.length) die('Укажи файлы: node scripts/diag.mjs report .diag/*.json');
  const sessions = files.map((f) => ({ file: path.basename(f), ...JSON.parse(fs.readFileSync(f, 'utf8')) }));

  const broadcasters = sessions.filter((s) => s.role === 'broadcaster');
  const viewers = sessions.filter((s) => s.role === 'viewer');
  const streams = [...new Set(sessions.map((s) => s.streamId))];
  console.log(`Стримы: ${streams.join(', ')}  |  вещателей: ${broadcasters.length}, зрителей: ${viewers.length}\n`);

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
    for (const v of vw) head.push(`${short(v.name)}:фриз`, `${short(v.name)}:мс`, `${short(v.name)}:lost`);
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
        row.push(s?.freezes ?? '', s?.freezeMs ?? '', s?.lost ?? '');
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
    for (const [, x] of v.ticks) { freezes += x.v.freezes; freezeMs += x.v.freezeMs; lost += x.v.lost; pli += x.v.pliSent; }
    const a = v.first, z = v.last;
    const recv = a && z ? (z.packetsReceived ?? 0) - (a.packetsReceived ?? 0) : 0;
    const lossPct = lost + recv > 0 ? (lost * 100) / (lost + recv) : 0;
    const dur = a && z ? (z.t - a.t) / 1000 : 0;
    const fps = a && z && dur > 0 ? ((z.framesDecoded ?? 0) - (a.framesDecoded ?? 0)) / dur : 0;
    worstViewerLoss = Math.max(worstViewerLoss, lossPct);
    console.log(
      `зритель ${v.name} (${v.client}): фризов ${freezes} / ${(freezeMs / 1000).toFixed(0)}с, потери ${lossPct.toFixed(1)}% (${lost} пакетов), декодировано ${fps.toFixed(1)} fps, PLI ${pli}`,
    );
  }

  // Сводка вещателя. cbMax сравниваем с БЮДЖЕТОМ КАДРА (1000/fps), а не с константой.
  let drops = 0, pli = 0, idr = 0, cbMax = 0, maxLoss = 0, dropWindows = 0, targetFps = 30;
  for (const [, x] of bc.ticks) {
    drops += x.timing?.drops ?? 0;
    if ((x.timing?.drops ?? 0) > 0) dropWindows++;
    pli += x.net?.pli ?? 0;
    idr += x.net?.idr ?? 0;
    cbMax = Math.max(cbMax, x.timing?.cbMax ?? 0);
    for (const l of x.net?.links ?? []) maxLoss = Math.max(maxLoss, l.loss);
  }
  if (broadcasters[0]?.samples?.length) targetFps = broadcasters[0].samples[0].targetFps || 30;
  const windows = bc.ticks.size || 1;
  const budgetMs = 1000 / targetFps;
  const idrRate = (idr / windows) / (BUCKET_MS / 1000); // IDR в секунду
  if (bc.ticks.size) {
    console.log(
      `\nвещатель: дропов захвата ${drops} (в ${dropWindows} окнах из ${windows}), cb max ${cbMax.toFixed(1)}мс при бюджете ${budgetMs.toFixed(1)}мс,` +
      ` PLI получено ${pli}, IDR отдано ${idr} (${idrRate.toFixed(2)}/с), худший loss линка ${maxLoss.toFixed(1)}%`,
    );
  }

  // Вердикт. Пороговые доли, не абсолюты: 55 дропов за 10 минут — шум инициализации,
  // а не перегрузка, и раньше этот вердикт ошибочно винил захват.
  const anyFreeze = vw.some((v) => [...v.ticks.values()].some((x) => x.v.freezes > 0));
  if (anyFreeze) {
    const captureBad = dropWindows / windows > 0.1 || cbMax > budgetMs;
    if (captureBad) console.log('\n=> Вещатель не успевал (дропы в >10% окон / колбэк длиннее бюджета кадра). Смотри CPU-путь: capture.rs.');
    else if (maxLoss > 2) console.log('\n=> Захват чист, сыпется линк вещатель->прямой ребёнок. Смотри аплинк вещателя, coturn.');
    else if (worstViewerLoss > 2) console.log('\n=> Захват и аплинк вещателя чисты, а зрители теряют пакеты. Виноват узел ниже (vrelay) или линк зрителя.\n   Дальше: docker compose logs vrelay | grep ingest   и   logs token | grep health');
    else console.log('\n=> Ни захват, ни линки не объясняют фризы. Смотри WARN/ERROR ниже.');
    // IDR-шторм усиливает любую потерю: каждый keyframe — крупный бурст.
    if (idrRate > 0.5) {
      console.log(`   ВНИМАНИЕ: IDR ${idrRate.toFixed(2)}/с — это шторм. Зрители теряют пакеты -> шлют PLI -> корень форсит IDR ->`);
      console.log('   бурст пробивает линк -> снова потери. Ожидаемая частота при GOP=4с — 0.25/с.');
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
